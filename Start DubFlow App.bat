@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\bootstrap.ps1"
if errorlevel 1 (
  echo.
  echo DubFlow chua the cai dependency. Sua loi ben tren roi chay lai file nay.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Frontend\electron\launch-hidden.ps1"
if errorlevel 1 (
  echo.
  echo DubFlow app bi loi khi khoi dong. Xem Frontend\.dubflow\logs de biet chi tiet.
  pause
  exit /b 1
)
