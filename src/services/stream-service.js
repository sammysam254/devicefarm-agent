'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const rentalPaymentService = require('./rental-payment-service');
const ScrcpyEngine = require('./scrcpy-engine');

function getStreamBlockedHtml(serial, checkoutUrl, statusObj = {}) {
  const statusStr = (statusObj.status || 'UNPAID').toUpperCase();
  const fee = statusObj.monthlyFee || 30;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stream Link Invalidated — Device ${serial}</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #060911;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #0f172a;
      border: 1px solid rgba(239, 68, 68, 0.45);
      border-radius: 24px;
      padding: 40px 32px;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 60px rgba(0,0,0,0.95), 0 0 35px rgba(239, 68, 68, 0.2);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.35);
      padding: 6px 16px;
      border-radius: 100px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.8px;
      margin-bottom: 20px;
    }
    .price-tag {
      font-size: 46px;
      font-weight: 800;
      color: #38bdf8;
      margin: 12px 0 4px;
      letter-spacing: -1px;
    }
    .price-period {
      font-size: 14px;
      color: #94a3b8;
      margin-bottom: 24px;
    }
    .info-box {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 24px;
      text-align: left;
      font-size: 13px;
      line-height: 1.6;
    }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 10px; }
    .info-row:last-child { margin-bottom: 0; }
    .info-label { color: #64748b; }
    .info-value { color: #f1f5f9; font-weight: 600; font-family: monospace; }
    .btn {
      display: block;
      width: 100%;
      padding: 15px;
      background: linear-gradient(135deg, #ef4444, #dc2626);
      color: #fff;
      text-decoration: none;
      font-weight: 700;
      border-radius: 14px;
      font-size: 15px;
      border: none;
      cursor: pointer;
      box-shadow: 0 10px 25px rgba(239, 68, 68, 0.4);
      transition: all 0.2s ease;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 15px 30px rgba(239, 68, 68, 0.55); }
    .btn-secondary {
      background: rgba(255,255,255,0.08);
      color: #94a3b8;
      box-shadow: none;
      margin-top: 12px;
    }
    .btn-secondary:hover { background: rgba(255,255,255,0.15); color: #fff; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🔒 STREAM LINK INVALIDATED</div>
    <h2 style="font-size:22px; font-weight:700;">Monthly Rental Payment Required</h2>
    <p style="color:#94a3b8; font-size:14px; margin-top:8px; line-height:1.5;">
      This stream link is locked. To enable streaming for this device (both local and cloud), you must pay the monthly rental fee.
    </p>

    <div class="price-tag">$${fee}.00 USD</div>
    <div class="price-period">Per Device Link / Month</div>

    <div class="info-box">
      <div class="info-row"><span class="info-label">Device Serial:</span><span class="info-value">${serial}</span></div>
      <div class="info-row"><span class="info-label">Rental Status:</span><span class="info-value" style="color:#ef4444;">${statusStr}</span></div>
      <div class="info-row"><span class="info-label">Stream Access:</span><span class="info-value" style="color:#ef4444;">BLOCKED UNTIL PAID</span></div>
      <div class="info-row"><span class="info-label">Profile ID:</span><span class="info-value">${statusObj.userProfileId || 'RENTAL_USER'}</span></div>
    </div>

    <a href="${checkoutUrl}" target="_blank" class="btn">💳 Pay $${fee} USD via Supabase to Unlock</a>
    <button onclick="location.reload()" class="btn btn-secondary">🔄 Refresh & Check Status</button>
  </div>
</body>
</html>`;
}

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

function resolveAdbBin() {
  if (config.adbPath && fs.existsSync(config.adbPath)) {
    return config.adbPath;
  }
  const bundledAdb = path.join(__dirname, '../../assets/bin/adb.exe');
  if (fs.existsSync(bundledAdb)) {
    return bundledAdb;
  }
  const commonPath = 'C:\\platform-tools\\adb.exe';
  if (fs.existsSync(commonPath)) {
    return commonPath;
  }
  return 'adb';
}

const ADB_BIN = resolveAdbBin();

/** Active Stream Servers map */
const activeServers = new Map();

/** Persistent interactive input shells per device serial for sub-millisecond touch dispatch */
const inputShells = new Map();

function getOrCreateInputShell(serial) {
  if (inputShells.has(serial)) {
    const proc = inputShells.get(serial);
    if (proc && proc.stdin && !proc.stdin.destroyed) return proc;
  }
  const proc = spawn(ADB_BIN, ['-s', serial, 'shell'], {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (proc.stdin) try { proc.stdin.setNoDelay(true); } catch (_) {}
  proc.on('error', () => inputShells.delete(serial));
  proc.on('close', () => inputShells.delete(serial));
  inputShells.set(serial, proc);
  return proc;
}

function sendSubMsInput(serial, cmd) {
  try {
    const sh = getOrCreateInputShell(serial);
    sh.stdin.write(cmd + '\n');
  } catch (_) {
    exec(`"${ADB_BIN}" -s ${serial} shell ${cmd}`);
  }
}

/**
 * Real-time Frame Capture Engine.
 * Continuously captures device screen via `adb exec-out screencap -p` (device-side PNG encoding)
 * and broadcasts frames to all connected WebSocket clients via server-push.
 */
class FrameCaptureEngine {
  constructor(serial) {
    this.serial = serial;
    this.latestFrame = null;
    this.isRunning = false;
    this.isCapturing = false;
    this.wsClients = new Set();
    this._loopTimer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`[CaptureEngine] Started real-time capture for ${this.serial}`);
    this._runLoop();
  }

  stop() {
    this.isRunning = false;
    if (this._loopTimer) {
      clearTimeout(this._loopTimer);
      this._loopTimer = null;
    }
    this.wsClients.clear();
    logger.info(`[CaptureEngine] Stopped for ${this.serial}`);
  }

  addClient(ws) {
    this.wsClients.add(ws);
    // Instant first paint: send cached frame immediately on connect
    if (this.latestFrame && ws.readyState === WebSocket.OPEN) {
      try { ws.send(this.latestFrame, { binary: true }); } catch (_) {}
    }
  }

  removeClient(ws) {
    this.wsClients.delete(ws);
  }

  /** One-shot capture for HTTP endpoint fallback */
  captureOneFrame() {
    return new Promise((resolve) => {
      const proc = spawn(ADB_BIN, ['-s', this.serial, 'exec-out', 'screencap', '-p'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const chunks = [];
      proc.stdout.on('data', c => chunks.push(c));
      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          this.latestFrame = Buffer.concat(chunks);
          resolve(this.latestFrame);
        } else {
          resolve(this.latestFrame);
        }
      });
      proc.on('error', () => resolve(this.latestFrame));
    });
  }

  _runLoop() {
    if (!this.isRunning) return;

    // Adaptive: slow poll when no clients connected to save resources
    if (this.wsClients.size === 0) {
      this._loopTimer = setTimeout(() => this._runLoop(), 300);
      return;
    }

    if (this.isCapturing) return;
    this.isCapturing = true;

    const proc = spawn(ADB_BIN, ['-s', this.serial, 'exec-out', 'screencap', '-p'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));

    proc.on('close', (code) => {
      this.isCapturing = false;
      if (code === 0 && chunks.length > 0) {
        this.latestFrame = Buffer.concat(chunks);
        this._broadcast(this.latestFrame);
      }

      if (this.isRunning) {
        setImmediate(() => this._runLoop());
      }
    });

    proc.on('error', () => {
      this.isCapturing = false;
      if (this.isRunning) {
        this._loopTimer = setTimeout(() => this._runLoop(), 50);
      }
    });
  }

  _broadcast(frameBuf) {
    for (const ws of this.wsClients) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.wsClients.delete(ws);
        continue;
      }
      // Backpressure: skip frame if client has >512KB queued
      if (ws.bufferedAmount > 524288) continue;
      try {
        ws.send(frameBuf, { binary: true });
      } catch (_) {
        this.wsClients.delete(ws);
      }
    }
  }
}

/**
 * Start a Real-Time Stream Server with server-push frame delivery.
 *
 * @param {string} serial  The ADB serial number of the target device.
 * @param {number} port    The local TCP port the server should listen on.
 * @returns {Promise<{ streamProcess: object, localUrl: string }>}
 */
async function startStreamServer(serial, port) {
  logger.info(`Starting Real-Time Stream Server for ${serial} on port ${port}...`);

  // Persistent ADB Shell for instant input execution (<1ms)
  const inputShell = spawn(ADB_BIN, ['-s', serial, 'shell'], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });

  if (inputShell && inputShell.stdin) {
    try { inputShell.stdin.setNoDelay(true); } catch (_) {}
  }

  const stdinBuf = Buffer.allocUnsafe(256);

  function sendSubMsInput(cmd) {
    if (inputShell && inputShell.stdin && !inputShell.stdin.destroyed) {
      const len = stdinBuf.write(cmd + '\n', 0, 'utf-8');
      inputShell.stdin.write(stdinBuf.subarray(0, len));
    } else {
      exec(`"${ADB_BIN}" -s ${serial} shell ${cmd}`);
    }
  }

  // HTML5 Web Player with 60 FPS Full-Color Realtime Engine
  const playerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Device ${serial} — Real-Time Stream</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      background: #04060a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      user-select: none;
      -webkit-user-select: none;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      max-width: 580px;
      padding: 2px 0;
    }
    .title-box { display: flex; align-items: center; gap: 8px; }
    .badge {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 3px 10px;
      border-radius: 100px;
      font-size: 11px;
      font-weight: 700;
      display: flex; align-items: center; gap: 6px;
      letter-spacing: 0.5px;
    }
    .dot { width: 6px; height: 6px; background: #38bdf8; border-radius: 50%; box-shadow: 0 0 10px #38bdf8; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    .main-stage {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: 100%;
      max-height: 86vh;
    }

    .screen-wrapper {
      position: relative;
      background: #000;
      border-radius: 20px;
      border: 3px solid rgba(56, 189, 248, 0.45);
      box-shadow: 0 20px 50px rgba(0,0,0,0.95), 0 0 30px rgba(56, 189, 248, 0.25);
      overflow: hidden;
      cursor: pointer;
      touch-action: none;
      display: flex;
      align-items: center;
      justify-content: center;
      max-height: 86vh;
    }
    #screenCanvas {
      display: block;
      max-height: 86vh;
      width: auto;
      height: auto;
      max-width: 100%;
      object-fit: contain;
      cursor: pointer;
    }

    .right-sidebar {
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      padding: 8px 6px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.8);
      max-height: 86vh;
      overflow-y: auto;
    }

    .side-btn {
      width: 38px;
      height: 38px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #f1f5f9;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .side-btn:hover {
      background: rgba(56, 189, 248, 0.25);
      border-color: rgba(56, 189, 248, 0.6);
      color: #38bdf8;
      transform: scale(1.06);
    }
    .side-btn:active { transform: scale(0.92); }

    .side-btn-active {
      background: rgba(52, 211, 153, 0.25) !important;
      border-color: #34d399 !important;
      color: #34d399 !important;
    }

    .side-btn-danger {
      background: rgba(248, 113, 113, 0.15);
      color: #f87171;
      border-color: rgba(248, 113, 113, 0.3);
    }
    .side-btn-danger:hover {
      background: rgba(248, 113, 113, 0.35);
      border-color: #f87171;
      color: #fff;
    }

    .divider { height: 1px; background: rgba(255, 255, 255, 0.12); margin: 2px 0; }

    .floating-back {
      position: absolute;
      bottom: 12px;
      right: 12px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #ef4444;
      color: #fff;
      border: 2px solid rgba(255,255,255,0.4);
      box-shadow: 0 4px 15px rgba(239, 68, 68, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      cursor: pointer;
      z-index: 90;
      transition: all 0.2s ease;
    }
    .floating-back:hover { transform: scale(1.1); background: #dc2626; }
    .floating-back:active { transform: scale(0.9); }

    .touch-ripple {
      position: absolute;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: rgba(56, 189, 248, 0.5);
      border: 2px solid #38bdf8;
      box-shadow: 0 0 15px #38bdf8;
      transform: translate(-50%, -50%) scale(0.4);
      pointer-events: none;
      animation: ripple 0.25s cubic-bezier(0, 0, 0.2, 1) forwards;
      z-index: 100;
    }
    @keyframes ripple {
      0% { transform: translate(-50%, -50%) scale(0.4); opacity: 1; }
      100% { transform: translate(-50%, -50%) scale(1.6); opacity: 0; }
    }

    .modal {
      display: none;
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.75);
      backdrop-filter: blur(8px);
      z-index: 200;
      align-items: center;
      justify-content: center;
    }
    .modal-content {
      background: #0f172a;
      border: 1px solid rgba(56, 189, 248, 0.4);
      border-radius: 16px;
      padding: 20px;
      width: 90%;
      max-width: 400px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.8);
    }
    .modal-title { font-weight: 700; font-size: 16px; margin-bottom: 12px; }
    .modal-input {
      width: 100%;
      padding: 10px 14px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      color: #fff;
      font-size: 14px;
      margin-bottom: 14px;
      outline: none;
    }
    .modal-btn {
      width: 100%;
      padding: 10px;
      background: #38bdf8;
      color: #0f172a;
      border: none;
      border-radius: 10px;
      font-weight: 700;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-box">
      <span style="font-size:20px;">🎨</span>
      <div>
        <div style="font-weight:700; font-size:14px;">Real-Time Instant Stream</div>
        <div style="font-size:10px; color:#64748b; font-family:monospace;">${serial}</div>
      </div>
    </div>
    <div class="badge" id="modeBadge"><span class="dot"></span> REALTIME LIVE</div>
  </div>

  <div class="main-stage">
    <div class="screen-wrapper" id="screenWrapper">
      <canvas id="screenCanvas" width="720" height="1600"></canvas>
      <button class="floating-back" title="Back Button" onclick="sendKey(4)">↩</button>
    </div>

    <div class="right-sidebar">
      <button class="side-btn" title="More Options / Settings" onclick="sendKey(82)">⋮</button>
      <button class="side-btn side-btn-danger" title="Power Off / Screen Lock" onclick="sendKey(26)">⏻</button>
      
      <div class="divider"></div>
      
      <button class="side-btn" title="Volume Up" onclick="sendKey(24)">🔊</button>
      <button class="side-btn" title="Volume Down" onclick="sendKey(25)">🔉</button>
      <button class="side-btn" title="Mute Audio" onclick="sendKey(164)">🔕</button>

      <div class="divider"></div>

      <button class="side-btn" title="Home Button" onclick="sendKey(3)">⭕</button>
      <button class="side-btn" title="Recent Apps" onclick="sendKey(187)">▢</button>

      <div class="divider"></div>

      <button class="side-btn" title="Take Screenshot" onclick="takeScreenshot()">📷</button>
      <button class="side-btn" title="Text Input" onclick="openTextModal()">⌨️</button>
      <button class="side-btn" title="Upload Video/Image to Phone" onclick="openUploadModal()">📤</button>
      <button class="side-btn" id="audioBtn" title="Play Sound on PC Speakers" onclick="togglePcAudio()">🔈</button>

      <div class="divider"></div>

      <button class="side-btn side-btn-danger" title="Reboot Phone" onclick="rebootPhone()">🔄</button>
    </div>
  </div>

  <div class="modal" id="textModal">
    <div class="modal-content">
      <div class="modal-title">⌨️ Send Text to Phone</div>
      <input type="text" class="modal-input" id="textInputValue" placeholder="Type text here..." onkeydown="if(event.key==='Enter') submitText()" />
      <button class="modal-btn" onclick="submitText()">Send Text</button>
    </div>
  </div>

  <div class="modal" id="uploadModal">
    <div class="modal-content">
      <div class="modal-title">📤 Upload Photo/Video to Phone</div>
      <input type="file" class="modal-input" id="filePicker" accept="image/*,video/*" />
      <button class="modal-btn" onclick="uploadSelectedFile()">Upload File</button>
    </div>
  </div>

  <script>
    const wrapper = document.getElementById('screenWrapper');
    const canvas = document.getElementById('screenCanvas');
    const ctx = canvas.getContext('2d');
    const modeBadge = document.getElementById('modeBadge');
    const audioBtn = document.getElementById('audioBtn');

    let nativeWidth = 720;
    let nativeHeight = 1600;

    let ws = null;
    let isWsActive = false;

    // ── Real-Time Server-Push WebSocket Engine ──
    function connectWS() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + location.host + '/ws';

      try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'blob';

        const wsTimer = setTimeout(() => {
          if (!isWsActive) startHttpPull();
        }, 1500);

        ws.onopen = () => {
          clearTimeout(wsTimer);
          isWsActive = true;
          modeBadge.innerHTML = '<span class="dot"></span> REALTIME LIVE';
        };

        ws.onmessage = (event) => {
          if (event.data instanceof Blob) {
            createImageBitmap(event.data).then(bitmap => {
              nativeWidth = bitmap.width;
              nativeHeight = bitmap.height;

              if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
              }
              ctx.drawImage(bitmap, 0, 0);
              bitmap.close();
            }).catch(() => {});
          }
        };

        ws.onerror = () => {
          clearTimeout(wsTimer);
          if (!isWsActive) startHttpPull();
        };

        ws.onclose = () => {
          isWsActive = false;
          setTimeout(connectWS, 800);
        };
      } catch (e) {
        startHttpPull();
      }
    }

    let isFetchingHttp = false;
    function startHttpPull() {
      if (isWsActive) return;
      modeBadge.innerHTML = '<span class="dot"></span> CLOUD MODE';

      function pullHttp() {
        if (isWsActive || isFetchingHttp) return;
        isFetchingHttp = true;

        fetch('/screen.jpg?t=' + Date.now())
          .then(r => r.blob())
          .then(blob => createImageBitmap(blob))
          .then(bitmap => {
            nativeWidth = bitmap.width;
            nativeHeight = bitmap.height;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            isFetchingHttp = false;
            requestAnimationFrame(pullHttp);
          })
          .catch(() => {
            isFetchingHttp = false;
            setTimeout(pullHttp, 30);
          });
      }

      pullHttp();
    }

    // ── PC Audio Forwarding Engine ──
    let audioCtx = null;
    let isAudioPlaying = false;

    function togglePcAudio() {
      if (isAudioPlaying) {
        if (audioCtx) audioCtx.suspend();
        isAudioPlaying = false;
        audioBtn.classList.remove('side-btn-active');
        audioBtn.innerHTML = '🔈';
        alert('PC Audio Muted');
      } else {
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        audioCtx.resume();
        isAudioPlaying = true;
        audioBtn.classList.add('side-btn-active');
        audioBtn.innerHTML = '🔊';
        alert('PC Audio Enabled! Playing sound on PC speakers...');
      }
    }

    function showTouchRipple(clientX, clientY) {
      const rect = wrapper.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const ripple = document.createElement('div');
      ripple.className = 'touch-ripple';
      ripple.style.left = x + 'px';
      ripple.style.top = y + 'px';
      wrapper.appendChild(ripple);
      setTimeout(() => ripple.remove(), 250);
    }

    function sendControl(data) {
      if (isWsActive && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      } else {
        const query = Object.keys(data).map(k => k + '=' + encodeURIComponent(data[k])).join('&');
        fetch('/control?' + query);
      }
    }

    let isMouseDown = false;
    let startX = 0, startY = 0;
    let startTime = 0;
    let lastMoveTime = 0;

    function getNativeCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const scaleX = nativeWidth / rect.width;
      const scaleY = nativeHeight / rect.height;
      return {
        x: Math.round((clientX - rect.left) * scaleX),
        y: Math.round((clientY - rect.top) * scaleY),
        clientX,
        clientY
      };
    }

    function handleStart(e) {
      if (e.target !== canvas) return;
      e.preventDefault();
      isMouseDown = true;
      const c = getNativeCoords(e);
      startX = c.x;
      startY = c.y;
      startTime = Date.now();
      showTouchRipple(c.clientX, c.clientY);

      // Send ACTION_DOWN (0) immediately for instant response
      sendControl({ type: 'touch', action: 0, x: startX, y: startY, width: nativeWidth, height: nativeHeight });
    }

    function handleMove(e) {
      if (!isMouseDown) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastMoveTime < 16) return;
      lastMoveTime = now;
      const c = getNativeCoords(e);

      // Send ACTION_MOVE (2) continuously for real-time cursor tracking
      sendControl({ type: 'touch', action: 2, x: c.x, y: c.y, width: nativeWidth, height: nativeHeight });
    }

    function handleEnd(e) {
      if (!isMouseDown) return;
      e.preventDefault();
      isMouseDown = false;

      const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
      const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
      const rect = canvas.getBoundingClientRect();
      const scaleX = nativeWidth / rect.width;
      const scaleY = nativeHeight / rect.height;
      const endX = Math.round((clientX - rect.left) * scaleX);
      const endY = Math.round((clientY - rect.top) * scaleY);

      // Send ACTION_UP (1) to complete the gesture
      sendControl({ type: 'touch', action: 1, x: endX, y: endY, width: nativeWidth, height: nativeHeight });
    }

    // ── Mouse Wheel Scroll Support ──
    let wheelTimer = null;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (wheelTimer) return;
      wheelTimer = setTimeout(() => { wheelTimer = null; }, 30);

      const c = getNativeCoords(e);
      const scrollDistance = e.deltaY > 0 ? -380 : 380;
      const y2 = Math.max(50, Math.min(nativeHeight - 50, c.y + scrollDistance));

      sendControl({
        type: 'swipe',
        x1: c.x,
        y1: c.y,
        x2: c.x,
        y2: y2,
        duration: 60
      });
    }, { passive: false });

    wrapper.addEventListener('mousedown', handleStart);
    wrapper.addEventListener('mousemove', handleMove);
    wrapper.addEventListener('mouseup', handleEnd);
    wrapper.addEventListener('touchstart', handleStart, { passive: false });
    wrapper.addEventListener('touchmove', handleMove, { passive: false });
    wrapper.addEventListener('touchend', handleEnd);

    function sendKey(code) {
      sendControl({ type: 'code', code: code });
    }

    function takeScreenshot() {
      fetch('/screen.jpg?t=' + Date.now())
        .then(r => r.blob())
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'screenshot-${serial}-' + Date.now() + '.jpg';
          a.click();
        });
    }

    function rebootPhone() {
      if (confirm('Are you sure you want to reboot device ${serial}?')) {
        sendControl({ type: 'reboot' });
      }
    }

    function openTextModal() {
      document.getElementById('textModal').style.display = 'flex';
      document.getElementById('textInputValue').focus();
    }

    function submitText() {
      const val = document.getElementById('textInputValue').value;
      if (val) {
        sendControl({ type: 'text', text: val });
        document.getElementById('textInputValue').value = '';
      }
      document.getElementById('textModal').style.display = 'none';
    }

    function openUploadModal() {
      document.getElementById('uploadModal').style.display = 'flex';
    }

    function uploadSelectedFile() {
      const input = document.getElementById('filePicker');
      if (input.files.length === 0) return alert('Select a file first!');
      const file = input.files[0];
      const formData = new FormData();
      formData.append('file', file);

      fetch('/upload', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(res => {
          alert('File ' + file.name + ' uploaded successfully to phone Gallery!');
          document.getElementById('uploadModal').style.display = 'none';
        })
        .catch(() => alert('Upload failed!'));
    }

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Backspace') sendKey(67);
      else if (e.key === 'Enter') sendKey(66);
      else if (e.key === 'Escape') sendKey(4);
      else if (e.key.length === 1) {
        sendControl({ type: 'text', text: e.key });
      }
    });

    window.onclick = (e) => {
      if (e.target.className === 'modal') {
        e.target.style.display = 'none';
      }
    };

    connectWS();
  </script>
</body>
</html>`;

    // ── Cached Payment Status (smart dynamic TTL: 2s when unpaid, 15s when paid) ──
    let cachedRentalStatus = null;
    let lastPaymentCheckTime = 0;

    async function getCachedRentalStatus(forceRefresh = false) {
      const now = Date.now();
      const ttl = (cachedRentalStatus && cachedRentalStatus.isPaid) ? 15000 : 2000;
      if (!forceRefresh && cachedRentalStatus !== null && (now - lastPaymentCheckTime) < ttl) {
        return cachedRentalStatus;
      }
      try {
        cachedRentalStatus = await rentalPaymentService.checkDeviceRentalStatus(serial);
      } catch (err) {
        if (cachedRentalStatus !== null) return cachedRentalStatus;
        cachedRentalStatus = { isPaid: false };
      }
      lastPaymentCheckTime = now;
      return cachedRentalStatus;
    }

    // ── Real-Time Capture Engine & Stealth Scrcpy Engine ──
    const captureEngine = new FrameCaptureEngine(serial);
    const scrcpyEngine = new ScrcpyEngine(serial);

    let useScrcpy = false;

    return new Promise(async (resolve, reject) => {
      try {
        const scrcpyVideoPort = port + 1000;
        await scrcpyEngine.start(scrcpyVideoPort, scrcpyVideoPort);
        useScrcpy = true;
        logger.info(`[STEALTH SCRCPY] Active for ${serial}`);
      } catch (err) {
        logger.warn(`[STEALTH SCRCPY] Scrcpy input fallback for ${serial}: ${err.message}`);
      }

      // Always start captureEngine to provide image frames for HTML canvas rendering
      captureEngine.start();

      const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const urlObj = new URL(req.url, `http://localhost:${port}`);
        const pathname = urlObj.pathname;

        // Cached rental payment check (smart TTL: 2s when unpaid, 15s when paid; force refresh on page visit)
        const isMainPage = (pathname === '/' || pathname === '/index.html');
        const rentalStatus = await getCachedRentalStatus(isMainPage);

        if (!rentalStatus.isPaid) {
          if (pathname === '/screen.jpg' || pathname === '/screen.png' || pathname === '/control' || pathname === '/upload') {
            res.writeHead(402, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'STREAM LINK INVALIDATED: $30 USD monthly rental payment required.',
              serial,
              monthlyFeeUsd: rentalStatus.monthlyFee || 30,
              isPaid: false,
              checkoutUrl: rentalPaymentService.getPaymentCheckoutUrl(serial),
            }));
            return;
          }

          const checkoutUrl = rentalPaymentService.getPaymentCheckoutUrl(serial);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(getStreamBlockedHtml(serial, checkoutUrl, rentalStatus));
          return;
        }

        // File Upload Endpoint (`/upload`) -> Pushes file to /sdcard/Download/ and triggers MediaScanner
        if (pathname === '/upload' && req.method === 'POST') {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => {
            const buf = Buffer.concat(chunks);
            const tempFilePath = path.join(process.cwd(), `upload_${Date.now()}.tmp`);
            fs.writeFileSync(tempFilePath, buf);

            const destPath = `/sdcard/Download/media_${Date.now()}.jpg`;
            exec(`"${ADB_BIN}" -s ${serial} push "${tempFilePath}" "${destPath}"`, () => {
              try { fs.unlinkSync(tempFilePath); } catch (_) {}
              exec(`"${ADB_BIN}" -s ${serial} shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${destPath}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'ok', dest: destPath }));
            });
          });
          return;
        }

        // Real-time screen capture (served from capture engine cache)
        if (pathname === '/screen.jpg' || pathname === '/screen.png') {
          const frame = captureEngine.latestFrame;
          if (frame) {
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
            });
            res.end(frame);
          } else {
            captureEngine.captureOneFrame().then(f => {
              if (f) {
                res.writeHead(200, {
                  'Content-Type': 'image/png',
                  'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
                });
                res.end(f);
              } else {
                res.writeHead(500);
                res.end('Capture error');
              }
            });
          }
          return;
        }

        if (pathname === '/control') {
          const type = urlObj.searchParams.get('type');
          if (type === 'tap') {
            const x = parseFloat(urlObj.searchParams.get('x'));
            const y = parseFloat(urlObj.searchParams.get('y'));
            const sent = useScrcpy && scrcpyEngine.sendTouchEvent(0, x, y, 1080, 2400);
            if (sent) {
              setTimeout(() => scrcpyEngine.sendTouchEvent(1, x, y, 1080, 2400), 30);
            } else {
              sendSubMsInput(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
            }
          } else if (type === 'swipe') {
            const x1 = parseFloat(urlObj.searchParams.get('x1'));
            const y1 = parseFloat(urlObj.searchParams.get('y1'));
            const x2 = parseFloat(urlObj.searchParams.get('x2'));
            const y2 = parseFloat(urlObj.searchParams.get('y2'));
            const sent = useScrcpy && scrcpyEngine.sendTouchEvent(0, x1, y1, 1080, 2400);
            if (sent) {
              setTimeout(() => scrcpyEngine.sendTouchEvent(2, x2, y2, 1080, 2400), 30);
              setTimeout(() => scrcpyEngine.sendTouchEvent(1, x2, y2, 1080, 2400), 80);
            } else {
              sendSubMsInput(serial, `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} 100`);
            }
          } else if (type === 'key' || type === 'code') {
            const code = parseInt(urlObj.searchParams.get('code'), 10);
            const sent = useScrcpy && scrcpyEngine.sendKeycode(0, code);
            if (sent) {
              setTimeout(() => scrcpyEngine.sendKeycode(1, code), 20);
            } else {
              sendSubMsInput(serial, `input keyevent ${code}`);
            }
          } else if (type === 'text') {
            const text = urlObj.searchParams.get('text');
            const sent = useScrcpy && scrcpyEngine.sendText(text);
            if (!sent) {
              sendSubMsInput(serial, `input text "${text.replace(/"/g, '\\"')}"`);
            }
          } else if (type === 'reboot') {
            exec(`"${ADB_BIN}" -s ${serial} reboot`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(playerHtml);
      });

      // WebSocket Real-Time Server-Push Stream
      const wss = new WebSocket.Server({ server, path: '/ws' });

      wss.on('connection', async (ws) => {
        const rentalStatus = await getCachedRentalStatus();
        if (!rentalStatus.isPaid) {
          logger.warn(`Rejecting WebSocket stream for ${serial} — Monthly rental fee ($30 USD) unpaid`);
          try {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'STREAM LINK INVALIDATED',
              message: 'Monthly rental fee ($30 USD/month) unpaid.',
            }));
            ws.close(4002, 'Rental Payment Unpaid');
          } catch (_) {}
          return;
        }

        logger.info(`WebSocket client connected to real-time stream for ${serial}`);

        // Add to capture engine for server-push image frame delivery to canvas
        captureEngine.addClient(ws);

        // Periodic payment re-check (every 60s)
        const paymentInterval = setInterval(async () => {
          try {
            const status = await getCachedRentalStatus();
            if (!status.isPaid) {
              ws.close(4002, 'Rental Payment Unpaid');
            }
          } catch (_) {}
        }, 60000);

        ws.on('message', (msg) => {
          try {
            const data = JSON.parse(msg.toString());
            const width = data.width || 1080;
            const height = data.height || 2400;

            if (data.type === 'touch') {
              const sent = useScrcpy && scrcpyEngine.sendTouchEvent(data.action, data.x, data.y, width, height);
              if (!sent) {
                // Fallback to ADB shell only for DOWN and UP, skip MOVE to avoid shell overhead
                if (data.action === 0 || data.action === 1) {
                  sendSubMsInput(serial, `input tap ${Math.round(data.x)} ${Math.round(data.y)}`);
                }
              }
            } else if (data.type === 'tap') {
              const sent = useScrcpy && scrcpyEngine.sendTouchEvent(0, data.x, data.y, width, height);
              if (sent) {
                setTimeout(() => scrcpyEngine.sendTouchEvent(1, data.x, data.y, width, height), 30);
              } else {
                sendSubMsInput(serial, `input tap ${Math.round(data.x)} ${Math.round(data.y)}`);
              }
            } else if (data.type === 'swipe') {
              const sent = useScrcpy && scrcpyEngine.sendTouchEvent(0, data.x1, data.y1, width, height);
              if (sent) {
                setTimeout(() => scrcpyEngine.sendTouchEvent(2, data.x2, data.y2, width, height), 30);
                setTimeout(() => scrcpyEngine.sendTouchEvent(1, data.x2, data.y2, width, height), 80);
              } else {
                sendSubMsInput(serial, `input swipe ${Math.round(data.x1)} ${Math.round(data.y1)} ${Math.round(data.x2)} ${Math.round(data.y2)} ${data.duration || 100}`);
              }
            } else if (data.type === 'key' || data.type === 'code') {
              const sent = useScrcpy && scrcpyEngine.sendKeycode(0, data.code);
              if (sent) {
                setTimeout(() => scrcpyEngine.sendKeycode(1, data.code), 20);
              } else {
                sendSubMsInput(serial, `input keyevent ${data.code}`);
              }
            } else if (data.type === 'text') {
              const sent = useScrcpy && scrcpyEngine.sendText(data.text);
              if (!sent) {
                sendSubMsInput(serial, `input text "${data.text.replace(/"/g, '\\"')}"`);
              }
            } else if (data.type === 'reboot') {
              exec(`"${ADB_BIN}" -s ${serial} reboot`);
            }
          } catch (_) {}
        });

        ws.on('close', () => {
          if (useScrcpy) scrcpyEngine.removeClient(ws);
          else captureEngine.removeClient(ws);
          clearInterval(paymentInterval);
        });

        ws.on('error', () => {
          if (useScrcpy) scrcpyEngine.removeClient(ws);
          else captureEngine.removeClient(ws);
          clearInterval(paymentInterval);
        });
      });

      server.on('error', (err) => {
        logger.error(`Stream server error for ${serial} on port ${port}:`, err.message);
        reject(err);
      });

      server.listen(port, '0.0.0.0', () => {
        const localUrl = `http://localhost:${port}`;
        logger.info(`Real-Time Stream server running for ${serial} at ${localUrl}`);
        activeServers.set(serial, { server, wss, inputShell, captureEngine, scrcpyEngine });

        const streamProcess = {
          pid: port,
          exitCode: null,
          kill: () => {
            scrcpyEngine.stop();
            captureEngine.stop();
            if (inputShell) {
              try { inputShell.kill(); } catch (_) {}
            }
            try { wss.close(); } catch (_) {}
            server.close();
            activeServers.delete(serial);
          }
        };

        resolve({ streamProcess, localUrl });
      });
    });
}


function buildStreamUrl(tunnelDomain, port, serial) {
  const domain = tunnelDomain.replace(/^https?:\/\//, '');
  return `https://${domain}/?action=proxy&remote=tcp%3A127.0.0.1%3A${port}&udid=${encodeURIComponent(serial)}`;
}

function killStreamServer(streamProcess) {
  if (streamProcess && typeof streamProcess.kill === 'function') {
    try {
      streamProcess.kill();
    } catch (_) {}
  }
}

module.exports = {
  startStreamServer,
  buildStreamUrl,
  killStreamServer,
};
