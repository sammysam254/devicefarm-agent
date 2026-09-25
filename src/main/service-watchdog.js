'use strict';

/**
 * DeviceFarm Agent — Autonomous Background Service Watchdog
 *
 * Supervises the DeviceFarm Agent process. If the agent crashes, is closed,
 * or terminates unexpectedly, the watchdog automatically relaunches it
 * after a 3-second delay, ensuring 24/7 continuous unattended operation.
 */

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..', '..');
let activeChild = null;
let restartCount = 0;
let isStopping = false;

function preLaunchCleanup() {
  try {
    // 0. Automatically sync latest code from GitHub if git is available
    try {
      execSync('git pull --ff-only origin main >nul 2>&1', { timeout: 15000, stdio: 'ignore', cwd: rootDir });
    } catch (_) {}

    // 1. Permanently remove any legacy cache file if created
    const wifiCache = path.join(rootDir, 'wifi-devices-cache.json');
    if (fs.existsSync(wifiCache)) {
      try { fs.unlinkSync(wifiCache); } catch (_) {}
    }

    // 2. Terminate any orphaned electron instances from prior runs
    if (process.platform === 'win32') {
      try {
        execSync('taskkill /F /IM electron.exe >nul 2>&1', { timeout: 3000, stdio: 'ignore' });
      } catch (_) {}
    }
  } catch (_) {}
}

function getLaunchTarget() {
  const localElectron = path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  const mainScript = path.join(rootDir, 'src', 'main', 'index.js');
  if (fs.existsSync(localElectron)) {
    return { bin: localElectron, args: [mainScript, '--hidden'] };
  }
  return { bin: process.execPath, args: [mainScript] };
}

function startAgent() {
  if (isStopping) return;

  preLaunchCleanup();

  const target = getLaunchTarget();

  try {
    activeChild = spawn(target.bin, target.args, {
      cwd: rootDir,
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
      env: { ...process.env, BACKGROUND_SERVICE: '1' }
    });

    activeChild.on('error', (err) => {
      // Avoid crash on spawn error, retry after delay
      scheduleRestart();
    });

    activeChild.on('exit', (code, signal) => {
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

let cloudflaredChild = null;

function resolveCloudflaredPath() {
  const candidates = [
    path.join(rootDir, 'assets', 'bin', 'cloudflared.exe'),
    path.join(rootDir, 'cloudflared.exe'),
    'C:\\DeviceFarmAgent\\assets\\bin\\cloudflared.exe',
    'C:\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        if (fs.statSync(c).size > 1000000) return c;
      } catch (_) {}
    }
  }
  return null;
}

function superviseCloudflared() {
  if (isStopping) return;
  const token = 'eyJhIjoiMjEzYzI3Y2IwOTVjZTBlMTE0ZTNkNWYzZDM3ODJiNWQiLCJ0IjoiMDVkMzUyZjgtZGU5Yi00MzBiLWIxYzUtNDUyNzNlZWQzOTExIiwicyI6Ik1qWmlaak13WVdZdE1UTmpPUzAwTm1NeExUZ3hNR0V0TlRWalpURTFNV1ZsTURNMSJ9';
  const bin = resolveCloudflaredPath();
  if (!bin) return;

  const { exec } = require('child_process');
  exec('tasklist /FI "IMAGENAME eq cloudflared.exe" /FO CSV /NH', (err, stdout) => {
    if (!err && stdout && stdout.toLowerCase().includes('cloudflared.exe')) {
      return; // Already running in background
    }
    try {
      cloudflaredChild = spawn(bin, ['tunnel', 'run', '--token', token], {
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
      });
      cloudflaredChild.on('exit', () => { cloudflaredChild = null; });
      cloudflaredChild.on('error', () => { cloudflaredChild = null; });
    } catch (_) {}
  });
}

// Handle termination signals cleanly
process.on('SIGINT', () => {
  isStopping = true;
  if (activeChild) {
    try { activeChild.kill(); } catch (_) {}
  }
  if (cloudflaredChild) {
    try { cloudflaredChild.kill(); } catch (_) {}
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  isStopping = true;
  if (activeChild) {
    try { activeChild.kill(); } catch (_) {}
  }
  if (cloudflaredChild) {
    try { cloudflaredChild.kill(); } catch (_) {}
  }
  process.exit(0);
});

// Start the initial supervised agent process & cloudflared tunnel
startAgent();
superviseCloudflared();
setInterval(superviseCloudflared, 15000);
