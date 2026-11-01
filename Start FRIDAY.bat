@echo off
rem  FRIDAY - starts in the background and opens her app window.
rem  Nothing to keep open: the assistant keeps running until you quit from Settings.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get the LTS version from https://nodejs.org
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\app.ps1"
if errorlevel 1 (
  echo.
  echo   FRIDAY could not start. See data\app.log
  pause
)
exit /b 0
