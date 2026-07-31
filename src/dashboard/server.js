'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const logger = require('../utils/logger');
const processManager = require('../main/process-manager');

let server = null;
let serverPort = 7400;

/**
 * Start the local Dashboard HTTP Server.
 * @param {number} [port=7400]
 * @returns {Promise<{ port: number, url: string }>}
 */
function startDashboardServer(port = 7400) {
  return new Promise((resolve, reject) => {
    serverPort = port;
    const htmlPath = path.join(__dirname, 'index.html');

    server = http.createServer((req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url.split('?')[0];
      const rentalPaymentService = require('../services/rental-payment-service');

      if (url === '/api/devices') {
        const rawDevices = processManager.getActiveDeviceSummaries();
        Promise.all(rawDevices.map(async (d) => {
          try {
            const rental = await rentalPaymentService.checkDeviceRentalStatus(d.serial);
            return {
              ...d,
              isPaid: rental.isPaid === true,
              paymentStatus: rental.status || (rental.isPaid ? 'active' : 'unpaid'),
            };
          } catch (_) {
            return d;
          }
        })).then(devices => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            count: devices.length,
            devices: devices,
            timestamp: new Date().toISOString()
          }));
        }).catch(err => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            count: rawDevices.length,
            devices: rawDevices,
            timestamp: new Date().toISOString()
          }));
        });
        return;
      }

      if (url === '/api/rental/status') {
        const devices = processManager.getActiveDeviceSummaries();
        rentalPaymentService.getMachineRentalSummary(devices).then(summary => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', summary }));
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: err.message }));
        });
        return;
      }

      if (url === '/api/rental/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const updated = rentalPaymentService.updateRentalConfig(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', config: updated }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: e.message }));
          }
        });
        return;
      }

      if (url === '/api/rental/override' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.serial) throw new Error('serial required');
            rentalPaymentService.setLocalPaymentOverride(parsed.serial, parsed.isPaid === true);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', serial: parsed.serial, isPaid: parsed.isPaid === true }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: e.message }));
          }
        });
        return;
      }

      if (url === '/api/rental/schema') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(rentalPaymentService.getSupabaseSqlSchema());
        return;
      }

      if (url === '/download/installer' || url === '/download/agent') {
        // Always serve the real standalone setup bat that clones and runs the agent
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

      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const actionParam = fullUrl.searchParams.get('action');
      const udidParam = fullUrl.searchParams.get('udid');
      const remoteParam = fullUrl.searchParams.get('remote');

      // If action=proxy or udid/remote is specified on dashboard server, proxy traffic directly to device stream port
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
            proxyRes.pipe(res, { end: true });
          });
          proxyReq.on('error', () => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('502 Bad Gateway — Stream server offline');
          });
          req.pipe(proxyReq, { end: true });
          return;
        }
      }

      if (url === '/' || url === '/index.html' || !url) {
        fs.readFile(htmlPath, (err, data) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading dashboard page');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
        return;
      }

      // Default fallback for any non-API SPA routes: serve dashboard index.html instead of 404
      fs.readFile(htmlPath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
    });

    // Handle WebSocket upgrade proxying for public tunnel connections
    server.on('upgrade', (req, socket, head) => {
      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const udidParam = fullUrl.searchParams.get('udid');
      const remoteParam = fullUrl.searchParams.get('remote');
      const serial = udidParam || (remoteParam ? decodeURIComponent(remoteParam).split(':').pop() : null);
      const devices = processManager.getActiveDeviceSummaries();
      const targetDev = devices.find(d => d.serial === serial) || devices[0];
      if (targetDev && targetDev.port) {
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: targetDev.port,
          path: req.url,
          method: 'GET',
          headers: req.headers,
        });
        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });
        proxyReq.on('error', () => { try { socket.destroy(); } catch (_) {} });
        proxyReq.end();
      } else {
        try { socket.destroy(); } catch (_) {}
      }
    });

    server.on('error', (err) => {
      logger.error(`Dashboard server failed to start on port ${port}:`, err.message);
      reject(err);
    });

    server.listen(port, '0.0.0.0', () => {
      logger.info(`Dashboard server running at http://localhost:${port}`);
      resolve({ port, url: `http://localhost:${port}` });
    });
  });
}

function openInChrome(targetUrl) {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromePath86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

  if (fs.existsSync(chromePath)) {
    exec(`"${chromePath}" "${targetUrl}"`);
  } else if (fs.existsSync(chromePath86)) {
    exec(`"${chromePath86}" "${targetUrl}"`);
  } else {
    exec(`start "" "${targetUrl}"`);
  }
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

module.exports = {
  startDashboardServer,
  openInChrome,
  stopDashboardServer,
  getDashboardUrl,
};
