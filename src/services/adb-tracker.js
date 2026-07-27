'use strict';

const adb = require('@devicefarmer/adbkit');
const Adb = adb.Adb || adb.default || adb;
const logger = require('../utils/logger');
const { getFreePort } = require('../utils/port-finder');
const { startStreamServer, buildStreamUrl } = require('./stream-service');
const { createTunnel } = require('./tunnel-service');
const apiClient = require('./api-client');
const processManager = require('../main/process-manager');
const rentalPaymentService = require('./rental-payment-service');
const bindingService = require('./binding-service');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

/**
 * Load config for port range.
 */
function loadConfig() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  return {};
}

const config = loadConfig();
const PORT_RANGE_START = config.portRangeStart || 8100;
const PORT_RANGE_END = config.portRangeEnd || 8900;

/** ADB client instance. */
let client = null;

/** Device tracker instance. */
let tracker = null;

/**
 * Debounce map to prevent rapid re-provisioning of the same serial.
 * Maps serial → timestamp of last removal.
 */
const recentRemovals = new Map();
const DEBOUNCE_MS = 3000;

/**
 * Handle a newly detected device.
 * Orchestrates the full pipeline: properties → port → stream → tunnel → API.
 *
 * @param {object} device  The adbkit device object ({ id, type }).
 */
async function handleDeviceAdd(device) {
  const serial = device.id;

  if (processManager.getDevice(serial)) {
    logger.warn(`Device ${serial} already tracked — tearing down old session`);
    await handleDeviceRemove(device);
    await new Promise((r) => setTimeout(r, 1000));
  }

  const lastRemoval = recentRemovals.get(serial);
  if (lastRemoval && Date.now() - lastRemoval < DEBOUNCE_MS) {
    const waitTime = DEBOUNCE_MS - (Date.now() - lastRemoval);
    logger.info(`Debouncing reconnection for ${serial}, waiting ${waitTime}ms`);
    await new Promise((r) => setTimeout(r, waitTime));
  }

  logger.info(`Device connected: ${serial} (type: ${device.type})`);

  try {
    // ----- 1. Read device properties -----
    let deviceModel = 'SM-A042F';
    let deviceBrand = 'samsung';

    try {
      const deviceClient = client.getDevice(serial);
      const properties = await deviceClient.getProperties();
      deviceModel = properties['ro.product.model'] || 'SM-A042F';
      deviceBrand = properties['ro.product.brand'] || 'samsung';
      logger.info(`Device properties for ${serial}`, { deviceModel, deviceBrand });
      // ----- 1b. Stealth Hardening -----
      const ADB_BIN = process.platform === 'win32' ? 'C:\\platform-tools\\adb.exe' : 'adb';
      exec(`"${ADB_BIN}" -s ${serial} shell settings put global development_settings_enabled 0`, () => {});
    } catch (err) {
      logger.warn(`Could not read properties for ${serial}`, { error: err.message });
    }

    // ----- 2. Check / Register Supabase Monthly Device Rental Status ($30 USD/mo) -----
    await bindingService.syncMachineBindingToSupabase([{ serial, model: deviceModel, brand: deviceBrand }]);
    const rentalInfo = await rentalPaymentService.checkDeviceRentalStatus(serial);
    if (!rentalInfo.isPaid) {
      logger.warn(`[RENTAL ENFORCEMENT] Device ${serial} rental is ${rentalInfo.status.toUpperCase()} ($30 USD/month unpaid). Stream link will be INVALIDATED until paid.`);
    } else {
      logger.info(`[RENTAL ACTIVE] Device ${serial} monthly rental ($30 USD) is PAID and ACTIVE.`);
    }

    // ----- 3. Allocate a free port -----
    const port = await getFreePort(PORT_RANGE_START, PORT_RANGE_END);
    logger.info(`Allocated port ${port} for device ${serial}`);

    // ----- 4. Start stream server -----
    const { streamProcess, localUrl } = await startStreamServer(serial, port);
    logger.info(`Stream server started for ${serial}`, { localUrl });

    // ----- 5. Create Cloudflare tunnel -----
    let publicUrl = null;
    let tunnelProcess = null;

    try {
      const tunnelResult = await createTunnel(port);
      publicUrl = tunnelResult.publicUrl;
      tunnelProcess = tunnelResult.tunnelProcess;
      logger.info(`Tunnel created for ${serial}`, { publicUrl });
    } catch (err) {
      logger.error(`Failed to create tunnel for ${serial} — device will be local-only`, {
        error: err.message,
      });
    }

    // ----- 6. Build the complete stream URL -----
    let streamUrl;
    if (publicUrl) {
      streamUrl = buildStreamUrl(publicUrl, port, serial);
    } else {
      streamUrl = `http://localhost:${port}/?action=proxy&remote=tcp%3A127.0.0.1%3A${port}&udid=${encodeURIComponent(serial)}`;
    }
    logger.info(`Stream URL for ${serial}: ${streamUrl}`);

    // ----- 7. Register with process manager -----
    processManager.addDevice(serial, {
      streamProcess,
      tunnelProcess,
      port,
      publicUrl,
      streamUrl,
      model: deviceModel,
      brand: deviceBrand,
      deviceModel,
      deviceBrand,
      paymentStatus: rentalInfo.status,
      isPaid: rentalInfo.isPaid,
      monthlyFeeUsd: rentalInfo.monthlyFee || 30,
    });

    // ----- 8. Register with central API -----
    await apiClient.registerDevice({
      serialNumber: serial,
      deviceModel,
      deviceBrand,
      streamUrl,
      status: rentalInfo.isPaid ? 'ONLINE' : 'UNPAID_BLOCKED',
      rentalStatus: rentalInfo.status,
    });

    logger.info(`Device ${serial} (${deviceBrand} ${deviceModel}) provisioned (Rental Paid: ${rentalInfo.isPaid})`);
  } catch (err) {
    logger.error(`Failed to provision device ${serial}`, { error: err.message, stack: err.stack });
    processManager.killDeviceProcesses(serial);
  }
}

/**
 * Handle a device disconnection.
 * Cleans up processes and notifies central API.
 *
 * @param {object} device  The adbkit device object ({ id, type }).
 */
async function handleDeviceRemove(device) {
  const serial = device.id;
  logger.info(`Device disconnected: ${serial}`);
  recentRemovals.set(serial, Date.now());

  processManager.killDeviceProcesses(serial);
  await apiClient.deregisterDevice(serial);
  logger.info(`Device ${serial} cleanup complete`);
}

/**
 * Initialize ADB tracker and listen for device connection/disconnection events.
 */
async function startTracking() {
  const adbHost = config.adbHost || '127.0.0.1';
  const adbPort = config.adbPort || 5037;
  let adbPath = config.adbPath || 'adb';
  const bundledAdb = path.join(__dirname, '../../assets/bin/adb.exe');
  if (!fs.existsSync(adbPath)) {
    if (fs.existsSync(bundledAdb)) {
      adbPath = bundledAdb;
    } else if (fs.existsSync('C:\\platform-tools\\adb.exe')) {
      adbPath = 'C:\\platform-tools\\adb.exe';
    } else {
      adbPath = 'adb';
    }
  }

  logger.info(`Initializing ADB client with binary: ${adbPath}`);
  client = Adb.createClient({ host: adbHost, port: adbPort, bin: adbPath });

  logger.info('Starting ADB device tracker...');

  try {
    const devices = await client.listDevices();
    logger.info(`Initial ADB device scan found ${devices.length} device(s)`);

    for (const device of devices) {
      if (device.type === 'device') {
        await handleDeviceAdd(device);
      }
    }
  } catch (err) {
    logger.error('Failed initial ADB device scan', { error: err.message });
  }

  try {
    tracker = await client.trackDevices();

    tracker.on('add', (device) => {
      if (device.type === 'device') {
        handleDeviceAdd(device);
      }
    });

    tracker.on('remove', (device) => {
      handleDeviceRemove(device);
    });

    tracker.on('end', () => {
      logger.warn('ADB tracker ended — attempting to restart in 5s');
      setTimeout(startTracking, 5000);
    });

    tracker.on('error', (err) => {
      logger.error('ADB tracker error', { error: err.message });
    });

    logger.info('ADB device tracker started successfully');
  } catch (err) {
    logger.error('Failed to start ADB device tracker — retrying in 5s', { error: err.message });
    setTimeout(startTracking, 5000);
  }
}

/**
 * Stop the ADB tracker.
 */
function stopTracking() {
  if (tracker) {
    try {
      tracker.end();
      tracker = null;
      logger.info('ADB device tracker stopped');
    } catch (err) {
      logger.error('Error stopping ADB tracker', { error: err.message });
    }
  }
}

module.exports = {
  startTracking,
  stopTracking,
};
