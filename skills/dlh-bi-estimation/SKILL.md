---
name: dlh-bi-estimation
description: "Estimate remaining BI delivery effort, compare explicit scope scenarios, or consolidate workstream estimates. Use for BI person-hour sizing, reuse/gap analysis, conditional adders, confidence, or estimate arithmetic. Do not trigger for invoice arithmetic or unrelated forecasting."
---

# BI estimation

Estimate BI work that remains, using the evidence the user authorizes. This package works on its own; when `dlh-bi-solution-design` is installed, use its `references/handoff-contract.md` as the shared design-to-estimate handoff. If it is not installed, collect only the relevant inputs and mark unknowns. Missing information does not require a full design interview.

## Method

1. Read current evidence and inspect reuse only within authorized scope. Distinguish **Existing/reuse**, **Existing/change**, **New**, and **Unverified**. Credit proven reuse; estimate only the remaining change. Do not infer implementation from an unmerged proposal or a name/tag.
2. Decompose remaining BI work by deliverable, contract, complexity, owner, prerequisite, evidence reference, and scenario. Include BI clarification, governance, design/review/rework, testing, UAT, and release. Exclude passive waiting and external-team implementation; show those as blockers/dependencies. Use optional delivery-planning prompts from the reference only when requested.
3. Allocate shared work once using a unique ownership key. Preserve discovery/decision effort when a conditional implementation is removed.
4. Use one point estimate per defined scenario. Separate materially different alternatives and compatible adders. Do not add conflicting options together, duplicate scope, apply a blanket AI discount, or add routine percentage contingency. Price a named contingency only when a specific unplaced BI risk justifies it.
5. Keep scope approval, implementation state, readiness, and estimate confidence distinct. Give one overall confidence score (1-5) and a short evidence-based rationale. Unknowns lower confidence or create discovery; they do not silently become committed scope.
6. Consolidate only compatible selected scenarios. Report baseline, conditional additions, compatible worst case, and unpriced gaps separately. Any capacity conversion must state its assumptions and is not a delivery-date promise.

## Output and ledger

Read `references/estimation-method.md`, then use `templates/workstream-estimate.md`, `templates/consolidated-estimate.md`, and `templates/estimate-data.json`. Put blockers first, then effort/status/driver table, confidence, assumptions, dependencies/owners, scope/product fit, and evidence.

`estimate-data.json` is the only quantitative ledger. Keep component IDs, owner/ownership key, hours, status, conditions, references, prerequisites, and scenarios there. The explorer derives totals, shares, component details, and scenario comparisons from that ledger; do not type the same figures into separate summary/detail/scenario blocks. When embedding data in HTML, replace `<` with `\\u003c` before putting the JSON in a script element. The explorer displays estimates; it does not generate or validate sizing judgment.

Use `scripts/validate_estimate.py --self-test` and `scripts/validate_estimate.py --input <estimate-data.json>` for the standard-library checks. A passing ledger check verifies arithmetic and structural consistency, not whether the work is correctly sized or semantically non-overlapping.

Do not set default hours, hourly rates, owners, controls, dates, or scope from the OTC examples. Treat any synthetic fixture as a validation example, replace it with evidence before use, and never claim a work estimate is approved or ready from arithmetic alone.

## Writing

Use concise, factual output. State assumptions and decisions plainly; avoid filler and invented statistics. Use Stop Slop for a final prose pass when available; it is optional.
