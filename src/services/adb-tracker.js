'use strict';

const adb = require('@devicefarmer/adbkit');
const Adb = adb.Adb || adb.default || adb;
const logger = require('../utils/logger');
const { getFreePort } = require('../utils/port-finder');
const { startStreamServer, buildStreamUrl } = require('./stream-service');
const { createTunnel } = require('./tunnel-service');
const apiClient = require('./api-client');
const processManager = require('../main/process-manager');
const bindingService = require('./binding-service');
const licenseService = require('./license-service');
const enrollmentGuard = require('./enrollment-guard');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) {}
    }
  }
  return {};
}

const config = loadConfig();
const PORT_RANGE_START = config.portRangeStart || 8100;
const PORT_RANGE_END   = config.portRangeEnd   || 8900;

let client  = null;
let tracker = null;

const recentRemovals = new Map();
const DEBOUNCE_MS = 3000;

// ─── Device Add ───────────────────────────────────────────────────────────────

async function handleDeviceAdd(device) {
  const serial = device.id;

  if (processManager.getDevice(serial)) {
    logger.warn(`Device ${serial} already tracked — tearing down old session`);
    await handleDeviceRemove(device);
    await new Promise(r => setTimeout(r, 1000));
  }

  const lastRemoval = recentRemovals.get(serial);
  if (lastRemoval && Date.now() - lastRemoval < DEBOUNCE_MS) {
    const waitTime = DEBOUNCE_MS - (Date.now() - lastRemoval);
    logger.info(`Debouncing reconnection for ${serial}, waiting ${waitTime}ms`);
    await new Promise(r => setTimeout(r, waitTime));
  }

  logger.info(`Device connected: ${serial} (type: ${device.type})`);

  try {
    // 1. Read device properties
    let deviceModel = 'Android';
    let deviceBrand  = 'Generic';

    try {
      const deviceClient = client.getDevice(serial);
      const props = await deviceClient.getProperties();
      deviceModel = props['ro.product.model'] || deviceModel;
      deviceBrand  = props['ro.product.brand']  || deviceBrand;
      logger.info(`Device properties: ${serial} → ${deviceBrand} ${deviceModel}`);
    } catch (err) {
      logger.warn(`Could not read properties for ${serial}: ${err.message}`);
    }

    // 2. Sync machine binding (no payment check — license managed online)
    const bindingCode = await bindingService.syncMachineBinding();
    const licenseStatus = await licenseService.checkLicenseStatus(bindingCode);

    if (!licenseStatus.isActive) {
      logger.warn(`[LICENSE] Binding ${bindingCode} is NOT licensed: ${licenseStatus.note}`);
      logger.warn(`[LICENSE] Device ${serial} stream will be locked until license is restored by seed admin.`);
    } else {
      logger.info(`[LICENSE] Binding ${bindingCode} is active (${licenseStatus.mode})`);
    }

    // 3. Allocate port
    const port = await getFreePort(PORT_RANGE_START, PORT_RANGE_END);
    logger.info(`Allocated port ${port} for device ${serial}`);

    // 4. Start stream server (always starts — license is enforced at website level)
    const { streamProcess, localUrl } = await startStreamServer(serial, port);
    logger.info(`Stream server started for ${serial}: ${localUrl}`);

    // 5. Create Cloudflare tunnel
    let publicUrl    = null;
    let tunnelProcess = null;

    try {
      const tunnelResult = await createTunnel(port);
      publicUrl     = tunnelResult.publicUrl;
      tunnelProcess = tunnelResult.tunnelProcess;
      logger.info(`Tunnel created for ${serial}: ${publicUrl}`);
    } catch (err) {
      logger.warn(`Failed to create tunnel for ${serial} — local-only: ${err.message}`);
    }

    // 6. Build stream URL
    const streamUrl = publicUrl
      ? buildStreamUrl(publicUrl, port, serial)
      : `http://localhost:${port}/?udid=${encodeURIComponent(serial)}`;

    logger.info(`Stream URL for ${serial}: ${streamUrl}`);

    // 7. Register with process manager
    processManager.addDevice(serial, {
      streamProcess,
      tunnelProcess,
      port,
      publicUrl,
      streamUrl,
      localUrl,
      model: deviceModel,
      brand: deviceBrand,
      deviceModel,
      deviceBrand,
      bindingCode,
      isPaid: licenseStatus.isActive,
      paymentStatus: licenseStatus.mode,
    });

    // 8. Sync device + stream URL to Supabase cloud (enables real-time URL updates for website users)
    await bindingService.syncDeviceUrl(serial, streamUrl, {
      model: deviceModel,
      brand: deviceBrand,
      localUrl,
      port,
    });

    // 9. Register with central API (silent fail)
    try {
      await apiClient.registerDevice({
        serialNumber: serial,
        deviceModel,
        deviceBrand,
        streamUrl,
        status: 'ONLINE',
      });
    } catch (_) {}

    logger.info(`✅ Device ${serial} (${deviceBrand} ${deviceModel}) provisioned — stream ready`);
  } catch (err) {
    logger.error(`Failed to provision device ${serial}: ${err.message}`, { stack: err.stack });
    processManager.killDeviceProcesses(serial);
  }
}

// ─── Device Remove ────────────────────────────────────────────────────────────

async function handleDeviceRemove(device) {
  const serial = device.id;
  logger.info(`Device disconnected: ${serial}`);
  recentRemovals.set(serial, Date.now());

  processManager.killDeviceProcesses(serial);

  // Mark device offline in Supabase
  licenseService.markDeviceOffline(serial).catch(() => {});

  try { await apiClient.deregisterDevice(serial); } catch (_) {}
  logger.info(`Device ${serial} cleanup complete`);
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

async function startTracking() {
  const cfg = loadConfig();
  const adbHost = cfg.adbHost || '127.0.0.1';
  const adbPort = cfg.adbPort || 5037;

  let adbPath = cfg.adbPath || 'adb';
  const bundledAdb = path.join(__dirname, '../../assets/bin/adb.exe');
  if (!fs.existsSync(adbPath)) {
    if      (fs.existsSync(bundledAdb)) adbPath = bundledAdb;
    else if (fs.existsSync('C:\\platform-tools\\adb.exe')) adbPath = 'C:\\platform-tools\\adb.exe';
    else adbPath = 'adb';
  }

  logger.info(`Initializing ADB client: ${adbPath}`);
  client = Adb.createClient({ host: adbHost, port: adbPort, bin: adbPath });
  logger.info('Starting ADB device tracker...');

  try {
    const devices = await client.listDevices();
    logger.info(`Initial ADB scan: ${devices.length} device(s)`);
    for (const d of devices) {
      if (d.type === 'device') await handleDeviceAdd(d);
    }
  } catch (err) {
    logger.error(`Initial ADB scan failed: ${err.message}`);
  }

  try {
    tracker = await client.trackDevices();

    tracker.on('add',    (d) => { if (d.type === 'device') handleDeviceAdd(d); });
    tracker.on('remove', (d) => handleDeviceRemove(d));
    tracker.on('end',    () => {
      logger.warn('ADB tracker ended — restarting in 5s');
      setTimeout(startTracking, 5000);
    });
    tracker.on('error', (err) => logger.error(`ADB tracker error: ${err.message}`));

    logger.info('✅ ADB device tracker started');

    // Start background enrollment guard (catches rebooted/silently-reconnected devices)
    enrollmentGuard.startEnrollmentGuard(handleDeviceAdd, handleDeviceRemove, 12000);
  } catch (err) {
    logger.error(`Failed to start ADB tracker: ${err.message} — retry in 5s`);
    setTimeout(startTracking, 5000);
  }
}

function stopTracking() {
  enrollmentGuard.stopEnrollmentGuard();
  if (tracker) {
    try { tracker.end(); tracker = null; logger.info('ADB tracker stopped'); }
    catch (err) { logger.error(`Error stopping ADB tracker: ${err.message}`); }
  }
}

module.exports = { startTracking, stopTracking };
