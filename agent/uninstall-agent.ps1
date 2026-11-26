$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName "EmployeeMonitor-BootHeartbeat" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "EmployeeMonitor-UserSession" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Employee Monitor automatic startup tasks have been removed."
Write-Host "The installed files and device registration were left in place."
