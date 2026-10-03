@echo off
rem Starts Fleetline on this Windows computer: server, simulated drivers and (optionally) a public phone link.
rem Double-click this file. Close the windows it opens to stop everything.
setlocal
cd /d "%~dp0backend"

where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)

if not exist node_modules (
  echo Installing server packages, first run only...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
if not exist data\fleetline.db (
  echo Creating demo data...
  call npm run seed || (pause & exit /b 1)
)

echo Starting the server...
start "Fleetline server" cmd /k "npm start"
timeout /t 4 /nobreak >nul

set /p SIM="Run simulated drivers so vehicles move on the map? (Y/N) "
if /i "%SIM%"=="Y" start "Fleetline simulated drivers" cmd /k "npm run simulate -- --speed 2"

rem The cloudflared path contains "(x86)", so this part avoids ( ) blocks, which would break on it.
set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not exist "%CF%" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if not exist "%CF%" goto openbrowser
set /p TUN="Create a public https link for your phone? (Y/N) "
if /i not "%TUN%"=="Y" goto openbrowser
start "Fleetline phone link" "%CF%" tunnel --no-autoupdate --url http://localhost:4000
echo The phone link appears in the "Fleetline phone link" window as https://something.trycloudflare.com
echo Add /driver/ to the end of it on your phone.

:openbrowser
start "" http://localhost:4000
echo.
echo Dispatch console: http://localhost:4000      (dispatch / dispatch123)
echo Driver app:       http://localhost:4000/driver/  (tom / driver123)
echo.
echo To stop Fleetline, close the windows titled "Fleetline ...".
pause
