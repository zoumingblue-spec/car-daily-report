@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo   汽车配件日报 — 一键初始化
echo ========================================
echo.
echo [1/2] 安装依赖...
npm install
if %ERRORLEVEL% NEQ 0 (
    echo 安装失败，请确认已安装 Node.js
    pause & exit /b 1
)
echo.
echo [2/2] 立即生成第一份日报...
node generate.js
if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ 初始化完成！
    echo.
    echo 请用浏览器打开: %~dp0index.html
    echo.
    echo ── 设置每日自动更新 ─────────────────────
    echo 运行以下命令打开任务计划程序向导:
    echo   schtasks /create /tn "汽车配件日报" /tr "%~dp0run.bat" /sc daily /st 07:00 /f
    echo.
) else (
    echo ❌ 生成失败，请检查错误信息
)
pause
