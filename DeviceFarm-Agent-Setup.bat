@echo off
setlocal enabledelayedexpansion

title DeviceFarm Agent Setup Starter

echo.
echo =======================================================================
echo              DEVICEFARM DESKTOP AGENT SETUP AND STARTER
echo =======================================================================
echo.

:: 1. Set working directory to the folder containing this script
cd /d "%~dp0"
echo [*] Application Directory: %CD%

:: ─── Resolve powershell.exe (always use full path to avoid "not recognized") ──
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"

:: ─────────────────────────────────────────────────────────────────────────────
:: 2. Resolve Node.js — find it or install it, then set NODE and NPM to full paths
:: ─────────────────────────────────────────────────────────────────────────────
set "NODE="
set "NPM="

:: Check common install locations first (handles fresh installs in same session)
if exist "%ProgramFiles%\nodejs\node.exe"             set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles%\nodejs\npm.cmd"              set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe"    set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd"     set "NPM=%LOCALAPPDATA%\Programs\nodejs\npm.cmd"

:: Also try PATH
if not defined NODE (
    for /f "delims=" %%I in ('where node 2^>nul') do (
        if not defined NODE set "NODE=%%I"
    )
)
if not defined NPM (
    for /f "delims=" %%I in ('where npm 2^>nul') do (
        if not defined NPM set "NPM=%%I"
    )
)
if not defined NPM (
    for /f "delims=" %%I in ('where npm.cmd 2^>nul') do (
        if not defined NPM set "NPM=%%I"
    )
)

if defined NODE (
    echo [OK] Node.js found: %NODE%
) else (
    echo [*] Node.js not found. Downloading installer...
    set "NODE_MSI=%TEMP%\node_lts_installer.msi"
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\node_lts_installer.msi' -UseBasicParsing"
    if not exist "%TEMP%\node_lts_installer.msi" (
        echo [ERROR] Download failed. Check your internet connection and try again.
        pause & exit /b 1
    )
    echo [*] Installing Node.js — please wait, this may take a minute...
    start /wait msiexec /i "%TEMP%\node_lts_installer.msi" /qn /norestart ADDLOCAL=ALL
    del "%TEMP%\node_lts_installer.msi" >nul 2>nul
    :: After MSI completes, the exe is always here
    set "NODE=%ProgramFiles%\nodejs\node.exe"
    set "NPM=%ProgramFiles%\nodejs\npm.cmd"
    if not exist "!NODE!" (
        echo [ERROR] Node.js install failed. Please install manually from https://nodejs.org
        pause & exit /b 1
    )
    echo [OK] Node.js installed: !NODE!
)

:: Derive npm from node location if still not set
if not defined NPM (
    for %%I in ("%NODE%") do set "NPM=%%~dpInpm.cmd"
)

echo [OK] npm: %NPM%

:: ─────────────────────────────────────────────────────────────────────────────
:: 3. ADB platform-tools
:: ─────────────────────────────────────────────────────────────────────────────
set "ADB=adb"
if exist "assets\bin\adb.exe" (
    set "ADB=%CD%\assets\bin\adb.exe"
    echo [OK] Bundled ADB found: %ADB%
) else if exist "C:\platform-tools\adb.exe" (
    set "ADB=C:\platform-tools\adb.exe"
    echo [OK] ADB found at C:\platform-tools\adb.exe
) else (
    echo [*] ADB missing. Downloading Android SDK platform-tools...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
        "Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile '%TEMP%\pt.zip' -UseBasicParsing"
    if exist "%TEMP%\pt.zip" (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
            "Expand-Archive -Path '%TEMP%\pt.zip' -DestinationPath 'C:\' -Force"
        del "%TEMP%\pt.zip" >nul 2>nul
    )
    if exist "C:\platform-tools\adb.exe" (
        set "ADB=C:\platform-tools\adb.exe"
        echo [OK] ADB installed to C:\platform-tools
    ) else (
        echo [WARN] ADB download failed — device detection may not work.
    )
)

:: ─────────────────────────────────────────────────────────────────────────────
:: 4. npm install dependencies
:: ─────────────────────────────────────────────────────────────────────────────
if exist "node_modules\electron\dist\electron.exe" (
    echo [OK] node_modules and Electron binary already present.
) else (
    echo [*] Installing npm dependencies — please wait...
    call "%NPM%" install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed. See errors above.
        pause & exit /b 1
    )
    echo [OK] Dependencies installed.

    :: Try the built-in Electron postinstall script first
    if not exist "node_modules\electron\dist\electron.exe" (
        echo [*] Running Electron postinstall script...
        "%NODE%" "node_modules\electron\install.js" 2>nul
    )

    :: Manual fallback — download the zip directly
    if not exist "node_modules\electron\dist\electron.exe" (
        echo [*] Downloading Electron v33.4.11 binary directly...
        if not exist "node_modules\electron\dist" mkdir "node_modules\electron\dist"
        "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
            "Invoke-WebRequest -Uri 'https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip' -OutFile 'node_modules\electron\ez.zip' -UseBasicParsing"
        if exist "node_modules\electron\ez.zip" (
            "%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
                "Expand-Archive -Path 'node_modules\electron\ez.zip' -DestinationPath 'node_modules\electron\dist' -Force"
            del "node_modules\electron\ez.zip" >nul 2>nul
            echo electron.exe> "node_modules\electron\path.txt"
        )
    )

    if exist "node_modules\electron\dist\electron.exe" (
        echo [OK] Electron binary ready.
    ) else (
        echo [WARN] Electron binary not found after all attempts. Launch may fail.
    )
)

:: ─────────────────────────────────────────────────────────────────────────────
:: 5. Payment verification
:: ─────────────────────────────────────────────────────────────────────────────
echo.
echo =======================================================================
echo     STEP 1: PRE-INSTALLATION PAYMENT SYSTEM VERIFICATION ($30/MO)
echo =======================================================================
echo.
echo [*] Generating Machine Binding Code...
"%NODE%" -e "const fs=require('fs'),path=require('path'),c=path.join(process.cwd(),'config.json'),cfg=fs.existsSync(c)?JSON.parse(fs.readFileSync(c)):{};if(!cfg.machineBindingCode||!/^\d{8}$/.test(cfg.machineBindingCode)){cfg.machineBindingCode=Math.floor(10000000+Math.random()*90000000).toString();fs.writeFileSync(c,JSON.stringify(cfg,null,2));}"
"%NODE%" "src\services\verify-payment.js"

:: ─────────────────────────────────────────────────────────────────────────────
:: 6. Launch the agent
:: ─────────────────────────────────────────────────────────────────────────────
echo.
echo =======================================================================
echo         STEP 2: STARTING DEVICEFARM DESKTOP AGENT SERVICE
echo =======================================================================
echo.

taskkill /F /IM electron.exe /T >nul 2>nul
taskkill /F /IM node.exe /T >nul 2>nul

set "ELECTRON_BIN=node_modules\electron\dist\electron.exe"
if exist "%ELECTRON_BIN%" (
    echo [*] Launching DeviceFarm Agent...
    start "" "%ELECTRON_BIN%" "src\main\index.js"
) else (
    echo [*] Electron binary not found — attempting launch via npm exec...
    start "" "%NPM%" exec -- electron .
)

echo [*] Waiting for Dashboard service on http://localhost:7400 ...
ping 127.0.0.1 -n 5 >nul 2>nul
start "" "http://localhost:7400"

echo.
echo =======================================================================
echo [OK] Setup Complete! DeviceFarm Agent is running in System Tray.
echo      Dashboard URL: http://localhost:7400
echo =======================================================================
echo.
echo Press any key to exit setup window...
pause >nul
