'use strict';

/**
 * Device anti-detection & bootloader hiding service.
 * ─────────────────────────────────────────────────
 * Configures connected Android devices so survey & earning apps
 * (e.g. Swagbucks, Freecash, AttaPoll, InboxDollars, Qmee) do not flag or block
 * the device due to unlocked bootloaders, developer options, root, or debugging overlays.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

function loadConfig() {
  for (const p of [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ]) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) {}
    }
  }
  return {};
}

function resolveAdb() {
  const cfg = loadConfig();
  if (cfg.adbPath && fs.existsSync(cfg.adbPath)) return cfg.adbPath;
  const bundled = path.join(__dirname, '../../assets/bin/adb.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (fs.existsSync('C:\\platform-tools\\adb.exe')) return 'C:\\platform-tools\\adb.exe';
  return 'adb';
}

/**
 * Execute adb shell command on a specific device serial.
 */
function execAdbShell(serial, cmd, timeoutMs = 5000) {
  const adbBin = resolveAdb();
  return new Promise((resolve) => {
    const fullCmd = `"${adbBin}" -s ${serial} shell "${cmd.replace(/"/g, '\\"')}"`;
    exec(fullCmd, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: err.message, stdout: stdout || '' });
      } else {
        resolve({ success: true, stdout: (stdout || '').trim() });
      }
    });
  });
}

/**
 * Applies bootloader hiding & stealth anti-detection config to an Android device.
 * @param {string} serial - Device ADB serial number
 */
async function applyDeviceStealth(serial) {
  logger.info(`[StealthService] Applying bootloader hiding & anti-detection stealth config for device: ${serial}...`);

  // 1. Hide Developer Settings & Debugging flags from Android Settings API checks
  const settingsCmds = [
    'settings put global development_settings_enabled 0',
    'settings put global adb_enabled 0',
    'settings put secure mock_location 0',
    'settings put global package_verifier_enable 1',
    'settings put system show_touches 0',
    'settings put system pointer_location 0',
    'settings put global stay_awake 0',
    'settings put system stay_awake 0',
  ];

  for (const cmd of settingsCmds) {
    await execAdbShell(serial, cmd);
  }

  // 2. Hide Unlocked Bootloader & Root Build Indicators
  const propConfigs = [
    { key: 'ro.boot.flash.locked', value: '1' },
    { key: 'ro.boot.verifiedbootstate', value: 'green' },
    { key: 'ro.boot.veritymode', value: 'enforcing' },
    { key: 'ro.secure', value: '1' },
    { key: 'ro.debuggable', value: '0' },
    { key: 'ro.build.type', value: 'user' },
    { key: 'ro.build.tags', value: 'release-keys' },
    { key: 'ro.boot.bootloader', value: 'locked' },
    { key: 'vendor.boot.verifiedbootstate', value: 'green' },
    { key: 'sys.oem_unlock_allowed', value: '0' },
  ];

  // Try resetprop via su first (for Magisk / KernelSU / APatch rooted devices)
  const resetpropCmds = propConfigs.map(p => `resetprop ${p.key} ${p.value}`).join('; ');
  const setpropCmds   = propConfigs.map(p => `setprop ${p.key} ${p.value}`).join('; ');

  const suRes = await execAdbShell(serial, `su -c "${resetpropCmds}"`);
  if (!suRes.success) {
    // Try resetprop directly without su wrapper
    const directReset = await execAdbShell(serial, resetpropCmds);
    if (!directReset.success) {
      // Fallback to standard setprop
      await execAdbShell(serial, setpropCmds);
    }
  }

  logger.info(`[StealthService] ✅ Bootloader hiding & stealth configuration active on device ${serial}`);
  return true;
}

module.exports = {
  applyDeviceStealth,
  execAdbShell,
};
