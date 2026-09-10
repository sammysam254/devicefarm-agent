'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn, exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const ScrcpyEngine = require('./scrcpy-engine');
const bindingService = require('./binding-service');
const licenseService = require('./license-service');

// ─── Config & ADB ────────────────────────────────────────────────────────────

function loadConfig() {
  for (const p of [path.join(process.cwd(), 'config.json'), path.join(__dirname, '..', '..', 'config.json')]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return {};
}
const config = loadConfig();

function resolveAdbBin() {
  if (config.adbPath && fs.existsSync(config.adbPath)) return config.adbPath;
  const b = path.join(__dirname, '../../assets/bin/adb.exe');
  if (fs.existsSync(b)) return b;
  if (fs.existsSync('C:\\platform-tools\\adb.exe')) return 'C:\\platform-tools\\adb.exe';
  return 'adb';
}
const ADB_BIN = resolveAdbBin();

const activeServers = new Map();

// ─── Persistent ADB input shell (fallback when scrcpy not ready) ─────────────

const inputShells = new Map();
function getInputShell(serial) {
  const ex = inputShells.get(serial);
  if (ex && ex.stdin && !ex.stdin.destroyed) return ex;
  const p = spawn(ADB_BIN, ['-s', serial, 'shell'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  if (p.stdin) try { p.stdin.setNoDelay(true); } catch (_) {}
  p.on('error', () => inputShells.delete(serial));
  p.on('close', () => inputShells.delete(serial));
  inputShells.set(serial, p);
  return p;
}
function adbInput(serial, cmd) {
  try { getInputShell(serial).stdin.write(cmd + '\n'); }
  catch (_) { exec(`"${ADB_BIN}" -s ${serial} shell ${cmd}`); }
}

// ─── Stream Blocked HTML (Admin Blocked View) ───────────────────────────────

function getDeviceStreamBlockedHtml(serial, reason = 'This device stream has been temporarily suspended or blocked by an Administrator.') {
  const cleanReason = (reason && String(reason).trim()) || 'This device stream has been temporarily suspended or blocked by an Administrator.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stream Currently Blocked - ${serial}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body {
      background: #060911;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      position: relative;
      overflow: hidden;
    }
    .glow-bg {
      position: absolute;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(239, 68, 68, 0.15) 0%, rgba(239, 68, 68, 0) 70%);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      filter: blur(40px);
    }
    .card {
      position: relative;
      z-index: 10;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 24px;
      padding: 44px 36px;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 30px rgba(239, 68, 68, 0.15);
      backdrop-filter: blur(16px);
      animation: fadeIn 0.4s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(16px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .icon-box {
      width: 88px;
      height: 88px;
      border-radius: 50%;
      background: rgba(239, 68, 68, 0.12);
      border: 2px solid rgba(239, 68, 68, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
      box-shadow: 0 0 25px rgba(239, 68, 68, 0.25);
    }
    .icon {
      font-size: 44px;
      line-height: 1;
      filter: drop-shadow(0 0 8px rgba(239, 68, 68, 0.6));
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #f87171;
      padding: 4px 14px;
      border-radius: 100px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
      text-transform: uppercase;
    }
    .dot {
      width: 6px;
      height: 6px;
      background: #ef4444;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    h1 {
      font-size: 24px;
      font-weight: 800;
      color: #f8fafc;
      letter-spacing: -0.3px;
      margin-bottom: 12px;
    }
    .desc {
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .device-info {
      background: rgba(2, 6, 23, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 13px;
      color: #cbd5e1;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .device-serial {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-weight: 700;
      color: #38bdf8;
    }
    .btn-refresh {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #ef4444, #b91c1c);
      color: #ffffff;
      font-weight: 700;
      font-size: 14px;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(239, 68, 68, 0.35);
      transition: all 0.2s ease;
    }
    .btn-refresh:hover {
      background: linear-gradient(135deg, #dc2626, #991b1b);
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(239, 68, 68, 0.45);
    }
    .btn-refresh:active {
      transform: translateY(1px);
    }
    .footer-text {
      margin-top: 16px;
      font-size: 12px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="glow-bg"></div>
  <div class="card">
    <div class="icon-box">
      <div class="icon">⛔</div>
    </div>
    <div class="badge">
      <span class="dot"></span> Stream Blocked
    </div>
    <h1>Stream is Currently Blocked</h1>
    <p class="desc">${cleanReason}</p>
    <div class="device-info">
      <span>Device UDID</span>
      <span class="device-serial">${serial}</span>
    </div>
    <button class="btn-refresh" onclick="location.reload()">
      🔄 Check Stream Status
    </button>
    <div class="footer-text">
      Please contact your Administrator or Seed Owner to unblock access.
    </div>
  </div>
</body>
</html>`;
}

function getExpiredLinkHtml(serial) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stream Link Expired - ${serial}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background:#060911; color:#f8fafc; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; text-align:center; }
    .card { background:#0f172a; border:1px solid rgba(239,68,68,0.4); border-radius:24px; padding:40px 32px; max-width:480px; width:100%; box-shadow:0 25px 50px rgba(0,0,0,0.7); }
    .icon { font-size:44px; margin-bottom:16px; }
    h2 { font-size:22px; font-weight:800; margin-bottom:12px; color:#f87171; }
    p { color:#94a3b8; font-size:14px; line-height:1.6; margin-bottom:18px; }
    .udid { font-family:monospace; background:rgba(255,255,255,0.06); padding:8px 14px; border-radius:10px; color:#38bdf8; font-size:13px; font-weight:700; margin-bottom:20px; display:inline-block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h2>Stream Link Expired</h2>
    <p>This stream link is no longer valid. An Administrator has generated a clean new access link for this device upon unblocking.</p>
    <div class="udid">Device UDID: ${serial}</div>
    <p style="font-size:13px; color:#cbd5e1;">Please open your account dashboard and click <b>Open Device Stream</b> to access the current live link.</p>
  </div>
</body>
</html>`;
}

// ─── Payment-blocked HTML ────────────────────────────────────────────────────

function getStreamBlockedHtml(serial, checkoutUrl, s = {}) {
  const fee = s.monthlyFee || 30;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Stream Blocked</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#060911;color:#f8fafc;font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#0f172a;border:1px solid rgba(239,68,68,.45);border-radius:24px;padding:40px 32px;max-width:520px;width:100%;text-align:center}.price{font-size:46px;font-weight:800;color:#38bdf8;margin:12px 0 4px}.btn{display:block;width:100%;padding:15px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;text-decoration:none;font-weight:700;border-radius:14px;font-size:15px;border:none;cursor:pointer;margin-top:16px}</style>
</head><body><div class="card">
<div style="font-size:28px;margin-bottom:12px">🔒</div>
<h2>Monthly Rental Payment Required</h2>
<div class="price">$${fee}.00 USD</div>
<p style="color:#94a3b8;margin:8px 0 16px">Device: <code>${serial}</code></p>
<a href="${checkoutUrl}" target="_blank" class="btn">💳 Pay to Unlock Stream</a>
<button onclick="location.reload()" class="btn" style="background:rgba(255,255,255,.08);color:#94a3b8;margin-top:8px">🔄 Refresh</button>
</div></body></html>`;
}

// ─── Active WebSocket Client Tracking ────────────────────────────────────────
const activeWsClients = new Map(); // Map<serial, Set<WebSocket>>

function disconnectBlockedStream(serial, reason = 'This device stream has been suspended or blocked by an Administrator.') {
  const clients = activeWsClients.get(serial);
  if (clients && clients.size > 0) {
    const payload = JSON.stringify({
      type: 'stream_blocked',
      reason: reason,
      serial: serial,
      timestamp: new Date().toISOString(),
    });
    for (const ws of Array.from(clients)) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
          ws.close(4003, 'Stream Blocked');
        }
      } catch (_) {}
    }
    clients.clear();
    logger.info(`[StreamServer] Disconnected all active WebSocket viewers for blocked device ${serial}`);
  }
}

// ─── Screencap fallback (one-shot, for /screen.jpg HTTP endpoint) ────────────

function captureOneFrame(serial) {
  return new Promise((resolve) => {
    const p = spawn(ADB_BIN, ['-s', serial, 'exec-out', 'screencap -p'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('close', code => {
      if (code !== 0 || !chunks.length) return resolve(null);
      resolve(Buffer.concat(chunks));
    });
    p.on('error', () => resolve(null));
  });
}

// ─── Shared control dispatcher (Raw, Direct, Zero-Delay) ──────────────────────

function get(data, key) {
  return typeof data.get === 'function' ? data.get(key) : data[key];
}

function handleControl(type, data, serial, engine, ws = null) {
  const W = parseFloat(get(data, 'width'))  || engine.screenWidth  || 720;
  const H = parseFloat(get(data, 'height')) || engine.screenHeight || 1600;

  if (type === 'touch') {
    const action = parseInt(get(data, 'action'), 10);
    const x = parseFloat(get(data, 'x'));
    const y = parseFloat(get(data, 'y'));
    const pressure = parseFloat(get(data, 'pressure')) || (action === 1 ? 0 : 1.0);
    const pointerId = get(data, 'pointerId') || 0;
    const ok = engine.sendTouchEvent(action, x, y, W, H, pressure, pointerId);
    if (!ok && (action === 0 || action === 1)) {
      const realX = Math.round((x / W) * (engine.screenWidth || W));
      const realY = Math.round((y / H) * (engine.screenHeight || H));
      if (action === 0) try { getInputShell(serial).stdin.write(`input tap ${realX} ${realY}\n`); } catch (_) {}
    }
  } else if (type === 'scroll') {
    const x = parseFloat(get(data, 'x'));
    const y = parseFloat(get(data, 'y'));
    const hscroll = parseFloat(get(data, 'hscroll')) || 0;
    const vscroll = parseFloat(get(data, 'vscroll')) || 0;
    engine.sendScrollEvent(x, y, W, H, hscroll, vscroll);
  } else if (type === 'tap') {
    const x = parseFloat(get(data, 'x')), y = parseFloat(get(data, 'y'));
    engine.sendTouchEvent(0, x, y, W, H, 1.0);
    setTimeout(() => engine.sendTouchEvent(1, x, y, W, H, 0), 40);
  } else if (type === 'swipe') {
    const x1 = parseFloat(get(data, 'x1')), y1 = parseFloat(get(data, 'y1'));
    const x2 = parseFloat(get(data, 'x2')), y2 = parseFloat(get(data, 'y2'));
    const dur = parseInt(get(data, 'duration'), 10) || 120;
    engine.sendTouchEvent(0, x1, y1, W, H, 1.0);
    const steps = 12;
    const dt = dur / steps;
    for (let i = 1; i <= steps; i++) {
      setTimeout(() => {
        // Cubic ease-out gives natural momentum to Android's gesture and fling physics
        const t = i / steps;
        const p = 1 - Math.pow(1 - t, 3);
        const cx = x1 + (x2 - x1) * p;
        const cy = y1 + (y2 - y1) * p;
        const act = (i === steps) ? 1 : 2;
        engine.sendTouchEvent(act, cx, cy, W, H, act === 1 ? 0 : 1.0);
      }, Math.round(i * dt));
    }
  } else if (type === 'code' || type === 'key') {
    const code = parseInt(get(data, 'code'), 10);
    engine.sendKeycode(0, code);
    setTimeout(() => engine.sendKeycode(1, code), 30);
  } else if (type === 'text') {
    const text = get(data, 'text') || '';
    engine.sendText(text);
  } else if (type === 'reboot') {
    exec(`"${ADB_BIN}" -s ${serial} reboot`);
  } else if (type === 'expand_notifications' || type === 'notifications') {
    exec(`"${ADB_BIN}" -s ${serial} shell cmd statusbar expand`);
  } else if (type === 'wake' || type === 'refresh' || type === 'request_keyframe') {
    if (ws && (engine._keyframeBuffer || engine._configPacket)) {
      try { ws.send(engine._keyframeBuffer || engine._configPacket, { binary: true }); } catch (_) {}
    }
    try { adbInput(serial, 'input keyevent 0'); } catch (_) {}
  }
}



// ─── Player HTML (WebCodecs H264 decoder + screencap fallback) ───────────────

function buildPlayerHtml(serial, screenW, screenH) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Stream ${serial}</title>
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;width:100%;background:#020617;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow:hidden;display:flex;flex-direction:column}
    body{user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
    
    /* Top Header Bar */
    .header{display:flex;align-items:center;justify-content:space-between;width:100%;height:44px;padding:0 12px;background:rgba(15,23,42,.98);border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;z-index:20}
    .hdr-left{display:flex;align-items:center;gap:10px}
    .hdr-title{font-weight:700;font-size:14px;color:#f8fafc;letter-spacing:.3px}
    .hdr-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#f8fafc;border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;transition:all .15s ease}
    .hdr-btn:hover{background:rgba(56,189,248,.25);border-color:rgba(56,189,248,.5);color:#38bdf8}
    .hdr-btn:active{transform:scale(.92)}

    .badge{background:rgba(56,189,248,.15);color:#38bdf8;border:1px solid rgba(56,189,248,.3);padding:3px 10px;border-radius:100px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:5px}
    .dot{width:6px;height:6px;background:#38bdf8;border-radius:50%;animation:pulse 1s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

    /* Stage - Fit to Screen for desktop & mobile */
    .stage{flex:1;display:flex;flex-direction:row !important;align-items:center;justify-content:center;gap:12px;width:100%;height:calc(100vh - 44px);min-height:0;padding:8px 12px;box-sizing:border-box;position:relative}
    .wrap{position:relative;background:#000;border-radius:20px;border:2px solid rgba(56,189,248,.4);box-shadow:0 0 35px rgba(56,189,248,.2),0 20px 40px rgba(0,0,0,.8);overflow:hidden;touch-action:none;display:flex;align-items:center;justify-content:center;height:100%;max-height:calc(100vh - 58px);max-width:calc(100vw - 75px);width:auto;aspect-ratio:9/19.5;flex-shrink:1}
    canvas{display:block;width:100%;height:100%;object-fit:contain;cursor:pointer;touch-action:none;-webkit-tap-highlight-color:transparent}

    /* Sidebar ALWAYS on the right side */
    .sidebar{display:flex !important;flex-direction:column;align-items:center;gap:5px;background:rgba(15,23,42,.95);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:8px 6px;max-height:calc(100vh - 58px);overflow-y:auto;flex-shrink:0;box-shadow:0 10px 30px rgba(0,0,0,.6);z-index:20}
    .btn{width:36px;height:36px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:#f1f5f9;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;transition:all .15s ease;user-select:none}
    .btn:hover{background:rgba(56,189,248,.25);border-color:rgba(56,189,248,.5);color:#38bdf8}
    .btn:active{transform:scale(.88)}
    .btn-red{background:rgba(248,113,113,.12);color:#f87171;border-color:rgba(248,113,113,.3)}
    .btn-red:hover{background:rgba(248,113,113,.3);border-color:rgba(248,113,113,.6);color:#ef4444}
    
    .vol-slider-box{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px 0 2px;width:100%}
    .volume-slider-v{-webkit-appearance:slider-vertical;appearance:slider-vertical;writing-mode:bt-lr;width:6px;height:70px;background:rgba(255,255,255,.15);border-radius:4px;outline:none;cursor:pointer;accent-color:#22c55e}

    .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:30;align-items:center;justify-content:center}
    .mbox{background:#0f172a;border:1px solid rgba(56,189,248,.4);border-radius:14px;padding:18px;width:90%;max-width:380px;box-shadow:0 20px 30px rgba(0,0,0,.6)}
    .minput{width:100%;padding:9px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:9px;color:#fff;font-size:14px;margin-bottom:12px;outline:none}
    .mbtn{width:100%;padding:9px;background:#38bdf8;color:#0f172a;border:none;border-radius:9px;font-weight:700;cursor:pointer}

    @media (max-width: 580px){
      .stage{padding:4px;gap:6px}
      .wrap{max-height:calc(100vh - 52px);max-width:calc(100vw - 56px)}
      .sidebar{padding:5px 3px;gap:3px;border-radius:12px}
      .btn{width:32px;height:32px;font-size:13px;border-radius:8px}
    }
  </style>
</head>
<body>

<!-- Header Bar -->
<div class="header">
  <div class="hdr-left">
    <button tabindex="-1" onfocus="this.blur()" class="hdr-btn" onclick="if(history.length>1)history.back();else window.close()" title="Back">&#x2190;</button>
    <div class="hdr-title" id="hdrTitle">Stream ${serial}</div>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <button tabindex="-1" onfocus="this.blur()" class="hdr-btn" onclick="reconnectStream()" title="Refresh Stream">&#x21BB;</button>
    <button tabindex="-1" onfocus="this.blur()" class="hdr-btn" onclick="toggleDebugModal()" title="Stream Diagnostics">&#128030;</button>
    <button tabindex="-1" onfocus="this.blur()" class="hdr-btn" onclick="popOutWindow()" title="Pop Out Chrome Window">&#x2197;</button>
    <div class="badge" id="badge"><span class="dot"></span><span id="modeText">CONNECTING</span></div>
    <span style="font-size:10px;color:#64748b;font-family:monospace" id="fps">--fps</span>
  </div>
</div>

<div class="stage">
  <div class="wrap" id="wrap">
    <canvas id="c" width="${screenW}" height="${screenH}"></canvas>
  </div>

  <!-- Sleek Dark Control Sidebar (Right Side) -->
  <div class="sidebar">
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="expandNotifications()" title="Notification Bar (Swipe Down)">&#8942;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn btn-red" onclick="key(26)" title="Power">&#9211;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn btn-red" onclick="reboot()" title="Reboot Device">&#128260;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn btn-red" onclick="rotateScreen()" title="Rotate Screen">&#x21BB;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(24)" title="Volume Up">&#128265;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(25)" title="Volume Down">&#128264;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(4)" title="Back">&#x25C0;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(3)" title="Home">&#9711;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="key(187)" title="Recents">&#9633;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="screenshot()" title="Screenshot">&#128247;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="openText()" title="Send Text / Keyboard">&#9000;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" onclick="openUpload()" title="Upload File / APK">&#128228;</button>
    <button tabindex="-1" onfocus="this.blur()" class="btn" id="muteBtn" onclick="toggleMute()" title="Mute/Unmute Audio">&#128266;</button>
    
    <!-- Vertical Green Volume Slider -->
    <div class="vol-slider-box" title="Volume Slider">
      <input tabindex="-1" onfocus="this.blur()" type="range" min="0" max="100" value="100" class="volume-slider-v" id="volSlider" oninput="setVolume(this.value)"/>
    </div>
  </div>
</div>

<div class="modal" id="textModal">
  <div class="mbox">
    <div style="font-weight:700;margin-bottom:10px">Send Text</div>
    <input class="minput" id="textVal" placeholder="Type here..." onkeydown="if(event.key==='Enter')doText()"/>
    <button class="mbtn" onclick="doText()">Send</button>
  </div>
</div>
<div class="modal" id="uploadModal">
  <div class="mbox">
    <div style="font-weight:700;margin-bottom:10px">Upload to Phone</div>
    <input class="minput" type="file" id="filePick" accept="image/*,video/*"/>
    <button class="mbtn" onclick="doUpload()">Upload</button>
  </div>
</div>

<div class="modal" id="debugModal">
  <div class="mbox">
    <div style="font-weight:700;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
      <span>🐞 Stream Diagnostics</span>
      <button onclick="document.getElementById('debugModal').style.display='none'" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer">&times;</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:#94a3b8">
      <div>Device Serial: <strong style="color:#fff">${serial}</strong></div>
      <div>Stream Resolution: <strong style="color:#38bdf8" id="dbgRes">--</strong></div>
      <div>Decoder Engine: <strong style="color:#34d399" id="dbgCodec">--</strong></div>
      <div>WebSocket State: <strong style="color:#c084fc" id="dbgWs">--</strong></div>
    </div>
  </div>
</div>

<!-- Stream Blocked Fullscreen Overlay -->
<div id="streamBlockedOverlay" style="display:none;position:fixed;inset:0;background:rgba(6,9,17,0.97);backdrop-filter:blur(16px);z-index:9999;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;">
  <div style="background:#0f172a;border:1px solid rgba(239,68,68,0.45);border-radius:24px;padding:40px 32px;max-width:480px;width:100%;box-shadow:0 0 50px rgba(239,68,68,0.25);">
    <div style="width:76px;height:76px;border-radius:50%;background:rgba(239,68,68,0.15);border:2px solid rgba(239,68,68,0.4);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:38px;">
      ⛔
    </div>
    <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.35);color:#f87171;padding:4px 14px;border-radius:100px;font-size:11px;font-weight:800;letter-spacing:0.5px;margin-bottom:14px;text-transform:uppercase;">
      <span style="width:6px;height:6px;background:#ef4444;border-radius:50%;"></span> ACCESS RESTRICTED
    </div>
    <h2 style="font-size:22px;font-weight:800;color:#f8fafc;margin-bottom:8px;">Stream Currently Blocked</h2>
    <p id="blockReasonText" style="color:#94a3b8;font-size:14px;line-height:1.6;margin-bottom:20px;">
      This device stream has been temporarily suspended or blocked by an Administrator.
    </p>
    <div style="background:rgba(2,6,23,0.6);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 14px;font-size:12px;color:#cbd5e1;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;">
      <span>Device UDID:</span>
      <span style="font-family:monospace;font-weight:700;color:#38bdf8;">${serial}</span>
    </div>
    <button onclick="location.reload()" style="width:100%;padding:13px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;border:none;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;box-shadow:0 4px 12px rgba(239,68,68,0.3);">
      🔄 Check Stream Status
    </button>
  </div>
</div>

<script>
  let isStreamBlocked = false;
  function showBlockedScreen(reason) {
    isStreamBlocked = true;
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    if (firstFrameTimer) { clearTimeout(firstFrameTimer); firstFrameTimer = null; }
    try { resetDecoder(); } catch(_) {}
    try { if (audioCtx) audioCtx.close(); } catch(_) {}
    
    const blockOverlay = document.getElementById('streamBlockedOverlay');
    const blockReasonEl = document.getElementById('blockReasonText');
    const badge = document.getElementById('badge');
    const modeText = document.getElementById('modeText');
    
    if (blockReasonEl && reason) blockReasonEl.textContent = reason;
    if (blockOverlay) blockOverlay.style.display = 'flex';
    if (badge) {
      badge.style.background = 'rgba(239,68,68,0.2)';
      badge.style.borderColor = 'rgba(239,68,68,0.5)';
      badge.style.color = '#f87171';
    }
    if (modeText) modeText.textContent = 'BLOCKED';
    
    const canvas = document.getElementById('c');
    if (canvas) canvas.style.pointerEvents = 'none';
  }

  const canvas = document.getElementById('c');
  const ctx    = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const wrap   = document.getElementById('wrap');
  const badge  = document.getElementById('badge');
  const modeText = document.getElementById('modeText');
  const fpsEl  = document.getElementById('fps');

  let nativeW = ${screenW}, nativeH = ${screenH};

  // ── FPS counter ─────────────────────────────────────────────────────────
  let fc = 0, fpsT = performance.now();
  function countFrame() {
    fc++;
    const now = performance.now();
    if (now - fpsT >= 1000) { fpsEl.textContent = fc + 'fps'; fc = 0; fpsT = now; }
  }

  // ── rAF draw queue ───────────────────────────────────────────────────────
  let pendingFrame = null, rafId = null;
  function queueDraw(bitmapOrImage) {
    if (pendingFrame && pendingFrame.close) pendingFrame.close();
    pendingFrame = bitmapOrImage;
    if (!rafId) rafId = requestAnimationFrame(doDraw);
  }
  function doDraw() {
    rafId = null;
    if (!pendingFrame) return;
    const f = pendingFrame; pendingFrame = null;
    const w = f.displayWidth  || f.codedWidth  || f.width;
    const h = f.displayHeight || f.codedHeight || f.height;
    if (w && h && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w; canvas.height = h; nativeW = w; nativeH = h;
      wrap.style.aspectRatio = w + ' / ' + h;
      console.log('[Canvas] Resized to ' + w + 'x' + h);
    }
    ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
    if (f.close) f.close();
    countFrame();
  }

  // ── Audio — WebCodecs AudioDecoder (Opus) with raw PCM fallback ────────────
  let audioCtx = null;
  let audioDecoder = null;
  let audioDecoderReady = false;
  let audioNextPlayTime = 0;
  const urlParams = new URLSearchParams(window.location.search);
  let isMuted = urlParams.get('muted') === '1' || urlParams.get('muted') === 'true';
  let gainNode = null;

  function initAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function() {});
      return;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
      gainNode = audioCtx.createGain();
      gainNode.gain.value = isMuted ? 0 : 1;
      gainNode.connect(audioCtx.destination);
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function() {});
    } catch (_) {}
  }

  function initOpusDecoder() {
    if (audioDecoderReady) return true;
    if (typeof AudioDecoder === 'undefined') return false;
    try {
      let layoutDetected = false;
      let isPlanar = false;

      audioDecoder = new AudioDecoder({
        output: function(audioData) {
          if (!audioCtx || !gainNode) { audioData.close(); return; }
          try {
            const nCh     = audioData.numberOfChannels;
            const nFrames = audioData.numberOfFrames;
            const sr      = audioData.sampleRate;

            // Detect planar vs interleaved once and cache it
            if (!layoutDetected) {
              if (nCh > 1) {
                try { audioData.allocationSize({ planeIndex: 1, format: 'f32-planar' }); isPlanar = true; }
                catch (_) { isPlanar = false; }
              } else {
                isPlanar = true;
              }
              layoutDetected = true;
            }

            const webAudioBuf = audioCtx.createBuffer(nCh, nFrames, sr);

            if (isPlanar) {
              for (let ch = 0; ch < nCh; ch++) {
                const byteLen = audioData.allocationSize({ planeIndex: ch, format: 'f32-planar' });
                const plane   = new Float32Array(byteLen / 4);
                audioData.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
                webAudioBuf.copyToChannel(plane, ch);
              }
            } else {
              const byteLen    = audioData.allocationSize({ planeIndex: 0, format: 'f32' });
              const interleaved = new Float32Array(byteLen / 4);
              audioData.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
              for (let ch = 0; ch < nCh; ch++) {
                const chData = webAudioBuf.getChannelData(ch);
                for (let i = 0; i < nFrames; i++) chData[i] = interleaved[i * nCh + ch];
              }
            }

            audioData.close();

            const src = audioCtx.createBufferSource();
            src.buffer = webAudioBuf;
            src.connect(gainNode);

            const now = audioCtx.currentTime;
            if (audioNextPlayTime < now) audioNextPlayTime = now;
            src.start(audioNextPlayTime);
            audioNextPlayTime += webAudioBuf.duration;
          } catch (err) {
            console.warn('[Audio] output error:', err);
            try { audioData.close(); } catch (_) {}
          }
        },
        error: function(err) {
          console.warn('[Audio] AudioDecoder error:', err);
          audioDecoderReady = false;
          audioDecoder = null;
          layoutDetected = false;
        }
      });
      audioDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      audioDecoderReady = true;
      return true;
    } catch (err) {
      console.warn('[Audio] AudioDecoder init failed:', err);
      return false;
    }
  }

  function playOpusPacket(bytes) {
    if (isMuted) return;
    if (!audioCtx) initAudio();
    if (!audioCtx || audioCtx.state !== 'running') return;
    if (!audioDecoderReady) {
      if (!initOpusDecoder()) return;
    }
    if (!audioDecoder || audioDecoder.state === 'closed') { audioDecoderReady = false; return; }
    try {
      audioDecoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: performance.now() * 1000,
        data: bytes
      }));
    } catch (err) {
      console.warn('[Audio] Opus decode error:', err);
      audioDecoderReady = false;
      audioDecoder = null;
    }
  }

  function playRawPcm(bytes) {
    // Fallback: raw signed 16-bit LE stereo 48kHz PCM
    initAudio();
    if (!audioCtx || !gainNode || isMuted) return;
    if (audioCtx.state !== 'running') return;
    try {
      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const sampleCount = Math.floor(int16.length / 2);
      if (sampleCount <= 0) return;
      const buf = audioCtx.createBuffer(2, sampleCount, 48000);
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < sampleCount; i++) {
        L[i] = int16[i * 2]     / 32768.0;
        R[i] = int16[i * 2 + 1] / 32768.0;
      }
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(gainNode);
      const now = audioCtx.currentTime;
      if (audioNextPlayTime < now) audioNextPlayTime = now;
      if (audioNextPlayTime > now + 0.12) audioNextPlayTime = now;
      src.start(audioNextPlayTime);
      audioNextPlayTime += buf.duration;
    } catch (_) {}
  }

  // ── Mute toggle ──────────────────────────────────────────────────────────
  function toggleMute() {
    isMuted = !isMuted;
    if (gainNode) gainNode.gain.value = isMuted ? 0 : 1;
    if (isMuted && audioDecoder && audioDecoder.state !== 'closed') {
      try { audioDecoder.flush().catch(function(){}); } catch (_) {}
    }
    // Sync desktop sidebar mute button
    const btn = document.getElementById('muteBtn');
    if (btn) {
      btn.textContent = isMuted ? '🔇' : '🔊';
      btn.title = isMuted ? 'Unmute audio' : 'Mute audio';
      btn.style.color = isMuted ? '#f87171' : '';
      btn.style.borderColor = isMuted ? 'rgba(248,113,113,.5)' : '';
    }
    // Sync mobile bottom bar mute button
    const iconM = document.getElementById('muteBtnMIcon');
    const btnM  = document.getElementById('muteBtnM');
    if (iconM) iconM.textContent = isMuted ? '🔇' : '🔊';
    if (btnM)  {
      btnM.style.color = isMuted ? '#f87171' : '';
      btnM.style.borderColor = isMuted ? 'rgba(248,113,113,.5)' : '';
    }
  }

  // Resume AudioContext on first user gesture
  ['click', 'mousedown', 'pointerdown', 'touchstart', 'keydown'].forEach(function(evt) {
    window.addEventListener(evt, initAudio, { passive: true });
  });

  // ── WebCodecs H264 Decoder ───────────────────────────────────────────────
  let decoder = null;
  let decoderReady = false;
  let hasKeyframe = false;
  let cachedSpsPps = null;

  function resetDecoder() {
    hasKeyframe = false;
    if (decoder) {
      try { decoder.close(); } catch (_) {}
      decoder = null;
    }
    decoderReady = false;
  }

  function initDecoder() {
    resetDecoder();
    if (typeof VideoDecoder === 'undefined') {
      console.warn('[Stream] WebCodecs VideoDecoder not available in this browser');
      return false;
    }
    try {
      decoder = new VideoDecoder({
        output: function(frame) {
          lastFrameReceivedTime = Date.now();
          const w = frame.displayWidth  || frame.codedWidth  || frame.width;
          const h = frame.displayHeight || frame.codedHeight || frame.height;
          if (w && h && (canvas.width !== w || canvas.height !== h)) {
            canvas.width = w; canvas.height = h; nativeW = w; nativeH = h;
            wrap.style.aspectRatio = w + ' / ' + h;
          }
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          frame.close();
          countFrame();
          if (modeText && modeText.textContent !== 'LIVE') {
            modeText.textContent = 'LIVE';
            if (badge) {
              badge.style.background = 'rgba(56,189,248,.15)';
              badge.style.borderColor = 'rgba(56,189,248,.3)';
              badge.style.color = '#38bdf8';
            }
          }
        },
        error: function(err) {
          console.error('[Stream] VideoDecoder error:', err);
          resetDecoder();
          setTimeout(function() {
            if (!decoderReady) {
              initDecoder();
              send({ type: 'request_keyframe' });
            }
          }, 10);
        }
      });
      decoder.configure({
        codec: 'avc1.42E01E',
        optimizeForLatency: true,
        hardwareAcceleration: 'no-preference'
      });
      decoderReady = true;
      return true;
    } catch (err) {
      console.error('[Stream] Failed to init VideoDecoder:', err);
      return false;
    }
  }

  function parseH264(u8) {
    let hasIdr = false, hasSps = false, hasPps = false, hasSlice = false;
    for (let i = 0; i < Math.min(u8.length - 4, 1024); i++) {
      if (u8[i] === 0 && u8[i+1] === 0) {
        let ntype = -1;
        if (u8[i+2] === 1 && i + 3 < u8.length) {
          ntype = u8[i+3] & 0x1f;
        } else if (u8[i+2] === 0 && u8[i+3] === 1 && i + 4 < u8.length) {
          ntype = u8[i+4] & 0x1f;
        }
        if (ntype === 5) { hasIdr = true; hasSlice = true; }
        else if (ntype === 7) hasSps = true;
        else if (ntype === 8) hasPps = true;
        else if (ntype === 1) hasSlice = true;
      }
    }
    return { hasIdr, hasSps, hasPps, hasSlice };
  }

  // ── WebSocket connection ─────────────────────────────────────────────────
  let ws = null, wsOk = false;
  let wsRetryTimer = null;
  let wsFailCount = 0;
  let lastFrameReceivedTime = 0;

  function connectWS() {
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch (_) {}
      ws = null;
    }
    hasKeyframe = false; // Reset so decoder waits for fresh SPS/PPS from new connection
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws' + location.search);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      wsOk = true;
      wsFailCount = 0; // Reset fail counter on successful connection
      lastFrameReceivedTime = Date.now();
      modeText.textContent = 'LIVE';
      if (!decoderReady || !decoder || decoder.state === 'closed') {
        initDecoder();
      }
      audioNextPlayTime = 0;
      fbRunning = false;
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function(){});
      flushQueue();
      // Nudge Android encoder to send initial keyframe immediately
      send({ type: 'wake' });
      setTimeout(function() {
        if (!hasKeyframe && ws && ws.readyState === 1) {
          send({ type: 'request_keyframe' });
        }
      }, 1000);
    };

    ws.onmessage = function(e) {
      // JSON control messages (stream_blocked, stream_reset, etc.)
      if (typeof e.data === 'string' || e.data instanceof ArrayBuffer && e.data.byteLength > 0 && new Uint8Array(e.data)[0] === 0x7B) {
        try {
          const txt = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
          const msg = JSON.parse(txt);
          if (msg.type === 'stream_blocked') {
            console.log('[Stream] Received stream_blocked signal from server');
            showBlockedScreen(msg.reason);
            return;
          }
          if (msg.type === 'stream_reset') {
            console.log('[Stream] Server stream reset — reinitialising decoder');
            resetDecoder();
            fbRunning = false;
            lastFrameReceivedTime = 0;
          }
          return;
        } catch (_) {}
      }

      if (isStreamBlocked) return;
      if (!(e.data instanceof ArrayBuffer)) return;
      lastFrameReceivedTime = Date.now();
      if (fbRunning) { fbRunning = false; modeText.textContent = 'LIVE'; }

      const rawU8 = new Uint8Array(e.data);
      if (rawU8.length < 4) return;

      // Handle tagged Audio binary frames — [0x41]['O'=opus / 'R'=raw][...payload]
      if (rawU8[0] === 0x41) {
        if (rawU8.length < 3) return;
        const codec = rawU8[1]; // 0x4F='O' opus, 0x52='R' raw
        const payload = rawU8.subarray(2);
        if (codec === 0x4F) {       // Opus
          playOpusPacket(payload);
        } else {                    // Raw PCM fallback
          playRawPcm(payload);
        }
        return;
      }

      let u8 = (rawU8[0] === 0x56) ? rawU8.subarray(1) : rawU8;

      // 1. PNG Image Auto-detection (0x89 0x50 0x4E 0x47)
      if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
        createImageBitmap(new Blob([u8], { type: 'image/png' }))
          .then(function(bmp) { queueDraw(bmp); })
          .catch(function(err) { console.warn('[Stream] PNG decode error:', err); });
        return;
      }

      // 2. JPEG Image Auto-detection (0xFF 0xD8)
      if (u8[0] === 0xFF && u8[1] === 0xD8) {
        createImageBitmap(new Blob([u8], { type: 'image/jpeg' }))
          .then(function(bmp) { queueDraw(bmp); })
          .catch(function(err) { console.warn('[Stream] JPEG decode error:', err); });
        return;
      }

      // 3. Raw H264 NAL stream via WebCodecs
      if (!decoderReady || !decoder || decoder.state === 'closed') {
        if (!initDecoder()) return;
      }

      const info = parseH264(u8);
      if (info.hasSps || info.hasPps) {
        cachedSpsPps = u8;
      }

      // If packet contains only parameter sets (SPS/PPS) without slice data, save config and wait for slice
      if (!info.hasSlice && (info.hasSps || info.hasPps)) {
        return;
      }

      let isKey = info.hasIdr;
      if (isKey) {
        hasKeyframe = true;
        // Prepend cached SPS/PPS if this IDR slice doesn't have SPS in it
        if (cachedSpsPps && !info.hasSps) {
          const combined = new Uint8Array(cachedSpsPps.length + u8.length);
          combined.set(cachedSpsPps, 0);
          combined.set(u8, cachedSpsPps.length);
          u8 = combined;
        }
      }

      if (!hasKeyframe) return; // Wait for initial IDR keyframe

      try {
        const chunk = new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: performance.now() * 1000,
          data: u8
        });
        decoder.decode(chunk);
      } catch (err) {
        console.warn('[Stream] H264 chunk decode error:', err);
      }
    };

    ws.onerror = function() {};

    ws.onclose = function(e) {
      if (e && (e.code === 4003 || (e.reason && (e.reason.includes('Blocked') || e.reason.includes('blocked'))))) {
        showBlockedScreen(e.reason || 'This device stream has been suspended or blocked by an Administrator.');
        return;
      }
      if (isStreamBlocked) return;
      wsOk = false;
      modeText.textContent = 'CONNECTING';
      wsFailCount++;
      const delay = Math.min(200 * Math.pow(2, Math.min(wsFailCount, 4)), 2000);
      wsRetryTimer = setTimeout(connectWS, delay);
    };
  }

  // ── HTTP screencap fallback ───────────────────────────────────────────────
  // DISABLED — strict scrcpy H264 only, no fallback
  let fbRunning = false;
  function startFallback() {
    // Disabled
  }

  // ── Control: Direct Zero-Lag Transport ─────────────────────────────────────
  const ctrlQueue = [];
  function flushQueue() {
    while (ctrlQueue.length && ws && ws.readyState === 1)
      ws.send(JSON.stringify(ctrlQueue.shift()));
  }
  function send(data) {
    if (isStreamBlocked) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
    else {
      if (data.type === 'touch' && data.action === 2) return; // drop stale moves
      ctrlQueue.push(data);
      if (ctrlQueue.length > 8) ctrlQueue.splice(0, ctrlQueue.length - 8);
    }
  }

  function coords(e) {
    const r = canvas.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    
    // Use canvas size first (actual rendered), fall back to nativeW/H, then server defaults
    const canvasW = canvas.width || nativeW || ${screenW};
    const canvasH = canvas.height || nativeH || ${screenH};
    
    // rect dimensions (CSS pixels on screen)
    const rectW = r.width || canvasW;
    const rectH = r.height || canvasH;
    
    // Prevent division by zero
    if (rectW === 0 || rectH === 0) return { x: 0, y: 0, cx, cy };
    
    const x = Math.round((cx - r.left) * (canvasW / rectW));
    const y = Math.round((cy - r.top)  * (canvasH / rectH));
    
    return {
      x: Math.max(0, Math.min(canvasW - 1, x)),
      y: Math.max(0, Math.min(canvasH - 1, y)),
      cx, cy
    };
  }

  // ── Raw Direct Pointer Control (Instant 1:1 Zero Delay) ───────────────────
  let down = false;
  let activePointerId = null;

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    down = true;
    activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    initAudio();
    const c = coords(e);
    send({ type:'touch', action:0, x:c.x, y:c.y, width:nativeW, height:nativeH, pressure:1.0 });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    e.preventDefault();
    const c = coords(e);
    send({ type:'touch', action:2, x:c.x, y:c.y, width:nativeW, height:nativeH, pressure:1.0 });
  });

  function releasePointer(e) {
    if (!down) return;
    down = false;
    if (activePointerId !== null) {
      try { canvas.releasePointerCapture(activePointerId); } catch (_) {}
      activePointerId = null;
    }
    const c = coords(e);
    send({ type:'touch', action:1, x:c.x, y:c.y, width:nativeW, height:nativeH, pressure:0 });
  }

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  window.addEventListener('pointerup', releasePointer);

  // Direct wheel scroll
  let wheelT = null;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (wheelT) return;
    wheelT = setTimeout(() => { wheelT = null; }, 80);
    const c = coords(e);
    const d = e.deltaY > 0 ? -350 : 350;
    send({ type:'swipe', x1:c.x, y1:c.y, x2:c.x, y2:Math.max(50, Math.min(nativeH - 50, c.y + d)), duration: 100 });
  }, { passive:false });

  // ── Keyboard handling (Spacebar protection & full Android keys) ────────
  document.addEventListener('keydown', (e) => {
    // Never intercept if typing into an input/textarea inside a modal dialog
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

    // Immediately blur any active button so Space cannot trigger click events on it
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== canvas) {
      document.activeElement.blur();
    }

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      key(62); // Android KEYCODE_SPACE = 62
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      key(67); // Android KEYCODE_DEL = 67
    } else if (e.key === 'Enter') {
      e.preventDefault();
      key(66); // Android KEYCODE_ENTER = 66
    } else if (e.key === 'Escape') {
      e.preventDefault();
      key(4);  // Android KEYCODE_BACK = 4
    } else if (e.key === 'Tab') {
      e.preventDefault();
      key(61); // Android KEYCODE_TAB = 61
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      key(19);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      key(20);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      key(21);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      key(22);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      send({ type:'text', text:e.key });
    }
  });

  // Ensure all buttons instantly blur upon click or touch so they never retain keyboard focus
  window.addEventListener('pointerdown', (e) => {
    if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest('button'))) {
      const btn = e.target.tagName === 'BUTTON' ? e.target : e.target.closest('button');
      setTimeout(() => { if (btn) btn.blur(); }, 0);
    }
  });
  window.addEventListener('click', (e) => {
    if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest('button'))) {
      const btn = e.target.tagName === 'BUTTON' ? e.target : e.target.closest('button');
      setTimeout(() => { if (btn) btn.blur(); }, 0);
    }
  });

  function key(code) { send({ type:'code', code }); }
  function expandNotifications() { send({ type:'expand_notifications' }); }

  function screenshot() {
    const q = location.search ? location.search + '&t=' + Date.now() : '?t=' + Date.now();
    fetch('/screen.jpg' + q).then(r=>r.blob()).then(b=>{
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'shot-${serial}-'+Date.now()+'.jpg';
      a.click();
    });
  }
  function reboot() { if(confirm('Reboot ${serial}?')) send({type:'reboot'}); }
  function openText() { document.getElementById('textModal').style.display='flex'; document.getElementById('textVal').focus(); }
  function doText() {
    const v = document.getElementById('textVal').value;
    if (v) { send({type:'text',text:v}); document.getElementById('textVal').value=''; }
    document.getElementById('textModal').style.display='none';
  }
  function openUpload() { document.getElementById('uploadModal').style.display='flex'; }
  function doUpload() {
    const f = document.getElementById('filePick').files[0];
    if (!f) return alert('Pick a file first');
    const fd = new FormData(); fd.append('file', f);
    fetch('/upload',{method:'POST',body:fd}).then(r=>r.json())
      .then(()=>{ alert(f.name+' uploaded!'); document.getElementById('uploadModal').style.display='none'; })
      .catch(()=>alert('Upload failed'));
  }
  let currentVolume = 100;
  function setVolume(val) {
    currentVolume = parseFloat(val);
    if (gainNode) gainNode.gain.value = isMuted ? 0 : (currentVolume / 100);
    const btn = document.getElementById('muteBtn');
    if (btn) {
      btn.textContent = (isMuted || currentVolume === 0) ? '🔇' : '🔊';
    }
  }

  function rotateScreen() {
    send({ type: 'code', code: 275 });
    setTimeout(reconnectStream, 300);
  }

  function reconnectStream() {
    modeText.textContent = 'CONNECTING';
    resetDecoder();
    connectWS();
  }

  function toggleDebugModal() {
    const modal = document.getElementById('debugModal');
    if (modal) {
      document.getElementById('dbgRes').textContent = nativeW + ' x ' + nativeH;
      document.getElementById('dbgWs').textContent = wsOk ? 'CONNECTED' : 'DISCONNECTED';
      document.getElementById('dbgCodec').textContent = typeof VideoDecoder !== 'undefined' ? 'WebCodecs H264 (Hardware)' : 'Fallback Canvas';
      modal.style.display = modal.style.display === 'flex' ? 'none' : 'flex';
    }
  }

  function popOutWindow() {
    const width = 510, height = 900;
    const left = Math.max(0, Math.round((window.screen.width - width) / 2));
    const top = Math.max(0, Math.round((window.screen.height - height) / 2));
    window.open(window.location.href, 'Stream_${serial}', 'width=' + width + ',height=' + height + ',top=' + top + ',left=' + left + ',resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no,popup=yes');
  }

  window.addEventListener('click', e => { if (e.target.classList.contains('modal')) e.target.style.display='none'; });

  // ── Clean Instant Teardown on Browser Close ─────────────────────────────
  window.addEventListener('beforeunload', function() {
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch (_) {}
      ws = null;
    }
    try { resetDecoder(); } catch (_) {}
    try { if (audioCtx) audioCtx.close(); } catch (_) {}
  });

  try { initAudio(); } catch (_) {}
  connectWS();

  // ── Gentle Liveness Check (Never drops healthy connections) ─────────────
  setInterval(function() {
    if (isStreamBlocked) return;
    if (!wsOk && (!ws || ws.readyState > 1)) {
      connectWS();
    }
  }, 3000);
</script>
</body>
</html>`;
}


// ─── startStreamServer ───────────────────────────────────────────────────────


async function startStreamServer(serial, port) {
  logger.info(`[StreamServer] Starting for ${serial} on port ${port}`);

  // Start scrcpy engine
  const engine = new ScrcpyEngine(serial);
  const videoPort = port + 1000;
  try {
    await engine.start(videoPort);
    logger.info(`[StreamServer] ScrcpyEngine ready for ${serial}`);
  } catch (err) {
    logger.warn(`[StreamServer] ScrcpyEngine failed for ${serial}: ${err.message} — screencap fallback active`);
  }

  // ── HTTP handler ──────────────────────────────────────────────────────────
  // Cache license check to avoid hitting Supabase on every HTTP request/WS connect
  let cachedLicenseResult = null;
  let cachedLicenseTime = 0;
  const LICENSE_CACHE_TTL = 60000; // 60 seconds

  async function getCachedLicenseStatus() {
    const now = Date.now();
    if (cachedLicenseResult && (now - cachedLicenseTime < LICENSE_CACHE_TTL)) {
      return cachedLicenseResult;
    }
    const bindingCode = bindingService.getOrGenerateBindingCode();
    cachedLicenseResult = await licenseService.checkLicenseStatus(bindingCode);
    cachedLicenseTime = now;
    return cachedLicenseResult;
  }

  // Cache device block status per-serial (4 second TTL already in license-service,
  // but avoid even calling into it on every request)
  let cachedBlockResult = null;
  let cachedBlockTime = 0;
  const BLOCK_CACHE_TTL = 5000; // 5 seconds

  async function getCachedBlockStatus() {
    const now = Date.now();
    if (cachedBlockResult && (now - cachedBlockTime < BLOCK_CACHE_TTL)) {
      return cachedBlockResult;
    }
    let isDeviceBlocked = false;
    let blockReason = 'This device stream has been temporarily suspended or blocked by an Administrator.';
    try {
      const processManager = require('../main/process-manager');
      const localBlock = processManager.isStreamBlocked(serial);
      if (localBlock && localBlock.isBlocked) {
        isDeviceBlocked = true;
        if (localBlock.reason) blockReason = localBlock.reason;
      }
    } catch (_) {}
    if (!isDeviceBlocked) {
      try {
        const cloudCheck = await licenseService.checkDeviceStreamBlocked(serial);
        if (cloudCheck && cloudCheck.isBlocked) {
          isDeviceBlocked = true;
          if (cloudCheck.reason) blockReason = cloudCheck.reason;
        }
      } catch (_) {}
    }
    cachedBlockResult = { isDeviceBlocked, blockReason };
    cachedBlockTime = now;
    return cachedBlockResult;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:;");
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const licenseInfo = await getCachedLicenseStatus();
    const bindingCode = licenseInfo.bindingCode || bindingService.getOrGenerateBindingCode();

    if (!licenseInfo.isActive) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Machine License Suspended</title></head>
        <body style="background:#090d16; color:#f8fafc; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center;">
          <div style="max-width:440px; padding:32px; background:#0f172a; border:1px solid rgba(239,68,68,0.3); border-radius:16px;">
            <div style="font-size:48px; margin-bottom:16px;">🔒</div>
            <h2 style="color:#ef4444; margin-bottom:8px;">Machine License Suspended</h2>
            <p style="color:#94a3b8; font-size:14px; line-height:1.6;">
              Access to this machine stream has been revoked by the Seed Owner.
            </p>
            <div style="margin-top:16px; font-family:monospace; background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; font-size:13px;">
              Binding Code: <strong>${bindingCode}</strong>
            </div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);
    const p   = url.pathname;
    const pinParam   = url.searchParams.get('key') || url.searchParams.get('pin') || url.searchParams.get('token');
    const tokenParam = url.searchParams.get('token') || req.headers['x-session-token'];
    const remoteIp = req.socket.remoteAddress || '';
    const hostHeader = req.headers.host || '';
    
    // Cloudflare Tunnel proxies traffic to localhost — inspect Cloudflare & proxy headers to detect remote clients
    const isCloudflareOrRemote = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (hostHeader && !hostHeader.includes('localhost') && !hostHeader.includes('127.0.0.1')));
    const isLocalHost = !isCloudflareOrRemote && (remoteIp.includes('127.0.0.1') || remoteIp.includes('::1') || remoteIp.includes('localhost') || hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1'));

    // ── Check if Device Stream is Blocked by Administrator ──────────────────
    const linkStatus = url.searchParams.get('status') || url.searchParams.get('link_status') || url.searchParams.get('stream_status');
    const isExplicitlyBlocked = linkStatus === 'suspended' || linkStatus === 'revoked' || linkStatus === 'blocked' || url.searchParams.get('is_blocked') === '1' || url.searchParams.get('blocked') === '1';

    let isDeviceBlocked = isExplicitlyBlocked;
    let blockReason = 'This device stream has been temporarily suspended or blocked by an Administrator.';

    if (!isDeviceBlocked) {
      const blockStatus = await getCachedBlockStatus();
      isDeviceBlocked = blockStatus.isDeviceBlocked;
      blockReason = blockStatus.blockReason;
    }

    if (isDeviceBlocked) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(getDeviceStreamBlockedHtml(serial, blockReason));
      return;
    }


    // Check key parameter (16-char), PIN parameter (6-digit), or session token
    const keyParam = (url.searchParams.get('key') || '').trim();
    const cleanPinParam = pinParam ? pinParam.trim() : '';

    const udidParam = (url.searchParams.get('udid') || '').trim();
    const isSeedAdminDedicated = (serial === 'R5CW114C0SP' || udidParam === 'R5CW114C0SP');

    // Cross-Machine & Multi-Device Smart Router:
    // If request specifies a different UDID than this stream server:
    if (udidParam && udidParam !== serial) {
      if (activeServers.has(udidParam)) {
        const targetDev = activeServers.get(udidParam);
        const targetPort = targetDev.server.address()?.port;
        if (targetPort && targetPort !== port) {
          res.writeHead(302, { 'Location': `http://localhost:${targetPort}${req.url}` });
          res.end();
          return;
        }
      } else {
        // Device is running on another computer in the farm -> look up in Supabase & redirect directly
        try {
          const client = licenseService.getSupabaseClient ? licenseService.getSupabaseClient() : null;
          if (client) {
            const devRes = await client.get(`/devices?serial=eq.${encodeURIComponent(udidParam)}&select=stream_url,status,is_stream_blocked,stream_blocked_reason`);
            if (devRes.data && Array.isArray(devRes.data) && devRes.data.length > 0 && devRes.data[0].stream_url) {
              const remoteUrl = devRes.data[0].stream_url;
              // If target remote device is blocked, render blocked screen immediately
              if (devRes.data[0].is_stream_blocked || devRes.data[0].status === 'blocked') {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end(getDeviceStreamBlockedHtml(udidParam, devRes.data[0].stream_blocked_reason));
                return;
              }
              // Redirect if remote URL points to a dedicated quick tunnel or different host
              const isDifferent = remoteUrl && (!remoteUrl.includes(hostHeader) || remoteUrl.includes('trycloudflare.com') || remoteUrl.includes('loca.lt'));
              if (isDifferent) {
                res.writeHead(302, { 'Location': remoteUrl });
                res.end();
                return;
              }
            }
          }
        } catch (_) {}
      }
    }

    // Invalidate stale / old stream links if device has a rotated clean key
    if (!isSeedAdminDedicated && isCloudflareOrRemote && (p === '/' || p === '') && keyParam) {
      const isKeyValid = await licenseService.validateDevicePin(serial, keyParam, bindingCode);
      if (!isKeyValid) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(getExpiredLinkHtml(serial));
        return;
      }
    }

    // Direct access allowed without PIN requirement for seamless local & Cloudflare fast link control

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
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ status:'ok' }));
        });
      });
      return;
    }

    if (p === '/screen.jpg') {
      const frame = await captureOneFrame(serial);
      if (frame) { res.writeHead(200, {'Content-Type':'image/png','Cache-Control':'no-cache'}); res.end(frame); }
      else        { res.writeHead(500); res.end('Capture error'); }
      return;
    }

    if (p === '/control') {
      handleControl(url.searchParams.get('type'), url.searchParams, serial, engine, null);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end('{"status":"ok"}'); return;
    }

    res.writeHead(200, {'Content-Type':'text/html'});
    // Prefer the negotiated stream resolution; fall back to physical screen size.
    const playerW = engine.videoWidth  > 0 ? engine.videoWidth  : engine.screenWidth;
    const playerH = engine.videoHeight > 0 ? engine.videoHeight : engine.screenHeight;
    res.end(buildPlayerHtml(serial, playerW, playerH));
  });

  // ── WebSocket — relay H264 + audio from scrcpy engine to browser ─────────
  const wss = new WebSocket.Server({ server, path: '/ws', perMessageDeflate: false });

  wss.on('connection', async (ws, req) => {
    const lic = await getCachedLicenseStatus();

    if (!lic.isActive) {
      ws.close(4003, 'License Revoked');
      return;
    }

    // Check if device stream is blocked on connect
    let isWsBlocked = false;
    let wsBlockReason = 'This device stream has been temporarily suspended or blocked by an Administrator.';

    const blockStatus = await getCachedBlockStatus();
    if (blockStatus.isDeviceBlocked) {
      isWsBlocked = true;
      wsBlockReason = blockStatus.blockReason;
    }

    if (isWsBlocked) {
      try {
        ws.send(JSON.stringify({ type: 'stream_blocked', reason: wsBlockReason, serial }));
      } catch (_) {}
      ws.close(4003, 'Stream Blocked');
      return;
    }

    // Invalidate stale stream links on remote WebSocket connection
    const wsUrl = new URL(req.url, 'http://localhost');
    const wsKey = (wsUrl.searchParams.get('key') || '').trim();
    const wsHost = req.headers.host || '';
    const isWsRemote = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (wsHost && !wsHost.includes('localhost') && !wsHost.includes('127.0.0.1')));
    if (serial !== 'R5CW114C0SP' && isWsRemote && wsKey) {
      const isWsKeyValid = await licenseService.validateDevicePin(serial, wsKey, bindingCode);
      if (!isWsKeyValid) {
        ws.close(4003, 'Stream Link Expired');
        return;
      }
    }

    // Register active WS client for instantaneous block broadcast
    if (!activeWsClients.has(serial)) {
      activeWsClients.set(serial, new Set());
    }
    activeWsClients.get(serial).add(ws);

    try { req.socket.setNoDelay(true); } catch (_) {}
    logger.info(`[StreamServer] WS connected for ${serial}`);
    engine.addClient(ws);

    ws.on('message', (msg) => {
      // 1. Ultra-fast binary packet handler (Sub-millisecond direct dispatch)
      if (Buffer.isBuffer(msg) || (msg instanceof ArrayBuffer) || (msg instanceof Uint8Array)) {
        const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
        if (buf.length >= 12 && buf[0] === 0x54) { // 'T' = Touch packet
          const action = buf.readUInt8(1);
          const x = buf.readUInt16BE(2);
          const y = buf.readUInt16BE(4);
          const w = buf.readUInt16BE(6);
          const h = buf.readUInt16BE(8);
          const pressure = buf.length >= 12 ? (buf.readUInt16BE(10) / 65535) : (action === 1 ? 0 : 1.0);
          const pId = buf.length >= 14 ? buf.readUInt16BE(12) : 0;
          engine.sendTouchEvent(action, x, y, w, h, pressure, pId);
          return;
        }
        if (buf.length >= 14 && buf[0] === 0x53) { // 'S' = Scroll packet
          const x = buf.readUInt16BE(2);
          const y = buf.readUInt16BE(4);
          const w = buf.readUInt16BE(6);
          const h = buf.readUInt16BE(8);
          const hscroll = buf.readInt16BE(10);
          const vscroll = buf.readInt16BE(12);
          engine.sendScrollEvent(x, y, w, h, hscroll, vscroll);
          return;
        }
      }

      // 2. JSON control message handler
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'wake' || data.type === 'request_keyframe') {
          // Immediately bootstrap client with cached SPS/PPS + IDR keyframe
          if (engine._keyframeBuffer || engine._configPacket) {
            try { ws.send(engine._keyframeBuffer || engine._configPacket, { binary: true }); } catch (_) {}
          }
          engine._requestIdrKeyframe();
          return;
        }
        handleControl(data.type, data, serial, engine, ws);
      } catch (_) {}
    });

    const cleanup = () => {
      engine.removeClient(ws);
      const set = activeWsClients.get(serial);
      if (set) {
        set.delete(ws);
        if (set.size === 0) activeWsClients.delete(serial);
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.on('clientError', (err, socket) => {
      try {
        if (socket.writable) socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      } catch (_) {}
    });
    server.listen(port, '0.0.0.0', () => {
      const localUrl = `http://localhost:${port}`;
      logger.info(`[StreamServer] Listening at ${localUrl}`);
      activeServers.set(serial, { server, wss, engine });

      const streamProcess = {
        pid: port, exitCode: null,
        kill() {
          engine.stop();
          try { wss.close(); } catch (_) {}
          server.close();
          activeServers.delete(serial);
        },
      };
      resolve({ streamProcess, localUrl });
    });
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

function buildStreamUrl(tunnelDomain, port, serial) {
  const cleanDomain = tunnelDomain.replace(/\/+$/, '');
  const domain = cleanDomain.startsWith('http') ? cleanDomain : `https://${cleanDomain}`;
  return `${domain}/?udid=${encodeURIComponent(serial)}`;
}

function killStreamServer(streamProcess) {
  if (streamProcess && typeof streamProcess.kill === 'function') {
    try { streamProcess.kill(); } catch (_) {}
  }
}

module.exports = {
  startStreamServer,
  buildStreamUrl,
  killStreamServer,
  disconnectBlockedStream,
  getDeviceStreamBlockedHtml,
};
