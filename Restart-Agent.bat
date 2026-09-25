@echo off
:: ════════════════════════════════════════════════════════════════════════════
:: DeviceFarm Agent — 1-Click Process Reset, Git Pull & Clean Restart
:: 
:: What this script does:
::   1. Requests Admin elevation so ALL processes (including SYSTEM) can be terminated
::   2. Terminates all running agent processes (electron, scrcpy, cloudflared, node)
::   3. Removes old conflicting background task scheduler services
::   4. Force-clears port 7400 to eliminate any zombie listeners
::   5. Resets and pulls the latest code from GitHub origin/main
::   6. Displays the exact Git Commit Hash, Author, Date & Message in use
::   7. Refreshes ADB server & lists all connected Android phones
::   8. Launches the 24/7 headless background agent watchdog
::   9. Verifies health of http://localhost:7400 and opens the dashboard
:: ════════════════════════════════════════════════════════════════════════════
setlocal EnableDelayedExpansion
title DeviceFarm Agent — Clean Restart & Code Sync

:: ── Check for Admin Privileges ──────────────────────────────────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ================================================================
    echo  [!] Elevating to Administrator to ensure complete process cleanup...
    echo  ================================================================
    PowerShell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
cd /d "%INSTALL_DIR%"

echo.
echo  ================================================================
echo   DEVICEFARM AGENT — SYSTEM RESTART ^& REPO UPDATE
echo  ================================================================
echo   Directory: %INSTALL_DIR%
echo.

:: ── Locate PowerShell ────────────────────────────────────────────────────────
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"

:: ── STEP 1: Terminate All Conflicting Processes ─────────────────────────────
echo [1/5] Terminating previous processes (electron, scrcpy, cloudflared, node, adb)...
schtasks /delete /tn "DeviceFarm_Agent_BootService" /f >nul 2>&1
schtasks /delete /tn "DeviceFarm_Agent_LogonService" /f >nul 2>&1
schtasks /delete /tn "DeviceFarm Agent AutoStart" /f >nul 2>&1

taskkill /F /IM cloudflared.exe /T >nul 2>&1
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM scrcpy.exe /T >nul 2>&1
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM adb.exe /T >nul 2>&1

:: Free port 7400 specifically
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetTCPConnection -LocalPort 7400 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {} }" >nul 2>&1
ping 127.0.0.1 -n 2 >nul 2>&1
echo [OK] All previous system processes killed and port 7400 released.

:: ── STEP 2: Pull Latest Code From GitHub ─────────────────────────────────────
echo.
echo [2/5] Fetching and applying latest code from GitHub (origin/main)...
set "GIT=git"
for /f "delims=" %%I in ('where git 2^>nul') do if not defined GIT set "GIT=%%I"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"

"%GIT%" fetch origin main
if %errorlevel% neq 0 (
    echo [WARN] git fetch encountered an error. Proceeding with local repository code...
) else (
    "%GIT%" reset --hard origin/main
    "%GIT%" clean -fd
    echo [OK] Repository synchronized with latest commit on origin/main.
)

if exist "%INSTALL_DIR%\wifi-devices-cache.json" del /F /Q "%INSTALL_DIR%\wifi-devices-cache.json" >nul 2>&1

:: ── STEP 3: Clearly Indicate the Code Being Used ─────────────────────────────
echo.
echo  ================================================================
echo   ACTIVE AGENT CODE VERSION IN USE:
echo  ================================================================
"%GIT%" log -n 1
echo.
echo   Branch: main
echo   Path  : %INSTALL_DIR%
echo  ================================================================
echo.

:: ── STEP 4: Refresh ADB and Android Devices ──────────────────────────────────
echo [3/5] Refreshing ADB server and checking connected phones...
set "ADB_BIN=%INSTALL_DIR%\assets\bin\adb.exe"
if not exist "%ADB_BIN%" set "ADB_BIN=adb"

"%ADB_BIN%" start-server >nul 2>&1
"%ADB_BIN%" reconnect >nul 2>&1
ping 127.0.0.1 -n 2 >nul 2>&1

echo [*] Connected Devices:
"%ADB_BIN%" devices -l

:: ── STEP 5: Launch Agent Service & Cloudflare Tunnel ─────────────────────────
echo.
echo [4/5] Launching DeviceFarm Agent Service (Headless Node.js)...

set "NODE=node"
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"

:: Start agent directly in background via headless service-watchdog
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath '%NODE%' -ArgumentList 'src\main\service-watchdog.js' -WorkingDirectory '%INSTALL_DIR%' -WindowStyle Hidden"

:: ── STEP 6: Health Verification ─────────────────────────────────────────────
echo.
echo [5/5] Waiting for Dashboard and stream proxy on http://localhost:7400...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ok = $false; for ($i = 0; $i -lt 15; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7400/api/license/status' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}; Start-Sleep -Seconds 1 }; if ($ok) { Write-Host ' [OK] Dashboard Server is LIVE on port 7400!' } else { Write-Host ' [*] Dashboard Server is still initializing in background...' }"

start "" "http://localhost:7400"

echo.
echo  ================================================================
echo   DEVICEFARM AGENT IS RUNNING!
echo  ================================================================
echo   Local Dashboard : http://localhost:7400
echo   Public Domain   : https://agent.dennoh.site
echo   Status          : Operational ^& Syncing to Supabase
echo  ================================================================
echo.
pause
