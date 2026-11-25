@echo off
chcp 65001 >nul
title Table Order - auto start setup
rem Put this file in the table-order-server folder (next to start-windows.bat) and double-click it.
cd /d "%~dp0"
if not exist "%~dp0start-windows.bat" (
  echo.
  echo  start-windows.bat was not found next to this file.
  echo  Move this file into the table-order-server folder and run it again.
  echo.
  pause
  exit /b
)
set "TOD_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:TOD_DIR; $lnk=Join-Path ([Environment]::GetFolderPath('Startup')) 'Table Order Server.lnk'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($lnk); $s.TargetPath=(Join-Path $d 'start-windows.bat'); $s.WorkingDirectory=$d; $s.WindowStyle=7; $s.Description='Table Order mini server'; $s.Save(); if(Test-Path $lnk){exit 0}else{exit 1}"
if errorlevel 1 (
  echo.
  echo  FAILED to create the startup shortcut. Please take a photo of this window and send it.
) else (
  echo.
  echo  DONE. The Table Order server will start automatically every time you sign in to Windows.
  echo  (The server window starts minimized on the taskbar.)
  echo  To turn this off: press Win+R, type shell:startup, delete "Table Order Server".
)
echo.
pause
