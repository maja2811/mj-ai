# Hidden tray host for the existing polling script. No scheduled task or service.
param(
    [ValidateRange(1, 2147483647)][int]$PollInterval = 60,
    [string]$OpencodeModel = 'azure/gpt-6.1-sol#high',
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$LogPath,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ErrorLogPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$watcher = Join-Path $PSScriptRoot 'pr-watcher.ps1'
$script:RepairAttempted = $false
$script:RepairJob = $null

function Start-WatcherRepair {
    param([string]$Failure)
    if ($script:RepairAttempted) { return }
    # One attempt per tray lifetime, even if OpenCode is unavailable. Never recurse.
    $script:RepairAttempted = $true
    try {
        $reportPath = "$LogPath.failure.json"
        @{
            failure = $Failure; log_path = $LogPath; error_log_path = $ErrorLogPath
            worker_path = $watcher; tray_pid = $PID
        } | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding UTF8 -ErrorAction Stop
        $helper = Join-Path $PSScriptRoot 'start_review_v2.py'
        $setupDirectory = (Get-Item -LiteralPath $PSScriptRoot).Parent.Parent.Parent.FullName
        Write-Host "PR watcher failure: requesting one repair session. Report: $reportPath"
        $script:RepairJob = Start-Job -ScriptBlock {
            param($helper, $directory, $model, $reportPath)
            $ErrorActionPreference = 'Stop'
            try {
                $python = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { 'python3' }
                $result = & $python $helper --directory $directory --model $model --watcher-failure $reportPath
                if ($LASTEXITCODE -ne 0) { throw "Repair helper exited with $LASTEXITCODE" }
                $sessionId = ($result | ConvertFrom-Json -ErrorAction Stop).session_id
                if ($sessionId -isnot [string] -or $sessionId -notmatch '^ses_[a-zA-Z0-9]+$') {
                    throw 'Repair helper returned an invalid session ID'
                }
                Write-Host "PR watcher repair started: $sessionId. Attach with: opencode --session $sessionId"
                try {
                    Start-Process wt.exe -ArgumentList @(
                        'new-tab', '--title', '"PR watcher repair"', '-d', "`"$directory`"",
                        'opencode.cmd', '--session', $sessionId
                    ) -ErrorAction Stop | Out-Null
                } catch {
                    Write-Host "WARN: could not open repair terminal; attach manually: opencode --session $sessionId. $_"
                }
            } catch {
                Write-Host "ERROR: could not start watcher repair (not retried this run): $_"
            }
        } -ArgumentList $helper, $setupDirectory, $OpencodeModel, $reportPath
    } catch {
        Write-Host "ERROR: could not schedule watcher repair (not retried this run): $_"
    }
}

function Receive-WatcherOutput {
    Receive-Job -Job $job -ErrorAction Continue 2>&1 | ForEach-Object {
        $line = [string]$_
        Write-Host $line
        if ($_ -is [System.Management.Automation.ErrorRecord] -or $line -match '^\s*(?:\[[^\]]+\]\s*)?ERROR:') {
            Start-WatcherRepair -Failure $line
        }
    }
}

function Open-WatcherLogs {
    # Encode the command and quote literal paths, including spaces/apostrophes.
    $stdout = $LogPath.Replace("'", "''")
    $stderr = $ErrorLogPath.Replace("'", "''")
    $command = @"
Write-Host 'PR watcher live logs: last 500 lines of this run, then new output. Closing this tab does not stop the watcher.'
Get-Content -LiteralPath '$stderr' -Tail 20 -ErrorAction SilentlyContinue
Get-Content -LiteralPath '$stdout' -Tail 500 -Wait
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    try {
        Start-Process wt.exe -ArgumentList @(
            'new-tab', '--title', '"PR watcher logs"',
            'powershell.exe', '-NoProfile', '-NoExit', '-EncodedCommand', $encoded
        ) | Out-Null
    } catch {
        Write-Host "ERROR: could not open log terminal: $_"
    }
}

$context = New-Object System.Windows.Forms.ApplicationContext
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add("Running (tray PID $PID)")
$status.Enabled = $false
$openLogs = $menu.Items.Add('Open logs')
$openLogs.Add_Click({ Open-WatcherLogs })
$stop = $menu.Items.Add('Stop watcher')
$stop.Add_Click({
    Write-Host 'Stopping PR watcher. Existing review sessions and saved state stay intact.'
    $context.ExitThread()
})
$icon = New-Object System.Windows.Forms.NotifyIcon
$eyeIcon = New-Object Drawing.Icon (Join-Path (Split-Path -Parent $PSScriptRoot) 'references/pr-watcher.ico')
$icon.Icon = $eyeIcon
$icon.Text = "PR watcher running (PID $PID)"
$icon.ContextMenuStrip = $menu
$icon.Add_DoubleClick({ Open-WatcherLogs })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$job = $null

try {
    # Keep GitHub/API calls off the UI thread so the menu remains responsive.
    # This job belongs to the independent tray process, not to OpenCode's shell.
    $job = Start-Job -ScriptBlock {
        param($path, $interval, $model)
        Set-Location $HOME
        & $path -PollInterval $interval -OpencodeModel $model
    } -ArgumentList $watcher, $PollInterval, $OpencodeModel
    $timer.Add_Tick({
        Receive-WatcherOutput
        if ($script:RepairJob) {
            Receive-Job -Job $script:RepairJob -ErrorAction Continue 2>&1 | ForEach-Object { Write-Host ([string]$_) }
        }
        if ($job.State -notin @('Running', 'NotStarted')) {
            Start-WatcherRepair -Failure "PR watcher worker ended unexpectedly ($($job.State))."
            # Let the independent repair submission finish before disposing its job.
            if (-not $script:RepairJob -or $script:RepairJob.State -notin @('Running', 'NotStarted')) {
                Write-Host "PR watcher worker ended ($($job.State)); removing tray icon."
                $context.ExitThread()
            }
        }
    })
    $icon.Visible = $true
    Write-Host "PR watcher tray ready (PID $PID). Right-click for Open logs / Stop watcher."
    $timer.Start()
    [Windows.Forms.Application]::Run($context)
} finally {
    $timer.Stop()
    $icon.Visible = $false
    $icon.Dispose()
    $eyeIcon.Dispose()
    $timer.Dispose()
    $menu.Dispose()
    $context.Dispose()
    if ($job) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Receive-Job -Job $job -ErrorAction Continue 2>&1 | ForEach-Object { Write-Host ([string]$_) }
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
    if ($script:RepairJob) {
        Stop-Job -Job $script:RepairJob -ErrorAction SilentlyContinue
        Receive-Job -Job $script:RepairJob -ErrorAction Continue 2>&1 | ForEach-Object { Write-Host ([string]$_) }
        Remove-Job -Job $script:RepairJob -Force -ErrorAction SilentlyContinue
    }
}
