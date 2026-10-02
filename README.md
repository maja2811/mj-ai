# mj-ai
Ai setup for local development

Runs on OpenCode v2 (`npm.cmd install -g @opencode/cli@latest`; the built-in upgrade is broken on Windows).
Terminal settings such as notifications live in `cli.json`. The last v1 setup is tagged `v1-final`.

On Windows, `plugins/windows-toasts/` sends native toasts for completed/failed sessions,
permission requests, and questions. Alerts include the project and session name and
appear even when VS Code is focused. Subagent completion alerts are suppressed.
The plugin reuses `skills/review-pr/scripts/notify.ps1` with the installed PowerShell
app identity (`Microsoft.PowerShell_8wekyb3d8bbwe!App`). Windows notification settings
and Do Not Disturb still apply. Terminal-host notifications are disabled in `cli.json`.

Check the notification plugin with `node --test plugins/windows-toasts/index.test.mjs`.
