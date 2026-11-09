# Design-to-estimate handoff

Use this contract when the user asks for both design and estimation. Omit it for a diagram-only request. Unknown fields are allowed; identify who can resolve them and how they affect scope or sequence.

Record:

- Version/date and evidence reviewed, including each evidence source and its date.
- Requirement/capability IDs, acceptance evidence, and whether scope is proposed, approved, or excluded.
- Output/layer boundaries, owner, producer, consumer, and dependencies.
- For modeled outputs: grain, keys, history/correction behavior, refresh/latency, and security boundary.
- Workstreams, exclusions, shared work counted once, decisions, blockers, and the owner of each decision.
- When relevant, note replay/backfill, late arrivals, revisions/deletes, downstream recomputation, replacement compatibility/history seams, parallel operation/reconciliation, acceptance, cutover/rollback, and post-release support with the owner of each activity.
- Separate per-deliverable DQ/monitoring/tests/deployment from cross-cutting runbooks/alerts/release coordination; assign shared work once.

Keep **scope approval**, **implementation state**, **readiness**, and **estimate confidence** separate. The handoff carries design evidence, not automatic approval or a commitment to deliver.
