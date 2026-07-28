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
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
        echo [OK] Added Node.js to PATH.
    ) else (
        echo [*] Node.js is NOT installed in PATH. Downloading and installing Node.js LTS...
        set "NODE_MSI=%TEMP%\node_installer.msi"
        powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%NODE_MSI%'"
        if exist "%NODE_MSI%" (
            echo [*] Installing Node.js silently...
            msiexec /i "%NODE_MSI%" /qn /norestart
            del "%NODE_MSI%" >nul 2>nul
            set "PATH=%ProgramFiles%\nodejs;%PATH%"
            echo [OK] Node.js installed successfully.
        )
    )
) else (
    echo [OK] Node.js environment detected.
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
    echo [*] Installing package dependencies...
    call npm install --no-audit --no-fund
    if not exist "node_modules\electron\dist\electron.exe" (
        echo [*] Running Electron installer script...
        node node_modules\electron\install.js 2>nul
    )
    if not exist "node_modules\electron\dist\electron.exe" (
        echo [*] Downloading Electron binary v33.4.11...
        if not exist "node_modules\electron\dist" mkdir "node_modules\electron\dist" 2>nul
        powershell -Command "Invoke-WebRequest -Uri 'https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip' -OutFile 'node_modules\electron\ez.zip'"
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
