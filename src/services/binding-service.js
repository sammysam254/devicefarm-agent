'use strict';

const fs = require('fs');
const path = require('path');
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
 * Generate or retrieve the unique 8-digit machine binding code.
 */
function getOrGenerateBindingCode() {
  const cfg = loadConfig();
  if (cfg.machineBindingCode && /^\d{8}$/.test(cfg.machineBindingCode)) {
    return cfg.machineBindingCode;
  }
  const randomNum = Math.floor(10000000 + Math.random() * 90000000).toString();
  cfg.machineBindingCode = randomNum;
  saveConfig(cfg);
  logger.info(`[BindingService] Generated new 8-digit machine binding code: ${randomNum}`);
  return randomNum;
}

/**
 * Sync machine binding to Supabase machine_bindings table.
 * Also ensures license record exists.
 */
async function syncMachineBinding() {
  const bindingCode = getOrGenerateBindingCode();
  const cfg = loadConfig();
  const supabaseUrl = cfg.supabaseUrl;
  const apiKey = cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey;

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

    // Upsert machine_bindings
    await client.post('/machine_bindings', {
      binding_code: bindingCode,
      machine_name: process.env.COMPUTERNAME || 'Windows Agent Machine',
      updated_at: new Date().toISOString(),
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
