from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "wait_for_ci.py"
SPEC = importlib.util.spec_from_file_location("wait_for_ci", MODULE_PATH)
assert SPEC is not None
wait_for_ci = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(wait_for_ci)


class WaitForCiTests(unittest.TestCase):
    def test_detects_pending_and_terminal_checks(self) -> None:
        self.assertTrue(wait_for_ci.is_check_pending({"status": "queued"}))
        self.assertTrue(wait_for_ci.is_check_pending({"state": "in_progress"}))
        self.assertTrue(wait_for_ci.is_check_pending({"bucket": "pending"}))
        self.assertFalse(wait_for_ci.is_check_pending({"status": "completed"}))
        self.assertFalse(wait_for_ci.is_check_pending({"state": "failure"}))
        self.assertFalse(wait_for_ci.is_check_pending({"conclusion": "failure"}))

    def test_waits_until_pending_checks_reach_terminal_state(self) -> None:
        responses = [
            {
                "headRefOid": "abc123",
                "statusCheckRollup": [
                    {"name": "validation", "status": "queued"},
                ],
            },
            {
                "headRefOid": "abc123",
                "statusCheckRollup": [
                    {
                        "name": "validation",
                        "status": "completed",
                        "conclusion": "failure",
                    },
                ],
            },
        ]

        def fetcher() -> dict[str, object]:
            return responses.pop(0)

        with tempfile.TemporaryDirectory() as tmpdir, patch.object(
            wait_for_ci.time, "sleep"
        ) as sleep:
            output_dir = Path(tmpdir)
            exit_code, manifest = wait_for_ci.wait_for_ci(
                fetcher=fetcher,
                target="ExampleOrg/example-repo#1",
                expected_head_sha="abc123",
                output_dir=output_dir,
                poll_interval_seconds=1,
                timeout_seconds=60,
                empty_grace_seconds=0,
            )
            saved_rollup = json.loads(
                (output_dir / "status-check-rollup.json").read_text(encoding="utf-8")
            )
            saved_manifest = json.loads(
                (output_dir / "ci-wait-manifest.json").read_text(encoding="utf-8")
            )

        self.assertEqual(exit_code, 0)
        self.assertTrue(manifest["completed"])
        self.assertEqual(manifest["pending_check_count"], 0)
        self.assertEqual(manifest["checks"][0]["conclusion"], "failure")
        self.assertEqual(saved_manifest["attempts"], 2)
        self.assertEqual(saved_rollup["statusCheckRollup"][0]["conclusion"], "failure")
        sleep.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()
