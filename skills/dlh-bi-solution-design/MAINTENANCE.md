# Maintain the design skill

The package separates reusable method from DSB platform rules and project examples. Keep future changes in those boundaries.

## Source map

- `references/design-method.md`: distilled from `files/otc/solution_design.html`, `files/otc/estimation_guide.md`, and DSB's current checklist/modeling guidance.
- `references/visual-system.md` and the HTML templates: presentation CSS/layout and color tokens come from `files/otc/presentation/index.html`; `files/otc/solution_design.html` supplies story/flow semantics only. Logo provenance follows `files/otc/presentation/brand-spec.md`.
- `references/handoff-contract.md`: shared design/estimate handoff, distilled from the estimate guide and solution-design example.
- The new PM decision brief draws on the ROS PM note, and optional delivery-planning prompts draw on its fast-track scenario at `bi-incubator/designs/2026-008-ros-stog-onboarding/estimates/`, pinned to `e3b6f1df94f6ed9f0f8ec8a6dfa5e04fc23efda1`. These examples do not set DSB policy.
- DSB modeling guardrails: `readme.md`, `checklist.md`, `docs/dimensional-modeling.md`, and `skills/dlh-platform/`.

Installed references do not read the source checkout at runtime. The packaged logo's source and retrieval date are in `assets/README.md`.

## Change and verification

1. Update the canonical package reference or template; keep the HTML/CSS grounded in the existing OTC visual system.
2. Keep DSB rules labeled as DSB-only. Check source documentation before changing those rules; do not edit platform policy as part of a skill-only change.
3. Keep eval prompts generic, with no OTC identifiers, exact owner names, dates, hours, or planning controls. Update expected behavior and triggers when routing changes.
4. Default to affected-case SPOT evals, storing partial evidence in `skills/.evals/dlh-bi-solution-design/spot-latest/`, separate from full benchmarks. Ask before pytest; treat full LLM runs, browser rendering, print review, and fresh-session discovery as optional checks and report any not run.
5. Update the repository's entry-point links only if discovery needs them. Installation/configuration remains the recipient's responsibility.

The OTC/DSB source baseline is `34cf9f0db1d871dc59393dc37590350904840c78`. Previously extracted shared-handoff lifecycle, transition, and operations prompts draw on ROS examples pinned to `9e79240c7cb789aae8e301d2e2ff4974764144e4`. Refresh the bundled guidance when its sources change.
