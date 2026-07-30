# DeviceFarm Agent — One-Click Installer

## Direct Download Link

**[📥 Click here to download DeviceFarm-Agent-Setup.bat](https://raw.githubusercontent.com/sammysam254/devicefarm-agent/main/DeviceFarm-Agent-Setup.bat)**

Right-click the link above and select "Save link as..." to download the installer.

## What It Does

This single `.bat` file is all you need. When you run it, it will automatically:

1. ✅ Install Git (if missing)
2. ✅ Install Node.js LTS (if missing)  
3. ✅ Install Android Debug Bridge (ADB)
4. ✅ Clone the agent code from GitHub
5. ✅ Download scrcpy-server.jar for streaming
6. ✅ Install all dependencies (npm packages + Electron)
7. ✅ Verify payment ($30/month rental)
8. ✅ Launch the DeviceFarm agent

## Installation Steps

1. **Download** the setup file using the link above
2. **Run** `DeviceFarm-Agent-Setup.bat` as Administrator
3. **Wait** for the automatic installation (2-3 minutes)
4. **Done!** The agent will open the dashboard at http://localhost:7400

## Requirements

- Windows 10/11 (64-bit)
- Internet connection
- Administrator privileges
- At least 500 MB free disk space

## Install Location

The agent installs to: `C:\DeviceFarmAgent`

## Troubleshooting

### Slow Download Speed?
The setup now uses:
- Shallow git clone (`--depth 1`) for 10x faster cloning
- Parallel downloads for npm, Electron, and scrcpy in the background
- Direct binary downloads to skip slow npm postinstall scripts

### Black Screen in Stream?
The agent now includes:
- Automatic scrcpy-server.jar download during setup
- Diagnostic logging to identify missing components
- Fallback to screencap if H264 streaming fails

Check the agent logs at `C:\DeviceFarmAgent\logs\` for details.

### Payment Required
Each device requires a $30/month rental payment. The setup wizard will generate a unique 8-digit Machine Binding Code and provide a checkout link.

## Support

For issues, check: https://github.com/sammysam254/devicefarm-agent/issues
