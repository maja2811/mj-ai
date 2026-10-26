from contextlib import redirect_stdout
import hashlib
from io import StringIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import start_review_v2 as starter


def test_review_and_repair_sessions():
    directory = r"C:\setup repo's\opencode"
    model = "azure/gpt-6.1-sol#xhigh"
    title, url = "PR Review: example/repo#1 @1234567", "https://github.com/example/repo/pull/1"
    key = hashlib.sha256(json.dumps([directory, title, url]).encode()).hexdigest()[:32]
    session_id = f"ses_{key}"
    with patch.object(starter, "api", side_effect=[{"data": {"id": session_id}}, None]) as api:
        assert starter.start_review(directory=directory, title=title, model=model, url=url) == {"session_id": session_id}
        assert api.call_args_list == [
            call("post", "/api/session", {
                "id": session_id, "title": title, "location": {"directory": directory},
                "model": {"providerID": "azure", "id": "gpt-6.1-sol", "variant": "xhigh"},
                "metadata": {"prWatcher": {"url": url}},
            }),
            call("post", f"/api/session/{session_id}/prompt", {
                "id": f"msg_{key}", "text": f"Review {url}\n\nRender the final review with --session-id {session_id} so its Used model "
                "line comes from this review session's model and reasoning variant.",
                "skills": [{"id": "review-pr"}],
            }),
        ]

    temp = Path(os.environ["LOCALAPPDATA"]) / "Temp" / "opencode"
    with TemporaryDirectory(prefix="watcher repair's ", dir=temp) as temporary:
        report_path = Path(temporary) / "failure.json"
        report = {"failure": 'ERROR: bad "number" / æøå',
                  "log_path": str(Path(temporary) / "stdout.log"),
                  "error_log_path": str(Path(temporary) / "stderr.log")}
        report_path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8-sig")
        argv = ["start_review_v2.py", "--watcher-failure", str(report_path), "--directory", directory, "--model", model]
        with patch.object(sys, "argv", argv), redirect_stdout(StringIO()) as output, \
                patch.object(starter, "api", side_effect=[{"data": {"id": "ses_repair"}}, None]) as api:
            starter.main()
        assert json.loads(output.getvalue()) == {"session_id": "ses_repair"}
        create, prompt = [entry.args[2] for entry in api.call_args_list]
        assert create["location"] == {"directory": directory}
        assert create["title"] == "PR watcher repair"
        assert create["model"] == {"providerID": "azure", "id": "gpt-6.1-sol", "variant": "xhigh"}
        assert create["metadata"] == {"prWatcher": {"failureReport": str(report_path)}}
        assert "skills" not in prompt
        assert report["failure"] in prompt["text"].replace('\\"', '"')
        assert json.loads(prompt["text"].split("```json\n")[1].split("\n```")[0]) == report
        for boundary in ("untrusted data", "Do not start reviews", ".review-poll-state.json", "active-reviews.json", "Ask before restarting/stopping", "committing", "pushing"):
            assert boundary in prompt["text"], boundary
        first_id = create["id"]
        with patch.object(starter, "api", side_effect=[{"data": {"id": "ses_repair"}}, None]) as api:
            starter.start_watcher_repair(directory=directory, model=model, failure_path=str(report_path))
        assert api.call_args_list[0].args[2]["id"] == first_id

        report_path.write_text('{"failure": "missing log paths"}', encoding="utf-8")
        with patch.object(starter, "api") as api:
            try:
                starter.start_watcher_repair(directory=directory, model=model, failure_path=str(report_path))
            except ValueError:
                pass
            else:
                raise AssertionError("Malformed failure reports must not launch a session")
            api.assert_not_called()


if __name__ == "__main__":
    test_review_and_repair_sessions()
    print("PASS: unchanged review payloads, repair CLI/model/context, safety boundaries, BOM/quotes and stable IDs")
