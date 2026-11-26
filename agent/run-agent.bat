@echo off
setlocal
cd /d "%~dp0"

REM Packaged mode: no Python installation required.
if exist "%~dp0EmployeeMonitorAgent.exe" (
  if not exist "%~dp0config.json" (
    copy "%~dp0config.example.json" "%~dp0config.json" >nul
    echo Created config.json. Enter your Worker URL, enrollment code, employee name, device name, and approved work folders.
    notepad "%~dp0config.json"
    echo Save and close Notepad, then run this file again.
    pause
    exit /b 0
  )
  "%~dp0EmployeeMonitorAgent.exe"
  pause
  exit /b %errorlevel%
)

REM Developer fallback for running from source.
where py >nul 2>nul
if errorlevel 1 (
  echo Packaged EmployeeMonitorAgent.exe was not found.
  echo Download and extract the Windows standalone build from the GitHub Actions artifact.
  echo No Python installation is needed when using that packaged build.
  pause
  exit /b 1
)
if not exist config.json (
  copy config.example.json config.json >nul
  echo Created config.json. Edit it, save, and run this file again.
  notepad config.json
  pause
  exit /b 0
)
py -m pip install -r requirements.txt
if errorlevel 1 (
  echo Dependency installation failed.
  pause
  exit /b 1
)
py agent.py
pause
