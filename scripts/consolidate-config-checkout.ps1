<#
.SYNOPSIS
    Collapses the two mj-ai checkouts into one by pointing the opencode config
    directory at this working copy.

.DESCRIPTION
    opencode reads global config from ~/.config/opencode. Keeping a second clone
    there means every change needs commit -> push -> pull before it takes effect,
    the two copies drift apart silently, and both AGENTS.md files load at once
    when the working copy is the current directory.

    OPENCODE_CONFIG_DIR does not solve this. It is additive - loaded after the
    global config and covering only agents/commands/modes/plugins - so
    ~/.config/opencode would still be read.

    Afterwards ~/.config/opencode is a junction to this repository. Edits take
    effect on save, and commits become purely about version history. Nothing
    sensitive is involved: opencode keeps credentials in ~/.local/share/opencode
    and package caches in ~/.cache/opencode, neither of which is touched here.

    Run from a plain PowerShell window with opencode fully closed.
    Administrator rights are not required - directory junctions do not need them.
#>
[CmdletBinding()]
param(
    [string]$WorkingCopy = "C:\Users\maja2811\work\mj-ai",
    [string]$ConfigPath = (Join-Path $HOME ".config\opencode")
)

$ErrorActionPreference = "Stop"

function Fail($message) {
    Write-Host "ABORT: $message" -ForegroundColor Red
    exit 1
}

# opencode must be closed - we are replacing the directory it runs from, and it
# holds file locks under node_modules while running.
$running = Get-Process -Name "opencode*" -ErrorAction SilentlyContinue
if ($running) {
    Fail "opencode is still running (PID $($running.Id -join ', ')). Quit it completely, then re-run."
}

if (-not (Test-Path -LiteralPath $WorkingCopy)) { Fail "Working copy not found: $WorkingCopy" }
if (-not (Test-Path -LiteralPath $ConfigPath)) { Fail "Config directory not found: $ConfigPath" }

$existing = Get-Item -LiteralPath $ConfigPath -Force
if ($existing.LinkType) {
    Write-Host "Already a $($existing.LinkType) -> $($existing.Target). Nothing to do." -ForegroundColor Green
    exit 0
}

# Refuse to run if either side holds work that is about to be discarded.
$workHead = (git -C $WorkingCopy rev-parse HEAD).Trim()
$confHead = (git -C $ConfigPath rev-parse HEAD).Trim()
$workDirty = git -C $WorkingCopy status --porcelain
$confDirty = git -C $ConfigPath status --porcelain

if ($workDirty) { Fail "Working copy has uncommitted changes. Commit or stash first.`n$workDirty" }
if ($confDirty) { Fail "Config copy has uncommitted changes that would be lost. Review first.`n$confDirty" }
if ($workHead -ne $confHead) {
    Fail "Checkouts are at different commits.`n  $WorkingCopy = $workHead`n  $ConfigPath  = $confHead`nSync them before consolidating."
}

Write-Host "Both checkouts clean and at $($workHead.Substring(0,7))." -ForegroundColor Green

# Move the old directory aside rather than deleting it - it still holds
# node_modules and any untracked local state.
$backup = "$ConfigPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Move-Item -LiteralPath $ConfigPath -Destination $backup
Write-Host "Old config directory moved to $backup"

try {
    New-Item -ItemType Junction -Path $ConfigPath -Target $WorkingCopy | Out-Null
}
catch {
    Move-Item -LiteralPath $backup -Destination $ConfigPath
    Fail "Junction failed, original restored. $($_.Exception.Message)"
}

# Verify opencode's entry points are readable through the link before committing
# to the change.
$required = @("opencode.json", "AGENTS.md", "dcp.jsonc", "plugin\notify.ts", "skills", "commands")
$missing = $required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ConfigPath $_)) }

if ($missing) {
    Remove-Item -LiteralPath $ConfigPath -Force
    Move-Item -LiteralPath $backup -Destination $ConfigPath
    Fail "Unreachable through the junction, original restored: $($missing -join ', ')"
}

Write-Host ""
Write-Host "Done. $ConfigPath -> $WorkingCopy" -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Start opencode and confirm skills, commands and agents load."
Write-Host "  2. opencode reinstalls node_modules on first start."
Write-Host "  3. Once satisfied, remove the backup:"
Write-Host "       Remove-Item -Recurse -Force '$backup'"
