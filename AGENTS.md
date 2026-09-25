# Global Agent Instructions - DSB Data Lakehouse

Default baseline for DSB Data Lakehouse repositories (`bi-dlh-*`).
Repo-local `AGENTS.md` files are more specific and override this file when present.

This file holds only what must apply to **every** request. Detailed conventions live in
skills and are loaded on demand — see Skill Routing below.

## Non-Negotiables

- Stay within the current `bi-dlh-*` project tree unless the user explicitly expands
  scope. The normal exceptions are explicitly named source-of-truth repositories such as
  `bi-dlh-documentation`, `bi-dlh-helper`, and `bi-dlh-project-template`.
- In Databricks workspace contexts, never inspect sibling projects or other users'
  `/Users/...` or `/Repos/...` directories unless explicitly requested.
- If required information is unavailable inside the allowed scope, say what was checked.
  Only widen scope after explicit user approval.
- Prefer verified sources over assumptions. If a required source, environment check,
  private feed, or skill-sync step is blocked, state the blocker and use the best
  verified fallback.
- No hardcoded secrets or credentials. Use Key Vault and environment variables.
- For helper/domain work, load the relevant `dlh-*` skill before relying on generic
  knowledge. If the skill is missing or unreadable, try the current-tool sync path
  before falling back to installed or version-matched helper source.

### Always ask first

- **Databricks profile** — never auto-select. Ask which profile to use.
- **pytest scope** — never run the full suite unassisted. Present the available
  test files/directories and let the user choose.
- **`review-local`** — never start it implicitly. Ask before invoking.
- **Edits to this file** — see Self-Improvement below.

### Windows reserved filenames

This machine runs Windows. Never create files named after reserved device names:
`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9` (case-insensitive, with or
without extensions). These route to a system device or create undeletable ghost files.
If you need a null/discard target, redirect output in code rather than writing to a
`nul` file.

## Governance & References

The authoritative company source is `DanskeStatsbaner/bi-dlh-documentation` on `main`.
Start from `readme.md` and `checklist.md`, then follow task-relevant links such as
`best-practices.md`, `monitoring.md`, `data-quality.md`, and `databricks-jobs.md`.

- Platform docs — [bi-dlh-documentation](https://github.com/DanskeStatsbaner/bi-dlh-documentation)
- Helper API and examples — [bi-dlh-helper](https://github.com/DanskeStatsbaner/bi-dlh-helper)
- CI/CD pipelines — [bi-dlh-dmt-ci-cd](https://github.com/DanskeStatsbaner/bi-dlh-dmt-ci-cd)
- Project scaffold — [bi-dlh-project-template](https://github.com/DanskeStatsbaner/bi-dlh-project-template)
- Reference implementation — [bi-dlh-src-commercial-spassenger](https://github.com/DanskeStatsbaner/bi-dlh-src-commercial-spassenger)

Read repo-local `checklist.md` when present, but treat it as potentially stale if it
conflicts with the documentation repo or current helper guidance.
When reading private GitHub docs with `gh api`, request decoded readable file content,
not raw `contents` JSON unless metadata is explicitly needed.

## Helper Version

- All DSB Databricks Delta Lake projects must use `dlh-dmt-helper` when it covers the task.
- Project pin source: prefer `adb/requirements.txt`; otherwise top-level `requirements.txt`.
- Keep code compatible with the pinned version unless the user explicitly asks to upgrade.
- For runtime-sensitive work, compare the pinned version with the installed runtime
  version using `importlib.metadata.version("dlh-dmt-helper")`; do not rely on
  `dlh_dmt_helper.__version__`.
- Prefer helper Git tags over `main` when exact behaviour matters; use `main` only for
  unreleased work or when no matching tag exists, and state that limitation.
- Latest-version and changelog checks must come from the private package feed or
  `DanskeStatsbaner/bi-dlh-helper` — never public package indexes or mirrors.
- Packaged `dlh-*` skills exist in `dlh-dmt-helper` 13.5.0+. For older pins, inspect
  installed or version-matched helper source instead of trusting synced skills.

## Skill Routing

| When the task involves | Use skill |
|---|---|
| Delta tables, CRUD, merge, CDC ingestion, SCD Type 2, deletes, synchronization, replay, diagnostics, transform pipelines, metrics, Delta maintenance | `dlh-tables` |
| Databricks widgets, deduplication, primary/foreign keys, clustering, metadata.yml generation, table conversion, Spark utility helpers | `dlh-common-functions` |
| DQX-backed data quality checks, result persistence, governance categorization | `dlh-data-quality` |
| Structured logging, notebook-safe logs, Loki integration, module-level log control, flushing, redaction, domain exceptions | `dlh-monitoring` |
| Databricks job metadata, run registration, trigger-table workflows, dependent job execution | `dlh-databricks-jobs` |
| Governed CSV ingestion from volumes, volume creation, schema enforcement, snake_case normalization, audit columns, GDE SCD2 behavior | `dlh-gde` |
| LLM calls through Databricks serving endpoints or Unity Catalog metadata generation | `dlh-ai` |
| Code style, imports, type hints, docstrings, PySpark patterns, pytest layout, uv/Ruff/mypy, pre-push validation, dependencies, CI/CD vars, Databricks CLI profiles, UC table paths | `dlh-dev-conventions` |
| DSB organisational conventions: catalog/schema naming, AD groups, UC permissions, SCD/Kimball rules, job YAML placement, project lifecycle, deviation sign-off | `dlh-platform` |
| Databricks CLI auth, ad-hoc SQL queries, schema discovery, warehouse lookup | `databricks-core` |
| Extended Databricks investigation (4+ queries, cross-table root cause, exploratory analysis) | `genie` |

If a task spans domains, read all relevant skills.

### Skill discovery and sync

- Prefer the project's `.opencode/skills/` copies when present — they are synced from the
  project's pinned `dlh-dmt-helper` version and are authoritative for that project.
- If a required `dlh-*` skill is not in the project, use the globally available skill as
  a fallback and verify the project's helper pin before relying on version-sensitive behaviour.
- If neither exists, run `sync_opencode_skills()` after the project environment is
  installed and `dlh_dmt_helper` imports successfully. Do not invent helper APIs while
  skill sync is unavailable.
- Re-run `sync_opencode_skills()` after any change to the project's `dlh-dmt-helper`
  pin. Synced skills snapshot the installed version and go stale silently otherwise.
  The sync is idempotent, so re-running when unsure is free.
- Databricks skills (`databricks-core`, etc.) are managed by the Databricks CLI:
  `databricks aitools list | install | update`. Do not hand-copy them.

Use only the sync helper that matches the current tool:

```python
from dlh_dmt_helper.skills.genie import sync_genie_skills
from dlh_dmt_helper.skills.github_copilot import sync_github_copilot_skills
from dlh_dmt_helper.skills.opencode import sync_opencode_skills
from dlh_dmt_helper.skills.project import sync_project_agents_file
```

If sync cannot run because auth, environment setup, or package import is blocked, say so
and fall back to pinned requirements plus installed or version-matched source. If native
skill files cannot be used but the package imports, read packaged skill content with
`list_skill_names()`, `read_skill()`, and `read_skill_reference()` from `dlh_dmt_helper.skills`.

## Style Default

For coding, refactoring, debugging, and review tasks, use the `ponytail` skill at `full`
by default. Prefer the smallest correct change, reuse existing code, and avoid
speculative abstractions while preserving validation, security, error handling,
accessibility, and required tests.

Use normal, clear prose. Do not apply `ponytail` to non-coding tasks.
Honor explicit overrides such as `ponytail ultra`, `ponytail off`, or `normal mode`
for the current session.

## Default Development Workflow

For coding, debugging, refactoring, and review tasks, use this lifecycle. Keep it
lightweight; skip a separate plan for trivial changes.

1. **Explore** — Understand before acting. Inspect the relevant repo, docs, dependencies,
   external systems, constraints, and existing behaviour as needed. Load applicable
   domain skills before relying on generic knowledge. Search narrowly and stop when the
   problem and change boundary are understood.
2. **Plan** — State the root cause or intended behaviour, smallest viable approach,
   affected surfaces, acceptance criteria, and validation scope. Surface uncertainty
   before implementation.
3. **Implement** — Smallest correct diff on the current branch. Reuse existing helpers
   and patterns. Do not add role-play agents or abstractions unless they provide a
   concrete capability, permission boundary, independent context, or parallelism benefit.
4. **Test** — Run the smallest relevant validation first, then broader checks when
   justified. Ask which pytest scope to run before executing pytest. Report skipped
   checks and blockers explicitly.
5. **Review and iterate** — Inspect the diff and validation results, correct issues, and
   repeat the relevant checks before considering the task complete.

Subagents are optional. Use them when work is genuinely independent or benefits from
isolation — parallel repo exploration, research, test design, or independent review.
Prefer one primary agent for sequential work. Give each subagent a narrow objective, the
required file paths and constraints, and ask for concise evidence-based output; the
primary agent owns synthesis, edits, and final verification.

Use `review-local` only as a final review step after implementation and tests, never as
a replacement for understanding, planning, or implementation. Always ask before invoking it.

## Planning and Audit Modes

- Use the `improve` skill for read-only repository audits, prioritized improvement
  findings, roadmap work, or self-contained implementation plans. It may write only under
  `plans/` or `advisor-plans/`; it does not implement source changes.
- Treat `plans/` and `advisor-plans/` as local advisory artifacts. Do not stage, commit,
  push, or include them in implementation PRs unless the user explicitly requests it.
- Use the normal workflow for direct implementation requests. Do not invoke `improve` as
  a substitute for implementation unless the user explicitly asks for a plan or audit.
- When delegating a plan, treat the executor's diff as untrusted until scope, tests, and
  acceptance criteria are checked.

## Self-Improvement

After completing a task or hitting an unexpected issue (wrong paths, missing conventions,
repeated mistakes), consider whether the lesson belongs in this file or in a skill.
Prefer putting detail in a skill and keeping this file small.
**Ask the user before making changes** — never update `AGENTS.md` without explicit approval.

## Setup Changes Are Versioned

Any change to the local agent setup under `~/.config/opencode/` — `AGENTS.md`,
`opencode.json`, `commands/`, `skills/`, `plugin/`, `hooks/` — must be committed and
pushed to `maja2811/mj-ai` (`main`) as part of the same task. Do not leave setup edits
uncommitted.

This applies only to the setup repo. Never auto-commit or push `bi-dlh-*` work
repositories; those follow the normal branch and PR flow.
