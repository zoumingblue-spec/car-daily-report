@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [%date% %time%] 开始生成汽车配件日报... >> run.log
node generate.js >> run.log 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [%date% %time%] 生成成功 >> run.log
    echo [%date% %time%] 开始推送到 GitHub... >> run.log
    git add reports/ index.html >> run.log 2>&1
    git commit -m "daily report %date%" >> run.log 2>&1
    git push origin main >> run.log 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo [%date% %time%] 推送成功 >> run.log
    ) else (
        echo [%date% %time%] 推送失败，请检查网络或 Git 配置 >> run.log
    )
) else (
    echo [%date% %time%] 生成失败，请检查 run.log >> run.log
)
