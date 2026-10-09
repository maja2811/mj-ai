---
name: review-pr
description: Review GitHub pull requests, branch URLs, or repository roots with the extracted in-house reviewer prompt using OpenCode-native toolcalling. Use this skill whenever the user asks to review a GitHub PR URL, branch URL, repo URL, generate a final markdown review, validate findings, inspect CI/discussion context, automatically watch for review-requested PRs, or optionally post a PR review back to GitHub. Do not start the old FastAPI reviewer backend; rely on OpenCode tools plus the bundled clone helpers.
compatibility: Requires Python 3, GitHub CLI (`gh`) authenticated for the target repositories, and network access to GitHub. The optional PR watcher (Windows-native) also requires PowerShell, Windows Terminal (`wt.exe`), and OpenCode V2 (`opencode`/`opencode2`). Optional runtime validation may require Databricks CLI (`databricks`) plus a user-selected Databricks profile. Optional Azure DevOps CI inspection may require the `dlh-azure-devops-pipelines` skill and existing local Azure/GitHub authentication.
---

# Review PR

This skill is the OpenCode-native replacement for the external PR reviewer backend. It uses the extracted reviewer prompt as an instruction contract, then lets OpenCode perform the toolcalling directly with its normal file, shell, web, GitHub CLI, Databricks, and supporting-repo inspection tools.

Do not run the old FastAPI reviewer backend, `/api/review/start`, or any legacy backend runner for the default workflow. The old backend was useful for assembling a first draft, but it duplicated toolcalling that OpenCode can now do itself. The deliverable is a corrected final markdown review written to disk.

Bundled resources:

- `references/opencode-reviewer-prompt.md`: extracted reviewer prompt adapted from `bi-dlh-pr-reviewer/pr_reviewer_app/backend/templates/review_prompt.xml.j2` and `_shared_components.j2` for OpenCode-native tools.
- `references/final-review-template.md`: deterministic final markdown wrapper that adds the AI notice, latest-checklist link, and fixed model line.
- `scripts/clone_pr_head.py`: fetches PR metadata, discussion artifacts, review summaries, filtered diff, and a local clone of the exact PR head commit using GitHub's pull ref so merged PRs with deleted source branches still work.
- `scripts/detect_followup_review.py`: deterministically detects the latest previous AI review from collected PR artifacts and writes follow-up context files.
- `scripts/collect_branch_or_repo_review.py`: fetches branch-vs-default or full-repository review artifacts for GitHub `/tree/<branch>` and repo-root URLs.
- `scripts/wait_for_ci.py`: waits until CI checks attached to the review head are no longer pending, queued, or in progress before review analysis starts.
- `scripts/collect_azure_devops_evidence.py`: maps PR-head GitHub status/check evidence to Azure DevOps builds and saves selected CI logs.
- `scripts/fetch_latest_checklist.py`: fetches the latest `checklist.md` from `DanskeStatsbaner/bi-dlh-documentation` and records its source ref.
- `scripts/render_review_markdown.py`: renders the final markdown from a body-only review with the final review template.
- `scripts/poll_reviews.py`: polls GitHub for open PRs where the current user is a requested reviewer, filtering out PRs already reviewed at the current head commit SHA.
- `scripts/start_review_v2.py`: creates an OpenCode V2 review session through `opencode2 api` and submits the review prompt with this skill; also used by the renderer to read the session model.
- `scripts/notify.ps1`: shows a native Windows toast notification (WinRT `ToastNotificationManager`); used by the global `windows-toasts` OpenCode plugin.
- `scripts/pr-watcher.ps1`: Windows-native watcher that loops `poll_reviews.py`, starts a background review session per new/updated PR via `start_review_v2.py`, and opens a Windows Terminal tab attached to the session once the review is ready.
- `scripts/clone_github_repo.py`: clones supporting GitHub repositories under the current review workspace.

## When To Use This Skill

Use this skill when the user asks to:

- review a GitHub PR URL
- review a GitHub branch URL such as `https://github.com/<owner>/<repo>/tree/<branch>`
- review a GitHub repository root such as `https://github.com/<owner>/<repo>`
- generate a markdown review file
- validate or correct findings against branch/repository contents
- inspect PR discussion, CI, package behavior, platform behavior, or Databricks runtime semantics as part of a review
- automatically watch GitHub for PRs requesting your review and launch review sessions
- post a completed review back to GitHub

If the task is only to discuss reviewer architecture or edit this skill, do not run the review workflow.

If the task is to start, verify, inspect, troubleshoot, or explain the automatic PR watcher, do not enter the PR/branch/repo review workflow and do not ask for a review target. Go directly to [Optional PR Watcher](#optional-pr-watcher).

## Default Workflow

### 1. Require A Review Target

- If the user did not provide a GitHub PR URL, branch URL, repo root URL, or `owner/repo`, ask for the target.
- If multiple GitHub targets are mentioned and the intended target is ambiguous, ask which one to review.
- Accept PR URLs in the form `https://github.com/<owner>/<repo>/pull/<number>`.
- Accept branch URLs in the form `https://github.com/<owner>/<repo>/tree/<branch>`; review them against the repository default branch unless the user gives a different base.
- Accept repo root URLs in the form `https://github.com/<owner>/<repo>` or `owner/repo`; review the default branch in full-file mode unless the user gives a non-default `--head-ref` style instruction.

### 2. Extract Explicit Options Only

Honor only options the user actually asked for.

- Output path: use the requested path, otherwise default from `suggested_filename` in `pr-manifest.json`.
- Checklist: always fetch and use the latest `checklist.md` from `DanskeStatsbaner/bi-dlh-documentation`. If the user provides another checklist URL, treat it as extra context only; it must not replace the official latest checklist.
- Excluded files: default to `uv.lock` for parity with the old backend. Add user-provided exclusions to that default unless the user explicitly asks to include lockfiles or include `uv.lock`.
- Custom review instruction: apply only when explicitly provided.
- Focus changed only: apply only when explicitly requested; otherwise review the target normally.
- Force initial review / ignore previous AI reviews: apply only when explicitly requested.
- Force follow-up review: apply when the user explicitly asks for a follow-up, even if automatic detection is inconclusive; ask for or identify the previous review to compare against.
- Posting mode: use the posting rules below.
- CI waiting: mandatory for PR, branch, and repo reviews. Do not skip the pre-review CI wait unless the user explicitly changes the task from review generation to CI inspection, watcher troubleshooting, or editing this skill.

Ignore backend-only options such as `model_key`, `max_tokens`, `reasoning_effort`, `thinking_level`, `enable_agent_tools`, `enable_validation`, and `enable_final_review` unless the user is explicitly asking about legacy backend behavior. OpenCode already controls model/tool execution for this session.

If the user explicitly says not to execute code or not to use Databricks, respect that and keep the review evidence limited to the allowed sources. The latest official checklist from `bi-dlh-documentation` is mandatory; if the user forbids fetching it, stop and ask whether to proceed without using this skill's standard checklist-backed review workflow.

### 3. Choose Paths And Collect Review Artifacts

Create a hidden review workspace under `~/.local/share/opencode/.review-pr-tmp/`, preferably `~/.local/share/opencode/.review-pr-tmp/review-pr-<id>/` (outside skill scan paths so clones are never loaded as skills). Keep all artifacts, clones, supporting repos, and runtime validation evidence inside that workspace. The helper scripts default here; only pass `--workspace` to override.

Default exclusions:

- Use `uv.lock` as an excluded pattern by default.
- If the user supplied excluded files, pass both `uv.lock` and the requested patterns.
- If the user explicitly asks to include `uv.lock` or lockfiles, omit the default `uv.lock` exclusion.

For PR URLs, run:

```bash
python ~/.config/opencode/skills/review-pr/scripts/clone_pr_head.py \
  --pr-url "<PR_URL>" \
  --workspace "<WORKSPACE>" \
  --exclude "uv.lock" \
  --manifest-path "<WORKSPACE>/pr-manifest.json"
```

For branch URLs or repo root URLs, run:

```bash
python ~/.config/opencode/skills/review-pr/scripts/collect_branch_or_repo_review.py \
  --target-url "<GITHUB_BRANCH_OR_REPO_URL>" \
  --workspace "<WORKSPACE>" \
  --exclude "uv.lock" \
  --manifest-path "<WORKSPACE>/pr-manifest.json"
```

If the user supplied a non-default base branch for a branch review, pass `--base-ref "<BASE_REF>"`. If the user supplied a non-default head ref for a repo root review, pass `--head-ref "<HEAD_REF>"`.

The helpers create the workspace when needed and are responsible for deleted-branch fallback, exact ref checkout, diff filtering, and manifest correctness. Do not hand-write or patch `pr-manifest.json`; if a helper fails, treat partial files as diagnostic only and rerun the fixed helper in a clean workspace before reviewing.

After the script finishes, read `pr-manifest.json`, then inspect:

- `clone_path`
- `diff_path`
- `pr_json_path`
- `issue_comments_path`
- `review_comments_path`
- `reviews_path`
- `changed_files_path`
- `suggested_filename`
- `head_sha`, `base_ref`, `cloned_head_sha`, `clone_strategy`, `target_kind`, `diff_type`, and `excluded_patterns`

Some fields are PR-only and may be absent for branch/repo reviews. Some fields are branch/repo-only and may be absent for PR reviews.

Do not guess artifact filenames. Always read the exact paths from `pr-manifest.json`; for changed files this is `changed_files_path`, not `changed-files.json`.

Freshness guard:

- The final review must be for the head SHA in `pr-manifest.json`.
- `cloned_head_sha` must equal `head_sha`; if it does not, stop and rerun artifact collection.
- If later GitHub metadata shows that the PR or branch head changed, rerun the relevant artifact helper and restart the review on the latest artifacts.
- Do not silently audit one head while writing a review for another.

GitHub discussion endpoint mapping:

- `issue_comments_path` contains top-level PR conversation from `repos/<owner>/<repo>/issues/<number>/comments`.
- `review_comments_path` contains inline code comments from `repos/<owner>/<repo>/pulls/<number>/comments`.
- `reviews_path` contains submitted review summaries and review states from `repos/<owner>/<repo>/pulls/<number>/reviews`.
- Never infer that a PR has no comments from an empty inline review-comments response alone.

### 4. Fetch Latest Checklist

Every review must use the latest official checklist from `DanskeStatsbaner/bi-dlh-documentation`. Do not rely on a stale local copy or only on a user-provided checklist URL.

Run after artifact collection:

```bash
python ~/.config/opencode/skills/review-pr/scripts/fetch_latest_checklist.py \
  --workspace "<WORKSPACE>"
```

Then read:

- `<WORKSPACE>/checklist.md`
- `<WORKSPACE>/checklist-manifest.json`

Rules:

- Treat this checklist as mandatory review input.
- If the checklist cannot be fetched, stop and report the GitHub/`gh` error instead of producing a checklist-free review.
- If the user provided a separate checklist URL, fetch it as supplemental context, but keep the official latest checklist as the source of truth for checklist-backed findings.
- Fetching the latest checklist does not establish that every process requirement still applies. Use the reviewer's checklist applicability rules to resolve corroborated documentation drift without waiving applicable safety or testing requirements.
- The final rendered markdown must link to the checklist URL from `checklist-manifest.json`.

### 5. Wait For CI Completion Before Reviewing

Every review must wait for CI to leave pending, queued, requested, running, or in-progress states before loading the reviewer prompt, analyzing changed files, or drafting findings. Failed, cancelled, skipped, neutral, or successful checks are terminal and may be reviewed after the wait gate records them; pending CI is not terminal.

Run after artifact collection and checklist fetch:

```bash
python ~/.config/opencode/skills/review-pr/scripts/wait_for_ci.py \
  --manifest-path "<WORKSPACE>/pr-manifest.json"
```

Rules:

- Treat this as a mandatory pre-review gate for PR URLs, branch URLs, and repo root reviews.
- The helper saves `<WORKSPACE>/ci-wait/status-check-rollup.json` and `<WORKSPACE>/ci-wait/ci-wait-manifest.json`; read them before reviewing and use them as the freshest CI status evidence.
- If CI finishes with failures or cancellations, continue the review using the completed CI evidence. Do not stop merely because CI is red.
- If the helper reports no checks after its no-check grace period, continue the review but note in the evidence ledger that no CI checks were visible for the review head.
- If the helper times out because checks are still pending, do not review or draft findings. Report the pending check names from `ci-wait-manifest.json` and ask whether to keep waiting, retry with a longer timeout, or stop.
- If the PR or branch head changes while waiting, rerun artifact collection, fetch the checklist again if needed, and restart the CI wait for the new head before reviewing.
- If the user explicitly asks only to inspect or troubleshoot CI, do that task instead of producing a review.

### 6. Detect Initial Vs Follow-Up Review

Support the same two review modes as the old backend.

Default detection:

- If the user explicitly asks for an initial review or says to ignore previous AI reviews, use initial mode.
- For PR reviews, run the deterministic helper unless forced initial mode is requested:

```bash
python ~/.config/opencode/skills/review-pr/scripts/detect_followup_review.py \
  --manifest-path "<WORKSPACE>/pr-manifest.json"
```

- Read `<WORKSPACE>/followup-context.json` after the helper finishes.
- The helper inspects `issue_comments_path`, `review_comments_path`, and `reviews_path` for the latest previous AI review.
- It treats a comment or review as a previous AI review when the author login contains `github-actions`, `dependabot`, `renovate`, `bot`, `ai-reviewer`, or `pr-reviewer`, or when the body contains markers such as `AI-Generated Review Notice`, `### Summary (≤120 words)`, `### Findings`, or `### Overall Recommendation`.
- Use the newest matching AI review/comment by creation or submission time from `followup-context.json`.
- If one is found, use follow-up mode. If none is found, use initial mode.
- If the user explicitly asks for a follow-up and no previous review can be identified, ask which previous review/comment should be used or proceed only if the user confirms a best-effort full-diff follow-up.
- For branch/repo reviews, use initial mode unless the user explicitly provides a previous review to compare against.

Follow-up context:

- Use `previous-review.md`, `author-responses.md`, and `diff-since-last.diff` when `followup-context.json` points to them.
- Save or note the previous review body, creation/submission timestamp, source type, and commit SHA if present.
- Collect author comments after the previous review timestamp from top-level and inline comments, excluding AI/bot comments.
- If the previous review has a commit SHA, use the helper-created incremental diff from that SHA to the current PR head SHA and use it to assess drift and resolution status.
- If the previous review lacks a commit SHA, use the current full manifest `diff_path` and make the internal evidence ledger clear that the comparison is full-diff based.
- In follow-up mode, focus on whether previous findings were addressed, whether the implementation introduced new issues, and whether author responses change the review outcome. Do not re-review the entire PR as if no previous review exists.
- Apply the extracted prompt's follow-up closure rules: keep the original acceptance criteria stable, distinguish missing independent validation from an evidenced defect, and check whether new failures follow prior review advice. Close satisfied findings or explicitly withdraw unsupported demands; keep genuine regressions and failed required CI gates separate.

### 7. Load The Extracted Reviewer Prompt

Read `~/.config/opencode/skills/review-pr/references/opencode-reviewer-prompt.md` before reviewing. Treat it as the reviewer contract for severity labels, output structure, citation rules, CI/CD assumptions, and OpenCode-native tool use.

Load `ponytail` when available and apply it as a complexity lens (delete, reuse, stdlib/native first, YAGNI, shrink) alongside the normal correctness review. The bundled prompt's **Simplicity Gate (Ponytail)** is required even when that companion skill is unavailable. Keep this skill's headings, severity labels, evidence standards, and posting rules instead of Ponytail's standalone one-line report or line-count score.

Then layer in:

- the user's explicit instructions
- the PR, branch, or repo artifacts from the current workspace
- the latest official checklist content from `<WORKSPACE>/checklist.md`
- any user-provided checklist content as supplemental context only
- any relevant repository-local docs or project conventions found in the cloned branch

The extracted prompt is the base instruction surface. This skill file adds workflow mechanics and evidence rules around it.

### 8. Review With OpenCode Tools

Do not draft from memory. Build and save an evidence ledger while reviewing.

Evidence precedence:

1. PR metadata, description, and discussion artifacts, when reviewing a PR
2. latest official checklist from `bi-dlh-documentation`
3. exact CI evidence from `<WORKSPACE>/ci-wait/` and Azure DevOps artifacts, when present
4. the manifest `diff_path` artifact
5. changed files and nearby context in `clone_path`
6. repo-local docs, tests, config, and CI definitions
7. supporting source-of-truth repositories cloned under `<WORKSPACE>/reference-repos/`
8. authoritative web/docs sources fetched with CRW when external behavior matters
9. Databricks runtime evidence, if safely collected

This order guides evidence collection, not automatic authority in a conflict. Apply the prompt's shared author-explanation and checklist applicability rules in initial and follow-up reviews. Record disputed process requirements and their current applicability evidence in the evidence ledger; a pending documentation PR is corroboration, not authority by itself.

Use OpenCode-native tools instead of backend tool names:

- Use `Read` for the manifest `diff_path`, metadata JSON, review comments, the changed file list artifact path from `changed_files_path`, and specific cloned files.
- Use `Grep` for symbol, import, path, and config searches inside the cloned repo or supporting repos.
- Use `Glob` for file discovery.
- Use `shell` for GitHub CLI and git commands that inspect repository state, history, checks, or exact revisions.
- Use CRW web tools for official docs and external references.
- Use `scripts/clone_github_repo.py` when a supporting source-of-truth repo needs local inspection.
- If a fresh GitHub CLI/API, CRW, or other web fetch substitutes for a supporting clone, save the raw response or a focused excerpt under `<WORKSPACE>/supporting-evidence/` before using it to keep or reject a candidate finding. Include enough metadata in the saved file to identify the URL, command, ref/SHA if known, and fetch time.

Missed-issues sweep:

- Review changed files directly, not just PR prose or previous comments.
- Check correctness, security, performance, maintainability, tests, CI/CD behavior, deployment behavior, data migration risk, project conventions, and applicable latest-checklist requirements.
- Apply the simplicity gate to the submitted code: trace callers and existing capabilities, identify unnecessary complexity with concrete cost, and verify the smallest adequate replacement. Material overengineering is a merge-blocking `MAJOR` finding, not an optional suggestion merely because tests pass.
- Treat PR description and comments as evidence about intent and rollout constraints when present, but verify important claims against code, CI, docs, or runtime behavior.
- When a candidate finding depends on existing persisted state from earlier code, cite the base or previous behavior that can create that state and include a concrete scenario.
- If a candidate finding says production data can be deleted, dropped, truncated, overwritten, omitted from a required reload, or otherwise lost, start from `CRITICAL`. Downgrade to `MAJOR` only when the evidence shows the data is temporary, recoverable, non-production, or not consumer-visible, and state that rationale in the review.
- Every candidate finding must end as `kept` or `rejected` in your working notes before writing the final review.
- Before rendering, save those working notes to `<WORKSPACE>/evidence-ledger.md` or `<WORKSPACE>/evidence-ledger.json`. Include each candidate finding, considered severity, final `kept` or `rejected` status, concrete evidence paths/lines, validation notes, and the rejection reason when rejected. For complexity findings, include the current requirement, concrete cost, and simpler equivalent; for proposed fixes, record why the chosen remediation is sufficient without extra machinery. This file is for auditability only; do not mention it in the final review.

### 9. CI And Azure DevOps Evidence

Prefer exact CI evidence over generic status labels.

- CI completion must already have been waited for by [Wait For CI Completion Before Reviewing](#5-wait-for-ci-completion-before-reviewing). Do not start the code review from a pending `statusCheckRollup`.
- Start from GitHub metadata for the exact PR head SHA: `statusCheckRollup`, checks, statuses, details URLs, target URLs, check-run `external_id` values, and any build IDs in links.
- Prefer `<WORKSPACE>/ci-wait/status-check-rollup.json` as the latest GitHub status/check rollup because it is captured after the wait gate.
- Treat PR-head-attached status/check evidence as authoritative for which Azure DevOps builds matter. Map Azure DevOps links or `external_id` values to build IDs and pipeline IDs before pulling logs.
- Do not inspect or cite similarly named Azure DevOps pipelines just because they exist in the same repo or folder. Ignore cleanup, permissions, scheduled, or unrelated pipelines unless they are attached to the PR head, enforce a required PR policy, or the user explicitly asks for them.
- If the PR uses Azure DevOps pipelines and exact logs are needed, load `dlh-azure-devops-pipelines` and inspect the relevant attached build, stage, and task output rather than guessing from a red/green status.
- Prefer the bundled helper for deterministic Azure DevOps evidence collection:

```bash
python ~/.config/opencode/skills/review-pr/scripts/collect_azure_devops_evidence.py \
  --manifest-path "<WORKSPACE>/pr-manifest.json"
```

- The helper saves `status-check-rollup.json`, `build-<id>.json`, `build-<id>-timeline.json`, selected task logs, and `azure-devops-manifest.json` under `<WORKSPACE>/azure-devops/`.
- If exact logs are unavailable, say that narrowly in the final review only when CI status itself matters.
- For Azure DevOps builds, fetch the build timeline first and classify task logs before deciding what to read. Pull logs for every task that is failed, `succeededWithIssues`, or directly validates/builds/deploys this repo's code or config.
- Code-produced task logs usually include project/self-service YAML validation, Databricks config validation, Python linting, Python format checks, static type checking, unit/integration tests, package/build/archive steps, deployment steps, and notebook/job validation steps.
- Skip checkout, key-vault, dependency installation, post-job, finalization, and generic environment setup logs unless they fail, have warnings/errors, or explain a code-produced failure.
- Save pulled Azure DevOps evidence under `<WORKSPACE>/azure-devops/` with filenames containing the build ID, log ID, and task name.
- Distinguish changed-code failures from repo-wide or pre-existing failures. If the failure is outside the touched files and not caused by the PR, do not present it as a functional defect in the diff.
- If a required PR gate fails for repo-wide or pre-existing reasons, frame it as a validation gate or waiver/tracking issue with exact CI evidence, not as a new code finding against unrelated files.
- For closed or merged PRs, do not recommend impossible formal request-changes action as the only next step; recommend a follow-up fix, documented waiver, or linked tracking item when the CI failure still matters.
- Do not invent CI failures from local assumptions.
- Do not ignore concrete CI failures just because they came from Azure DevOps rather than GitHub Actions.

### 10. Databricks-Backed Runtime Validation

When a claim depends on actual Databricks runtime behavior and static evidence is not enough, prefer Databricks-backed execution over local Spark.

This applies especially to Spark SQL parsing, casting, coercion, ANSI behavior, DataFrame semantics, notebook/widget behavior, Databricks-specific runtime behavior, and environment differences that cannot be settled from config alone.

Rules:

- Load the `databricks` skill before running Databricks commands.
- Never auto-select a Databricks profile.
- If the user explicitly provided a Databricks profile, use it.
- Otherwise, run `databricks auth profiles`, show the available profiles, and ask the user to choose one before Databricks execution.
- If the chosen profile is missing or invalid, drive the Databricks CLI auth workflow yourself and ask the user only for pieces the CLI flow cannot infer safely.
- Prefer the least invasive probe that can answer the question.
- Save command inputs and outputs under `<WORKSPACE>/databricks-validation/`.
- Prefer literals, temp views, and read-only queries over real data mutations.
- Never mutate production tables, volumes, jobs, secrets, or deployed workspace assets just to validate a review claim.
- Delete temporary Databricks workspace paths after capturing evidence.
- If Databricks execution cannot be performed safely, keep the claim narrower and state the blocker.

### 11. Package And Platform Source-Of-Truth Repos

If a finding depends on package behavior, deployment wiring, platform conventions, runtime configuration, or shared CI/CD behavior, inspect the source-of-truth repo before concluding.

- Clone supporting repos with `scripts/clone_github_repo.py`, pass `--workspace <WORKSPACE>` exactly, and save each clone manifest with `--manifest-path <WORKSPACE>/reference-repos/<slug>-manifest.json`. Do not pass `<WORKSPACE>/reference-repos` or `<WORKSPACE>/reference-repos/<slug>` as the workspace. The helper normalizes those mistakes to avoid nested paths, but correct calls are easier to audit. Use `--repo <owner/repo-or-url>`; `--repo-url` is accepted as an alias but `--repo` is preferred for consistency.
- Treat each supporting clone manifest as required evidence. Before relying on the clone, read the manifest and cite or record `clone_path`, `requested_ref`, `resolved_head_sha`, `resolved_tags`, and `resolved_describe` in the evidence ledger when they are relevant.
- If the target repo pins a supporting package version, such as `dlh-dmt-helper==13.5.1` in `requirements.txt` or `pyproject.toml`, prefer cloning the source-of-truth repo at the matching tag/ref with `--ref <pinned-version-or-tag>` and a versioned `--directory-name`. If no matching tag/ref is available, use the closest source evidence you can fetch and explicitly record the mismatch or fallback reason in the evidence ledger.
- For `dlh-dmt-helper`, inspect `https://github.com/DanskeStatsbaner/bi-dlh-helper`.
- For DSB BI/DLH platform docs and deployment behavior, inspect `https://github.com/DanskeStatsbaner/bi-dlh-documentation` and `https://github.com/DanskeStatsbaner/bi-dlh-dmt-ci-cd`.
- When local inspection is helpful, clone those repos into the current review workspace, not elsewhere on disk.
- Treat supporting-repo evidence as valid only when it comes from the current review workspace under `<WORKSPACE>/reference-repos/`, the current target repo under `clone_path`, or a fresh CLI/CRW fetch saved under `<WORKSPACE>/supporting-evidence/`. Do not cite or validate package/platform behavior from previous `.review-pr-tmp` workspaces, installed skill bundles, or unrelated local checkouts; those paths can be stale or belong to another PR. If a loaded domain skill exposes a bundled path from an old review workspace, use it as background guidance only, then clone/read the real source-of-truth repo in the current workspace before keeping the finding.
- If `scripts/clone_github_repo.py` cannot clone a supporting repo and you fall back to `gh api`, CRW, or another fresh fetch, create `<WORKSPACE>/supporting-evidence/` and save the fetched source/excerpt plus the exact command or URL before relying on it in the evidence ledger.
- If the current-workspace supporting clone or fresh fetch fails, either keep the claim narrow to the evidence already available in the target repo or reject the candidate. Do not promote a package/platform finding from stale local evidence.
- Prefer source, tags, changelogs, tests, docs, and version metadata over guessing from local call names.
- Only promote package/platform facts to findings when they connect concretely to this PR's actual usage, deployment path, or documented expectations.

Important DLH platform false-positive guardrails:

- Do not treat `/Workspace/Users/.../<repo>/adb/...`, `/Workspace/Repos/.../<repo>/adb/...`, or `/Repos/.../<repo>/adb/...` notebook paths as automatically invalid. First inspect `bi-dlh-dmt-ci-cd` path normalization and deployment behavior.
- If CI/CD rewrites a supported repo-local path to `/Deployment/<repo>/<branch>/...`, reject findings that claim the job is developer-workspace-bound solely because of the checked-in path.
- Do not flag CI/CD-guaranteed environment variables such as `DATABRICKS_ENVIRONMENT`, `KEY_VAULT_NAME`, `CATALOG_NAME`, `PROJECT_NAME`, and storage path variables as missing just because local ad hoc execution would need setup.
- For managed Databricks jobs and notebooks, prefer concrete platform evidence over generic local-runtime concerns.
- Apply the extracted prompt's **Unity Catalog metadata** policy: missing, invalid, or outdated required metadata for new development or changes to existing solutions is `MAJOR` and requires `REQUEST_CHANGES` for an open PR unless explicitly waived/downgraded under the existing policy. Check affected data assets and applicable schema metadata even when metadata files are absent from the diff; exclude unrelated untouched legacy assets and optional metadata. A tracking issue or generator failure alone is not a waiver.
- When reviewing Unity Catalog `metadata.yml`, verify the helper-managed YAML shape before recommending exact tag syntax. Current `dlh-dmt-helper` injects table-level domain as the domain value itself with an empty value, for example `Product: ""`, not `domain: Product`; inspect a current-workspace clone of `bi-dlh-helper` under `<WORKSPACE>/reference-repos/` or the repo-pinned helper source when uncertain.
- If a metadata finding includes an example YAML snippet, match the repo-local existing format and helper implementation. Do not invent tag keys, tag nesting, or metadata fields that the helper will not emit or consume.
- When a `metadata.yml` finding concerns `columns: []` or missing column documentation, compare actual projected output columns against `metadata.yml` `columns[*].name` and verify populated descriptions. Follow the prompt's closure rules: partial required coverage remains `⚠️` and merge-blocking, not a remaining non-blocking `MINOR`; explain any reassessment of an earlier `MINOR` finding under the current policy.

### 12. Validate And Produce The Final Markdown Review

Before rendering:

- Re-check retained findings against the diff, current source, CI/runtime evidence, and PR discussion.
- For blocking findings (`CRITICAL` or `MAJOR`), use one read-only subagent to search for counterevidence. Give it the target/head, artifact paths, and candidate claims; require complete call paths, supported/partially supported/false verdicts, file/line evidence, and severity justification. If delegation is unavailable or disallowed, disclose the limitation and perform the counterevidence pass yourself.
- Verify the subagent's evidence yourself, resolve disagreements, and record final dispositions in the evidence ledger. Remove unsupported claims and update the recommendation when blockers fall away. A subagent's verdict is not evidence by itself.
- Apply the reviewer prompt's simplicity gate to proposed fixes and recommendations. Follow its initial/follow-up format, severity, citation, and output rules.

The LLM must write only the review body. It must not generate the disclaimer, checklist sentence, or model line. Those are rendered deterministically from `references/final-review-template.md`.

Write the body-only review to:

```text
<WORKSPACE>/review-body.md
```

Then render the final markdown file with the deterministic template:

```bash
python ~/.config/opencode/skills/review-pr/scripts/render_review_markdown.py \
  --body-path "<WORKSPACE>/review-body.md" \
  --output-path "<FINAL_MARKDOWN_PATH>" \
  --checklist-manifest-path "<WORKSPACE>/checklist-manifest.json" \
  --session-id "<CURRENT_REVIEW_SESSION_ID>"
```

- Pass the current review session ID from the watcher prompt or session context. The renderer reads its model and reasoning variant from OpenCode and writes a provider-free label, for example `**Used model:** GPT 6.1 Sol (high)` for `azure/gpt-6.1-sol#high`. It formats GPT model IDs as readable names and puts the reasoning variant in parentheses, omitting the parentheses when none is set. Use the session that performed the review, not a parent or unrelated session. If the model was changed during the review, this identifies the selected model at rendering time.
- For manual runs where the session ID is not known, or for rendering outside OpenCode, pass `--model "<ACTUAL_MODEL_AND_REASONING_LEVEL>"` explicitly, for example `--model "GPT 6.1 Sol (high)"`. There is no hardcoded model fallback; an unavailable session or missing model must be resolved before rendering.

Final coherence pass:

- Read the saved markdown once after the last edit.
- Verify that `review-body.md` does not contain `AI-Generated Review Notice` or `**Used model:**`.
- Prefer `Read` or `Grep` for absence checks. If using `rg` in Bash, remember that zero matches returns exit code 1; use a command that explicitly treats zero forbidden matches as the expected success and inspect the captured output.
- Verify that the rendered final markdown contains exactly one AI-generated review notice and exactly one `**Used model:**` line matching the review session's model and reasoning variant.
- Verify that the rendered final markdown links to the checklist URL from `checklist-manifest.json`.
- Confirm the evidence ledger exists, every kept finding appears in the review, and rejected candidates have rejection rationales and are absent from the review.
- In follow-up mode, verify statuses against the previous review's exact conditions and current head; record closure evidence or withdrawal reasons in the evidence ledger and remove withdrawn demands from recommendations. Report related regressions separately under `### New Issues`, including any connection to prior review advice.
- Confirm that summary, findings, examples, recommendations, and overall recommendation agree.
- Confirm the final assistant message agrees with the file on whether findings were added, removed, or retained.
- Follow [Optional GitHub Posting](#optional-github-posting) to show the rendered review and obtain approval before posting.

## Optional GitHub Posting

After writing the final markdown review for a PR URL, report the saved file path and show the rendered final review content in the assistant message before asking about posting. The user should see exactly what would be posted to GitHub before being asked to approve the post. Then always use the `question` tool to offer posting options. Put the default formal review action first: request changes for `REQUEST_CHANGES`, approve for `APPROVE`, or comment when the recommendation is neither. Include a `Do not post` option. Do not post automatically. Branch/repo reviews have no PR posting target, so just report the saved file path unless the user gives a specific posting destination.

If the posting question is dismissed or unanswered, treat that as `do not post`, leave the markdown on disk, mark the workflow complete, and report the saved file path in the final response.

Default posting behavior:

- Default to a formal PR review, not a plain PR comment.
- If the final review recommends `REQUEST_CHANGES`, default to request changes.
- If the final review recommends `APPROVE`, default to approval.
- Use a plain PR comment only when the user explicitly asks for a comment or the recommendation is neither approval nor request changes.
- Post the rendered final markdown file, not the body-only draft. The posted body must include the deterministic template preamble and the session-derived `**Used model:**` line.

Posting commands:

- Comment: `gh pr comment <PR_URL> --body-file <FINAL_MARKDOWN_PATH>`
- Approval review: `gh pr review <PR_URL> --approve --body-file <FINAL_MARKDOWN_PATH>`
- Request-changes review: `gh pr review <PR_URL> --request-changes --body-file <FINAL_MARKDOWN_PATH>`
- Comment-style formal review: `gh pr review <PR_URL> --comment --body-file <FINAL_MARKDOWN_PATH>`

Safety rules:

- Never post without explicit confirmation in the current run. A normal-text reply such as "post it", "post as comment", "approve", or "request changes" is sufficient confirmation when it clearly names the intended posting action.
- If no explicit affirmative answer is received, treat that as `do not post`, leave the markdown on disk, mark the workflow complete, and report the file path.
- Never post before the final markdown file exists.
- Do not post a request-changes review as approval.
- If `gh` auth or repository access fails, report the error and do not retry blindly.
- After posting, verify the latest submitted PR review with `gh pr view <PR_URL> --json reviews --jq '.reviews[-1] | {author: .author.login, state: .state, submittedAt: .submittedAt}'` or an equivalent GitHub API query. Report the verified review state and timestamp in the final assistant message. If verification fails, say the post command succeeded but verification failed, include the error, and do not claim a verified posted state.

## Optional PR Watcher

Use `scripts/pr-watcher.ps1` when the user wants review sessions to start automatically for new GitHub PRs requesting their review. This is the Windows-native watcher: it polls GitHub via `scripts/poll_reviews.py` (`gh search prs --review-requested=@me`, filtered to open, non-draft PRs not yet reviewed at the current head commit SHA) and starts an OpenCode V2 review session in the background for each new/updated PR through `scripts/start_review_v2.py`. Nothing opens while the review runs. The global `windows-toasts` plugin (`~/.config/opencode/plugins/windows-toasts`) shows a toast when the session finishes, fails, or asks the posting question; the watcher checks active sessions every 15 seconds and then opens a Windows Terminal tab attached to the session (`opencode.cmd --session <sessionID>`).

Reattach to any review with `opencode --session <sessionID>`. The global `opencode.json` allows `external_directory` access to `~/.local/share/opencode/.review-pr-tmp/*` so reviews do not prompt for their own workspace. The macOS `pr-watcher.sh` and its review-tabs plugin are not bundled in this install; do not suggest them on Windows.

For verification or troubleshooting requests, inspect `scripts/pr-watcher.ps1`, `scripts/poll_reviews.py`, and `scripts/start_review_v2.py` directly and answer from the scripts. Do not start a persistent watcher unless the user asks to start it.

**Required first run:** before starting the watcher for the first time, or any time `.review-poll-state.json` is deleted/reset, run baseline seeding so existing pending-review PRs are recorded as already seen instead of all being launched at once:

```powershell
powershell -ExecutionPolicy Bypass -File ~/.config/opencode/skills/review-pr/scripts/pr-watcher.ps1 -Baseline
```

Default command (after baseline seeding):

```powershell
powershell -ExecutionPolicy Bypass -File ~/.config/opencode/skills/review-pr/scripts/pr-watcher.ps1
```

Defaults:

- Poll interval: `60` seconds, override with `-PollInterval <seconds>`.
- OpenCode V2 model: `azure/gpt-6.1-sol#high`, override with `-OpencodeModel <provider/model#variant>`. The variant is set on the session through the API, not through a TUI flag.
- `scripts/start_review_v2.py` creates the session through `opencode2 api post /api/session` (title `PR Review: <repo>#<number> @<short-sha>`, model, skill directory as location, watcher metadata), then submits the prompt with the `review-pr` skill through `/api/session/<sessionID>/prompt`, including the session ID for `render_review_markdown.py --session-id`. Session and message IDs are derived from directory, title, and URL, so a retry for the same head commit reuses the same session and a new commit gets a new session.
- Single-cycle mode: pass `-Once` to run one poll cycle and exit instead of looping. Sessions still run and toast when ready, but no tab is opened; attach with `opencode --session <sessionID>`.
- Baseline mode: pass `-Baseline` to seed existing pending PRs as already-seen without launching any sessions.
- State file (dedup by head SHA): `~/.config/opencode/skills/review-pr/.review-poll-state.json`, managed by `poll_reviews.py`. A PR is marked reviewed only after its session was started, so a failed start is retried on the next poll.
- Review artifacts go to `~/.local/share/opencode/.review-pr-tmp` (override with `PR_WATCHER_REVIEW_TMP_DIR`). The Windows watcher does not clean them up; delete old `review-pr-*` folders manually when needed.
- Notification: the `windows-toasts` plugin calls `scripts/notify.ps1`. Active sessions are tracked in memory, so after a watcher restart reviews still toast but their tab must be opened manually. If toasts do not appear, check Windows notification settings for PowerShell.
- Requires `gh`, `python`, `opencode.cmd`/`opencode2.cmd` (npm shims; the `.ps1` shims may be blocked by execution policy), and `wt.exe` (Windows Terminal) on PATH.

## Failure Handling

- If an artifact helper fails, surface the `gh`, git, or network error exactly enough to diagnose it. Do not review from partial artifacts or manually reconstruct `pr-manifest.json`.
- If GitHub access fails, do not guess from partial artifacts.
- If the latest official checklist cannot be fetched, stop and report the failure instead of producing a checklist-free review.
- If exact CI logs are needed but unavailable, state the narrow CI evidence gap and keep affected claims limited.
- If the CI wait helper times out on pending checks, stop without producing the review and report the pending check names plus the wait manifest path.
- For GitHub checks, use fields supported by the local `gh` version, such as `name,state,startedAt,completedAt,link,bucket,description`; do not assume `gh pr checks --json conclusion` is available.
- For Azure DevOps build logs, prefer `az devops invoke --area build --resource timeline` and `az devops invoke --area build --resource logs` with explicit organization/project/build IDs. Do not rely on nonexistent `az pipelines build logs list` commands.
- If Databricks validation is needed but cannot be done safely, state the blocker and keep the claim narrower.
- If supporting repo access fails, say which repo could not be inspected and avoid findings that depend on it.
- If the PR or branch head changes during the run, refresh artifacts and review the new head.

## Output Rules

- Final deliverable: one markdown file containing the review.
- Default location: current directory.
- Default filename: use `suggested_filename` from `pr-manifest.json` unless the user requested a different path.
- Keep the local review workspace so artifacts remain inspectable.
