'use strict';

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
let logger;
try {
  logger = require('../utils/logger');
} catch (_) {
  logger = {
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a)
  };
}

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

const lastSyncTime = new Map(); // serial -> last sync timestamp

/**
 * Synchronize Android device hardware RTC and system clock to host PC time.
 * Solves time drift and prevents devices/surveys/apps from becoming unresponsive or rejecting inputs.
 */
function syncDeviceTime(serial) {
  return new Promise((resolve) => {
    if (!serial) return resolve(false);

    const adbBin = resolveAdb();
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // Format date string for older date commands: YYYYMMDD.HHmmss (UTC)
    const d = new Date(nowMs);
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

    // Sequence:
    // 1. Temporarily disable auto_time so Android kernel allows manual clock injection
    // 2. Set exact epoch millisecond time via cmd alarm set-time (Android 6.0+)
    // 3. Fallback to toybox/toolbox date commands
    // 4. Re-enable auto_time so apps reading Settings.Global.AUTO_TIME see network sync enabled
    // 5. Wake up network time service if present
    const commands = [
      'settings put global auto_time 0',
      `cmd alarm set-time ${nowMs} 2>/dev/null`,
      `date -u @${nowSec} 2>/dev/null`,
      `toybox date -u @${nowSec} 2>/dev/null`,
      `date -u ${dateStr} 2>/dev/null`,
      'settings put global auto_time 1',
      'settings put global auto_time_zone 1',
      'cmd network_time_update_service force_refresh 2>/dev/null'
    ];

    const shellCmd = commands.join('; ');
    const fullCmd = `"${adbBin}" -s ${serial} shell "${shellCmd}"`;

    exec(fullCmd, { windowsHide: true, timeout: 6000 }, (err) => {
      if (err) {
        // Fallback: try direct cmd alarm set-time without chaining
        exec(`"${adbBin}" -s ${serial} shell cmd alarm set-time ${nowMs}`, { windowsHide: true, timeout: 3000 }, () => {
          resolve(true);
        });
      } else {
        const last = lastSyncTime.get(serial) || 0;
        if (nowMs - last > 300000) { // Log once every 5 minutes per device
          logger.info(`[TimeSync] Device ${serial} clock synchronized to ${new Date(nowMs).toISOString()} (epoch ${nowMs})`);
          lastSyncTime.set(serial, nowMs);
        }
        resolve(true);
      }
    });
  });
}

let syncInterval = null;

function startPeriodicTimeSync(getActiveSerialsFn, intervalMs = 30000) {
  if (syncInterval) clearInterval(syncInterval);

  const runSync = async () => {
    try {
      const serials = typeof getActiveSerialsFn === 'function' ? getActiveSerialsFn() : [];
      if (!Array.isArray(serials) || serials.length === 0) return;
      for (const s of serials) {
        await syncDeviceTime(s);
      }
    } catch (_) {}
  };

  // Run on start
  runSync();
  syncInterval = setInterval(runSync, intervalMs);
}

function stopPeriodicTimeSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

module.exports = {
  syncDeviceTime,
  startPeriodicTimeSync,
  stopPeriodicTimeSync
};
