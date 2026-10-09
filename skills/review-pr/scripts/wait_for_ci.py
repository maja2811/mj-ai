#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


DEFAULT_POLL_INTERVAL_SECONDS = 30
DEFAULT_TIMEOUT_SECONDS = 7200
DEFAULT_EMPTY_GRACE_SECONDS = 120

PENDING_VALUES = {
    "expected",
    "inprogress",
    "notstarted",
    "pending",
    "queued",
    "requested",
    "running",
    "waiting",
}

TERMINAL_STATE_VALUES = {
    "cancelled",
    "canceled",
    "error",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "success",
    "timedout",
}


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize(value: Any) -> str:
    return str(value or "").replace("_", "").replace("-", "").replace(" ", "").lower()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Wait for GitHub status checks attached to a review head to finish."
    )
    parser.add_argument("--pr-url", help="GitHub PR URL")
    parser.add_argument(
        "--manifest-path",
        help="Path to pr-manifest.json from the review artifact helper",
    )
    parser.add_argument(
        "--workspace",
        help="Review workspace; defaults to the manifest workspace or current directory",
    )
    parser.add_argument(
        "--poll-interval-seconds",
        type=int,
        default=DEFAULT_POLL_INTERVAL_SECONDS,
        help=f"Seconds between status polls (default: {DEFAULT_POLL_INTERVAL_SECONDS})",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"Maximum seconds to wait before failing (default: {DEFAULT_TIMEOUT_SECONDS})",
    )
    parser.add_argument(
        "--empty-grace-seconds",
        type=int,
        default=DEFAULT_EMPTY_GRACE_SECONDS,
        help=(
            "Seconds to keep polling when no checks are visible yet, to allow CI "
            f"systems to attach checks (default: {DEFAULT_EMPTY_GRACE_SECONDS})"
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the final wait manifest JSON to stdout",
    )
    return parser


def require_gh() -> None:
    if shutil.which("gh") is None:
        raise SystemExit("GitHub CLI 'gh' is required for this script.")


def run_json(command: list[str]) -> Any:
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"exit code {exc.returncode}"
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{detail}") from exc

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Expected JSON from command: {' '.join(command)}") from exc


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_manifest(path_value: str | None) -> dict[str, Any]:
    if not path_value:
        return {}
    path = Path(path_value).expanduser().resolve()
    return json.loads(path.read_text(encoding="utf-8"))


def ensure_workspace(args: argparse.Namespace, manifest: dict[str, Any]) -> Path:
    value = args.workspace or manifest.get("workspace")
    path = Path(value).expanduser().resolve() if value else Path.cwd().resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def check_name(check: dict[str, Any]) -> str:
    return str(
        check.get("name")
        or check.get("context")
        or check.get("workflowName")
        or check.get("workflow_name")
        or "unnamed check"
    )


def check_url(check: dict[str, Any]) -> str | None:
    value = (
        check.get("detailsUrl")
        or check.get("details_url")
        or check.get("targetUrl")
        or check.get("target_url")
        or check.get("html_url")
        or check.get("url")
    )
    return str(value) if value else None


def is_check_pending(check: dict[str, Any]) -> bool:
    status = normalize(check.get("status"))
    state = normalize(check.get("state"))
    bucket = normalize(check.get("bucket"))

    if status in PENDING_VALUES or state in PENDING_VALUES or bucket in PENDING_VALUES:
        return True
    if status == "completed":
        return False
    if state in TERMINAL_STATE_VALUES:
        return False
    if normalize(check.get("conclusion")):
        return False
    if check.get("completedAt") or check.get("completed_at"):
        return False
    return False


def summarize_checks(checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for check in checks:
        summaries.append(
            {
                "type": check.get("__typename") or check.get("type"),
                "name": check_name(check),
                "state": check.get("state"),
                "status": check.get("status"),
                "bucket": check.get("bucket"),
                "conclusion": check.get("conclusion"),
                "startedAt": check.get("startedAt") or check.get("started_at"),
                "completedAt": check.get("completedAt") or check.get("completed_at"),
                "url": check_url(check),
                "externalId": check.get("externalId") or check.get("external_id"),
                "is_pending": is_check_pending(check),
            }
        )
    return summaries


def fetch_pr_rollup(pr_url: str) -> dict[str, Any]:
    return run_json(
        [
            "gh",
            "pr",
            "view",
            pr_url,
            "--json",
            "headRefOid,statusCheckRollup",
        ]
    )


def fetch_commit_rollup(owner: str, repo: str, head_sha: str) -> dict[str, Any]:
    check_runs_payload = run_json(
        [
            "gh",
            "api",
            f"repos/{owner}/{repo}/commits/{head_sha}/check-runs",
        ]
    )
    statuses_payload = run_json(
        ["gh", "api", f"repos/{owner}/{repo}/commits/{head_sha}/status"]
    )

    rollup: list[dict[str, Any]] = []
    for check_run in check_runs_payload.get("check_runs") or []:
        if not isinstance(check_run, dict):
            continue
        rollup.append(
            {
                "__typename": "CheckRun",
                "name": check_run.get("name"),
                "status": check_run.get("status"),
                "conclusion": check_run.get("conclusion"),
                "startedAt": check_run.get("started_at"),
                "completedAt": check_run.get("completed_at"),
                "detailsUrl": check_run.get("details_url") or check_run.get("html_url"),
                "externalId": check_run.get("external_id"),
            }
        )

    for status in statuses_payload.get("statuses") or []:
        if not isinstance(status, dict):
            continue
        rollup.append(
            {
                "__typename": "StatusContext",
                "context": status.get("context"),
                "state": status.get("state"),
                "targetUrl": status.get("target_url"),
                "description": status.get("description"),
            }
        )

    return {
        "headRefOid": head_sha,
        "statusCheckRollup": rollup,
        "commitCheckRuns": check_runs_payload,
        "commitStatus": statuses_payload,
    }


def build_fetcher(
    args: argparse.Namespace, manifest: dict[str, Any]
) -> tuple[Callable[[], dict[str, Any]], str, str | None]:
    pr_url = args.pr_url or manifest.get("pr_url")
    head_sha = manifest.get("head_sha")
    if pr_url:
        return lambda: fetch_pr_rollup(str(pr_url)), str(pr_url), str(head_sha) if head_sha else None

    owner = manifest.get("owner")
    repo = manifest.get("repo")
    if owner and repo and head_sha:
        target = f"{owner}/{repo}@{head_sha}"
        return (
            lambda: fetch_commit_rollup(str(owner), str(repo), str(head_sha)),
            target,
            str(head_sha),
        )

    raise SystemExit(
        "Provide --pr-url, or --manifest-path containing pr_url, or owner/repo/head_sha."
    )


def make_wait_manifest(
    *,
    target: str,
    expected_head_sha: str | None,
    rollup_path: Path,
    started_at: str,
    last_checked_at: str,
    attempts: int,
    checks: list[dict[str, Any]],
    pending_checks: list[dict[str, Any]],
    completed: bool,
    timed_out: bool,
    timeout_seconds: int,
    poll_interval_seconds: int,
    empty_grace_seconds: int,
) -> dict[str, Any]:
    return {
        "target": target,
        "expected_head_sha": expected_head_sha,
        "started_at": started_at,
        "last_checked_at": last_checked_at,
        "attempts": attempts,
        "completed": completed,
        "timed_out": timed_out,
        "checks_found": len(checks),
        "pending_check_count": len(pending_checks),
        "pending_checks": pending_checks,
        "checks": checks,
        "status_rollup_path": str(rollup_path),
        "timeout_seconds": timeout_seconds,
        "poll_interval_seconds": poll_interval_seconds,
        "empty_grace_seconds": empty_grace_seconds,
    }


def wait_for_ci(
    *,
    fetcher: Callable[[], dict[str, Any]],
    target: str,
    expected_head_sha: str | None,
    output_dir: Path,
    poll_interval_seconds: int,
    timeout_seconds: int,
    empty_grace_seconds: int,
) -> tuple[int, dict[str, Any]]:
    rollup_path = output_dir / "status-check-rollup.json"
    wait_manifest_path = output_dir / "ci-wait-manifest.json"
    started_at = utc_now()
    started = time.monotonic()
    deadline = started + timeout_seconds
    empty_deadline = started + empty_grace_seconds
    saw_checks = False
    attempts = 0

    while True:
        attempts += 1
        rollup = fetcher()
        write_json(rollup_path, rollup)

        current_head = rollup.get("headRefOid")
        if expected_head_sha and current_head and expected_head_sha != current_head:
            raise RuntimeError(
                "Review head changed while waiting for CI. "
                f"Expected {expected_head_sha}, current {current_head}."
            )

        raw_checks = [
            check
            for check in (rollup.get("statusCheckRollup") or [])
            if isinstance(check, dict)
        ]
        if raw_checks:
            saw_checks = True

        checks = summarize_checks(raw_checks)
        pending_checks = [check for check in checks if check["is_pending"]]
        now = time.monotonic()
        no_checks_grace_expired = not checks and now >= empty_deadline
        completed = not pending_checks and (saw_checks or no_checks_grace_expired)
        timed_out = not completed and now >= deadline
        wait_manifest = make_wait_manifest(
            target=target,
            expected_head_sha=expected_head_sha,
            rollup_path=rollup_path,
            started_at=started_at,
            last_checked_at=utc_now(),
            attempts=attempts,
            checks=checks,
            pending_checks=pending_checks,
            completed=completed,
            timed_out=timed_out,
            timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
            empty_grace_seconds=empty_grace_seconds,
        )
        write_json(wait_manifest_path, wait_manifest)

        if completed:
            if checks:
                print(
                    f"CI checks reached terminal state for {target}: "
                    f"{len(checks)} checks, 0 pending."
                )
            else:
                print(
                    f"No CI checks were visible for {target} after "
                    f"{empty_grace_seconds} seconds."
                )
            return 0, wait_manifest

        if timed_out:
            pending_names = ", ".join(check["name"] for check in pending_checks) or "no checks visible"
            eprint(f"Timed out waiting for CI on {target}: {pending_names}")
            return 2, wait_manifest

        if pending_checks:
            pending_names = ", ".join(check["name"] for check in pending_checks)
            eprint(f"CI still pending for {target}: {pending_names}")
        else:
            eprint(f"No CI checks visible for {target}; waiting for checks to attach")

        sleep_for = min(poll_interval_seconds, max(0, deadline - time.monotonic()))
        if sleep_for > 0:
            time.sleep(sleep_for)


def main() -> int:
    args = build_parser().parse_args()
    if args.poll_interval_seconds <= 0:
        raise SystemExit("--poll-interval-seconds must be greater than 0.")
    if args.timeout_seconds <= 0:
        raise SystemExit("--timeout-seconds must be greater than 0.")
    if args.empty_grace_seconds < 0:
        raise SystemExit("--empty-grace-seconds cannot be negative.")

    require_gh()
    manifest = read_manifest(args.manifest_path)
    workspace = ensure_workspace(args, manifest)
    output_dir = workspace / "ci-wait"
    output_dir.mkdir(parents=True, exist_ok=True)
    fetcher, target, expected_head_sha = build_fetcher(args, manifest)
    exit_code, wait_manifest = wait_for_ci(
        fetcher=fetcher,
        target=target,
        expected_head_sha=expected_head_sha,
        output_dir=output_dir,
        poll_interval_seconds=args.poll_interval_seconds,
        timeout_seconds=args.timeout_seconds,
        empty_grace_seconds=args.empty_grace_seconds,
    )
    if args.json:
        print(json.dumps(wait_manifest, indent=2))
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        eprint(str(exc))
        raise
