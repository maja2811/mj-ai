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
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# Repo prefixes to monitor (owner/prefix).
# PRs in repos not matching any prefix are ignored.
# An empty list means: react to ANY PR where the current user is a
# requested reviewer, regardless of repo name.
REPO_PREFIXES: list[str] = []

# State file to track which (PR URL, commit SHA) pairs have been reviewed.
STATE_FILE = Path(__file__).parent.parent / ".review-poll-state.json"


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def load_state() -> dict[str, str]:
    """Load reviewed state: {pr_url: last_reviewed_commit_sha}."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_state(state: dict[str, str]) -> None:
    """Persist reviewed state."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


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


def find_reviewable_prs(state: dict[str, str]) -> list[dict[str, Any]]:
    """Find PRs that need review (not yet reviewed at current head commit)."""
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

        last_reviewed_sha = state.get(pr_url)
        if last_reviewed_sha == head_sha:
            continue

        reviewable.append(
            {
                "url": pr_url,
                "repo": repo_name,
                "number": pr["number"],
                "title": pr["title"],
                "head_sha": head_sha,
                "updated_at": pr["updatedAt"],
            }
        )

    return reviewable


def mark_reviewed(state: dict[str, str], pr_url: str, head_sha: str) -> None:
    """Mark a PR as reviewed at a specific commit SHA."""
    state[pr_url] = head_sha
    save_state(state)


def poll_once(output_json: bool = False) -> list[dict[str, Any]]:
    """Run a single poll cycle. Returns list of reviewable PRs."""
    state = load_state()

    eprint(f"[poll] Checking for pending reviews...")
    try:
        reviewable = find_reviewable_prs(state)
    except RuntimeError as e:
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
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    # Mark a PR as reviewed (called after a review completes)
    if args.mark_reviewed:
        state = load_state()
        try:
            head_sha = get_head_sha(args.mark_reviewed)
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
