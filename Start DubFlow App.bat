@echo off
title DubFlow App

rem Kiem tra thu vien da duoc cai dat hay chua
if not exist "%~dp0Backend\node_modules" goto INSTALL_DEPS
if not exist "%~dp0Frontend\node_modules" goto INSTALL_DEPS
if not exist "%~dp0Frontend\.dubflow\python-path.txt" goto INSTALL_DEPS

goto RUN_APP

:INSTALL_DEPS
echo [THONG BAO] Thu vien chua duoc cai dat. Dang khoi chay cai dat thu vien...
echo.
call "%~dp0Install Dependencies.bat"
if errorlevel 1 (
  echo.
  echo [LOI] Khong the cai dat thu vien. Khong the khoi dong ung dung.
  pause
  exit /b 1
)
echo.

:RUN_APP
echo Dang khoi dong ung dung DubFlow (hien thi log truc tiep)...
echo.
cd /d "%~dp0Frontend"
node electron/start-app.js
if errorlevel 1 (
  echo.
  echo [LOI] DubFlow app bi loi khi khoi dong. Xem thong bao loi ben tren.
  pause
  exit /b 1
)
