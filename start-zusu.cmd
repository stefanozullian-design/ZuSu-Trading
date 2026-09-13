@echo off
rem ---------------------------------------------------------------------------
rem  Double-click this file to start ZuSu Trading.
rem
rem  Everything it does lives in scripts\start.mjs. This wrapper exists for one
rem  reason: when a .cmd file finishes, its window closes. Without the pause
rem  below, a start-up failure would flash a message on screen for a fraction
rem  of a second and then vanish, which is indistinguishable from nothing
rem  happening at all.
rem ---------------------------------------------------------------------------
title ZuSu Trading
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or Windows cannot find it.
  echo.
  echo   Install it from https://nodejs.org and then restart the computer,
  echo   so that Windows picks up the change.
  echo.
  echo   Press any key to close this window.
  pause >nul
  exit /b 1
)

node scripts\start.mjs

if errorlevel 1 (
  echo.
  echo   ZuSu stopped because of the problem above.
  echo   This window is staying open so you can read it.
  echo.
  echo   Press any key to close.
  pause >nul
)
