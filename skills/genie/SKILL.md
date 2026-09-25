---
name: genie
description: Databricks Genie CLI automation with Databricks-profile workspace switching, standalone Microsoft auth bootstrap, browserless direct prompting, and headless real-client execution.
compatibility: Requires Node.js, Playwright browser install, Databricks CLI with profiles in ~/.databrickscfg, and Databricks workspace access.
metadata:
  version: "1.0"
---

# Genie Operations

Use this skill for Databricks Genie automation from the scripts in this skill folder.

**IMPORTANT: For quick, targeted SQL queries (row counts, data checks, schema inspection, verifying a fix), use the Databricks CLI directly** (`databricks experimental aitools tools query "..." --profile <PROFILE>`). Only use genie for extended multi-table investigations, root-cause analysis, or natural-language exploratory queries.

**Important:** Always ask the user which Databricks profile to use before running any genie command. Never auto-select a profile. If a Databricks profile was already selected earlier in the conversation (e.g. via the `databricks` skill or a `databricks connect` flow), confirm with the user whether to reuse it. Otherwise, list available profiles with `npm run genie:auth -- --list-profiles` and let the user pick. All commands below must be run from this skill folder (`~/.config/opencode/skills/genie/`).

## Layout

- Genie scripts live in `scripts/`
- Skill-local dependencies live in `node_modules/`
- Workspace selection comes from Databricks CLI profiles in `~/.databrickscfg`
- Standalone Microsoft auth seed lives in `playwright/.auth/microsoft.json`
- Derived Databricks auth cache is stored per profile under `<os-temp>/genie/profiles/<profile>/`

## Prerequisites

- Install dependencies in this skill folder: `npm install`
- Install browser: `npx playwright install chromium`
- Ensure Databricks CLI profiles exist: `databricks auth profiles`
- Optionally set up `agent-browser` auth vault for encrypted secret storage (see Authentication section)

## Authentication

List available workspaces:

```bash
npm run genie:auth -- --list-profiles
```

Bootstrap Databricks auth for a profile:

```bash
npm run genie:auth -- --profile sso_commercial_uat
```

Refresh the standalone Microsoft seed directly:

```bash
npm run genie:auth:ms -- --profile sso_commercial_uat
```

Force-refresh Databricks auth:

```bash
npm run genie:auth -- --profile sso_commercial_uat --force
```

Genie auth behavior:

- It selects the workspace host from the chosen Databricks CLI profile in `~/.databrickscfg`
- It validates the Databricks workspace session from the selected profile's cache under `<os-temp>/genie/profiles/<profile>/`
- If the Databricks state is missing or expired, it bootstraps from the standalone Microsoft seed in `playwright/.auth/microsoft.json`
- If that seed is stale, it refreshes Microsoft auth locally and retries Databricks bootstrap

### Secret storage (agent-browser auth vault)

Microsoft SSO credentials (password + TOTP secret) are stored in an encrypted agent-browser auth vault profile. Save the JSON secret bundle as the password field:

```bash
echo '{"password":"<ms-password>","totpSecret":"<totp-secret>","username":"<ms-email>"}' | agent-browser auth save jira-secrets --url https://jira.dsb.dk --username <ms-email> --password-stdin
```

Override the profile name via `AB_AUTH_PROFILE` env var. Set `USE_AGENT_BROWSER_AUTH=false` to disable vault lookup. Set `ALLOW_ENV_SECRET_FALLBACK=true` to fall back to `MS_PASSWORD` / `MS_TOTP_SECRET` env vars when the vault is unavailable.

## Commands

Recommended default:

```bash
npm run genie:headless -- --profile sso_commercial_uat --new-chat "Find KTS tables"
```

Browserless direct mode:

```bash
npm run genie:direct -- --profile sso_commercial_uat "Find KTS tables"
```

Interactive browser-session mode:

```bash
npm run genie:prompt -- --profile sso_commercial_uat "Find KTS tables"
```

`genie:prompt` keeps its own per-profile `agent-browser` state under `<os-temp>/genie/profiles/<profile>/agent-browser-state.json`. On first use for a profile, it may pause and let you complete Microsoft/Databricks sign-in in the `agent-browser` session window, then it saves that browser state for reuse.

## Which mode to use?

- `genie:headless`: recommended default; most faithful to the real Databricks client and usually the safest choice when Genie internals change
- `genie:direct`: faster, lighter, and easier to script or run in CI; best when you want structured automation and tighter session control
- `genie:prompt`: useful for interactive browser-session experiments, but less automation-oriented

## Direct vs headless

- Use `genie:headless` for product-faithful behavior and better resilience to Databricks-side changes
- Use `genie:direct` for lower overhead, faster startup, named persistent sessions, and API-style automation
- `genie:direct` depends on maintained adapters for tool semantics; `genie:headless` naturally inherits the real client behavior
- If unsure, start with `genie:headless`
