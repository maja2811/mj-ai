# Estimation method

Estimate the BI work that remains between current evidence and accepted outcomes. Keep reusable method separate from DSB project constraints and project-specific facts.

## Evidence and remaining work

Inspect authorized repositories, interfaces, schemas, samples, consumers, owners, requirements, and acceptance evidence before assigning reuse. Classify each capability:

- **Existing/reuse:** verified fit with no change. Show context at zero remaining effort and exclude it from totals.
- **Existing/change:** working capability with a named gap. Estimate the gap, not a rebuild.
- **New:** required capability absent from evidence.
- **Unverified:** existence or fit not confirmed. Estimate discovery; show an implementation allowance only as a separate, clearly conditional scenario when stakeholders need it.

An unmerged proposal or an existing object name is evidence to inspect, not proof of usable production implementation. Cite evidence and date. Unpriced scope stays visible as unpriced, not as zero effort.

## Work breakdown and ownership

Break the estimate into concrete BI tasks/contracts and explain each driver. Include BI source clarification, architecture/model decisions, governance, review/rework, testing, UAT, approvals, deployment, and release where needed. Do not include elapsed waiting or implementation owned by an external team. Record each as a dependency, blocker, or sequence effect.

Estimate shared foundations once. Give each component a stable ID, owner, unique ownership key, status, point hours, conditions, evidence references, and prerequisites. If one task supports several workstreams, assign it to one owner/workstream and reference it elsewhere instead of summing it twice.

## Conditional sizing prompts

Use only prompts that fit the requested scope; do not apply a full delivery checklist to a small change.

- **Data lifecycle:** when relevant, check replay/backfill, late arrivals, revisions/deletes, and downstream recomputation. Clarify unknown behavior and affected data before sizing; do not assume duration or hours.
- **Replacement or migration:** when replacing an existing output or consumer, consider compatibility, the historical seam, parallel operation/reconciliation, acceptance, cutover/rollback, and post-release support. Assign each activity to its actual source, shared, or consumer owner, once.
- **Operations:** include applicable per-deliverable DQ, monitoring, tests, and deployment. Allocate cross-cutting runbooks, shared alerts, and release coordination once to a named owner/component. BI labor remains in the estimate; external-team work and passive elapsed waits remain dependencies.

## Optional delivery planning

Use these only when the user asks for role capacity, productivity assumptions, coordination allowances, or deadline options. They do not add defaults to a basic estimate.

- **Effort and capacity:** show total BI effort separately from who can perform it and when. Moving architecture or review to another role changes the capacity lane, not total labor. Record availability and turnaround as constraints; keep BI work in the estimate and external work or waits as dependencies.
- **Productivity assumptions:** state whether the baseline already assumes AI-assisted delivery. Apply an additional user-selected factor once to its named activity and base. Keep specification/steering, integration, testing, and review visible. Mark an unvalidated adjustment provisional; do not imply a general productivity rate.
- **Coordination allowance:** include only when the user approves it. State the scope and, when supplied, the rate and base. Allocate it once and exclude coordination already priced under architecture, review, or another component. A named allowance is planned effort, not routine uncertainty contingency.
- **Deadline options:** compare full and phased delivery only when requested. List delivered and deferred scope, acceptance gates and owners, fallback, and missing schedule/capacity facts. A phased option retains deferred work in the full-scope view. Do not promise a date or call fallback work free without evidence.

## Scenarios and confidence

- Use one point estimate for each named, bounded scenario. Do not blend materially different outcomes into a range.
- Keep mutually exclusive alternatives separate. A consolidated worst case may combine only compatible options.
- Show discovery and decision effort separately from conditional implementation. No-build removes the implementation only when evidence supports that choice; it does not erase work needed to reach the decision.
- Do not add routine contingency for general uncertainty, normal defects, review, testing, or rework. Include a named, evidence-based contingency only for extra BI work that cannot yet be placed in a component.
- Do not apply a blanket AI productivity discount. Human clarification, governance, review, UAT, and release remain in scope when required.

Give one estimate-confidence score for each workstream or consolidated estimate, with a short evidence-based explanation:

| Score | Meaning |
|---:|---|
| 1 | Provisional point based on sparse evidence or a low-confidence planning assumption |
| 2 | Directional; major scope or contract assumptions remain |
| 3 | Decision-useful; material assumptions remain |
| 4 | Strong evidence bounds the estimate; dependencies mainly affect sequence or acceptance |
| 5 | Confirmed scope, evidence, contracts, and acceptance tightly bound the point |

Confidence does not mean scope approval or implementation readiness. Report those states separately.

## Output order

1. Blockers and owners.
2. Effort/status/driver table, including relevant reusable capabilities and total remaining BI effort.
3. One confidence score and rationale.
4. Material assumptions and what changes if they fail.
5. Dependencies, owners, needed-by point, and sequence effect.
6. Scope, product fit, exclusions, and unpriced gaps.
7. Evidence reviewed and sizing basis.

For a consolidation, show the selected baseline, conditional additions, compatible worst-case combination, and unpriced scope separately. If converting hours to calendar capacity, state productive capacity, concurrent staffing, dependencies, and exclusions. Never present the conversion as a committed date.

## DSB constraints, for DSB work only

- Source Raw preserves received data; Curated stays source-specific except for CF dimensions. Datamarts consume Cleansed, Curated, and CF outputs, not Raw or other Datamarts. A single-source Datamart is valid when justified.
- Curated and Datamart use a star by default. Establish fact grain; dimensions have a single-column key, and facts referencing SCD Type 2 dimensions use their historical surrogate key. Facts normally use Type 1.
- Check DSB's current platform docs and load `dlh-platform` when available; these are not generic rules for other organizations.
