@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0install-agent.ps1""'"
if errorlevel 1 (
  echo Installation did not complete. Check the PowerShell error above.
  pause
)
