# Plan 001: Recreate The Windows Development Environment

> **Executor instructions**: Follow this plan in order on the new Windows laptop. Authenticate in the browser whenever a command opens one. Do not transfer, paste, commit, or store credentials in source-controlled files. Stop at any STOP condition rather than working around company access controls.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `83c5110`, 2026-09-28

## Why This Matters

The current machine has a deliberate OpenCode setup, global VS Code preferences, 33 installed VS Code extensions, Python/Databricks tooling, and access to DSB repositories. Most OpenCode behavior is already versioned in `maja2811/mj-ai`; credentials and VS Code user state are not. Rebuilding from installers and Git keeps the new machine current while avoiding migration of secrets, stale caches, and device-specific session state.

## Current State

- `~/.config/opencode` is the Git repository `https://github.com/maja2811/mj-ai.git`, currently on `main` at `83c5110`.
- `~/.config/opencode/opencode.json` defines the default GitHub Copilot models, the Databricks AI Gateway provider using `{env:DATABRICKS_TOKEN}`, the Atlassian MCP endpoint, and these external skill paths:

  ```json
  "skills": {
    "paths": [
      "C:\\Users\\maja2811\\work\\bi-dlh-documentation\\skills\\dlh-platform",
      "C:\\Users\\maja2811\\work\\bi-dlh-helper\\dlh_dmt_helper\\skills"
    ]
  }
  ```

- `~/.config/opencode/package.json` declares `@opencode-ai/plugin`; installation therefore requires Node.js and `npm install` after cloning.
- `~/.config/opencode/scripts/install-personal-skills.ps1` restores the personal third-party skills to `~/.agents/skills`, the OpenCode auto-discovery location. This is preferable to adding every skill path to `opencode.json`; the location is recognized automatically and avoids hardcoded username-specific paths.
- `~/AppData/Roaming/Code/User/settings.json` contains global settings for Python, GitHub Pull Requests, JSON/YAML formatting, and an `OpenCode` terminal profile. It uses a username-specific OpenCode executable path and must be changed if the Windows user profile name changes.
- `~/AppData/Roaming/Code/User/keybindings.json` maps `Ctrl+Shift+OEM_3` to create a terminal with the `OpenCode` profile.
- Existing local VS Code prompts are `dsb_copilot_review.prompt.md` and `dsb-bi-copilot-review-2.prompt.md` under `~/AppData/Roaming/Code/User/prompts/`. They are not in `mj-ai`; copy only these prompt files after inspecting them for any sensitive or machine-specific content.
- DSB project repositories are normally under `~/work/`, including `bi-dlh-documentation`, `bi-dlh-helper`, `bi-dlh-dmt-ci-cd`, `bi-dlh-central-bimanagement`, `bi-dlh-commercial-csf`, and `bi-dlh-src-commercial-spassenger`.
- Do not copy any of these sensitive locations: Windows Credential Manager, browser profiles/cookies, `~/.databrickscfg`, OpenCode `auth.json`, `DATABRICKS_TOKEN`, Azure DevOps PATs, SSH private keys, `.env` files, or `skills/genie/playwright/.auth/`.

## Commands You Will Need

| Purpose | Command | Expected On Success |
|---|---|---|
| Install baseline tools | `winget install --exact --id <package-id>` | Installer completes successfully |
| Clone personal setup | `git clone https://github.com/maja2811/mj-ai.git "$HOME/.config/opencode"` | Git clone completes |
| Install setup dependencies | `npm install` | Exit 0 in `~/.config/opencode` |
| Restore personal skills | `& "$HOME/.config/opencode/scripts/install-personal-skills.ps1"` | Each skill is installed under `~/.agents/skills` |
| Authenticate GitHub CLI | `gh auth login` | `gh auth status` shows the intended GitHub account |
| Integrate Git with GitHub CLI | `gh auth setup-git` | Git uses GitHub CLI credentials for HTTPS remotes |
| Authenticate Databricks | `databricks auth login --host <workspace-url> --profile <profile>` | Browser login completes; `databricks auth profiles` shows valid profile(s) |
| Install Databricks agent tools | `databricks aitools install --agents opencode` | `databricks aitools list` lists OpenCode integration |
| Verify OpenCode | `opencode --version` | Prints a version |
| Verify VS Code extensions | `code --list-extensions --show-versions` | Installed extensions are listed |

## Scope

**In scope**

- Installing the tools listed below on a new company-managed Windows laptop.
- Recreating `~/.config/opencode` from `maja2811/mj-ai`.
- Reapplying VS Code user settings, keybinding, prompts, and extensions.
- Fresh authentication to GitHub, Databricks, Azure DevOps, OpenCode/GitHub Copilot, and Atlassian.
- Cloning required DSB repositories under `~/work`.

**Out of scope**

- Copying any token, private key, credential database, browser profile, or session store.
- Changing the shared OpenCode configuration or DSB repositories.
- Installing optional non-development applications from the old laptop.

## Steps

## Copilot Prompt

Open this file in the first VS Code Copilot Chat window on the new laptop, then paste:

```text
Act as my Windows developer-workstation setup assistant. Follow the checked-in
runbook 001-recreate-windows-development-environment.md step by step. Run only
the commands in the runbook, explain commands that require browser login, and
stop for my confirmation before any authentication, token entry, or software
installation requiring elevation. Do not copy, print, store, or ask me to paste
credentials into source-controlled files. Keep a checklist of completed steps
and report any blocked company access precisely.
```

Do not ask Copilot to recreate the plan from memory. The runbook is the source
of truth and should be updated on the old laptop if a missing requirement is found.

### Step 1: Prepare The New Laptop

1. Complete company enrollment, Windows Update, VPN/client security setup, and sign in with the DSB account before developer tooling. These controls may be required for private GitHub, Azure DevOps, and Databricks access.
2. Open PowerShell 7 and confirm package management is available:

   ```powershell
   winget --version
   ```

3. Install the required baseline tools from official WinGet manifests. Do not pin the old laptop versions; use current approved releases.

   ```powershell
   winget install --exact --id Git.Git
   winget install --exact --id Microsoft.VisualStudioCode
   winget install --exact --id Microsoft.PowerShell
   winget install --exact --id Microsoft.WindowsTerminal
   winget install --exact --id Python.Python.3.12
   winget install --exact --id OpenJS.NodeJS
   winget install --exact --id GitHub.cli
   winget install --exact --id astral-sh.uv
   winget install --exact --id Databricks.DatabricksCLI
   winget install --exact --id SST.opencode
   ```

4. Close and reopen PowerShell so `PATH` changes take effect, then verify:

   ```powershell
   git --version
   code --version
   python --version
   node --version
   npm --version
   gh --version
   uv --version
   databricks --version
   opencode --version
   ```

**Verify**: Every command prints a version. Python must be 3.12 or later unless a checked-out project explicitly requires another version.

### Step 2: Configure Git And GitHub

1. Set the Git identity. These values appear in future commit metadata:

   ```powershell
   git config --global user.name "maja2811"
   git config --global user.email "maja2811@dsb.dk"
   git config --global --list --show-origin
   ```

2. Authenticate GitHub CLI using browser/device authentication. Choose `GitHub.com`, `HTTPS`, and browser login when prompted:

   ```powershell
   gh auth login
   gh auth status
   ```

3. Configure Git so HTTPS GitHub remotes use the GitHub CLI's fresh, secure credential store rather than prompting separately for a password or personal access token:

   ```powershell
   gh auth setup-git
   git config --global --get credential.helper
   ```

4. Confirm the `DanskeStatsbaner` organization and private setup repository are reachable:

   ```powershell
   gh repo view maja2811/mj-ai --json nameWithOwner,visibility
   gh repo view DanskeStatsbaner/bi-dlh-documentation --json nameWithOwner,visibility
   ```

**Verify**: Both repository commands return JSON and no authentication error. `gh auth status` shows the intended account, and `git config --global --get credential.helper` prints a configured credential helper. If organization access is missing, request the required DSB GitHub group membership rather than using a personal token.

### Step 3: Restore OpenCode Configuration And Skills

1. Clone the versioned setup repository. If the new Windows username is not `maja2811`, clone into that new account's home directory; do not clone into the old absolute path.

   ```powershell
   New-Item -ItemType Directory -Force -Path "$HOME/.config"
   git clone https://github.com/maja2811/mj-ai.git "$HOME/.config/opencode"
   ```

2. Install the configuration repository's Node dependency:

   ```powershell
   npm install
   ```

3. Restore the personal skills to `~/.agents/skills`. Keep this location: OpenCode automatically discovers skills in `~/.agents/skills`, so no additional `skills.paths` entry is needed. The versioned installer downloads their public upstream sources and does not migrate credentials or session state:

   ```powershell
   & "$HOME/.config/opencode/scripts/install-personal-skills.ps1"
   Get-ChildItem "$HOME/.agents/skills" -Directory | Select-Object -ExpandProperty Name
   ```

   This installs `improve`, `huashu-design`, `ponytail`, `stop-slop`, `skill-generalizer`, `skill-miner`, `skill-personalizer`, `grill-me`, and `handoff`.

4. Clone the source repositories that supply the DSB-specific OpenCode skills. Preserve the `~/work` layout, because the checked-in `opencode.json` currently uses absolute paths under it:

   ```powershell
   New-Item -ItemType Directory -Force -Path "$HOME/work"
   git clone https://github.com/DanskeStatsbaner/bi-dlh-documentation.git "$HOME/work/bi-dlh-documentation"
   git clone https://github.com/DanskeStatsbaner/bi-dlh-helper.git "$HOME/work/bi-dlh-helper"
   ```

5. If the Windows username differs from `maja2811`, update only the two skill paths in `~/.config/opencode/opencode.json` to use the new home directory. Preserve the `{env:DATABRICKS_TOKEN}` placeholder; never replace it with a token.
6. Authenticate OpenCode with the GitHub Copilot subscription:
   - Run `opencode` from any cloned repository.
   - Run `/connect`.
   - Select **GitHub Copilot**, open `https://github.com/login/device`, and complete the device-code authorization.
   - Run `/models` and confirm the configured `github-copilot` models are available.
7. Install the Databricks-managed skills only after the CLI is installed:

   ```powershell
   databricks aitools install --agents opencode
   databricks aitools list
   ```

8. Confirm the global configuration loads by starting and exiting OpenCode:

   ```powershell
   opencode
   ```

**Verify**: OpenCode starts without a configuration error; its skill list includes the cloned DSB skills and the Databricks agent integration is listed. Quit and restart OpenCode after every later configuration change because it loads configuration only at startup.

### Step 4: Restore VS Code User Experience

1. Start VS Code, sign into the DSB GitHub account, and enable Settings Sync only if it is approved and contains the intended personal VS Code profile. Do not assume it migrates extensions, prompts, or corporate authentication correctly.
2. Create or replace the following files from the old laptop after reviewing them:

   ```text
   %APPDATA%\Code\User\settings.json
   %APPDATA%\Code\User\keybindings.json
   %APPDATA%\Code\User\prompts\dsb_copilot_review.prompt.md
   %APPDATA%\Code\User\prompts\dsb-bi-copilot-review-2.prompt.md
   ```

3. In `settings.json`, change the `terminal.integrated.profiles.windows.OpenCode.path` value if the new username changes the WinGet links path. Better: set it to the result of `(Get-Command opencode).Source` from the new machine.
4. Install the extension inventory from the previous machine. Run one command per extension; omit extensions you intentionally no longer use.

   ```powershell
   code --install-extension charliermarsh.ruff
   code --install-extension cweijan.vscode-office
   code --install-extension databricks.databricks
   code --install-extension eriklynd.json-tools
   code --install-extension exelord.git-commits
   code --install-extension george-alisson.html-preview-vscode
   code --install-extension github.vscode-pull-request-github
   code --install-extension hediet.vscode-drawio
   code --install-extension ms-python.python
   code --install-extension ms-python.mypy-type-checker
   code --install-extension ms-python.vscode-pylance
   code --install-extension ms-python.vscode-python-envs
   code --install-extension ms-toolsai.jupyter
   code --install-extension ms-toolsai.jupyter-keymap
   code --install-extension ms-toolsai.jupyter-renderers
   code --install-extension ms-toolsai.vscode-jupyter-cell-tags
   code --install-extension ms-toolsai.vscode-jupyter-slideshow
   code --install-extension ms-vscode.powershell
   code --install-extension natqe.reload
   code --install-extension redhat.vscode-yaml
   code --install-extension tomoki1207.pdf
   code --install-extension yzane.markdown-pdf
   code --install-extension yzhang.markdown-all-in-one
   ```

   Do not manually install `ms-python.debugpy` or `ms-vscode.vscode-speech`; they are VS Code-managed dependencies. The old `databricks.databricks` extension had two retained versions locally; install only the current extension.
5. Reload VS Code, open the integrated terminal profile menu, and confirm the `OpenCode` profile starts OpenCode. Press `Ctrl+Shift+OEM_3` to confirm the keybinding creates that terminal profile.

**Verify**: `code --list-extensions --show-versions` includes the extension IDs above; VS Code loads without JSON settings errors; the OpenCode profile launches successfully.

### Step 5: Restore DSB Python Development

1. Clone the DSB project repositories needed for current work beneath `~/work`. Start with the active project and its shared sources; avoid cloning repositories merely because they existed on the old laptop.
2. Open each project in VS Code. Prefer its committed `.vscode/extensions.json`, `.vscode/tasks.json`, `.vscode/settings.json`, `pyproject.toml`, and `adb/requirements.txt` over global assumptions.
3. For a project with the shared DSB local-development configuration, run the VS Code task **Install Dependencies**. It creates the project `.venv`, installs dependencies using `uv`, and can prompt for the Azure DevOps private-PyPI credential.
4. Create a new Azure DevOps PAT with only **Packaging: Read** scope when required. Enter it only into the task's prompt or the OS secret/environment mechanism used by the project. Never copy the old PAT.
5. Authenticate each required Databricks workspace using OAuth. Use a named profile, one profile per workspace/project:

   ```powershell
   databricks auth login --host https://<workspace-host> --profile <profile-name>
   databricks auth profiles
   ```

    Create profiles only for workspaces you need. Current mappings are:

    | Profile | Workspace | Intended use |
    |---|---|---|
    | `commercial-dev` | `https://adb-3304658076883586.6.azuredatabricks.net/` | Commercial development; can read commercial production data when access permits. |
    | `datamart-prd` | `https://adb-2848871633622482.2.azuredatabricks.net/` | Read production datamart data. |
    | `commercial-prd` | `https://adb-129115855181532.12.azuredatabricks.net/` | Commercial production work. |

    A profile selects a workspace, not a cluster. Use the open project's configuration to identify the relevant workspace, then ask the developer to select a profile before every Databricks command. Do not auto-select a profile.
6. Set `DATABRICKS_TOKEN` only if the Databricks AI Gateway provider needs it and a team-approved short-lived token flow exists. Keep it in the user environment or the approved secret store, never in `opencode.json`. OAuth profiles alone do not necessarily populate this variable.
7. Use the project-specific VS Code **Connect to Databricks** task where it is provided. It performs browser OAuth and configures the profile expected by the project.

**Verify**: In an active project, `uv --version` and `databricks auth profiles` work, the project environment setup task completes, and a minimal project-approved local command can import its dependencies. Do not run an entire pytest suite without choosing its scope first.

### Step 6: Reconnect Optional Services

1. Start OpenCode and authorize the remote Atlassian MCP when first prompted. Verify a harmless Jira/Confluence read via the configured Jira subagent. Do not copy old browser state.
2. If using the `genie` skill, follow its documented Microsoft authentication flow to create a new local browser-auth state. Do not migrate `skills/genie/playwright/.auth/`.
3. Install optional personal tools only when needed. The old machine included Azure Data Studio, Azure Storage Explorer, Power BI Desktop, SQL Server Management Studio, KeePass, FFmpeg, FileZilla, and Copilot CLI, but none are prerequisites for the DSB Python/OpenCode workflow.

**Verify**: Each optional service completes its own browser/device authentication and works without importing old credential files.

## Done Criteria

- [ ] `git --version`, `code --version`, `python --version`, `node --version`, `gh --version`, `uv --version`, `databricks --version`, and `opencode --version` all print versions.
- [ ] `gh auth status` shows the intended DSB GitHub account and private DSB repositories are accessible.
- [ ] `~/.config/opencode` is cloned from `maja2811/mj-ai` and `npm install` exits 0 there.
- [ ] Personal skills are installed under `~/.agents/skills`; OpenCode starts with the restored configuration and has been authorized with GitHub Copilot.
- [ ] `databricks aitools list` shows the installed OpenCode integration.
- [ ] VS Code settings, keybinding, prompts, and required extensions are restored and the OpenCode terminal profile works.
- [ ] Required Databricks profiles were created through fresh OAuth, and needed private-PyPI access has been established with a newly issued PAT.
- [ ] No credentials, browser profiles, `auth.json`, `.databrickscfg`, SSH private keys, `.env` files, or `node_modules` were copied from the old laptop.

## STOP Conditions

Stop and request help from DSB IT/platform support if:

- WinGet is unavailable or software installation requires privileges you do not have.
- GitHub organization access, Copilot entitlement, Azure DevOps feed access, or Databricks workspace access is denied.
- `opencode` fails to load the restored configuration after confirming the `skills.paths` directories exist.
- The Windows username differs and changing the two checked-in absolute skill paths would require a shared configuration change you do not want to make.
- A tool asks to import or export a secret, browser profile, Windows credential, or unencrypted token file from the old machine.

## Maintenance Notes

- Keep durable OpenCode changes in `maja2811/mj-ai`; do not rely on untracked files under `~/.config/opencode`.
- Keep personal third-party skills in `~/.agents/skills`. Their reproducible installer and upstream source mapping are versioned in `mj-ai` at `scripts/install-personal-skills.ps1`; add a new skill there when expanding the personal set.
- The two absolute DSB skill paths in `opencode.json` make the current setup username-dependent. A future improvement is to replace them with home-relative paths if OpenCode's configuration supports them consistently on Windows.
- Run `databricks aitools update` periodically, then restart OpenCode. Project-local `.opencode/skills` copies remain authoritative when present.
- The VS Code extension list is a snapshot, not a strict lockfile. Install current versions and review extensions periodically, especially AI extensions with broad workspace access.
