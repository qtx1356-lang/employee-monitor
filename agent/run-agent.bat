@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher not found. Install Python 3.11 or newer from https://www.python.org/downloads/windows/ and enable Add Python to PATH.
  pause
  exit /b 1
)
if not exist config.json (
  copy config.example.json config.json >nul
  echo Created config.json. Edit it with your Worker URL, enrollment code, employee name, device name, and approved work folders.
  notepad config.json
  echo Save and close Notepad, then run this file again.
  pause
  exit /b 0
)
py -m pip install --upgrade pip
py -m pip install -r requirements.txt
if errorlevel 1 (
  echo Dependency installation failed.
  pause
  exit /b 1
)
py agent.py
pause
