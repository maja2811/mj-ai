---
name: "dlh-dev-conventions"
description: "Local development conventions for DSB Data Lakehouse (bi-dlh-*) repositories: Python/SQL code style, imports, type hints, docstrings, naming, error handling, logging, PySpark patterns, pytest layout, uv/Ruff/mypy tooling, pre-push validation commands, dependency and requirements.txt/pyproject.toml rules, dlh-dmt-helper version pinning and feed rules, databricks-connect version matching, ci_cd/adb_vars_*.yml and project_config.yml expectations, Databricks CLI profiles, and Unity Catalog table-path resolution. Load when writing, editing, reviewing, or validating code in a bi-dlh-* repo, when running lint/type/test checks, when changing dependencies or the helper pin, when changing CI/CD config, or when querying Databricks from the CLI."
metadata:
  version: "1.0.0"
---

# DLH Development Conventions

Local, machine- and repo-level conventions for `bi-dlh-*` work.

For DSB **organisational** conventions — catalog/schema naming patterns, AD groups,
Unity Catalog permissions, SCD/Kimball modelling rules, job YAML placement, the
11-phase project lifecycle, deviation sign-off — use the `dlh-platform` skill instead.
This skill covers how code is written and validated on this machine; `dlh-platform`
covers what the platform requires.

## Architecture

- Medallion architecture: raw -> cleansed -> curated (-> datamart where applicable).
- No transforms in raw — raw stores data exactly as received from source.
- DRY: reusable logic goes in shared modules or the `dlh-dmt-helper` package.
- Delta best practices: merge/upsert over truncate-and-load; no row-by-row Python loops.
- No hardcoded secrets — use Key Vault and environment variables.
- For data quality, prefer DQX-backed `dlh_dmt_helper.data_quality.dq_check()` and DQX
  YAML files. Do not introduce legacy `check()` / `NamedDataFrame` patterns unless
  maintaining existing code that has not migrated yet.

## Querying Databricks

Use the Databricks CLI for SQL queries. The `databricks-core` skill provides the
recommended commands:

```sh
# Run ad-hoc SQL queries
databricks experimental aitools tools query "SELECT * FROM table LIMIT 10" --profile <PROFILE>

# Discover table structure (columns, types, sample data)
databricks experimental aitools tools discover-schema catalog.schema.table --profile <PROFILE>

# Find the default warehouse
databricks experimental aitools tools get-default-warehouse --profile <PROFILE>
```

Never use raw `databricks api post` calls to the SQL Statement Execution API.

Databricks skills are managed by the CLI, not hand-copied:
`databricks aitools list` / `install --skills <name> --agents opencode` / `update`.

### Workspace profiles

A profile selects a workspace, not a cluster. `~/.databrickscfg` is the source of truth —
list them with `databricks auth profiles` instead of trusting a copied table. Names encode
purpose (`commercial-dev`, `datamart-prd`, `commercial-prd`).

Default to `commercial-dev`, but confirm with the user before any Databricks command and
never auto-select a `*-prd` profile.

### Unity Catalog naming

Tables are fully qualified as `datamart_{env}.{project}_product.{table}`
(e.g. `datamart_prd.rejseplan_product.helrejse`). Source repos use
`{source}_{env}.{project}_cleansed.{table}` or `_raw` schemas.

Never guess table paths like `{project}.curated.{table}` — check the codebase
(`spark.catalog.setCurrentCatalog(...)` / `spark.catalog.setCurrentDatabase(...)` calls)
if unsure.

### Query vs Genie

Use direct SQL queries for quick checks (counts, schema inspection, spot-checking
records, testing joins). Switch to the `genie` skill for extended investigations
requiring 4+ queries, root-cause analysis across multiple tables, or exploratory analysis.

## Tooling

- Package manager: **uv** (not pip). Always use `uv run` to execute tools.
- Linter/formatter: **Ruff**. Type checker: **mypy**.
- CI/CD: Azure DevOps. Pipelines in `ci_cd/`.
- Notebooks are `.py` files with a `# Databricks notebook source` header and
  `# COMMAND ----------` cell separators. NOT `.ipynb`.

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

### Type annotations

- Use modern Python 3.12+ syntax: `str | None`, `dict[str, Any]`, `list[int]`.
- Avoid `typing.Dict`, `typing.List` etc. in new code.
- All functions must have return type annotations, including `-> None`.

### Naming

- Functions, variables, constants: `snake_case` (constants are NOT UPPER_CASE).
- Classes: `PascalCase`.
- Private/internal helpers: leading underscore (`_helper_func`).
- Files/notebooks: `snake_case.py`.
- Tables: lowercase with underscores. Prefixes: `dim_`, `fact_`, `dm_` in curated.

### Docstrings

Google style. Every public function gets a docstring with `Args:`, `Returns:`,
`Raises:` sections as appropriate. Every test function gets a one-line docstring.

### Error handling

- Use `CustomException` from `dlh_dmt_helper.monitoring` for domain errors.
- Chain exceptions: `raise CustomException(...) from e`.
- Guard clauses with early `raise` for preconditions.
- Use `# noqa: BLE001` when catching broad `Exception` intentionally.
- Never silently swallow exceptions.

### Logging

- Use `logger` from `dlh_dmt_helper.monitoring` — never `print()` or stdlib `logging`.
- Use `loki=False` for debug/sensitive output not meant for centralized logging
  (`humio` is deprecated and defaults to `False`).
- Wrap f-strings containing dicts/JSON with `escape_curly_braces()` before passing
  to the logger.

### PySpark patterns

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
- Plain `assert` with descriptive messages:
  `assert len(data) == 2, "Should return two items"`
- Tests must be fully mocked — no live API or Databricks calls.

## Dependencies

- `adb/requirements.txt` is the **source of truth** for CI/CD runtime dependencies.
- `pyproject.toml` `[dependency-groups] dev` mirrors it for local dev.
  Update `requirements.txt` first.
- PySpark is overridden to never install (databricks-connect bundles its own).
- **Installing dependencies in project repos** (`bi-dlh-src-*`, `bi-dlh-datamart-*`):
  use the VS Code task **Install Dependencies** (Ctrl+Shift+P > Tasks: Run Task)
  instead of bare `uv sync`. That task handles PyPI token setup for the private
  Azure DevOps feed. In the helper repo (`bi-dlh-helper`), plain `uv sync` works.

### `dlh-dmt-helper` version

- Use `dlh-dmt-helper` whenever it covers the task.
- Pin source: `adb/requirements.txt`, otherwise top-level `requirements.txt`. Stay
  compatible with the pin unless the user asks to upgrade.
- Pinned to the private Azure DevOps feed to prevent dependency confusion. Check the
  latest version and the
  [CHANGELOG](https://github.com/DanskeStatsbaner/bi-dlh-helper/blob/main/CHANGELOG.md)
  only via that feed or `DanskeStatsbaner/bi-dlh-helper` — never public indexes or
  mirrors. When bumping, look for breaking API and behavioural changes (e.g. logger
  `humio` defaults).
- For runtime-sensitive work, compare the pin against
  `importlib.metadata.version("dlh-dmt-helper")`; do not trust `dlh_dmt_helper.__version__`.
- Prefer helper Git tags over `main` when exact behaviour matters; use `main` only for
  unreleased work or when no tag matches, and state that limitation.
- Packaged `dlh-*` skills need helper 13.5.0+. On older pins, read installed or
  version-matched source instead of trusting synced skills.

## Shared CI/CD & project infrastructure

The shared CI/CD repo [bi-dlh-dmt-ci-cd](https://github.com/DanskeStatsbaner/bi-dlh-dmt-ci-cd)
drives all deployment pipelines. Its expectations:

- **`ci_cd/adb_vars_{dev,uat,prd}.yml`** — per-environment variables consumed by the
  deployer (`adb_deploy.py`). Key flags: `deploy_jobs`, `deploy_schemas`,
  `delete_missing_jobs`. Removing a job YAML from `adb/jobs/` does NOT delete it from
  Databricks unless `delete_missing_jobs: true` is set here.
- **`project_setup/project_config.yml`** — cluster runtime version, node types, storage
  containers, warehouse config. The `spark_version` here is the source of truth for
  which Databricks Runtime the project targets.
- **`pyproject.toml`** — the `databricks-connect` version MUST match `spark_version`
  from `project_config.yml` (runtime `15.4.x` -> `databricks-connect==15.4.*`,
  runtime `17.3.x` -> `databricks-connect==17.3.*`).

For full local environment setup (VS Code config, `pyproject.toml` structure, UV index
configuration, `.vscode/` tasks and settings), see
[vscode-dev-setup.md](https://github.com/DanskeStatsbaner/bi-dlh-documentation/blob/main/docs/vscode-dev-setup.md).
Older projects may be missing `pyproject.toml`, `.vscode/`, etc. — copy them from
[bi-dlh-project-template](https://github.com/DanskeStatsbaner/bi-dlh-project-template)
and adapt. Use
[bi-dlh-src-commercial-spassenger](https://github.com/DanskeStatsbaner/bi-dlh-src-commercial-spassenger)
as the up-to-date reference implementation.

## Pre-push validation

The ruff target depends on repo structure:

- `adb/` exists (source/datamart repos) -> target `adb/`
- otherwise (e.g. `bi-dlh-helper`) -> target `.`

```sh
# Source/datamart repos (adb/ exists):
uv run ruff check adb/ && uv run ruff format --check adb/ && uv run mypy

# Library/helper repos (no adb/):
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

Ask the user which pytest scope to run before executing pytest. Present the available
test directories/files and let them choose:

- a specific test file (`tests/ai/test_metadata.py`)
- a specific test directory (`tests/data_quality/`)
- a specific class or function (`tests/ai/test_metadata.py::TestClassName::test_name`)
- the full suite (only if explicitly confirmed)
