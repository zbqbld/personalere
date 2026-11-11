@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
REM Next 16 dev rejects HMR websocket upgrades from 127.0.0.1, which stalls
REM hydration and leaves the boot overlay on screen. Always use localhost.
set "URL=http://localhost:3000/chart"

REM Dev mode needs no production build. First request triggers a compile that can
REM take 1-2 minutes on a cold start, so poll until the page really answers
REM instead of opening the browser after a fixed delay.

echo [Ziwei Doushu] Checking port 3000...
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [Ziwei Doushu] A local server is already running; reusing it.
  goto WAIT
)

echo [Ziwei Doushu] Starting local server (dev mode)...
echo [Ziwei Doushu] Keep the "Ziwei Dev Server" window open while using the app.
start "Ziwei Dev Server" cmd /k "npm run dev"

:WAIT
echo [Ziwei Doushu] Waiting for the page to become ready (first compile can take 1-2 min)...
for /L %%i in (1,1,90) do (
  curl -s -o NUL --max-time 5 "%URL%" >nul 2>&1
  if not errorlevel 1 goto READY
  ping -n 3 127.0.0.1 >nul 2>&1
)

echo [Ziwei Doushu] Timed out after about 3 minutes.
echo [Ziwei Doushu] Please read the error message in the "Ziwei Dev Server" window.
pause
exit /b 1

:READY
echo [Ziwei Doushu] Ready. Opening %URL%
start "" "%URL%"
