@echo off
chcp 65001 >nul
title Table Order - turn off auto start
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Administrator permission is needed. Click YES on the next window.
  set "TOD_SELF=%~f0"
  powershell -NoProfile -Command "Start-Process -FilePath $env:TOD_SELF -Verb RunAs"
  exit /b
)
set "TOD_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:TOD_SELF); iex ($t.Substring($t.IndexOf('#PS'+'START#')))"
echo.
pause
exit /b

#PSSTART#
try {
  if (Get-ScheduledTask -TaskName 'TableOrderServer' -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName 'TableOrderServer' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'TableOrderServer' -Confirm:$false
    Write-Host ' 자동 실행을 껐습니다.'
  } else { Write-Host ' 자동 실행이 설정되어 있지 않습니다.' }
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*service-windows.bat*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Write-Host ' 뒤에서 돌던 서버도 껐습니다. 다시 켜려면 start-windows.bat 또는 자동실행-설정을 실행하세요.'
} catch { Write-Host (' 오류: ' + $_.Exception.Message) -ForegroundColor Red }
