# Install

OpenCode V2 does not discover a root `skills/` directory unless you configure it.

1. Copy the complete folder to `.opencode/skills/dlh-bi-estimation/`, `.claude/skills/dlh-bi-estimation/`, or `.agents/skills/dlh-bi-estimation/`, or add `"./skills"` to `opencode.json`'s `skills` sources.
2. Keep `SKILL.md`, `references/`, `templates/`, `scripts/`, and `assets/` together. Paths are relative to the skill folder. The validator uses Python's standard library; no dependencies or Databricks access are required.
3. Start a fresh session and load `dlh-bi-estimation` to confirm discovery and supporting files.
4. Edit the canonical package in this repository, then sync the whole folder to installed copies.

For another harness, use its equivalent skill-source configuration. See <https://opencode.ai/v2/docs/skills> for OpenCode V2 discovery and permissions.
