@echo off
rem ---------------------------------------------------------------------------
rem  Double-click this once. It puts a ZuSu Trading icon on your desktop.
rem
rem  It creates a shortcut and nothing else: no installer, no registry entry,
rem  no service. Deleting the icon undoes it completely.
rem ---------------------------------------------------------------------------
title ZuSu Trading — desktop icon
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$here = (Get-Location).Path;" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$link = Join-Path $desktop 'ZuSu Trading.lnk';" ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "$s = $shell.CreateShortcut($link);" ^
  "$s.TargetPath = Join-Path $here 'start-zusu.cmd';" ^
  "$s.WorkingDirectory = $here;" ^
  "$s.IconLocation = (Join-Path $here 'assets\zusu.ico') + ',0';" ^
  "$s.Description = 'Start ZuSu Trading';" ^
  "$s.Save();" ^
  "Write-Host '';" ^
  "Write-Host ('  Done. There is now a ZuSu Trading icon on your desktop.');" ^
  "Write-Host ('  ' + $link);"

if errorlevel 1 (
  echo.
  echo   The shortcut could not be created. The message above says why.
) else (
  echo.
  echo   Double-click that icon to start ZuSu. You can also drag it onto
  echo   the taskbar to pin it there.
)

echo.
echo   Press any key to close this window.
pause >nul
