'use strict';

/**
 * DeviceFarm Auto-Enrollment & Reboot Recovery Service
 * ─────────────────────────────────────────────────────
 * Background process that:
 * 1. Polls ADB every 10 seconds for any newly connected / rebooted devices
 * 2. Cross-checks with active processManager sessions
 * 3. Auto re-provisions any device found in ADB that is NOT actively streamed
 * 4. Cleans up stale processManager entries for devices no longer in ADB
 *
 * This runs ALONGSIDE the event-driven adb-tracker so that even if a
 * device silently reboots (no ADB disconnect event fired), it gets
 * picked up and re-enrolled within ~10 seconds.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const processManager = require('../main/process-manager');

// ─── Config ──────────────────────────────────────────────────────────────────

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

const { ensureAdbVendorKeys } = require('../utils/adb-keys');

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _consecutiveAdbFailures = 0;

function listAdbDevices(adbBin) {
  try {
    ensureAdbVendorKeys();
  } catch (_) {}

  return new Promise((resolve) => {
    exec(`"${adbBin}" devices`, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        _consecutiveAdbFailures++;
        logger.warn(`[EnrollmentGuard] adb devices poll warning (attempt ${_consecutiveAdbFailures}): ${err.message} — preserving all active streams without restarting daemon`);
        resolve(null);
        return;
      }
      _consecutiveAdbFailures = 0;
      const lines = (stdout || '').split('\n').slice(1);
      const serials = [];
      const offlineSerials = [];
      const unauthorizedSerials = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          if (parts[1] === 'device') {
            serials.push(parts[0]);
          } else if (parts[1] === 'offline') {
            offlineSerials.push(parts[0]);
          } else if (parts[1] === 'unauthorized') {
            unauthorizedSerials.push(parts[0]);
          }
        }
      }
      // Reconnect ONLY specific offline devices individually (NEVER system-wide)
      if (offlineSerials.length > 0) {
        const now = Date.now();
        for (const s of offlineSerials) {
          const last = _lastUnauthReconnect.get('off_' + s) || 0;
          if (now - last > 60000) {
            _lastUnauthReconnect.set('off_' + s, now);
            try {
              exec(`"${adbBin}" -s ${s} reconnect offline`, { timeout: 4000 }, () => {});
            } catch (_) {}
          }
        }
      }
      if (unauthorizedSerials.length > 0) {
        const now = Date.now();
        for (const s of unauthorizedSerials) {
          const last = _lastUnauthReconnect.get(s) || 0;
          if (now - last > 60000) {
            _lastUnauthReconnect.set(s, now);
            logger.info(`[EnrollmentGuard] Unauthorized device detected: ${s} — prompting reconnect with host authorization keys...`);
            try {
              exec(`"${adbBin}" -s ${s} reconnect`, { timeout: 4000 }, () => {});
            } catch (_) {}
          }
        }
      }
      resolve(serials);
    });
  });
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

let _addDeviceCallback = null;
let _removeDeviceCallback = null;
let _intervalTimer = null;
const _inProgress = new Set();
const _lastUnauthReconnect = new Map();
const _missingCounts = new Map();
const _lastAutoHealMap = new Map();
let _lastPeriodicUnlockTime = 0;

function isDevicePhysicallyOnline(adbBin, serial) {
  return new Promise((resolve) => {
    exec(`"${adbBin}" -s ${serial} get-state`, { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(false);
      const state = (stdout || '').trim().toLowerCase();
      resolve(state === 'device');
    });
  });
}

function unlockAllScreens(adbBin, serials) {
  const cmd = 'svc power stayon true && settings put global stay_on_while_plugged_in 3 && settings put system screen_off_timeout 2147483647 && input keyevent 224 && wm dismiss-keyguard';
  for (const s of serials) {
    try {
      exec(`"${adbBin}" -s ${s} shell "${cmd}"`, { timeout: 5000 }, () => {});
    } catch (_) {}
  }
}

/**
 * Start the recovery polling loop.
 * @param {Function} onDeviceAdd    – same handler as adb-tracker's handleDeviceAdd
 * @param {Function} onDeviceRemove – same handler as adb-tracker's handleDeviceRemove
 * @param {number} intervalMs      – polling interval, default 15000ms
 */
function startEnrollmentGuard(onDeviceAdd, onDeviceRemove, intervalMs = 15000) {
  _addDeviceCallback = onDeviceAdd;
  _removeDeviceCallback = onDeviceRemove;

  if (_intervalTimer) clearInterval(_intervalTimer);

  logger.info('[EnrollmentGuard] Auto-enrollment recovery service started');

  _intervalTimer = setInterval(async () => {
    try {
      await runRecoveryCheck();
    } catch (err) {
      logger.warn(`[EnrollmentGuard] Recovery check error: ${err.message}`);
    }
  }, intervalMs);
}

async function runRecoveryCheck(force = false) {
  const adbBin = resolveAdb();
  const rawSerials = await listAdbDevices(adbBin);

  // If ADB poll timed out or failed, skip cycle without touching running streams
  if (rawSerials === null) {
    logger.info('[EnrollmentGuard] Skipping scan cycle — protecting all active device streams');
    return;
  }

  // Strict USB only: disconnect and filter out any WiFi IP endpoints
  const adbSerials = [];
  for (const s of rawSerials) {
    if (s.includes(':')) {
      logger.info(`[EnrollmentGuard] Disconnecting wireless ADB endpoint ${s} — strict USB debugging only`);
      try {
        exec(`"${adbBin}" disconnect ${s}`, { timeout: 3000 }, () => {});
      } catch (_) {}
    } else {
      adbSerials.push(s);
    }
  }

  const activeSerials = new Set(processManager.getActiveSerials());
  const streamService = require('./stream-service');

  // ── Periodic Keep-Alive: ensure all connected phone screens stay awake & unlocked every 60 seconds ──
  const nowScan = Date.now();
  if (nowScan - _lastPeriodicUnlockTime >= 60000) {
    _lastPeriodicUnlockTime = nowScan;
    unlockAllScreens(adbBin, adbSerials);
  }

  // ── 1. Re-enroll physical USB devices seen by ADB but not actively streaming, or recover failed streams ──
  for (const serial of adbSerials) {
    const session = processManager.getDevice(serial);
    const isHealthy = streamService.isStreamHealthy(serial);

    if (session && isHealthy) {
      _missingCounts.delete(serial);
      continue; // Fully streaming and healthy ✓
    }

    if (session && !isHealthy) {
      _missingCounts.delete(serial);

      // Debounce auto-heal: allow at most once per 60 seconds per device
      const now = Date.now();
      const lastHeal = _lastAutoHealMap.get(serial) || 0;
      if (now - lastHeal < 60000) {
        continue;
      }

      // Deterministic physical state check — NO GUESSING
      const isOnline = await isDevicePhysicallyOnline(adbBin, serial);
      if (!isOnline) {
        logger.info(`[EnrollmentGuard] Device ${serial} is physically offline on USB bus — preserving session and awaiting device reconnect`);
        continue;
      }
      _lastAutoHealMap.set(serial, now);

      logger.warn(`[EnrollmentGuard] ⚡ [AutoHeal] Stream interruption detected for ${serial} — auto-healing in-place without taking stream offline...`);
      try {
        if (typeof streamService.autoHealStream === 'function') {
          streamService.autoHealStream(serial).catch(err => {
            logger.warn(`[EnrollmentGuard] Auto-heal notice for ${serial}: ${err.message}`);
          });
        }
      } catch (err) {
        logger.warn(`[EnrollmentGuard] Auto-heal invocation error for ${serial}: ${err.message}`);
      }
      continue; // Session preserved on existing port, do NOT kill device or allocate new port!
    }

    if (!session) {
      if (_inProgress.has(serial)) continue; // Already being provisioned ✓

      logger.info(`[EnrollmentGuard] Enrolling unstreamed USB device: ${serial}`);
      _inProgress.add(serial);

      try {
        await _addDeviceCallback({ id: serial, type: 'device' });
      } catch (err) {
        logger.warn(`[EnrollmentGuard] Enrollment failed for ${serial}: ${err.message}`);
      } finally {
        _inProgress.delete(serial);
      }
    }
  }

  // ── 2. Clean up stale processManager entries for vanished or legacy WiFi devices ─
  for (const serial of activeSerials) {
    if (serial.includes(':')) {
      logger.info(`[EnrollmentGuard] Purging legacy/stale WiFi session: ${serial}`);
      try {
        if (_removeDeviceCallback) {
          await _removeDeviceCallback({ id: serial });
        } else {
          processManager.killDeviceProcesses(serial);
        }
      } catch (err) {
        logger.warn(`[EnrollmentGuard] Cleanup error for ${serial}: ${err.message}`);
      }
      continue;
    }

    const session = processManager.getDevice(serial);
    const isDirectMatch = adbSerials.includes(serial);
    const isAdbSerialMatch = session && session.adbSerial && adbSerials.includes(session.adbSerial);
    const isHwSerialMatch = session && session.hardwareSerial && adbSerials.includes(session.hardwareSerial);

    if (isDirectMatch || isAdbSerialMatch || isHwSerialMatch) {
      // Device is present in ADB USB list — reset any missing counter
      _missingCounts.delete(serial);
      continue;
    }

    // Debounce removal: device must be missing across 8 consecutive scans (~120s)
    const count = (_missingCounts.get(serial) || 0) + 1;
    _missingCounts.set(serial, count);

    if (count < 8) {
      logger.info(`[EnrollmentGuard] Device ${serial} absent from scan (${count}/8) — holding stream alive`);
      continue;
    }

    logger.info(`[EnrollmentGuard] Device ${serial} confirmed disconnected after ${count} scans — cleaning up`);
    _missingCounts.delete(serial);
    try {
      if (_removeDeviceCallback) {
        await _removeDeviceCallback({ id: serial });
      } else {
        processManager.killDeviceProcesses(serial);
      }
    } catch (err) {
      logger.warn(`[EnrollmentGuard] Cleanup error for ${serial}: ${err.message}`);
    }
  }
}

function stopEnrollmentGuard() {
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
    logger.info('[EnrollmentGuard] Auto-enrollment recovery service stopped');
  }
}

module.exports = { startEnrollmentGuard, stopEnrollmentGuard, runRecoveryCheck };
