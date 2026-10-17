@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo          一起玩牌 - 启动程序
echo ========================================
where node >nul 2>nul
if errorlevel 1 (
  echo 没有检测到 Node.js。
  echo 请先安装 Node.js 18 或更高版本，然后重新双击本文件。
  echo 官网：https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo 正在首次安装运行依赖，请保持网络连接……
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
echo 程序启动后，请在浏览器打开 http://localhost:3000
echo 按 Ctrl+C 可以停止程序。
call npm start
pause
