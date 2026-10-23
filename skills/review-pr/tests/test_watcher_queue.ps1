# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File tests/test_watcher_queue.ps1
# Use real queue functions with fake Python/terminal calls; never touch live state.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA ('Temp/opencode/watcher queue check ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$ActiveReviewsPath = Join-Path $root 'active-reviews.json'
$ScriptDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts'
$StartScript = 'fake-start.py'
$ReviewDir = Join-Path $root 'review directory with spaces'
$OpencodeModel = 'fixture/model'
$workerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/pr-watcher.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($workerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Read-ActiveReviews', 'Save-ActiveReviews', 'Start-ReviewSession', 'Open-ReadyReviews', 'Invoke-PollCycle', 'Invoke-ReviewMaintenance')) {
    $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $function) { throw "Missing function: $name" }
    . ([scriptblock]::Create($function.Extent.Text))
}
function Write-Log { param($Message) }
function Get-PythonExe { 'Test-Python' }
function Test-Python {
    $global:LASTEXITCODE = $script:pythonExitCode
    if ($args -contains 'maintain') {
        $script:maintenanceCalls++
        $global:LASTEXITCODE = $script:maintenanceExitCode
        return 'WARN: fixture maintenance result'
    }
    if ($args -contains '--status') {
        $script:statusCalls++
        return $script:reviewStatus
    }
    $script:startCalls++
    return '{"session_id":"ses_fixture1"}'
}
function Mark-Reviewed {
    param($Url, $HeadSha)
    throw 'Review launch must not be marked completed or baseline.'
}
function Mark-Started {
    param($Url, $HeadSha, $SessionId, $Attempt)
    $script:markerCalls++
    if (-not (Read-ActiveReviews).ContainsKey($SessionId)) { throw 'Launch tracked before queue was saved.' }
    $script:trackedHead = $HeadSha
    $script:trackedSession = $SessionId
    $script:trackedAttempt = $Attempt
}
function Get-ReviewablePrs { $script:pollCalls++; @() }
function Start-Process {
    [CmdletBinding()]
    param($FilePath, $ArgumentList)
    if ($FilePath -ne 'wt.exe') { throw 'Unexpected terminal executable.' }
    $script:terminalCalls++
    $script:terminalArguments = $ArgumentList
    if ($script:failTerminal) { throw 'Fixture terminal failure.' }
}
$script:ActiveReviews = Read-ActiveReviews
if ($script:ActiveReviews.Count -ne 0) { throw 'Missing queue must start empty.' }
$script:startCalls = 0
$script:markerCalls = 0
$script:terminalCalls = 0
$script:statusCalls = 0
$script:pythonExitCode = 0
$script:maintenanceExitCode = 0
$script:reviewStatus = 'working'
$script:failTerminal = $false
Start-ReviewSession -Url 'https://example.test/pr/1' -Repo "fixture-$([char]0xe6)" -Number 1 -Title 'Fixture' -HeadSha 'abcdef1234'
$expectedTitle = $script:ActiveReviews['ses_fixture1']
if ($script:startCalls -ne 1 -or $script:markerCalls -ne 1) { throw 'Fixture review launch was not saved and tracked.' }
if ($script:trackedHead -ne 'abcdef1234' -or $script:trackedSession -ne 'ses_fixture1' -or $script:trackedAttempt -ne 1) {
    throw 'Tracking did not use the exact launched head/session/attempt.'
}

# Simulate a restart: discard memory, load only the file, and do not start a new review.
$script:ActiveReviews = @{}
$script:ActiveReviews = Read-ActiveReviews
if ($script:ActiveReviews['ses_fixture1'] -ne $expectedTitle) { throw 'Restart lost the session ID/title or Unicode.' }
Open-ReadyReviews
if ($script:terminalCalls -ne 0 -or (Read-ActiveReviews).Count -ne 1) { throw 'Working review opened early or lost its queue entry.' }
$script:reviewStatus = 'blocked'
$script:pythonExitCode = 1
Open-ReadyReviews
if ($script:terminalCalls -ne 0 -or (Read-ActiveReviews).Count -ne 1) { throw 'Failed status check lost the session.' }
$script:pythonExitCode = 0
foreach ($status in @('blocked', 'done')) {
    $script:reviewStatus = $status
    $script:failTerminal = $true
    Open-ReadyReviews
    if ((Read-ActiveReviews).Count -ne 1 -or $script:ActiveReviews.Count -ne 1) { throw 'Failed terminal launch lost the session.' }
    $script:failTerminal = $false
    Open-ReadyReviews
    if ($script:ActiveReviews.Count -ne 0 -or (Read-ActiveReviews).Count -ne 0) { throw 'Opened tab remained queued.' }
    if ($script:terminalArguments[-1] -ne 'ses_fixture1' -or $script:terminalArguments[-2] -ne '--session') {
        throw 'Terminal did not attach to the existing session.'
    }
    if ($script:terminalArguments[4] -ne ('"' + $ReviewDir + '"')) { throw 'Review directory was not quoted.' }
    $before = $script:terminalCalls
    $script:ActiveReviews = Read-ActiveReviews
    Open-ReadyReviews
    if ($script:terminalCalls -ne $before) { throw 'Restart reopened an already delivered tab.' }
    if ($status -eq 'blocked') {
        $script:ActiveReviews['ses_fixture1'] = $expectedTitle
        Save-ActiveReviews
        $script:ActiveReviews = Read-ActiveReviews
    }
}
if ($script:startCalls -ne 1) { throw 'Recovery relaunched a review.' }
if (@(Get-ChildItem -LiteralPath $root -Filter '*.tmp').Count) { throw 'Queue writes left temporary files.' }
Write-Output 'PASS: persisted before tracking (not completion), exact head/session/attempt, restart restore, terminal retry and no duplicate review/tab.'

# A bounded retry gets a different, deterministic title/session key.
Start-ReviewSession -Url 'https://example.test/pr/1' -Repo 'fixture' -Number 1 -Title 'Fixture' -HeadSha 'abcdef1234' -Attempt 2
if ($script:ActiveReviews['ses_fixture1'] -ne 'PR Review: fixture#1 @abcdef1 (retry 1)' -or $script:trackedAttempt -ne 2) {
    throw 'Retry did not get its own stable title and attempt number.'
}
Write-Output 'PASS: retries use a distinct deterministic session title and tracked attempt.'

# A failed queue write must leave the PR head unmarked so the launch can retry.
$goodPath = $ActiveReviewsPath
$blockedParent = Join-Path $root 'blocked-parent'
'fixture file' | Set-Content -LiteralPath $blockedParent
$ActiveReviewsPath = Join-Path $blockedParent 'active-reviews.json'
$before = $script:markerCalls
$failed = $false
try {
    Start-ReviewSession -Url 'https://example.test/pr/1' -Repo 'fixture' -Number 1 -Title 'Fixture' -HeadSha 'abcdef1234'
} catch { $failed = $true }
if (-not $failed -or $script:markerCalls -ne $before) { throw 'Failed queue write marked a head as reviewed.' }
$ActiveReviewsPath = $goodPath
Write-Output 'PASS: failed queue writes do not mark the PR head.'

# Exercise the real marker wrappers with a fake Python command, not live state.
& {
    foreach ($name in @('Mark-Reviewed', 'Mark-Started')) {
        $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        . ([scriptblock]::Create($function.Extent.Text))
    }
    $PollScript = 'fake-poll.py'
    $script:markerExitCode = 0
    function Test-Python {
        $script:markerArguments = $args
        $global:LASTEXITCODE = $script:markerExitCode
    }
    Mark-Started -Url 'https://example.test/pr/1' -HeadSha 'exact-head' -SessionId 'ses_fixture1' -Attempt 2
    if (($script:markerArguments -join '|') -ne 'fake-poll.py|--mark-started|https://example.test/pr/1|--head-sha|exact-head|--session-id|ses_fixture1|--attempt|2') {
        throw 'Launch marker omitted the captured head/session/attempt.'
    }
    Mark-Reviewed -Url 'https://example.test/pr/1' -HeadSha 'baseline-head'
    if (($script:markerArguments -join '|') -ne 'fake-poll.py|--mark-reviewed|https://example.test/pr/1|--head-sha|baseline-head') {
        throw 'Baseline marker refetched rather than recording the captured head.'
    }
    $script:markerExitCode = 1
    $failed = $false
    try { Mark-Started -Url 'fixture' -HeadSha 'exact-head' -SessionId 'ses_fixture1' -Attempt 1 } catch { $failed = $true }
    if (-not $failed) { throw 'A failed launch-state write was ignored.' }
}
Write-Output 'PASS: real marker CLI arguments preserve the captured head/session/attempt and report failed writes.'

foreach ($invalid in @('not JSON', '[]', '{"wrong-id":"title"}', '{"ses_fixture1":null}')) {
    $invalid | Set-Content -LiteralPath $ActiveReviewsPath -Encoding UTF8
    $failed = $false
    try { Read-ActiveReviews | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw "Invalid queue was accepted: $invalid" }
    if ((Get-Content -LiteralPath $ActiveReviewsPath -Raw).Trim() -ne $invalid) { throw 'Invalid queue was discarded or overwritten.' }
}
Write-Output 'PASS: malformed queues fail without discarding state.'

# Exercise startup wiring without entering the real loop or calling external tools.
function Test-Prerequisites { }
function Invoke-BaselineSeed { $script:baselineCalls++ }
$worker = Get-Content -LiteralPath $workerPath -Raw
$main = $worker.Substring($worker.LastIndexOf("`nTest-Prerequisites")).Trim()
$Baseline = $true
$Once = $false
$script:baselineCalls = 0
. ([scriptblock]::Create($main))
if ($script:baselineCalls -ne 1) { throw 'Baseline did not exit before reading the invalid tab queue.' }
$script:ActiveReviews = @{ ses_fixture1 = $expectedTitle }
Save-ActiveReviews
$script:ActiveReviews = @{}
$Baseline = $false
$Once = $true
$script:pollCalls = 0
$script:maintenanceCalls = 0
$script:maintenanceExitCode = 23
. ([scriptblock]::Create($main))
if ($script:pollCalls -ne 1 -or $script:maintenanceCalls -ne 1 -or $script:ActiveReviews['ses_fixture1'] -ne $expectedTitle) {
    throw 'Maintenance failure interrupted the single poll or startup lost the restored queue.'
}
Write-Output 'PASS: startup restores the queue; baseline skips maintenance; Once runs maintenance and polls despite its failure.'
Write-Output "Validation artifacts: $root"
