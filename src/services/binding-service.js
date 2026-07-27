'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../utils/logger');
const { getDecryptedSystemCredentials } = require('../utils/security');
const rentalPaymentService = require('./rental-payment-service');

function loadConfigPath() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return path.join(process.cwd(), 'config.json');
}

function loadConfig() {
  const cfgPath = loadConfigPath();
  if (fs.existsSync(cfgPath)) {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (_) {}
  }
  return {};
}

function saveConfig(cfg) {
  const cfgPath = loadConfigPath();
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * Generate or retrieve the unique 8-digit machine binding code.
 * E.g., "53361175"
 */
function getOrGenerateBindingCode() {
  const cfg = loadConfig();
  if (cfg.machineBindingCode && /^\d{8}$/.test(cfg.machineBindingCode)) {
    return cfg.machineBindingCode;
  }

  const randomNum = Math.floor(10000000 + Math.random() * 90000000).toString();
  cfg.machineBindingCode = randomNum;
  saveConfig(cfg);
  logger.info(`[Binding Service] Generated new 8-digit machine binding code: ${randomNum}`);
  return randomNum;
}

/**
 * Sync machine binding code and connected devices to Supabase.
 */
async function syncMachineBindingToSupabase(devices = []) {
  const bindingCode = getOrGenerateBindingCode();
  const creds = getDecryptedSystemCredentials();
  const supabaseUrl = creds.supabaseUrl;
  const apiKey = creds.supabaseServiceRoleKey || creds.supabaseAnonKey;

  if (!supabaseUrl || !apiKey) return bindingCode;

  try {
    const client = axios.create({
      baseURL: `${supabaseUrl.replace(/\/$/, '')}/rest/v1`,
      timeout: 6000,
      headers: {
        'Content-Type': 'application/json',
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Prefer: 'resolution=merge-duplicates',
      },
    });

    // 1. Check if this 8-digit Machine Code was previously bound to a user account in Supabase
    let boundUserId = null;
    try {
      const resBind = await client.get(`/machine_bindings?binding_code=eq.${bindingCode}&select=*`);
      if (resBind.data && resBind.data.length > 0 && resBind.data[0].user_id) {
        boundUserId = resBind.data[0].user_id;
        const cfg = loadConfig();
        cfg.rentalUserId = boundUserId;
        saveConfig(cfg);
        logger.info(`[Auto-Link] Recognized Machine Code ${bindingCode} auto-bound to profile: ${boundUserId}`);
      }
    } catch (_) {}

    // 2. Register/update machine binding record in Supabase
    try {
      const bindPayload = {
        binding_code: bindingCode,
        machine_name: process.env.COMPUTERNAME || 'Windows Agent Machine',
        updated_at: new Date().toISOString(),
      };
      if (boundUserId) bindPayload.user_id = boundUserId;

      await client.post('/machine_bindings', bindPayload, {
        headers: { Prefer: 'resolution=merge-duplicates' }
      });
    } catch (_) {}

    // 3. Sync connected devices using robust createOrUpdateDeviceRental
    for (const dev of devices) {
      try {
        await rentalPaymentService.createOrUpdateDeviceRental(dev.serial, {
          deviceModel: dev.model || 'Android Device',
          deviceBrand: dev.brand || 'Generic',
        });
      } catch (_) {}
    }

    logger.info(`[Binding Sync] Synced 8-digit code ${bindingCode} and ${devices.length} devices to Supabase.`);
  } catch (err) {
    logger.warn(`[Binding Sync Note] Local machine status ready: ${err.message}`);
  }

  return bindingCode;
}

module.exports = {
  getOrGenerateBindingCode,
  syncMachineBindingToSupabase,
};
