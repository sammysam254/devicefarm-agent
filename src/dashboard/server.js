'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const logger = require('../utils/logger');
const processManager = require('../main/process-manager');
const bindingService = require('../services/binding-service');
const licenseService = require('../services/license-service');
const { ensureFlexPulseWallpaper } = require('../utils/wallpaper-generator');

let server = null;
let serverPort = 7400;

let agentConfig = null;
function getAgentConfig() {
  if (agentConfig) return agentConfig;
  for (const p of [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ]) {
    if (fs.existsSync(p)) {
      try {
        agentConfig = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return agentConfig;
      } catch (_) {}
    }
  }
  return {};
}

function resolveAdb() {
  const cfg = getAgentConfig();
  if (cfg.adbPath && fs.existsSync(cfg.adbPath)) return cfg.adbPath;
  const bundled = path.join(__dirname, '../../assets/bin/adb.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (fs.existsSync('C:\\platform-tools\\adb.exe')) return 'C:\\platform-tools\\adb.exe';
  return 'adb';
}

function resolveSerialForAdb(rawSerial) {
  if (!rawSerial) return rawSerial;
  const target = findTargetDevice(rawSerial);
  if (target && (target.hardwareSerial || target.adbSerial || target.serial)) {
    return target.hardwareSerial || target.adbSerial || target.serial;
  }
  return rawSerial;
}

function execAdb(serial, adbArgs, timeoutMs = 15000) {
  const adbBin = resolveAdb();
  const realSerial = resolveSerialForAdb(serial);
  const args = realSerial ? ['-s', realSerial, ...adbArgs] : adbArgs;
  return new Promise((resolve) => {
    const fullCmd = `"${adbBin}" ${args.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ')}`;
    exec(fullCmd, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: err.message, stderr: (stderr || '').trim(), stdout: (stdout || '').trim() });
      } else {
        resolve({ success: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
      }
    });
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const ESSENTIAL_PACKAGES = new Set([
  'com.android.settings',
  'com.google.android.gms',
  'com.android.vending',
  'com.google.android.gsf',
  'com.android.systemui',
  'com.android.launcher3',
  'com.google.android.apps.nexuslauncher',
  'com.sec.android.app.launcher',
  'com.miui.home',
  'com.huawei.android.launcher',
  'com.oppo.launcher',
  'com.vivo.upslide',
  'com.devicefarm.agent',
  'com.google.android.inputmethod.latin',
  'com.android.inputmethod.latin',
  'com.samsung.android.honeyboard',
  'com.android.shell',
  'android',
]);

function isAuthorizedRequest(req) {
  const remoteIp = req.socket.remoteAddress || '';
  const hostHeader = req.headers.host || '';
  const isCloudflareOrRemote = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (hostHeader && !hostHeader.includes('localhost') && !hostHeader.includes('127.0.0.1')));
  const isLocalHost = !isCloudflareOrRemote && (remoteIp.includes('127.0.0.1') || remoteIp.includes('::1') || remoteIp.includes('localhost') || hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1'));
  if (isLocalHost) return true;

  const authHeader = req.headers['x-farm-auth-key'];
  const cfg = getAgentConfig();
  const expectedKey = process.env.FARM_SECRET_KEY || cfg.agentSecretKey || null;
  if (!expectedKey) return true;
  return authHeader === expectedKey;
}

// Session token cache to avoid exposing binding code in HTTP responses
const SESSION_TOKENS = new Map();

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function storeBindingCodeInSession(bindingCode) {
  const token = generateSessionToken();
  SESSION_TOKENS.set(token, {
    bindingCode,
    createdAt: Date.now(),
  });
  
  // Expire tokens after 5 minutes
  setTimeout(() => {
    SESSION_TOKENS.delete(token);
  }, 5 * 60 * 1000);
  
  return token;
}

const FARM_SERIAL_ALIASES = {
  '7070016025067254': ['10.1.10.49:5555', '10.1.10.49'],
  'ZA223HQMXQ': ['10.1.10.79:5555', '10.1.10.79'],
  'YTCY999TVKVCZDZX': ['10.1.10.197:5555', '10.1.10.197'],
  '1120308025024495': ['10.1.10.100:5555', '10.1.10.100'],
  'M769UCQCDMZLPF8D': ['10.1.10.173:5555', '10.1.10.173'],
  '10.1.10.49:5555': ['7070016025067254'],
  '10.1.10.79:5555': ['ZA223HQMXQ'],
  '10.1.10.197:5555': ['YTCY999TVKVCZDZX'],
  '10.1.10.100:5555': ['1120308025024495'],
  '10.1.10.173:5555': ['M769UCQCDMZLPF8D'],
};

function findTargetDevice(rawSerial, actionParam) {
  if (!rawSerial) {
    if (actionParam === 'proxy') {
      const devices = processManager.getActiveDeviceSummaries();
      return devices[0] || null;
    }
    return null;
  }

  const serial = decodeURIComponent(rawSerial).trim();

  // 1. Direct lookup from processManager active sessions (USB priority)
  const direct = processManager.getDevice(serial);
  if (direct && direct.port && !direct.isWifi) return direct;

  // 1b. Check known farm hardware serial aliases (USB priority)
  const aliases = FARM_SERIAL_ALIASES[serial] || [];
  for (const alias of aliases) {
    const aliasDev = processManager.getDevice(alias);
    if (aliasDev && aliasDev.port && !aliasDev.isWifi) return aliasDev;
  }
  for (const alias of aliases) {
    const aliasDev = processManager.getDevice(alias);
    if (aliasDev && aliasDev.port) return aliasDev;
  }

  if (direct && direct.port) return direct;

  // 2. Check all active sessions for hardwareSerial, adbSerial, or serial match
  const allSerials = processManager.getActiveSerials();
  for (const s of allSerials) {
    const dev = processManager.getDevice(s);
    if (!dev || !dev.port) continue;
    if (dev.hardwareSerial === serial || dev.adbSerial === serial || dev.serial === serial) {
      return dev;
    }
    if (dev.hardwareSerial?.toLowerCase() === serial.toLowerCase() || dev.serial?.toLowerCase() === serial.toLowerCase()) {
      return dev;
    }
  }

  // 3. Match by IP address without port if serial contains IP
  if (serial.includes(':')) {
    const ipOnly = serial.split(':')[0];
    for (const s of allSerials) {
      const dev = processManager.getDevice(s);
      if (dev && dev.port && (s.startsWith(ipOnly) || dev.adbSerial?.startsWith(ipOnly))) {
        return dev;
      }
    }
  }

  // 4. Summaries fallback
  const summaries = processManager.getActiveDeviceSummaries();
  const found = summaries.find(d => 
    d.serial === serial || 
    d.serial?.toLowerCase() === serial.toLowerCase() ||
    (d.serial && (d.serial.includes(serial) || serial.includes(d.serial)))
  );
  if (found) return found;

  return null;
}

/**
 * Start the local Dashboard HTTP Server.
 * @param {number} [port=7400]
 * @returns {Promise<{ port: number, url: string }>}
 */
function startDashboardServer(port = 7400) {
  return new Promise((resolve, reject) => {
    serverPort = port;
    const htmlPath = path.join(__dirname, 'index.html');

    try {
      const wifiCachePath = path.join(process.cwd(), 'wifi-devices-cache.json');
      if (fs.existsSync(wifiCachePath)) fs.unlinkSync(wifiCachePath);
    } catch (_) {}

    server = http.createServer(async (req, res) => {
      try {
      // Enable CORS & Security headers (permitting frame embedding on dennoh.site)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-farm-auth-key');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'self' https://dennoh.site https://*.dennoh.site http://localhost:*;");

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const url = fullUrl.pathname;

      // ── API Routes ────────────────────────────────────────────────────────
      // ── Public endpoint for initial binding code (no auth required) ────
      if (url === '/api/binding/code') {
        const bindingCode = bindingService.getOrGenerateBindingCode();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          bindingCode,
          timestamp: new Date().toISOString()
        }));
        return;
      }

      if (url === '/api/devices') {
        const bindingCode = bindingService.getOrGenerateBindingCode();
        const lic = await licenseService.checkLicenseStatus(bindingCode);
        const rawDevices = processManager.getActiveDeviceSummaries();
        const sessionToken = storeBindingCodeInSession(bindingCode);

        const remoteIp = req.socket.remoteAddress || '';
        const hostHeader = req.headers.host || '';
        const isCloudflareOrRemote = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (hostHeader && !hostHeader.includes('localhost') && !hostHeader.includes('127.0.0.1')));
        const isLocalHost = !isCloudflareOrRemote && (remoteIp.includes('127.0.0.1') || remoteIp.includes('::1') || remoteIp.includes('localhost') || hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1'));
        const isAuthorized = isAuthorizedRequest(req);
        const canAccess = isLocalHost || isAuthorized;

        const devices = canAccess ? rawDevices.map(d => ({
          ...d,
          streamUrl: d.streamUrl ? `${d.streamUrl}&token=${sessionToken}` : d.streamUrl,
        })) : [];

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          bindingCode,
          sessionToken,
          isLicensed: lic.isActive,
          licenseMode: lic.mode,
          count: canAccess ? rawDevices.length : 0,
          devices: devices,
          isRemote: !isLocalHost,
          timestamp: new Date().toISOString()
        }));
        return;
      }

      if (url === '/api/license/status' || url === '/api/rental/status') {
        const bindingCode = bindingService.getOrGenerateBindingCode();
        const lic = await licenseService.checkLicenseStatus(bindingCode);
        const devices = processManager.getActiveDeviceSummaries();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          bindingCode,  // Public endpoint - show binding code
          isLicensed: lic.isActive,
          licenseMode: lic.mode,
          note: lic.note,
          deviceCount: devices.length,
          deviceSerials: devices.map(d => ({ serial: d.serial, model: d.model, port: d.port })),
          timestamp: new Date().toISOString()
        }));
        return;
      }

      if (url === '/api/system-logs') {
        const logRelayService = require('../services/log-relay-service');
        const limit = parseInt(fullUrl.searchParams.get('limit') || '100', 10);
        const logs = logRelayService.getRecentLogs ? logRelayService.getRecentLogs(limit) : [];
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        });
        res.end(JSON.stringify({ status: 'ok', logs }));
        return;
      }

      if (url === '/api/system/sync' || url === '/api/system/update') {
        const autoSync = require('../services/auto-sync-service');
        if (autoSync && autoSync.checkAndSyncGithub) {
          autoSync.checkAndSyncGithub().catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'Sync check initiated' }));
        return;
      }

      if (url === '/api/system/reconnect') {
        const enrollmentGuard = require('../services/enrollment-guard');
        if (enrollmentGuard && enrollmentGuard.runRecoveryCheck) {
          enrollmentGuard.runRecoveryCheck(true).catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'Recovery check initiated' }));
        return;
      }

      if (url === '/download/installer' || url === '/download/agent') {
        const setupBatPath = path.join(__dirname, '..', '..', 'DeviceFarm-Agent-Setup.bat');
        if (fs.existsSync(setupBatPath)) {
          res.writeHead(200, {
            'Content-Type': 'application/x-msdos-program',
            'Content-Disposition': 'attachment; filename="DeviceFarm-Agent-Setup.bat"',
            'Cache-Control': 'no-cache',
          });
          fs.createReadStream(setupBatPath).pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Installer not found');
        }
        return;
      }

      // ── Kiosk & System Branding Endpoints ───────────────────────────────
      // GET /api/devices/:serial/apps
      const appsMatch = url.match(/^\/api\/devices\/([^/]+)\/apps$/);
      if (appsMatch && req.method === 'GET') {
        if (!isAuthorizedRequest(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Unauthorized' }));
          return;
        }

        const rawSerial = decodeURIComponent(appsMatch[1]);
        const realSerial = resolveSerialForAdb(rawSerial);

        const [allRes, disabledRes] = await Promise.all([
          execAdb(realSerial, ['shell', 'pm', 'list', 'packages', '-3']),
          execAdb(realSerial, ['shell', 'pm', 'list', 'packages', '-d', '-3']),
        ]);

        if (!allRes.success && !allRes.stdout) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: allRes.error || 'Failed to query device packages' }));
          return;
        }

        const disabledLines = (disabledRes.stdout || '').split('\n').map(l => l.trim().replace(/^package:/, '')).filter(Boolean);
        const disabledSet = new Set(disabledLines);

        const allLines = (allRes.stdout || '').split('\n').map(l => l.trim().replace(/^package:/, '')).filter(Boolean);
        const packages = allLines.map(pkg => ({
          packageName: pkg,
          isEnabled: !disabledSet.has(pkg),
          isEssential: ESSENTIAL_PACKAGES.has(pkg),
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          success: true,
          serial: realSerial,
          count: packages.length,
          packages,
        }));
        return;
      }

      // POST /api/devices/:serial/lockdown
      const lockdownMatch = url.match(/^\/api\/devices\/([^/]+)\/lockdown$/);
      if (lockdownMatch && req.method === 'POST') {
        if (!isAuthorizedRequest(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Unauthorized' }));
          return;
        }

        const rawSerial = decodeURIComponent(lockdownMatch[1]);
        const realSerial = resolveSerialForAdb(rawSerial);

        let payload = {};
        try {
          payload = await parseJsonBody(req);
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON body' }));
          return;
        }

        const allowedPackages = Array.isArray(payload.allowedPackages) ? payload.allowedPackages : [];
        const allowedSet = new Set(allowedPackages);

        // 1. Query all third-party packages: pm list packages -3
        const allRes = await execAdb(realSerial, ['shell', 'pm', 'list', 'packages', '-3']);
        const allPackages = (allRes.stdout || '').split('\n').map(l => l.trim().replace(/^package:/, '')).filter(Boolean);

        let enabledCount = 0;
        let lockedCount = 0;

        for (const pkg of allPackages) {
          if (allowedSet.has(pkg)) {
            // Packages inside allowedPackages run: pm enable <pkg>
            await execAdb(realSerial, ['shell', 'pm', 'enable', pkg]);
            enabledCount++;
          } else {
            // Packages NOT in allowedPackages run: pm disable-user --user 0 <pkg>
            if (!ESSENTIAL_PACKAGES.has(pkg)) {
              await execAdb(realSerial, ['shell', 'pm', 'disable-user', '--user', '0', pkg]);
              lockedCount++;
            }
          }
        }

        // 2. Branded Wallpaper Injection ("FlexPulse System")
        let wallpaperPushed = false;
        try {
          const wallpaperPath = ensureFlexPulseWallpaper();
          if (fs.existsSync(wallpaperPath)) {
            const pushRes = await execAdb(realSerial, ['push', wallpaperPath, '/sdcard/flexpulse_wallpaper.png']);
            if (pushRes.success) {
              wallpaperPushed = true;
              // Broadcast / launch wallpaper manager intent
              await execAdb(realSerial, [
                'shell', 'am', 'start',
                '-a', 'android.intent.action.ATTACH_DATA',
                '-c', 'android.intent.category.DEFAULT',
                '-d', 'file:///sdcard/flexpulse_wallpaper.png',
                '-t', 'image/png',
                '-e', 'mimeType', 'image/png'
              ]);
              await execAdb(realSerial, [
                'shell', 'am', 'broadcast',
                '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
                '-d', 'file:///sdcard/flexpulse_wallpaper.png'
              ]);
              await execAdb(realSerial, [
                'shell', 'am', 'broadcast',
                '-a', 'com.flexpulse.SET_WALLPAPER',
                '-e', 'path', '/sdcard/flexpulse_wallpaper.png'
              ]);
            }
          }
        } catch (wpErr) {
          logger.warn(`[Lockdown] Wallpaper trigger error: ${wpErr.message}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          success: true,
          message: `FlexPulse Multi-App Mode applied: ${enabledCount} allowed, ${lockedCount} frozen/hidden.`,
          lockedCount,
          enabledCount,
          wallpaperSet: wallpaperPushed,
        }));
        return;
      }

      // POST /api/devices/:serial/unlock
      const unlockMatch = url.match(/^\/api\/devices\/([^/]+)\/unlock$/);
      if (unlockMatch && req.method === 'POST') {
        if (!isAuthorizedRequest(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Unauthorized' }));
          return;
        }

        const rawSerial = decodeURIComponent(unlockMatch[1]);
        const realSerial = resolveSerialForAdb(rawSerial);

        // Re-enables all currently disabled third-party packages: pm list packages -d -3 -> pm enable <pkg>
        const disabledRes = await execAdb(realSerial, ['shell', 'pm', 'list', 'packages', '-d', '-3']);
        const disabledPackages = (disabledRes.stdout || '').split('\n').map(l => l.trim().replace(/^package:/, '')).filter(Boolean);

        let unlockedCount = 0;
        for (const pkg of disabledPackages) {
          await execAdb(realSerial, ['shell', 'pm', 'enable', pkg]);
          unlockedCount++;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          success: true,
          message: `Restored normal mode. ${unlockedCount} third-party apps re-enabled.`,
          unlockedCount,
        }));
        return;
      }

      // POST /api/devices/:serial/install-playstore
      const playstoreMatch = url.match(/^\/api\/devices\/([^/]+)\/install-playstore$/);
      if (playstoreMatch && req.method === 'POST') {
        if (!isAuthorizedRequest(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Unauthorized' }));
          return;
        }

        const rawSerial = decodeURIComponent(playstoreMatch[1]);
        const realSerial = resolveSerialForAdb(rawSerial);

        let payload = {};
        try {
          payload = await parseJsonBody(req);
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON body' }));
          return;
        }

        const packageName = (payload.packageName || '').trim();
        if (!packageName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Target package ID is required' }));
          return;
        }

        // 1. Ensure Play Store is active: pm enable com.android.vending
        await execAdb(realSerial, ['shell', 'pm', 'enable', 'com.android.vending']);

        // 2. Trigger official store listing intent
        await execAdb(realSerial, [
          'shell', 'am', 'start',
          '-a', 'android.intent.action.VIEW',
          '-d', `market://details?id=${packageName}`
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          success: true,
          message: 'Play Store listing launched for ' + packageName,
        }));
        return;
      }

      // ── Proxy Handling ──────────────────────────────────────────────────
      const actionParam = fullUrl.searchParams.get('action');
      const udidParam = fullUrl.searchParams.get('udid');
      const remoteParam = fullUrl.searchParams.get('remote');

      if (actionParam === 'proxy' || udidParam || remoteParam) {
        const rawSerial = udidParam || (remoteParam ? decodeURIComponent(remoteParam).split(':').pop() : null);
        const targetDev = findTargetDevice(rawSerial, actionParam);

        if (targetDev && targetDev.port) {
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: targetDev.port,
            path: req.url,
            method: req.method,
            headers: req.headers,
            timeout: 15000,
          }, (proxyRes) => {
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
            }
            proxyRes.pipe(res);
            proxyRes.on('error', () => { try { res.destroy(); } catch (_) {} });
          });

          proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
              res.writeHead(504, { 'Content-Type': 'text/plain' });
              res.end('Gateway Timeout — device stream response timed out');
            }
          });

          proxyReq.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Bad Gateway — device stream unavailable');
            } else {
              try { res.destroy(); } catch (_) {}
            }
          });

          req.on('error', () => { try { proxyReq.destroy(); } catch (_) {} });
          req.pipe(proxyReq);
          return;
        }

        // If a specific device UDID was requested but not found on this machine:
        if (udidParam || remoteParam) {
          const requestedSerial = rawSerial || 'Unknown';
          const currentBinding = bindingService.getOrGenerateBindingCode();
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Device Not Found — ${requestedSerial}</title>
              <style>
                body { background: #07090e; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
                .card { max-width: 500px; width: 100%; background: #0f172a; border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 20px; padding: 36px 28px; text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.6); }
                .icon { font-size: 48px; margin-bottom: 12px; }
                h2 { color: #f87171; margin: 0 0 10px; font-size: 22px; font-weight: 800; }
                p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 0 0 20px; }
                code { background: rgba(255,255,255,0.08); color: #38bdf8; padding: 3px 8px; border-radius: 6px; font-family: monospace; font-size: 14px; }
                .box { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px; font-size: 13px; color: #cbd5e1; text-align: left; margin-bottom: 24px; line-height: 1.6; }
                .btn { display: inline-block; padding: 12px 24px; background: #38bdf8; color: #0f172a; border-radius: 10px; font-weight: 700; text-decoration: none; font-size: 14px; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="icon">📱</div>
                <h2>Device Not Connected Here</h2>
                <p>Device <code>${requestedSerial}</code> is not plugged into this machine (Binding Code: <strong>${currentBinding}</strong>).</p>
                <div class="box">
                  <strong>Why am I seeing this?</strong><br>
                  • This device is plugged into a different computer (e.g. your remote USA host).<br>
                  • To stream this remote device, open it via your cloud dashboard or <code>https://agent.dennoh.site/?udid=${requestedSerial}</code> once that host is running.
                </div>
                <a href="/" class="btn">View Local Dashboard</a>
              </div>
            </body>
            </html>
          `);
          return;
        }
      }

        // ── Serve Index HTML Page ───────────────────────────────────────────
        fs.readFile(htmlPath, (err, data) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading dashboard page');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
      } catch (handlerErr) {
        logger.error(`[DashboardServer] Request error: ${handlerErr.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          try { res.destroy(); } catch (_) {}
        }
      }
    });

    server.on('clientError', (err, socket) => {
      try {
        if (socket.writable) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        }
        socket.destroy();
      } catch (_) {}
    });

    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => { try { socket.destroy(); } catch (_) {} });

      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const actionParam = fullUrl.searchParams.get('action');
      const udidParam = fullUrl.searchParams.get('udid');
      const remoteParam = fullUrl.searchParams.get('remote');
      const serial = udidParam || (remoteParam ? decodeURIComponent(remoteParam).split(':').pop() : null);
      const targetDev = findTargetDevice(serial, actionParam);

      if (targetDev && targetDev.port) {
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: targetDev.port,
          path: req.url,
          method: 'GET',
          headers: req.headers,
        });

        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          proxySocket.on('error', () => { try { socket.destroy(); proxySocket.destroy(); } catch (_) {} });
          socket.on('error', () => { try { proxySocket.destroy(); socket.destroy(); } catch (_) {} });

          socket.write(
            `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
            Object.keys(proxyRes.headers)
              .map(k => `${k}: ${proxyRes.headers[k]}`)
              .join('\r\n') +
            '\r\n\r\n'
          );

          if (proxyHead && proxyHead.length) socket.write(proxyHead);
          if (head && head.length) proxySocket.write(head);

          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });

        proxyReq.on('error', (err) => {
          try { socket.destroy(); } catch (_) {}
        });

        proxyReq.end();
      } else {
        try { socket.destroy(); } catch (_) {}
      }
    });

    server.listen(port, '0.0.0.0', () => {
      const url = `http://localhost:${port}`;
      logger.info(`[DashboardServer] Listening at ${url}`);
      resolve({ port, url });
    });

    server.on('error', (err) => {
      logger.error(`[DashboardServer] Failed to start on port ${port}: ${err.message}`);
      reject(err);
    });
  });
}

function stopDashboardServer() {
  if (server) {
    server.close();
    server = null;
  }
}

function getDashboardUrl() {
  return `http://localhost:${serverPort}`;
}

function openInChrome(url) {
  const isWin = process.platform === 'win32';
  if (isWin) {
    exec(`start "" "${url}"`, (err) => {
      if (err) logger.warn(`Could not open Chrome: ${err.message}`);
    });
  }
}

module.exports = {
  startDashboardServer,
  stopDashboardServer,
  getDashboardUrl,
  openInChrome,
  SESSION_TOKENS,
};
