# Global Agent Instructions - DSB Data Lakehouse

Baseline for DSB Data Lakehouse repositories (`bi-dlh-*`). A repo-local `AGENTS.md` is
more specific and overrides this file. Only universal rules live here; detail lives in
skills, loaded on demand.

## Non-Negotiables

- Stay in the current `bi-dlh-*` tree unless the user expands scope. Exceptions:
  `bi-dlh-documentation`, `bi-dlh-helper`, `bi-dlh-project-template`.
- In Databricks workspaces, never inspect sibling projects or other users' `/Users/...`
  or `/Repos/...` directories unless asked.
- If required information is out of scope, say what you checked. Widen only after approval.
- Prefer verified sources over assumptions. If a source, environment check, private feed,
  or skill sync is blocked, state the blocker and use the best verified fallback.
- No hardcoded secrets or credentials. Use Key Vault and environment variables.
- Use `dlh-dmt-helper` whenever it covers the task, and stay compatible with the
  project's pin. Version and feed rules live in `dlh-dev-conventions`.
- Load the relevant `dlh-*` skill before relying on generic knowledge. If it is missing or
  unreadable, try the sync path below before falling back to installed or version-matched
  helper source.

### Always ask first

- **Databricks profile** — a profile selects a workspace, not a cluster. Default to
  `commercial-dev`, list alternatives with `databricks auth profiles`, and confirm before
  any Databricks command. Never auto-select a `*-prd` profile.
- **pytest scope** — never run the full suite unassisted. List the available test
  files/directories and let the user choose.
- **`review-local`** — never start it implicitly.
- **Commits and pushes** — ask before `git commit` or `git push`, every time. A rule
  requiring work to end committed is not permission to decide the work is finished.
  Run git through the shell `workdir` parameter, never `git -C`, so permission
  patterns match.
- **Edits to this file** — never update `AGENTS.md` without explicit approval.
- **VS Code CLI** — never run `code` or `code.cmd`; they open windows on this workstation.
  Use filesystem inspection and other CLI tools unless the user asks to launch VS Code.

### Windows reserved filenames

Never create files named `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9` (any
case, with or without extension) — they route to a device or leave undeletable ghost
files. For a null/discard target, redirect output in code instead of writing a `nul` file.

## Governance & References

Authoritative source: `DanskeStatsbaner/bi-dlh-documentation` on `main`. Start at
`readme.md` and `checklist.md`, then follow task-relevant links such as
`best-practices.md`, `monitoring.md`, `data-quality.md`, `databricks-jobs.md`.

Also under `github.com/DanskeStatsbaner/`: `bi-dlh-helper` (helper API and examples),
`bi-dlh-dmt-ci-cd` (CI/CD pipelines), `bi-dlh-project-template` (project scaffold),
`bi-dlh-src-commercial-spassenger` (reference implementation).

Read repo-local `checklist.md` when present, but treat it as potentially stale where it
conflicts with the documentation repo or current helper guidance. When reading private
GitHub docs with `gh api`, request decoded file content, not raw `contents` JSON unless
you need metadata.

## Skill Routing

Skill descriptions are already in context — route on those. Additional rules:

- Coding, refactoring, debugging, review → `ponytail` (see Style).
- Audits, roadmaps, self-contained implementation plans → `improve` (see Planning and
  Audit Modes).
- Prose deliverables → `stop-slop` (see Style).
- Any `bi-dlh-*` code, tests, tooling, dependencies, CI/CD vars, or UC table paths →
  `dlh-dev-conventions`.
- Ad-hoc Databricks queries → `databricks-core`. Escalate to `genie` for extended
  investigation (4+ queries, cross-table root cause, exploratory analysis).
- A task spanning domains → read every relevant skill.

### Jira and Confluence

Atlassian MCP is disabled globally to keep it out of context and enabled only on the
`jira` subagent. Route all Jira/Confluence work through `/jira <request>` or `@jira`,
which loads `jira-assistant` with the MCP available. Do not attempt it from `build` or
`plan` — the tools are not there.

### Skill discovery and sync

- The project's `.opencode/skills/` wins when present; it is synced from the project's
  pinned `dlh-dmt-helper` version and is authoritative for that project.
- Missing there → use the global skill as fallback, but verify the project's pin before
  relying on version-sensitive behaviour.
- Missing everywhere → run `sync_opencode_skills()` from `dlh_dmt_helper.skills.opencode`
  once the project environment is installed and the package imports. Never invent helper
  APIs while sync is unavailable. (Sibling helpers exist for `genie`, `github_copilot`,
  and project agents files — use only the one matching the tool in use.)
- Re-run it after any change to the project's helper pin. Synced skills snapshot the
  installed version and go stale silently; the sync is idempotent, so re-run when unsure.
- Databricks skills are managed by the Databricks CLI
  (`databricks aitools list | install | update`). Never hand-copy them.
- If sync is blocked by auth, environment setup, or package import, say so and fall back
  to pinned requirements plus installed or version-matched source. If the package imports
  but native skill files are unusable, read packaged content with `list_skill_names()`,
  `read_skill()`, and `read_skill_reference()` from `dlh_dmt_helper.skills`.

## Style

- Coding, refactoring, debugging, and review use `ponytail` at `full` by default:
  smallest correct change, reuse existing code, no speculative abstractions — while
  preserving validation, security, error handling, accessibility, and required tests.
  Honor `ponytail ultra`, `ponytail off`, or `normal mode` for the session.
- Never apply `ponytail` to non-coding tasks. Use normal, clear prose.
- Prose deliverables (markdown docs, Confluence pages, PR and review write-ups) get
  `stop-slop` as a final editing pass. Skip it for docstrings (Google style per
  `dlh-dev-conventions`), commit messages, and templated content. On Danish Confluence
  pages apply its structural rules only; its phrase lists are English.

## Default Development Workflow

Use this lifecycle for coding, debugging, refactoring, and review. Keep it lightweight;
skip a separate plan for trivial changes.

1. **Explore** — understand before acting. Inspect the repo, docs, dependencies, external
   systems, constraints, and existing behaviour as needed. Load applicable domain skills
   before relying on generic knowledge. Search narrowly and stop once the problem and the
   change boundary are clear.
2. **Plan** — state the root cause or intended behaviour, smallest viable approach,
   affected surfaces, acceptance criteria, and validation scope. Surface uncertainty
   before implementing.
3. **Implement** — smallest correct diff on the current branch, reusing existing helpers
   and patterns. No role-play agents or abstractions without a concrete capability,
   permission boundary, independent context, or parallelism benefit.
4. **Test** — smallest relevant validation first, broader checks when justified. Ask which
   pytest scope to run before executing pytest. Report skipped checks and blockers.
5. **Review and iterate** — inspect the diff and validation results, correct what you
   find, and re-run the relevant checks before calling the task complete.

Subagents are optional. Use them when work is genuinely independent or benefits from
isolation — parallel repo exploration, research, test design, independent review —
otherwise stay with one primary agent for sequential work. Give each subagent a narrow
objective, the required file paths, and the constraints, and ask for concise
evidence-based output. The primary agent owns synthesis, edits, and final verification.

`review-local` is a final review step after implementation and tests, never a replacement
for understanding, planning, or implementing. Always ask before invoking it.

## Planning and Audit Modes

- Assess every new task for an `improve` plan. Default to `improve plan <description>` for
  non-trivial coding, debugging, refactoring, or configuration work; skip it only for
  minor, tightly scoped changes where the correct edit and its validation are immediately
  clear.
- Use `improve` for read-only repository audits, prioritized findings, roadmap work, and
  self-contained implementation plans. It writes only under `plans/` or `advisor-plans/`
  and never changes source.
- Treat `plans/` and `advisor-plans/` as local advisory artifacts. Never stage, commit,
  push, or include them in implementation PRs unless the user asks.
- Direct implementation requests use the normal workflow. Never use `improve` as a
  substitute for implementing unless the user explicitly asks for a plan or audit.
- When delegating a plan, treat the executor's diff as untrusted until scope, tests, and
  acceptance criteria check out.

## Self-Improvement

After completing a task or hitting an unexpected issue (wrong paths, missing conventions,
repeated mistakes), consider whether the lesson belongs in this file or in a skill. Prefer
the skill and keep this file small. Ask the user before changing either.

## Setup Changes Are Versioned

Any change to the local agent setup under `~/.config/opencode/` — `AGENTS.md`,
`opencode.json`, `commands/`, `skills/`, `plugins/` — must end the task committed and
pushed to `maja2811/mj-ai` (`main`). This describes the required end state; it does
not authorize committing without asking. Never leave setup edits uncommitted.

This applies only to the setup repo. Never auto-commit or push `bi-dlh-*` work
repositories; those follow the normal branch and PR flow.
