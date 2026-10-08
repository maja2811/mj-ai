<#
.SYNOPSIS
    Windows-native PR review watcher for the review-pr skill.

.DESCRIPTION
    Polls GitHub (via scripts/poll_reviews.py) for open, non-draft PRs where
    the current user is a requested reviewer. For each new or updated PR
    (detected by a changed head commit SHA), shows a Windows toast
    notification (scripts/notify.ps1) and opens a new Windows Terminal tab
    running opencode with the /review-pr command pre-filled.

    This is the Windows-native replacement for scripts/pr-watcher.sh, which
    depends on cmux (Mac/Linux-only) and is not usable on this platform.

.PARAMETER PollInterval
    Seconds between polls. Default 60.

.PARAMETER OpencodeModel
    Model to pass to `opencode -m`. Default azure/gpt-6.1-sol.

.PARAMETER Once
    Run a single poll cycle and exit, instead of looping forever.

.PARAMETER Baseline
    Seed the state file with every currently pending review PR (marked
    reviewed at its current head SHA) WITHOUT launching a review session for
    any of them. Run this once before starting the watcher for the first
    time, or any time the state file is deleted/reset, so existing pending
    reviews are not all treated as "new" and launched at once.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File pr-watcher.ps1 -Baseline

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File pr-watcher.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File pr-watcher.ps1 -PollInterval 30 -Once
#>

param(
    [int]$PollInterval = 60,
    [string]$OpencodeModel = "azure/gpt-6.1-sol",
    [switch]$Once,
    [switch]$Baseline
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PollScript = Join-Path $ScriptDir "poll_reviews.py"
$NotifyScript = Join-Path $ScriptDir "notify.ps1"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    Write-Host "[$timestamp] $Message"
}

function Test-Prerequisites {
    $missing = @()
    foreach ($tool in @("gh", "opencode", "wt")) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            $missing += $tool
        }
    }
    if (-not (Get-Command python -ErrorAction SilentlyContinue) -and
        -not (Get-Command python3 -ErrorAction SilentlyContinue)) {
        $missing += "python"
    }
    if ($missing.Count -gt 0) {
        Write-Log "ERROR: required tool(s) not found: $($missing -join ', ')"
        Write-Log "wt.exe (Windows Terminal) is used to open review sessions in a new tab."
        exit 1
    }
    try {
        gh auth status 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Log "ERROR: gh is not authenticated. Run: gh auth login"
            exit 1
        }
    } catch {
        Write-Log "ERROR: gh auth status failed: $_"
        exit 1
    }
}

function Get-PythonExe {
    if (Get-Command python -ErrorAction SilentlyContinue) { return "python" }
    return "python3"
}

function Get-ReviewablePrs {
    $py = Get-PythonExe
    $json = & $py $PollScript --once --json 2>$null
    if (-not $json) { return @() }
    try {
        return $json | ConvertFrom-Json
    } catch {
        Write-Log "WARN: could not parse poll_reviews.py output as JSON"
        return @()
    }
}

function Mark-Reviewed {
    param([string]$Url)
    $py = Get-PythonExe
    & $py $PollScript --mark-reviewed $Url 2>$null | Out-Null
}

function Show-Notification {
    param([string]$Title, [string]$Message)
    try {
        powershell -ExecutionPolicy Bypass -File $NotifyScript -Title $Title -Message $Message
    } catch {
        Write-Log "WARN: notification failed: $_"
    }
}

function Start-ReviewSession {
    param([string]$Url, [string]$Repo, [int]$Number, [string]$Title)

    Write-Log "Launching review session: $Repo#$Number - $Title"
    Show-Notification -Title "PR Review Started" -Message "$Repo#$Number`: $Title"

    $prompt = "/review-pr $Url"
    $command = "opencode -m $OpencodeModel --prompt `"$prompt`""

    try {
        Start-Process wt.exe -ArgumentList @(
            "new-tab",
            "--title", "PR Review: $Repo#$Number",
            "powershell", "-NoExit", "-Command", $command
        )
    } catch {
        Write-Log "ERROR: failed to launch Windows Terminal tab for $Url`: $_"
        return
    }

    # Marking reviewed at launch time (not completion) prevents relaunching the
    # same head commit on the next poll. A new commit produces a new head SHA,
    # which poll_reviews.py will surface again as a fresh review-worthy PR.
    Mark-Reviewed -Url $Url
}

function Invoke-PollCycle {
    $prs = Get-ReviewablePrs
    if ($prs.Count -eq 0) {
        Write-Log "No pending reviews found."
        return
    }
    foreach ($pr in $prs) {
        Start-ReviewSession -Url $pr.url -Repo $pr.repo -Number $pr.number -Title $pr.title
    }
}

function Invoke-BaselineSeed {
    $prs = Get-ReviewablePrs
    if ($prs.Count -eq 0) {
        Write-Log "No pending reviews to seed as baseline."
        return
    }
    Write-Log "Seeding $($prs.Count) existing pending review(s) as baseline (no sessions launched):"
    foreach ($pr in $prs) {
        Write-Log "  - $($pr.repo)#$($pr.number): $($pr.title)"
        Mark-Reviewed -Url $pr.url
    }
    Write-Log "Baseline seeding complete. Only NEW or updated PRs from now on will launch a review session."
}

Test-Prerequisites

if ($Baseline) {
    Write-Log "PR Watcher (Windows) - baseline seed mode"
    Invoke-BaselineSeed
    return
}

Write-Log "PR Watcher (Windows) starting"
Write-Log "Poll interval: ${PollInterval}s"
Write-Log "Model: $OpencodeModel"

if ($Once) {
    Invoke-PollCycle
    return
}

while ($true) {
    try {
        Invoke-PollCycle
    } catch {
        Write-Log "ERROR: poll cycle failed: $_"
    }
    Start-Sleep -Seconds $PollInterval
}
