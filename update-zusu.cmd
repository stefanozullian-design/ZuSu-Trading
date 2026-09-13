@echo off
rem ---------------------------------------------------------------------------
rem  Double-click this to get the newest version of ZuSu.
rem
rem  Separate from start-zusu.cmd on purpose: starting the app and changing the
rem  code it runs are different acts, and an update that arrives unannounced
rem  while you are looking at positions is the wrong kind of surprise.
rem ---------------------------------------------------------------------------
title ZuSu Trading — update
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or Windows cannot find it.
  echo   Press any key to close this window.
  pause >nul
  exit /b 1
)

node scripts\update.mjs

echo.
echo   Press any key to close.
pause >nul
