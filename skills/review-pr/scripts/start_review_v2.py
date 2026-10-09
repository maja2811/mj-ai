#!/usr/bin/env python3
"""Create and start an OpenCode V2 review session (used by pr-watcher.ps1)."""
import argparse
import hashlib
import json
import shutil
import subprocess


def api(method, path, body=None):
    argv = [shutil.which("opencode2") or "opencode2", "api", method, path]
    if body is not None:
        argv.extend(["--data", json.dumps(body)])
    result = subprocess.run(argv, check=True, capture_output=True, encoding="utf-8", timeout=30)
    return json.loads(result.stdout) if result.stdout.strip() else None


def model_ref(value):
    provider, sep, model = value.partition("/")
    if not sep or not provider or not model:
        raise ValueError("Model must be provider/model#variant")
    model, marker, variant = model.partition("#")
    if not model or (marker and not variant):
        raise ValueError("Model and optional variant must be nonempty")
    result = {"providerID": provider, "id": model}
    if marker:
        result["variant"] = variant
    return result


def start_review(*, directory, title, model, url):
    key = hashlib.sha256(json.dumps([directory, title, url]).encode()).hexdigest()[:32]
    created = api("post", "/api/session", {
        "id": f"ses_{key}",
        "title": title,
        "location": {"directory": directory},
        "model": model_ref(model),
        "metadata": {"prWatcher": {"url": url}},
    })
    session_id = created["data"]["id"]
    if not isinstance(session_id, str) or not session_id.startswith("ses"):
        raise ValueError("V2 session creation returned an invalid ID")
    api("post", f"/api/session/{session_id}/prompt", {
        "id": f"msg_{key}",
        "text": (
            f"Review {url}\n\n"
            f"Render the final review with --session-id {session_id} so its Used model "
            "line comes from this review session's model and reasoning variant."
        ),
        "skills": [{"id": "review-pr"}],
    })
    return {"session_id": session_id}


def review_status(session_id):
    session = api("get", f"/api/session/{session_id}")["data"]
    # time.idle keeps its old value after a session resumes (e.g. when a background
    # subagent finishes), so trust the newest message and running children instead.
    newest = api("get", f"/api/session/{session_id}/message?limit=1")["data"]
    children = api("get", f"/api/session?parentID={session_id}")["data"]
    if newest and newest[0].get("type") == "idle" and all(c["time"].get("idle") for c in children):
        return "done" if session.get("outcome") == "succeeded" else session.get("outcome") or "interrupted"
    if api("get", f"/api/session/{session_id}/permission")["data"]:
        return "blocked"
    if api("get", f"/api/session/{session_id}/form")["data"]:
        return "blocked"
    return "working"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", metavar="SESSION_ID")
    for flag in ["directory", "title", "model", "url"]:
        parser.add_argument(f"--{flag}")
    args = parser.parse_args()
    if args.status:
        print(review_status(args.status))
        return
    del args.status
    if not all(vars(args).values()):
        parser.error("--directory, --title, --model and --url are required to start a review")
    print(json.dumps(start_review(**vars(args))))


if __name__ == "__main__":
    main()
