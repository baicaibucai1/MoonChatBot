@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ====================================
echo   QQ 机器人管理面板
echo ====================================
if not exist .env (
  echo [警告] 尚未配置 .env 文件！
  echo 请先复制 .env.example 为 .env，并填入你的 AppID/Token/API Key
  pause
  exit /b 1
)
node server.js
pause