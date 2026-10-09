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
from urllib.parse import unquote, urlparse


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Collect review artifacts for a GitHub branch URL or repository root URL."
    )
    parser.add_argument(
        "--target-url",
        required=True,
        help="GitHub branch URL, repo root URL, or owner/repo",
    )
    parser.add_argument(
        "--head-ref",
        help="Optional branch/ref override; required only when reviewing a repo root at a non-default ref",
    )
    parser.add_argument(
        "--base-ref",
        help="Optional base branch/ref for branch comparison; defaults to repository default branch",
    )
    parser.add_argument(
        "--workspace",
        help="Workspace directory; defaults to a hidden local workspace under $PR_WATCHER_REVIEW_TMP_DIR or ~/.local/share/opencode/.review-pr-tmp (outside skill scan path)",
    )
    parser.add_argument(
        "--manifest-path",
        help="Optional path where the JSON manifest should be written",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="File path, basename, or glob pattern to exclude from diff/file lists",
    )
    parser.add_argument("--json", action="store_true", help="Print manifest JSON to stdout")
    return parser


def require_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Required CLI not found: {name}")


def ensure_workspace(path_value: str | None) -> Path:
    if path_value:
        path = Path(path_value).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    root = Path(
        os.environ.get("PR_WATCHER_REVIEW_TMP_DIR", "")
        or str(Path.home() / ".local/share/opencode/.review-pr-tmp")
    ).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    while True:
        path = root / f"review-target-{uuid.uuid4().hex[:8]}"
        try:
            path.mkdir()
            return path
        except FileExistsError:
            continue


def parse_target(target_url: str) -> dict[str, str | None]:
    target_url = target_url.strip()
    if re.fullmatch(r"[^/\s]+/[^/\s]+", target_url):
        owner, repo = target_url.split("/", 1)
        return {"kind": "repo", "owner": owner, "repo": repo.removesuffix(".git"), "branch": None}

    parsed = urlparse(target_url)
    if parsed.scheme not in {"http", "https"}:
        raise SystemExit("Target must be a GitHub URL or owner/repo.")
    if (parsed.netloc or "").lower() not in {"github.com", "www.github.com"}:
        raise SystemExit("Target URL must point to github.com.")

    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise SystemExit("Target URL must look like https://github.com/<owner>/<repo>.")
    owner = parts[0]
    repo = parts[1].removesuffix(".git")

    if len(parts) >= 4 and parts[2] == "tree":
        return {"kind": "branch", "owner": owner, "repo": repo, "branch": "/".join(parts[3:])}
    if len(parts) == 2:
        return {"kind": "repo", "owner": owner, "repo": repo, "branch": None}
    raise SystemExit("Only GitHub repo root URLs and /tree/<branch> URLs are supported.")


def run_json(command: list[str], *, cwd: Path | None = None) -> Any:
    try:
        result = subprocess.run(command, cwd=cwd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"exit code {exc.returncode}"
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{detail}") from exc
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Expected JSON from command: {' '.join(command)}") from exc


def run_capture(command: list[str], *, cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(command, cwd=cwd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"exit code {exc.returncode}"
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{detail}") from exc
    return result.stdout


def run_checked(command: list[str], *, cwd: Path | None = None) -> None:
    try:
        subprocess.run(command, cwd=cwd, check=True, text=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Command failed with exit code {exc.returncode}: {' '.join(command)}") from exc


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def resolve_commit(owner: str, repo: str, ref: str) -> str:
    import urllib.parse

    encoded_ref = urllib.parse.quote(ref, safe="")
    data = run_json(["gh", "api", f"repos/{owner}/{repo}/commits/{encoded_ref}"])
    sha = data.get("sha") if isinstance(data, dict) else None
    if not isinstance(sha, str) or not sha:
        raise RuntimeError(f"Could not resolve {owner}/{repo}@{ref} to a commit SHA.")
    return sha


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower())
    return slug.strip("-") or "review"


def matches_excluded_pattern(file_path: str | None, patterns: list[str]) -> bool:
    if not file_path:
        return False
    basename = file_path.split("/")[-1]
    return any(
        pattern == file_path
        or pattern == basename
        or fnmatch.fnmatch(file_path, pattern)
        or fnmatch.fnmatch(basename, pattern)
        for pattern in patterns
    )


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
        else:
            output.append(line)
    flush()
    return "".join(output)


def clone_ref(owner: str, repo: str, head_ref: str, head_sha: str, clone_path: Path) -> str:
    if clone_path.exists():
        if clone_path.is_dir():
            shutil.rmtree(clone_path)
        else:
            clone_path.unlink()

    run_checked(
        [
            "gh",
            "repo",
            "clone",
            f"{owner}/{repo}",
            str(clone_path),
            "--",
            "--filter=blob:none",
            "--no-checkout",
        ]
    )
    fetch_ref = f"refs/heads/{head_ref}"
    run_checked(
        ["git", "fetch", "--depth", "1", "origin", f"{fetch_ref}:refs/remotes/origin/review-head"],
        cwd=clone_path,
    )
    run_checked(["git", "checkout", "--detach", head_sha], cwd=clone_path)
    return fetch_ref


def list_repo_files(clone_path: Path, excluded_patterns: list[str]) -> list[dict[str, Any]]:
    output = run_capture(["git", "ls-tree", "-r", "--name-only", "HEAD"], cwd=clone_path)
    items: list[dict[str, Any]] = []
    for path in output.splitlines():
        if not path or matches_excluded_pattern(path, excluded_patterns):
            continue
        items.append({"path": path, "status": "present", "additions": 0, "deletions": 0})
    return items


def compare_files(owner: str, repo: str, base_sha: str, head_sha: str, excluded_patterns: list[str]) -> tuple[str, list[dict[str, Any]], list[str]]:
    compare_ref = f"{base_sha}...{head_sha}"
    compare_json = run_json(["gh", "api", f"repos/{owner}/{repo}/compare/{compare_ref}"])
    raw_diff = run_capture(
        [
            "gh",
            "api",
            f"repos/{owner}/{repo}/compare/{compare_ref}",
            "-H",
            "Accept: application/vnd.github.diff",
        ]
    )
    changed_files: list[dict[str, Any]] = []
    commit_messages: list[str] = []
    if isinstance(compare_json, dict):
        for file_info in compare_json.get("files") or []:
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
        for commit in compare_json.get("commits") or []:
            if not isinstance(commit, dict):
                continue
            message = ((commit.get("commit") or {}).get("message")) if isinstance(commit.get("commit"), dict) else None
            if isinstance(message, str):
                commit_messages.append(message)
    return filter_unified_diff(raw_diff, excluded_patterns), changed_files, commit_messages


def main() -> int:
    args = build_parser().parse_args()
    require_tool("gh")

    target = parse_target(args.target_url)
    owner = str(target["owner"])
    repo = str(target["repo"])
    workspace = ensure_workspace(args.workspace)
    repo_json_path = workspace / "repo.json"
    diff_path = workspace / "review.diff"
    changed_files_path = workspace / "changed_files.json"
    clone_path = workspace / "clone"
    excluded_patterns = [pattern.strip() for pattern in args.exclude if pattern.strip()]

    for stale_file in (repo_json_path, diff_path, changed_files_path):
        try:
            stale_file.unlink()
        except FileNotFoundError:
            pass

    eprint(f"Fetching repository metadata for {owner}/{repo}")
    repo_data = run_json(["gh", "api", f"repos/{owner}/{repo}"])
    write_json(repo_json_path, repo_data)
    default_branch = str((repo_data or {}).get("default_branch") or "main")

    head_ref = args.head_ref or target.get("branch") or default_branch
    base_ref = args.base_ref or default_branch
    if not isinstance(head_ref, str) or not head_ref:
        raise RuntimeError("Could not determine head ref for review target.")

    head_sha = resolve_commit(owner, repo, head_ref)
    base_sha = resolve_commit(owner, repo, base_ref)

    eprint(f"Cloning {owner}/{repo}@{head_ref}")
    clone_ref_value = clone_ref(owner, repo, head_ref, head_sha, clone_path)
    cloned_head_sha = run_capture(["git", "rev-parse", "HEAD"], cwd=clone_path).strip()
    if cloned_head_sha != head_sha:
        raise RuntimeError(f"Cloned head does not match expected SHA. Expected {head_sha}, got {cloned_head_sha}.")

    if head_sha == base_sha:
        diff_type = "full_repo"
        title = f"Repository {owner}/{repo} at {head_ref}"
        diff_text = ""
        changed_files = list_repo_files(clone_path, excluded_patterns)
        commit_messages: list[str] = []
    else:
        diff_type = "branch_compare"
        title = f"Branch {head_ref} vs {base_ref}"
        diff_text, changed_files, commit_messages = compare_files(owner, repo, base_sha, head_sha, excluded_patterns)

    diff_path.write_text(diff_text, encoding="utf-8")
    write_json(changed_files_path, changed_files)

    target_kind = "repo" if diff_type == "full_repo" else "branch"
    suggested_filename = f"review-{slugify(owner)}-{slugify(repo)}-{slugify(head_ref)}.md"
    manifest = {
        "workspace": str(workspace),
        "clone_path": str(clone_path),
        "repo_json_path": str(repo_json_path),
        "diff_path": str(diff_path),
        "changed_files_path": str(changed_files_path),
        "owner": owner,
        "repo": repo,
        "number": None,
        "title": title,
        "target_url": args.target_url,
        "target_kind": target_kind,
        "diff_type": diff_type,
        "head_ref": head_ref,
        "head_sha": head_sha,
        "base_ref": base_ref,
        "base_sha": base_sha,
        "cloned_head_sha": cloned_head_sha,
        "clone_repo_full_name": f"{owner}/{repo}",
        "clone_ref": clone_ref_value,
        "clone_strategy": "github-branch-ref",
        "excluded_patterns": excluded_patterns,
        "changed_file_count": len(changed_files),
        "commit_messages": commit_messages,
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
