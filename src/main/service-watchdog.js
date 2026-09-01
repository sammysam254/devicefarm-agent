'use strict';

/**
 * DeviceFarm Agent — Autonomous Background Service Watchdog
 *
 * Supervises the DeviceFarm Agent process. If the agent crashes, is closed,
 * or terminates unexpectedly, the watchdog automatically relaunches it
 * after a delay, ensuring 24/7 continuous unattended operation.
 * Includes a singleton guard so multiple watchdogs never fight for control.
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

// ── Singleton Guard for Watchdog ─────────────────────────────────────────────
const WATCHDOG_LOCK_PORT = 7419;
const lockServer = net.createServer();

lockServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another watchdog instance is already active and supervising. Exit cleanly.
    process.exit(0);
  }
});

lockServer.listen(WATCHDOG_LOCK_PORT, '127.0.0.1', () => {
  // Lock acquired — proceed as primary supervisor
  startWatchdog();
});

// Ensure watchdog event loop stays active indefinitely
const keepAliveTimer = setInterval(() => {}, 60000);

const rootDir = path.resolve(__dirname, '..', '..');
let activeChild = null;
let restartCount = 0;
let isStopping = false;

function getElectronPath() {
  const localElectron = path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(localElectron)) {
    return localElectron;
  }
  return 'electron';
}

function startWatchdog() {
  startAgent();
}

function startAgent() {
  if (isStopping) return;

  const electronExe = getElectronPath();
  const mainScript = path.join(rootDir, 'src', 'main', 'index.js');
  const args = [mainScript, '--hidden'];

  try {
    activeChild = spawn(electronExe, args, {
      cwd: rootDir,
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, BACKGROUND_SERVICE: '1' }
    });
    try { activeChild.unref(); } catch (_) {}

    activeChild.on('error', () => {
      scheduleRestart();
    });

    activeChild.on('exit', (code) => {
      activeChild = null;
      if (!isStopping) {
        scheduleRestart();
      }
    });
  } catch (err) {
    scheduleRestart();
  }
}

function scheduleRestart() {
  if (isStopping) return;
  restartCount++;
  // Exponential backoff up to 10 seconds if restarting rapidly
  const delay = Math.min(3000 + (restartCount > 5 ? 7000 : 0), 10000);
  setTimeout(() => {
    startAgent();
  }, delay);
}

// Handle termination signals cleanly
process.on('SIGINT', () => {
  isStopping = true;
  if (activeChild) {
    try { activeChild.kill(); } catch (_) {}
  }
  try { lockServer.close(); } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  isStopping = true;
  if (activeChild) {
    try { activeChild.kill(); } catch (_) {}
  }
  try { lockServer.close(); } catch (_) {}
  process.exit(0);
});
