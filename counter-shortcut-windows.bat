@echo off
chcp 65001 >nul
title Table Order - counter screen shortcut
set "TOD_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:TOD_SELF); iex ($t.Substring($t.IndexOf('#PS'+'START#')))"
echo.
pause
exit /b

#PSSTART#
try {
  $cands = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  $br = $cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $br) { throw '크롬(또는 엣지)을 찾지 못했습니다' }
  $prof = Join-Path $env:LOCALAPPDATA 'TableOrderCounter'
  New-Item -ItemType Directory -Force -Path $prof | Out-Null
  $helper = Join-Path $prof 'open-counter.bat'
  $h = @"
@echo off
rem 서버가 켜질 때까지 기다렸다가 주문받기 화면을 엽니다 (최대 3분)
for /l %%i in (1,1,90) do (
  curl -s -o nul -m 2 http://127.0.0.1:8765/api/info && goto go
  ping -n 3 127.0.0.1 >nul
)
:go
start "" "$br" --app=http://localhost:8765/#t7 --user-data-dir="$prof\profile" --autoplay-policy=no-user-gesture-required --start-maximized --no-first-run --no-default-browser-check --disable-features=Translate
"@
  $h = ($h -replace "`r", '') -replace "`n", "`r`n"
  [IO.File]::WriteAllText($helper, $h, (New-Object Text.UTF8Encoding $false))
  $ws = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'))) {
    $s = $ws.CreateShortcut((Join-Path $dir '주문받기.lnk'))
    $s.TargetPath = "$env:SystemRoot\System32\cmd.exe"; $s.Arguments = '/c "' + $helper + '"'; $s.WindowStyle = 7
    $s.IconLocation = "$br,0"; $s.Description = '테이블 오더 주문받기 화면 (알림음 자동)'; $s.Save()
  }
  Write-Host ''
  Write-Host ' 완료! 바탕화면에 "주문받기" 바로가기를 만들었습니다.' -ForegroundColor Green
  Write-Host ' - 이 바로가기로 열면 알림음이 화면을 누르지 않아도 자동으로 켜집니다.'
  Write-Host ' - 윈도우에 로그인하면 주문받기 화면이 자동으로 열립니다 (서버가 켜질 때까지 기다렸다가).'
  Write-Host ' - 처음 한 번은 관리 PIN을 넣어야 합니다. 그 뒤로는 기억합니다.'
  Write-Host ' - 지금 열려 있는 크롬의 주문받기 탭은 닫아 주세요 (두 화면에서 소리가 겹칩니다).'
  Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList ('/c "' + $helper + '"') -WindowStyle Minimized
} catch {
  Write-Host (' 만들지 못했습니다: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host ' 이 창을 사진으로 찍어 보내 주세요.'
}
