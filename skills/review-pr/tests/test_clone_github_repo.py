from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "clone_github_repo.py"
SPEC = importlib.util.spec_from_file_location("clone_github_repo", MODULE_PATH)
assert SPEC is not None
clone_github_repo = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(clone_github_repo)


class RunCloneRepoTests(unittest.TestCase):
    git_metadata = {
        "resolved_head_sha": "abc123",
        "resolved_branch": "main",
        "resolved_tags": ["v1.2.3"],
        "resolved_describe": "v1.2.3",
    }

    def test_repo_url_alias_parses_to_repo(self) -> None:
        args = clone_github_repo.build_parser().parse_args(
            ["--repo-url", "https://github.com/ExampleOrg/example-repo"]
        )

        self.assertEqual(args.repo, "https://github.com/ExampleOrg/example-repo")

    def test_falls_back_to_https_clone_when_gh_clone_fails(self) -> None:
        calls: list[list[str]] = []

        def fake_run(
            command: list[str],
            *,
            check: bool = False,
            text: bool = False,
        ) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            if command[:3] == ["gh", "repo", "clone"]:
                raise subprocess.CalledProcessError(128, command)
            return subprocess.CompletedProcess(command, 0)

        with tempfile.TemporaryDirectory() as tmpdir:
            clone_path = Path(tmpdir) / "clone"
            clone_path.mkdir()

            with patch.object(
                clone_github_repo.subprocess, "run", side_effect=fake_run
            ):
                clone_strategy = clone_github_repo.run_clone_repo(
                    "ExampleOrg/example-repo", clone_path, "main"
                )

            self.assertFalse(clone_path.exists())

        self.assertEqual(clone_strategy, "https-gh-credential-helper")
        self.assertEqual(calls[0][:3], ["gh", "repo", "clone"])
        self.assertEqual(
            calls[1][:3],
            ["git", "-c", "credential.helper=!gh auth git-credential"],
        )
        self.assertIn("https://github.com/ExampleOrg/example-repo.git", calls[1])
        self.assertIn("--branch", calls[1])
        self.assertIn("main", calls[1])

    def test_uses_primary_gh_clone_when_it_succeeds(self) -> None:
        calls: list[list[str]] = []

        def fake_run(
            command: list[str],
            *,
            check: bool = False,
            text: bool = False,
        ) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            return subprocess.CompletedProcess(command, 0)

        with tempfile.TemporaryDirectory() as tmpdir:
            clone_path = Path(tmpdir) / "clone"

            with patch.object(
                clone_github_repo.subprocess, "run", side_effect=fake_run
            ):
                clone_strategy = clone_github_repo.run_clone_repo(
                    "ExampleOrg/example-repo", clone_path
                )

        self.assertEqual(clone_strategy, "gh-repo-clone")
        self.assertEqual(calls[0][:3], ["gh", "repo", "clone"])
        self.assertFalse(
            any(
                command[:3]
                == ["git", "-c", "credential.helper=!gh auth git-credential"]
                for command in calls
            )
        )

    def test_main_writes_manifest_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir) / "workspace"
            manifest_path = Path(tmpdir) / "manifests" / "helper.json"
            argv = [
                "clone_github_repo.py",
                "--repo-url",
                "https://github.com/ExampleOrg/example-repo",
                "--workspace",
                str(workspace),
                "--ref",
                "v1.2.3",
                "--directory-name",
                "example-helper",
                "--manifest-path",
                str(manifest_path),
            ]

            with patch.object(sys, "argv", argv), patch.object(
                sys, "stdout", io.StringIO()
            ), patch.object(sys, "stderr", io.StringIO()), patch.object(
                clone_github_repo, "require_gh"
            ), patch.object(
                clone_github_repo,
                "run_clone_repo",
                return_value="https-gh-credential-helper",
            ), patch.object(
                clone_github_repo,
                "collect_git_metadata",
                return_value=self.git_metadata,
            ):
                exit_code = clone_github_repo.main()

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(manifest["repo_full_name"], "ExampleOrg/example-repo")
        self.assertEqual(manifest["requested_ref"], "v1.2.3")
        self.assertEqual(manifest["directory_name"], "example-helper")
        self.assertEqual(manifest["clone_strategy"], "https-gh-credential-helper")
        self.assertEqual(
            manifest["clone_path"],
            str((workspace / "reference-repos" / "example-helper").resolve()),
        )
        self.assertEqual(manifest["resolved_head_sha"], "abc123")
        self.assertEqual(manifest["resolved_branch"], "main")
        self.assertEqual(manifest["resolved_tags"], ["v1.2.3"])
        self.assertEqual(manifest["resolved_describe"], "v1.2.3")
        self.assertEqual(manifest["manifest_path"], str(manifest_path.resolve()))

    def test_main_normalizes_reference_repo_leaf_workspace_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            review_workspace = Path(tmpdir) / "review-workspace"
            mistaken_workspace = review_workspace / "reference-repos" / "bi-dlh-helper"
            manifest_path = review_workspace / "reference-repos" / "bi-dlh-helper-manifest.json"
            argv = [
                "clone_github_repo.py",
                "--repo",
                "DanskeStatsbaner/bi-dlh-helper",
                "--workspace",
                str(mistaken_workspace),
                "--manifest-path",
                str(manifest_path),
            ]

            with patch.object(sys, "argv", argv), patch.object(
                sys, "stdout", io.StringIO()
            ), patch.object(sys, "stderr", io.StringIO()), patch.object(
                clone_github_repo, "require_gh"
            ), patch.object(
                clone_github_repo,
                "run_clone_repo",
                return_value="https-gh-credential-helper",
            ), patch.object(
                clone_github_repo,
                "collect_git_metadata",
                return_value=self.git_metadata,
            ):
                exit_code = clone_github_repo.main()

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(manifest["workspace"], str(review_workspace.resolve()))
        self.assertEqual(
            manifest["reference_root"],
            str((review_workspace / "reference-repos").resolve()),
        )
        self.assertEqual(manifest["directory_name"], "bi-dlh-helper")
        self.assertEqual(
            manifest["clone_path"],
            str((review_workspace / "reference-repos" / "bi-dlh-helper").resolve()),
        )
        self.assertNotIn("reference-repos/reference-repos", manifest["clone_path"])


if __name__ == "__main__":
    unittest.main()
