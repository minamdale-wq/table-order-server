@echo off
chcp 65001 >nul
title Table Order Mini Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Please install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b
)
set TOD_SUPERVISED=1
:loop
node server.js
echo.
echo  Server stopped. Restarting in 3 seconds... (close this window to stop)
timeout /t 3 >nul
goto loop
