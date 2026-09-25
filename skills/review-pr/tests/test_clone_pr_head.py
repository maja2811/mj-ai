from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "clone_pr_head.py"
SPEC = importlib.util.spec_from_file_location("clone_pr_head", MODULE_PATH)
assert SPEC is not None
clone_pr_head = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(clone_pr_head)


class RunClonePrRefTests(unittest.TestCase):
    def test_falls_back_to_https_clone_when_gh_clone_fails(self) -> None:
        calls: list[tuple[list[str], Path | None]] = []

        def fake_run(
            command: list[str],
            *,
            cwd: Path | None = None,
            check: bool = False,
            text: bool = False,
        ) -> subprocess.CompletedProcess[str]:
            calls.append((command, cwd))
            if command[:3] == ["gh", "repo", "clone"]:
                raise subprocess.CalledProcessError(128, command)
            return subprocess.CompletedProcess(command, 0)

        with tempfile.TemporaryDirectory() as tmpdir:
            clone_path = Path(tmpdir) / "clone"
            clone_path.mkdir()

            with patch.object(clone_pr_head.subprocess, "run", side_effect=fake_run):
                clone_ref = clone_pr_head.run_clone_pr_ref(
                    "ExampleOrg/example-repo", 123, "abc123", clone_path
                )

        self.assertEqual(clone_ref, "refs/pull/123/head")
        self.assertEqual(calls[0][0][:3], ["gh", "repo", "clone"])
        self.assertEqual(
            calls[1][0][:3],
            ["git", "-c", "credential.helper=!gh auth git-credential"],
        )
        self.assertIn("https://github.com/ExampleOrg/example-repo.git", calls[1][0])
        self.assertEqual(calls[2][0][:2], ["git", "fetch"])
        self.assertEqual(calls[2][1], clone_path)
        self.assertEqual(calls[3][0], ["git", "checkout", "--detach", "abc123"])
        self.assertEqual(calls[3][1], clone_path)

    def test_uses_primary_gh_clone_when_it_succeeds(self) -> None:
        calls: list[list[str]] = []

        def fake_run(
            command: list[str],
            *,
            cwd: Path | None = None,
            check: bool = False,
            text: bool = False,
        ) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            return subprocess.CompletedProcess(command, 0)

        with tempfile.TemporaryDirectory() as tmpdir:
            clone_path = Path(tmpdir) / "clone"

            with patch.object(clone_pr_head.subprocess, "run", side_effect=fake_run):
                clone_ref = clone_pr_head.run_clone_pr_ref(
                    "ExampleOrg/example-repo", 123, "abc123", clone_path
                )

        self.assertEqual(clone_ref, "refs/pull/123/head")
        self.assertEqual(calls[0][:3], ["gh", "repo", "clone"])
        self.assertFalse(
            any(
                command[:3]
                == ["git", "-c", "credential.helper=!gh auth git-credential"]
                for command in calls
            )
        )


if __name__ == "__main__":
    unittest.main()
