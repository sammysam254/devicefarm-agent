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
 * Start the local Dashboard HTTP Server.
 * @param {number} [port=7400]
 * @returns {Promise<{ port: number, url: string }>}
 */
function startDashboardServer(port = 7400) {
  return new Promise((resolve, reject) => {
    serverPort = port;
    const htmlPath = path.join(__dirname, 'index.html');

    server = http.createServer(async (req, res) => {
      // Enable CORS & Security headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'");

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
        // REQUIRE AUTH: Must have valid session token to access device list
        const authToken = req.headers['x-session-token'] || fullUrl.searchParams.get('token');
        
        if (!authToken || !SESSION_TOKENS.has(authToken)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'error',
            error: 'Unauthorized',
            message: 'Valid session token required'
          }));
          return;
        }

        const bindingCode = bindingService.getOrGenerateBindingCode();
        const lic = await licenseService.checkLicenseStatus(bindingCode);
        const rawDevices = processManager.getActiveDeviceSummaries();

        // Hide binding code in response — only return opaque session token instead
        const sessionToken = storeBindingCodeInSession(bindingCode);

        const devices = rawDevices.map(d => ({
          ...d,
          // DO NOT expose bindingCode here
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          sessionToken,  // Opaque token instead of binding code
          isLicensed: lic.isActive,
          licenseMode: lic.mode,
          count: devices.length,
          devices: devices,
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
          timestamp: new Date().toISOString()
        }));
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
        const serial = udidParam || (remoteParam ? decodeURIComponent(remoteParam).split(':').pop() : null);
        const devices = processManager.getActiveDeviceSummaries();
        const targetDev = devices.find(d => d.serial === serial) || devices[0];
        if (targetDev && targetDev.port) {
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: targetDev.port,
            path: req.url,
            method: req.method,
            headers: req.headers,
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', () => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Bad Gateway — device stream unavailable');
          });

          req.pipe(proxyReq);
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
