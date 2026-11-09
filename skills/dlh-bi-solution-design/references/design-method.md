# Design method

Use the smallest design that answers the request. Keep reusable method separate from DSB policy and project evidence.

## High-level solution

1. State purpose, measurable success, scope, exclusions, users, and affected products.
2. Inspect authorized requirements and existing assets. Cite each source and date; mark gaps.
3. Map each requirement to an output, owner, acceptance evidence, and scope status. A tag or candidate list does not approve work.
4. Draw producer-to-consumer flows, boundaries, data layers, contracts, and cross-team dependencies. Identify who owns each transformation and handoff.
5. Compare reuse and alternatives. Name the decision, decision owner, evidence needed, and effect if unresolved.
6. Review quality, access/security, history/corrections, latency, volume, operations, deployment, and consumer acceptance at the level the project needs.
7. Show the first end-to-end slice and the review or decision that should happen next.

Include business clarification, governance, design review, testing, UAT, and release when they affect the design. External-team work and elapsed waiting are dependencies, not BI-owned implementation.

## Focused fact/dimension star

1. Name the business process and write the fact grain as one row per event/state/period at a stated level of detail.
2. Identify dimensions used to filter/group the fact and measures that can be aggregated at that grain.
3. Show each dimension's single-column primary key, each corresponding fact foreign key, and the dimension-to-fact 1:N relationship. Use clear relationship labels; do not depend on color alone.
4. Label every field as observed, proposed, or unknown. Show the grain and important assumptions beside the diagram.
5. Add historical surrogate keys, role-playing dates, shared/conformed dimensions, or bridge tables only where a stated requirement needs them.

DSB alignment for DSB work only:

- Curated and Datamart models use a star by default. Define the fact grain first. Use a single-column dimension key; when a dimension is SCD Type 2, the fact references its surrogate key so it points to the correct historical version. Facts normally use Type 1.
- Curated remains source-specific except for references to shared CF dimensions. Datamarts may combine appropriate Cleansed, Curated, and CF outputs; they do not consume Raw or other datamarts. Single-source Datamarts can be valid when justified.
- Requirements come from the current DSB `readme.md`, `checklist.md`, and `docs/dimensional-modeling.md`. Treat those platform rules as DSB-specific rather than general modeling claims.

## Evidence and status

Use distinct labels for **confirmed**, **proposed**, **unknown**, and **decision needed**. Keep business scope approval separate from implementation status, delivery readiness, and estimate confidence. Do not convert a missing field, owner, source contract, or acceptance rule into a fact.

## PM decision brief

Use `templates/pm-decision-brief.md` only when requested. Summarize the decision, recommendation and basis, delivered/deferred scope, conditions, decision owners, fallback, and next step. State effort or dates only when the user supplies evidence; mark gaps plainly. A decision-only note needs no diagram, estimate, or broad interview. Keep a focused star to its diagram and brief grain/key/measure note unless the user asks for more.
