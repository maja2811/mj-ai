"""Standalone safety checks for review lifecycle registration and cleanup."""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import review_lifecycle as lifecycle


NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
SESSION = "ses_fixture123"
SHA = "a" * 40
PR_URL = "https://github.com/example/repo/pull/17"
BODY = "**Used model:** Fixture\n\n### Summary\nApproved for æøå 🚆.\n"


class LifecycleFixture:
    def __init__(self):
        local = Path(os.environ["LOCALAPPDATA"]) / "Temp" / "opencode"
        local.mkdir(parents=True, exist_ok=True)
        self.temporary = TemporaryDirectory(prefix="review lifecycle's ", dir=local)
        self.base = Path(self.temporary.name)
        self.root = self.base / "managed"
        self.root.mkdir()
        self.session_location = str(Path(__file__).resolve().parents[1])
        self.env = patch.dict(os.environ, {"PR_WATCHER_REVIEW_TMP_DIR": str(self.root)})
        self.env.start()
        self.workspace = self.create_workspace()
        self.marker = 0
        self.is_archived = False
        self.archive_calls = 0
        self.active = {}
        self.children = {}
        self.child_cursor = False
        self.message_cursor = False
        self.session_outcome = "succeeded"
        self.latest_message = {"id": "msg_idle", "type": "idle", "outcome": "succeeded", "time": {"created": 1}}
        self.pending = set()
        self.fail_api = False
        self.fail_archive = False
        self.fail_gh = False
        self.dirty = False
        self.review = self.approved_review()
        self.api_patch = patch.object(lifecycle, "api", side_effect=self.api)
        self.api_mock = self.api_patch.start()
        self.subprocess_patch = patch.object(lifecycle.subprocess, "run", side_effect=self.run)
        self.run_mock = self.subprocess_patch.start()

    def close(self):
        self.api_patch.stop()
        self.subprocess_patch.stop()
        self.env.stop()
        self.temporary.cleanup()

    def create_workspace(self, name="review-pr-fixture"):
        workspace = self.root / name
        workspace.mkdir(parents=True)
        clone = workspace / "clone"
        (clone / ".git").mkdir(parents=True)
        (clone / "source.py").write_text("print('review')\n", encoding="utf-8")
        manifest = {
            "workspace": str(workspace), "clone_path": str(clone),
            "owner": "example", "repo": "repo", "number": 17,
            "pr_url": PR_URL, "head_sha": SHA, "cloned_head_sha": SHA,
            "suggested_filename": "pr-review-example-repo-17.md",
        }
        (workspace / "pr-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (workspace / "final.md").write_text(BODY, encoding="utf-8")
        return workspace

    @staticmethod
    def approved_review(**changes):
        review = {
            "id": 123, "state": "APPROVED", "submitted_at": "2026-10-21T11:00:00Z",
            "commit_id": SHA, "user": {"login": "maja2811"}, "body": BODY.rstrip("\n"),
        }
        review.update(changes)
        return review

    def session(self, session_id=SESSION):
        return {
            "id": session_id,
            "location": {"directory": self.session_location if session_id == SESSION else str(self.base / "child-location")},
            "title": "PR Review: example/repo#17 @aaaaaaa",
            "metadata": {"prWatcher": {"url": PR_URL}},
            "outcome": self.session_outcome,
            "time": {"created": int(datetime(2026, 10, 21, 10, 0, tzinfo=timezone.utc).timestamp() * 1000),
                     "archived": self.marker},
        }

    def api(self, method, path, body=None):
        if self.fail_api:
            raise RuntimeError("fixture API outage")
        if path == "/api/session/active":
            return {"data": self.active}
        if path.startswith("/api/session?"):
            query = path.split("?", 1)[1]
            params = dict(part.split("=", 1) for part in query.split("&"))
            parent_id = params["parentID"]
            if "cursor" in params:
                return {"data": [], "cursor": {"previous": "first", "next": None}}
            children = [{"id": child_id} for child_id in self.children.get(parent_id, [])]
            next_cursor = "second-page" if self.child_cursor and children else None
            return {"data": children, "cursor": {"previous": None, "next": next_cursor}}
        if "/message?" in path:
            session_id, query = path.split("/api/session/", 1)[1].split("/message?", 1)
            params = dict(part.split("=", 1) for part in query.split("&"))
            if params.get("limit") == "1":
                assert params.get("order") == "desc"
                messages = [self.latest_message]
                next_cursor = None
            elif params.get("order") == "asc":
                messages = [] if self.message_cursor else [{"id": "msg_user", "type": "user", "text": f"Review {PR_URL}", "time": {"created": 1}}]
                next_cursor = "message-page" if self.message_cursor else None
            elif "cursor" in params:
                messages = [{"id": "msg_user", "type": "user", "text": f"Review {PR_URL}", "time": {"created": 1}}]
                next_cursor = None
            else:
                raise AssertionError(f"Unordered V2 message query: {path}")
            return {"data": messages, "cursor": {"previous": "older", "next": next_cursor}}
        if path.endswith("/permission") or path.endswith("/form"):
            session_id = path.split("/api/session/", 1)[1].split("/", 1)[0]
            kind = path.rsplit("/", 1)[-1]
            return {"data": [{"id": "pending"}] if (session_id, kind) in self.pending else []}
        if method == "patch" and path == f"/api/session/{SESSION}":
            assert body == {"archived": True}
            if self.fail_archive:
                raise RuntimeError("fixture archive failure")
            self.archive_calls += 1
            self.is_archived = True
            self.marker = int(NOW.timestamp() * 1000)
            return None
        if path.startswith("/api/session/"):
            session_id = path.rsplit("/", 1)[-1]
            if session_id == SESSION:
                return {"data": self.session(session_id)}
            return {"data": self.session(session_id)}
        raise AssertionError(f"Unexpected API call: {method} {path}")

    def run(self, command, **kwargs):
        if command[:2] == ["gh", "api"]:
            assert kwargs.get("encoding") == "utf-8"
            if self.fail_gh:
                raise subprocess.CalledProcessError(1, command, stderr="fixture GitHub outage")
            args = command[2:]
            if args == ["user"]:
                return subprocess.CompletedProcess(command, 0, json.dumps({"login": "maja2811"}), "")
            if args == ["repos/example/repo/pulls/17"]:
                return subprocess.CompletedProcess(command, 0, json.dumps({"head": {"sha": SHA}}), "")
            if args == ["--paginate", "--slurp", "repos/example/repo/pulls/17/reviews"]:
                return subprocess.CompletedProcess(command, 0, json.dumps([[self.review]]), "")
            raise AssertionError(f"Unexpected GitHub command: {command}")
        if command[0] == "git":
            assert kwargs.get("cwd") is not None and "-C" not in command
            if "rev-parse" in command:
                return subprocess.CompletedProcess(command, 0, "fixture-head\n", "")
            if "status" in command:
                return subprocess.CompletedProcess(command, 0, " M source.py\n" if self.dirty else "", "")
        raise AssertionError(f"Unexpected subprocess: {command}")

    def register(self, review_path=None, session=None):
        if session is not None:
            original = self.api_mock.side_effect

            def api(method, path, body=None):
                if path == f"/api/session/{SESSION}":
                    return {"data": session}
                return original(method, path, body)

            self.api_mock.side_effect = api
        return lifecycle.record_approval(
            str(self.workspace / "pr-manifest.json"), SESSION,
            str(review_path or self.workspace / "final.md"),
        )

    def write_receipt(self, *, archived_at=None, archived_marker=None, snapshot=None, git_heads=None):
        manifest = json.loads((self.workspace / "pr-manifest.json").read_text(encoding="utf-8"))
        receipt = {
            "version": 1, "session_id": SESSION,
            "session_location": lifecycle._session_location(self.session()),
            "pr": {"owner": "example", "repo": "repo", "number": 17, "url": PR_URL, "head_sha": SHA},
            "approval": {
                "review_id": 123, "author": "maja2811", "submitted_at": "2026-10-21T11:00:00Z",
                "body_sha256": lifecycle.hashlib.sha256(BODY.rstrip("\n").encode("utf-8")).hexdigest(),
            },
            "registered_at": "2026-10-21T11:00:00Z",
        }
        if archived_at:
            receipt.update({"archived_at": archived_at, "archived_marker": archived_marker})
        if snapshot is not None:
            receipt["workspace_snapshot"] = snapshot
        if git_heads is not None:
            receipt["git_heads"] = git_heads
        (self.workspace / lifecycle.RECEIPT_NAME).write_text(json.dumps(receipt), encoding="utf-8")
        return receipt

    def expired_receipt(self):
        self.marker = int((NOW - timedelta(days=7)).timestamp() * 1000)
        self.is_archived = True
        self.write_receipt(
            archived_at=lifecycle.utc_text(NOW - timedelta(days=7)),
            archived_marker=self.marker,
        )
        snapshot, repos = lifecycle._safe_tree(self.workspace, excluded={self.workspace / lifecycle.RECEIPT_NAME})
        heads, _ = lifecycle._git_state(repos, self.workspace)
        receipt_path = self.workspace / lifecycle.RECEIPT_NAME
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["registered_at"] = lifecycle.utc_text(NOW - timedelta(days=8))
        receipt["approval"]["submitted_at"] = receipt["registered_at"]
        receipt["workspace_snapshot"] = snapshot
        receipt["git_heads"] = heads
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")


def test_registration_and_verification_failures():
    assert lifecycle._normalize_body("line one\r\nline two\r\n") == "line one\nline two"
    assert lifecycle._normalize_body("line\n\n") != lifecycle._normalize_body("line\n")
    fixture = LifecycleFixture()
    try:
        external = fixture.base / "explicit-external-review.md"
        external.write_text(BODY, encoding="utf-8")
        result = fixture.register(external)
        assert result["status"] == "registered" and result["review_id"] == 123
        assert result["submitted_at"] == fixture.review["submitted_at"]
        receipt_path = fixture.workspace / lifecycle.RECEIPT_NAME
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        assert fixture.session_location.endswith("skills/review-pr") or fixture.session_location.endswith("skills\\review-pr")
        assert receipt["session_location"] == os.path.normcase(fixture.session_location)
        assert receipt["session_location"] != os.path.normcase(str(fixture.workspace))
        first = receipt_path.read_text(encoding="utf-8")
        second = fixture.register(external)
        assert second["status"] == "already-registered"
        assert receipt_path.read_text(encoding="utf-8") == first
        assert external.exists()
    finally:
        fixture.close()

    for invalid in (
        {"state": "COMMENTED"}, {"state": "CHANGES_REQUESTED"}, {"state": "DISMISSED"},
        {"user": {"login": "another-user"}}, {"body": BODY + "extra"},
        {"commit_id": "b" * 40}, {"submitted_at": None},
    ):
        fixture = LifecycleFixture()
        try:
            fixture.review.update(invalid)
            try:
                fixture.register()
            except ValueError:
                pass
            else:
                raise AssertionError(f"Invalid approval accepted: {invalid}")
            assert not (fixture.workspace / lifecycle.RECEIPT_NAME).exists()
        finally:
            fixture.close()

    fixture = LifecycleFixture()
    try:
        fixture.review["submitted_at"] = "2026-10-21T09:00:00Z"
        try:
            fixture.register()
        except ValueError:
            pass
        else:
            raise AssertionError("Approval predating the review session was accepted")
        assert not (fixture.workspace / lifecycle.RECEIPT_NAME).exists()
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        fixture.review = fixture.approved_review()
        fixture.review["id"] = 124
        duplicate = fixture.approved_review()
        original = fixture.run_mock.side_effect

        def duplicate_reviews(command, **kwargs):
            if command[:2] == ["gh", "api"] and command[2:4] == ["--paginate", "--slurp"]:
                return subprocess.CompletedProcess(command, 0, json.dumps([[fixture.review, duplicate]]), "")
            return original(command, **kwargs)

        fixture.run_mock.side_effect = duplicate_reviews
        try:
            fixture.register()
        except ValueError:
            pass
        else:
            raise AssertionError("Ambiguous duplicate approvals were accepted")
        assert not (fixture.workspace / lifecycle.RECEIPT_NAME).exists()
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        wrong_session = fixture.session()
        wrong_session["metadata"]["prWatcher"]["url"] = "https://github.com/example/repo/pull/18"
        try:
            fixture.register(session=wrong_session)
        except ValueError:
            pass
        else:
            raise AssertionError("Session for another PR was accepted")
        assert not (fixture.workspace / lifecycle.RECEIPT_NAME).exists()
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        manual_session = fixture.session()
        manual_session.pop("metadata")
        manual_session["title"] = "Manual review"
        fixture.message_cursor = True
        fixture.register(session=manual_session)
        assert (fixture.workspace / lifecycle.RECEIPT_NAME).exists()
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        manifest_path = fixture.workspace / "pr-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["head_sha"] = "b" * 40
        manifest["cloned_head_sha"] = manifest["head_sha"]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        try:
            fixture.register()
        except ValueError:
            pass
        else:
            raise AssertionError("PR whose current head differs from the manifest was accepted")
        assert not (fixture.workspace / lifecycle.RECEIPT_NAME).exists()
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        fixture.fail_gh = True
        try:
            fixture.register()
        except RuntimeError:
            pass
        else:
            raise AssertionError("GitHub lookup failure was accepted")
        assert not (fixture.workspace / lifecycle.RECEIPT_NAME).exists()
    finally:
        fixture.close()


def test_archive_retention_and_cleanup():
    fixture = LifecycleFixture()
    try:
        external = fixture.base / "explicit-external-output.md"
        external.write_text(BODY, encoding="utf-8")
        fixture.register()
        receipt_path = fixture.workspace / lifecycle.RECEIPT_NAME
        before = receipt_path.read_text(encoding="utf-8")
        lifecycle._maintain_workspace(fixture.workspace, True, NOW)
        assert receipt_path.read_text(encoding="utf-8") == before
        assert fixture.archive_calls == 0 and not fixture.is_archived

        fixture.active = {SESSION: {"type": "running"}}
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        assert fixture.archive_calls == 0
        fixture.active = {}
        fixture.children = {SESSION: ["ses_child123"]}
        fixture.child_cursor = True
        fixture.active = {"ses_child123": {"type": "running"}}
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        assert fixture.archive_calls == 0
        fixture.children = {}
        fixture.active = {}

        fixture.pending.add((SESSION, "permission"))
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        assert fixture.archive_calls == 0
        fixture.pending.clear()
        fixture.pending.add((SESSION, "form"))
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        assert fixture.archive_calls == 0
        fixture.pending.clear()

        for message in (
            {"id": "msg_failed", "type": "idle", "outcome": "failed", "time": {"created": 1}},
            {"id": "msg_interrupted", "type": "idle", "outcome": "interrupted", "time": {"created": 1}},
            {"id": "msg_pending", "type": "user", "text": "still working", "time": {"created": 1}},
            {"id": "msg_assistant", "type": "assistant", "time": {"created": 1}},
            {"id": "msg_v1", "role": "assistant", "time": {"completed": 1}, "finish": "stop"},
            {"id": "msg_error", "type": "idle", "outcome": "succeeded", "error": {"type": "fixture"}, "time": {"created": 1}},
        ):
            fixture.latest_message = message
            lifecycle._maintain_workspace(fixture.workspace, False, NOW)
            assert fixture.archive_calls == 0
        fixture.latest_message = {"id": "msg_idle", "type": "idle", "outcome": "succeeded", "time": {"created": 1}}
        fixture.session_outcome = "failed"
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        assert fixture.archive_calls == 0
        fixture.session_outcome = "succeeded"
        fixture.children = {SESSION: ["ses_child123"]}  # Child location differs from the parent and workspace.

        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        assert fixture.archive_calls == 1 and receipt["archived_at"] == lifecycle.utc_text(NOW)
        assert receipt["archived_marker"] == fixture.marker

        six_days = NOW + timedelta(days=6)
        lifecycle._maintain_workspace(fixture.workspace, False, six_days)
        assert fixture.workspace.exists()
        seven_days = NOW + timedelta(days=7)
        lifecycle._maintain_workspace(fixture.workspace, True, seven_days)
        assert fixture.workspace.exists()
        lifecycle._maintain_workspace(fixture.workspace, False, seven_days)
        assert not fixture.workspace.exists()
        assert external.exists()
    finally:
        fixture.close()


def test_preservation_and_fail_closed_cases():
    # Dirty Git work is retained and recorded as protected.
    fixture = LifecycleFixture()
    try:
        fixture.expired_receipt()
        fixture.dirty = True
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        receipt = json.loads((fixture.workspace / lifecycle.RECEIPT_NAME).read_text(encoding="utf-8"))
        assert fixture.workspace.exists() and "local changes" in receipt["preserved_reason"]
    finally:
        fixture.close()

    # A changed V2 location preserves the registered review.
    fixture = LifecycleFixture()
    try:
        fixture.expired_receipt()
        fixture.session_location = str(fixture.base / "moved-session")
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        receipt = json.loads((fixture.workspace / lifecycle.RECEIPT_NAME).read_text(encoding="utf-8"))
        assert fixture.workspace.exists() and receipt["preserved_reason"] == "review session location changed"
    finally:
        fixture.close()

    # V2 archive crash recovery must remain read-only in dry-run mode.
    fixture = LifecycleFixture()
    try:
        fixture.register()
        fixture.marker = int(NOW.timestamp() * 1000)
        fixture.is_archived = True
        path = fixture.workspace / lifecycle.RECEIPT_NAME
        before = path.read_bytes()
        lifecycle._maintain_workspace(fixture.workspace, True, NOW + timedelta(days=1))
        assert path.read_bytes() == before and fixture.archive_calls == 0
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        fixture.expired_receipt()
        (fixture.workspace / "user-notes.md").write_text("keep this work\n", encoding="utf-8")
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        receipt = json.loads((fixture.workspace / lifecycle.RECEIPT_NAME).read_text(encoding="utf-8"))
        assert fixture.workspace.exists() and "workspace changed" in receipt["preserved_reason"]
    finally:
        fixture.close()

    # Restoring/unarchiving an archived session protects it permanently.
    fixture = LifecycleFixture()
    try:
        fixture.expired_receipt()
        fixture.marker = 0
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        receipt = json.loads((fixture.workspace / lifecycle.RECEIPT_NAME).read_text(encoding="utf-8"))
        assert fixture.workspace.exists() and "restored" in receipt["preserved_reason"]
    finally:
        fixture.close()

    # A missing or malformed receipt never authorizes cleanup.
    for content in (None, "not JSON"):
        fixture = LifecycleFixture()
        try:
            path = fixture.workspace / lifecycle.RECEIPT_NAME
            if content is None:
                fixture.expired_receipt()
                path.unlink()
            else:
                path.write_text(content, encoding="utf-8")
            try:
                lifecycle._maintain_workspace(fixture.workspace, False, NOW + timedelta(days=30))
            except (ValueError, json.JSONDecodeError):
                pass
            assert fixture.workspace.exists()
        finally:
            fixture.close()

    fixture = LifecycleFixture()
    try:
        fixture.expired_receipt()
        receipt_path = fixture.workspace / lifecycle.RECEIPT_NAME
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["pr"]["head_sha"] = "b" * 40
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        before = receipt_path.read_text(encoding="utf-8")
        lifecycle._maintain_workspace(fixture.workspace, False, NOW + timedelta(days=30))
        assert fixture.workspace.exists() and receipt_path.read_text(encoding="utf-8") == before
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        fixture.expired_receipt()
        (fixture.workspace / "pr-manifest.json").write_text("[]", encoding="utf-8")
        try:
            lifecycle._maintain_workspace(fixture.workspace, False, NOW + timedelta(days=30))
        except ValueError:
            pass
        else:
            raise AssertionError("Malformed manifest was accepted for cleanup")
        assert fixture.workspace.exists()
    finally:
        fixture.close()

    # API outages and failed archive calls leave the workspace and receipt intact.
    fixture = LifecycleFixture()
    try:
        fixture.register()
        receipt_path = fixture.workspace / lifecycle.RECEIPT_NAME
        before = receipt_path.read_text(encoding="utf-8")
        fixture.fail_api = True
        try:
            lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        except RuntimeError:
            pass
        assert fixture.workspace.exists() and receipt_path.read_text(encoding="utf-8") == before
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        fixture.register()
        receipt_path = fixture.workspace / lifecycle.RECEIPT_NAME
        before = receipt_path.read_text(encoding="utf-8")
        fixture.fail_archive = True
        try:
            lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Failed archive call was accepted")
        assert fixture.workspace.exists() and receipt_path.read_text(encoding="utf-8") == before
    finally:
        fixture.close()

    fixture = LifecycleFixture()
    try:
        fixture.expired_receipt()
        fixture.children = {SESSION: ["ses_child123"]}
        fixture.active = {"ses_child123": {"type": "running"}}
        lifecycle._maintain_workspace(fixture.workspace, False, NOW)
        assert fixture.workspace.exists()
    finally:
        fixture.close()

    # Refuse an external workspace and nested symlink/reparse escapes.
    fixture = LifecycleFixture()
    try:
        try:
            lifecycle._assert_managed_workspace(fixture.base)
        except ValueError:
            pass
        else:
            raise AssertionError("External workspace was accepted")
        fixture.expired_receipt()
        link = fixture.workspace / "external-link"
        try:
            link.symlink_to(fixture.base, target_is_directory=True)
        except OSError:
            link.write_text("fixture reparse entry", encoding="utf-8")
            with patch.object(lifecycle, "_is_reparse", side_effect=lambda path: Path(path) == link):
                try:
                    lifecycle._safe_tree(fixture.workspace)
                except ValueError:
                    pass
                else:
                    raise AssertionError("Simulated reparse point was accepted")
        else:
            try:
                lifecycle._safe_tree(fixture.workspace)
            except ValueError:
                pass
            else:
                raise AssertionError("Nested symlink was accepted")
        assert fixture.workspace.exists()
    finally:
        fixture.close()


if __name__ == "__main__":
    test_registration_and_verification_failures()
    test_archive_retention_and_cleanup()
    test_preservation_and_fail_closed_cases()
    print("PASS: verified approval, idempotence, invalid reviews, deferred/successful archive, retention boundary, restored/dirty/unresolved state, dry-run, containment, links and API failure preservation")
