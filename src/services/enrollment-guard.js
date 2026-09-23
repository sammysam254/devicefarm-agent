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
    exec(`"${adbBin}" devices`, { timeout: 25000 }, (err, stdout, stderr) => {
      if (err) {
        _consecutiveAdbFailures++;
        logger.warn(`[EnrollmentGuard] adb devices poll warning (attempt ${_consecutiveAdbFailures}): ${err.message}`);
        // If ADB daemon has truly failed/hung across multiple checks, heal it cleanly
        if (_consecutiveAdbFailures >= 2) {
          logger.error(`[EnrollmentGuard] ADB daemon failure confirmed (${_consecutiveAdbFailures} consecutive failed polls) — auto-restarting ADB daemon...`);
          _consecutiveAdbFailures = 0;
          try {
            if (process.platform === 'win32') {
              const { execSync } = require('child_process');
              try { execSync(`"${adbBin}" kill-server >nul 2>&1`, { timeout: 4000, stdio: 'ignore' }); } catch (_) {}
              try { execSync(`"${adbBin}" start-server >nul 2>&1`, { timeout: 8000, stdio: 'ignore' }); } catch (_) {}
              try { execSync(`"${adbBin}" reconnect >nul 2>&1`, { timeout: 4000, stdio: 'ignore' }); } catch (_) {}
            }
          } catch (e) {
            logger.warn('[EnrollmentGuard] ADB daemon restart notice:', e.message);
          }
        }
        resolve(null);
        return;
      }
      _consecutiveAdbFailures = 0;
      const lines = (stdout || '').split('\n').slice(1);
      const serials = [];
      let hasOffline = false;
      const unauthorizedSerials = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          if (parts[1] === 'device') {
            serials.push(parts[0]);
          } else if (parts[1] === 'offline') {
            hasOffline = true;
          } else if (parts[1] === 'unauthorized') {
            unauthorizedSerials.push(parts[0]);
          }
        }
      }
      if (hasOffline) {
        try {
          exec(`"${adbBin}" reconnect offline`, { timeout: 4000 }, () => {});
        } catch (_) {}
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

  // ── 1. Re-enroll physical USB devices seen by ADB but not actively streaming, or recover failed streams ──
  for (const serial of adbSerials) {
    const session = processManager.getDevice(serial);
    const isHealthy = streamService.isStreamHealthy(serial);

    if (session && isHealthy) {
      _missingCounts.delete(serial);
      continue; // Fully streaming and healthy ✓
    }

    if (session && !isHealthy) {
      logger.warn(`[EnrollmentGuard] Stream failure detected on device ${serial} (server/engine stopped) — auto-restarting stream...`);
      try {
        processManager.killDeviceProcesses(serial);
      } catch (_) {}
    }

    if (_inProgress.has(serial)) continue; // Already being provisioned ✓

    logger.info(`[EnrollmentGuard] Enrolling/Recovering USB device: ${serial}`);
    _inProgress.add(serial);

    try {
      await _addDeviceCallback({ id: serial, type: 'device' });
    } catch (err) {
      logger.warn(`[EnrollmentGuard] Re-enrollment failed for ${serial}: ${err.message}`);
    } finally {
      _inProgress.delete(serial);
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

    // Debounce removal: device must be missing across 4 consecutive scans (~60s)
    const count = (_missingCounts.get(serial) || 0) + 1;
    _missingCounts.set(serial, count);

    if (count < 4) {
      logger.info(`[EnrollmentGuard] Device ${serial} absent from scan (${count}/4) — holding stream alive`);
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
