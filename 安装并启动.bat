@echo off
rem ============================================================
rem  MoonChatBot - one-click: install deps -> prepare config -> run
rem  Double-click this file after cloning / downloading from GitHub.
rem ============================================================
title MoonChatBot - Install & Run
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Please install it first from https://nodejs.org  (LTS is fine)
  pause
  exit /b 1
)

echo.
echo [1/3] Installing dependencies (npm install)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your network and try again.
  pause
  exit /b 1
)

echo.
echo [2/3] Preparing configuration files...
node setup.js

echo.
echo [3/3] Starting the panel at http://127.0.0.1:4357 ...
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:4357"
node server.js

echo.
echo Server exited.
pause
