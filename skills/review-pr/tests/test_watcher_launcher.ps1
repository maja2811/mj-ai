# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File tests/test_watcher_launcher.ps1
# Exercise the documented launcher without GitHub, OpenCode sessions, or review state.
$ErrorActionPreference = 'Stop'
$skillPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'SKILL.md'
$skill = Get-Content -LiteralPath $skillPath -Raw
$blocks = [regex]::Matches($skill, '(?s)```powershell\r?\n(.*?)\r?\n```')
$launchers = @($blocks | Where-Object { $_.Groups[1].Value.Contains('Start-Process') })
if ($launchers.Count -ne 1) { throw 'Expected one documented persistent launcher.' }
$code = $launchers[0].Groups[1].Value
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
if ($code -match '-Wait\b|-NoNewWindow\b') { throw 'Launcher must return and use a separate window.' }
if ($code -notmatch '-WindowStyle\s+Hidden\b' -or $code -notmatch '-STA\b') {
    throw 'Tray host must start hidden in STA mode.'
}

# Spaces/apostrophes exercise launcher and encoded log-viewer quoting.
$root = Join-Path $env:LOCALAPPDATA ('Temp/opencode/watcher launch check''s ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$traySource = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/pr-watcher-tray.ps1') -Raw
$iconPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'references/pr-watcher.ico'
Add-Type -AssemblyName System.Drawing
foreach ($size in @(16, 32, 48)) {
    $eye = New-Object Drawing.Icon -ArgumentList $iconPath, $size, $size
    if ($eye.Width -ne $size -or $eye.Height -ne $size) { throw 'Eye icon size is missing.' }
    $eye.Dispose()
}
New-Item -ItemType Directory -Path (Join-Path $root 'references') | Out-Null
Copy-Item -LiteralPath $iconPath -Destination (Join-Path $root 'references/pr-watcher.ico')
Write-Output 'PASS: bundled eye icon loads at 16, 32 and 48 pixels.'

foreach ($mode in @('completion', 'menu-stop', 'host-stop')) {
    $case = Join-Path $root $mode
    New-Item -ItemType Directory -Path $case | Out-Null
    $fixture = Join-Path $case 'fake watcher.ps1'
    $tray = Join-Path $case 'fake tray.ps1'
    $logDir = Join-Path $case 'persistent logs'
    $launcher = Join-Path $case 'launcher.ps1'
    $child = $null
    $parent = $null
    try {
        $worker = @'
param([int]$PollInterval, [string]$OpencodeModel)
Write-Host "worker-pid=$PID interval=$PollInterval model=$OpencodeModel"
Write-Host 'started'
Start-Sleep -Seconds 5
Write-Host 'after-launcher-exit'
Write-Error 'test-worker-error'
'@
        if ($mode -ne 'completion') { $worker += "`nStart-Sleep -Seconds 60" }
        $worker | Set-Content -LiteralPath $fixture -Encoding UTF8
        $trayCode = $traySource.Replace("`$watcher = Join-Path `$PSScriptRoot 'pr-watcher.ps1'", '$watcher = "' + $fixture + '"')
        if ($trayCode.Contains("Join-Path `$PSScriptRoot 'pr-watcher.ps1'")) {
            throw 'Fixture substitution failed; refusing to start the real watcher.'
        }
        if ($mode -eq 'menu-stop') {
            # Exercise real menu callbacks, but capture the terminal command instead of opening it.
            $capturePath = (Join-Path $case 'terminal.json').Replace("'", "''")
            $capture = "function Capture-Terminal { param(`$ArgumentList) `$ArgumentList | ConvertTo-Json | Set-Content -LiteralPath '$capturePath' }`n"
            $trayCode = $trayCode.Replace('Start-Process wt.exe -ArgumentList', 'Capture-Terminal -ArgumentList')
            $trayCode = $trayCode.Replace('function Open-WatcherLogs {', $capture + 'function Open-WatcherLogs {')
            $control = @'
    $testClock = [Diagnostics.Stopwatch]::StartNew()
    $timer.Add_Tick({
        if ($testClock.Elapsed.TotalSeconds -ge 10) {
            $openLogs.PerformClick()
            $stop.PerformClick()
        }
    })
'@
            $trayCode = $trayCode.Replace('    $timer.Start()', $control + "`n    `$timer.Start()")
        }
        $trayCode | Set-Content -LiteralPath $tray -Encoding UTF8
        $launcherCode = $code.Replace('$watcher = "$HOME/.config/opencode/skills/review-pr/scripts/pr-watcher-tray.ps1"', '$watcher = "' + $tray + '"')
        $launcherCode = $launcherCode.Replace('$logDir = "$HOME/.local/share/opencode/pr-watcher"', '$logDir = "' + $logDir + '"')
        if ($launcherCode.Contains('$HOME/.config/opencode/skills/review-pr/scripts/')) {
            throw 'Launcher substitution failed; refusing to start the real tray host.'
        }
        ($launcherCode + ' | ConvertTo-Json -Compress') | Set-Content -LiteralPath $launcher -Encoding UTF8
        $parentOutput = Join-Path $case 'launcher.json'
        $parentError = Join-Path $case 'launcher.err.log'
        $parent = Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`"" `
            -WindowStyle Hidden -RedirectStandardOutput $parentOutput -RedirectStandardError $parentError -PassThru
        if (-not $parent.WaitForExit(3000)) { throw 'Launcher did not return before the fixture finished.' }
        $errors = Get-Content -LiteralPath $parentError -Raw
        if ($errors) { throw "Launcher failed: $errors" }
        $info = Get-Content -LiteralPath $parentOutput -Raw | ConvertFrom-Json
        $child = Get-Process -Id $info.PID -ErrorAction Stop
        if ($child.HasExited) { throw 'Tray host did not survive launcher exit.' }
        if ($mode -eq 'host-stop') {
            Start-Sleep -Seconds 10
            Stop-Process -Id $child.Id -ErrorAction Stop
        }
        Wait-Process -Id $child.Id -Timeout 25 -ErrorAction Stop
        $stdout = Get-Content -LiteralPath $info.Stdout -Raw
        $stderr = Get-Content -LiteralPath $info.Stderr -Raw
        if ($stderr) { throw "Tray host failed: $stderr" }
        foreach ($text in @('tray ready', 'started', 'after-launcher-exit', 'test-worker-error', 'interval=60 model=azure/gpt-6.1-sol#high')) {
            if (-not $stdout.Contains($text)) { throw "Missing $text in fixture logs: $stdout" }
        }
        if ($stdout -notmatch 'worker-pid=(\d+)') { throw 'Missing fixture worker PID.' }
        $workerProcess = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue
        if ($workerProcess -and -not $workerProcess.WaitForExit(5000)) { throw 'Fixture worker leaked after tray exit.' }
        if ($mode -eq 'menu-stop') {
            if ($stdout -notmatch 'Stopping PR watcher') { throw 'Stop menu did not run.' }
            $arguments = Get-Content -LiteralPath (Join-Path $case 'terminal.json') -Raw | ConvertFrom-Json
            $view = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($arguments[-1]))
            if ($view -notmatch 'Closing this tab does not stop' -or $view -notmatch '-Tail 500 -Wait' -or
                $view -notmatch 'last 500 lines of this run') {
                throw 'Log menu did not create a read-only live log terminal.'
            }
            foreach ($path in @($info.Stdout, $info.Stderr)) {
                if (-not $view.Contains("'" + $path.Replace("'", "''") + "'")) { throw 'Log path quoting failed.' }
            }
            [System.Management.Automation.Language.Parser]::ParseInput($view, [ref]$tokens, [ref]$parseErrors) | Out-Null
            if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
        } elseif ($mode -eq 'completion' -and $stdout -notmatch 'worker ended') {
            throw 'Tray did not notice worker completion.'
        }
        Write-Output "PASS: $mode, hidden launcher survival, live job logs, quoted paths, tray exit and worker cleanup."
    } finally {
        if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
        if ($parent -and -not $parent.HasExited) { Stop-Process -Id $parent.Id -ErrorAction SilentlyContinue }
    }
}

# Exercise only the changed poll reader with a fake Python script: no gh or state.
& {
    $workerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/pr-watcher.ps1'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($workerPath, [ref]$tokens, [ref]$parseErrors)
    $reader = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ReviewablePrs' }, $true)
    . ([scriptblock]::Create($reader.Extent.Text))
    function Get-PythonExe { (Get-Command python -ErrorAction Stop).Source }
    function Write-Log { param($Message) $script:diagnostics += [string]$Message }
    $PollScript = Join-Path $root 'fake poll.py'
    foreach ($mode in @('pending', 'multiple', 'empty-array', 'empty', 'error', 'invalid', 'nonzero')) {
        $python = "import sys`nprint('[poll] Checking for pending reviews...', file=sys.stderr)`n"
        switch ($mode) {
            'pending' { $python += 'print(''[{"number": 1}]'')' }
            'multiple' { $python += 'print(''[{"number": 6}, {"number": 350}, {"number": 349}, {"number": 35}]'')' }
            'empty-array' { $python += 'print(''[]'')' }
            'empty' { $python += "print('[poll] No pending reviews found.', file=sys.stderr)" }
            'error' { $python += "print('[poll] Error: fixture failure', file=sys.stderr)" }
            'invalid' { $python += "print('not JSON')" }
            'nonzero' { $python += "sys.exit(1)" }
        }
        $python | Set-Content -LiteralPath $PollScript -Encoding UTF8
        $script:diagnostics = @()
        $threw = $false
        try { $prs = @(Get-ReviewablePrs) } catch { $threw = $true; $reason = $_.Exception.Message }
        $expectedError = $mode -in @('error', 'invalid', 'nonzero')
        if ($threw -ne $expectedError) { throw "Unexpected poll-reader outcome for $mode`: $reason" }
        if (-not ($script:diagnostics -match 'Checking for pending')) { throw 'Poll progress was hidden.' }
        if ($mode -eq 'pending' -and ($prs.Count -ne 1 -or $prs[0].number -ne 1)) { throw 'Poll JSON mixed with diagnostics.' }
        if ($mode -eq 'multiple' -and ($prs.Count -ne 4 -or ($prs.number -join ',') -ne '6,350,349,35')) {
            throw 'Poll JSON array was not enumerated into individual PRs.'
        }
        foreach ($pr in $prs) {
            if ($pr -isnot [pscustomobject] -or $pr.number -isnot [int]) { throw 'Each PR must have a scalar integer number.' }
        }
        if ($mode -in @('empty', 'empty-array') -and $prs.Count -ne 0) { throw 'Empty poll should return no PRs.' }
    }
    Write-Output 'PASS: poll progress, individual PRs with scalar numbers, empty results, errors and malformed output.'
}
Write-Output "Validation artifacts: $root"
