'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn, exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const rentalPaymentService = require('./rental-payment-service');
const ScrcpyEngine = require('./scrcpy-engine');

// ─── Config & ADB resolution ────────────────────────────────────────────────

function loadConfig() {
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(__dirname, '..', '..', 'config.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return {};
}

const config = loadConfig();

function resolveAdbBin() {
  if (config.adbPath && fs.existsSync(config.adbPath)) return config.adbPath;
  const bundled = path.join(__dirname, '../../assets/bin/adb.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (fs.existsSync('C:\\platform-tools\\adb.exe')) return 'C:\\platform-tools\\adb.exe';
  return 'adb';
}

const ADB_BIN = resolveAdbBin();

/** Active stream servers map: serial → { server, wss, inputShell, captureEngine, scrcpyEngine } */
const activeServers = new Map();

// ─── Persistent input shell (sub-ms ADB fallback) ───────────────────────────

const inputShells = new Map();

function getOrCreateInputShell(serial) {
  const existing = inputShells.get(serial);
  if (existing && existing.stdin && !existing.stdin.destroyed) return existing;
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

// ─── Blocked-stream HTML ─────────────────────────────────────────────────────

function getStreamBlockedHtml(serial, checkoutUrl, statusObj = {}) {
  const statusStr = (statusObj.status || 'UNPAID').toUpperCase();
  const fee = statusObj.monthlyFee || 30;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stream Blocked — ${serial}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#060911;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#0f172a;border:1px solid rgba(239,68,68,.45);border-radius:24px;padding:40px 32px;max-width:520px;width:100%;text-align:center;box-shadow:0 25px 60px rgba(0,0,0,.95),0 0 35px rgba(239,68,68,.2)}
    .badge{display:inline-flex;align-items:center;gap:8px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.35);padding:6px 16px;border-radius:100px;font-size:12px;font-weight:800;letter-spacing:.8px;margin-bottom:20px}
    .price-tag{font-size:46px;font-weight:800;color:#38bdf8;margin:12px 0 4px;letter-spacing:-1px}
    .price-period{font-size:14px;color:#94a3b8;margin-bottom:24px}
    .info-box{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:18px;margin-bottom:24px;text-align:left;font-size:13px;line-height:1.6}
    .info-row{display:flex;justify-content:space-between;margin-bottom:10px}
    .info-row:last-child{margin-bottom:0}
    .info-label{color:#64748b}.info-value{color:#f1f5f9;font-weight:600;font-family:monospace}
    .btn{display:block;width:100%;padding:15px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;text-decoration:none;font-weight:700;border-radius:14px;font-size:15px;border:none;cursor:pointer;box-shadow:0 10px 25px rgba(239,68,68,.4);transition:all .2s ease}
    .btn:hover{transform:translateY(-2px);box-shadow:0 15px 30px rgba(239,68,68,.55)}
    .btn-secondary{background:rgba(255,255,255,.08);color:#94a3b8;box-shadow:none;margin-top:12px}
    .btn-secondary:hover{background:rgba(255,255,255,.15);color:#fff}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🔒 STREAM LINK INVALIDATED</div>
    <h2 style="font-size:22px;font-weight:700;">Monthly Rental Payment Required</h2>
    <p style="color:#94a3b8;font-size:14px;margin-top:8px;line-height:1.5;">This stream link is locked. Pay the monthly rental fee to enable streaming.</p>
    <div class="price-tag">$${fee}.00 USD</div>
    <div class="price-period">Per Device Link / Month</div>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Device Serial:</span><span class="info-value">${serial}</span></div>
      <div class="info-row"><span class="info-label">Rental Status:</span><span class="info-value" style="color:#ef4444;">${statusStr}</span></div>
      <div class="info-row"><span class="info-label">Stream Access:</span><span class="info-value" style="color:#ef4444;">BLOCKED UNTIL PAID</span></div>
      <div class="info-row"><span class="info-label">Profile ID:</span><span class="info-value">${statusObj.userProfileId || 'RENTAL_USER'}</span></div>
    </div>
    <a href="${checkoutUrl}" target="_blank" class="btn">💳 Pay $${fee} USD to Unlock</a>
    <button onclick="location.reload()" class="btn btn-secondary">🔄 Refresh &amp; Check Status</button>
  </div>
</body>
</html>`;
}

// ─── FrameCaptureEngine ──────────────────────────────────────────────────────
//
// Key upgrades vs old version:
//   1. Uses a PERSISTENT `adb exec-out` shell that streams raw screencap output
//      continuously instead of re-spawning a new process each frame.
//   2. JPEG conversion on the device side (via `screencap | busybox cjpeg -quality 70`)
//      when available, otherwise falls back to PNG.
//   3. Frame boundaries are detected from PNG/JPEG magic bytes so we can keep a
//      single long-lived pipe and slice frames out of it.
//   4. When no clients are connected, capture is paused entirely (no wasted CPU).
//

class FrameCaptureEngine {
  constructor(serial) {
    this.serial = serial;
    this.latestFrame = null;       // latest raw JPEG/PNG buffer
    this.latestMime = 'image/jpeg';
    this.isRunning = false;
    this.wsClients = new Set();

    // Persistent capture process state
    this._captureProc = null;
    this._pendingChunks = [];
    this._captureActive = false;
    this._restartTimer = null;

    // Stats
    this._fps = 0;
    this._frameCount = 0;
    this._fpsTimer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this._startCapture();
    this._fpsTimer = setInterval(() => {
      this._fps = this._frameCount;
      this._frameCount = 0;
    }, 1000);
    logger.info(`[CaptureEngine ${this.serial}] Started`);
  }

  stop() {
    this.isRunning = false;
    this._stopCapture();
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._fpsTimer) { clearInterval(this._fpsTimer); this._fpsTimer = null; }
    this.wsClients.clear();
    logger.info(`[CaptureEngine ${this.serial}] Stopped`);
  }

  addClient(ws) {
    this.wsClients.add(ws);
    // Send latest cached frame immediately so the screen isn't blank on connect
    if (this.latestFrame && ws.readyState === WebSocket.OPEN) {
      try { ws.send(this.latestFrame, { binary: true }); } catch (_) {}
    }
    // Resume capture if it was paused (no clients)
    if (!this._captureActive) this._startCapture();
  }

  removeClient(ws) {
    this.wsClients.delete(ws);
  }

  /** One-shot capture used by the /screen.jpg HTTP fallback */
  captureOneFrame() {
    return new Promise((resolve) => {
      if (this.latestFrame) return resolve(this.latestFrame);
      const proc = spawn(ADB_BIN, ['-s', this.serial, 'exec-out', 'screencap', '-p'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const chunks = [];
      proc.stdout.on('data', (c) => chunks.push(c));
      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          this.latestFrame = Buffer.concat(chunks);
          this.latestMime = 'image/png';
          resolve(this.latestFrame);
        } else {
          resolve(this.latestFrame);
        }
      });
      proc.on('error', () => resolve(this.latestFrame));
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _startCapture() {
    if (!this.isRunning || this._captureActive) return;
    this._captureActive = true;
    this._spawnCaptureLoop();
  }

  _stopCapture() {
    this._captureActive = false;
    if (this._captureProc) {
      try { this._captureProc.kill(); } catch (_) {}
      this._captureProc = null;
    }
  }

  /**
   * Fast single-shot screencap loop.
   *
   * Strategy: spawn one `adb exec-out screencap -p` process, collect all
   * chunks, broadcast the complete PNG frame, then IMMEDIATELY re-spawn —
   * no setTimeout, no setInterval. This gives maximum throughput limited
   * only by how fast the device can produce frames (~5-15 fps over USB,
   * ~2-8 fps over Wi-Fi — far better than the 1 fps seen with the shell loop).
   *
   * When no WS clients are connected we insert a 200ms idle pause to avoid
   * burning CPU for nothing.
   */
  _spawnCaptureLoop() {
    if (!this.isRunning || !this._captureActive) return;

    // Idle when no clients — avoids burning CPU
    if (this.wsClients.size === 0) {
      this._restartTimer = setTimeout(() => this._spawnCaptureLoop(), 200);
      return;
    }

    const proc = spawn(ADB_BIN, ['-s', this.serial, 'exec-out', 'screencap -p'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this._captureProc = proc;
    const chunks = [];

    proc.stdout.on('data', (c) => chunks.push(c));

    proc.on('close', (code) => {
      this._captureProc = null;
      if (code === 0 && chunks.length > 0) {
        const frame = Buffer.concat(chunks);
        // Sanity: must start with PNG magic bytes
        if (frame[0] === 0x89 && frame[1] === 0x50) {
          this.latestFrame = frame;
          this.latestMime = 'image/png';
          this._frameCount++;
          this._broadcast(frame);
        }
      }
      // Re-spawn immediately — setImmediate yields to I/O but adds no timer delay
      if (this.isRunning && this._captureActive) {
        setImmediate(() => this._spawnCaptureLoop());
      }
    });

    proc.on('error', () => {
      this._captureProc = null;
      if (this.isRunning && this._captureActive) {
        this._restartTimer = setTimeout(() => this._spawnCaptureLoop(), 300);
      }
    });
  }

  _broadcast(frameBuf) {
    for (const ws of this.wsClients) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.wsClients.delete(ws);
        continue;
      }
      // Backpressure: skip frame if client has >256KB queued (was 512KB)
      if (ws.bufferedAmount > 262144) continue;
      try {
        ws.send(frameBuf, { binary: true });
      } catch (_) {
        this.wsClients.delete(ws);
      }
    }
  }
}


// ─── Player HTML builder ─────────────────────────────────────────────────────

function buildPlayerHtml(serial) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Device ${serial} — Live Stream</title>
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;background:#04060a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow:hidden}
    body{display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:6px 12px;user-select:none;-webkit-user-select:none}
    .header{display:flex;align-items:center;justify-content:space-between;width:100%;max-width:580px;padding:2px 0}
    .badge{background:rgba(56,189,248,.15);color:#38bdf8;border:1px solid rgba(56,189,248,.3);padding:3px 10px;border-radius:100px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:6px;letter-spacing:.5px}
    .dot{width:6px;height:6px;background:#38bdf8;border-radius:50%;box-shadow:0 0 10px #38bdf8;animation:pulse 1s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .fps{font-size:10px;color:#64748b;font-family:monospace;margin-left:6px}
    .main-stage{flex:1;display:flex;align-items:center;justify-content:center;gap:12px;width:100%;max-height:86vh}
    .screen-wrapper{position:relative;background:#000;border-radius:20px;border:3px solid rgba(56,189,248,.45);box-shadow:0 20px 50px rgba(0,0,0,.95),0 0 30px rgba(56,189,248,.25);overflow:hidden;cursor:pointer;touch-action:none;display:flex;align-items:center;justify-content:center;max-height:86vh}
    #screenCanvas{display:block;max-height:86vh;width:auto;height:auto;max-width:100%;object-fit:contain;cursor:pointer}
    .right-sidebar{display:flex;flex-direction:column;gap:6px;background:rgba(15,23,42,.95);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:8px 6px;box-shadow:0 10px 30px rgba(0,0,0,.8);max-height:86vh;overflow-y:auto}
    .side-btn{width:38px;height:38px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f1f5f9;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;transition:all .15s ease}
    .side-btn:hover{background:rgba(56,189,248,.25);border-color:rgba(56,189,248,.6);color:#38bdf8;transform:scale(1.06)}
    .side-btn:active{transform:scale(.92)}
    .side-btn-danger{background:rgba(248,113,113,.15);color:#f87171;border-color:rgba(248,113,113,.3)}
    .side-btn-danger:hover{background:rgba(248,113,113,.35);border-color:#f87171;color:#fff}
    .divider{height:1px;background:rgba(255,255,255,.12);margin:2px 0}
    .floating-back{position:absolute;bottom:12px;right:12px;width:44px;height:44px;border-radius:50%;background:#ef4444;color:#fff;border:2px solid rgba(255,255,255,.4);box-shadow:0 4px 15px rgba(239,68,68,.5);display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;z-index:90;transition:all .2s ease}
    .floating-back:hover{transform:scale(1.1);background:#dc2626}
    .floating-back:active{transform:scale(.9)}
    .touch-ripple{position:absolute;width:26px;height:26px;border-radius:50%;background:rgba(56,189,248,.5);border:2px solid #38bdf8;box-shadow:0 0 15px #38bdf8;transform:translate(-50%,-50%) scale(.4);pointer-events:none;animation:ripple .25s cubic-bezier(0,0,.2,1) forwards;z-index:100}
    @keyframes ripple{0%{transform:translate(-50%,-50%) scale(.4);opacity:1}100%{transform:translate(-50%,-50%) scale(1.6);opacity:0}}
    .modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.75);backdrop-filter:blur(8px);z-index:200;align-items:center;justify-content:center}
    .modal-content{background:#0f172a;border:1px solid rgba(56,189,248,.4);border-radius:16px;padding:20px;width:90%;max-width:400px;box-shadow:0 20px 50px rgba(0,0,0,.8)}
    .modal-title{font-weight:700;font-size:16px;margin-bottom:12px}
    .modal-input{width:100%;padding:10px 14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:10px;color:#fff;font-size:14px;margin-bottom:14px;outline:none}
    .modal-btn{width:100%;padding:10px;background:#38bdf8;color:#0f172a;border:none;border-radius:10px;font-weight:700;cursor:pointer}
  </style>
</head>
<body>
  <div class="header">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:20px">🎨</span>
      <div>
        <div style="font-weight:700;font-size:14px">Real-Time Instant Stream</div>
        <div style="font-size:10px;color:#64748b;font-family:monospace">${serial}</div>
      </div>
    </div>
    <div style="display:flex;align-items:center">
      <div class="badge" id="modeBadge"><span class="dot"></span> LIVE</div>
      <span class="fps" id="fpsCounter">-- fps</span>
    </div>
  </div>

  <div class="main-stage">
    <div class="screen-wrapper" id="screenWrapper">
      <canvas id="screenCanvas" width="720" height="1600"></canvas>
      <button class="floating-back" title="Back" onclick="sendKey(4)">&#x21A9;</button>
    </div>
    <div class="right-sidebar">
      <button class="side-btn" title="Menu" onclick="sendKey(82)">&#8942;</button>
      <button class="side-btn side-btn-danger" title="Power" onclick="sendKey(26)">&#9211;</button>
      <div class="divider"></div>
      <button class="side-btn" title="Vol+" onclick="sendKey(24)">&#128266;</button>
      <button class="side-btn" title="Vol-" onclick="sendKey(25)">&#128265;</button>
      <button class="side-btn" title="Mute" onclick="sendKey(164)">&#128277;</button>
      <div class="divider"></div>
      <button class="side-btn" title="Home" onclick="sendKey(3)">&#9711;</button>
      <button class="side-btn" title="Recents" onclick="sendKey(187)">&#9723;</button>
      <div class="divider"></div>
      <button class="side-btn" title="Screenshot" onclick="takeScreenshot()">&#128247;</button>
      <button class="side-btn" title="Type text" onclick="openTextModal()">&#9000;&#65039;</button>
      <button class="side-btn" title="Upload file" onclick="openUploadModal()">&#128228;</button>
      <div class="divider"></div>
      <button class="side-btn side-btn-danger" title="Reboot" onclick="rebootPhone()">&#128260;</button>
    </div>
  </div>

  <div class="modal" id="textModal">
    <div class="modal-content">
      <div class="modal-title">&#9000;&#65039; Send Text to Phone</div>
      <input type="text" class="modal-input" id="textInputValue" placeholder="Type here..." onkeydown="if(event.key==='Enter')submitText()"/>
      <button class="modal-btn" onclick="submitText()">Send</button>
    </div>
  </div>
  <div class="modal" id="uploadModal">
    <div class="modal-content">
      <div class="modal-title">&#128228; Upload to Phone</div>
      <input type="file" class="modal-input" id="filePicker" accept="image/*,video/*"/>
      <button class="modal-btn" onclick="uploadSelectedFile()">Upload</button>
    </div>
  </div>

  <script>
    const wrapper = document.getElementById('screenWrapper');
    const canvas  = document.getElementById('screenCanvas');
    const ctx     = canvas.getContext('2d', { alpha: false });
    const modeBadge   = document.getElementById('modeBadge');
    const fpsCounter  = document.getElementById('fpsCounter');

    let nativeW = 720, nativeH = 1600;
    let ws = null, wsActive = false;

    // ── FPS counter ──────────────────────────────────────────────────────────
    let frameCount = 0, lastFpsTime = performance.now();
    function countFrame() {
      frameCount++;
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        fpsCounter.textContent = frameCount + ' fps';
        frameCount = 0;
        lastFpsTime = now;
      }
    }

    // ── Frame rendering — fastest path via ImageBitmap + rAF ─────────────────
    let pendingBitmap = null;
    let rafPending = false;

    function scheduleDraw(bitmap) {
      if (pendingBitmap) pendingBitmap.close(); // discard superseded frame
      pendingBitmap = bitmap;
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(drawPending);
      }
    }

    function drawPending() {
      rafPending = false;
      if (!pendingBitmap) return;
      const bmp = pendingBitmap;
      pendingBitmap = null;
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width  = bmp.width;
        canvas.height = bmp.height;
        nativeW = bmp.width;
        nativeH = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      countFrame();
    }

    // ── WebSocket stream ─────────────────────────────────────────────────────
    function connectWS() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.binaryType = 'blob';

      const fallbackTimer = setTimeout(() => { if (!wsActive) startHttpPull(); }, 1500);

      ws.onopen = () => {
        clearTimeout(fallbackTimer);
        wsActive = true;
        modeBadge.innerHTML = '<span class="dot"></span> LIVE';
        flushControlQueue();
      };

      ws.onmessage = (e) => {
        if (!(e.data instanceof Blob)) return;
        createImageBitmap(e.data).then(scheduleDraw).catch(() => {});
      };

      ws.onerror = () => { clearTimeout(fallbackTimer); if (!wsActive) startHttpPull(); };
      ws.onclose = () => { wsActive = false; setTimeout(connectWS, 800); };
    }

    // ── HTTP fallback (rAF-driven, no setTimeout) ─────────────────────────────
    let httpRunning = false;
    function startHttpPull() {
      if (wsActive || httpRunning) return;
      httpRunning = true;
      modeBadge.innerHTML = '<span class="dot"></span> CLOUD';
      (function pull() {
        if (wsActive) { httpRunning = false; return; }
        fetch('/screen.jpg?t=' + Date.now())
          .then(r => r.blob())
          .then(b => createImageBitmap(b))
          .then(bmp => { scheduleDraw(bmp); requestAnimationFrame(pull); })
          .catch(() => setTimeout(pull, 50));
      })();
    }

    // ── Control helpers ──────────────────────────────────────────────────────
    // IMPORTANT: Never use fetch() for control — over a tunnel each HTTP
    // request adds 200-500ms. All control messages go exclusively over the
    // WebSocket. If not yet connected, queue and flush on reconnect.
    const controlQueue = [];

    function flushControlQueue() {
      while (controlQueue.length > 0 && ws && ws.readyState === 1) {
        ws.send(JSON.stringify(controlQueue.shift()));
      }
    }

    function sendControl(data) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data));
      } else {
        // Drop MOVE events from queue to avoid stale swipe buildup
        if (data.type === 'touch' && data.action === 2) return;
        controlQueue.push(data);
        // Limit queue size — only keep last 8 pending commands
        if (controlQueue.length > 8) controlQueue.splice(0, controlQueue.length - 8);
      }
    }

    function getNativeCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: Math.round((cx - rect.left) * (nativeW / rect.width)),
        y: Math.round((cy - rect.top)  * (nativeH / rect.height)),
        cx, cy
      };
    }

    function showRipple(cx, cy) {
      const rect = wrapper.getBoundingClientRect();
      const r = document.createElement('div');
      r.className = 'touch-ripple';
      r.style.left = (cx - rect.left) + 'px';
      r.style.top  = (cy - rect.top)  + 'px';
      wrapper.appendChild(r);
      setTimeout(() => r.remove(), 260);
    }

    // ── Pointer events — zero artificial delay ───────────────────────────────
    let pointerDown = false;
    let lastMoveT = 0;

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup',   onUp);
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove',  onMove, { passive: false });
    canvas.addEventListener('touchend',   onUp);

    function onDown(e) {
      e.preventDefault();
      pointerDown = true;
      const c = getNativeCoords(e);
      showRipple(c.cx, c.cy);
      // ACTION_DOWN sent instantly — no setTimeout
      sendControl({ type:'touch', action:0, x:c.x, y:c.y, width:nativeW, height:nativeH });
    }

    function onMove(e) {
      if (!pointerDown) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastMoveT < 8) return;   // ~120 fps max move rate
      lastMoveT = now;
      const c = getNativeCoords(e);
      sendControl({ type:'touch', action:2, x:c.x, y:c.y, width:nativeW, height:nativeH });
    }

    function onUp(e) {
      if (!pointerDown) return;
      e.preventDefault();
      pointerDown = false;
      const cx = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
      const cy = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
      const rect = canvas.getBoundingClientRect();
      const x = Math.round((cx - rect.left) * (nativeW / rect.width));
      const y = Math.round((cy - rect.top)  * (nativeH / rect.height));
      // ACTION_UP sent instantly — no setTimeout
      sendControl({ type:'touch', action:1, x, y, width:nativeW, height:nativeH });
    }

    // ── Mouse wheel scroll ───────────────────────────────────────────────────
    let wheelTimer = null;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (wheelTimer) return;
      wheelTimer = setTimeout(() => { wheelTimer = null; }, 30);
      const c = getNativeCoords(e);
      const dist = e.deltaY > 0 ? -380 : 380;
      const y2 = Math.max(50, Math.min(nativeH - 50, c.y + dist));
      sendControl({ type:'swipe', x1:c.x, y1:c.y, x2:c.x, y2, duration:60 });
    }, { passive: false });

    // ── Keyboard ─────────────────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Backspace') sendKey(67);
      else if (e.key === 'Enter') sendKey(66);
      else if (e.key === 'Escape') sendKey(4);
      else if (e.key.length === 1) sendControl({ type:'text', text:e.key });
    });

    function sendKey(code) { sendControl({ type:'code', code }); }

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
      if (confirm('Reboot device ${serial}?')) sendControl({ type:'reboot' });
    }

    function openTextModal() {
      document.getElementById('textModal').style.display = 'flex';
      document.getElementById('textInputValue').focus();
    }

    function submitText() {
      const v = document.getElementById('textInputValue').value;
      if (v) { sendControl({ type:'text', text:v }); document.getElementById('textInputValue').value = ''; }
      document.getElementById('textModal').style.display = 'none';
    }

    function openUploadModal() { document.getElementById('uploadModal').style.display = 'flex'; }

    function uploadSelectedFile() {
      const f = document.getElementById('filePicker').files[0];
      if (!f) return alert('Select a file first!');
      const fd = new FormData();
      fd.append('file', f);
      fetch('/upload', { method:'POST', body:fd })
        .then(r => r.json())
        .then(() => { alert(f.name + ' uploaded to phone!'); document.getElementById('uploadModal').style.display = 'none'; })
        .catch(() => alert('Upload failed'));
    }

    window.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) e.target.style.display = 'none';
    });

    connectWS();
  </script>
</body>
</html>`;
}


// ─── startStreamServer ───────────────────────────────────────────────────────

async function startStreamServer(serial, port) {
  logger.info(`[StreamServer] Starting for ${serial} on port ${port}`);

  // Cached rental status (2s TTL when unpaid, 15s when paid)
  let cachedStatus = null;
  let lastCheckTime = 0;

  async function getRentalStatus(forceRefresh = false) {
    const now = Date.now();
    const ttl = (cachedStatus && cachedStatus.isPaid) ? 15000 : 2000;
    if (!forceRefresh && cachedStatus !== null && (now - lastCheckTime) < ttl) return cachedStatus;
    try { cachedStatus = await rentalPaymentService.checkDeviceRentalStatus(serial); }
    catch (err) { if (cachedStatus !== null) return cachedStatus; cachedStatus = { isPaid: false }; }
    lastCheckTime = Date.now();
    return cachedStatus;
  }

  // Start engines
  const captureEngine = new FrameCaptureEngine(serial);
  const scrcpyEngine  = new ScrcpyEngine(serial);

  const scrcpyPort = port + 1000;
  try {
    await scrcpyEngine.start(scrcpyPort);
    logger.info(`[StreamServer] ScrcpyEngine control socket ready for ${serial}`);
  } catch (err) {
    logger.warn(`[StreamServer] ScrcpyEngine failed for ${serial}: ${err.message} — using ADB shell fallback`);
  }

  captureEngine.start();

  // ── HTTP request handler ────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${port}`);
    const p   = url.pathname;

    const isMainPage = (p === '/' || p === '/index.html');
    const status = await getRentalStatus(isMainPage);

    if (!status.isPaid) {
      if (p === '/screen.jpg' || p === '/screen.png' || p === '/control' || p === '/upload') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payment required', isPaid: false }));
        return;
      }
      const checkoutUrl = rentalPaymentService.getPaymentCheckoutUrl(serial);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getStreamBlockedHtml(serial, checkoutUrl, status));
      return;
    }

    // File upload → /sdcard/Download/
    if (p === '/upload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const tmp = path.join(process.cwd(), `upload_${Date.now()}.tmp`);
        fs.writeFileSync(tmp, Buffer.concat(chunks));
        const dest = `/sdcard/Download/media_${Date.now()}.jpg`;
        exec(`"${ADB_BIN}" -s ${serial} push "${tmp}" "${dest}"`, () => {
          try { fs.unlinkSync(tmp); } catch (_) {}
          exec(`"${ADB_BIN}" -s ${serial} shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${dest}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', dest }));
        });
      });
      return;
    }

    // Screen frame (served from capture engine cache; MIME matches latest capture)
    if (p === '/screen.jpg' || p === '/screen.png') {
      const frame = captureEngine.latestFrame;
      const mime  = captureEngine.latestMime || 'image/png';
      if (frame) {
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        res.end(frame);
      } else {
        captureEngine.captureOneFrame().then(f => {
          if (f) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); res.end(f); }
          else   { res.writeHead(500); res.end('Capture error'); }
        });
      }
      return;
    }

    // Control endpoint
    if (p === '/control') {
      const type = url.searchParams.get('type');
      _handleControl(type, url.searchParams, serial, scrcpyEngine);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Main page — serve player
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buildPlayerHtml(serial));
  });

  // ── WebSocket real-time stream ──────────────────────────────────────────
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', async (ws) => {
    const status = await getRentalStatus();
    if (!status.isPaid) {
      try { ws.send(JSON.stringify({ type: 'error', error: 'Payment required' })); ws.close(4002, 'Unpaid'); } catch (_) {}
      return;
    }

    logger.info(`[StreamServer] WS client connected for ${serial}`);
    captureEngine.addClient(ws);

    // Periodic payment re-check every 60s
    const payCheck = setInterval(async () => {
      const s = await getRentalStatus();
      if (!s.isPaid) ws.close(4002, 'Unpaid');
    }, 60000);

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        _handleControl(data.type, data, serial, scrcpyEngine);
      } catch (_) {}
    });

    ws.on('close', () => { captureEngine.removeClient(ws); clearInterval(payCheck); });
    ws.on('error', () => { captureEngine.removeClient(ws); clearInterval(payCheck); });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const localUrl = `http://localhost:${port}`;
      logger.info(`[StreamServer] Listening for ${serial} at ${localUrl}`);

      activeServers.set(serial, { server, wss, captureEngine, scrcpyEngine });

      const streamProcess = {
        pid: port,
        exitCode: null,
        kill() {
          scrcpyEngine.stop();
          captureEngine.stop();
          try { wss.close(); } catch (_) {}
          server.close();
          activeServers.delete(serial);
        },
      };

      resolve({ streamProcess, localUrl });
    });
  });
}

// ─── Shared control dispatcher ────────────────────────────────────────────────
// Handles both WebSocket (data = parsed JSON object) and HTTP (data = URLSearchParams).

function _get(data, key) {
  return typeof data.get === 'function' ? data.get(key) : data[key];
}

function _handleControl(type, data, serial, scrcpyEngine) {
  const W = parseFloat(_get(data, 'width'))  || 1080;
  const H = parseFloat(_get(data, 'height')) || 2400;

  if (type === 'touch') {
    const action = parseInt(_get(data, 'action'), 10);
    const x = parseFloat(_get(data, 'x'));
    const y = parseFloat(_get(data, 'y'));
    const sent = scrcpyEngine.isReady && scrcpyEngine.sendTouchEvent(action, x, y, W, H);
    if (!sent && (action === 0 || action === 1)) {
      sendSubMsInput(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
    }
  } else if (type === 'tap') {
    const x = parseFloat(_get(data, 'x'));
    const y = parseFloat(_get(data, 'y'));
    const sent = scrcpyEngine.isReady && scrcpyEngine.sendTouchEvent(0, x, y, W, H);
    // No artificial delay — send UP immediately after DOWN
    if (sent) {
      scrcpyEngine.sendTouchEvent(1, x, y, W, H);
    } else {
      sendSubMsInput(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
    }
  } else if (type === 'swipe') {
    const x1 = parseFloat(_get(data, 'x1')), y1 = parseFloat(_get(data, 'y1'));
    const x2 = parseFloat(_get(data, 'x2')), y2 = parseFloat(_get(data, 'y2'));
    const dur = parseInt(_get(data, 'duration'), 10) || 100;
    const sent = scrcpyEngine.isReady && scrcpyEngine.sendTouchEvent(0, x1, y1, W, H);
    if (sent) {
      scrcpyEngine.sendTouchEvent(2, x2, y2, W, H);
      scrcpyEngine.sendTouchEvent(1, x2, y2, W, H);
    } else {
      sendSubMsInput(serial, `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${dur}`);
    }
  } else if (type === 'code' || type === 'key') {
    const code = parseInt(_get(data, 'code'), 10);
    const sent = scrcpyEngine.isReady && scrcpyEngine.sendKeycode(0, code);
    // Send UP immediately — no setTimeout
    if (sent) {
      scrcpyEngine.sendKeycode(1, code);
    } else {
      sendSubMsInput(serial, `input keyevent ${code}`);
    }
  } else if (type === 'text') {
    const text = _get(data, 'text') || '';
    const sent = scrcpyEngine.isReady && scrcpyEngine.sendText(text);
    if (!sent) {
      sendSubMsInput(serial, `input text "${text.replace(/"/g, '\\"')}"`);
    }
  } else if (type === 'reboot') {
    exec(`"${ADB_BIN}" -s ${serial} reboot`);
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

function buildStreamUrl(tunnelDomain, port, serial) {
  const domain = tunnelDomain.replace(/^https?:\/\//, '');
  return `https://${domain}/?action=proxy&remote=tcp%3A127.0.0.1%3A${port}&udid=${encodeURIComponent(serial)}`;
}

function killStreamServer(streamProcess) {
  if (streamProcess && typeof streamProcess.kill === 'function') {
    try { streamProcess.kill(); } catch (_) {}
  }
}

module.exports = { startStreamServer, buildStreamUrl, killStreamServer };
