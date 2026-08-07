'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger');
const licenseService = require('./license-service');

function loadConfigPath() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(process.cwd(), 'config.json');
}

function loadConfig() {
  const cfgPath = loadConfigPath();
  if (fs.existsSync(cfgPath)) {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch (_) {}
  }
  return {};
}

function saveConfig(cfg) {
  const cfgPath = loadConfigPath();
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * Derives a static, deterministic 8-digit machine binding code based on machine hardware identity.
 * This guarantees the exact same computer ALWAYS keeps the exact same binding code across setup script reruns.
 */
function getOrGenerateBindingCode() {
  const cfg = loadConfig();
  if (cfg.machineBindingCode && /^\d{8}$/.test(cfg.machineBindingCode)) {
    return cfg.machineBindingCode;
  }

  const hostname = os.hostname() || process.env.COMPUTERNAME || 'Windows-Machine';
  const interfaces = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        mac = net.mac;
        break;
      }
    }
    if (mac) break;
  }

  const rawSeed = `${hostname.toLowerCase()}-${mac.toLowerCase() || 'default-mac'}`;
  const hash = crypto.createHash('sha256').update(rawSeed).digest('hex');
  const bindingCode = (parseInt(hash.substring(0, 8), 16) % 90000000 + 10000000).toString();

  cfg.machineBindingCode = bindingCode;
  saveConfig(cfg);
  logger.info(`[BindingService] Derived hardware machine code for ${hostname}: ${bindingCode}`);
  return bindingCode;
}

/**
 * Sync machine binding to Supabase machine_bindings table.
 */
async function syncMachineBinding() {
  const bindingCode = getOrGenerateBindingCode();
  const cfg = loadConfig();
  
  // PRIORITY: Read from environment variables for security
  const supabaseUrl = process.env.SUPABASE_URL || cfg.supabaseUrl;
  const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey;

  if (!supabaseUrl || !apiKey) return bindingCode;

  try {
    const axios = require('axios');
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

    // Upsert machine_bindings with on_conflict=binding_code
    await client.post('/machine_bindings?on_conflict=binding_code', {
      binding_code: bindingCode,
      machine_name: process.env.COMPUTERNAME || os.hostname() || 'Windows Agent Machine',
      updated_at: new Date().toISOString(),
    }, {
      headers: { Prefer: 'resolution=merge-duplicates' },
    });

    logger.info(`[BindingService] Machine binding code ${bindingCode} synced to Supabase`);
  } catch (err) {
    logger.warn(`[BindingService] Sync notice: ${err.message}`);
  }

  return bindingCode;
}

/**
 * Sync a device's stream URL to Supabase.
 * Called each time device connects or tunnel URL changes.
 */
async function syncDeviceUrl(serial, streamUrl, opts = {}) {
  // Disable cloud sync if explicitly requested
  if (process.env.DISABLE_CLOUD_SYNC === 'true' || process.env.DISABLE_CLOUD_SYNC === '1') {
    logger.info(`[BindingService] Cloud sync disabled for ${serial} (DISABLE_CLOUD_SYNC env var set)`);
    return;
  }
  
  const bindingCode = getOrGenerateBindingCode();
  await licenseService.syncDeviceToCloud({
    serial,
    model: opts.model,
    brand: opts.brand,
    streamUrl,
    localUrl: opts.localUrl,
    port: opts.port,
    bindingCode,
    status: 'online',
  });
}

module.exports = {
  getOrGenerateBindingCode,
  syncMachineBinding,
  syncDeviceUrl,
};
