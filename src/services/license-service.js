'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../utils/logger');

// ─── DNS-over-HTTPS (DoH) Client ──────────────────────────────────────────
// Prevent survey apps from analyzing DNS queries to detect infrastructure
class DoHClient {
  constructor() {
    // Rotate between multiple DoH providers to avoid single-point detection
    this.providers = [
      'https://1.1.1.1/dns-query',           // Cloudflare
      'https://8.8.8.8/dns-query',           // Google
      'https://dns.nextdns.io/dns-query',    // NextDNS (privacy-focused)
    ];
    this.currentProvider = 0;
  }
  
  async resolve(hostname) {
    try {
      const provider = this.providers[this.currentProvider];
      this.currentProvider = (this.currentProvider + 1) % this.providers.length;
      
      const response = await axios.get(provider, {
        params: {
          name: hostname,
          type: 'A',
        },
        headers: {
          'Accept': 'application/dns-json',
          // Randomize User-Agent per request
          'User-Agent': this._randomUserAgent(),
        },
        timeout: 5000,
      });
      
      if (response.data.Answer && response.data.Answer.length > 0) {
        return response.data.Answer[0].data;
      }
      return null;
    } catch (err) {
      logger.warn(`[ProxyService] DNS resolution failed for ${hostname}`);
      return null;
    }
  }
  
  _randomUserAgent() {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}

const dohClient = new DoHClient();

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
const ROTATED_STREAM_KEYS = new Map(); // Map<serial, rotated16CharKey>

function getRotatedStreamKey(serial) {
  return ROTATED_STREAM_KEYS.get(serial) || null;
}

function setRotatedStreamKey(serial, key) {
  if (serial && key) {
    ROTATED_STREAM_KEYS.set(serial, key);
  }
}

// Randomize cache TTL to prevent timing attacks (3000-8000ms instead of fixed 5000ms)
const CACHE_TTL_MIN = process.env.CACHE_TTL_MIN ? parseInt(process.env.CACHE_TTL_MIN, 10) : 3000;
const CACHE_TTL_MAX = process.env.CACHE_TTL_MAX ? parseInt(process.env.CACHE_TTL_MAX, 10) : 8000;

function getRandomCacheTTL() {
  return Math.floor(Math.random() * (CACHE_TTL_MAX - CACHE_TTL_MIN + 1)) + CACHE_TTL_MIN;
}

// ─── Supabase client ──────────────────────────────────────────────────────────

function getSupabaseClient() {
  // PRIORITY: Read from environment variables for security
  // Falls back to config.json only if env vars not set
  const url = process.env.SUPABASE_URL || loadConfig().supabaseUrl;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || loadConfig().supabaseServiceRoleKey || loadConfig().supabaseAnonKey;
  
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
  const cacheTTL = getRandomCacheTTL();
  if (cached && Date.now() - cached.at < cacheTTL) return cached.value;

  const client = getSupabaseClient();

  // If Supabase not configured — standalone / free mode
  if (!client) {
    const result = { isActive: true, mode: 'standalone', bindingCode, note: 'No Supabase configured — standalone mode' };
    licenseCache.set(bindingCode, { value: result, at: Date.now() });
    return result;
  }

  try {
    const res = await client.get(
      `/machine_bindings?binding_code=eq.${encodeURIComponent(bindingCode)}&select=*&limit=1`
    );
    const rows = res.data;

    if (!rows || rows.length === 0) {
      // No binding record yet in cloud — treat as free/active
      const result = { isActive: true, mode: 'free', bindingCode, note: 'Unbound machine — active free mode' };
      licenseCache.set(bindingCode, { value: result, at: Date.now() });
      return result;
    }

    const lic = rows[0];
    const isActive = lic.is_licensed !== false;
    const result = {
      isActive,
      mode: lic.license_mode || 'licensed',
      bindingCode,
      note: isActive ? 'Licensed and active' : ('Revoked: ' + (lic.license_note || 'License revoked by seed admin')),
    };
    licenseCache.set(bindingCode, { value: result, at: Date.now() });
    return result;
  } catch (err) {
    logger.warn(`[LicenseService] License check note for ${bindingCode}: ${err.message}`);
    const result = { isActive: true, mode: 'offline_grace', bindingCode, note: 'Supabase notice — active grace mode' };
    licenseCache.set(bindingCode, { value: result, at: Date.now() });
    return result;
  }
}

/**
 * Sync device info to Supabase devices & device_rentals tables.
 * Called when a device connects or its stream URL changes.
 */
async function syncDeviceToCloud(params) {
  const { serial, model, brand, streamUrl, localUrl, port, bindingCode, status } = params;
  const client = getSupabaseClient();
  if (!client) return;

  try {
    let finalStreamUrl = streamUrl || null;

    // Check if an existing rotated stream_url with key= exists in Supabase for this device
    try {
      const exRes = await client.get(`/devices?serial=eq.${encodeURIComponent(serial)}&select=stream_url`);
      if (exRes.data && Array.isArray(exRes.data) && exRes.data.length > 0 && exRes.data[0].stream_url) {
        const dbUrl = exRes.data[0].stream_url;
        if (dbUrl.includes('key=')) {
          finalStreamUrl = dbUrl;
          const match = dbUrl.match(/key=([^&]+)/);
          if (match && match[1]) {
            ROTATED_STREAM_KEYS.set(serial, match[1]);
          }
        }
      }
    } catch (_) {}

    // 1. Sync to public.devices table (used by website dashboards)
    const devicesPayload = {
      serial,
      model: model || 'Android Device',
      brand: brand || 'Generic',
      stream_url: finalStreamUrl,
      local_url: localUrl || null,
      port: port || null,
      binding_code: bindingCode || null,
      status: status || 'online',
      is_deleted_from_view: false, // Ensure active connected devices are visible in admin dashboards
      last_seen: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await client.post('/devices?on_conflict=serial', devicesPayload, {
      headers: { Prefer: 'resolution=merge-duplicates' },
    });

    // 2. Check machine_bindings to find owner user_id if machine is bound to a user account
    let ownerUserId = 'RENTAL_USER_DEFAULT';
    if (bindingCode) {
      try {
        const mbRes = await client.get(`/machine_bindings?binding_code=eq.${encodeURIComponent(bindingCode)}&select=user_id`);
        if (mbRes.data && Array.isArray(mbRes.data) && mbRes.data.length > 0 && mbRes.data[0].user_id) {
          ownerUserId = mbRes.data[0].user_id;
        }
      } catch (_) {}
    }

    // 3. Sync to public.device_rentals table (used by netlify admin portal & rental hub)
    try {
      const rentalPatchPayload = {
        device_model: model || 'Android Device',
        device_brand: brand || 'Generic',
        binding_code: bindingCode || null,
        updated_at: new Date().toISOString(),
      };
      if (finalStreamUrl) rentalPatchPayload.stream_url = finalStreamUrl;

      const patchRes = await client.patch(
        `/device_rentals?serial_number=eq.${encodeURIComponent(serial)}`,
        rentalPatchPayload,
        { headers: { Prefer: 'return=representation' } }
      );

      if (!patchRes.data || !Array.isArray(patchRes.data) || patchRes.data.length === 0) {
        // New device serial — insert into device_rentals so admin portals always match local ADB device count
        await client.post('/device_rentals', {
          serial_number: serial,
          user_id: ownerUserId,
          device_model: model || 'Android Device',
          device_brand: brand || 'Generic',
          binding_code: bindingCode || null,
          stream_url: finalStreamUrl,
          monthly_fee: 30,
          currency: 'USD',
          status: 'active',
          updated_at: new Date().toISOString(),
        });
        logger.info(`[LicenseService] Device ${serial} newly registered in device_rentals cloud table`);
      }
    } catch (rentalErr) {
      logger.warn(`[LicenseService] device_rentals sync notice for ${serial}: ${rentalErr.message}`);
    }

    logger.info(`[LicenseService] Device ${serial} synced to cloud (devices & device_rentals updated, url: ${finalStreamUrl})`);
  } catch (err) {
    logger.warn(`[LicenseService] Device sync notice for ${serial}: ${err.message}`);
  }
}

/**
 * Mark device as offline in Supabase across devices & device_rentals tables.
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
  try {
    await client.patch(
      `/device_rentals?serial_number=eq.${encodeURIComponent(serial)}`,
      { updated_at: new Date().toISOString() },
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
  dohClient,
  getRotatedStreamKey,
  setRotatedStreamKey,
};
