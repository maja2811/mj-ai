# Install

OpenCode V2 does not discover a root `skills/` directory unless you configure it.

1. Copy the complete folder to `.opencode/skills/dlh-bi-solution-design/`, `.claude/skills/dlh-bi-solution-design/`, or `.agents/skills/dlh-bi-solution-design/`, or add `"./skills"` to `opencode.json`'s `skills` sources.
2. Keep `SKILL.md`, `references/`, `templates/`, and `assets/` together. Paths are relative to the skill folder. The method and templates need no package install, browser service, or documentation-repository access.
3. Start a fresh session and load `dlh-bi-solution-design` to confirm discovery and supporting files.
4. Edit the canonical package in this repository, then sync the whole folder to installed copies.

For another harness, use its equivalent skill-source configuration. See <https://opencode.ai/v2/docs/skills> for OpenCode V2 discovery and permissions.
