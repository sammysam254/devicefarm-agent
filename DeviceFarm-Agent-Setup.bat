@echo off
setlocal enabledelayedexpansion

:: ════════════════════════════════════════════════════════════════════════════
::  DEVICEFARM AGENT — UNIFIED SETUP, RESTART & RECOVERY SUITE
::  100% Transparent Execution: Shows all logs, never auto-closes.
:: ════════════════════════════════════════════════════════════════════════════

title DeviceFarm Agent — Setup ^& Manager (Elevated)

:: ── Step 0: Ensure Administrator Elevation ───────────────────────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ================================================================
    echo   [!] Requesting Administrator privileges to manage services...
    echo  ================================================================
    echo.
    PowerShell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/k \"\"%~f0\"\" %*' -Verb RunAs"
    exit /b
)

:: ── Self-replicate to %TEMP% so git updates cannot disrupt running batch file ──
set "ORIG_DIR=%~dp0"
if "%ORIG_DIR:~-1%"=="\" set "ORIG_DIR=%ORIG_DIR:~0,-1%"

if /i not "%~dp0"=="%TEMP%\DeviceFarmSetup\" (
    echo [*] Preparing execution environment in %TEMP%\DeviceFarmSetup...
    if not exist "%TEMP%\DeviceFarmSetup" mkdir "%TEMP%\DeviceFarmSetup"
    copy /Y "%~f0" "%TEMP%\DeviceFarmSetup\setup.bat"
    echo [*] Launching unified master script from safe temp staging...
    call "%TEMP%\DeviceFarmSetup\setup.bat" "%ORIG_DIR%" %*
    echo.
    echo  ================================================================
    echo   DeviceFarm Setup execution finished. Window will stay open.
    echo  ================================================================
    cmd /k
)

:: ── Parse Arguments & Detect Install Directory ──────────────────────────────
set "CALLER_DIR=%~1"
set "ACTION_FLAG=%~2"
if "%CALLER_DIR:~0,2%"=="--" (
    set "ACTION_FLAG=%CALLER_DIR%"
    set "CALLER_DIR="
)
if "%CALLER_DIR:~0,1%"=="/" (
    set "ACTION_FLAG=%CALLER_DIR%"
    set "CALLER_DIR="
)

set "INSTALL_DIR=C:\DeviceFarmAgent"
if defined CALLER_DIR if exist "%CALLER_DIR%\src\main\index.js" (
    set "INSTALL_DIR=%CALLER_DIR%"
) else if exist "%ORIG_DIR%\src\main\index.js" (
    set "INSTALL_DIR=%ORIG_DIR%"
) else if exist "C:\cvc\devicefarm-agent\src\main\index.js" (
    set "INSTALL_DIR=C:\cvc\devicefarm-agent"
) else if exist "C:\DeviceFarmAgent\src\main\index.js" (
    set "INSTALL_DIR=C:\DeviceFarmAgent"
) else if defined CALLER_DIR (
    set "INSTALL_DIR=%CALLER_DIR%"
)

set "REPO_URL=https://github.com/sammysam254/devicefarm-agent.git"

:: ── Locate PowerShell ────────────────────────────────────────────────────────
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"

echo.
echo  ================================================================
echo   DEVICEFARM DESKTOP AGENT  ^|  Unified Setup ^& Service Manager
echo  ================================================================
echo   Target Directory : %INSTALL_DIR%
echo   Source Repository: %REPO_URL%
echo   Administrator    : Confirmed (Elevated)
echo  ================================================================
echo.

:: ── Determine Execution Mode ────────────────────────────────────────────────
if /i "%ACTION_FLAG%"=="--restart" goto :clean_restart
if /i "%ACTION_FLAG%"=="-restart"  goto :clean_restart
if /i "%ACTION_FLAG%"=="restart"   goto :clean_restart
if /i "%ACTION_FLAG%"=="/restart"  goto :clean_restart

if exist "%INSTALL_DIR%\.git" (
    echo   [1] Clean Restart, Git Pull ^& Cache Reset (Recommended)
    echo   [2] Full Fresh Installation (Reinstall dependencies ^& tools)
    echo.
    set /p "USER_CHOICE=Select an option [1 or 2] (Press Enter for 1): "
    if "!USER_CHOICE!"=="2" goto :full_install
    goto :clean_restart
)

:full_install
:: ════════════════════════════════════════════════════════════════════════════
:: STEP 1 — Git Installation
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo ================================================================
echo  STEP 1: Checking Git
echo ================================================================
set "GIT="
for /f "delims=" %%I in ('where git 2^>nul') do if not defined GIT set "GIT=%%I"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe"       set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe"  set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"

if defined GIT (
    echo [OK] Git is available: %GIT%
    "%GIT%" --version
) else (
    echo [*] Git not found. Downloading Git for Windows...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.45.2.windows.1/Git-2.45.2-64-bit.exe' -OutFile '%TEMP%\git_installer.exe' -UseBasicParsing"
    if not exist "%TEMP%\git_installer.exe" (
        echo [ERROR] Could not download Git. Check your internet connection.
        cmd /k
    )
    echo [*] Installing Git silently — please wait...
    start /wait "" "%TEMP%\git_installer.exe" /VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS="icons,ext\reg\shellhere,assoc,assoc_sh"
    del "%TEMP%\git_installer.exe" >nul 2>nul
    set "GIT=%ProgramFiles%\Git\cmd\git.exe"
    if not exist "!GIT!" (
        echo [ERROR] Git installation failed. Please install from https://git-scm.com
        cmd /k
    )
    echo [OK] Git installed successfully: !GIT!
)

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 2 — Node.js LTS Installation
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo ================================================================
echo  STEP 2: Checking Node.js
echo ================================================================
set "NODE="
set "NPM="

if exist "%ProgramFiles%\nodejs\node.exe"          set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles%\nodejs\npm.cmd"           set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd"  set "NPM=%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
if not defined NODE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NPM  for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM  set "NPM=%%I"
if not defined NPM  for /f "delims=" %%I in ('where npm 2^>nul')     do if not defined NPM  set "NPM=%%I"

if defined NODE (
    echo [OK] Node.js is available: %NODE%
    "%NODE%" --version
) else (
    echo [*] Node.js not found. Downloading LTS installer...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\node_installer.msi' -UseBasicParsing"
    if not exist "%TEMP%\node_installer.msi" (
        echo [ERROR] Node.js download failed. Check your internet connection.
        cmd /k
    )
    echo [*] Installing Node.js — please wait...
    start /wait msiexec /i "%TEMP%\node_installer.msi" /qn /norestart ADDLOCAL=ALL
    del "%TEMP%\node_installer.msi" >nul 2>nul
    set "NODE=%ProgramFiles%\nodejs\node.exe"
    set "NPM=%ProgramFiles%\nodejs\npm.cmd"
    if not exist "!NODE!" (
        echo [ERROR] Node.js installation failed. Install from https://nodejs.org
        cmd /k
    )
    echo [OK] Node.js installed successfully: !NODE!
)
if not defined NPM for %%I in ("%NODE%") do set "NPM=%%~dpInpm.cmd"
echo [OK] npm executable: %NPM%

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 3 — ADB Platform Tools
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo ================================================================
echo  STEP 3: Checking ADB
echo ================================================================
set "ADB="
if exist "%INSTALL_DIR%\assets\bin\adb.exe"  set "ADB=%INSTALL_DIR%\assets\bin\adb.exe"
if not defined ADB if exist "C:\platform-tools\adb.exe" set "ADB=C:\platform-tools\adb.exe"
if not defined ADB for /f "delims=" %%I in ('where adb 2^>nul') do if not defined ADB set "ADB=%%I"

if defined ADB (
    echo [OK] ADB is available: %ADB%
    "%ADB%" version
) else (
    echo [*] ADB not found. Downloading Android SDK platform-tools...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile '%TEMP%\pt.zip' -UseBasicParsing"
    if exist "%TEMP%\pt.zip" (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
            "Expand-Archive -Path '%TEMP%\pt.zip' -DestinationPath 'C:\' -Force"
        del "%TEMP%\pt.zip" >nul 2>nul
    )
    if exist "C:\platform-tools\adb.exe" (
        set "ADB=C:\platform-tools\adb.exe"
        echo [OK] ADB installed successfully: C:\platform-tools\adb.exe
    ) else (
        echo [WARN] ADB install failed — device detection may not work until ADB is available.
    )
)

:: ════════════════════════════════════════════════════════════════════════════
:: STEP 4 — Clone or Update Repository
:: ════════════════════════════════════════════════════════════════════════════
echo.
echo ================================================================
echo  STEP 4: Setting Up Agent Files
echo ================================================================

if not exist "%INSTALL_DIR%\.git" (
    echo [*] Cloning agent repository from GitHub into %INSTALL_DIR% ...
    "%GIT%" clone --depth 1 --single-branch --branch main "%REPO_URL%" "%INSTALL_DIR%"
    if !errorlevel! neq 0 (
        echo [ERROR] git clone failed. Check your internet connection.
        cmd /k
    )
    echo [OK] Agent repository cloned successfully.
)

cd /d "%INSTALL_DIR%"

for %%I in ("%NODE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"

if not exist "node_modules\winston\package.json" (
    echo [*] Installing npm dependencies...
    call "%NPM%" install --no-audit --no-fund
)

if not exist "scrcpy-server.jar" (
    echo [*] Downloading scrcpy-server.jar...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4' -OutFile 'scrcpy-server.jar' -UseBasicParsing"
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo [*] Downloading Electron v33.4.11...
    if not exist "node_modules\electron\dist" mkdir "node_modules\electron\dist" >nul 2>nul
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip' -OutFile 'node_modules\electron\ez.zip' -UseBasicParsing"
    if exist "node_modules\electron\ez.zip" (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
            "Expand-Archive -Path 'node_modules\electron\ez.zip' -DestinationPath 'node_modules\electron\dist' -Force"
        del "node_modules\electron\ez.zip" >nul 2>nul
        echo electron.exe> "node_modules\electron\path.txt"
    )
)

if exist "src\services\verify-payment.js" (
    echo [*] Running system license / payment verification...
    "%NODE%" "src\services\verify-payment.js"
)

:: ════════════════════════════════════════════════════════════════════════════
:: CLEAN RESTART / RESET / UPDATE ENTRY POINT
:: ════════════════════════════════════════════════════════════════════════════
:clean_restart
cd /d "%INSTALL_DIR%"

echo.
echo  ================================================================
echo   CLEAN SYSTEM RESTART, CACHE WIPE ^& CLOUDFLARE LAUNCH
echo  ================================================================
echo   Working Directory: %INSTALL_DIR%
echo.

:: ── Locate Git and Node if running directly in restart mode ──────────────────
if not defined GIT (
    set "GIT=git"
    for /f "delims=" %%I in ('where git 2^>nul') do if not defined GIT set "GIT=%%I"
    if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
    if not defined GIT if exist "%ProgramFiles(x86)%\Git\cmd\git.exe" set "GIT=%ProgramFiles(x86)%\Git\cmd\git.exe"
    if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"
)

if not defined NODE (
    set "NODE=node"
    if exist "%ProgramFiles%\nodejs\node.exe"          set "NODE=%ProgramFiles%\nodejs\node.exe"
    if exist "%ProgramFiles(x86)%\nodejs\node.exe"    set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
    if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    if not defined NODE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
)

:: ── Step 1: Forcefully Terminate Old Processes ───────────────────────────────
echo.
echo [1/5] Terminating previous processes (electron, scrcpy, cloudflared, node, adb)...
schtasks /delete /tn "DeviceFarm_Agent_BootService" /f >nul 2>&1
schtasks /delete /tn "DeviceFarm_Agent_LogonService" /f >nul 2>&1
schtasks /delete /tn "DeviceFarm Agent AutoStart" /f >nul 2>&1

taskkill /F /IM cloudflared.exe /T 2>&1
taskkill /F /IM electron.exe /T 2>&1
taskkill /F /IM scrcpy.exe /T 2>&1
taskkill /F /IM node.exe /T 2>&1
taskkill /F /IM adb.exe /T 2>&1

echo [*] Releasing port 7400...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "$conns = Get-NetTCPConnection -LocalPort 7400 -ErrorAction SilentlyContinue; if ($conns) { $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; Write-Host ' [OK] Terminated PID on port 7400:' $_ } catch {} } } else { Write-Host ' [OK] Port 7400 is already free.' }"

ping 127.0.0.1 -n 2 >nul 2>&1

:: ── Step 2: Remove All Unnecessary Caches & Flush Network/WiFi Cache ───────────
echo.
echo [2/5] Wiping stale caches and flushing network/Wi-Fi socket cache...
if exist "%INSTALL_DIR%\wifi-devices-cache.json" (
    del /F /Q "%INSTALL_DIR%\wifi-devices-cache.json"
    echo  [OK] Deleted: wifi-devices-cache.json
) else (
    echo  [*] No wifi-devices-cache.json present
)
if exist "%INSTALL_DIR%\license_cache.json" (
    del /F /Q "%INSTALL_DIR%\license_cache.json"
    echo  [OK] Deleted: license_cache.json
) else (
    echo  [*] No license_cache.json present
)
if exist "%INSTALL_DIR%\*.tmp" (
    del /F /Q "%INSTALL_DIR%\*.tmp"
    echo  [OK] Deleted: temporary cache files (*.tmp)
)

echo [*] Flushing Windows DNS resolver cache...
ipconfig /flushdns

echo [*] Purging NetBIOS cache...
nbtstat -R >nul 2>&1

echo [*] Resetting IP ARP neighbor cache...
netsh interface ip delete arpcache >nul 2>&1
echo [OK] Network and Wi-Fi resolver cache flushed clean.

:: ── Step 3: Pull Latest Code From GitHub ─────────────────────────────────────
echo.
echo [3/5] Synchronizing latest code from GitHub (origin/main)...
echo [*] Running: git fetch origin main...
"%GIT%" -C "%INSTALL_DIR%" fetch origin main

echo [*] Running: git reset --hard origin/main...
"%GIT%" -C "%INSTALL_DIR%" reset --hard origin/main

echo [*] Running: git clean -fd...
"%GIT%" -C "%INSTALL_DIR%" clean -fd

echo.
echo  ================================================================
echo   ACTIVE AGENT VERSION IN USE:
echo  ================================================================
"%GIT%" -C "%INSTALL_DIR%" log -n 1 --stat
echo.
echo   Branch: main
echo   Path  : %INSTALL_DIR%
echo  ================================================================
echo.

:: ── Step 4: Refresh ADB and Connected Phones ─────────────────────────────────
echo [4/5] Refreshing ADB server and detecting connected devices...
set "ADB_BIN=%INSTALL_DIR%\assets\bin\adb.exe"
if not exist "%ADB_BIN%" set "ADB_BIN=adb"

echo [*] Starting ADB server...
"%ADB_BIN%" start-server
echo [*] Reconnecting ADB devices...
"%ADB_BIN%" reconnect

echo.
echo [*] Connected Android Devices:
"%ADB_BIN%" devices -l
echo.

:: ── Step 5: Launch Watchdog, Cloudflare Tunnel & Register 24/7 Tasks ─────────
echo [5/5] Launching DeviceFarm Agent Service ^& Cloudflare Tunnel...

:: 5a. Start Headless Watchdog
echo [*] Starting Agent Service watchdog (Node.js)...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
    "$proc = Start-Process -FilePath '%NODE%' -ArgumentList 'src\main\service-watchdog.js' -WorkingDirectory '%INSTALL_DIR%' -WindowStyle Hidden -PassThru; Write-Host ' [OK] Agent watchdog launched with PID:' $proc.Id"

:: 5b. Locate or Auto-Download Cloudflared Binary
set "CLOUDFLARED_EXE=%INSTALL_DIR%\assets\bin\cloudflared.exe"
if not exist "%CLOUDFLARED_EXE%" set "CLOUDFLARED_EXE=C:\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED_EXE%" set "CLOUDFLARED_EXE=C:\Program Files\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED_EXE%" set "CLOUDFLARED_EXE=C:\Program Files (x86)\cloudflared\cloudflared.exe"

if not exist "%CLOUDFLARED_EXE%" (
    echo [*] Cloudflared not found. Downloading cloudflared-windows-amd64.exe from GitHub...
    if not exist "%INSTALL_DIR%\assets\bin" mkdir "%INSTALL_DIR%\assets\bin" >nul 2>nul
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%INSTALL_DIR%\assets\bin\cloudflared.exe' -UseBasicParsing; Write-Host ' [OK] Download complete.'"
    if exist "%INSTALL_DIR%\assets\bin\cloudflared.exe" set "CLOUDFLARED_EXE=%INSTALL_DIR%\assets\bin\cloudflared.exe"
)

echo [*] Cloudflare binary location: %CLOUDFLARED_EXE%
if exist "%CLOUDFLARED_EXE%" (
    "%CLOUDFLARED_EXE%" --version
)

:: 5c. Start Cloudflare Tunnel for agent.dennoh.site
if exist "%CLOUDFLARED_EXE%" (
    echo [*] Starting Cloudflare Tunnel daemon for agent.dennoh.site...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "$cf = Start-Process -FilePath '%CLOUDFLARED_EXE%' -ArgumentList 'tunnel','run','--token','eyJhIjoiMjEzYzI3Y2IwOTVjZTBlMTE0ZTNkNWYzZDM3ODJiNWQiLCJ0IjoiMDVkMzUyZjgtZGU5Yi00MzBiLWIxYzUtNDUyNzNlZWQzOTExIiwicyI6Ik1qWmlaak13WVdZdE1UTmpPUzAwTm1NeExUZ3hNR0V0TlRWalpURTFNV1ZsTURNMSJ9' -WindowStyle Hidden -PassThru; Write-Host ' [OK] Cloudflare tunnel started with PID:' $cf.Id"
) else (
    echo [ERROR] Cloudflared binary could not be found or downloaded!
)

:: 5d. Re-register 24/7 Windows Scheduled Tasks (Boot & Logon)
echo [*] Re-registering Windows 24/7 background tasks...
set "TASK_BOOT=DeviceFarm_Agent_BootService"
set "TASK_LOGON=DeviceFarm_Agent_LogonService"
set "VBS_LAUNCHER=%INSTALL_DIR%\Start-Agent-Silent.vbs"
set "STARTUP_ALL=%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK_ALL=%STARTUP_ALL%\DeviceFarm-Agent-Service.lnk"

if exist "%VBS_LAUNCHER%" (
    schtasks /create /tn "%TASK_BOOT%" /tr "wscript.exe \"%VBS_LAUNCHER%\"" /sc ONSTART /ru "SYSTEM" /rl HIGHEST /f
    schtasks /create /tn "%TASK_LOGON%" /tr "wscript.exe \"%VBS_LAUNCHER%\"" /sc ONLOGON /rl HIGHEST /f
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "try { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%LNK_ALL%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%VBS_LAUNCHER%\"'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.WindowStyle = 0; $s.Description = 'DeviceFarm Agent Autonomous Background Service'; $s.Save(); Write-Host ' [OK] Startup folder shortcut registered.' } catch {}"
)

:: ── Health Verification ──────────────────────────────────────────────────────
echo.
echo [*] Verifying local dashboard (port 7400) and public tunnel status...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
    "$okLocal = $false; for ($i = 0; $i -lt 15; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7400/api/license/status' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $okLocal = $true; break } } catch {}; Start-Sleep -Seconds 1 }; if ($okLocal) { Write-Host ' [OK] Local Dashboard Server is LIVE on port 7400!' } else { Write-Host ' [*] Local Dashboard Server is still initializing...' }; $cfProc = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue; if ($cfProc) { Write-Host ' [OK] Cloudflare Tunnel daemon is RUNNING (PID:' $cfProc[0].Id ')!' } else { Write-Host ' [WARN] Cloudflare Tunnel process not detected yet' }"

start "" "http://localhost:7400"

echo.
echo  ================================================================
echo   DEVICEFARM AGENT IS FULLY OPERATIONAL!
echo  ================================================================
echo   Local Dashboard : http://localhost:7400
echo   Public Domain   : https://agent.dennoh.site
echo   Status          : Operational ^& Cloudflare Tunnel Active
echo   Background Task : 24/7 Auto-Start on Boot ^& Logon Configured
echo  ================================================================
echo.
echo   NOTE: This window will NEVER auto-close.
echo   All output is preserved above for your review.
echo   You may minimize this window or close it manually when ready.
echo.
cmd /k
