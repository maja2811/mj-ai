from pathlib import Path


def test_metadata_policy():
    root = Path(__file__).resolve().parents[1]
    prompt = (root / "references/opencode-reviewer-prompt.md").read_text(encoding="utf-8")
    skill = (root / "SKILL.md").read_text(encoding="utf-8")
    metadata = prompt.split("Unity Catalog metadata:\n", 1)[1].split(
        "\n## Review Discipline", 1
    )[0]

    for required in (
        "5 October 2026",
        "new development and changes to existing solutions",
        "not unrelated untouched legacy assets",
        "no metadata file appears in the diff",
        "is `MAJOR` and requires `REQUEST_CHANGES`",
        "generator failure, or passing CI alone does not waive",
        "`business_data_steward` and `certification_status` optional",
        "wording-only improvements remain non-blocking",
        "descriptions are populated",
        "partial metadata fix remains `⚠️` and merge-blocking",
        "explain its reassessment",
    ):
        assert required in metadata, required

    assert "Apply the extracted prompt's **Unity Catalog metadata** policy" in skill
    assert "is `MAJOR` and requires `REQUEST_CHANGES`" in skill
    assert "partial required coverage remains `⚠️` and merge-blocking" in skill
    for text in (prompt, skill):
        assert "add a remaining `MINOR` metadata issue" not in text
        assert "review explicitly accepts a narrower documented subset with a rationale" not in text


if __name__ == "__main__":
    test_metadata_policy()
    print("PASS: required metadata gate, legacy/optional scope, and follow-up consistency")
