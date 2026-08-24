@echo off
:: ════════════════════════════════════════════════════════════════════════════
:: DeviceFarm Agent — Windows Background Service & Auto-Start Installer
:: Registers the agent as an autonomous background service that:
::   1. Starts silently at Windows Boot & User Login
::   2. Runs 100% invisibly in the background (0 console windows)
::   3. Auto-restarts continuously via watchdog if closed or terminated
:: ════════════════════════════════════════════════════════════════════════════
setlocal EnableDelayedExpansion

title DeviceFarm Agent — Background Service Setup

:: Check for Administrative privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ================================================================
    echo  [!] Requesting Administrator privileges to configure service...
    echo  ================================================================
    echo.
    PowerShell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

:: ─── Locate this script's directory ───────────────────────────────────────
set "AGENT_DIR=%~dp0"
if "%AGENT_DIR:~-1%"=="\" set "AGENT_DIR=%AGENT_DIR:~0,-1%"

:: ─── Verify Silent Launcher exists ────────────────────────────────────────
set "VBS_LAUNCHER=%AGENT_DIR%\Start-Agent-Silent.vbs"
if not exist "%VBS_LAUNCHER%" (
    echo [ERROR] Start-Agent-Silent.vbs not found in %AGENT_DIR%
    pause
    exit /b 1
)

:: ─── Task Names ───────────────────────────────────────────────────────────
set "TASK_BOOT=DeviceFarm_Agent_BootService"
set "TASK_LOGON=DeviceFarm_Agent_LogonService"

echo.
echo  ================================================================
echo   DEVICEFARM AGENT — BACKGROUND SERVICE INSTALLATION
echo  ================================================================
echo.
echo  [*] Target Directory : %AGENT_DIR%
echo  [*] Silent Launcher  : %VBS_LAUNCHER%
echo.

:: ─── Remove any old conflicting tasks ─────────────────────────────────────
schtasks /delete /tn "DeviceFarm Agent AutoStart" /f >nul 2>&1
schtasks /delete /tn "%TASK_BOOT%" /f >nul 2>&1
schtasks /delete /tn "%TASK_LOGON%" /f >nul 2>&1

:: ─── 1. Register Task for System Boot (Starts when PC turns on) ───────────
echo [*] Registering Windows Boot Trigger (starts when PC turns on)...
schtasks /create ^
  /tn "%TASK_BOOT%" ^
  /tr "wscript.exe \"%VBS_LAUNCHER%\"" ^
  /sc ONSTART ^
  /ru "SYSTEM" ^
  /rl HIGHEST ^
  /f >nul 2>&1

if %errorlevel% equ 0 (
    echo [OK] Boot Service Task successfully registered!
) else (
    echo [INFO] System-level task notice, creating user-level logon task...
)

:: ─── 2. Register Task for User Logon (Starts at desktop login) ────────────
echo [*] Registering User Logon Trigger (starts when user logs in)...
schtasks /create ^
  /tn "%TASK_LOGON%" ^
  /tr "wscript.exe \"%VBS_LAUNCHER%\"" ^
  /sc ONLOGON ^
  /rl HIGHEST ^
  /f >nul 2>&1

if %errorlevel% equ 0 (
    echo [OK] Logon Service Task successfully registered!
)

:: ─── 3. Startup Folder Shortcut (Secondary Redundancy) ─────────────────────
echo [*] Configuring Windows Startup folder shortcut...
set "STARTUP_ALL=%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK_ALL=%STARTUP_ALL%\DeviceFarm-Agent-Service.lnk"

PowerShell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell;" ^
    "$s = $ws.CreateShortcut('%LNK_ALL%');" ^
    "$s.TargetPath = 'wscript.exe';" ^
    "$s.Arguments = '\"%VBS_LAUNCHER%\"';" ^
    "$s.WorkingDirectory = '%AGENT_DIR%';" ^
    "$s.WindowStyle = 0;" ^
    "$s.Description = 'DeviceFarm Agent Autonomous Background Service';" ^
    "$s.Save()" >nul 2>&1

if exist "%LNK_ALL%" (
    echo [OK] All-Users Startup shortcut created: %LNK_ALL%
)

:: ─── 4. Start the service immediately in the background ───────────────────
echo.
echo [*] Starting DeviceFarm Agent silently in the background now...
wscript.exe "%VBS_LAUNCHER%"

echo.
echo  ================================================================
echo   [SUCCESS] DEVICEFARM AGENT BACKGROUND SERVICE CONFIGURED!
echo  ================================================================
echo   - Runs 100% invisibly in the background at all times
echo   - Automatically starts anytime Windows turns on or restarts
echo   - Auto-restarts if closed or terminated
echo   - Accessible in your browser at http://localhost:7400
echo   - System Tray icon is active
echo  ================================================================
echo.
pause
