$ErrorActionPreference = "Stop"
$source = $PSScriptRoot
$installRoot = Join-Path $env:ProgramData "EmployeeMonitor"
$exe = Join-Path $installRoot "EmployeeMonitorAgent.exe"

if (-not (Test-Path (Join-Path $source "EmployeeMonitorAgent.exe"))) {
    throw "EmployeeMonitorAgent.exe is not beside this installer. Extract the complete Windows agent ZIP first."
}

if (-not (Test-Path (Join-Path $source "config.json"))) {
    Copy-Item (Join-Path $source "config.example.json") (Join-Path $source "config.json") -Force
    Write-Host "A configuration file has been created. Enter the employee name, save it, then run install-agent.bat again."
    Start-Process notepad.exe (Join-Path $source "config.json") -Wait
    exit 0
}

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

# The installer may be launched directly from the installed folder.
# Avoid copying a directory onto itself (which causes Copy-Item errors).
$sourceFull = [System.IO.Path]::GetFullPath($source).TrimEnd('\', '/')
$installFull = [System.IO.Path]::GetFullPath($installRoot).TrimEnd('\', '/')
if (-not [string]::Equals($sourceFull, $installFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Copy-Item (Join-Path $source "*") $installRoot -Recurse -Force
} else {
    Write-Host "Installer is already in the installation folder; skipping file copy."
}
if (-not (Test-Path (Join-Path $installRoot "config.json"))) {
    throw "config.json was not copied. Installation stopped."
}

$startupAction = New-ScheduledTaskAction -Execute $exe -Argument '"--heartbeat-only"' -WorkingDirectory $installRoot
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$systemPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "EmployeeMonitor-BootHeartbeat" -Action $startupAction -Trigger $startupTrigger -Principal $systemPrincipal -Settings $taskSettings -Description "Employee Monitor heartbeat component; sends device online status only." -Force | Out-Null

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$userAction = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $installRoot
$userTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$userPrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "EmployeeMonitor-UserSession" -Action $userAction -Trigger $userTrigger -Principal $userPrincipal -Settings $taskSettings -Description "Visible Employee Monitor user-session component; detects foreground application process names." -Force | Out-Null

Start-ScheduledTask -TaskName "EmployeeMonitor-BootHeartbeat"
Start-Sleep -Seconds 5
Start-ScheduledTask -TaskName "EmployeeMonitor-UserSession"

Write-Host ""
Write-Host "Employee Monitor startup tasks installed."
Write-Host " - At Windows startup: heartbeat component runs as SYSTEM."
Write-Host " - At employee logon: foreground application monitor starts in that user's session."
Write-Host " - Both tasks are configured to restart after a failure."
Write-Host "Installed at: $installRoot"
Write-Host "To remove, run uninstall-agent.ps1 from the installed folder as Administrator."
