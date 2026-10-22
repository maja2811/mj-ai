"""Standalone checks for literal OpenCode V2 API argument transport."""

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import start_review_v2 as starter


SHIM = """@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*
"""


def write_shim(directory: Path, *, native=True) -> tuple[Path, Path]:
    shim = directory / "opencode2.CMD"
    shim.write_text(SHIM, encoding="utf-8")
    executable = directory / "node_modules" / "@opencode" / "cli" / "bin" / "opencode.exe"
    if native:
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"fixture native executable")
    return shim, executable


def test_windows_shim_uses_native_with_literal_arguments():
    with TemporaryDirectory(prefix="api transport ") as temporary:
        shim, native = write_shim(Path(temporary))
        path = "/api/session/ses_example/message?limit=1&order=desc"
        body = {"text": 'A "quoted" body & % ^ ! | < >', "metadata": {"key": "æøå"}}
        payload = {"data": {"type": "idle", "outcome": "succeeded"}}
        completed = subprocess.CompletedProcess([], 0, json.dumps(payload), "")
        with patch.object(starter.os, "name", "nt"), \
                patch.object(starter.shutil, "which", return_value=str(shim)), \
                patch.object(starter.subprocess, "run", return_value=completed) as run:
            assert starter.api("post", path, body) == payload

        args, kwargs = run.call_args
        assert args[0] == [str(native), "api", "post", path, "--data", json.dumps(body)]
        assert args[0][3] == path and "&order=desc" in args[0][3]
        assert json.loads(args[0][-1]) == body
        assert kwargs == {"check": True, "capture_output": True, "encoding": "utf-8", "timeout": 30}


def test_direct_native_and_non_windows_resolution():
    with TemporaryDirectory(prefix="api transport ") as temporary:
        native = Path(temporary) / "opencode2.exe"
        native.write_bytes(b"fixture native executable")
        completed = subprocess.CompletedProcess([], 0, "{}", "")
        with patch.object(starter.os, "name", "nt"), \
                patch.object(starter.shutil, "which", return_value=str(native)), \
                patch.object(starter.subprocess, "run", return_value=completed) as run:
            assert starter.api("get", "/api/session/active") == {}
        assert run.call_args.args[0][0] == str(native)

        with patch.object(starter.os, "name", "posix"), \
                patch.object(starter.shutil, "which", return_value="/usr/bin/opencode2"), \
                patch.object(starter.subprocess, "run", return_value=completed) as run:
            assert starter.api("get", "/api/session/active") == {}
        assert run.call_args.args[0][0] == "/usr/bin/opencode2"


def test_unsupported_or_missing_shim_target_fails_before_spawn():
    with TemporaryDirectory(prefix="api transport ") as temporary:
        root = Path(temporary)
        shim, _ = write_shim(root, native=False)
        with patch.object(starter.os, "name", "nt"), \
                patch.object(starter.shutil, "which", return_value=str(shim)), \
                patch.object(starter.subprocess, "run") as run:
            try:
                starter.api("get", "/api/session/active")
            except FileNotFoundError:
                pass
            else:
                raise AssertionError("Missing native OpenCode executable was accepted")
            run.assert_not_called()

        shim.write_text(SHIM + "REM unsupported extra command\n", encoding="utf-8")
        native = root / "node_modules" / "@opencode" / "cli" / "bin" / "opencode.exe"
        native.parent.mkdir(parents=True)
        native.write_bytes(b"fixture native executable")
        with patch.object(starter.os, "name", "nt"), \
                patch.object(starter.shutil, "which", return_value=str(shim)), \
                patch.object(starter.subprocess, "run") as run:
            try:
                starter.api("get", "/api/session/active")
            except RuntimeError as exc:
                assert "Unsupported Windows" in str(exc)
            else:
                raise AssertionError("Unsupported batch shim was accepted")
            run.assert_not_called()


if __name__ == "__main__":
    test_windows_shim_uses_native_with_literal_arguments()
    test_direct_native_and_non_windows_resolution()
    test_unsupported_or_missing_shim_target_fails_before_spawn()
    print("PASS: literal query/body arguments, Windows npm shim resolution, native/non-Windows paths, and fail-closed shims")
