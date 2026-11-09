---
name: dlh-bi-solution-design
description: "Shape a BI solution design, architecture view, or focused fact-and-dimension star for a data project. Use for high-level solution design, data flows, ownership/contracts, or star-schema modeling. A focused star request returns one star and a brief grain/key/measure note, not a deck or estimate."
---

# BI solution design

Use this skill for a BI architecture/design request, or a focused fact-and-dimension model. The method and templates in this package work without this repository; DSB-specific guardrails below are explicitly scoped to DSB projects.

## Choose the depth first

- **High-level solution:** scope, flows, boundaries, contracts, owners, dependencies, decisions, and a first useful slice.
- **Focused star:** one business process and fact grain, its dimensions, keys, relationships, relevant measures, and assumptions. Return just the star and a short note. Do not create a deck, conduct a broad project interview, or estimate effort unless asked.
- **Combined design:** include both views and only the implementation/model details the project needs.

Choose the format separately: diagram, short document, deck, or explorer. Start with the user's requested depth and format; ask only questions that could change the design. Mark unresolved details as proposed or unknown instead of blocking a useful draft.

## Work

1. Read only authorized requirements, current assets, and evidence. Record sources and evidence date; do not infer scope approval from a tag or diagram.
2. Map requirement IDs to outputs, acceptance, owner, and status. Separate confirmed scope, proposed design, open decisions, and exclusions.
3. For a solution overview, show source and consumer boundaries, data flows, layers where applicable, contracts, ownership, quality/security/history/latency/operations concerns, dependencies, and decisions. Distinguish data/model flows from reconciliation or other control paths with both line style and labels.
4. For a star, define grain before fields. Mark unverified fields as proposed. Give each dimension a single-column key, identify the fact foreign key, show dimension-to-fact 1:N relationships, and list only useful measures. Add SCD2 historical-key behavior, role-playing dates, conformed dimensions, or a bridge only when the requirements need them. Keep the result a star, not an enterprise ERD.
5. Show the first reviewable vertical slice, acceptance evidence, and decisions needed from the PM, architect, owners, or users.

For DSB projects, respect the bundled rules in `references/design-method.md`; load `dlh-platform` when available for current platform-specific decisions. Do not claim that these DSB rules apply to other platforms.

## Templates and style

- Start from `templates/design-brief.md` for a written brief.
- Use `templates/pm-decision-brief.md` only when the user asks for a concise PM decision note. Do not add a diagram or estimate unless requested.
- Use `templates/solution-design.html` for an overview and `templates/star-schema.html` for a standalone star. Both use the existing estimate presentation's typography, panels, colors, and layout with generic content slots; the older solution-design HTML informs story and flow semantics only.
- Use the estimate explorer supplied by `dlh-bi-estimation` only when an estimate is supplied. Estimation remains owned by that skill.
- Read `references/visual-system.md` before changing layout or styling. Keep the existing look; redesign only when the user asks.
- Read `references/handoff-contract.md` when design and estimation share a scope. A diagram-only request does not need the full handoff.

Never invent owners, architecture, fields, acceptance, or approval. Do not treat this package's synthetic fixtures as project defaults. Do not inspect external workbooks or projects unless the user authorizes that access.

Write concise, factual labels and notes. Name assumptions and decisions; avoid filler and invented statistics. Use Stop Slop for a final prose pass when available; it is optional.
