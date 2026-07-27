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
        const setupBatPath = path.join(process.cwd(), 'DeviceFarm-Agent-Setup.bat');
        const distDir = path.join(process.cwd(), 'dist');
        let fileToServe = null;

        if (fs.existsSync(distDir)) {
          const files = fs.readdirSync(distDir);
          const exeFile = files.find(f => f.endsWith('.exe'));
          if (exeFile) {
            fileToServe = path.join(distDir, exeFile);
          }
        }

        if (fileToServe && fs.existsSync(fileToServe)) {
          const filename = path.basename(fileToServe);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${filename}"`
          });
          fs.createReadStream(fileToServe).pipe(res);
          return;
        } else if (fs.existsSync(setupBatPath)) {
          res.writeHead(200, {
            'Content-Type': 'application/x-msdos-program',
            'Content-Disposition': 'attachment; filename="DeviceFarm-Agent-Setup.bat"'
          });
          fs.createReadStream(setupBatPath).pipe(res);
          return;
        } else {
          const batContent = `@echo off
TITLE DeviceFarm Setup
set "PATH=C:\\Program Files\\nodejs;C:\\platform-tools;%PATH%"
if exist "%~dp0package.json" (
    set "APP_DIR=%~dp0"
) else (
    set "APP_DIR=C:\\DEVICEFARM\\"
)
if "%APP_DIR:~-1%"=="\\" set "APP_DIR=%APP_DIR:~0,-1%"
cd /d "%APP_DIR%"
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed. Download from https://nodejs.org
    pause
    exit /b 1
)
if exist "%APP_DIR%\\node_modules\\electron" (
    echo Packages verified. Starting Agent...
) else (
    echo Installing dependencies...
    call npm install --no-audit --no-fund
)
if exist "%APP_DIR%\\node_modules\\electron\\dist\\electron.exe" (
    start "" "%APP_DIR%\\node_modules\\electron\\dist\\electron.exe" "%APP_DIR%"
) else (
    start "" npx electron "%APP_DIR%"
)
echo [*] Waiting for Dashboard service on port 7400...
:WAIT_LOOP
curl -s --max-time 1 http://localhost:7400/api/devices >nul 2>nul
if %errorlevel% neq 0 (
    timeout /t 1 /nobreak >nul
    goto WAIT_LOOP
)
start "" "http://localhost:7400"
`;
          res.writeHead(200, {
            'Content-Type': 'application/x-msdos-program',
            'Content-Disposition': 'attachment; filename="DeviceFarm-Agent-Setup.bat"'
          });
          res.end(batContent);
          return;
        }
      }

      if (url === '/' || url === '/index.html') {
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

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
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

module.exports = {
  startDashboardServer,
  openInChrome,
  stopDashboardServer,
};
