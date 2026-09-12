@echo off
title Updating DeviceFarm Agent
cd /d "%~dp0"

echo ================================================================
echo  Updating DeviceFarm Agent to latest code...
echo ================================================================
echo.

echo [*] Terminating running agent processes...
taskkill /F /IM electron.exe >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq DeviceFarm*" >nul 2>&1
PowerShell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^(electron|node)\.exe$') -and ($_.CommandLine -and ($_.CommandLine -match 'service-watchdog' -or $_.CommandLine -match 'devicefarm-agent')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }"

echo [*] Pulling latest updates from GitHub...
git pull origin main

echo.
echo [*] Starting updated agent in background...
if exist "Start-Agent-Silent.vbs" (
    wscript.exe "Start-Agent-Silent.vbs"
    echo [OK] DeviceFarm Agent started silently in background!
) else (
    start npm start
    echo [OK] DeviceFarm Agent started!
)

echo.
echo ================================================================
echo  [SUCCESS] DeviceFarm Agent is updated and streaming!
echo  Check your CCTV wall: https://dennoh.site/seed-admin
echo ================================================================
echo.
timeout /t 5
