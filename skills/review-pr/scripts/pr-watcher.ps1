<#
.SYNOPSIS
    Windows-native PR review watcher for the review-pr skill.

.DESCRIPTION
    Polls GitHub (via scripts/poll_reviews.py) for open, non-draft PRs where
    the current user is a requested reviewer. For each new or updated PR
    (detected by a changed head commit SHA), starts an OpenCode V2 review
    session in the background through the API (scripts/start_review_v2.py).
    The windows-toasts plugin notifies when a review finishes or asks the
    posting question; the watcher then opens a Windows Terminal tab attached
    to that session.

    This is the Windows-native replacement for scripts/pr-watcher.sh, which
    is macOS-only (bash, jq, alerter/osascript, review-tabs plugin).

.PARAMETER PollInterval
    Seconds between polls. Default 60.

.PARAMETER OpencodeModel
    Session model as provider/model#variant. Default azure/gpt-6.1-sol#high.

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
    [string]$OpencodeModel = "azure/gpt-6.1-sol#high",
    [switch]$Once,
    [switch]$Baseline
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReviewDir = Split-Path -Parent $ScriptDir
$PollScript = Join-Path $ScriptDir "poll_reviews.py"
$StartScript = Join-Path $ScriptDir "start_review_v2.py"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    Write-Host "[$timestamp] $Message"
}

function Test-Prerequisites {
    $missing = @()
    foreach ($tool in @("gh", "opencode.cmd", "opencode2.cmd", "wt")) {
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
    Write-Log 'Checking GitHub for pending reviews...'
    # Keep poll progress/errors visible without mixing diagnostics into JSON.
    # Windows PowerShell treats native stderr (including progress) as errors.
    $ErrorActionPreference = 'Continue'
    $lines = @(& $py $PollScript --once --json 2>&1)
    $exitCode = $LASTEXITCODE
    $diagnostics = @($lines | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] })
    foreach ($line in $diagnostics) { Write-Log ([string]$line) }
    if ($exitCode -ne 0 -or ($diagnostics -match '\[poll\] Error:')) {
        throw "poll_reviews.py failed; see the poll diagnostics above."
    }
    $json = ($lines | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if (-not $json) { return @() }
    return $json | ConvertFrom-Json -ErrorAction Stop
}

function Mark-Reviewed {
    param([string]$Url)
    $py = Get-PythonExe
    & $py $PollScript --mark-reviewed $Url 2>$null | Out-Null
}

function Start-ReviewSession {
    param([string]$Url, [string]$Repo, [int]$Number, [string]$Title, [string]$HeadSha)

    Write-Log "Launching review session: $Repo#$Number - $Title"

    # The head SHA in the title gives each new commit its own stable session ID;
    # retries for the same commit reuse the same session instead of duplicating it.
    $sessionTitle = "PR Review: $Repo#$Number @$($HeadSha.Substring(0, [Math]::Min(7, $HeadSha.Length)))"
    $py = Get-PythonExe
    try {
        $out = & $py $StartScript --directory $ReviewDir --title $sessionTitle --model $OpencodeModel --url $Url
        if ($LASTEXITCODE -ne 0) { throw "start_review_v2.py exited with $LASTEXITCODE" }
        $sessionId = ($out | ConvertFrom-Json).session_id
    } catch {
        Write-Log "ERROR: failed to start review session for $Url (will retry next poll): $_"
        return
    }

    # The review runs in the OpenCode background service. The windows-toasts
    # plugin notifies when it finishes or asks the posting question; the tab is
    # opened then by Open-ReadyReviews.
    $script:ActiveReviews[$sessionId] = $sessionTitle

    # Marking reviewed at launch time (not completion) prevents relaunching the
    # same head commit on the next poll. A new commit produces a new head SHA,
    # which poll_reviews.py will surface again as a fresh review-worthy PR.
    Mark-Reviewed -Url $Url
}

function Open-ReadyReviews {
    $py = Get-PythonExe
    foreach ($sessionId in @($script:ActiveReviews.Keys)) {
        $status = & $py $StartScript --status $sessionId 2>$null
        if ($LASTEXITCODE -ne 0 -or $status -eq "working") { continue }
        $sessionTitle = $script:ActiveReviews[$sessionId]
        $script:ActiveReviews.Remove($sessionId)
        Write-Log "Review $status`: $sessionTitle ($sessionId)"
        try {
            Start-Process wt.exe -ArgumentList @(
                "new-tab", "--title", "`"$sessionTitle`"", "-d", $ReviewDir,
                "opencode.cmd", "--session", $sessionId
            )
        } catch {
            Write-Log "WARN: failed to open Windows Terminal tab; attach manually with: opencode --session $sessionId"
        }
    }
}

function Invoke-PollCycle {
    $prs = @(Get-ReviewablePrs)
    if ($prs.Count -eq 0) {
        Write-Log "No pending reviews found."
        return
    }
    foreach ($pr in $prs) {
        Start-ReviewSession -Url $pr.url -Repo $pr.repo -Number $pr.number -Title $pr.title -HeadSha $pr.head_sha
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

$ActiveReviews = @{}

if ($Once) {
    Invoke-PollCycle
    return
}

$nextPoll = Get-Date
while ($true) {
    try {
        if ((Get-Date) -ge $nextPoll) {
            Invoke-PollCycle
            $nextPoll = (Get-Date).AddSeconds($PollInterval)
        }
        Open-ReadyReviews
    } catch {
        Write-Log "ERROR: poll cycle failed: $_"
    }
    Start-Sleep -Seconds 15
}
