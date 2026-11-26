@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
cd /d "%ROOT%"

REM Find the packaged executable even if the ZIP was extracted with nested folders.
set "AGENT_EXE="
for /r "%ROOT%" %%F in (EmployeeMonitorAgent.exe) do (
  if not defined AGENT_EXE set "AGENT_EXE=%%~fF"
)

if not defined AGENT_EXE (
  echo EmployeeMonitorAgent.exe was not found anywhere inside:
  echo %ROOT%
  echo.
  echo Please download the newest employee-monitor-windows artifact from GitHub Actions
  echo and extract the entire ZIP into a new, empty folder.
  pause
  exit /b 1
)

for %%D in ("%AGENT_EXE%") do set "AGENT_DIR=%%~dpD"

REM Ensure the example config is beside the executable.
if not exist "%AGENT_DIR%config.example.json" (
  if exist "%ROOT%config.example.json" copy "%ROOT%config.example.json" "%AGENT_DIR%config.example.json" >nul
)

REM First run: create config and open it in Notepad.
if not exist "%AGENT_DIR%config.json" (
  copy "%AGENT_DIR%config.example.json" "%AGENT_DIR%config.json" >nul
  if errorlevel 1 (
    echo Could not create config.json. Check that config.example.json exists.
    pause
    exit /b 1
  )
  echo Enter the employee name in config.json, save, and close Notepad.
  notepad "%AGENT_DIR%config.json"
  echo.
  echo Now run run-agent.bat again.
  pause
  exit /b 0
)

pushd "%AGENT_DIR%"
"%AGENT_EXE%"
set "RESULT=%errorlevel%"
popd
echo.
echo Agent stopped with exit code %RESULT%.
pause
exit /b %RESULT%
