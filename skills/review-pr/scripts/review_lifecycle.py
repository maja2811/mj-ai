#!/usr/bin/env python3
"""Register verified PR approvals and safely retain their review workspaces."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import quote, urlparse

from start_review_v2 import api


RECEIPT_NAME = ".review-lifecycle.json"
RETENTION = timedelta(days=7)
SESSION_ID = re.compile(r"^ses_[a-zA-Z0-9]+$")
SHA = re.compile(r"^[a-fA-F0-9]{40,64}$")
GH_TIMEOUT = 20


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def parse_time(value: object) -> datetime:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        stamp = value / 1000 if value > 100_000_000_000 else value
        return datetime.fromtimestamp(stamp, timezone.utc)
    if isinstance(value, str):
        if value.isdigit():
            return parse_time(int(value))
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    raise ValueError("Missing or invalid UTC timestamp")


def _root_path() -> Path:
    configured = os.environ.get("PR_WATCHER_REVIEW_TMP_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".local/share/opencode/.review-pr-tmp"


def _is_reparse(path: Path) -> bool:
    info = path.lstat()
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & reparse)


def _has_reparse_ancestor(path: Path) -> bool:
    absolute = path.absolute()
    return any(component.exists() and _is_reparse(component) for component in reversed((absolute, *absolute.parents)))


def _assert_managed_workspace(workspace: Path) -> tuple[Path, Path]:
    root_arg = _root_path()
    if not root_arg.exists():
        raise ValueError(f"Managed workspace root does not exist: {root_arg}")
    if _has_reparse_ancestor(root_arg):
        raise ValueError("Managed workspace root is a symlink or reparse point")
    root = root_arg.resolve(strict=True)
    candidate = workspace.expanduser().resolve(strict=True)
    if not candidate.is_dir() or candidate == root or candidate.parent != root:
        raise ValueError("Workspace must be a direct child of the configured review workspace root")
    if not candidate.name.startswith("review-pr-") or _is_reparse(candidate):
        raise ValueError("Workspace must be a real direct review-pr-* directory")
    return root, candidate


def _contained(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _read_json(path: Path) -> dict:
    if _is_reparse(path) or not path.is_file():
        raise ValueError(f"Expected a regular non-link file: {path.name}")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path.name}")
    return value


def _manifest(workspace: Path) -> dict:
    path = workspace / "pr-manifest.json"
    if path.parent.resolve(strict=True) != workspace or _is_reparse(path):
        raise ValueError("PR manifest must be inside the review workspace and must not be a link")
    data = _read_json(path)
    owner, repo, number = data.get("owner"), data.get("repo"), data.get("number")
    sha = data.get("head_sha")
    if (not isinstance(owner, str) or owner in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9_.-]+", owner) or
            not isinstance(repo, str) or repo in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9_.-]+", repo) or
            not isinstance(number, int) or isinstance(number, bool) or number < 1 or
            not isinstance(sha, str) or not SHA.fullmatch(sha) or data.get("cloned_head_sha") != sha):
        raise ValueError("PR manifest has an invalid PR identity or mismatched head SHA")
    parsed = urlparse(str(data.get("pr_url", "")))
    if (parsed.scheme != "https" or parsed.netloc.lower() != "github.com" or
            parsed.path.rstrip("/").lower() != f"/{owner}/{repo}/pull/{number}".lower() or
            parsed.query or parsed.fragment):
        raise ValueError("PR manifest URL does not match its owner/repository/number")
    declared_workspace = data.get("workspace")
    if not isinstance(declared_workspace, str) or Path(declared_workspace).expanduser().resolve() != workspace:
        raise ValueError("PR manifest workspace does not match its containing directory")
    clone_value = data.get("clone_path")
    if not isinstance(clone_value, str):
        raise ValueError("PR manifest is missing clone_path")
    clone = Path(clone_value).expanduser().resolve()
    if not _contained(clone, workspace) or clone == workspace or not clone.is_dir() or _is_reparse(clone):
        raise ValueError("PR clone path escapes the review workspace")
    return data


def _gh_json(*args: str):
    command = ["gh", "api", *args]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8", timeout=GH_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"GitHub lookup failed ({' '.join(command)}): {exc}") from exc
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"GitHub returned invalid JSON for {' '.join(command)}") from exc


def _reviews(payload) -> list[dict]:
    if not isinstance(payload, list):
        raise ValueError("GitHub review lookup did not return a list")
    result = []
    for page in payload:
        entries = page if isinstance(page, list) else [page]
        if any(not isinstance(item, dict) for item in entries):
            raise ValueError("GitHub review lookup returned malformed data")
        result.extend(entries)
    return result


def _normalize_body(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return normalized[:-1] if normalized.endswith("\n") else normalized


def _session_data(session_id: str) -> dict:
    response = api("get", f"/api/session/{session_id}")
    session = response.get("data") if isinstance(response, dict) else None
    if not isinstance(session, dict) or session.get("id") != session_id:
        raise ValueError("OpenCode returned a mismatched or malformed session")
    return session


def _session_location(session: dict) -> str | None:
    location = session.get("location")
    directory = location.get("directory") if isinstance(location, dict) else None
    return os.path.normcase(os.path.abspath(directory)) if isinstance(directory, str) and directory else None


def _session_mentions_pr(session: dict, session_id: str, pr_url: str, repo: str, number: int) -> bool:
    metadata = session.get("metadata")
    watcher = metadata.get("prWatcher") if isinstance(metadata, dict) else None
    if isinstance(watcher, dict) and isinstance(watcher.get("url"), str):
        return watcher["url"].rstrip("/") == pr_url.rstrip("/")
    title = session.get("title")
    if isinstance(title, str) and re.search(rf"(?:^|\s){re.escape(repo)}#{number}(?:\s|$)", title):
        return True
    cursor = None
    seen = set()
    for _ in range(100):
        path = f"/api/session/{session_id}/message?limit=100"
        path += "&order=asc" if cursor is None else f"&cursor={quote(cursor, safe='')}"
        response = api("get", path)
        messages = _data(response, "session messages")
        if not isinstance(messages, list):
            raise ValueError("Malformed session messages while validating the PR")
        if any(message.get("type") == "user" and isinstance(message.get("text"), str) and
               pr_url in message["text"] for message in messages if isinstance(message, dict)):
            return True
        cursor = _next_cursor(response, "session messages")
        if cursor is None:
            return False
        if cursor in seen:
            raise ValueError("Repeated session-message cursor")
        seen.add(cursor)
    raise ValueError("Session-message pagination exceeded 100 pages")


def record_approval(manifest_path: str, session_id: str, review_path: str) -> dict:
    if not SESSION_ID.fullmatch(session_id):
        raise ValueError("Invalid OpenCode session ID")
    manifest_file = Path(manifest_path).expanduser().resolve(strict=True)
    _, workspace = _assert_managed_workspace(manifest_file.parent)
    if manifest_file != workspace / "pr-manifest.json":
        raise ValueError("Manifest must be the workspace's pr-manifest.json")
    manifest = _manifest(workspace)
    review_file = Path(review_path).expanduser().resolve(strict=True)
    if _is_reparse(review_file) or not review_file.is_file():
        raise ValueError("Rendered review must be a regular file, not a link")
    body = review_file.read_text(encoding="utf-8")

    session = _session_data(session_id)
    session_location = _session_location(session)
    if session_location is None:
        raise ValueError("OpenCode session has no V2 location.directory")
    repo_full_name = f"{manifest['owner']}/{manifest['repo']}"
    if not _session_mentions_pr(session, session_id, manifest["pr_url"], repo_full_name, manifest["number"]):
        raise ValueError("Review session does not identify the manifest PR")

    owner, repo, number = manifest["owner"], manifest["repo"], manifest["number"]
    prefix = f"repos/{owner}/{repo}/pulls/{number}"
    user = _gh_json("user")
    login = user.get("login") if isinstance(user, dict) else None
    if not isinstance(login, str) or not login:
        raise ValueError("GitHub did not identify the authenticated user")
    pr = _gh_json(f"repos/{owner}/{repo}/pulls/{number}")
    head = pr.get("head") if isinstance(pr, dict) else None
    if not isinstance(head, dict) or head.get("sha") != manifest["head_sha"]:
        raise ValueError("PR head no longer matches the reviewed manifest")
    reviews = _reviews(_gh_json("--paginate", "--slurp", f"{prefix}/reviews"))
    normalized = _normalize_body(body)
    matches = []
    for review in reviews:
        author = review.get("user")
        if (isinstance(author, dict) and str(author.get("login", "")).casefold() == login.casefold() and
                review.get("state") == "APPROVED" and review.get("submitted_at") and
                review.get("commit_id") == manifest["head_sha"] and
                isinstance(review.get("body"), str) and _normalize_body(review["body"]) == normalized):
            matches.append(review)
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one submitted APPROVED review matching this user, head and body; found {len(matches)}")
    review = matches[0]
    review_id = review.get("id")
    if not isinstance(review_id, int) or isinstance(review_id, bool) or review_id < 1:
        raise ValueError("Verified GitHub review has no valid review ID")
    session_time = session.get("time")
    if not isinstance(session_time, dict) or not session_time.get("created"):
        raise ValueError("OpenCode session has no creation time to identify the posted review")
    if parse_time(review["submitted_at"]) < parse_time(session_time["created"]):
        raise ValueError("Matching approval predates this review session")

    receipt_path = workspace / RECEIPT_NAME
    immutable = {
        "version": 1,
        "session_id": session_id,
        "session_location": session_location,
        "pr": {"owner": owner, "repo": repo, "number": number, "url": manifest["pr_url"], "head_sha": manifest["head_sha"]},
        "approval": {
            "review_id": review_id,
            "author": login,
            "submitted_at": review["submitted_at"],
            "body_sha256": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        },
    }
    if receipt_path.exists():
        old = _read_json(receipt_path)
        if any(old.get(key) != value for key, value in immutable.items()):
            raise ValueError("A conflicting review lifecycle receipt already exists")
        return {"status": "already-registered", "review_id": review_id, "submitted_at": review["submitted_at"]}
    receipt = {**immutable, "registered_at": utc_text(utc_now())}
    try:
        with receipt_path.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(receipt, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        old = _read_json(receipt_path)
        if any(old.get(key) != value for key, value in immutable.items()):
            raise ValueError("A conflicting review lifecycle receipt already exists")
        return {"status": "already-registered", "review_id": review_id, "submitted_at": review["submitted_at"]}
    return {"status": "registered", "review_id": review_id, "submitted_at": review["submitted_at"], "receipt": str(receipt_path)}


def _data(response, description: str):
    if not isinstance(response, dict) or "data" not in response:
        raise ValueError(f"Malformed OpenCode response for {description}")
    return response["data"]


def _next_cursor(response: dict, description: str) -> str | None:
    cursor = response.get("cursor")
    if not isinstance(cursor, dict) or "next" not in cursor:
        raise ValueError(f"Malformed pagination cursor for {description}")
    value = cursor["next"]
    if value is not None and (not isinstance(value, str) or not value):
        raise ValueError(f"Invalid pagination cursor for {description}")
    return value


def _children(session_id: str) -> list[str]:
    cursor = None
    seen_cursors = set()
    ids = []
    for _ in range(100):
        path = f"/api/session?parentID={quote(session_id, safe='')}"
        if cursor:
            path += f"&cursor={quote(cursor, safe='')}"
        response = api("get", path)
        data = _data(response, "child sessions")
        if not isinstance(data, list):
            raise ValueError("Malformed child session list")
        for item in data:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not SESSION_ID.fullmatch(item["id"]):
                raise ValueError("Malformed child session entry")
            ids.append(item["id"])
        next_cursor = _next_cursor(response, "child sessions")
        if next_cursor is None:
            return ids
        if next_cursor in seen_cursors:
            raise ValueError("Invalid or repeated child-session pagination cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    raise ValueError("Child-session pagination exceeded 100 pages")


def _has_pending(session_id: str, kind: str) -> bool:
    data = _data(api("get", f"/api/session/{session_id}/{kind}"), kind)
    if data in (None, [], {}):
        return False
    if isinstance(data, (list, dict)):
        return bool(data)
    raise ValueError(f"Malformed pending {kind} response")


def _last_message_succeeded(session_id: str) -> bool:
    response = api("get", f"/api/session/{session_id}/message?limit=1&order=desc")
    data = _data(response, "last message")
    if not isinstance(data, list) or not data:
        return False
    _next_cursor(response, "last message")
    latest = data[0]
    time_data = latest.get("time") if isinstance(latest, dict) else None
    created = time_data.get("created") if isinstance(time_data, dict) else None
    return (isinstance(latest, dict) and isinstance(latest.get("id"), str) and latest["id"].startswith("msg_") and
            latest.get("type") == "idle" and latest.get("outcome") == "succeeded" and "error" not in latest and
            isinstance(created, (int, float)) and not isinstance(created, bool))


def _archived_marker(session: dict):
    times = session.get("time")
    return times.get("archived") if isinstance(times, dict) else None


def _is_archived(session: dict) -> bool:
    marker = _archived_marker(session)
    return isinstance(marker, (int, float)) and not isinstance(marker, bool) and marker > 0


def _session_tree(session_id: str, active: dict, seen=None) -> tuple[bool, dict | None]:
    seen = seen or set()
    if session_id in seen:
        raise ValueError("Cycle detected in child session tree")
    seen.add(session_id)
    if session_id in active:
        return False, None
    session = _session_data(session_id)
    settled = True
    for child_id in _children(session_id):
        child_settled, _ = _session_tree(child_id, active, seen)
        settled = settled and child_settled
    if _has_pending(session_id, "permission") or _has_pending(session_id, "form"):
        settled = False
    if session.get("outcome") not in (None, "succeeded"):
        settled = False
    if not _last_message_succeeded(session_id):
        settled = False
    return settled, session


def _active_sessions() -> dict:
    data = _data(api("get", "/api/session/active"), "active sessions")
    if not isinstance(data, dict):
        raise ValueError("Malformed active-session list")
    return data


def _write_receipt(workspace: Path, receipt: dict) -> None:
    target = workspace / RECEIPT_NAME
    if _is_reparse(target):
        raise ValueError("Lifecycle receipt became a symlink or reparse point")
    temporary = workspace / f"{RECEIPT_NAME}.{os.getpid()}.tmp"
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(receipt, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _safe_tree(workspace: Path, *, excluded: set[Path] | None = None) -> tuple[str, list[Path]]:
    """Reject all links and snapshot workspace files without hashing large clones."""
    excluded = excluded or set()
    digest = hashlib.sha256()
    repos = []
    stack = [workspace]
    while stack:
        directory = stack.pop()
        with os.scandir(directory) as entries:
            for entry in sorted(entries, key=lambda item: (item.name.casefold(), item.name)):
                path = Path(entry.path)
                if _is_reparse(path):
                    raise ValueError(f"Workspace contains a symlink or reparse point: {path.relative_to(workspace)}")
                if path in excluded:
                    continue
                info = entry.stat(follow_symlinks=False)
                relative = path.relative_to(workspace).as_posix()
                if entry.is_dir(follow_symlinks=False):
                    if (path / ".git").exists():
                        repos.append(path)
                    if relative != ".git":
                        digest.update(f"D\0{relative}\0".encode("utf-8", errors="surrogateescape"))
                    stack.append(path)
                elif entry.is_file(follow_symlinks=False):
                    if ".git" not in path.parts:
                        digest.update(f"F\0{relative}\0{info.st_size}\0{info.st_mtime_ns}\0".encode("utf-8", errors="surrogateescape"))
                else:
                    raise ValueError(f"Workspace contains a non-regular entry: {relative}")
    return digest.hexdigest(), repos


def _git_state(repos: list[Path], workspace: Path) -> tuple[dict[str, str], list[str]]:
    heads = {}
    dirty = []
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
    for repo in repos:
        relative = repo.relative_to(workspace).as_posix()
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=repo, check=True,
                capture_output=True, text=True, timeout=15, env=env,
            )
            heads[relative] = result.stdout.strip()
            status = subprocess.run(
                ["git", "status", "--porcelain", "--untracked-files=all"], cwd=repo,
                check=True, capture_output=True, text=True, timeout=15, env=env,
            )
            if status.stdout.strip():
                dirty.append(relative)
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeError(f"Could not verify Git workspace {relative}: {exc}") from exc
    return heads, dirty


def _receipt_matches(receipt: dict, manifest: dict) -> bool:
    pr = receipt.get("pr")
    approval = receipt.get("approval")
    valid = (
        receipt.get("version") == 1 and not isinstance(receipt.get("version"), bool) and isinstance(receipt.get("session_id"), str) and
        SESSION_ID.fullmatch(receipt["session_id"]) is not None and isinstance(pr, dict) and
        isinstance(receipt.get("session_location"), str) and bool(receipt["session_location"]) and
        pr == {"owner": manifest["owner"], "repo": manifest["repo"], "number": manifest["number"],
               "url": manifest["pr_url"], "head_sha": manifest["head_sha"]} and
        isinstance(approval, dict) and isinstance(approval.get("review_id"), int) and
        not isinstance(approval.get("review_id"), bool) and approval["review_id"] > 0 and
        isinstance(approval.get("author"), str) and bool(approval["author"]) and
        isinstance(approval.get("submitted_at"), str) and
        isinstance(approval.get("body_sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", approval["body_sha256"]) is not None and
        isinstance(receipt.get("registered_at"), str)
    )
    if not valid:
        return False
    try:
        parse_time(approval["submitted_at"])
        registered = parse_time(receipt["registered_at"])
        return not receipt.get("archived_at") or parse_time(receipt["archived_at"]) >= registered
    except (TypeError, ValueError, OverflowError):
        return False


def _same_session_location(session: dict, receipt: dict) -> bool:
    return _session_location(session) == receipt.get("session_location")


def _mark_preserved(workspace: Path, receipt: dict, reason: str, dry_run: bool) -> None:
    print(f"WARN: preserving {workspace.name}: {reason}")
    if not dry_run and not receipt.get("preserved_reason"):
        receipt["preserved_reason"] = reason
        _write_receipt(workspace, receipt)


def _maintain_workspace(workspace: Path, dry_run: bool, now: datetime) -> None:
    root, workspace = _assert_managed_workspace(workspace)
    receipt_path = workspace / RECEIPT_NAME
    if not receipt_path.exists():
        return
    receipt = _read_json(receipt_path)
    manifest = _manifest(workspace)
    if not _receipt_matches(receipt, manifest):
        print(f"WARN: preserving {workspace.name}: receipt/manifest identity mismatch")
        return
    if receipt.get("preserved_reason"):
        return

    session_id = receipt["session_id"]
    active = _active_sessions()
    settled, session = _session_tree(session_id, active)
    if session is None:
        print(f"Deferred {workspace.name}: review session is still running")
        return
    if not _same_session_location(session, receipt):
        _mark_preserved(workspace, receipt, "review session location changed", dry_run)
        return
    if not _session_mentions_pr(session, session_id, manifest["pr_url"], f"{manifest['owner']}/{manifest['repo']}", manifest["number"]):
        _mark_preserved(workspace, receipt, "review session/PR identity mismatch", dry_run)
        return
    marker = _archived_marker(session)
    archived = _is_archived(session)
    archived_at = receipt.get("archived_at")

    if archived_at:
        try:
            stored_time = parse_time(archived_at)
            current_marker = parse_time(marker)
        except (TypeError, ValueError, OverflowError):
            _mark_preserved(workspace, receipt, "archive timestamp is malformed or missing", dry_run)
            return
        if not archived or current_marker != parse_time(receipt.get("archived_marker")):
            _mark_preserved(workspace, receipt, "review session was restored or re-archived", dry_run)
            return
        if not settled:
            print(f"Deferred {workspace.name}: review session or a descendant is unsettled")
            return
        if now < stored_time + RETENTION:
            return

        excluded = {receipt_path}
        workspace_snapshot, repos = _safe_tree(workspace, excluded=excluded)
        heads, dirty = _git_state(repos, workspace)
        if dirty:
            _mark_preserved(workspace, receipt, f"Git work has local changes: {', '.join(dirty)}", dry_run)
            return
        if receipt.get("workspace_snapshot") != workspace_snapshot or receipt.get("git_heads") != heads:
            _mark_preserved(workspace, receipt, "workspace changed after approval was archived", dry_run)
            return
        if dry_run:
            print(f"Would remove eligible workspace: {workspace}")
            return

        # Recheck the remote state and local work immediately before deletion.
        active = _active_sessions()
        settled, latest = _session_tree(session_id, active)
        if latest is None or session_id in active or not settled:
            print(f"Deferred {workspace.name}: session became active or unsettled before cleanup")
            return
        if not _same_session_location(latest, receipt):
            _mark_preserved(workspace, receipt, "review session location changed before cleanup", dry_run)
            return
        if not _session_mentions_pr(latest, session_id, manifest["pr_url"], f"{manifest['owner']}/{manifest['repo']}", manifest["number"]):
            _mark_preserved(workspace, receipt, "review session/PR identity changed before cleanup", dry_run)
            return
        if not _is_archived(latest) or parse_time(_archived_marker(latest)) != parse_time(receipt["archived_marker"]):
            _mark_preserved(workspace, receipt, "review session changed before cleanup", dry_run)
            return
        final_snapshot, final_repos = _safe_tree(workspace, excluded=excluded)
        final_heads, final_dirty = _git_state(final_repos, workspace)
        if final_dirty or final_snapshot != workspace_snapshot or final_heads != heads:
            _mark_preserved(workspace, receipt, "workspace changed immediately before cleanup", dry_run)
            return
        if workspace.parent != root or workspace == root:
            raise ValueError("Refusing to remove a path other than one direct managed workspace")
        shutil.rmtree(workspace)
        print(f"Removed retained review workspace: {workspace}")
        return

    if archived:
        try:
            remote_time = parse_time(marker)
            registered_time = parse_time(receipt["registered_at"])
        except (TypeError, ValueError, OverflowError):
            print(f"WARN: preserving {workspace.name}: pre-existing archive time is unavailable")
            return
        if remote_time < registered_time:
            print(f"WARN: preserving {workspace.name}: session was archived before approval registration")
            return
        if not settled:
            print(f"Deferred {workspace.name}: archived review is still unsettled")
            return
        if dry_run:
            print(f"Would record the verified archive time for {workspace.name}")
            return
        # Recover an archive performed after the verified approval (including a retry
        # after a crash between the API response and writing the receipt).
        archive_time = remote_time
    else:
        if not settled:
            print(f"Deferred {workspace.name}: review session or a descendant is unsettled")
            return
        if dry_run:
            print(f"Would archive verified approval: {workspace.name} ({session_id})")
            return
        active = _active_sessions()
        settled, latest = _session_tree(session_id, active)
        if latest is None or session_id in active or not settled or _is_archived(latest):
            print(f"Deferred {workspace.name}: review session changed before archive")
            return
        if not _same_session_location(latest, receipt):
            _mark_preserved(workspace, receipt, "review session location changed before archive", dry_run)
            return
        if not _session_mentions_pr(latest, session_id, manifest["pr_url"], f"{manifest['owner']}/{manifest['repo']}", manifest["number"]):
            _mark_preserved(workspace, receipt, "review session/PR identity changed before archive", dry_run)
            return
        api("patch", f"/api/session/{session_id}", {"archived": True})
        verified = _session_data(session_id)
        marker = _archived_marker(verified)
        if not _is_archived(verified) or not marker:
            raise RuntimeError("OpenCode did not confirm the session archive")
        archive_time = parse_time(marker)

    receipt["archived_at"] = utc_text(archive_time)
    receipt["archived_marker"] = marker
    try:
        snapshot, repos = _safe_tree(workspace, excluded={receipt_path})
        heads, _ = _git_state(repos, workspace)
        receipt["workspace_snapshot"] = snapshot
        receipt["git_heads"] = heads
    except (OSError, RuntimeError, ValueError) as exc:
        # An unavailable snapshot means the artifacts remain retained indefinitely.
        receipt["preserved_reason"] = f"could not establish safe workspace snapshot: {exc}"
    _write_receipt(workspace, receipt)
    print(f"Archived verified approval: {session_id} at {receipt['archived_at']}")


def maintain(dry_run: bool = False) -> int:
    root_arg = _root_path()
    if not root_arg.exists():
        print(f"No review workspace root: {root_arg}")
        return 0
    if _has_reparse_ancestor(root_arg):
        print("WARN: preserving all review workspaces: configured root is a symlink or reparse point")
        return 0
    root = root_arg.resolve(strict=True)
    if not root.is_dir():
        print("WARN: preserving all review workspaces: configured root is not a directory")
        return 0
    try:
        with os.scandir(root) as entries:
            candidates = [Path(entry.path) for entry in entries if entry.name.startswith("review-pr-")]
    except OSError as exc:
        print(f"WARN: review maintenance could not scan the configured root: {exc}")
        return 0
    for workspace in candidates:
        try:
            if _is_reparse(workspace) or not workspace.is_dir():
                print(f"WARN: preserving {workspace.name}: not a real review workspace directory")
                continue
            _maintain_workspace(workspace, dry_run, utc_now())
        except Exception as exc:
            print(f"WARN: review maintenance deferred {workspace.name}: {type(exc).__name__}: {exc}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("record-approval", help="record a verified GitHub APPROVED review")
    register.add_argument("--manifest-path", required=True)
    register.add_argument("--session-id", required=True)
    register.add_argument("--review-path", required=True)
    maintenance = commands.add_parser("maintain", help="archive completed approvals and expire retained workspaces")
    maintenance.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "record-approval":
        print(json.dumps(record_approval(args.manifest_path, args.session_id, args.review_path), ensure_ascii=False))
        return 0
    return maintain(args.dry_run)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"review lifecycle: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
