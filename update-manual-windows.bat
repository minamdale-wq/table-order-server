@echo off
chcp 65001 >nul
title Table Order - manual update
cd /d "%~dp0"
if not exist "%~dp0server.js" (
  echo.
  echo  server.js was not found next to this file.
  echo  Put this file in the table-order-server folder ^(next to start-windows.bat^) and run it again.
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
set "TOD_DIR=%~dp0"
set "TOD_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:TOD_SELF); iex ($t.Substring($t.IndexOf('#PS'+'START#')))"
echo.
pause
exit /b

#PSSTART#
$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $d = $env:TOD_DIR.TrimEnd('\')
  $base = 'https://raw.githubusercontent.com/minamdale-wq/table-order-server/main/'
  $files = @('server.js', 'public/index.html', 'version.json', 'public/closed.jpg')
  Write-Host ''
  Write-Host ' 테이블 오더 서버를 직접 업데이트합니다.' -ForegroundColor Cyan
  Write-Host (' 서버 폴더: ' + $d)

  # 서버 로그에 남은 최근 오류 (원인 확인용)
  $logf = Join-Path $d 'server-log.txt'
  if (Test-Path -LiteralPath $logf) {
    $errs = Get-Content -LiteralPath $logf -Encoding UTF8 -Tail 400 | Where-Object { $_ -match '오류|Error|EPERM|EBUSY|EACCES' } | Select-Object -Last 6
    if ($errs) { Write-Host ''; Write-Host ' [최근 서버 오류 기록]' -ForegroundColor Yellow; $errs | ForEach-Object { Write-Host ('   ' + $_) } }
  }

  # 1) 새 파일 먼저 받기 (받기에 실패하면 아무것도 바꾸지 않음)
  $tmp = Join-Path $env:TEMP ('tod-update-' + [DateTime]::Now.Ticks); New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  foreach ($f in $files) {
    $out = Join-Path $tmp ($f -replace '/', '_')
    Invoke-WebRequest -UseBasicParsing -Uri ($base + $f + '?t=' + [DateTime]::Now.Ticks) -OutFile $out
    if ((Get-Item -LiteralPath $out).Length -lt 100) { throw ($f + ' 파일을 제대로 받지 못했습니다') }
  }
  $ver = (Get-Content -LiteralPath (Join-Path $tmp 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  Write-Host (' 새 버전 ' + $ver + ' 파일을 받았습니다.')

  # 2) 서버 끄기
  $task = Get-ScheduledTask -TaskName 'TableOrderServer' -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName 'TableOrderServer' -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'service-windows\.bat|(^|[\\"\s])start-windows\.bat' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Start-Sleep -Seconds 3
  Write-Host ' 서버를 잠시 껐습니다.'

  # 3) 지금 파일 보관 후 교체
  $bk = Join-Path $d ('data\versions\manual-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  foreach ($f in $files) {
    $dst = Join-Path $d ($f -replace '/', '\'); $src = Join-Path $tmp ($f -replace '/', '_')
    if (Test-Path -LiteralPath $dst) { $b = Join-Path $bk ($f -replace '/', '\'); New-Item -ItemType Directory -Force -Path (Split-Path $b) | Out-Null; Copy-Item -LiteralPath $dst -Destination $b -Force }
    Get-ChildItem -LiteralPath (Split-Path $dst) -Filter ((Split-Path $dst -Leaf) + '.new') -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $ok = $false
    for ($i = 0; $i -lt 20 -and -not $ok; $i++) { try { Copy-Item -LiteralPath $src -Destination $dst -Force; $ok = $true } catch { Start-Sleep -Milliseconds 500 } }
    if (-not $ok) { throw ($f + ' 파일을 바꾸지 못했습니다 (다른 프로그램이 쓰고 있음)') }
  }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ' 파일을 바꿨습니다. (이전 파일은 data\versions 에 보관)'

  # 4) 서버 다시 켜기
  if ($task) { Start-ScheduledTask -TaskName 'TableOrderServer' }
  else { Start-Process -FilePath (Join-Path $d 'start-windows.bat') -WorkingDirectory $d }
  $now = $null
  for ($i = 0; $i -lt 25 -and -not $now; $i++) { Start-Sleep -Seconds 1; try { $r = Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8765/api/info'; $now = $r } catch {} }
  Write-Host ''
  if ($now) {
    Write-Host (' 완료! 서버가 새 버전으로 다시 켜졌습니다.') -ForegroundColor Green
    Write-Host ' 주문받기 화면과 태블릿은 잠시 뒤 저절로 새로고침됩니다.'
  } else {
    Write-Host ' 파일은 바꿨지만 서버가 아직 응답하지 않습니다. 1분 뒤 주문받기 화면을 새로고침해 보세요.' -ForegroundColor Yellow
  }
} catch {
  Write-Host ''
  Write-Host (' 업데이트하지 못했습니다: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host ' 이 창을 사진으로 찍어 보내 주세요. (서버가 꺼졌다면 start-windows.bat 를 실행하세요)'
  $task = Get-ScheduledTask -TaskName 'TableOrderServer' -ErrorAction SilentlyContinue
  if ($task) { try { Start-ScheduledTask -TaskName 'TableOrderServer' } catch {} }
}
