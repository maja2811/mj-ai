---
name: review-pr
description: Review GitHub pull requests, branch URLs, or repository roots with the extracted in-house reviewer prompt using OpenCode-native toolcalling. Use this skill whenever the user asks to review a GitHub PR URL, branch URL, repo URL, generate a final markdown review, validate findings, inspect CI/discussion context, automatically watch for review-requested PRs, or optionally post a PR review back to GitHub. Do not start the old FastAPI reviewer backend; rely on OpenCode tools plus the bundled clone helpers.
compatibility: Requires Python 3, GitHub CLI (`gh`) authenticated for the target repositories, and network access to GitHub. The optional PR watcher (Windows-native) also requires PowerShell, Windows Terminal (`wt.exe`), and `opencode`. Optional runtime validation may require Databricks CLI (`databricks`) plus a user-selected Databricks profile. Optional Azure DevOps CI inspection may require the `dlh-azure-devops-pipelines` skill and existing local Azure/GitHub authentication.
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
- `scripts/collect_azure_devops_evidence.py`: maps PR-head GitHub status/check evidence to Azure DevOps builds and saves selected CI logs.
- `scripts/fetch_latest_checklist.py`: fetches the latest `checklist.md` from `DanskeStatsbaner/bi-dlh-documentation` and records its source ref.
- `scripts/render_review_markdown.py`: renders the final markdown from a body-only review with the final review template.
- `scripts/poll_reviews.py`: polls GitHub for open PRs where the current user is a requested reviewer, filtering out PRs already reviewed at the current head commit SHA.
- `scripts/notify.ps1`: shows a native Windows toast notification (WinRT `ToastNotificationManager`).
- `scripts/pr-watcher.ps1`: Windows-native watcher that loops `poll_reviews.py`, shows a toast via `notify.ps1` for each new/updated PR, and opens a new Windows Terminal tab running `opencode --prompt '/review-pr <url>'`.
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

Ignore backend-only options such as `model_key`, `max_tokens`, `reasoning_effort`, `thinking_level`, `enable_agent_tools`, `enable_validation`, and `enable_final_review` unless the user is explicitly asking about legacy backend behavior. OpenCode already controls model/tool execution for this session.

If the user explicitly says not to execute code or not to use Databricks, respect that and keep the review evidence limited to the allowed sources. The latest official checklist from `bi-dlh-documentation` is mandatory; if the user forbids fetching it, stop and ask whether to proceed without using this skill's standard checklist-backed review workflow.

### 3. Choose Paths And Collect Review Artifacts

Create a workspace-local hidden review folder under `./.review-pr-tmp/`, preferably `./.review-pr-tmp/review-pr-<id>/`. Keep all artifacts, clones, supporting repos, and runtime validation evidence inside that workspace.

Default exclusions:

- Use `uv.lock` as an excluded pattern by default.
- If the user supplied excluded files, pass both `uv.lock` and the requested patterns.
- If the user explicitly asks to include `uv.lock` or lockfiles, omit the default `uv.lock` exclusion.

For PR URLs, run:

```bash
python3 ~/.config/opencode/skills/review-pr/scripts/clone_pr_head.py \
  --pr-url "<PR_URL>" \
  --workspace "<WORKSPACE>" \
  --exclude "uv.lock" \
  --manifest-path "<WORKSPACE>/pr-manifest.json"
```

For branch URLs or repo root URLs, run:

```bash
python3 ~/.config/opencode/skills/review-pr/scripts/collect_branch_or_repo_review.py \
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
python3 ~/.config/opencode/skills/review-pr/scripts/fetch_latest_checklist.py \
  --workspace "<WORKSPACE>"
```

Then read:

- `<WORKSPACE>/checklist.md`
- `<WORKSPACE>/checklist-manifest.json`

Rules:

- Treat this checklist as mandatory review input.
- If the checklist cannot be fetched, stop and report the GitHub/`gh` error instead of producing a checklist-free review.
- If the user provided a separate checklist URL, fetch it as supplemental context, but keep the official latest checklist as the source of truth for checklist-backed findings.
- The final rendered markdown must link to the checklist URL from `checklist-manifest.json`.

### 5. Detect Initial Vs Follow-Up Review

Support the same two review modes as the old backend.

Default detection:

- If the user explicitly asks for an initial review or says to ignore previous AI reviews, use initial mode.
- For PR reviews, run the deterministic helper unless forced initial mode is requested:

```bash
python3 ~/.config/opencode/skills/review-pr/scripts/detect_followup_review.py \
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

### 6. Load The Extracted Reviewer Prompt

Read `~/.config/opencode/skills/review-pr/references/opencode-reviewer-prompt.md` before reviewing. Treat it as the reviewer contract for severity labels, output structure, citation rules, CI/CD assumptions, and OpenCode-native tool use.

Then layer in:

- the user's explicit instructions
- the PR, branch, or repo artifacts from the current workspace
- the latest official checklist content from `<WORKSPACE>/checklist.md`
- any user-provided checklist content as supplemental context only
- any relevant repository-local docs or project conventions found in the cloned branch

The extracted prompt is the base instruction surface. This skill file adds workflow mechanics and evidence rules around it.

### 7. Review With OpenCode Tools

Do not draft from memory. Build and save an evidence ledger while reviewing.

Evidence precedence:

1. PR metadata, description, and discussion artifacts, when reviewing a PR
2. latest official checklist from `bi-dlh-documentation`
3. exact CI evidence, if available
4. the manifest `diff_path` artifact
5. changed files and nearby context in `clone_path`
6. repo-local docs, tests, config, and CI definitions
7. supporting source-of-truth repositories cloned under `<WORKSPACE>/reference-repos/`
8. authoritative web/docs sources fetched with CRW when external behavior matters
9. Databricks runtime evidence, if safely collected

Use OpenCode-native tools instead of backend tool names:

- Use `Read` for the manifest `diff_path`, metadata JSON, review comments, the changed file list artifact path from `changed_files_path`, and specific cloned files.
- Use `Grep` for symbol, import, path, and config searches inside the cloned repo or supporting repos.
- Use `Glob` for file discovery.
- Use `bash` for GitHub CLI and git commands that inspect repository state, history, checks, or exact revisions.
- Use CRW web tools for official docs and external references.
- Use `scripts/clone_github_repo.py` when a supporting source-of-truth repo needs local inspection.
- If a fresh GitHub CLI/API, CRW, or other web fetch substitutes for a supporting clone, save the raw response or a focused excerpt under `<WORKSPACE>/supporting-evidence/` before using it to keep or reject a candidate finding. Include enough metadata in the saved file to identify the URL, command, ref/SHA if known, and fetch time.

Missed-issues sweep:

- Review changed files directly, not just PR prose or previous comments.
- Check correctness, security, performance, maintainability, tests, CI/CD behavior, deployment behavior, data migration risk, project conventions, and applicable latest-checklist requirements.
- Treat PR description and comments as evidence about intent and rollout constraints when present, but verify important claims against code, CI, docs, or runtime behavior.
- When a candidate finding depends on existing persisted state from earlier code, cite the base or previous behavior that can create that state and include a concrete scenario.
- If a candidate finding says production data can be deleted, dropped, truncated, overwritten, omitted from a required reload, or otherwise lost, start from `CRITICAL`. Downgrade to `MAJOR` only when the evidence shows the data is temporary, recoverable, non-production, or not consumer-visible, and state that rationale in the review.
- Every candidate finding must end as `kept` or `rejected` in your working notes before writing the final review.
- Before rendering, save those working notes to `<WORKSPACE>/evidence-ledger.md` or `<WORKSPACE>/evidence-ledger.json`. Include each candidate finding, considered severity, final `kept` or `rejected` status, concrete evidence paths/lines, validation notes, and the rejection reason when rejected. This file is for auditability only; do not mention it in the final review.

### 8. CI And Azure DevOps Evidence

Prefer exact CI evidence over generic status labels.

- Start from GitHub metadata for the exact PR head SHA: `statusCheckRollup`, checks, statuses, details URLs, target URLs, check-run `external_id` values, and any build IDs in links.
- Treat PR-head-attached status/check evidence as authoritative for which Azure DevOps builds matter. Map Azure DevOps links or `external_id` values to build IDs and pipeline IDs before pulling logs.
- Do not inspect or cite similarly named Azure DevOps pipelines just because they exist in the same repo or folder. Ignore cleanup, permissions, scheduled, or unrelated pipelines unless they are attached to the PR head, enforce a required PR policy, or the user explicitly asks for them.
- If the PR uses Azure DevOps pipelines and exact logs are needed, load `dlh-azure-devops-pipelines` and inspect the relevant attached build, stage, and task output rather than guessing from a red/green status.
- Prefer the bundled helper for deterministic Azure DevOps evidence collection:

```bash
python3 ~/.config/opencode/skills/review-pr/scripts/collect_azure_devops_evidence.py \
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

### 9. Databricks-Backed Runtime Validation

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

### 10. Package And Platform Source-Of-Truth Repos

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
- When reviewing Unity Catalog `metadata.yml`, verify the helper-managed YAML shape before recommending exact tag syntax. Current `dlh-dmt-helper` injects table-level domain as the domain value itself with an empty value, for example `Product: ""`, not `domain: Product`; inspect a current-workspace clone of `bi-dlh-helper` under `<WORKSPACE>/reference-repos/` or the repo-pinned helper source when uncertain.
- If a metadata finding includes an example YAML snippet, match the repo-local existing format and helper implementation. Do not invent tag keys, tag nesting, or metadata fields that the helper will not emit or consume.
- When a `metadata.yml` finding concerns `columns: []` or missing column documentation, compare the actual projected output columns from the changed table or view against `metadata.yml` `columns[*].name`. Do not mark the finding fully addressed unless the metadata covers the relevant exposed columns, or the review explicitly accepts a narrower documented subset with a rationale.
- In follow-up mode, if a metadata fix documents only some exposed columns, mark the previous metadata finding `⚠️` or add a remaining `MINOR` metadata issue instead of approving it as fully resolved.

### 11. Produce The Final Markdown Review

The LLM must write only the review body. It must not generate the disclaimer, checklist sentence, or model line. Those are rendered deterministically from `references/final-review-template.md`.

Write the body-only review to:

```text
<WORKSPACE>/review-body.md
```

Then render the final markdown file with the deterministic template:

```bash
python3 ~/.config/opencode/skills/review-pr/scripts/render_review_markdown.py \
  --body-path "<WORKSPACE>/review-body.md" \
  --output-path "<FINAL_MARKDOWN_PATH>" \
  --checklist-manifest-path "<WORKSPACE>/checklist-manifest.json" \
  --model "GPT-5.5"
```

- Use the initial or follow-up structure from `references/opencode-reviewer-prompt.md`, based on the detected review mode.
- Use only these severity labels when findings exist: `CRITICAL`, `MAJOR`, `MINOR`, `SUGGESTION`.
- Preserve exact headings and order.
- Do not write `AI-Generated Review Notice`, `Used model`, or the checklist preamble in `review-body.md`.
- The rendered final markdown must start with the template preamble and `**Used model:** GPT-5.5`.
- Keep the Summary no longer than 120 words.
- Sort findings by severity: `CRITICAL` > `MAJOR` > `MINOR` > `SUGGESTION`.
- Use Markdown links for code locations with stable refs, preferably the review head SHA from `pr-manifest.json`.
- Do not use unsupported labels such as `HIGH`, `MEDIUM`, `LOW`, or `INFO`.
- Do not mention temp workspace paths, helper scripts, tool names, internal notes, or that a correction pass happened.
- If no significant findings remain, write `No significant findings` in the Findings section and make the recommendation consistent.
- If example remediation details are unknown, keep examples generic instead of inventing APIs, parameters, or exact replacement code.
- Runtime-sensitive wording must reflect what was actually executed or verified.
- In follow-up mode, keep previous findings in their original order and use status values exactly as defined in the follow-up structure.
- In follow-up mode, add new findings under `### New Issues` only when they are concrete and evidenced; do not duplicate already-resolved previous findings as new issues.
- In follow-up mode, assess each previous finding against the exact condition described in the previous review. If the old condition is fixed but the fix creates a related different failure mode, mark the old finding `✅` and add the different failure under `### New Issues`.

Final coherence pass:

- Read the saved markdown once after the last edit.
- Verify that `review-body.md` does not contain `AI-Generated Review Notice` or `**Used model:**`.
- Prefer `Read` or `Grep` for absence checks. If using `rg` in Bash, remember that zero matches returns exit code 1; use a command that explicitly treats zero forbidden matches as the expected success and inspect the captured output.
- Verify that the rendered final markdown contains exactly one AI-generated review notice and exactly one `**Used model:** GPT-5.5` line.
- Verify that the rendered final markdown links to the checklist URL from `checklist-manifest.json`.
- Perform an independent validation pass against the saved artifacts before finalizing: re-check each kept finding against the manifest `diff_path`, current file lines, CI/runtime evidence, and PR discussion when present.
- Verify that `<WORKSPACE>/evidence-ledger.md` or `<WORKSPACE>/evidence-ledger.json` exists and that every final finding is marked `kept` there, while every plausible rejected candidate has a rejection rationale.
- Verify that every rejected candidate is absent, every retained finding is actionable, and CI-only findings are not misrepresented as changed-code defects.
- In follow-up mode, verify previous-finding statuses against the previous review commit and the current head before publishing the status table.
- In follow-up mode, verify that each previous-finding status answers only whether the exact previous condition remains; related regressions introduced by the fix belong under `### New Issues`.
- Confirm that summary, findings, examples, recommendations, and overall recommendation agree.
- Confirm every kept finding appears in the final markdown and every rejected candidate is absent.
- Confirm the final assistant message agrees with the file on whether findings were added, removed, or retained.

## Optional GitHub Posting

After writing the final markdown review for a PR URL, report the saved file path and proactively offer to post it back to GitHub in normal assistant text. The completion message must include an explicit offer such as `I can post this as a formal request-changes review if you want.` when the recommendation is `REQUEST_CHANGES`, or the matching approval/comment wording for other outcomes. Do not use the `question` tool as the default posting prompt; dismissed interactive prompts can leave the run without a final completion message. Do not post automatically. Branch/repo reviews have no PR posting target, so just report the saved file path unless the user gives a specific posting destination.

If the user explicitly asks for an interactive choice, the `question` tool may be used, but the workflow must still be considered complete if the question is dismissed or unanswered.

Default posting behavior:

- Default to a formal PR review, not a plain PR comment.
- If the final review recommends `REQUEST_CHANGES`, default to request changes.
- If the final review recommends `APPROVE`, default to approval.
- Use a plain PR comment only when the user explicitly asks for a comment or the recommendation is neither approval nor request changes.
- Post the rendered final markdown file, not the body-only draft. The posted body must include the deterministic template preamble and `**Used model:** GPT-5.5`.

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

Use `scripts/pr-watcher.ps1` when the user wants review sessions to start automatically for new GitHub PRs requesting their review. This is the Windows-native watcher: it polls GitHub via `scripts/poll_reviews.py` (`gh search prs --review-requested=@me`, filtered to open, non-draft PRs not yet reviewed at the current head commit SHA), shows a Windows toast notification via `scripts/notify.ps1` for each new/updated PR, and opens a new Windows Terminal tab running `opencode --prompt '/review-pr <PR_URL>'`.

There is no `cmux`/bash watcher bundled with this install — that variant depends on `cmux`, which is Mac/Linux-only. Do not suggest it on Windows.

For verification or troubleshooting requests, inspect `scripts/pr-watcher.ps1` and `scripts/poll_reviews.py` directly and answer from the scripts. Do not start a persistent watcher unless the user asks to start it.

**Required first run:** before starting the watcher for the first time, or any time `.review-poll-state.json` is deleted/reset, run baseline seeding so existing pending-review PRs are recorded as already seen instead of all being launched at once:

```powershell
powershell -ExecutionPolicy Bypass -File ~/.config/opencode/skills/review-pr/scripts/pr-watcher.ps1 -Baseline
```

This marks every currently pending review PR as reviewed at its current head SHA, without opening any terminal tabs or sessions. Only genuinely new PRs, or PRs updated with a new commit after baseline, will trigger a review session once the watcher starts.

Default command (after baseline seeding):

```powershell
powershell -ExecutionPolicy Bypass -File ~/.config/opencode/skills/review-pr/scripts/pr-watcher.ps1
```

Defaults:

- Poll interval: `60` seconds, override with `-PollInterval <seconds>`.
- OpenCode model: `azure/gpt-6.1-sol`, override with `-OpencodeModel <model>`.
- Do not add `--variant` to the watcher's launched command. `opencode run` supports `--variant`, but `opencode [project]`/TUI does not; passing it makes OpenCode print help instead of starting the review.
- Single-cycle mode: pass `-Once` to run one poll cycle and exit instead of looping.
- Baseline mode: pass `-Baseline` to seed existing pending PRs as already-seen without launching any sessions (see "Required first run" above).
- State file (dedup by head SHA): `~/.config/opencode/skills/review-pr/.review-poll-state.json`, managed by `poll_reviews.py`; a PR is marked reviewed (launch time) immediately after its review session is opened, so it will not relaunch until a new commit changes the head SHA.
- Notification: `scripts/notify.ps1 -Title <title> -Message <message>` shows a native WinRT toast. If toast notifications are not appearing (for example due to notification settings or focus-assist), check Windows notification settings for PowerShell/Windows Terminal.
- Requires `wt.exe` (Windows Terminal) on PATH to open review sessions in a new tab; if it's missing, install Windows Terminal or adapt `Start-ReviewSession` in `pr-watcher.ps1` to use a different terminal launcher.

## Failure Handling

- If an artifact helper fails, surface the `gh`, git, or network error exactly enough to diagnose it. Do not review from partial artifacts or manually reconstruct `pr-manifest.json`.
- If GitHub access fails, do not guess from partial artifacts.
- If the latest official checklist cannot be fetched, stop and report the failure instead of producing a checklist-free review.
- If exact CI logs are needed but unavailable, state the narrow CI evidence gap and keep affected claims limited.
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
