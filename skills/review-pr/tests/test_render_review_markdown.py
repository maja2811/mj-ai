from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import render_review_markdown as renderer


def test_session_model_rendering():
    with TemporaryDirectory() as directory:
        root = Path(directory)
        body, output = root / "body.md", root / "review.md"
        body.write_text("### Summary\nNo significant findings.\n", encoding="utf-8")
        argv = ["render_review_markdown.py", "--body-path", str(body),
                "--output-path", str(output), "--checklist-url", "https://example.test/checklist"]
        for selected, expected in [
            ({"providerID": "azure", "id": "gpt-6-sol", "variant": "high"}, "GPT 6 Sol (high)"),
            ({"providerID": "azure", "id": "gpt-6.1-sol", "variant": "high"}, "GPT 6.1 Sol (high)"),
            ({"providerID": "other", "id": "custom", "variant": "low"}, "custom (low)"),
            ({"providerID": "other", "id": "custom"}, "custom"),
        ]:
            with patch.object(sys, "argv", argv + ["--session-id", "ses_review"]), \
                    patch.object(renderer, "api", return_value={"data": {"model": selected}}) as api:
                assert renderer.main() == 0
                api.assert_called_once_with("get", "/api/session/ses_review")
            text = output.read_text(encoding="utf-8")
            assert text.count("**Used model:**") == 1
            assert f"**Used model:** {expected}\n" in text
            assert "### Summary" in text
            assert "https://example.test/checklist" in text

        with patch.object(sys, "argv", argv + ["--model", "Manual model high"]), \
                patch.object(renderer, "api") as api:
            assert renderer.main() == 0
            api.assert_not_called()
            assert "**Used model:** Manual model high" in output.read_text(encoding="utf-8")

        output.unlink()
        with patch.object(sys, "argv", argv + ["--session-id", "ses_review"]), \
                patch.object(renderer, "api", return_value={"data": {"model": {}}}):
            try:
                renderer.main()
            except ValueError:
                pass
            else:
                raise AssertionError("Missing session model must fail instead of inventing a label")
        assert not output.exists()


if __name__ == "__main__":
    test_session_model_rendering()
    print("PASS: session-derived model labels, overrides, optional variant, and missing-model failure")
