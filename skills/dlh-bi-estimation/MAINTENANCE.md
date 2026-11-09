# Maintain the estimation skill

## Source map

- `references/estimation-method.md` distills reusable method from `files/otc/estimation_guide.md` and estimate examples `03`, `09`, `15`, `19`, `20`, and `21`.
- `templates/` contains output formats, the estimate explorer, and a clearly labeled synthetic ledger fixture, not an OTC planning case. The explorer uses the existing OTC estimate presentation's typography, palette, panel, and estimate hierarchy.
- `scripts/validate_estimate.py` checks quantitative/structural consistency with Python's standard library. It does not establish scope, ownership correctness, or estimate quality.
- DSB modeling/layer constraints are packaged in the method reference and grounded in `readme.md`, `checklist.md`, `docs/dimensional-modeling.md`, and `skills/dlh-platform/`.

Installed references do not read source checkouts at runtime. Do not import source-specific dates, owners, controls, or planning totals into defaults.

## Update and verification

1. Update the estimation method, output templates, ledger validation, or trigger descriptions only where the change requires it.
2. From the `skills/dlh-bi-estimation/` folder, run `uv run --no-project python scripts/validate_estimate.py --self-test`, `uv run --no-project python scripts/validate_estimate.py --input templates/estimate-data.json`, and parse all eval JSON files.
3. Default to affected-case SPOT evals, storing partial evidence in `skills/.evals/dlh-bi-estimation/spot-latest/`, separate from any full benchmark.
4. Review arithmetic provenance, scope overlap, owner allocation, alternative compatibility, retained discovery, and separation of readiness/confidence/approval.
5. Ask before pytest. Treat full LLM benchmarks as optional escalation; report checks not run.
6. Refresh source revision notes and install guidance when sources change. Do not edit local/global setup from this package task.

The OTC guide/examples and DSB documentation baseline is `34cf9f0db1d871dc59393dc37590350904840c78`. Lifecycle, transition, and operations prompts use ROS examples pinned to `9e79240c7cb789aae8e301d2e2ff4974764144e4`. New role/capacity, productivity, coordination-allowance, and deadline-scenario prompts draw on the ROS fast-track scenario at `e3b6f1df94f6ed9f0f8ec8a6dfa5e04fc23efda1`. These examples do not establish DSB policy or default values.
