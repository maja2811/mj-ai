# Genie Operations (Standalone Skill)

This skill provides standalone Databricks Genie automation scripts.

## Requirements

- Node.js + npm
- Playwright browser install
- Databricks CLI with profiles configured in `~/.databrickscfg`
- Access to the target Databricks workspace
- Optional: `agent-browser` auth vault for encrypted secret storage

## Install

```bash
npm install
npx playwright install chromium
```

## Authentication

Genie selects workspaces from your Databricks CLI profiles in `~/.databrickscfg`. It keeps a standalone Microsoft auth seed plus a separate browser auth cache per Databricks profile.

List available workspaces:

```bash
npm run genie:auth -- --list-profiles
```

Bootstrap or refresh Databricks auth for a specific profile:

```bash
npm run genie:auth -- --profile sso_commercial_uat
```

Refresh the standalone Microsoft seed directly:

```bash
npm run genie:auth:ms -- --profile sso_commercial_uat
```

Force a fresh Databricks auth bootstrap:

```bash
npm run genie:auth -- --profile sso_commercial_uat --force
```

Auth files:

- Standalone Microsoft auth seed: `playwright/.auth/microsoft.json`
- Derived Databricks auth cache: profile-scoped files under `<os-temp>/genie/profiles/<profile>/`

`genie:headless` and `genie:direct` accept `--profile <name>` and auto-refresh Databricks auth for that workspace when the cached session is missing or expired. If the standalone Microsoft seed is stale, Genie refreshes it locally and retries Databricks bootstrap.

### Secret storage

Microsoft SSO credentials are stored in an encrypted `agent-browser` auth vault. Save the JSON secret bundle as the password field:

```bash
echo '{"password":"...","totpSecret":"...","username":"..."}' | agent-browser auth save jira-secrets --url https://jira.dsb.dk --username <email> --password-stdin
```

Environment variables:
- `AB_AUTH_PROFILE` — override vault profile name (default: `jira-secrets`)
- `USE_AGENT_BROWSER_AUTH` — set to `false` to disable vault (default: `true`)
- `ALLOW_ENV_SECRET_FALLBACK` — set to `true` to fall back to `MS_PASSWORD`/`MS_TOTP_SECRET` env vars

## Commands

Run Genie with the real Databricks web client (recommended default):

```bash
npm run genie:headless -- --profile sso_commercial_uat --new-chat "Find KTS tables"
```

Run Genie through the browserless direct client:

```bash
npm run genie:direct -- --profile sso_commercial_uat "Find KTS tables"
```

Drive an existing interactive browser session directly:

```bash
npm run genie:prompt -- --profile sso_commercial_uat "Find KTS tables"
```

`genie:prompt` keeps its own per-profile `agent-browser` state under `<os-temp>/genie/profiles/<profile>/agent-browser-state.json`. On first use for a profile, it may pause and let you complete Microsoft/Databricks sign-in in the `agent-browser` session window, then it saves that browser state for later reuse.

## Which mode to use?

- `genie:headless`: recommended default; uses the real Databricks client, so it is the most faithful and usually the most resilient when Genie internals change
- `genie:direct`: faster and lighter; easier to script, easier to run in CI, and better when you want tight control over structured tool/session handling
- `genie:prompt`: useful for interactive/live-session experimentation, but less automation-friendly than the other two

## Direct vs headless

- Use `genie:headless` when you want behavior closest to the actual product UI and client orchestration
- Use `genie:direct` when you want lower overhead, faster startup, named persistent sessions, and API-style automation
- `genie:direct` is more deterministic for scripting, but it depends on our maintained adapters for Genie tools and backend behavior
- `genie:headless` is slower, but it naturally follows Databricks client changes better because it runs the real browser flow
- If you are unsure, start with `genie:headless`
