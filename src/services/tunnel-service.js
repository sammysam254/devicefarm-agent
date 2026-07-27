'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

function loadConfig() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  return {};
}

const config = loadConfig();

/**
 * Resolve cloudflared.exe binary location.
 */
function resolveCloudflaredBin() {
  if (config.cloudflaredPath && fs.existsSync(config.cloudflaredPath)) {
    return config.cloudflaredPath;
  }

  const bundledDir = path.join(__dirname, '..', '..', 'assets', 'bin');
  if (!fs.existsSync(bundledDir)) {
    fs.mkdirSync(bundledDir, { recursive: true });
  }

  const bundledExe = path.join(bundledDir, 'cloudflared.exe');
  if (fs.existsSync(bundledExe)) {
    return bundledExe;
  }

  const commonPaths = [
    'C:\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(process.cwd(), 'cloudflared.exe'),
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return bundledExe;
}

let CLOUDFLARED_BIN = resolveCloudflaredBin();

/**
 * Ensure cloudflared.exe is present. If missing, auto-downloads binary via PowerShell WebRequest.
 */
function ensureCloudflaredAvailable() {
  return new Promise((resolve) => {
    CLOUDFLARED_BIN = resolveCloudflaredBin();
    if (fs.existsSync(CLOUDFLARED_BIN)) {
      return resolve(CLOUDFLARED_BIN);
    }

    logger.info('[+] Auto-downloading cloudflared.exe binary...');
    const downloadCmd = `powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '${CLOUDFLARED_BIN}' -UseBasicParsing"`;

    try {
      execSync(downloadCmd, { windowsHide: true, timeout: 60000 });
      if (fs.existsSync(CLOUDFLARED_BIN)) {
        logger.info('[OK] cloudflared.exe downloaded successfully');
        return resolve(CLOUDFLARED_BIN);
      }
    } catch (_) {}

    resolve(null);
  });
}

/** Regex to capture trycloudflare.com URL */
const TUNNEL_URL_REGEX = /https?:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
const TUNNEL_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

function createTunnel(port) {
  return new Promise(async (resolve, reject) => {
    const binPath = await ensureCloudflaredAvailable();
    
    if (!binPath || !fs.existsSync(binPath)) {
      logger.info(`[Standalone Local Mode] cloudflared binary unavailable — tunnel skipped for port ${port}`);
      return reject(new Error('cloudflared binary unavailable'));
    }

    logger.info(`[+] Spawning cloudflared tunnel for localhost:${port}`);

    try {
      const tunnelProcess = spawn(binPath, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let resolved = false;
      let combinedOutput = '';

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.warn(`Cloudflared tunnel timed out after ${TUNNEL_TIMEOUT_MS}ms for port ${port}`);
          killTunnel(tunnelProcess);
          reject(new Error(`Tunnel URL not received within ${TUNNEL_TIMEOUT_MS}ms`));
        }
      }, TUNNEL_TIMEOUT_MS);

      function handleData(data) {
        const text = data.toString();
        combinedOutput += text;
        const match = text.match(TUNNEL_URL_REGEX);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const publicUrl = match[0];
          logger.info(`[OK] Cloudflared tunnel established: ${publicUrl}`);
          resolve({ publicUrl, tunnelProcess });
        }
      }

      tunnelProcess.stdout.on('data', handleData);
      tunnelProcess.stderr.on('data', handleData);

      tunnelProcess.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          logger.warn(`Cloudflared process notice: ${err.message}`);
          reject(err);
        }
      });

      tunnelProcess.on('exit', (code, signal) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited (code=${code})`));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function createTunnelWithRetry(port, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[+] Tunnel creation attempt ${attempt}/${maxRetries} for port ${port}`);
      const result = await createTunnel(port);
      return result;
    } catch (err) {
      lastErr = err;
      logger.warn(`[-] Tunnel attempt ${attempt} failed, retrying...`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

function killTunnel(tunnelProcess) {
  if (!tunnelProcess || tunnelProcess.exitCode !== null) return;
  const pid = tunnelProcess.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      tunnelProcess.kill('SIGTERM');
    }
  } catch (_) {}
}

async function isCloudflaredAvailable() {
  const binPath = await ensureCloudflaredAvailable();
  return binPath ? fs.existsSync(binPath) : false;
}

module.exports = {
  createTunnel: createTunnelWithRetry,
  killTunnel,
  isCloudflaredAvailable,
};
