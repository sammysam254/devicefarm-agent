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

:: 2. Check Node.js Environment
set "NODE_BIN="
where node >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Node.js detected in PATH.
    set "NODE_BIN=node"
) else if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
    echo [OK] Added Node.js to PATH from Program Files.
) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
    set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    echo [OK] Added Node.js to PATH from local Programs.
) else (
    echo [*] Node.js is NOT installed. Downloading and installing Node.js LTS...
    set "NODE_MSI=%TEMP%\node_installer.msi"
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\node_installer.msi' -UseBasicParsing"
    if exist "%TEMP%\node_installer.msi" (
        echo [*] Installing Node.js silently — please wait...
        :: /w makes start wait for the process to finish before continuing
        start /w "" msiexec /i "%TEMP%\node_installer.msi" /qn /norestart ADDLOCAL=ALL
        del "%TEMP%\node_installer.msi" >nul 2>nul
        :: Refresh PATH from registry so npm/node are available immediately
        for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%B"
        for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%B"
        set "PATH=%ProgramFiles%\nodejs;!SYS_PATH!;!USR_PATH!"
        set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
        echo [OK] Node.js installed and PATH refreshed.
    ) else (
        echo [ERROR] Failed to download Node.js installer. Check your internet connection.
        pause
        exit /b 1
    )
)

:: 3. Check ADB Binary Environment
if exist "C:\platform-tools\adb.exe" (
    set "PATH=C:\platform-tools;%PATH%"
    echo [OK] Android ADB binary detected at C:\platform-tools\adb.exe.
) else (
    echo [*] ADB binary missing. Downloading Android SDK platform-tools...
    curl -L -s -o "%TEMP%\pt.zip" "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
    tar -xf "%TEMP%\pt.zip" -C "C:\" 2>nul
    del "%TEMP%\pt.zip" 2>nul
    if exist "C:\platform-tools\adb.exe" (
        set "PATH=C:\platform-tools;%PATH%"
        echo [OK] Android ADB platform-tools installed successfully to C:\platform-tools.
    )
)

:: 4. Check npm package dependencies and Electron binary
if exist "node_modules\electron\dist\electron.exe" (
    echo [OK] Required packages and Electron binary detected.
) else (
    :: Verify node/npm are reachable before attempting install
    where node >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] node.exe is still not in PATH after setup. Cannot install dependencies.
        echo         Please install Node.js from https://nodejs.org and re-run this script.
        pause
        exit /b 1
    )
    echo [*] Installing package dependencies...
    call npm install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed. Check the errors above.
        pause
        exit /b 1
    )
    if not exist "node_modules\electron\dist\electron.exe" (
        echo [*] Running Electron installer script...
        node node_modules\electron\install.js 2>nul
    )
    if not exist "node_modules\electron\dist\electron.exe" (
        echo [*] Downloading Electron binary v33.4.11...
        if not exist "node_modules\electron\dist" mkdir "node_modules\electron\dist" 2>nul
        powershell -Command "Invoke-WebRequest -Uri 'https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip' -OutFile 'node_modules\electron\ez.zip' -UseBasicParsing"
        tar -xf "node_modules\electron\ez.zip" -C "node_modules\electron\dist" 2>nul
        del "node_modules\electron\ez.zip" 2>nul
        powershell -Command "Set-Content -Path 'node_modules\electron\path.txt' -Value 'electron.exe'"
    )
)

:: 5. PRE-INSTALLATION PAYMENT SYSTEM VERIFICATION
echo.
echo =======================================================================
echo     STEP 1: PRE-INSTALLATION PAYMENT SYSTEM VERIFICATION ($30/MO)
echo =======================================================================
echo.
echo [*] Generating 8-digit Machine Binding Code and initializing payment engine...
node -e "const fs=require('fs'),path=require('path'),c=path.join(process.cwd(),'config.json'),cfg=fs.existsSync(c)?JSON.parse(fs.readFileSync(c)):{};if(!cfg.machineBindingCode||!/^\d{8}$/.test(cfg.machineBindingCode)){cfg.machineBindingCode=Math.floor(10000000+Math.random()*90000000).toString();fs.writeFileSync(c,JSON.stringify(cfg,null,2));}"
node "src\services\verify-payment.js"

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
    echo [*] Launching via npx electron...
    start "" npx electron .
)

echo [*] Waiting for Dashboard service on http://localhost:7400 ...
ping 127.0.0.1 -n 4 >nul 2>nul
start "" "http://localhost:7400"

echo.
echo =======================================================================
echo [OK] Setup Complete! DeviceFarm Agent is running in System Tray.
echo      Dashboard URL: http://localhost:7400
echo =======================================================================
echo.
echo Press any key to exit setup window...
pause >nul
