'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

let localtunnel = null;
try {
  localtunnel = require('localtunnel');
} catch (_) {
  logger.warn('localtunnel npm module not present — cloudflared only');
}

function loadConfig() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) {}
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
 * Ensure cloudflared.exe is present.
 */
function ensureCloudflaredAvailable() {
  return new Promise((resolve) => {
    CLOUDFLARED_BIN = resolveCloudflaredBin();
    if (fs.existsSync(CLOUDFLARED_BIN)) {
      return resolve(CLOUDFLARED_BIN);
    }

    logger.info('[+] Auto-downloading cloudflared.exe binary...');
    const PS = process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : 'powershell.exe';
    const downloadCmd = `"${PS}" -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '${CLOUDFLARED_BIN}' -UseBasicParsing"`;

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

/** Regex to capture trycloudflare.com URL (excluding Cloudflare internal api.trycloudflare.com) */
const TUNNEL_URL_REGEX = /https?:\/\/(?!api\.)[a-zA-Z0-9-]+\.trycloudflare\.com/;
const TUNNEL_TIMEOUT_MS = 15000;

function createCloudflaredTunnel(port) {
  return new Promise(async (resolve, reject) => {
    const binPath = await ensureCloudflaredAvailable();
    
    if (!binPath || !fs.existsSync(binPath)) {
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
          reject(err);
        }
      });

      tunnelProcess.on('exit', (code) => {
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

/**
 * Fallback localtunnel provider when Cloudflare quick tunnels fail/rate-limit.
 */
async function createLocaltunnelFallback(port) {
  if (!localtunnel) {
    throw new Error('localtunnel module not loaded');
  }
  logger.info(`[+] Spawning localtunnel fallback for localhost:${port}`);
  const tunnel = await localtunnel({ port });

  const wrapper = {
    pid: 'localtunnel',
    exitCode: null,
    kill: () => { try { tunnel.close(); } catch (_) {} },
    close: () => { try { tunnel.close(); } catch (_) {} },
  };

  logger.info(`[OK] Localtunnel established: ${tunnel.url}`);
  return { publicUrl: tunnel.url, tunnelProcess: wrapper };
}

async function createTunnelWithRetry(port) {
  // 1. Try Cloudflared
  try {
    logger.info(`[+] Tunnel creation attempt (Cloudflare) for port ${port}`);
    return await createCloudflaredTunnel(port);
  } catch (err) {
    logger.warn(`[-] Cloudflare tunnel attempt 1 failed (${err.message}) — retrying once...`);
  }

  try {
    return await createCloudflaredTunnel(port);
  } catch (err) {
    logger.warn(`[-] Cloudflare tunnel attempt 2 failed (${err.message}) — switching to Localtunnel fallback...`);
  }

  // 2. Try Localtunnel fallback
  try {
    return await createLocaltunnelFallback(port);
  } catch (err) {
    logger.warn(`[-] Localtunnel fallback failed (${err.message})`);
  }

  throw new Error('All tunneling providers (Cloudflare + Localtunnel) failed');
}

function killTunnel(tunnelProcess) {
  if (!tunnelProcess) return;
  if (typeof tunnelProcess.close === 'function') {
    try { tunnelProcess.close(); } catch (_) {}
  }
  if (typeof tunnelProcess.kill === 'function' && tunnelProcess.pid !== 'localtunnel' && tunnelProcess.exitCode === null) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(tunnelProcess.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        tunnelProcess.kill('SIGTERM');
      }
    } catch (_) {}
  }
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
