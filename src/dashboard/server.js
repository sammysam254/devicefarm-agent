'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const logger = require('../utils/logger');
const processManager = require('../main/process-manager');
const streamService = require('../services/stream-service');
const bindingService = require('../services/binding-service');
const licenseService = require('../services/license-service');

let server = null;
let serverPort = 7400;

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

/**
 * Intelligent fuzzy matcher for device serials.
 * Handles exact case-insensitive matches, common OCR character confusions
 * (0 vs O vs 8, 1 vs I vs L vs T, 5 vs S, 2 vs Z, Q vs C, B vs P),
 * and Levenshtein distance <= 3.
 */
function findMatchingDevice(requestedSerial, devices) {
  if (!devices || devices.length === 0) return null;
  if (!requestedSerial) return devices[0];
  const cleanReq = requestedSerial.trim().toLowerCase();

  // 1. Exact match (case-insensitive)
  const exact = devices.find(d => d.serial && d.serial.toLowerCase() === cleanReq);
  if (exact) return exact;

  // 2. OCR character normalization
  function normOcr(s) {
    return (s || '').toLowerCase()
      .replace(/[0o8]/g, '#')
      .replace(/[1ilt]/g, '!')
      .replace(/[5s]/g, '$')
      .replace(/[2z]/g, '%')
      .replace(/[qc]/g, '@')
      .replace(/[pb]/g, '&');
  }
  const normReq = normOcr(cleanReq);
  const ocrMatch = devices.find(d => normOcr(d.serial) === normReq);
  if (ocrMatch) return ocrMatch;

  // 3. Levenshtein edit distance <= 3
  function lev(a, b) {
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  let best = null;
  let minD = 4;
  for (const d of devices) {
    if (!d.serial) continue;
    const dVal = lev(cleanReq, d.serial.toLowerCase());
    if (dVal < minD) {
      minD = dVal;
      best = d;
    }
  }
  return best;
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

    server = http.createServer(async (req, res) => {
      // Enable CORS & Security headers (permitting frame embedding on dennoh.site)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

        const devices = rawDevices.map(d => ({
          ...d,
          streamUrl: d.trycloudflareUrl || d.streamUrl || (d.publicUrl ? `${d.publicUrl}/?udid=${encodeURIComponent(d.serial)}` : `http://localhost:${d.port}/?udid=${encodeURIComponent(d.serial)}`),
          trycloudflareUrl: d.trycloudflareUrl || (d.streamUrl && d.streamUrl.includes('trycloudflare.com') ? d.streamUrl : null),
          namedTokenUrl: d.namedTokenUrl || null,
          publicUrl: d.trycloudflareUrl || d.publicUrl || null,
          localUrl: d.localUrl || `http://localhost:${d.port}`,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          bindingCode,
          sessionToken,
          isLicensed: lic.isActive,
          licenseMode: lic.mode,
          count: rawDevices.length,
          devices: devices,
          isRemote: !isLocalHost,
          timestamp: new Date().toISOString()
        }));
        return;
      }

      if (url === '/api/devices/block-stream' || url === '/api/devices/unblock-stream' || url === '/api/devices/toggle-stream-block') {
        const serial = fullUrl.searchParams.get('serial');
        const reason = fullUrl.searchParams.get('reason') || 'This device stream has been suspended by an Administrator.';
        const isBlock = url === '/api/devices/block-stream' || fullUrl.searchParams.get('block') === 'true' || fullUrl.searchParams.get('blocked') === '1';

        if (!serial) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Missing serial parameter' }));
          return;
        }

        try {
          await licenseService.setDeviceStreamBlockStatus(serial, isBlock, reason);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            serial,
            isStreamBlocked: isBlock,
            reason: isBlock ? reason : null,
            timestamp: new Date().toISOString()
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: err.message }));
        }
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
        res.end(JSON.stringify({ logs, total: logs.length }));
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

      // ── Proxy Handling ──────────────────────────────────────────────────
      const actionParam = fullUrl.searchParams.get('action');
      const udidParam = fullUrl.searchParams.get('udid');
      const remoteParam = fullUrl.searchParams.get('remote');

      if (actionParam === 'proxy' || udidParam || remoteParam) {
        const serial = (udidParam || (remoteParam ? decodeURIComponent(remoteParam).split(':').pop() : null) || '').trim();
        const devices = processManager.getActiveDeviceSummaries();
        let targetDev = findMatchingDevice(serial, devices);

        if (!targetDev && serial) {
          const activeEntry = streamService.getActiveServerEntry(serial);
          if (activeEntry && activeEntry.port) {
            targetDev = { serial: activeEntry.serial, port: activeEntry.port };
          }
        }

        if (targetDev && targetDev.port) {
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: targetDev.port,
            path: req.url,
            method: req.method,
            headers: req.headers,
          }, (proxyRes) => {
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
            }
            proxyRes.pipe(res);
            proxyRes.on('error', () => { try { res.destroy(); } catch (_) {} });
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

        if (serial) {
          // Device is provisioning or connecting — display auto-refreshing loading screen
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="2">
  <title>Connecting Stream - ${serial}</title>
  <style>
    body { background:#070b14; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; padding:20px; }
    .box { background:rgba(15,23,42,0.9); border:1px solid rgba(56,189,248,0.3); border-radius:18px; padding:32px; max-width:380px; width:100%; }
    .spin { width:32px; height:32px; border:3px solid rgba(56,189,248,0.2); border-top-color:#38bdf8; border-radius:50%; animation:s 0.8s linear infinite; margin:0 auto 16px; }
    @keyframes s { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    <div class="spin"></div>
    <div style="font-size:15px; font-weight:700; color:#fff;">Connecting ${serial}...</div>
    <div style="font-size:12px; color:#94a3b8; margin-top:8px; line-height:1.4;">Device video pipeline is initializing. Connecting automatically in 2 seconds...</div>
  </div>
</body>
</html>`);
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
      const serial = (udidParam || (remoteParam ? decodeURIComponent(remoteParam).split(':').pop() : null) || '').trim();

      const devices = processManager.getActiveDeviceSummaries();
      let targetDev = findMatchingDevice(serial, devices);

      if (!targetDev && serial) {
        const activeEntry = streamService.getActiveServerEntry(serial);
        if (activeEntry && activeEntry.port) {
          targetDev = { serial: activeEntry.serial, port: activeEntry.port };
        }
      }

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
