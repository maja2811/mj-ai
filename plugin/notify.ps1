param(
    [int]$ServerPid,
    [string]$Title = "OpenCode",
    [string]$Message = "Waiting for you",
    [string]$MatchTitle = "",
    [switch]$Force
)

# Best-effort desktop notification helper for the OpenCode notify plugin.
# Suppresses the toast when the OpenCode host window is the foreground window
# (unless -Force). Focus is decided by:
#   1. the foreground window's PID being in the process ancestry of $ServerPid
#      (covers terminals whose window process is an ancestor), OR
#   2. the foreground window being a GUI host that also appears in the ancestry
#      (by process name) AND whose title contains -MatchTitle (covers VS Code /
#      Cursor, which own their windows in a sibling process).
# Never throws: failures degrade to a system sound.

$ErrorActionPreference = "SilentlyContinue"

function Test-OpencodeFocused {
    param([int]$RootPid, [string]$MatchTitle)

    if (-not $RootPid) { return $false }

    try {
        $sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
'@
        if (-not ([System.Management.Automation.PSTypeName]'FgWin').Type) {
            Add-Type -TypeDefinition $sig
        }

        $hwnd = [FgWin]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return $false }

        [uint32]$fgPid = 0
        [void][FgWin]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
        if ($fgPid -eq 0) { return $false }

        $sb = New-Object System.Text.StringBuilder 1024
        [void][FgWin]::GetWindowText($hwnd, $sb, 1024)
        $fgTitle = $sb.ToString()
        $fgName = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).ProcessName

        # Build a childPID -> parentPID map once, plus a PID -> name map.
        $parentOf = @{}
        $nameOf = @{}
        foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name)) {
            $parentOf[[uint32]$p.ProcessId] = [uint32]$p.ParentProcessId
            $nameOf[[uint32]$p.ProcessId] = $p.Name
        }

        # Walk ancestry from the OpenCode process up to the desktop.
        $ancestorNames = New-Object System.Collections.Generic.HashSet[string]
        $cur = [uint32]$RootPid
        $seen = New-Object System.Collections.Generic.HashSet[uint32]
        while ($cur -ne 0 -and $parentOf.ContainsKey($cur) -and -not $seen.Contains($cur)) {
            [void]$seen.Add($cur)
            # 1) direct PID match (real terminal windows)
            if ($cur -eq $fgPid) { return $true }
            $n = $nameOf[$cur]
            if ($n) { [void]$ancestorNames.Add(($n -replace '\.exe$', '')) }
            $parent = $parentOf[$cur]
            if ($parent -eq $cur) { break }
            $cur = $parent
        }

        # 2) GUI-host name + title match (VS Code / Cursor multi-window case)
        if ($fgName -and $ancestorNames.Contains($fgName)) {
            if ([string]::IsNullOrWhiteSpace($MatchTitle)) { return $true }
            if ($fgTitle -and $fgTitle.ToLower().Contains($MatchTitle.ToLower())) { return $true }
        }

        return $false
    }
    catch {
        # Unknown -> treat as NOT focused so we err toward notifying.
        return $false
    }
}

if (-not $Force) {
    if (Test-OpencodeFocused -RootPid $ServerPid -MatchTitle $MatchTitle) {
        Write-Output "SUPPRESSED (focused)"
        exit 0
    }
}

# Ensure BurntToast is present (install once, into CurrentUser scope).
if (-not (Get-Module -ListAvailable -Name BurntToast)) {
    try {
        if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
            Install-PackageProvider -Name NuGet -Force -Scope CurrentUser | Out-Null
        }
        Install-Module -Name BurntToast -Scope CurrentUser -Force -AllowClobber | Out-Null
    }
    catch { }
}

try {
    Import-Module BurntToast -ErrorAction Stop
    $lines = @($Title) + ($Message -split "`n" | Where-Object { $_ -ne "" })
    New-BurntToastNotification -Text $lines -ErrorAction Stop
    Write-Output "NOTIFIED"
}
catch {
    # Fallback: audible cue so the event is not lost entirely.
    try { [System.Media.SystemSounds]::Asterisk.Play() } catch { }
    Write-Output "FALLBACK_SOUND"
}
