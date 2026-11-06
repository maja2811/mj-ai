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
- Load the relevant `dlh-*` skill before relying on generic knowledge. If it is missing,
  follow Skill discovery and sync below.

### Always ask first

- **Databricks profile** — a profile selects a workspace, not a cluster. Default to
  `commercial-dev`, list alternatives with `databricks auth profiles`, and confirm before
  any Databricks command. Never auto-select a `*-prd` profile.
- **pytest scope** — never run the full suite unassisted. List the available test
  files/directories and let the user choose.
- **`review-pr`** — never start a review implicitly.
- **Jira and Confluence writes** — draft comments, updates, transitions, and new issues
  for my review. Post only after approval or when I asked for that exact change.
- **Commits and pushes** — ask before `git commit` or `git push`, every time. A rule
  requiring work to end committed is not permission to decide the work is finished.
  Run git through the shell `workdir` parameter, never `git -C`, so permission
  patterns match.
- **Edits to this file** — never update `AGENTS.md` without explicit approval.
- **VS Code CLI** — never run `code` or `code.cmd`; they open windows on this workstation.

### Windows reserved filenames

Never create files named `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9` (any
case, any extension); they leave undeletable ghost files. Discard output in code instead.

## Default Development Workflow

Use this loop for coding, debugging, refactoring, and review. Skip a separate plan for
trivial changes. Work in the checkout open in VS Code (normally the session's working
directory) so diffs stay visible there; use a separate worktree only for genuinely
parallel work or when asked, and say so first.

1. **Explore** — understand before acting: repo, docs, dependencies, external systems,
   and existing behaviour. If the task has a Jira ticket, read it via the `jira` agent;
   its goal and acceptance criteria are the yardstick for the rest of the loop. Search
   narrowly and stop once the problem and the change boundary are clear.
2. **Plan** — state the root cause or intended behaviour, smallest viable approach,
   affected surfaces, acceptance criteria, and validation scope. For bugs and incidents,
   show the evidence behind the diagnosis, your confidence, and what else could explain
   it. For non-trivial work, write the plan with `improve plan <description>`, include a
   rough effort estimate, and wait for my approval before implementing.
3. **Implement** — smallest correct diff on the current branch, reusing existing helpers
   and patterns.
4. **Test** — smallest relevant validation first, broader checks when justified: unit and
   integration tests, then a DEV Databricks run with DQ checks where the change affects
   data. Report which checks ran with their results, and which could not run and why.
5. **Review and iterate** — inspect the diff and validation results against the
   acceptance criteria, correct what you find, and re-run the relevant checks after each
   fix. If implementation or review exposes a flaw in the plan, stop and revise the plan
   with me instead of patching around it. Once the branch is pushed, `review-pr` can
   review its branch URL or PR against the latest checklist as an optional final step,
   never a replacement for the loop. A person reviews every PR. Never merge to `main`
   yourself.

Subagents only for independent work (parallel exploration, research, independent review);
sequential work stays with one agent. The primary agent makes all edits and verifies
subagent findings and executor diffs before relying on them.

### Plans and audits

- Use `improve` for audits, roadmaps, and implementation plans, never as a substitute for
  a direct implementation request.
- `plans/` and `advisor-plans/` are local artifacts. Never stage, commit, push, or
  include them in PRs unless asked.

## Style

- Coding, refactoring, debugging, and review use `ponytail` at `full` by default. Never
  apply it to non-coding tasks.
- Prose deliverables (markdown docs, Confluence pages, PR and review write-ups) get
  `stop-slop` as a final editing pass. Skip it for docstrings (Google style per
  `dlh-dev-conventions`), commit messages, and templated content. On Danish Confluence
  pages apply its structural rules only; its phrase lists are English.

## Skill Routing

Route on the skill descriptions already in context, plus:

- Any `bi-dlh-*` code, tests, tooling, dependencies, CI/CD vars, or UC table paths →
  `dlh-dev-conventions`.
- Ad-hoc Databricks queries → `databricks-core`. Escalate to `genie` for extended
  investigation (4+ queries, cross-table root cause, exploratory analysis).
- A task spanning domains → read every relevant skill.

### Jira and Confluence

Atlassian MCP is enabled only on the `jira` subagent. Route all Jira/Confluence work
through `/jira <request>` or `@jira`; the tools are not available elsewhere.

### Skill discovery and sync

- The project's `.opencode/skills/` wins; it is synced from the project's pinned
  `dlh-dmt-helper` and is authoritative there. Otherwise use the global skill, but verify
  the project's pin before relying on version-sensitive behaviour.
- Missing everywhere, or after any change to the helper pin → run
  `sync_opencode_skills()` from `dlh_dmt_helper.skills.opencode` once the project
  environment imports the package. It is idempotent; re-run when unsure. Never invent
  helper APIs while sync is unavailable.
- If sync is blocked, say so and fall back to installed or version-matched source, or
  read packaged content with `list_skill_names()`, `read_skill()`, and
  `read_skill_reference()` from `dlh_dmt_helper.skills`.
- Databricks skills are managed by the Databricks CLI
  (`databricks aitools list | install | update`). Never hand-copy them.

## Governance & References

Authoritative source: `DanskeStatsbaner/bi-dlh-documentation` on `main`. Start at
`readme.md` and `checklist.md`, then follow task-relevant links such as
`best-practices.md`, `monitoring.md`, `data-quality.md`, `databricks-jobs.md`.

Also under `github.com/DanskeStatsbaner/`: `bi-dlh-helper` (helper API and examples),
`bi-dlh-dmt-ci-cd` (CI/CD pipelines), `bi-dlh-project-template` (project scaffold),
`bi-dlh-src-commercial-spassenger` (reference implementation).

A repo-local `checklist.md` may be stale where it conflicts with the documentation repo
or current helper guidance. With `gh api`, request decoded file content, not raw
`contents` JSON unless you need metadata.

## Local Access

- `AZDO_PYPI_DSB_MODULES_TOKEN` (user env var) is an Azure DevOps PAT for org `dsbdk`. Besides
  the private package feed it has **Build: read & execute** and **Artifacts: read**. Use it for
  the Azure DevOps REST API with basic auth `":" + token`. Never print it.
- Trigger a pipeline run (ask first, it deploys):
  `POST https://dev.azure.com/dsbdk/{projectId}/_apis/pipelines/{pipelineId}/runs?api-version=7.1`
  with body `{"resources":{"repositories":{"self":{"refName":"refs/heads/<branch>"}}},"templateParameters":{"deploy_to_dev":"true"}}`.
  Look up IDs with `GET .../_apis/pipelines?api-version=7.1&$top=500`. Project
  `DSB Azure - Data Lakehouse Projects` = `08c4e2de-f993-4d1b-b873-9b06da982aa8`. CSF pipelines:
  7779 `adb-ci-cd-bi-dlh-commercial-csf` (deploy), 7782 CI validation, 7780 cleanup, 7781 UC
  permissions.
- No Azure CLI is installed. The `dlh-dmt-helper` library on DEV clusters is set by the deploy
  pipeline, and I have no rights to change cluster libraries. To test a newer helper before the
  deploy, install it notebook-scoped (`%pip install dlh-dmt-helper==X`) in a wrapper notebook and
  `%run` the real notebook in the same session.
- Databricks OAuth profiles expire. If `databricks auth token --profile <p>` fails, run
  `databricks auth login --profile <p>` (opens a browser) before starting long work.

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
