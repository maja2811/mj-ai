# [Project] BI solution design

- **Version/date:** [version] / [date]
- **Evidence reviewed through:** [date]
- **Audience:** [decision-makers and delivery owners]
- **Depth / format:** [overview, focused star, combined] / [diagram, short document, deck, explorer]

## Purpose and success

- Business outcome: [outcome]
- Success / acceptance evidence: [measurable result]
- Users and consumers: [roles or products]

## Scope

| Requirement ID | Requirement / capability | Output | Owner | Acceptance evidence | Scope status |
|---|---|---|---|---|---|
| [REQ-01] | [need] | [output] | [owner] | [evidence] | [proposed / approved / excluded] |

## Architecture and contracts

| Producer | Flow / transformation | Contract or output | Consumer | Owner | Dependency / status |
|---|---|---|---|---|---|
| [producer] | [flow] | [grain, keys, history, refresh] | [consumer] | [owner] | [dependency / confirmed / unknown] |

## Model, when needed

- Business process and fact grain: [one row represents …]
- Fact keys and measures: [foreign keys and aggregations]
- Dimensions and single-column keys: [dimension list]
- History, role-playing dates, shared dimensions or bridges: [only if required]
- Proposed fields / unresolved assumptions: [list]

## Quality, security, operations

- Data quality and reconciliation: [checks, owners, accepted differences]
- Access / classification / privacy: [boundary and decision owner]
- History, corrections, latency, volume, and refresh: [requirements]
- Monitoring, recovery, deployment, and support: [operational ownership]

## Decisions, blockers, and next slice

| Decision / blocker | Owner | Evidence needed | Effect if unresolved | Due / status |
|---|---|---|---|---|
| [decision] | [owner] | [evidence] | [scope or sequence effect] | [date/status] |

- **First vertical slice:** [producer → accepted output → consumer]
- **Reviewers:** [PM, architect, owners, users]
- **Exclusions:** [explicit list]

Keep scope approval, implementation state, readiness, and estimate confidence separate. Do not fill unknowns with guessed project facts.
