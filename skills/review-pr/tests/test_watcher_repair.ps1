# Isolated tray functions and fake helper only: no live watcher, API, terminal or state.
$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/pr-watcher-tray.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$root = Join-Path $env:LOCALAPPDATA ('Temp/opencode/repair check''s ' + [guid]::NewGuid().ToString('N'))
$scripts = Join-Path $root 'opencode/skills/review-pr/scripts'
New-Item -ItemType Directory -Path $scripts -Force | Out-Null
foreach ($name in @('Start-WatcherRepair', 'Receive-WatcherOutput')) {
    $node = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name }, $true)
    if (-not $node) { throw "Missing $name" }
    . ([scriptblock]::Create($node.Extent.Text.Replace('$PSScriptRoot', "'" + $scripts.Replace("'", "''") + "'")))
}
$LogPath = Join-Path $root 'watcher.out.log'
$ErrorLogPath = Join-Path $root 'watcher.err.log'
$watcher = Join-Path $scripts 'pr-watcher.ps1'
$OpencodeModel = 'azure/gpt-6.1-sol#high'
$job = [pscustomobject]@{ State = 'Running' }
$script:RepairAttempted = $false
$script:RepairJob = $null
$script:starts = 0
$script:throwOnStart = $false
$script:received = @()
$script:terminals = @()

function Start-Job {
    param($ScriptBlock, $ArgumentList)
    $script:starts++
    if ($script:throwOnStart) { throw 'fixture job scheduling failure' }
    $script:submission = $ScriptBlock
    $script:submissionArgs = $ArgumentList
    [pscustomobject]@{ State = 'Running' }
}
function Receive-Job { param($Job) $script:received }
function Start-Process {
    param($FilePath, $ArgumentList)
    if ($FilePath -ne 'wt.exe') { throw 'Unexpected process requested' }
    $script:terminals += ,$ArgumentList
}

$script:received = @('[2026-10-16T10:00:00] Checking GitHub for pending reviews...', 'Launching review: ERROR: is only a title')
Receive-WatcherOutput
if ($script:starts) { throw 'Normal progress triggered repair' }
$failure = '[2026-10-16T10:00:00] ERROR: bad "number" in user''s data'
$script:received = @($failure, $failure, 'ERROR: second error')
Receive-WatcherOutput
Start-WatcherRepair -Failure 'PR watcher worker ended unexpectedly (Failed).'
if ($script:starts -ne 1 -or -not $script:RepairAttempted) { throw 'Repeated failures must schedule exactly one repair' }
$report = Get-Content -LiteralPath "$LogPath.failure.json" -Raw -Encoding UTF8 | ConvertFrom-Json
if ($report.failure -ne $failure -or $report.log_path -ne $LogPath -or $report.error_log_path -ne $ErrorLogPath) {
    throw 'Failure details/quoted paths did not survive the report'
}
if ($script:submissionArgs[1] -ne (Join-Path $root 'opencode') -or $script:submissionArgs[2] -ne $OpencodeModel) {
    throw 'Repair must use the setup root and configured model'
}
$helper = Join-Path $scripts 'start_review_v2.py'
@'
import json, sys
assert '--watcher-failure' in sys.argv
assert '--url' not in sys.argv
print(json.dumps({'session_id': 'ses_fixturerepair'}))
'@ | Set-Content -LiteralPath $helper -Encoding UTF8
& $script:submission @script:submissionArgs
if ($script:terminals.Count -ne 1 -or $script:terminals[0][-1] -ne 'ses_fixturerepair' -or
    $script:terminals[0][4] -ne ('"' + (Join-Path $root 'opencode') + '"')) { throw 'Repair terminal arguments are invalid' }

# A failed helper must not open a terminal or recursively schedule a repair.
'raise SystemExit(7)' | Set-Content -LiteralPath $helper -Encoding UTF8
& $script:submission @script:submissionArgs
if ($script:starts -ne 1 -or $script:terminals.Count -ne 1) { throw 'Failed submission recursed or opened a terminal' }

$script:RepairAttempted = $false
$script:RepairJob = $null
$script:throwOnStart = $true
Start-WatcherRepair -Failure 'ERROR: job scheduling fixture'
Start-WatcherRepair -Failure 'ERROR: do not retry'
if ($script:starts -ne 2 -or -not $script:RepairAttempted) { throw 'Scheduling failure must still latch the attempt' }

# Fatal PowerShell errors need no ERROR: log prefix to trigger repair.
$script:RepairAttempted = $false
$script:throwOnStart = $false
$script:received = @([System.Management.Automation.ErrorRecord]::new(
    [Exception]::new('fixture fatal error'), 'fixture', 'NotSpecified', $null
))
Receive-WatcherOutput
if ($script:starts -ne 3) { throw 'PowerShell error records must trigger repair' }
Write-Output 'PASS: progress filtering, one repair per run, diagnostic quoting, setup location/model, terminal, helper/scheduling errors and fatal records.'
Write-Output "Validation artifacts: $root"
