"""Standalone, offline regression checks; never read or write live watcher state."""

from contextlib import redirect_stderr
from io import StringIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import poll_reviews as poller
import start_review_v2 as starter


URL = "https://github.com/example/repo/pull/1"
SHA = "a" * 40
NEXT_SHA = "b" * 40
PR = {"repository": {"nameWithOwner": "example/repo"}, "url": URL,
      "number": 1, "title": "Fixture", "updatedAt": "2026-10-23T08:00:00Z"}


def test_persisted_outcomes_and_retry_limit():
    root = Path(os.environ["LOCALAPPDATA"]) / "Temp" / "opencode"
    with TemporaryDirectory(prefix="watcher state ", dir=root) as temporary, \
            patch.object(poller, "STATE_FILE", Path(temporary) / "state.json"), \
            patch.object(poller, "get_pending_prs", return_value=[PR]), \
            patch.object(poller, "get_head_sha", return_value=SHA) as head, \
            patch.object(poller, "review_status") as status:
        assert poller.load_state() == {}
        state = {}
        assert poller.find_reviewable_prs(state)[0]["attempt"] == 1
        poller.mark_started(state, URL, SHA, "ses_first", 1)
        assert poller.load_state()[URL]["status"] == "started"
        for outcome in ("working", "blocked"):
            status.return_value = outcome
            assert poller.find_reviewable_prs(state) == []
            assert poller.load_state()[URL]["status"] == outcome

        status.return_value = "done"  # Includes an explicit choice not to post.
        assert poller.find_reviewable_prs(state) == []
        assert poller.load_state()[URL]["status"] == "completed"
        status.reset_mock()
        poller.mark_started(state, URL, SHA, "ses_first", 1)
        assert state[URL]["status"] == "completed", "Duplicate launch downgraded completion"
        assert poller.find_reviewable_prs(poller.load_state()) == []
        status.assert_not_called()

        head.return_value = NEXT_SHA
        assert poller.find_reviewable_prs(state)[0]["attempt"] == 1
        assert state[URL]["head_sha"] == SHA, "Completion marked a newer, unreviewed head"
        head.return_value = SHA

        for outcome in ("interrupted", "failed"):
            state = {}
            poller.mark_started(state, URL, SHA, "ses_first", 1)
            status.return_value = outcome
            retry = poller.find_reviewable_prs(poller.load_state())
            assert retry[0]["attempt"] == 2
            assert poller.load_state()[URL]["status"] == outcome
            poller.mark_started(poller.load_state(), URL, SHA, "ses_retry", 2)
            errors = StringIO()
            with redirect_stderr(errors):
                assert poller.find_reviewable_prs(poller.load_state()) == []
            assert "opencode --session ses_retry" in errors.getvalue()
            assert poller.load_state()[URL]["status"] == outcome, "Failed retry was marked completed"

        status.side_effect = RuntimeError("fixture API unavailable")
        before = poller.STATE_FILE.read_bytes()
        with redirect_stderr(StringIO()):
            assert poller.find_reviewable_prs(poller.load_state()) == []
        assert poller.STATE_FILE.read_bytes() == before
        status.side_effect = None

        # Legacy marks/baselines are preserved, not replayed or remotely reclassified.
        poller.STATE_FILE.write_text(json.dumps({URL: SHA}), encoding="utf-8-sig")
        state = poller.load_state()
        status.reset_mock()
        assert poller.find_reviewable_prs(state) == []
        status.assert_not_called()
        assert state == {URL: SHA}

        # Posting can remove the PR from GitHub's requested-review search.
        state = {}
        poller.mark_started(state, URL, SHA, "ses_posted", 1)
        status.return_value = "done"
        with patch.object(poller, "get_pending_prs", return_value=[]):
            assert poller.find_reviewable_prs(state) == []
        assert poller.load_state()[URL]["status"] == "completed"


def test_explicit_requeue_preserves_history_until_next_launch():
    root = Path(os.environ["LOCALAPPDATA"]) / "Temp" / "opencode"
    with TemporaryDirectory(prefix="watcher requeue ", dir=root) as temporary, \
            patch.object(poller, "STATE_FILE", Path(temporary) / "state.json"), \
            patch.object(poller, "get_pending_prs", return_value=[PR]), \
            patch.object(poller, "get_head_sha", return_value=SHA) as head, \
            patch.object(poller, "review_status") as status:
        original = {"head_sha": SHA, "session_id": "ses_first", "attempt": 1, "status": "completed"}
        poller.save_state({URL: original, "https://github.com/example/other/pull/2": NEXT_SHA})
        args = ["poll_reviews.py", "--requeue", URL]
        with patch.object(sys, "argv", args), redirect_stderr(StringIO()):
            poller.main()
        head.assert_not_called()
        status.assert_not_called()
        state = poller.load_state()
        assert state[URL] == {**original, "status": "queued"}
        assert state["https://github.com/example/other/pull/2"] == NEXT_SHA
        for _ in range(2):
            poller.requeue_review(state, URL)
            assert poller.find_reviewable_prs(poller.load_state())[0]["attempt"] == 2
            assert poller.load_state()[URL]["status"] == "queued"
            status.assert_not_called()  # The old outcome must not consume the retry.
        head.return_value = NEXT_SHA
        assert poller.find_reviewable_prs(poller.load_state())[0]["attempt"] == 1
        head.return_value = SHA
        poller.mark_started(poller.load_state(), URL, SHA, "ses_retry", 2)
        assert poller.load_state()[URL]["session_id"] == "ses_retry"
        status.return_value = "working"
        assert poller.find_reviewable_prs(poller.load_state()) == []
        for record in (None, SHA, {**original, "status": "working"}, {**original, "attempt": 2}):
            before = poller.STATE_FILE.read_bytes()
            try:
                poller.requeue_review({URL: record}, URL)
            except ValueError:
                pass
            else:
                raise AssertionError("Unsafe or exhausted review was requeued")
            assert poller.STATE_FILE.read_bytes() == before


def test_state_and_cli_fail_closed():
    root = Path(os.environ["LOCALAPPDATA"]) / "Temp" / "opencode"
    with TemporaryDirectory(prefix="watcher CLI ", dir=root) as temporary, \
            patch.object(poller, "STATE_FILE", Path(temporary) / "state.json"), \
            patch.object(poller, "get_head_sha") as head:
        args = ["poll_reviews.py", "--mark-started", URL, "--head-sha", SHA,
                "--session-id", "ses_first", "--attempt", "1"]
        with patch.object(sys, "argv", args), redirect_stderr(StringIO()):
            poller.main()
        head.assert_not_called()
        original = poller.STATE_FILE.read_bytes()
        with patch.object(poller.os, "replace", side_effect=OSError("fixture write failure")):
            try:
                poller.save_state({URL: NEXT_SHA})
            except OSError:
                pass
            else:
                raise AssertionError("Failed replacement succeeded")
        assert poller.STATE_FILE.read_bytes() == original
        assert list(Path(temporary).iterdir()) == [poller.STATE_FILE]

        args = ["poll_reviews.py", "--mark-reviewed", URL, "--head-sha", SHA]
        with patch.object(sys, "argv", args), redirect_stderr(StringIO()):
            poller.main()
        assert poller.load_state() == {URL: SHA}
        head.assert_not_called()

        for invalid in ("not JSON", "[]", '{"url": null}', '{"url": {"head_sha": "bad"}}'):
            poller.STATE_FILE.write_text(invalid, encoding="utf-8")
            errors = StringIO()
            with redirect_stderr(errors):
                assert poller.poll_once() == []
            assert "[poll] Error:" in errors.getvalue()
            assert poller.STATE_FILE.read_text(encoding="utf-8") == invalid


def test_status_precedence_and_live_children():
    def fixture_api(method, path, body=None):
        assert method == "get"
        if path in {"/api/session/ses_parent", "/api/session/ses_child"}:
            return {"data": {"outcome": "succeeded", "time": {"idle": 123}}}
        if path.endswith("/permission") or path.endswith("/form"):
            return {"data": []}
        if path.endswith("/message?limit=1&order=desc"):
            if "ses_child" in path:
                return {"data": [{"type": "assistant"}]}
            return {"data": [{"type": "idle", "outcome": "succeeded"}]}
        if path == "/api/session?parentID=ses_parent":
            return {"data": [], "cursor": {"next": "next&literal"}}
        if path == "/api/session?parentID=ses_parent&cursor=next%26literal":
            return {"data": [{"id": "ses_child", "time": {"idle": 123}}], "cursor": {"next": None}}
        raise AssertionError(f"Unexpected API call: {path}")

    with patch.object(starter, "api", side_effect=fixture_api):
        assert starter.review_status("ses_parent") == "working", "Stale child idle time marked parent completed"
    with patch.object(starter, "api", side_effect=[{"data": {"outcome": "succeeded"}}, {"data": ["permission"]}]) as api:
        assert starter.review_status("ses_parent") == "blocked"
        assert api.call_count == 2
    with patch.object(starter, "api", side_effect=[{"data": {"outcome": "succeeded"}}, {"data": []}, {"data": ["question"]}]):
        assert starter.review_status("ses_parent") == "blocked"

    for outcome, expected in (("succeeded", "done"), ("interrupted", "interrupted"), ("failed", "failed"), (None, "interrupted")):
        responses = [{"data": {"outcome": "succeeded"}}, {"data": []}, {"data": []},
                     {"data": [{"type": "idle", "outcome": outcome}]}, {"data": [], "cursor": {"next": None}}]
        with patch.object(starter, "api", side_effect=responses):
            assert starter.review_status("ses_parent") == expected

    responses = [{"data": {}}, {"data": []}, {"data": []},
                 {"data": [{"type": "idle", "outcome": "succeeded"}]}, {"data": []}]
    with patch.object(starter, "api", side_effect=responses):
        try:
            starter.review_status("ses_parent")
        except KeyError:
            pass
        else:
            raise AssertionError("Missing child pagination metadata marked a review complete")


if __name__ == "__main__":
    test_persisted_outcomes_and_retry_limit()
    test_explicit_requeue_preserves_history_until_next_launch()
    test_state_and_cli_fail_closed()
    test_status_precedence_and_live_children()
    print("PASS: exact-head tracking, completion, blocked/running dedup, bounded retries, legacy state, atomic failures and session status")
