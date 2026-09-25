<#
.SYNOPSIS
    Shows a Windows toast notification.

.DESCRIPTION
    Uses the WinRT ToastNotificationManager API to show a native Windows
    toast notification. Used by the review-pr skill's PR watcher to notify
    when a new or updated PR is ready for review.

.PARAMETER Title
    The notification title.

.PARAMETER Message
    The notification body text.

.PARAMETER AppId
    The AppUserModelID to show the toast under. Defaults to a generic
    PowerShell AppId so no separate app registration is required.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File notify.ps1 -Title "PR Review Ready" -Message "Review written: my-review.md"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Title,

    [Parameter(Mandatory = $true)]
    [string]$Message,

    [string]$AppId = "Microsoft.Windows.PowerShell"
)

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$template = @"
<toast>
    <visual>
        <binding template="ToastGeneric">
            <text>$([System.Security.SecurityElement]::Escape($Title))</text>
            <text>$([System.Security.SecurityElement]::Escape($Message))</text>
        </binding>
    </visual>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)

$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
