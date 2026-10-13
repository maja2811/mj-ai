---
description: Start an independent Windows PR watcher with background OpenCode V2 review sessions
agent: build
subagent: false
---

Load the `review-pr` skill and follow its Optional PR Watcher instructions. Start the Windows watcher; do not ask for a review target or run reviews in this chat.

Use the bundled `scripts/pr-watcher.ps1` and the `Start-Process` launcher in the skill's Starting The Watcher section. Run the short launcher through a foreground shell tool call, not `background: true`. OpenCode's idle location cleanup can cancel a tool-managed background watcher.

Before the first start, check `$HOME/.config/opencode/skills/review-pr/.review-poll-state.json`. If it is missing, run the script with `-Baseline` in the foreground first. Explain that this records existing pending PRs as seen without reviewing them. Stop if baseline seeding fails. Preserve existing state; do not delete or reset it.

For a normal start, check for an existing watcher process before launching a duplicate. Start an independent PowerShell process with `-WindowStyle Minimized` and unique stdout/stderr logs under `$HOME/.local/share/opencode/pr-watcher/`. Do not use `-Wait` or `-NoNewWindow`. Let the script handle polling, review sessions, and opening terminal tabs. Do not run an agent-managed polling loop or wait for reviews in this chat.

Honor only requested script options: `-PollInterval`, `-OpencodeModel`, `-Once`, and `-Baseline`. Validate and quote values before passing them to PowerShell; do not interpolate arbitrary `$ARGUMENTS` into a command. Run `-Once` or `-Baseline` directly in the foreground without `Start-Process`; both exit after one operation. With `-Baseline`, seed only and do not start the persistent watcher.

After the launcher exits, make one process/log check as described in the skill. Report the PID, both log paths, and any startup error. Explain that the user can restore the minimized PowerShell window and close it with X to stop polling; output lives in the logs, and existing review sessions remain open. Do not claim that a review completed just because the watcher started. Do not add a scheduled task or service unless requested.

Requested options: $ARGUMENTS
