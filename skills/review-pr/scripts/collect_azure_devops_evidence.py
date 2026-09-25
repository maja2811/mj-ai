#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_ORGANIZATION = "https://dev.azure.com/dsbdk"
DEFAULT_PROJECT = "DSB Azure - Data Lakehouse Projects"

CODE_LOG_PATTERN = re.compile(
    r"yaml|validat|databricks|lint|ruff|format|mypy|type[- ]?check|"
    r"test|pytest|unit|integration|package|build|archive|copy folders|"
    r"publish artifact|deploy|notebook|bundle|wheel|python",
    re.IGNORECASE,
)
SETUP_LOG_PATTERN = re.compile(
    r"checkout|initialize job|finalize job|post-job|install|dependency|"
    r"key[- ]?vault|secret|setup|cache|use python|configure|download",
    re.IGNORECASE,
)
PROBLEM_RESULTS = {"failed", "succeededwithissues", "partiallysucceeded"}


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Collect Azure DevOps evidence for builds attached to a GitHub PR head."
        )
    )
    parser.add_argument("--pr-url", help="GitHub PR URL")
    parser.add_argument(
        "--manifest-path",
        help="Path to pr-manifest.json from clone_pr_head.py",
    )
    parser.add_argument(
        "--workspace",
        help="Review workspace; defaults to the manifest workspace or current directory",
    )
    parser.add_argument(
        "--organization",
        default=DEFAULT_ORGANIZATION,
        help=f"Azure DevOps organization URL (default: {DEFAULT_ORGANIZATION})",
    )
    parser.add_argument(
        "--project",
        default=DEFAULT_PROJECT,
        help=f"Azure DevOps project (default: {DEFAULT_PROJECT})",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the evidence manifest JSON to stdout",
    )
    return parser


def require_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Required CLI not found: {name}")


def run_json(command: list[str]) -> Any:
    try:
        result = subprocess.run(
            command,
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


def refresh_evidence_dir(path: Path) -> None:
    for pattern in (
        "status-check-rollup.json",
        "azure-devops-manifest.json",
        "build-*.json",
        "build-*-timeline.json",
        "build-*-log-*.txt",
    ):
        for stale_file in path.glob(pattern):
            if stale_file.is_file():
                stale_file.unlink()


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


def extract_urls(value: Any) -> list[str]:
    urls: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in {"targeturl", "detailsurl", "url", "link"}:
                if isinstance(item, str) and item:
                    urls.append(item)
            else:
                urls.extend(extract_urls(item))
    elif isinstance(value, list):
        for item in value:
            urls.extend(extract_urls(item))
    return urls


def extract_build_ids_from_value(value: Any) -> set[str]:
    build_ids: set[str] = set()
    if not isinstance(value, str):
        return build_ids

    build_ids.update(re.findall(r"[?&]buildId=(\d+)", value))
    build_ids.update(re.findall(r"/_build/results/.*?buildId=(\d+)", value))

    # Azure check-run external IDs commonly look like pipelineId|buildId|projectId.
    for token in re.split(r"[^0-9]+", value):
        if len(token) >= 5:
            build_ids.add(token)

    return build_ids


def extract_check_build_ids(check: dict[str, Any]) -> list[str]:
    build_ids: set[str] = set()
    for url in extract_urls(check):
        build_ids.update(extract_build_ids_from_value(url))

    external_id = check.get("externalId") or check.get("external_id")
    build_ids.update(extract_build_ids_from_value(external_id))
    return sorted(build_ids, key=int)


def sanitize_filename(value: str) -> str:
    lowered = value.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered)
    return slug.strip("-") or "log"


def normalize_result(value: Any) -> str:
    return str(value or "").replace("_", "").replace(" ", "").lower()


def should_pull_log(record: dict[str, Any]) -> tuple[bool, str]:
    log = record.get("log") or {}
    if not log.get("id"):
        return False, "no log id"

    if record.get("type") != "Task":
        return False, "non-task rollup log"

    result = normalize_result(record.get("result"))
    name = str(record.get("name") or "")
    lowered_name = name.lower()

    if result in PROBLEM_RESULTS:
        return True, f"task result is {record.get('result')}"
    if record.get("state") == "inProgress":
        return False, "task still in progress"
    if result == "skipped":
        return False, "task was skipped"
    if SETUP_LOG_PATTERN.search(lowered_name):
        if "install" in lowered_name or "dependency" in lowered_name:
            return False, "dependency installation log"
        return False, "setup/plumbing log"
    if CODE_LOG_PATTERN.search(name):
        return True, "code-produced validation/build/deploy log"
    return False, "not a code-produced task"


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


def fetch_build(build_id: str, organization: str, project: str) -> dict[str, Any]:
    return run_json(
        [
            "az",
            "pipelines",
            "build",
            "show",
            "--id",
            build_id,
            "--organization",
            organization,
            "--project",
            project,
            "--output",
            "json",
        ]
    )


def fetch_timeline(build_id: str, organization: str, project: str) -> dict[str, Any]:
    return run_json(
        [
            "az",
            "devops",
            "invoke",
            "--organization",
            organization,
            "--area",
            "build",
            "--resource",
            "timeline",
            "--route-parameters",
            f"project={project}",
            f"buildId={build_id}",
            "--output",
            "json",
        ]
    )


def fetch_log(build_id: str, log_id: str, organization: str, project: str) -> dict[str, Any]:
    return run_json(
        [
            "az",
            "devops",
            "invoke",
            "--organization",
            organization,
            "--area",
            "build",
            "--resource",
            "logs",
            "--route-parameters",
            f"project={project}",
            f"buildId={build_id}",
            f"logId={log_id}",
            "--output",
            "json",
        ]
    )


def log_payload_to_text(payload: dict[str, Any]) -> str:
    value = payload.get("value")
    if isinstance(value, list):
        return "\n".join(str(line) for line in value) + "\n"
    return json.dumps(payload, indent=2) + "\n"


def main() -> int:
    args = build_parser().parse_args()
    require_tool("gh")

    manifest = read_manifest(args.manifest_path)
    pr_url = args.pr_url or manifest.get("pr_url")
    head_sha = manifest.get("head_sha")
    if not pr_url:
        raise SystemExit("Provide --pr-url or --manifest-path with pr_url.")

    workspace = ensure_workspace(args, manifest)
    evidence_dir = workspace / "azure-devops"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    refresh_evidence_dir(evidence_dir)

    eprint(f"Fetching PR status rollup for {pr_url}")
    rollup = fetch_pr_rollup(pr_url)
    write_json(evidence_dir / "status-check-rollup.json", rollup)

    current_head = rollup.get("headRefOid")
    if head_sha and current_head and head_sha != current_head:
        raise RuntimeError(
            "PR head changed after artifact collection. "
            f"Manifest head {head_sha}, current head {current_head}."
        )
    if not head_sha:
        head_sha = current_head

    checks = rollup.get("statusCheckRollup") or []
    attached_build_ids: set[str] = set()
    check_summaries: list[dict[str, Any]] = []
    for check in checks:
        if not isinstance(check, dict):
            continue
        build_ids = extract_check_build_ids(check)
        attached_build_ids.update(build_ids)
        check_summaries.append(
            {
                "type": check.get("__typename"),
                "name": check.get("name") or check.get("context"),
                "state": check.get("state"),
                "status": check.get("status"),
                "conclusion": check.get("conclusion"),
                "detailsUrl": check.get("detailsUrl"),
                "targetUrl": check.get("targetUrl"),
                "externalId": check.get("externalId") or check.get("external_id"),
                "azure_build_ids": build_ids,
            }
        )

    azure_manifest: dict[str, Any] = {
        "pr_url": pr_url,
        "head_sha": head_sha,
        "organization": args.organization,
        "project": args.project,
        "evidence_dir": str(evidence_dir),
        "status_check_rollup_path": str(evidence_dir / "status-check-rollup.json"),
        "checks": check_summaries,
        "azure_build_ids": sorted(attached_build_ids, key=int),
        "builds": [],
    }

    if not attached_build_ids:
        write_json(evidence_dir / "azure-devops-manifest.json", azure_manifest)
        if args.json:
            print(json.dumps(azure_manifest, indent=2))
        else:
            print(f"No Azure DevOps build IDs found in PR-head checks for {pr_url}.")
        return 0

    require_tool("az")

    for build_id in sorted(attached_build_ids, key=int):
        eprint(f"Fetching Azure DevOps build {build_id}")
        build = fetch_build(build_id, args.organization, args.project)
        build_path = evidence_dir / f"build-{build_id}.json"
        write_json(build_path, build)

        source_version = build.get("sourceVersion")
        source_version_matches_head = bool(head_sha and source_version == head_sha)

        eprint(f"Fetching Azure DevOps timeline for build {build_id}")
        timeline = fetch_timeline(build_id, args.organization, args.project)
        timeline_path = evidence_dir / f"build-{build_id}-timeline.json"
        write_json(timeline_path, timeline)

        build_summary: dict[str, Any] = {
            "build_id": build_id,
            "build_path": str(build_path),
            "timeline_path": str(timeline_path),
            "definition": build.get("definition"),
            "repository": build.get("repository"),
            "sourceBranch": build.get("sourceBranch"),
            "sourceVersion": source_version,
            "source_version_matches_head": source_version_matches_head,
            "status": build.get("status"),
            "result": build.get("result"),
            "url": build.get("url"),
            "pulled_logs": [],
            "skipped_logs": [],
        }

        for record in timeline.get("records") or []:
            if not isinstance(record, dict):
                continue
            log = record.get("log") or {}
            log_id = log.get("id")
            should_pull, reason = should_pull_log(record)
            record_summary = {
                "name": record.get("name"),
                "type": record.get("type"),
                "state": record.get("state"),
                "result": record.get("result"),
                "log_id": log_id,
                "reason": reason,
            }
            if not should_pull:
                build_summary["skipped_logs"].append(record_summary)
                continue

            safe_name = sanitize_filename(str(record.get("name") or f"log-{log_id}"))
            log_path = evidence_dir / f"build-{build_id}-log-{log_id}-{safe_name}.txt"
            eprint(f"Fetching log {log_id} for build {build_id}: {record.get('name')}")
            payload = fetch_log(str(build_id), str(log_id), args.organization, args.project)
            log_path.write_text(log_payload_to_text(payload), encoding="utf-8")
            record_summary["path"] = str(log_path)
            build_summary["pulled_logs"].append(record_summary)

        azure_manifest["builds"].append(build_summary)

    manifest_path = evidence_dir / "azure-devops-manifest.json"
    write_json(manifest_path, azure_manifest)

    if args.json:
        print(json.dumps(azure_manifest, indent=2))
    else:
        print(f"Azure DevOps evidence manifest: {manifest_path}")
        for build in azure_manifest["builds"]:
            print(
                "build {build_id}: {pulled} logs pulled, {skipped} logs skipped".format(
                    build_id=build["build_id"],
                    pulled=len(build["pulled_logs"]),
                    skipped=len(build["skipped_logs"]),
                )
            )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        eprint(str(exc))
        raise
