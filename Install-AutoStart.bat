@echo off
:: ════════════════════════════════════════════════════════════════════════════
:: DeviceFarm Agent — Windows Auto-Start Setup
:: Registers the agent to auto-launch silently at Windows login via Task Scheduler.
:: Run this ONCE as Administrator after the initial setup.
:: ════════════════════════════════════════════════════════════════════════════
setlocal EnableDelayedExpansion

:: ─── Locate this script's directory ───────────────────────────────────────
set "AGENT_DIR=%~dp0"
if "%AGENT_DIR:~-1%"=="\" set "AGENT_DIR=%AGENT_DIR:~0,-1%"

:: ─── Verify the main launch script exists ─────────────────────────────────
if not exist "%AGENT_DIR%\DeviceFarm-Agent-Setup.bat" (
    echo [ERROR] DeviceFarm-Agent-Setup.bat not found in %AGENT_DIR%
    pause
    exit /b 1
)

:: ─── Task name ─────────────────────────────────────────────────────────────
set "TASK_NAME=DeviceFarm Agent AutoStart"

:: ─── Remove any existing task with the same name ──────────────────────────
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: ─── Register the task ────────────────────────────────────────────────────
:: Trigger: At logon of any user
:: Action:  Run DeviceFarm-Agent-Setup.bat (minimized, no window)
:: Run level: Highest (so ADB and process management work properly)

schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "cmd /c start /min \"\" \"%AGENT_DIR%\\DeviceFarm-Agent-Setup.bat\"" ^
  /sc ONLOGON ^
  /rl HIGHEST ^
  /delay 0001:00 ^
  /f ^
  >nul 2>&1

if %errorlevel% equ 0 (
    echo.
    echo  ================================================================
    echo  [OK] DeviceFarm Agent will now start automatically at login!
    echo       Task:     "%TASK_NAME%"
    echo       Location: %AGENT_DIR%
    echo  ================================================================
    echo.
    echo  The agent will launch 1 minute after you log in.
    echo  To remove auto-start, run: schtasks /delete /tn "%TASK_NAME%" /f
    echo.
) else (
    echo.
    echo  ================================================================
    echo  [WARN] Task Scheduler registration failed (try running as Admin).
    echo  Falling back to Startup folder shortcut method...
    echo  ================================================================
    echo.

    :: ── Fallback: create a shortcut in the Windows Startup folder ──────────
    set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
    set "LNK_PATH=%STARTUP%\DeviceFarm-Agent.lnk"

    :: Use PowerShell to create the shortcut
    PowerShell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ws = New-Object -ComObject WScript.Shell;" ^
        "$s = $ws.CreateShortcut('%LNK_PATH%');" ^
        "$s.TargetPath = '%AGENT_DIR%\DeviceFarm-Agent-Setup.bat';" ^
        "$s.WorkingDirectory = '%AGENT_DIR%';" ^
        "$s.WindowStyle = 7;" ^
        "$s.Description = 'DeviceFarm Agent AutoStart';" ^
        "$s.Save()"

    if exist "%LNK_PATH%" (
        echo  [OK] Startup shortcut created: %LNK_PATH%
    ) else (
        echo  [ERROR] Could not create startup shortcut. Please manually add
        echo          DeviceFarm-Agent-Setup.bat to your Startup folder.
    )
    echo.
)

pause
