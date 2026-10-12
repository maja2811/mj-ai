---
description: Start the Windows PR watcher with background OpenCode V2 review sessions
agent: build
subagent: false
---

Load the `review-pr` skill and follow its Optional PR Watcher instructions. Start the Windows watcher; do not ask for a review target or run reviews in this chat.

Use the bundled script:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME/.config/opencode/skills/review-pr/scripts/pr-watcher.ps1"
```

Before the first start, check `$HOME/.config/opencode/skills/review-pr/.review-poll-state.json`. If it is missing, run the script with `-Baseline` in the foreground first. Explain that this records existing pending PRs as seen without reviewing them. Stop if baseline seeding fails. Preserve existing state; do not delete or reset it.

For a normal start, use the shell tool with `background: true` and return after launching it. Let the script handle polling, review sessions, and opening terminal tabs. Do not run an agent-managed polling loop or wait for reviews in this chat.

Honor only requested script options: `-PollInterval`, `-OpencodeModel`, `-Once`, and `-Baseline`. Validate values before passing them to PowerShell. Run `-Once` or `-Baseline` in the foreground instead of the background; both exit after one operation. With `-Baseline`, seed only and do not start the persistent watcher.

Report the launch result or any startup error. Do not claim that a review completed just because the watcher started.

Requested options: $ARGUMENTS
