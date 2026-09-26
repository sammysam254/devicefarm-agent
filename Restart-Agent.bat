@echo off
:: ════════════════════════════════════════════════════════════════════════════
:: DeviceFarm Agent — Restart Wrapper
:: Delegates directly to DeviceFarm-Agent-Setup.bat in restart mode.
:: ════════════════════════════════════════════════════════════════════════════
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
call "%SCRIPT_DIR%\DeviceFarm-Agent-Setup.bat" "%SCRIPT_DIR%" --restart %*
cmd /k
