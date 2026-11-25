@echo off
chcp 65001 >nul
title Table Order - open firewall port 8765
rem --- Run as administrator (Windows asks "Allow changes?" -> Yes) ---
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo  Opening TCP port 8765 for the Table Order server (all network types)...
netsh advfirewall firewall delete rule name="Table Order 8765" >nul 2>&1
netsh advfirewall firewall add rule name="Table Order 8765" dir=in action=allow protocol=TCP localport=8765 profile=any
if errorlevel 1 (
  echo.
  echo  FAILED. Please take a photo of this window and send it.
) else (
  echo.
  echo  DONE. Tablets can now connect to this PC on port 8765.
  echo  Refresh the page on the tablet.
)
echo.
pause
