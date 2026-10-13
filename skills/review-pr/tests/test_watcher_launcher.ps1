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

# Spaces in both paths exercise Start-Process argument quoting.
$root = Join-Path $env:LOCALAPPDATA ('Temp/opencode/watcher launch check ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$fixture = Join-Path $root 'fake watcher.ps1'
$logDir = Join-Path $root 'persistent logs'
$launcher = Join-Path $root 'launcher.ps1'
$child = $null
$parent = $null
try {
    @'
Write-Host 'started'
Start-Sleep -Seconds 5
Write-Host 'after-launcher-exit'
[Console]::Error.WriteLine('test-stderr')
'@ | Set-Content -LiteralPath $fixture -Encoding UTF8
    $code = $code.Replace('$watcher = "$HOME/.config/opencode/skills/review-pr/scripts/pr-watcher.ps1"', '$watcher = "' + $fixture + '"')
    $code = $code.Replace('$logDir = "$HOME/.local/share/opencode/pr-watcher"', '$logDir = "' + $logDir + '"')
    if ($code.Contains('$HOME/.config/opencode/skills/review-pr/scripts/pr-watcher.ps1')) {
        throw 'Fixture substitution failed; refusing to start the real watcher.'
    }
    ($code + ' | ConvertTo-Json -Compress') | Set-Content -LiteralPath $launcher -Encoding UTF8
    $parentOutput = Join-Path $root 'launcher.json'
    $parentError = Join-Path $root 'launcher.err.log'
    $parent = Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`"" `
        -WindowStyle Hidden -RedirectStandardOutput $parentOutput -RedirectStandardError $parentError -PassThru
    if (-not $parent.WaitForExit(3000)) { throw 'Launcher did not return before the fixture finished.' }
    $output = Get-Content -LiteralPath $parentOutput -Raw
    $errors = Get-Content -LiteralPath $parentError -Raw
    if ($errors) { throw "Launcher failed: $errors" }
    $info = $output | ConvertFrom-Json
    $child = Get-Process -Id $info.PID -ErrorAction Stop
    if ($child.HasExited) { throw 'Child did not survive launcher exit.' }
    Wait-Process -Id $child.Id -Timeout 10 -ErrorAction Stop
    $stdout = Get-Content -LiteralPath $info.Stdout -Raw
    $stderr = Get-Content -LiteralPath $info.Stderr -Raw
    if ($stdout -notmatch 'started' -or $stdout -notmatch 'after-launcher-exit') {
        throw "Persistent stdout capture failed: $stdout"
    }
    if ($stderr -notmatch 'test-stderr') { throw "Persistent stderr capture failed: $stderr" }
    Write-Output 'PASS: quoted paths, child survival after launcher exit, and persistent stdout/stderr.'
    Write-Output "Validation artifacts: $root"
} finally {
    if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
    if ($parent -and -not $parent.HasExited) { Stop-Process -Id $parent.Id -ErrorAction SilentlyContinue }
}
