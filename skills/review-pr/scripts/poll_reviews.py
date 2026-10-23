#!/usr/bin/env python3
"""Poll for pending PR reviews and output PR URLs ready for review.

Checks GitHub for open PRs where the current user is a requested reviewer
(directly or via team/CODEOWNERS). Filters by configurable repo prefixes
and tracks already-reviewed commit SHAs to avoid duplicate reviews.

Usage:
    python poll_reviews.py --once          # Single check, exit
    python poll_reviews.py --interval 60   # Poll every 60 seconds
    python poll_reviews.py --json          # Output JSON instead of text
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from start_review_v2 import review_status

# Repo prefixes to monitor (owner/prefix).
# PRs in repos not matching any prefix are ignored.
# An empty list means: react to ANY PR where the current user is a
# requested reviewer, regardless of repo name.
REPO_PREFIXES: list[str] = []

# Legacy strings are baseline/handled SHAs; new records track session outcomes.
STATE_FILE = Path(__file__).parent.parent / ".review-poll-state.json"
MAX_ATTEMPTS = 2
State = dict[str, str | dict[str, Any]]


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def load_state() -> State:
    """Preserve legacy marks and fail closed rather than replay a corrupt state."""
    if not STATE_FILE.exists():
        return {}
    state = json.loads(STATE_FILE.read_text(encoding="utf-8-sig"))
    if not isinstance(state, dict):
        raise ValueError("Review poll state must be a JSON object")
    for url, record in state.items():
        if isinstance(record, str) and re.fullmatch(r"[a-fA-F0-9]{40,64}", record):
            continue
        if (not isinstance(record, dict) or
                not re.fullmatch(r"[a-fA-F0-9]{40,64}", str(record.get("head_sha", ""))) or
                not re.fullmatch(r"ses_[a-zA-Z0-9]+", str(record.get("session_id", ""))) or
                type(record.get("attempt")) is not int or not 1 <= record["attempt"] <= MAX_ATTEMPTS or
                record.get("status") not in {"started", "working", "blocked", "completed", "failed", "interrupted"}):
            raise ValueError(f"Invalid review poll state for {url}")
    return state


def save_state(state: State) -> None:
    """Replace state atomically so an interrupted write cannot erase history."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=STATE_FILE.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(state, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            temporary.unlink()
            raise
    try:
        os.replace(temporary, STATE_FILE)
    finally:
        temporary.unlink(missing_ok=True)


def run_gh(*args: str) -> str:
    """Run a gh CLI command and return stdout."""
    result = subprocess.run(
        ["gh", *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def get_pending_prs() -> list[dict[str, Any]]:
    """Get open PRs where the current user is a requested reviewer."""
    raw = run_gh(
        "search",
        "prs",
        "--review-requested=@me",
        "--state=open",
        "--limit=50",
        "--json",
        "repository,number,title,url,updatedAt",
    )
    if not raw:
        return []
    return json.loads(raw)


def matches_prefix(repo_full_name: str) -> bool:
    """Check if a repo matches any of the configured prefixes.

    If no prefixes are configured, all repos match (react to any PR the
    current user is a requested reviewer on).
    """
    if not REPO_PREFIXES:
        return True
    return any(repo_full_name.startswith(prefix) for prefix in REPO_PREFIXES)


def get_head_sha(pr_url: str) -> str:
    """Get the head commit SHA for a PR."""
    # Parse owner/repo and number from URL
    # e.g. https://github.com/DanskeStatsbaner/bi-dlh-src-commercial-kts/pull/24
    parts = pr_url.rstrip("/").split("/")
    repo = f"{parts[-4]}/{parts[-3]}"
    number = parts[-1]
    return run_gh(
        "pr",
        "view",
        number,
        "--repo",
        repo,
        "--json",
        "headRefOid",
        "--jq",
        ".headRefOid",
    )


def refresh_sessions(state: State) -> dict[str, str]:
    """Settle launched sessions even after posting removes the review request."""
    statuses = {}
    changed = False
    for url, record in state.items():
        if isinstance(record, str) or record["status"] == "completed":
            continue
        try:
            status = review_status(record["session_id"])
        except Exception as exc:
            eprint(f"[poll] WARN: preserving {record['session_id']}; status unavailable: {exc}")
            continue
        if status not in {"working", "blocked", "done", "failed", "interrupted"}:
            raise ValueError(f"Unexpected review status: {status}")
        statuses[url] = status
        updated = {**record, "status": "completed" if status == "done" else status}
        if updated != record:
            state[url] = updated
            changed = True
    if changed:
        save_state(state)
    return statuses


def find_reviewable_prs(state: State) -> list[dict[str, Any]]:
    """Find PRs that need review (not yet reviewed at current head commit)."""
    statuses = refresh_sessions(state)
    pending = get_pending_prs()
    reviewable = []

    for pr in pending:
        repo_name = pr["repository"]["nameWithOwner"]
        if not matches_prefix(repo_name):
            continue

        pr_url = pr["url"]
        try:
            head_sha = get_head_sha(pr_url)
        except (RuntimeError, IndexError) as e:
            eprint(f"  Skipping {pr_url}: {e}")
            continue

        record = state.get(pr_url)
        if record == head_sha:
            continue
        attempt = 1
        if isinstance(record, dict) and record["head_sha"] == head_sha:
            if record["status"] == "completed":
                continue
            status = statuses.get(pr_url)
            if status in {None, "working", "blocked", "done"}:
                continue
            if record["attempt"] >= MAX_ATTEMPTS:
                eprint(f"[poll] WARN: {pr_url} review {status} after {MAX_ATTEMPTS} attempts; "
                       f"attach manually: opencode --session {record['session_id']}")
                continue
            attempt = record["attempt"] + 1

        reviewable.append(
            {
                "url": pr_url,
                "repo": repo_name,
                "number": pr["number"],
                "title": pr["title"],
                "head_sha": head_sha,
                "updated_at": pr["updatedAt"],
                "attempt": attempt,
            }
        )

    return reviewable


def mark_reviewed(state: State, pr_url: str, head_sha: str) -> None:
    """Mark a PR as reviewed at a specific commit SHA."""
    state[pr_url] = head_sha
    save_state(state)


def mark_started(state: State, pr_url: str, head_sha: str, session_id: str, attempt: int) -> None:
    """Track an exact launched head without claiming the review has completed."""
    if (not re.fullmatch(r"[a-fA-F0-9]{40,64}", head_sha) or
            not re.fullmatch(r"ses_[a-zA-Z0-9]+", session_id) or not 1 <= attempt <= MAX_ATTEMPTS):
        raise ValueError("Invalid review head, session ID or attempt")
    previous = state.get(pr_url)
    if isinstance(previous, dict) and previous["head_sha"] == head_sha and previous["session_id"] == session_id:
        return
    state[pr_url] = {"head_sha": head_sha, "session_id": session_id, "attempt": attempt, "status": "started"}
    save_state(state)


def poll_once(output_json: bool = False) -> list[dict[str, Any]]:
    """Run a single poll cycle. Returns list of reviewable PRs."""
    eprint(f"[poll] Checking for pending reviews...")
    try:
        state = load_state()
        reviewable = find_reviewable_prs(state)
    except (RuntimeError, ValueError, OSError) as e:
        eprint(f"[poll] Error: {e}")
        return []

    if not reviewable:
        eprint("[poll] No pending reviews found.")
        return []

    eprint(f"[poll] Found {len(reviewable)} PR(s) needing review:")
    for pr in reviewable:
        eprint(f"  - {pr['repo']}#{pr['number']}: {pr['title']}")

    if output_json:
        print(json.dumps(reviewable, indent=2))
    else:
        for pr in reviewable:
            print(pr["url"])

    return reviewable


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Poll for pending PR reviews assigned to the current GitHub user."
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single check and exit.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=60,
        help="Polling interval in seconds (default: 60). Ignored with --once.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="output_json",
        help="Output reviewable PRs as JSON.",
    )
    parser.add_argument(
        "--mark-reviewed",
        metavar="PR_URL",
        help="Mark a PR as reviewed at its current head SHA and exit.",
    )
    parser.add_argument("--mark-started", metavar="PR_URL", help="Record a launched session, not a completed review.")
    parser.add_argument("--head-sha", help="Exact head captured by the poll, without fetching a newer head.")
    parser.add_argument("--session-id")
    parser.add_argument("--attempt", type=int, default=1)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.mark_started:
        if args.mark_reviewed or not args.head_sha or not args.session_id:
            parser.error("--mark-started requires --head-sha and --session-id, without --mark-reviewed")
        mark_started(load_state(), args.mark_started, args.head_sha, args.session_id, args.attempt)
        eprint(f"[poll] Tracking {args.session_id} at {args.head_sha[:8]} (attempt {args.attempt})")
        return

    # Explicit baseline/manual marking; normal launches use --mark-started.
    if args.mark_reviewed:
        state = load_state()
        try:
            head_sha = args.head_sha or get_head_sha(args.mark_reviewed)
            mark_reviewed(state, args.mark_reviewed, head_sha)
            eprint(f"[poll] Marked {args.mark_reviewed} as reviewed at {head_sha[:8]}")
        except RuntimeError as e:
            eprint(f"[poll] Error marking reviewed: {e}")
            sys.exit(1)
        return

    if args.once:
        poll_once(output_json=args.output_json)
        return

    # Continuous polling loop
    eprint(f"[poll] Starting review poll loop (interval: {args.interval}s)")
    eprint(
        f"[poll] Monitoring repos: {', '.join(p.split('/')[-1] + '*' for p in REPO_PREFIXES)}"
    )
    eprint(f"[poll] State file: {STATE_FILE}")
    eprint("")

    while True:
        try:
            poll_once(output_json=args.output_json)
        except KeyboardInterrupt:
            eprint("\n[poll] Stopped.")
            break
        except Exception as e:
            eprint(f"[poll] Unexpected error: {e}")

        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            eprint("\n[poll] Stopped.")
            break


if __name__ == "__main__":
    main()
