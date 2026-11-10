@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM Dev mode does not require .next production output; avoids startup failure after an interrupted build.
echo [Ziwei Doushu] Starting local server (dev mode)...
start "" cmd /k "npm run dev"
timeout /t 12 >nul
echo [Ziwei Doushu] Opening browser -> http://localhost:3000/
start http://localhost:3000/
