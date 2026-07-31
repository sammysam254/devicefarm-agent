'use strict';

const { app, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const processManager = require('./process-manager');
const autoLaunch = require('./auto-launch');
const adbTracker = require('../services/adb-tracker');
const apiClient = require('../services/api-client');
const { isCloudflaredAvailable } = require('../services/tunnel-service');
const { startDashboardServer, openInChrome, stopDashboardServer, getDashboardUrl } = require('../dashboard/server');

// ──────────────────────────────────────────────────────────
//  Globals
// ──────────────────────────────────────────────────────────

let tray = null;
let isShuttingDown = false;

// ──────────────────────────────────────────────────────────
//  Tray Icon & Context Menu
// ──────────────────────────────────────────────────────────

/**
 * Resolve the tray icon path.
 */
function getIconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    path.join(process.cwd(), 'assets', 'icon.png'),
    path.join(process.cwd(), 'assets', 'icon.png.png'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return candidates[0];
}

/**
 * Build the system tray context menu dynamically.
 */
function buildTrayMenu() {
  const devices = processManager.getActiveDeviceSummaries();
  const menuTemplate = [];

  // Device list section
  if (devices.length === 0) {
    menuTemplate.push({
      label: 'No devices connected',
      enabled: false,
    });
  } else {
    menuTemplate.push({
      label: `Connected Devices (${devices.length})`,
      enabled: false,
    });
    menuTemplate.push({ type: 'separator' });

    for (const d of devices) {
      const label = `${d.brand || ''} ${d.model || ''} (${d.serial}) — Port ${d.port}`.trim();
      menuTemplate.push({
        label: label,
        submenu: [
          {
            label: 'Open Stream Web Page',
            click: () => {
              shell.openExternal(d.streamUrl);
            },
          },
          {
            label: 'Copy Stream URL',
            click: () => {
              const { clipboard } = require('electron');
              clipboard.writeText(d.streamUrl);
            },
          },
          {
            label: 'Reboot Device',
            click: () => {
              const { exec } = require('child_process');
              exec(`adb -s ${d.serial} reboot`);
            },
          },
        ],
      });
    }
  }

  menuTemplate.push({ type: 'separator' });

  // Open Dashboard
  menuTemplate.push({
    label: 'Open Web Dashboard',
    click: () => {
      openInChrome(getDashboardUrl());
    },
  });

  // Copy Dashboard URL
  menuTemplate.push({
    label: 'Copy Dashboard Link',
    click: () => {
      const { clipboard } = require('electron');
      clipboard.writeText(getDashboardUrl());
    },
  });

  menuTemplate.push({ type: 'separator' });

  // Auto-launch toggle
  const isAutoStart = autoLaunch.isEnabled();
  menuTemplate.push({
    label: 'Start on Windows Boot',
    type: 'checkbox',
    checked: isAutoStart,
    click: async (item) => {
      if (item.checked) {
        await autoLaunch.enable();
      } else {
        await autoLaunch.disable();
      }
    },
  });

  menuTemplate.push({ type: 'separator' });

  // About / Status dialog
  menuTemplate.push({
    label: 'Status & Diagnostics',
    click: () => {
      const summary = processManager.getActiveDeviceSummaries();
      const count = summary.length;
      const autoStr = autoLaunch.isEnabled() ? 'Enabled' : 'Disabled';

      dialog.showMessageBox({
        type: 'info',
        title: 'DeviceFarm Agent Diagnostics',
        message: `DeviceFarm Agent v1.0.0\n\nConnected Devices: ${count}\nAuto-Launch: ${autoStr}\nDashboard: ${getDashboardUrl()}`,
        buttons: ['OK'],
      });
    },
  });

  menuTemplate.push({ type: 'separator' });

  // Quit
  menuTemplate.push({
    label: 'Exit DeviceFarm Agent',
    click: () => {
      gracefulShutdown();
    },
  });

  return Menu.buildFromTemplate(menuTemplate);
}

/**
 * Refresh the tray menu and tooltip.
 */
function refreshTrayMenu() {
  if (!tray || isShuttingDown) return;
  const count = processManager.getDeviceCount();
  tray.setToolTip(`DeviceFarm Agent (${count} device${count === 1 ? '' : 's'})`);
  tray.setContextMenu(buildTrayMenu());
}

/**
 * Periodically refresh tray state.
 */
function startTrayRefreshInterval() {
  setInterval(() => {
    refreshTrayMenu();
  }, 5000);
}

async function runStartupChecks() {
  const isAuto = autoLaunch.isEnabled();
  logger.info(`Auto-launch status: ${isAuto ? 'ENABLED' : 'DISABLED'}`);
  logger.info('[OK] DeviceFarm Machine License Engine: ACTIVE (Managed Online)');

  const hasCloudflared = await isCloudflaredAvailable();
  if (hasCloudflared) {
    logger.info('[OK] cloudflared is available for public tunneling');
  } else {
    logger.warn('[!] cloudflared NOT found — devices will be streamable via local network only');
  }
}

// ──────────────────────────────────────────────────────────
//  Graceful Shutdown
// ──────────────────────────────────────────────────────────

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutting down DeviceFarm Agent...');

  try {
    apiClient.stopHeartbeat();
    adbTracker.stopTracking();
    await processManager.stopAll();
    await stopDashboardServer();

    if (tray) {
      tray.destroy();
      tray = null;
    }
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
  }

  logger.info('Shutdown complete. Exiting process.');
  app.quit();
  process.exit(0);
}

// ──────────────────────────────────────────────────────────
//  App Lifecycle Listeners
// ──────────────────────────────────────────────────────────

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.warn('Unhandled promise rejection', { reason: String(reason) });
});

process.on('SIGINT', () => {
  gracefulShutdown();
});

process.on('SIGTERM', () => {
  gracefulShutdown();
});

// ──────────────────────────────────────────────────────────
//  Main Entry — app.whenReady()
// ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  logger.info('====================================');
  logger.info('  DeviceFarm Agent starting...');
  logger.info(`  PID: ${process.pid}`);
  logger.info(`  Platform: ${process.platform}`);
  logger.info(`  Electron: ${process.versions.electron}`);
  logger.info(`  Node: ${process.versions.node}`);
  logger.info('====================================');

  await runStartupChecks();

  // Safely initialize System Tray with resized icon
  const iconPath = getIconPath();
  try {
    const rawImg = nativeImage.createFromPath(iconPath);
    const trayImg = rawImg.isEmpty() ? rawImg : rawImg.resize({ width: 16, height: 16 });
    tray = new Tray(trayImg);
    tray.setToolTip('DeviceFarm Agent — Operational');
    tray.setContextMenu(buildTrayMenu());
    logger.info('System tray initialized');
  } catch (e) {
    logger.warn('Tray icon init warning:', e.message);
  }

  await adbTracker.startTracking();
  apiClient.startHeartbeat(() => processManager.getActiveSerials());
  startTrayRefreshInterval();

  try {
    const { url } = await startDashboardServer(7400);
    openInChrome(url);
  } catch (err) {
    logger.error('Failed to start Dashboard server', { error: err.message });
  }

  setTimeout(() => refreshTrayMenu(), 3000);
  logger.info('DeviceFarm Agent is fully operational');
});
