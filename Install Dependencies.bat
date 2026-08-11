@echo off
title Cai dat Thu vien DubFlow
echo ====================================================
echo   Dang kiem tra va cai dat thu vien / dependency...
echo ====================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\bootstrap.ps1"
if errorlevel 1 (
  echo.
  echo [LOI] DubFlow chua the cai dat dependency. Sua loi ben tren roi chay lai file nay.
  pause
  exit /b 1
)
echo.
echo [THANH CONG] Da cai dat day du thu vien cho DubFlow!
echo.
pause
