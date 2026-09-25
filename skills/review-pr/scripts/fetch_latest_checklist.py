#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote


DEFAULT_REPO = "DanskeStatsbaner/bi-dlh-documentation"
DEFAULT_PATH = "checklist.md"


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fetch the latest review checklist from bi-dlh-documentation."
    )
    parser.add_argument(
        "--workspace",
        help="Review workspace; defaults to current directory",
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help=f"Checklist repository (default: {DEFAULT_REPO})",
    )
    parser.add_argument(
        "--path",
        default=DEFAULT_PATH,
        help=f"Checklist path in repository (default: {DEFAULT_PATH})",
    )
    parser.add_argument(
        "--ref",
        help="Optional ref to fetch; defaults to the repository default branch",
    )
    parser.add_argument(
        "--output-path",
        help="Where to write checklist markdown; defaults to <workspace>/checklist.md",
    )
    parser.add_argument(
        "--manifest-path",
        help="Where to write checklist manifest JSON; defaults to <workspace>/checklist-manifest.json",
    )
    parser.add_argument("--json", action="store_true", help="Print manifest JSON to stdout")
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


def run_text(command: list[str]) -> str:
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"exit code {exc.returncode}"
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{detail}") from exc
    return result.stdout


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> int:
    args = build_parser().parse_args()
    require_gh()

    workspace = Path(args.workspace).expanduser().resolve() if args.workspace else Path.cwd().resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    output_path = Path(args.output_path).expanduser().resolve() if args.output_path else workspace / "checklist.md"
    manifest_path = Path(args.manifest_path).expanduser().resolve() if args.manifest_path else workspace / "checklist-manifest.json"

    repo_data = run_json(["gh", "api", f"repos/{args.repo}"])
    default_ref = str(repo_data.get("default_branch") or "main") if isinstance(repo_data, dict) else "main"
    ref = args.ref or default_ref
    encoded_path = quote(args.path, safe="/")
    encoded_ref = quote(ref, safe="")

    eprint(f"Fetching {args.repo}/{args.path}@{ref}")
    checklist = run_text(
        [
            "gh",
            "api",
            f"repos/{args.repo}/contents/{encoded_path}?ref={encoded_ref}",
            "-H",
            "Accept: application/vnd.github.raw",
        ]
    )
    if not checklist.strip():
        raise RuntimeError(f"Fetched checklist is empty: {args.repo}/{args.path}@{ref}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(checklist, encoding="utf-8")

    manifest = {
        "repo": args.repo,
        "path": args.path,
        "ref": ref,
        "default_ref": default_ref,
        "checklist_path": str(output_path),
        "html_url": f"https://github.com/{args.repo}/blob/{ref}/{args.path}",
        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    write_json(manifest_path, manifest)

    if args.json:
        print(json.dumps(manifest, indent=2))
    else:
        print(f"Checklist: {output_path}")
        print(f"Checklist manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        eprint(str(exc))
        raise
