'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../utils/logger');

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

function saveConfig(cfg) {
  const p = path.join(process.cwd(), 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const licenseCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 1 min

// ─── Supabase client ──────────────────────────────────────────────────────────

function getSupabaseClient() {
  const cfg = loadConfig();
  const url = cfg.supabaseUrl;
  const key = cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey;
  if (!url || !key) return null;
  return axios.create({
    baseURL: `${url.replace(/\/$/, '')}/rest/v1`,
    timeout: 8000,
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
}

// ─── License check ────────────────────────────────────────────────────────────

/**
 * Check if the local machine binding is licensed and active.
 * Returns { isActive, mode, bindingCode, note }
 */
async function checkLicenseStatus(bindingCode) {
  const cached = licenseCache.get(bindingCode);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const client = getSupabaseClient();

  // If Supabase not configured — standalone / free mode
  if (!client) {
    const result = { isActive: true, mode: 'standalone', bindingCode, note: 'No Supabase configured — standalone mode' };
    licenseCache.set(bindingCode, { value: result, at: Date.now() });
    return result;
  }

  try {
    const res = await client.get(
      `/licenses?binding_code=eq.${encodeURIComponent(bindingCode)}&select=*&limit=1`
    );
    const rows = res.data;

    if (!rows || rows.length === 0) {
      // No license record yet — treat as free/active until explicitly revoked
      const result = { isActive: true, mode: 'free', bindingCode, note: 'No license record — auto-active' };
      licenseCache.set(bindingCode, { value: result, at: Date.now() });
      return result;
    }

    const lic = rows[0];
    const isActive = lic.is_active === true && lic.revoked_at === null;
    const result = {
      isActive,
      mode: lic.mode || 'licensed',
      bindingCode,
      note: isActive ? 'Licensed and active' : ('Revoked: ' + (lic.license_note || 'License revoked by seed admin')),
    };
    licenseCache.set(bindingCode, { value: result, at: Date.now() });
    return result;
  } catch (err) {
    logger.warn(`[LicenseService] Failed to check license for ${bindingCode}: ${err.message} — defaulting to active`);
    const result = { isActive: true, mode: 'offline_grace', bindingCode, note: 'Supabase unreachable — offline grace' };
    licenseCache.set(bindingCode, { value: result, at: Date.now() });
    return result;
  }
}

/**
 * Sync device info to Supabase devices table.
 * Called when a device connects or its stream URL changes.
 */
async function syncDeviceToCloud(params) {
  const { serial, model, brand, streamUrl, localUrl, port, bindingCode, status } = params;
  const client = getSupabaseClient();
  if (!client) return;

  try {
    const payload = {
      serial,
      model: model || 'Android Device',
      brand: brand || 'Generic',
      stream_url: streamUrl || null,
      local_url: localUrl || null,
      port: port || null,
      binding_code: bindingCode || null,
      status: status || 'online',
      last_seen: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await client.post('/devices', payload, {
      headers: { Prefer: 'resolution=merge-duplicates' },
    });

    logger.info(`[LicenseService] Device ${serial} synced to cloud (url: ${streamUrl})`);
  } catch (err) {
    logger.warn(`[LicenseService] Device sync notice for ${serial}: ${err.message}`);
  }
}

/**
 * Mark device as offline in Supabase.
 */
async function markDeviceOffline(serial) {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    await client.patch(
      `/devices?serial=eq.${encodeURIComponent(serial)}`,
      { status: 'offline', updated_at: new Date().toISOString() },
      { headers: { Prefer: 'return=minimal' } }
    );
  } catch (_) {}
}

module.exports = {
  checkLicenseStatus,
  syncDeviceToCloud,
  markDeviceOffline,
  loadConfig,
  saveConfig,
};
