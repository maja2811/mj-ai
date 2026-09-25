---
name: review-local
description: Run a local code review against the current branch (or a specified branch/range of commits) using the DSB Data Lakehouse checklist. Launches parallel sub-agents for each major checklist area and produces a consolidated markdown review following the review-guidelines severity format.
compatibility: Requires a Git repository with the DSB DLH project structure (adb/ directory or library layout). Requires GitHub CLI (gh) for fetching the latest checklist and review-guidelines if not cached.
metadata:
  version: "1.0"
---

# Local Code Review

Use this skill when the user asks to review code locally, review the current branch, run the checklist against local changes, or produce a review of uncommitted/committed work without a GitHub PR.

## When To Use This Skill

- User asks to review local changes, the current branch, or a specific set of commits
- User asks to run the checklist against their code
- User asks for a pre-PR review or self-review
- User asks to review a branch before opening a PR

This skill always reviews the current branch or diff scope the user asked for. Do not add review modes; keep the workflow centered on the branch and the checklist.

## Workflow

### 1. Determine review scope

Ask the user what to review if unclear:

- **Uncommitted changes**: `git diff` + `git diff --cached` + untracked files
- **Branch vs main**: `git diff main...HEAD` (all commits on the branch)
- **Specific commits**: `git log <range>` + `git diff <range>`

Default to **branch vs main** if the user just says "review" without specifics.

### 2. Run automated checks first

Before launching sub-agents, run the automated tooling. Determine the target path (`adb/` if it exists, `.` otherwise) and run:

```bash
uv run ruff check <target>
uv run ruff format --check <target>
uv run mypy
```

If any of these fail, include the failures as findings in the final report:
- Ruff lint errors -> MAJOR (each distinct rule violation)
- Ruff format errors -> MINOR
- mypy type errors -> MAJOR

Do NOT skip the sub-agent review even if these fail -- the automated checks and the sub-agent review are complementary.

### 3. Gather context

Collect:

```bash
git diff main...HEAD --stat
git diff main...HEAD
git log main...HEAD --oneline
```

Identify which files changed and which checklist sections are relevant. Not every section applies to every change.

### 4. Review mindset

- Treat the review as assistive, not authoritative.
- Prefer high-confidence findings over speculative noise.
- Focus first on CRITICAL and MAJOR issues; include MINOR and SUGGESTION items only when clearly evidenced and useful.
- Keep the review scoped to the branch changes and avoid widening beyond the diff.
- Use the checklist as the primary guide and fetch docs only when a finding depends on documented behavior.

**Exclude from review** -- do not flag findings in these file types/patterns:
- Lock files (`uv.lock`, `package-lock.json`)
- Generated metadata (`metadata.yml` unless explicitly modified by hand)
- Cache directories (`__pycache__/`, `.mypy_cache/`, `.ruff_cache/`)
- IDE config (`.vscode/`, `.idea/`)
- `.gitignore`, `.gitattributes` (unless the change is clearly wrong)

### 5. Launch parallel sub-agent reviews

Launch one Task sub-agent (type: `general`) per applicable checklist section below. Each sub-agent receives:

- The full diff
- The list of changed files
- Read access to the repo
- Its specific checklist section criteria
- Instructions to output findings in the severity format

**Sub-agent sections** (map to checklist headings):

| Agent | Checklist Section | Focus |
|-------|------------------|-------|
| `code-quality` | 2. Code Development & Quality | Architecture, language choice, code structure, naming, style, modularity, error handling, logging, efficiency, Spark anti-patterns |
| `data-modeling` | 3. Data Modeling & Storage | Medallion layers, table types, schema, constraints, Delta optimization, history, star schema, keys |
| `data-quality` | 4. Data Quality | DQ framework usage, check definitions, coverage, failure handling, notifications |
| `documentation` | 5. Documentation | README, notebook markdown, inline comments, docstrings, UC metadata |
| `security` | 6. Security & Access Control | Hardcoded secrets, credentials, permissions, least privilege |
| `testing` | 7. Testing | Test directory, unit tests, edge cases, integration tests, schema regression |
| `deployment` | 8. Deployment & Orchestration | Version control, CI/CD, job definitions, cluster config, adhoc scripts |
| `monitoring` | 9. Monitoring | Monitoring setup, logging sufficiency, exception handling, alerting |
| `cost` | 10. Cost Management | Cluster sizing, job clusters, optimization cost, warehouses, retention |

**Skip sections** that have zero relevance to the changed files. For example:

- If no `adb/jobs/` files changed and no job YAML was touched, skip `deployment` (unless the changes affect orchestration logic).
- If no data quality YAML or DQ-related code changed, skip `data-quality`.
- Always run `code-quality` and `documentation` since they apply to virtually all changes.

### 6. Sub-agent instructions template

Each sub-agent should receive a prompt following this pattern:

```
You are reviewing local code changes in a DSB Data Lakehouse repository.
Your focus area is: [SECTION NAME]

## Changed files
[LIST OF CHANGED FILES WITH STATS]

## Full diff
[FULL DIFF TEXT - or instruct to read specific files]

## Checklist criteria for your section
[PASTE THE RELEVANT CHECKLIST ITEMS]

## Your task
1. Read the repo's `AGENTS.md` (if present) for repo-specific conventions (import ordering, type annotations, naming, error handling patterns, etc.).
2. Read the changed files and surrounding context in the repository.
3. Evaluate each applicable checklist item against the changes.
4. For each finding, assign a severity: CRITICAL, MAJOR, MINOR, or SUGGESTION.
5. Do not invent findings to fill a quota. If an issue is not clearly supported by the diff or surrounding code, leave it out.
6. Return your findings as a list in this format:

### [SECTION NAME]

| # | Severity | File(s) | Finding | Checklist Item |
|---|----------|---------|---------|----------------|
| 1 | MAJOR    | adb/curated/tables/foo.py:42 | Missing error handling around Delta merge | Error Handling |

Include a brief explanation for each finding.
If no issues found for your section, return: "No issues found for [SECTION NAME]."

## Severity definitions
- CRITICAL: Causes a bug, security vulnerability, data loss, outage, or major violation. Must be fixed before merge.
- MAJOR: Performance issues or code that is difficult to maintain, but not immediately critical. Must be resolved before merge.
- MINOR: Deviation from best practices, readability, or small refactor. Strongly recommended to fix, can be postponed with a GitHub Issue.
- SUGGESTION: Optional improvement or future idea. No immediate action required.

## Important
- Only flag issues that are actually evidenced in the diff or surrounding code. Do not speculate.
- Be specific: cite exact file paths and line numbers.
- Do not flag issues in unchanged code unless the change directly interacts with or depends on a pre-existing problem.
- Verify claims by reading the actual files, not just the diff hunks.

## Reference sources
When a finding depends on documented best practices, package APIs, or deployment behavior,
fetch the relevant file from these repos before concluding:

- Platform docs & checklist: https://github.com/DanskeStatsbaner/bi-dlh-documentation
  (best-practices.md, docs/monitoring.md, docs/data-quality.md, docs/databricks-jobs.md, etc.)
- dlh-dmt-helper source: https://github.com/DanskeStatsbaner/bi-dlh-helper
- CI/CD wiring: https://github.com/DanskeStatsbaner/bi-dlh-dmt-ci-cd

Use `gh api repos/DanskeStatsbaner/<repo>/contents/<path> -q .download_url` to get download URLs.
Do not guess package behavior or platform conventions -- verify against the source repos.
```

### 7. Consolidate results

After all sub-agents return, merge their findings into a single review document.

**Deduplication:** If two sub-agents flag the same file:line for the same underlying issue (e.g. `code-quality` and `monitoring` both flag missing error handling on the same function), keep only the finding with the higher severity and note which sections flagged it.

**Automated check findings:** Prepend any ruff/mypy failures from step 2 as findings in the appropriate severity section. Group them as "Automated Checks" in the Checklist Area column.

**Output format** (follows review-guidelines.md):

```markdown
# Local Code Review

**Branch:** `<branch-name>`
**Base:** `main`
**Files changed:** <count>
**Review date:** <date>

---

## Summary

<1-3 sentence overview of the changes and overall quality>

## Findings

### CRITICAL

| # | File(s) | Finding | Checklist Area | Recommended Action |
|---|---------|---------|----------------|--------------------|
| ... | ... | ... | ... | ... |

### MAJOR

| # | File(s) | Finding | Checklist Area | Recommended Action |
|---|---------|---------|----------------|--------------------|
| ... | ... | ... | ... | ... |

### MINOR

| # | File(s) | Finding | Checklist Area | Recommended Action |
|---|---------|---------|----------------|--------------------|
| ... | ... | ... | ... | ... |

### SUGGESTION

| # | File(s) | Finding | Checklist Area | Recommended Action |
|---|---------|---------|----------------|--------------------|
| ... | ... | ... | ... | ... |

## Statistics

| Severity | Count |
|----------|-------|
| CRITICAL | <n> |
| MAJOR | <n> |
| MINOR | <n> |
| SUGGESTION | <n> |
| **Total** | **<n>** |

## Checklist Coverage

| Section | Status |
|---------|--------|
| Code Development & Quality | Reviewed / Skipped (reason) |
| Data Modeling & Storage | Reviewed / Skipped (reason) |
| Data Quality | Reviewed / Skipped (reason) |
| Documentation | Reviewed / Skipped (reason) |
| Security & Access Control | Reviewed / Skipped (reason) |
| Testing | Reviewed / Skipped (reason) |
| Deployment & Orchestration | Reviewed / Skipped (reason) |
| Monitoring | Reviewed / Skipped (reason) |
| Cost Management | Reviewed / Skipped (reason) |

## Overall Recommendation

<APPROVE / REQUEST_CHANGES>

<Brief justification>
```

### 8. Write the review file

- Default filename: `review-local-<branch-name>.md` in the current directory.
- If the user specified an output path, use that instead.
- After writing, display the summary and finding counts to the user.
- Check if `review-local-*.md` is already in `.gitignore`. If not, offer to add it so the review file doesn't get committed accidentally.
- Ask the user if they want to proceed with any fixes.
- When summarizing, call out the branch purpose, the most important findings, and whether the branch looks ready for PR.

## Severity Definitions (from review-guidelines.md)

| Name | Meaning | Required Action |
|------|---------|-----------------|
| CRITICAL | Causes a bug, security vulnerability, data loss, outage, or major violation | Must be fixed before PR can be merged |
| MAJOR | Performance issues or code that is difficult to maintain, but not immediately critical | Must be resolved before merging the PR |
| MINOR | Deviation from best practices, readability, or small refactor | Strongly recommended to fix. Can be postponed with a GitHub Issue |
| SUGGESTION | Optional improvement or future idea | No immediate action required |

## Important Rules

- Use ONLY the four severity labels above. Never invent alternatives (HIGH, MEDIUM, LOW, INFO, etc.).
- Be evidence-based. Every finding must cite a specific file and line.
- Do not flag pre-existing issues unless the current changes make them worse or directly interact with them.
- When in doubt, read the actual code, not just the diff.
- Reference the specific checklist item each finding relates to.
- Treat AI output as assistive. Verify logic, security, and data-handling claims against the code and docs before concluding.
- The `AGENTS.md` global instructions apply to all reviewed code (import ordering, type annotations, naming conventions, etc.).
- For `bi-dlh-helper` (library repos without `adb/`), adjust paths accordingly: review `.` instead of `adb/`.

## Reference Repositories

Sub-agents should fetch and consult these sources when a finding depends on documented conventions, package APIs, or deployment behavior. Use `gh api` or the WebFetch tool to retrieve specific files as needed.

### bi-dlh-documentation (platform docs & checklist)

**Repo:** https://github.com/DanskeStatsbaner/bi-dlh-documentation

The authoritative source for all platform conventions, best practices, and the review process. The checklist references many docs in this repo by relative path. Key files:

| Checklist reference | Full path in repo |
|---------------------|-------------------|
| `checklist.md` | `checklist.md` |
| `review-guidelines.md` | `review-guidelines.md` |
| `best-practices.md` | `best-practices.md` |
| `readme.md` (governance, architecture) | `readme.md` |
| `onboarding.md` | `onboarding.md` |
| `docs/monitoring.md` | `docs/monitoring.md` |
| `docs/data-quality.md` | `docs/data-quality.md` |
| `docs/databricks-jobs.md` | `docs/databricks-jobs.md` |
| `docs/unity-catalog-metadata.md` | `docs/unity-catalog-metadata.md` |
| `docs/unity-catalog-permissions.md` | `docs/unity-catalog-permissions.md` |
| `docs/dimensional-modeling.md` | `docs/dimensional-modeling.md` |

Fetch any file with:
```bash
gh api repos/DanskeStatsbaner/bi-dlh-documentation/contents/<path> -q .download_url
```

When a checklist item links to e.g. `best-practices.md#delta-table-optimization`, fetch `best-practices.md` from this repo to verify the exact guidance before flagging a finding.

### bi-dlh-helper (dlh-dmt-helper package source)

**Repo:** https://github.com/DanskeStatsbaner/bi-dlh-helper

The authoritative source for `dlh-dmt-helper` package APIs, signatures, supported usage patterns, and version history. Consult this repo when:

- The reviewed code imports or calls `dlh_dmt_helper` modules (monitoring, data_quality, ai, etc.)
- A finding depends on whether the code uses the package correctly
- Checking whether a newer package version offers better functionality
- Verifying CustomException, logger, DeltaTableManager, or data quality API behavior

Key paths:
- `dlh_dmt_helper/monitoring/` -- logger, CustomException, Loki/Humio sinks
- `dlh_dmt_helper/data_quality/` -- DQ framework, check() method
- `dlh_dmt_helper/ai/` -- metadata generation
- `dlh_dmt_helper/delta/` -- DeltaTableManager, read_change_data
- `CHANGELOG.md` or tags -- version history

### bi-dlh-dmt-ci-cd (deployment & runtime wiring)

**Repo:** https://github.com/DanskeStatsbaner/bi-dlh-dmt-ci-cd

The authoritative source for actual deployment and runtime wiring. Consult when findings involve:

- Job/task parameters and cluster environment variables
- CI/CD pipeline behavior (`adb_pipeline.yml` template)
- Databricks deployment patterns
- How notebooks receive configuration at runtime

### Other internal packages

If the reviewed code imports other internal DSB packages, look for their repos under the `DanskeStatsbaner` org following the naming pattern:
- `dlh-oracle` -> `https://github.com/DanskeStatsbaner/bi-dlh-oracle`
- `dlh-<name>` -> `https://github.com/DanskeStatsbaner/bi-dlh-<name>`

## Sub-Agent Reference Access

Each sub-agent prompt should include a reminder to fetch relevant documentation when needed:

```
## Reference sources
When a finding depends on documented best practices, package APIs, or deployment behavior,
fetch the relevant file from these repos before concluding:

- Platform docs & checklist: https://github.com/DanskeStatsbaner/bi-dlh-documentation
  (best-practices.md, docs/monitoring.md, docs/data-quality.md, docs/databricks-jobs.md, etc.)
- dlh-dmt-helper source: https://github.com/DanskeStatsbaner/bi-dlh-helper
- CI/CD wiring: https://github.com/DanskeStatsbaner/bi-dlh-dmt-ci-cd

Use `gh api repos/DanskeStatsbaner/<repo>/contents/<path> -q .download_url` to get download URLs.
Do not guess package behavior or platform conventions -- verify against the source repos.
```
