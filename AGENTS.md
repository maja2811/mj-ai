# Global Agent Instructions - DSB Data Lakehouse

These instructions are the default baseline for DSB Data Lakehouse repositories (`bi-dlh-*`).
Repo-local `AGENTS.md` files are more specific and override this file when present.

## Non-Negotiables

- Stay within the current `bi-dlh-*` project tree unless the user explicitly expands scope. The normal exceptions are explicitly named source-of-truth repositories such as `bi-dlh-documentation`, `bi-dlh-helper`, and `bi-dlh-project-template`.
- In Databricks workspace contexts, never inspect sibling projects or other users' `/Users/...` or `/Repos/...` directories unless explicitly requested.
- If required information is unavailable inside the allowed scope, say what was checked. Only widen scope after explicit user approval.
- Prefer verified sources over assumptions. If a required source, environment check, private feed, or skill-sync step is blocked, state the blocker and use the best verified fallback.
- For helper/domain work, load and use the relevant `dlh-*` skill before relying on generic knowledge. If the skill is missing or unreadable, try the current-tool sync path before falling back to installed or version-matched helper source.

## Governance & Review

Before writing or reviewing code, read the relevant development checklist and docs.
The authoritative company source is `DanskeStatsbaner/bi-dlh-documentation` on `main`.
Repo-local `checklist.md` files should still be read when present, but treat them as potentially stale if they conflict with the documentation repo or current helper guidance.

For deeper context on best practices, naming, architecture, and operational guidelines,
consult the shared documentation repo:
[bi-dlh-documentation](https://github.com/DanskeStatsbaner/bi-dlh-documentation).
Start from `readme.md` and `checklist.md`, then follow task-relevant links such as
`best-practices.md`, `monitoring.md`, `data-quality.md`, and `databricks-jobs.md`.
When reading private GitHub docs with `gh api`, request decoded readable file content, not raw `contents` JSON unless metadata is explicitly needed.

## Architecture

- Medallion architecture: raw -> cleansed -> curated (-> datamart where applicable).
- No transforms in raw — raw stores data exactly as received from source.
- DRY: reusable logic goes in shared modules or the `dlh-dmt-helper` package.
- For usage examples and API reference for `dlh-dmt-helper`, consult:
  [bi-dlh-helper](https://github.com/DanskeStatsbaner/bi-dlh-helper).
- Delta best practices: merge/upsert over truncate-and-load; no row-by-row Python loops.
- No hardcoded secrets — use Key Vault and environment variables.
- For data quality, prefer DQX-backed `dlh_dmt_helper.data_quality.dq_check()` and DQX YAML files. Do not introduce legacy `check()` / `NamedDataFrame` patterns unless maintaining existing code that has not migrated yet.

## Helper Version & Skills

- All DSB Databricks Delta Lake projects must use `dlh-dmt-helper` when it covers the task.
- Project pin source: prefer `adb/requirements.txt`; otherwise use top-level `requirements.txt`.
- Keep code compatible with the pinned helper version unless the user explicitly asks to upgrade.
- For runtime-sensitive helper work, compare the pinned helper version with the installed runtime version using `importlib.metadata.version("dlh-dmt-helper")`; do not rely on `dlh_dmt_helper.__version__`.
- Use version-matched helper source/docs when exact behavior matters. Prefer helper Git tags over `main`; use `main` only for unreleased work or when no matching tag exists and state that limitation.
- Latest-version and changelog checks must come from the private package feed or `DanskeStatsbaner/bi-dlh-helper`, not public package indexes or mirrors.
- If the private feed or helper repo is blocked, report the blocker and do not substitute unverified public metadata.
- Packaged/native `dlh-*` skills exist in `dlh-dmt-helper` 13.5.0 and newer. For older pins, inspect installed or version-matched helper source instead of trusting existing synced skills.

### Skill Routing

| When the task involves | Use skill |
|---|---|
| Delta tables, CRUD, merge, CDC ingestion, SCD Type 2, deletes, synchronization, replay, diagnostics, transform pipelines, metrics, Delta maintenance | `dlh-tables` |
| Databricks widgets, deduplication, primary/foreign keys, clustering, metadata.yml generation, table conversion, Spark utility helpers | `dlh-common-functions` |
| DQX-backed data quality checks, result persistence, governance categorization | `dlh-data-quality` |
| Structured logging, notebook-safe logs, Loki/Humio integration, module-level log control, flushing, redaction, domain exceptions | `dlh-monitoring` |
| Databricks job metadata, run registration, trigger-table workflows, dependent job execution | `dlh-databricks-jobs` |
| Governed CSV ingestion from volumes, volume creation, schema enforcement, snake_case normalization, audit columns, GDE SCD2 behavior | `dlh-gde` |
| LLM calls through Databricks serving endpoints or Unity Catalog metadata generation | `dlh-ai` |

If a task spans domains, read all relevant skills.

### Skill Discovery

- Prefer the project's `.opencode/skills/` copies when present. They are synced from the project's pinned `dlh-dmt-helper` version and are the authoritative helper guidance for that project.
- If a required `dlh-*` skill is not available in the project, use the globally available linked skill as a fallback and verify the project's helper pin before relying on version-sensitive behavior.
- If neither copy is available, run `sync_opencode_skills()` after the project environment is installed and `dlh_dmt_helper` imports successfully. Do not invent helper APIs while skill sync is unavailable.
- `dlh-platform` is global documentation guidance. Use it for DSB-specific conventions when no project-local equivalent is available.

### General Style Defaults

- For coding, refactoring, debugging, and review tasks, use the `ponytail` skill at `full` by default. Prefer the smallest correct change, reuse existing code, and avoid speculative abstractions while preserving validation, security, error handling, accessibility, and required tests.
- Use normal, clear prose by default.
- Do not apply `ponytail` to non-coding tasks.
- Honor explicit user overrides such as `ponytail ultra`, `ponytail off`, or `normal mode` for the current session.

### Default Development Workflow

For coding, debugging, refactoring, and review tasks, use this default lifecycle. Keep it lightweight; skip a separate plan for trivial changes.

1. **Explore** — Understand the task before acting. Inspect the relevant repository or files, documentation, dependencies, external systems, constraints, and existing behavior as needed. Load applicable domain skills before relying on generic knowledge. Search narrowly and stop when the problem and change boundary are understood.
2. **Plan** — Create and refine a plan before editing or executing. State the root cause or intended behavior, smallest viable approach, affected surfaces, acceptance criteria, and validation scope. Surface uncertainty before implementation.
3. **Implement** — Make the smallest correct diff on the current branch. Reuse existing helpers and patterns. Do not add role-play agents or abstractions unless they provide a concrete capability, permission boundary, independent context, or parallelism benefit.
4. **Test** — Run the smallest relevant validation first, then broader checks when justified. Ask the user which pytest scope to run before executing pytest. Report skipped checks and blockers explicitly.
5. **Review and iterate** — Inspect the diff and validation results, correct issues, and repeat the relevant checks before considering the task complete.

Subagents are optional. Use them when work is genuinely independent or benefits from isolation, such as parallel repository exploration, research, test design, or an independent review. Prefer one primary agent for sequential work. Give each subagent a narrow objective, the required file paths and constraints, and ask for concise evidence-based output; the primary agent owns synthesis, edits, and final verification.

Use the `review-local` skill only as a final review/validation step after implementation and tests, not as a replacement for understanding, planning, or implementation. Always ask the user whether to run `review-local` before invoking it; never start it implicitly.

This workflow follows the general approach documented for GitHub Copilot cloud agent: research first, create/refine a plan, implement, inspect the result, and iterate before delivery. The local `Explore -> Plan -> Implement -> Test/Review -> Iterate` sequence makes validation explicit without requiring every task to be repository work or to end in a pull request. See [Research, plan, and iterate on code changes](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/research-plan-iterate).

### Planning And Audit Modes

- Use the `improve` skill for read-only repository audits, prioritized improvement findings, roadmap work, or self-contained implementation plans. It may write only under `plans/` or `advisor-plans/`; it does not implement source changes.
- Use the normal workflow for direct implementation requests. Do not invoke `improve` as a substitute for implementation unless the user explicitly asks for a plan or audit.
- When delegating a plan, treat the executor's diff as untrusted until the primary agent checks scope, tests, and acceptance criteria.

### Skill Sync And Fallback

Use only the sync helper that matches the current tool/environment:

```python
from dlh_dmt_helper.skills.genie import sync_genie_skills
from dlh_dmt_helper.skills.github_copilot import sync_github_copilot_skills
from dlh_dmt_helper.skills.opencode import sync_opencode_skills
from dlh_dmt_helper.skills.project import sync_project_agents_file
```

- In OpenCode helper workflows, run `sync_opencode_skills()` after the repo environment is synced and helper import works, before relying on runtime-sensitive helper API guidance.
- If sync cannot run because auth, environment setup, or package import is blocked, say so and fall back to pinned requirements plus installed or version-matched source/docs.
- If native skill files cannot be used but the package can be imported, read packaged skill content with `list_skill_names()`, `read_skill()`, and `read_skill_reference()` from `dlh_dmt_helper.skills`.

## Querying Databricks

- **Use the Databricks CLI** for SQL queries. The official `databricks-core` skill
  (from [databricks-agent-skills](https://github.com/databricks/databricks-agent-skills))
  provides the recommended commands:
  ```sh
  # Run ad-hoc SQL queries
  databricks experimental aitools tools query "SELECT * FROM table LIMIT 10" --profile <PROFILE>

  # Discover table structure (columns, types, sample data)
  databricks experimental aitools tools discover-schema catalog.schema.table --profile <PROFILE>

  # Find the default warehouse
  databricks experimental aitools tools get-default-warehouse --profile <PROFILE>
  ```
  Never use raw `databricks api post` calls to the SQL Statement Execution API.
- **DSB workspace profiles** (in `~/.databrickscfg`):

  | Profile      | Workspace                                    | Usage              |
  |--------------|----------------------------------------------|--------------------|
  | `rejseplan`  | `adb-2848871633622482.2.azuredatabricks.net`  | Rejseplan datamart |
  | `spassenger` | `adb-3304658076883586.6.azuredatabricks.net`  | S-passenger source |
  | `DEFAULT`    | `adb-3304658076883586.6.azuredatabricks.net`  | Default workspace  |

  Always ask the user which profile to use. Never auto-select.
- **Unity Catalog naming**: Tables are fully qualified as
  `datamart_{env}.{project}_product.{table}` (e.g., `datamart_prd.rejseplan_product.helrejse`).
  Source repos use `{source}_{env}.{project}_cleansed.{table}` or `_raw` schemas.
  Never guess table paths like `{project}.curated.{table}` — always check the codebase
  (`spark.catalog.setCurrentCatalog(...)` / `spark.catalog.setCurrentDatabase(...)` calls)
  if unsure.
- **Query vs Genie**: Use direct SQL queries for quick checks (counts, schema inspection,
  spot-checking records, testing joins). Switch to the **genie** skill for extended
  investigations requiring 4+ queries, root-cause analysis across multiple tables,
  or exploratory analysis.

## Tooling

- Package manager: **uv** (not pip). Always use `uv run` to execute tools.
- Linter/formatter: **Ruff**. Type checker: **mypy**.
- CI/CD: Azure DevOps. Pipelines in `ci_cd/`.
- Notebooks are `.py` files with `# Databricks notebook source` header and `# COMMAND ----------` cell separators. NOT `.ipynb`.

## Code Style

### Imports

Ruff enforces isort ordering (`I` rule). Three groups separated by blank lines:

```python
# 1. Standard library
import os
from typing import Any

# 2. Third-party
from pyspark.sql import functions as F
from dlh_dmt_helper.monitoring import CustomException, logger

# 3. Local (absolute from adb/, never relative)
from raw.utils import SomeModule
```

- Always alias: `from pyspark.sql import functions as F`
- No relative imports (`from .foo`). Use absolute paths rooted at `adb/`.

### Formatting

- Ruff formatter on save; line length is not capped (E501 is ignored).
- Indentation: 4 spaces, no tabs.

### Type Annotations

- Use modern Python 3.12+ syntax: `str | None`, `dict[str, Any]`, `list[int]`.
- Avoid `typing.Dict`, `typing.List` etc. in new code.
- All functions must have return type annotations, including `-> None`.

### Naming Conventions

- Functions, variables, constants: `snake_case` (constants are NOT UPPER_CASE).
- Classes: `PascalCase`.
- Private/internal helpers: leading underscore (`_helper_func`).
- Files/notebooks: `snake_case.py`.
- Tables: lowercase with underscores. Prefixes: `dim_`, `fact_`, `dm_` in curated.

### Docstrings

Google style. Every public function gets a docstring with `Args:`, `Returns:`, `Raises:` sections as appropriate. Every test function gets a one-line docstring.

### Error Handling

- Use `CustomException` from `dlh_dmt_helper.monitoring` for domain errors.
- Chain exceptions: `raise CustomException(...) from e`.
- Guard clauses with early `raise` for preconditions.
- Use `# noqa: BLE001` when catching broad `Exception` intentionally.
- Never silently swallow exceptions.

### Logging

- Use `logger` from `dlh_dmt_helper.monitoring` — never `print()` or stdlib `logging`.
- Use `loki=False` for debug/sensitive output not meant for centralized logging (`humio` is deprecated and defaults to `False`).
- Wrap f-strings containing dicts/JSON with `escape_curly_braces()` before passing to logger.

### PySpark Patterns

- Always `from pyspark.sql import functions as F`, then `F.col()`, `F.lit()`, etc.
- Method chaining for DataFrame transforms.
- Use `DeltaTableManager` and `read_change_data()` from `dlh_dmt_helper` for Delta operations.
- Environment variables via `os.environ["KEY"]` (fail-fast) or `os.environ.get("KEY", "default")`.
- Suppress type checker on Databricks globals: `dbutils.notebook.exit("msg")  # type: ignore`

### Tests

- File naming: `test_{module_name}.py` in `adb/tests/`.
- Group related tests in classes (`class TestFetchData:`).
- Tests annotate `-> None`.
- Use `pytest.fixture`, `monkeypatch`, `MagicMock`, `tmp_path`.
- Plain `assert` with descriptive messages: `assert len(data) == 2, "Should return two items"`
- Tests must be fully mocked — no live API or Databricks calls.

## Dependencies

- `adb/requirements.txt` is the **source of truth** for CI/CD runtime dependencies.
- `pyproject.toml` `[dependency-groups] dev` mirrors it for local dev. Update requirements.txt first.
- `dlh-dmt-helper` is pinned to the private Azure DevOps feed to prevent dependency confusion.
- PySpark is overridden to never install (databricks-connect bundles its own).
- **Installing dependencies in project repos** (`bi-dlh-src-*`, `bi-dlh-datamart-*`): Use the VS Code task **Install Dependencies** (Ctrl+Shift+P > Tasks: Run Task) instead of bare `uv sync`. This task handles PyPI token setup for the private Azure DevOps feed. In the helper repo (`bi-dlh-helper`), plain `uv sync` works.

## Shared CI/CD & Project Infrastructure

The shared CI/CD repo [bi-dlh-dmt-ci-cd](https://github.com/DanskeStatsbaner/bi-dlh-dmt-ci-cd)
drives all deployment pipelines. Be aware of its expectations:

- **`ci_cd/adb_vars_{dev,uat,prd}.yml`**: Per-environment variables consumed by the
  deployer (`adb_deploy.py`). Key flags include `deploy_jobs`, `deploy_schemas`,
  `delete_missing_jobs`. Removing a job YAML from `adb/jobs/` does NOT delete it
  from Databricks unless `delete_missing_jobs: true` is set in these files.
- **`project_setup/project_config.yml`**: Defines cluster runtime version, node types,
  storage containers, and warehouse config. The `spark_version` here is the
  source of truth for which Databricks Runtime the project targets.
- **`pyproject.toml`**: The `databricks-connect` version MUST match the
  `spark_version` from `project_config.yml` (e.g., runtime `15.4.x` →
  `databricks-connect==15.4.*`, runtime `17.3.x` → `databricks-connect==17.3.*`).
  The `[dependency-groups] dev` section must mirror `adb/requirements.txt`.
- When bumping `dlh-dmt-helper`, always check the
  [CHANGELOG](https://github.com/DanskeStatsbaner/bi-dlh-helper/blob/main/CHANGELOG.md)
  for breaking API changes and behavioral changes (e.g., logger `humio` defaults).

For the full local development environment setup (VS Code config, `pyproject.toml`
structure, UV index configuration, `.vscode/` tasks and settings), refer to
[vscode-dev-setup.md](https://github.com/DanskeStatsbaner/bi-dlh-documentation/blob/main/docs/vscode-dev-setup.md)
in the shared documentation repo. Older projects may be missing `pyproject.toml`,
`.vscode/`, etc. — copy them from the
[bi-dlh-project-template](https://github.com/DanskeStatsbaner/bi-dlh-project-template)
and adapt to the project (see the setup doc for details). Use
[bi-dlh-src-commercial-spassenger](https://github.com/DanskeStatsbaner/bi-dlh-src-commercial-spassenger)
as the up-to-date reference implementation.

## Pre-push Validation

Before pushing, run linting, formatting, type checking, and an agreed test scope.
The target path for ruff depends on the repo structure:

- If an `adb/` directory exists (source/datamart repos): use `adb/` as the target.
- Otherwise (e.g., `bi-dlh-helper`): use `.` as the target.

Check first, then run the non-test validation commands. Ask the user which pytest scope to run before executing pytest.
```sh
# Source/datamart repos (adb/ exists):
uv run ruff check adb/ && uv run ruff format --check adb/ && uv run mypy

# Library/helper repos (no adb/):
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

## Running Tests

**Always ask the user which test suite(s) to run before executing pytest.**
Never run the full test suite (`uv run python -m pytest`) without confirmation.
Present the available test directories/files and let the user choose, e.g.:
- A specific test file (`tests/ai/test_metadata.py`)
- A specific test directory (`tests/data_quality/`)
- A specific test class or function (`tests/ai/test_metadata.py::TestClassName::test_name`)
- The full suite (only if explicitly confirmed)

This avoids long-running or unnecessary test runs.

## Windows Reserved Filenames

This project runs on Windows. **Never create files named after Windows reserved device
names**: `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9` (case-insensitive,
with or without extensions). Writing to these names does not create a normal file — it
routes to a system device or creates an undeletable ghost file. Use platform-safe names
only. If you need a null/discard target, avoid file paths entirely (e.g., redirect output
in code rather than writing to a `nul` file).

## Self-Improvement

After completing a task or encountering an unexpected issue (e.g., wrong paths, missing
conventions, repeated mistakes), reflect on whether the lesson learned would be valuable
to capture in this `AGENTS.md` file. If so, **ask the user before making changes** —
never update `AGENTS.md` without explicit approval.
