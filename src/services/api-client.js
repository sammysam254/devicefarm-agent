'use strict';

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

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

const isCentralApiPlaceholder = !config.centralApiUrl || config.centralApiUrl.includes('your-central-platform.com');

const httpClient = axios.create({
  baseURL: isCentralApiPlaceholder ? 'http://localhost:3000' : config.centralApiUrl,
  timeout: 5000,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.agentSecretKey || ''}`,
  },
});

let heartbeatTimer = null;

async function registerDevice(payload) {
  if (isCentralApiPlaceholder) {
    logger.info(`[Standalone Local Mode] Device ${payload.serialNumber} ready at ${payload.streamUrl}`);
    return { status: 'local_standalone' };
  }

  try {
    const body = {
      serialNumber: payload.serialNumber,
      deviceModel: payload.deviceModel,
      deviceBrand: payload.deviceBrand,
      streamUrl: payload.streamUrl,
      localPort: payload.localPort,
      status: 'online',
      timestamp: new Date().toISOString(),
    };
    const response = await httpClient.post('/register', body);
    logger.info(`[OK] Registered device ${payload.serialNumber} with central API`);
    return response.data;
  } catch (err) {
    logger.info(`[Standalone Local Mode] Central API offline for ${payload.serialNumber}`);
    return null;
  }
}

async function unregisterDevice(serialNumber) {
  if (isCentralApiPlaceholder) return null;
  try {
    const body = { serialNumber, status: 'offline', timestamp: new Date().toISOString() };
    const response = await httpClient.post('/unregister', body);
    return response.data;
  } catch (_) {
    return null;
  }
}

async function sendHeartbeat(activeSerials) {
  if (isCentralApiPlaceholder) return null;
  try {
    const body = { activeDevices: activeSerials, timestamp: new Date().toISOString() };
    const response = await httpClient.post('/heartbeat', body);
    return response.data;
  } catch (_) {
    return null;
  }
}

function startHeartbeat(getActiveSerials) {
  if (isCentralApiPlaceholder) return;
  const interval = config.heartbeatIntervalMs || 30000;
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    const serials = getActiveSerials();
    if (serials.length > 0) {
      await sendHeartbeat(serials);
    }
  }, interval);
  if (heartbeatTimer.unref) {
    heartbeatTimer.unref();
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

module.exports = {
  registerDevice,
  unregisterDevice,
  deregisterDevice: unregisterDevice,
  sendHeartbeat,
  startHeartbeat,
  stopHeartbeat,
};
