#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Clone a GitHub repository into a review workspace so it can be "
            "inspected without leaving the current directory."
        )
    )
    parser.add_argument(
        "--repo",
        "--repo-url",
        dest="repo",
        required=True,
        help="GitHub repo as owner/name or https://github.com/owner/name",
    )
    parser.add_argument(
        "--workspace",
        help=(
            "Review workspace directory. If a path ending in reference-repos "
            "or reference-repos/<name> is supplied, it is normalized to avoid "
            "nested reference-repos directories. Defaults to a hidden local "
            "workspace under $PR_WATCHER_REVIEW_TMP_DIR or "
            "~/.local/share/opencode/.review-pr-tmp (outside skill scan path)"
        ),
    )
    parser.add_argument(
        "--ref",
        help="Optional branch, tag, or ref to clone",
    )
    parser.add_argument(
        "--directory-name",
        help="Optional directory name under <workspace>/reference-repos",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print a JSON manifest to stdout",
    )
    parser.add_argument(
        "--manifest-path",
        help="Optional path where a JSON clone manifest should be written",
    )
    return parser


def default_workspace() -> Path:
    root = Path(
        os.environ.get("PR_WATCHER_REVIEW_TMP_DIR", "")
        or str(Path.home() / ".local/share/opencode/.review-pr-tmp")
    ).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)

    while True:
        path = root / f"review-pr-reference-{uuid.uuid4().hex[:8]}"
        try:
            path.mkdir()
            return path
        except FileExistsError:
            continue


def resolve_clone_paths(
    path_value: str | None, repo_full_name: str, directory_name: str | None
) -> tuple[Path, Path, str, Path]:
    """Resolve review workspace, reference root, and clone path.

    The intended input is ``--workspace <WORKSPACE>``. Agents sometimes pass
    ``<WORKSPACE>/reference-repos`` or ``<WORKSPACE>/reference-repos/<name>``;
    normalize those forms instead of creating reference-repos/reference-repos.
    """
    inferred_directory_name = directory_name

    if path_value:
        raw_workspace = Path(path_value).expanduser().resolve()
        if raw_workspace.name == "reference-repos":
            workspace = raw_workspace.parent
            reference_root = raw_workspace
        elif raw_workspace.parent.name == "reference-repos":
            workspace = raw_workspace.parent.parent
            reference_root = raw_workspace.parent
            inferred_directory_name = inferred_directory_name or raw_workspace.name
        else:
            workspace = raw_workspace
            reference_root = workspace / "reference-repos"
        workspace.mkdir(parents=True, exist_ok=True)
        reference_root.mkdir(parents=True, exist_ok=True)
    else:
        workspace = default_workspace()
        reference_root = workspace / "reference-repos"
        reference_root.mkdir(parents=True, exist_ok=True)

    final_directory_name = inferred_directory_name or slugify(repo_full_name)
    clone_path = reference_root / final_directory_name
    return workspace, reference_root, final_directory_name, clone_path


def parse_repo(repo_value: str) -> str:
    repo_value = repo_value.strip()
    parsed = urlparse(repo_value)

    if parsed.scheme in {"http", "https"}:
        if (parsed.netloc or "").lower() not in {"github.com", "www.github.com"}:
            raise SystemExit("Repo URL must point to github.com.")
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) < 2:
            raise SystemExit(
                "Repo URL must look like https://github.com/<owner>/<repo>."
            )
        owner = parts[0]
        repo = parts[1]
        if repo.endswith(".git"):
            repo = repo[:-4]
        return f"{owner}/{repo}"

    if re.fullmatch(r"[^/\s]+/[^/\s]+", repo_value):
        return repo_value

    raise SystemExit(
        "Repo must look like owner/repo or https://github.com/<owner>/<repo>."
    )


def require_gh() -> None:
    if shutil.which("gh") is None:
        raise SystemExit("GitHub CLI 'gh' is required for this script.")


def remove_partial_clone(clone_path: Path) -> None:
    if not clone_path.exists():
        return
    if clone_path.is_dir():
        shutil.rmtree(clone_path)
    else:
        clone_path.unlink()


def run_clone_repo(
    repo_full_name: str, clone_path: Path, ref: str | None = None
) -> str:
    clone_args = ["--depth", "1"]
    if ref:
        clone_args.extend(["--branch", ref, "--single-branch"])

    clone_command = [
        "gh",
        "repo",
        "clone",
        repo_full_name,
        str(clone_path),
        "--",
        *clone_args,
    ]
    https_clone_command = [
        "git",
        "-c",
        "credential.helper=!gh auth git-credential",
        "clone",
        *clone_args,
        f"https://github.com/{repo_full_name}.git",
        str(clone_path),
    ]

    try:
        try:
            subprocess.run(clone_command, check=True, text=True)
            return "gh-repo-clone"
        except subprocess.CalledProcessError:
            # Some GitHub orgs require SAML-authorized HTTPS credentials even when
            # gh is authenticated; fall back to GitHub CLI's credential helper.
            remove_partial_clone(clone_path)
            subprocess.run(https_clone_command, check=True, text=True)
            return "https-gh-credential-helper"
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Failed to clone supporting repository "
            f"{repo_full_name} (exit code {exc.returncode})."
        ) from exc


def slugify(value: str) -> str:
    lowered = value.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered)
    return slug.strip("-") or "repo"


def run_git_output(
    clone_path: Path, args: list[str], *, allow_failure: bool = False
) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=clone_path,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as exc:
        if allow_failure:
            return None
        raise RuntimeError(
            "Failed to collect git metadata from supporting repository "
            f"{clone_path} (exit code {exc.returncode})."
        ) from exc
    return result.stdout.strip()


def collect_git_metadata(clone_path: Path) -> dict[str, object]:
    tags_output = run_git_output(
        clone_path, ["tag", "--points-at", "HEAD"], allow_failure=True
    )
    return {
        "resolved_head_sha": run_git_output(clone_path, ["rev-parse", "HEAD"]),
        "resolved_branch": run_git_output(
            clone_path, ["symbolic-ref", "--quiet", "--short", "HEAD"], allow_failure=True
        ),
        "resolved_tags": tags_output.splitlines() if tags_output else [],
        "resolved_describe": run_git_output(
            clone_path, ["describe", "--tags", "--always", "--dirty"], allow_failure=True
        ),
    }


def main() -> int:
    args = build_parser().parse_args()
    require_gh()

    repo_full_name = parse_repo(args.repo)
    workspace, reference_root, directory_name, clone_path = resolve_clone_paths(
        args.workspace, repo_full_name, args.directory_name
    )

    if clone_path.exists() and any(clone_path.iterdir()):
        raise SystemExit(f"Clone path already exists and is not empty: {clone_path}")

    eprint(f"Workspace: {workspace}")
    eprint(f"Cloning {repo_full_name}")
    clone_strategy = run_clone_repo(repo_full_name, clone_path, args.ref)
    git_metadata = collect_git_metadata(clone_path)

    manifest_path = (
        Path(args.manifest_path).expanduser().resolve()
        if args.manifest_path
        else None
    )

    manifest = {
        "workspace": str(workspace),
        "reference_root": str(reference_root),
        "repo_full_name": repo_full_name,
        "requested_ref": args.ref,
        "directory_name": directory_name,
        "clone_path": str(clone_path),
        "clone_strategy": clone_strategy,
        "repo_url": f"https://github.com/{repo_full_name}",
        **git_metadata,
    }
    if manifest_path:
        manifest["manifest_path"] = str(manifest_path)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )

    if args.json:
        print(json.dumps(manifest, indent=2))
    else:
        for key, value in manifest.items():
            print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        eprint(str(exc))
        raise
