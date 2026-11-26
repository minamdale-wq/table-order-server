@echo off
chcp 65001 >nul
title Table Order - auto start setup (v2)
cd /d "%~dp0"
if not exist "%~dp0server.js" (
  echo.
  echo  server.js was not found next to this file.
  echo  Put this file in the table-order-server folder, next to start-windows.bat, and run it again.
  echo.
  pause
  exit /b
)
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Administrator permission is needed. Click YES on the next window.
  set "TOD_SELF=%~f0"
  powershell -NoProfile -Command "Start-Process -FilePath $env:TOD_SELF -Verb RunAs"
  exit /b
)
set "TOD_NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined TOD_NODE set "TOD_NODE=%%i"
if not defined TOD_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "TOD_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined TOD_NODE (
  echo.
  echo  Node.js was not found. Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b
)
set "TOD_DIR=%~dp0"
set "TOD_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:TOD_SELF); iex ($t.Substring($t.IndexOf('#PS'+'START#')))"
echo.
pause
exit /b

#PSSTART#
$ErrorActionPreference = 'Stop'
try {
  $d = $env:TOD_DIR.TrimEnd('\'); $node = $env:TOD_NODE
  Write-Host ''
  Write-Host ' 테이블 오더 서버 자동 실행을 설정합니다.' -ForegroundColor Cyan
  Write-Host (' 서버 폴더: ' + $d)
  Write-Host (' Node.js : ' + $node)
  $svc = Join-Path $d 'service-windows.bat'
  $bat = @"
@echo off
chcp 65001 >nul
title Table Order Server (auto)
cd /d "%~dp0"
set TOD_SUPERVISED=1
:loop
if exist "%~dp0server-log.txt" for %%A in ("%~dp0server-log.txt") do if %%~zA GTR 5000000 move /y "%~dp0server-log.txt" "%~dp0server-log-old.txt" >nul
"$node" server.js >> "%~dp0server-log.txt" 2>&1
if "%errorlevel%"=="3" exit /b
ping -n 4 127.0.0.1 >nul
goto loop
"@
  $bat = ($bat -replace "`r", '') -replace "`n", "`r`n"
  [IO.File]::WriteAllText($svc, $bat, (New-Object Text.UTF8Encoding $false))

  # 예전 방식(로그인해야 켜지는 시작 프로그램 바로가기)은 지움
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Table Order Server.lnk'
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Host ' 예전 시작 프로그램 바로가기를 지웠습니다.' }

  # 컴퓨터가 켜지면(로그인 전에도) 서버를 켜는 예약 작업
  $a  = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument ('/c "' + $svc + '"') -WorkingDirectory $d
  $tr = New-ScheduledTaskTrigger -AtStartup; $tr.Delay = 'PT20S'
  $p  = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $st = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'TableOrderServer' -Action $a -Trigger $tr -Principal $p -Settings $st -Force | Out-Null
  Write-Host ' 예약 작업 TableOrderServer 를 만들었습니다.'

  # 지금 열려 있는 서버 창이 있으면 닫고 새 방식으로 켬
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match '(^|[\\"\s])start-windows\.bat' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName 'TableOrderServer'
  Write-Host ' 서버를 켜는 중입니다…'
  $ok = $false
  for ($i = 0; $i -lt 20 -and -not $ok; $i++) { Start-Sleep -Seconds 1; try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8765/api/info'; if ($r.StatusCode -eq 200) { $ok = $true } } catch {} }
  Write-Host ''
  if ($ok) {
    Write-Host ' 완료! 서버가 켜졌습니다. 이제 컴퓨터를 켜면 로그인하지 않아도 서버가 자동으로 켜집니다.' -ForegroundColor Green
    Write-Host ' 서버는 화면에 창 없이 뒤에서 돌아갑니다. 확인: 크롬에서 http://localhost:8765/#t7'
    Write-Host ' 서버 기록은 서버 폴더의 server-log.txt 에 남습니다.'
    Write-Host ' 이제 start-windows.bat 는 누르지 않아도 됩니다. (눌러도 "이미 켜져 있습니다" 하고 닫힙니다)'
  } else {
    Write-Host ' 예약 작업은 만들었지만 서버가 아직 응답하지 않습니다.' -ForegroundColor Yellow
    Write-Host (' 서버 폴더의 server-log.txt 를 열어 마지막 줄을 사진으로 보내 주세요: ' + (Join-Path $d 'server-log.txt'))
  }
} catch {
  Write-Host ''
  Write-Host (' 설정하지 못했습니다: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host ' 이 창을 사진으로 찍어 보내 주세요.'
}
