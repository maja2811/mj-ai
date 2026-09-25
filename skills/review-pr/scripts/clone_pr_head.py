#!/usr/bin/env python3

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Clone the PR head commit into a workspace and save the PR metadata and diff."
        )
    )
    parser.add_argument("--pr-url", required=True, help="GitHub PR URL")
    parser.add_argument(
        "--head-sha",
        help="Optional exact PR head SHA to verify and clone",
    )
    parser.add_argument(
        "--workspace",
        help=(
            "Workspace directory; defaults to a hidden local workspace "
            "under ./.review-pr-tmp"
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a JSON manifest to stdout",
    )
    parser.add_argument(
        "--manifest-path",
        help="Optional path where the JSON manifest should be written",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="File path, basename, or glob pattern to exclude from saved diff output",
    )
    return parser


def ensure_workspace(path_value: str | None) -> Path:
    if path_value:
        path = Path(path_value).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    root = Path.cwd().resolve() / ".review-pr-tmp"
    root.mkdir(parents=True, exist_ok=True)

    while True:
        path = root / f"review-pr-clone-{uuid.uuid4().hex[:8]}"
        try:
            path.mkdir()
            return path
        except FileExistsError:
            continue


def parse_pr_url(pr_url: str) -> tuple[str, str, int]:
    parsed = urlparse(pr_url)
    if parsed.scheme not in {"http", "https"}:
        raise SystemExit("PR URL must use http or https.")
    if (parsed.netloc or "").lower() not in {"github.com", "www.github.com"}:
        raise SystemExit("PR URL must point to github.com.")

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 4 or parts[2] != "pull":
        raise SystemExit(
            "PR URL must look like https://github.com/<owner>/<repo>/pull/<number>."
        )

    try:
        number = int(parts[3])
    except ValueError as exc:
        raise SystemExit("PR number in URL is not valid.") from exc

    return parts[0], parts[1], number


def require_gh() -> None:
    if shutil.which("gh") is None:
        raise SystemExit("GitHub CLI 'gh' is required for this script.")


def run_gh_json(command: list[str], *, cwd: Path | None = None) -> Any:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
        )
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


def matches_excluded_pattern(file_path: str | None, patterns: list[str]) -> bool:
    if not file_path:
        return False
    basename = file_path.split("/")[-1]
    for pattern in patterns:
        if (
            pattern == file_path
            or pattern == basename
            or fnmatch.fnmatch(file_path, pattern)
            or fnmatch.fnmatch(basename, pattern)
        ):
            return True
    return False


def diff_path_from_header_line(line: str) -> str | None:
    if line.startswith("diff --git "):
        parts = line.split()
        if len(parts) >= 4:
            candidate = parts[3]
            return candidate[2:] if candidate.startswith("b/") else candidate
    if line.startswith("+++ b/"):
        return line[6:].strip()
    if line.startswith("--- a/"):
        return line[6:].strip()
    return None


def filter_unified_diff(diff_text: str, patterns: list[str]) -> str:
    patterns = [pattern.strip() for pattern in patterns if pattern and pattern.strip()]
    if not patterns:
        return diff_text

    output: list[str] = []
    current_block: list[str] = []
    current_excluded = False

    def flush() -> None:
        nonlocal current_block, current_excluded
        if current_block and not current_excluded:
            output.extend(current_block)
        current_block = []
        current_excluded = False

    for line in diff_text.splitlines(keepends=True):
        if line.startswith("diff --git "):
            flush()
            current_block = [line]
            current_excluded = matches_excluded_pattern(diff_path_from_header_line(line), patterns)
            continue

        if current_block:
            path = diff_path_from_header_line(line)
            if path and matches_excluded_pattern(path, patterns):
                current_excluded = True
            current_block.append(line)
        elif not matches_excluded_pattern(diff_path_from_header_line(line), patterns):
            output.append(line)

    flush()
    return "".join(output)


def flatten_paginated_collection(payload: Any) -> list[Any]:
    if not isinstance(payload, list):
        raise RuntimeError("Expected a paginated GitHub API payload to be a JSON array.")

    flattened: list[Any] = []
    for page in payload:
        if isinstance(page, list):
            flattened.extend(page)
        else:
            flattened.append(page)
    return flattened


def fetch_gh_collection(endpoint: str, *, cwd: Path | None = None) -> list[Any]:
    payload = run_gh_json(["gh", "api", "--paginate", "--slurp", endpoint], cwd=cwd)
    return flatten_paginated_collection(payload)


def run_gh_capture(
    command: list[str], output_path: Path, *, cwd: Path | None = None, exclude: list[str] | None = None
) -> None:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        stdout = (exc.stdout or b"").decode("utf-8", errors="replace").strip()
        detail = stderr or stdout or f"exit code {exc.returncode}"
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{detail}") from exc

    if exclude:
        diff_text = result.stdout.decode("utf-8", errors="replace")
        output_path.write_text(filter_unified_diff(diff_text, exclude), encoding="utf-8")
    else:
        output_path.write_bytes(result.stdout)


def run_checked_capture(command: list[str], *, cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"exit code {exc.returncode}"
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{detail}") from exc
    return result.stdout


def run_clone_pr_ref(
    repo_full_name: str, pr_number: int, head_sha: str, clone_path: Path
) -> str:
    clone_command = [
        "gh",
        "repo",
        "clone",
        repo_full_name,
        str(clone_path),
        "--",
        "--filter=blob:none",
        "--no-checkout",
    ]
    https_clone_command = [
        "git",
        "-c",
        "credential.helper=!gh auth git-credential",
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        f"https://github.com/{repo_full_name}.git",
        str(clone_path),
    ]
    fetch_ref = f"refs/pull/{pr_number}/head"
    local_ref = f"refs/remotes/origin/pr/{pr_number}"
    fetch_command = [
        "git",
        "fetch",
        "--depth",
        "1",
        "origin",
        f"{fetch_ref}:{local_ref}",
    ]
    checkout_command = ["git", "checkout", "--detach", head_sha]

    try:
        try:
            subprocess.run(clone_command, check=True, text=True)
        except subprocess.CalledProcessError:
            # Some GitHub orgs require SAML-authorized HTTPS credentials even when
            # gh is authenticated; fall back to GitHub CLI's credential helper.
            if clone_path.exists():
                if clone_path.is_dir():
                    shutil.rmtree(clone_path)
                else:
                    clone_path.unlink()
            subprocess.run(https_clone_command, check=True, text=True)
        subprocess.run(fetch_command, cwd=clone_path, check=True, text=True)
        subprocess.run(checkout_command, cwd=clone_path, check=True, text=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Failed to clone and check out PR head "
            f"{repo_full_name}#{pr_number}@{head_sha} (exit code {exc.returncode})."
        ) from exc

    return fetch_ref


def slugify(value: str) -> str:
    lowered = value.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered)
    return slug.strip("-") or "review"


def main() -> int:
    args = build_parser().parse_args()
    require_gh()
    excluded_patterns = [pattern.strip() for pattern in args.exclude if pattern.strip()]

    owner, repo, number = parse_pr_url(args.pr_url)
    workspace = ensure_workspace(args.workspace)
    pr_json_path = workspace / "pr.json"
    diff_path = workspace / "pr.diff"
    changed_files_path = workspace / "changed_files.json"
    issue_comments_path = workspace / "issue_comments.json"
    review_comments_path = workspace / "review_comments.json"
    reviews_path = workspace / "reviews.json"
    clone_path = workspace / "clone"

    # Reused workspaces must be refreshed fully so a failed prior run cannot leave
    # stale PR metadata, diff output, or an out-of-date clone behind.
    for stale_file in (
        pr_json_path,
        diff_path,
        changed_files_path,
        issue_comments_path,
        review_comments_path,
        reviews_path,
    ):
        try:
            stale_file.unlink()
        except FileNotFoundError:
            pass

    if clone_path.exists():
        if clone_path.is_dir():
            shutil.rmtree(clone_path)
        else:
            clone_path.unlink()

    eprint(f"Workspace: {workspace}")
    eprint(f"Fetching PR metadata for {owner}/{repo}#{number}")

    pr_data = run_gh_json(["gh", "api", f"repos/{owner}/{repo}/pulls/{number}"])
    write_json(pr_json_path, pr_data)

    eprint("Fetching PR discussion artifacts")
    changed_files_raw = fetch_gh_collection(f"repos/{owner}/{repo}/pulls/{number}/files")
    changed_files = []
    for file_info in changed_files_raw:
        if not isinstance(file_info, dict):
            continue
        path = file_info.get("filename")
        if matches_excluded_pattern(str(path or ""), excluded_patterns):
            continue
        changed_files.append(
            {
                "path": path,
                "status": file_info.get("status"),
                "additions": file_info.get("additions", 0),
                "deletions": file_info.get("deletions", 0),
            }
        )
    write_json(changed_files_path, changed_files)

    issue_comments = fetch_gh_collection(
        f"repos/{owner}/{repo}/issues/{number}/comments"
    )
    review_comments = fetch_gh_collection(
        f"repos/{owner}/{repo}/pulls/{number}/comments"
    )
    reviews = fetch_gh_collection(f"repos/{owner}/{repo}/pulls/{number}/reviews")
    write_json(issue_comments_path, issue_comments)
    write_json(review_comments_path, review_comments)
    write_json(reviews_path, reviews)

    head = pr_data.get("head") or {}
    base = pr_data.get("base") or {}
    head_repo = head.get("repo") or {}
    base_repo = base.get("repo") or {}
    base_repo_full_name = base_repo.get("full_name") or f"{owner}/{repo}"
    repo_full_name = head_repo.get("full_name") or head.get("label") or base_repo_full_name
    head_ref = head.get("ref")
    head_sha = head.get("sha")
    base_sha = base.get("sha")
    base_ref = base.get("ref")
    title = pr_data.get("title") or ""

    if not base_repo_full_name or not head_sha:
        raise RuntimeError(
            "PR metadata did not include a base repository and head commit SHA."
        )

    requested_head_sha = args.head_sha.strip() if args.head_sha else None
    if requested_head_sha and head_sha != requested_head_sha:
        raise RuntimeError(
            "Requested PR head SHA does not match the current PR head. "
            f"Requested {requested_head_sha}, current {head_sha}."
        )

    eprint(f"Cloning {base_repo_full_name} PR ref for {repo_full_name}@{head_ref}")
    clone_ref = run_clone_pr_ref(base_repo_full_name, number, head_sha, clone_path)

    cloned_head_sha = run_checked_capture(
        ["git", "rev-parse", "HEAD"], cwd=clone_path
    ).strip()
    if cloned_head_sha != head_sha:
        raise RuntimeError(
            "Cloned PR head does not match the current PR head SHA. "
            f"Current {head_sha}, cloned {cloned_head_sha}."
        )

    eprint("Saving PR diff")
    if base_sha and cloned_head_sha:
        compare_ref = f"{base_sha}...{cloned_head_sha}"
        run_gh_capture(
            ["gh", "api", f"repos/{owner}/{repo}/compare/{compare_ref}", "-H", "Accept: application/vnd.github.diff"],
            diff_path,
            exclude=excluded_patterns,
        )
    else:
        run_gh_capture(["gh", "pr", "diff", args.pr_url], diff_path, exclude=excluded_patterns)

    suggested_filename = f"pr-review-{slugify(owner)}-{slugify(repo)}-{number}.md"

    manifest = {
        "workspace": str(workspace),
        "clone_path": str(clone_path),
        "pr_json_path": str(pr_json_path),
        "diff_path": str(diff_path),
        "changed_files_path": str(changed_files_path),
        "issue_comments_path": str(issue_comments_path),
        "review_comments_path": str(review_comments_path),
        "reviews_path": str(reviews_path),
        "owner": owner,
        "repo": repo,
        "number": number,
        "title": title,
        "pr_url": pr_data.get("html_url") or args.pr_url,
        "head_repo_full_name": repo_full_name,
        "head_ref": head_ref,
        "head_sha": head_sha,
        "base_repo_full_name": base_repo_full_name,
        "base_sha": base_sha,
        "requested_head_sha": requested_head_sha,
        "cloned_head_sha": cloned_head_sha,
        "clone_repo_full_name": base_repo_full_name,
        "clone_ref": clone_ref,
        "clone_strategy": "github-pull-ref",
        "base_ref": base_ref,
        "excluded_patterns": excluded_patterns,
        "changed_file_count": len(changed_files),
        "issue_comment_count": len(issue_comments),
        "review_comment_count": len(review_comments),
        "review_count": len(reviews),
        "suggested_filename": suggested_filename,
    }

    if args.manifest_path:
        write_json(Path(args.manifest_path).expanduser().resolve(), manifest)

    if args.json:
        print(json.dumps(manifest, indent=2))
    elif not args.manifest_path:
        for key, value in manifest.items():
            print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        eprint(str(exc))
        raise
