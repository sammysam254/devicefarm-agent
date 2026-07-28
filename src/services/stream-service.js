'use strict';

const http = require('http');
const WebSocket = require('ws');
const { spawn, exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const rentalPaymentService = require('./rental-payment-service');
const ScrcpyEngine = require('./scrcpy-engine');

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

// ─── Screencap fallback (one-shot, for /screen.jpg HTTP endpoint) ────────────

function captureOneFrame(serial) {
  return new Promise((resolve) => {
    const p = spawn(ADB_BIN, ['-s', serial, 'exec-out', 'screencap -p'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('close', code => {
      if (code !== 0 || !chunks.length) return resolve(null);
      let buf = Buffer.concat(chunks);
      // Fix Windows stdout CRLF line ending corruption in binary PNG data
      let cleanBuf = Buffer.alloc(buf.length);
      let pos = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0D && i + 1 < buf.length && buf[i+1] === 0x0A) continue;
        cleanBuf[pos++] = buf[i];
      }
      resolve(cleanBuf.slice(0, pos));
    });
    p.on('error', () => resolve(null));
  });
}

// ─── Shared control dispatcher ────────────────────────────────────────────────

function get(data, key) {
  return typeof data.get === 'function' ? data.get(key) : data[key];
}

function handleControl(type, data, serial, engine) {
  const W = parseFloat(get(data, 'width'))  || engine.screenWidth  || 720;
  const H = parseFloat(get(data, 'height')) || engine.screenHeight || 1600;

  if (type === 'touch') {
    const action = parseInt(get(data, 'action'), 10);
    const x = parseFloat(get(data, 'x'));
    const y = parseFloat(get(data, 'y'));
    if (!engine.sendTouchEvent(action, x, y, W, H)) {
      if (action === 0) adbInput(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
    }
  } else if (type === 'tap') {
    const x = parseFloat(get(data, 'x')), y = parseFloat(get(data, 'y'));
    if (!engine.sendTouchEvent(0, x, y, W, H)) adbInput(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
    else engine.sendTouchEvent(1, x, y, W, H);
  } else if (type === 'swipe') {
    const x1 = parseFloat(get(data, 'x1')), y1 = parseFloat(get(data, 'y1'));
    const x2 = parseFloat(get(data, 'x2')), y2 = parseFloat(get(data, 'y2'));
    const dur = parseInt(get(data, 'duration'), 10) || 100;
    if (!engine.sendTouchEvent(0, x1, y1, W, H)) {
      adbInput(serial, `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${dur}`);
    } else {
      engine.sendTouchEvent(2, x2, y2, W, H);
      engine.sendTouchEvent(1, x2, y2, W, H);
    }
  } else if (type === 'code' || type === 'key') {
    const code = parseInt(get(data, 'code'), 10);
    if (!engine.sendKeycode(0, code)) adbInput(serial, `input keyevent ${code}`);
    else engine.sendKeycode(1, code);
  } else if (type === 'text') {
    const text = get(data, 'text') || '';
    if (!engine.sendText(text)) adbInput(serial, `input text "${text.replace(/"/g, '\\"')}"`);
  } else if (type === 'reboot') {
    exec(`"${ADB_BIN}" -s ${serial} reboot`);
  }
}


// ─── Player HTML (WebCodecs H264 decoder + screencap fallback) ───────────────

function buildPlayerHtml(serial, screenW, screenH) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serial} — Live</title>
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;background:#04060a;color:#f8fafc;font-family:system-ui;overflow:hidden}
    body{display:flex;flex-direction:column;align-items:center;padding:6px 12px;user-select:none;-webkit-user-select:none}
    .header{display:flex;align-items:center;justify-content:space-between;width:100%;max-width:560px;padding:2px 0;flex-shrink:0}
    .badge{background:rgba(56,189,248,.15);color:#38bdf8;border:1px solid rgba(56,189,248,.3);padding:3px 10px;border-radius:100px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:5px}
    .dot{width:6px;height:6px;background:#38bdf8;border-radius:50%;animation:pulse 1s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .stage{flex:1;display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:0}
    .wrap{position:relative;background:#000;border-radius:18px;border:2px solid rgba(56,189,248,.4);box-shadow:0 0 30px rgba(56,189,248,.2);overflow:hidden;touch-action:none;flex-shrink:0}
    canvas{display:block;max-height:calc(100vh - 52px);width:auto;cursor:crosshair}
    .sidebar{display:flex;flex-direction:column;gap:5px;background:rgba(15,23,42,.95);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:7px 5px;max-height:calc(100vh - 52px);overflow-y:auto;flex-shrink:0}
    .btn{width:36px;height:36px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#f1f5f9;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;transition:all .12s}
    .btn:hover{background:rgba(56,189,248,.25);border-color:rgba(56,189,248,.5);color:#38bdf8}
    .btn:active{transform:scale(.88)}
    .btn-red{background:rgba(248,113,113,.12);color:#f87171;border-color:rgba(248,113,113,.3)}
    .btn-red:hover{background:rgba(248,113,113,.3)}
    .hr{height:1px;background:rgba(255,255,255,.1);margin:2px 0}
    .back{position:absolute;bottom:10px;right:10px;width:40px;height:40px;border-radius:50%;background:#ef4444;color:#fff;border:2px solid rgba(255,255,255,.35);box-shadow:0 4px 12px rgba(239,68,68,.5);display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;z-index:9}
    .ripple{position:absolute;width:24px;height:24px;border-radius:50%;background:rgba(56,189,248,.5);border:2px solid #38bdf8;transform:translate(-50%,-50%) scale(.3);pointer-events:none;animation:rip .22s forwards;z-index:10}
    @keyframes rip{to{transform:translate(-50%,-50%) scale(1.8);opacity:0}}
    .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:20;align-items:center;justify-content:center}
    .mbox{background:#0f172a;border:1px solid rgba(56,189,248,.4);border-radius:14px;padding:18px;width:90%;max-width:360px}
    .minput{width:100%;padding:9px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:9px;color:#fff;font-size:14px;margin-bottom:12px;outline:none}
    .mbtn{width:100%;padding:9px;background:#38bdf8;color:#0f172a;border:none;border-radius:9px;font-weight:700;cursor:pointer}
  </style>
</head>
<body>
<div class="header">
  <div style="display:flex;align-items:center;gap:8px">
    <span style="font-size:18px">📱</span>
    <div>
      <div style="font-weight:700;font-size:13px">Live Stream</div>
      <div style="font-size:10px;color:#64748b;font-family:monospace">${serial}</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <div class="badge" id="badge"><span class="dot"></span><span id="modeText">CONNECTING</span></div>
    <span style="font-size:10px;color:#64748b;font-family:monospace" id="fps">--fps</span>
  </div>
</div>

<div class="stage">
  <div class="wrap" id="wrap">
    <canvas id="c" width="${screenW}" height="${screenH}"></canvas>
    <button class="back" onclick="key(4)">&#x21A9;</button>
  </div>
  <div class="sidebar">
    <button class="btn" onclick="key(82)">&#8942;</button>
    <button class="btn btn-red" onclick="key(26)">&#9211;</button>
    <div class="hr"></div>
    <button class="btn" onclick="key(24)">&#128266;</button>
    <button class="btn" onclick="key(25)">&#128265;</button>
    <button class="btn" onclick="key(164)">&#128277;</button>
    <div class="hr"></div>
    <button class="btn" onclick="key(3)">&#9711;</button>
    <button class="btn" onclick="key(187)">&#9723;</button>
    <div class="hr"></div>
    <button class="btn" onclick="screenshot()">&#128247;</button>
    <button class="btn" onclick="openText()">&#9000;</button>
    <button class="btn" onclick="openUpload()">&#128228;</button>
    <div class="hr"></div>
    <button class="btn btn-red" onclick="reboot()">&#128260;</button>
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

<script>
  const canvas = document.getElementById('c');
  const ctx    = canvas.getContext('2d', { alpha: false });
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
    }
    ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
    if (f.close) f.close();
    countFrame();
  }

  // ── WebCodecs H264 decoder ───────────────────────────────────────────────
  // Zero-latency design:
  //   • latencyMode:'realtime' disables internal frame reordering buffers
  //   • optimizeForLatency:true is the older Chrome hint — kept for compat
  //   • We wait for a real SPS/PPS config packet before configuring so the
  //     codec string (avc1.PPCCLL) reflects the actual stream profile/level.
  //   • On every new config packet we re-configure without closing so Chrome
  //     handles resolution changes seamlessly.

  let decoder = null;
  let decoderConfigured = false;
  let cachedSpsPps = null;
  let lastTs = 0;

  function initDecoder() {
    if (decoder) {
      try { decoder.close(); } catch (_) {}
      decoder = null;
    }
    decoderConfigured = false;
    decoder = new VideoDecoder({
      output: (frame) => { queueDraw(frame); },
      error:  (e) => {
        console.warn('[Decoder] error:', e);
        if (decoder) { try { decoder.close(); } catch(_){} decoder = null; }
        decoderConfigured = false;
      }
    });
    console.log('[Decoder] created — waiting for SPS/PPS config');
  }

  function getNalTypes(buf) {
    const u8 = new Uint8Array(buf);
    const types = [];
    for (let i = 0; i < u8.length - 3; i++) {
      if (u8[i] === 0 && u8[i+1] === 0) {
        if (u8[i+2] === 1 && i + 3 < u8.length) {
          types.push(u8[i+3] & 0x1f);
        } else if (u8[i+2] === 0 && u8[i+3] === 1 && i + 4 < u8.length) {
          types.push(u8[i+4] & 0x1f);
        }
      }
    }
    return types;
  }

  function parseSpsCodecString(data) {
    try {
      const u8 = new Uint8Array(data);
      for (let i = 0; i < u8.length - 4; i++) {
        if (u8[i] === 0 && u8[i+1] === 0) {
          const offset = (u8[i+2] === 1) ? 3 : (u8[i+2] === 0 && u8[i+3] === 1) ? 4 : 0;
          if (offset > 0 && i + offset < u8.length) {
            const nalType = u8[i + offset] & 0x1f;
            if (nalType === 7 && i + offset + 3 < u8.length) {
              const p = u8[i + offset + 1].toString(16).padStart(2, '0');
              const c = u8[i + offset + 2].toString(16).padStart(2, '0');
              const l = u8[i + offset + 3].toString(16).padStart(2, '0');
              return 'avc1.' + p + c + l;
            }
          }
        }
      }
    } catch (_) {}
    return null;
  }

  function configureDecoder(configData) {
    cachedSpsPps = new Uint8Array(configData);
    const codecStr = parseSpsCodecString(configData) || 'avc1.42E01F';
    try {
      if (!decoder || decoder.state === 'closed') initDecoder();
      const cfg = { codec: codecStr, optimizeForLatency: true };
      try { cfg.latencyMode = 'realtime'; } catch(_) {}
      decoder.configure(cfg);
      decoderConfigured = true;
      console.log('[Decoder] configured with', codecStr);
    } catch (e) {
      console.warn('[Decoder] configure failed:', e);
      decoderConfigured = false;
    }
  }

  function feedFrame(data, isKey) {
    if (!decoder || decoder.state === 'closed' || !decoderConfigured) return;

    let payload = data;
    if (isKey && cachedSpsPps) {
      const types = getNalTypes(data);
      if (!types.includes(7)) {
        const combined = new Uint8Array(cachedSpsPps.length + data.byteLength);
        combined.set(cachedSpsPps, 0);
        combined.set(new Uint8Array(data), cachedSpsPps.length);
        payload = combined.buffer;
      }
    }

    const ts = Math.max(lastTs + 1, Math.floor(performance.now() * 1000));
    lastTs = ts;
    try {
      decoder.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: ts,
        data: payload
      }));
    } catch (e) {
      console.warn('[Decoder] decode error:', e);
    }
  }

  function parseAndFeedNal(data) {
    const types = getNalTypes(data);
    const hasSps = types.includes(7);
    const hasIdr = types.includes(5);

    if (hasSps) {
      configureDecoder(data);
      if (!hasIdr) return;
    }

    if (!decoderConfigured && cachedSpsPps) {
      configureDecoder(cachedSpsPps);
    }

    if (hasIdr) {
      feedFrame(data, true);
    } else if (types.includes(1)) {
      feedFrame(data, false);
    }
  }

  // ── WebSocket connection ─────────────────────────────────────────────────
  let ws = null, wsOk = false;
  let wsFailCount = 0;       // number of consecutive WS failures
  let wsRetryTimer = null;

  function connectWS() {
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws' + location.search);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      wsOk = true;
      wsFailCount = 0;
      modeText.textContent = 'H264 LIVE';
      // Stop any running screencap fallback immediately
      fbRunning = false;
      if (typeof VideoDecoder !== 'undefined') {
        lastTs = 0;
        initDecoder();
      } else {
        modeText.textContent = 'LIVE (compat)';
        startFallback();
      }
      flushQueue();
    };

    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      parseAndFeedNal(e.data);
    };

    // On error: just retry — don't start screencap fallback yet.
    // Cloudflare tunnels return 530/503 during startup for 10-30s.
    ws.onerror = () => {};

    ws.onclose = () => {
      wsOk = false;
      decoderConfigured = false;
      wsFailCount++;
      // Only fall back to screencap after 10 consecutive WS failures (~10s)
      // This covers the Cloudflare tunnel startup window.
      if (wsFailCount >= 10 && typeof VideoDecoder === 'undefined') {
        startFallback();
      }
      // Retry: fast at first (500ms), then every 1s once tunnel is up
      const delay = wsFailCount < 5 ? 500 : 1000;
      wsRetryTimer = setTimeout(connectWS, delay);
    };
  }

  // ── PNG/JPEG screencap fallback (for browsers without WebCodecs) ──────────
  let fbRunning = false;
  function startFallback() {
    if (fbRunning) return;
    fbRunning = true;
    modeText.textContent = 'SCREENCAP';
    (function pull() {
      // Stop as soon as WS is alive and WebCodecs is available
      if (wsOk && typeof VideoDecoder !== 'undefined') { fbRunning = false; return; }
      if (!fbRunning) return; // stopped externally (WS connected)
      const q = location.search ? location.search + '&t=' + Date.now() : '?t=' + Date.now();
      fetch('/screen.jpg' + q)
        .then(r => r.blob()).then(b => createImageBitmap(b))
        .then(bmp => { queueDraw(bmp); requestAnimationFrame(pull); })
        .catch(() => setTimeout(pull, 200));
    })();
  }

  // ── Control: WS-only, never fetch ───────────────────────────────────────
  const ctrlQueue = [];
  function flushQueue() {
    while (ctrlQueue.length && ws && ws.readyState === 1)
      ws.send(JSON.stringify(ctrlQueue.shift()));
  }
  function send(data) {
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
    return {
      x: Math.round((cx - r.left) * (nativeW / r.width)),
      y: Math.round((cy - r.top)  * (nativeH / r.height)),
      cx, cy
    };
  }

  function ripple(cx, cy) {
    const r = wrap.getBoundingClientRect();
    const d = document.createElement('div');
    d.className = 'ripple';
    d.style.left = (cx - r.left) + 'px';
    d.style.top  = (cy - r.top)  + 'px';
    wrap.appendChild(d);
    setTimeout(() => d.remove(), 230);
  }

  // ── Pointer events ───────────────────────────────────────────────────────
  let down = false;

  canvas.addEventListener('mousedown',  onDown);
  canvas.addEventListener('mousemove',  onMove);
  canvas.addEventListener('mouseup',    onUp);
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove',  onMove, { passive: false });
  canvas.addEventListener('touchend',   onUp);

  function onDown(e) {
    e.preventDefault(); down = true;
    const c = coords(e);
    ripple(c.cx, c.cy);
    send({ type:'touch', action:0, x:c.x, y:c.y, width:nativeW, height:nativeH });
  }
  function onMove(e) {
    if (!down) return; e.preventDefault();
    const c = coords(e);
    send({ type:'touch', action:2, x:c.x, y:c.y, width:nativeW, height:nativeH });
  }
  function onUp(e) {
    if (!down) return; e.preventDefault(); down = false;
    const cx = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const cy = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const r  = canvas.getBoundingClientRect();
    send({ type:'touch', action:1,
      x: Math.round((cx - r.left) * (nativeW / r.width)),
      y: Math.round((cy - r.top)  * (nativeH / r.height)),
      width:nativeW, height:nativeH });
  }

  // wheel scroll
  let wheelT = null;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); if (wheelT) return;
    wheelT = setTimeout(() => wheelT = null, 30);
    const c = coords(e);
    const d = e.deltaY > 0 ? -400 : 400;
    send({ type:'swipe', x1:c.x, y1:c.y, x2:c.x, y2:Math.max(50,Math.min(nativeH-50,c.y+d)), duration:80 });
  }, { passive:false });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Backspace') key(67);
    else if (e.key === 'Enter') key(66);
    else if (e.key === 'Escape') key(4);
    else if (e.key.length === 1) send({ type:'text', text:e.key });
  });

  function key(code) { send({ type:'code', code }); }

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
  window.addEventListener('click', e => { if (e.target.classList.contains('modal')) e.target.style.display='none'; });

  connectWS();
</script>
</body>
</html>`;
}


// ─── startStreamServer ───────────────────────────────────────────────────────

async function startStreamServer(serial, port) {
  logger.info(`[StreamServer] Starting for ${serial} on port ${port}`);

  let cachedStatus = null, lastCheck = 0;
  async function getRentalStatus(force = false) {
    const now = Date.now(), ttl = cachedStatus?.isPaid ? 15000 : 2000;
    if (!force && cachedStatus && (now - lastCheck) < ttl) return cachedStatus;
    try { cachedStatus = await rentalPaymentService.checkDeviceRentalStatus(serial); }
    catch (_) { if (cachedStatus) return cachedStatus; cachedStatus = { isPaid: false }; }
    lastCheck = Date.now();
    return cachedStatus;
  }

  // Start scrcpy engine (video + control share same ADB-forwarded port)
  const engine = new ScrcpyEngine(serial);
  const videoPort = port + 1000;
  try {
    await engine.start(videoPort);
    logger.info(`[StreamServer] ScrcpyEngine ready for ${serial}`);
  } catch (err) {
    logger.warn(`[StreamServer] ScrcpyEngine failed for ${serial}: ${err.message} — screencap fallback active`);
  }

  // ── HTTP handler ──────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${port}`);
    const p   = url.pathname;
    const isPage = p === '/' || p === '/index.html';

    const status = await getRentalStatus(isPage);
    if (!status.isPaid) {
      if (p === '/screen.jpg' || p === '/control' || p === '/upload') {
        res.writeHead(402, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error:'Payment required' })); return;
      }
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(getStreamBlockedHtml(serial, rentalPaymentService.getPaymentCheckoutUrl(serial), status));
      return;
    }

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
      handleControl(url.searchParams.get('type'), url.searchParams, serial, engine);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end('{"status":"ok"}'); return;
    }

    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(buildPlayerHtml(serial, engine.screenWidth, engine.screenHeight));
  });

  // ── WebSocket — relay H264 from scrcpy engine to browser ─────────────────
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    logger.info(`[StreamServer] WS connected for ${serial}`);

    // Register client with scrcpy engine immediately for zero-latency frame delivery
    engine.addClient(ws);

    // Perform rental payment check asynchronously without blocking stream delivery
    getRentalStatus().then(status => {
      if (!status || !status.isPaid) {
        try { ws.send(JSON.stringify({type:'error',error:'Payment required'})); ws.close(4002,'Unpaid'); } catch (_) {}
        engine.removeClient(ws);
      }
    }).catch(() => {});

    const payCheck = setInterval(async () => {
      const s = await getRentalStatus();
      if (!s.isPaid) { engine.removeClient(ws); ws.close(4002, 'Unpaid'); }
    }, 60000);

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        handleControl(data.type, data, serial, engine);
      } catch (_) {}
    });

    ws.on('close', () => { engine.removeClient(ws); clearInterval(payCheck); });
    ws.on('error', () => { engine.removeClient(ws); clearInterval(payCheck); });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
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
  const domain = tunnelDomain.replace(/^https?:\/\//, '');
  return `https://${domain}/?action=proxy&remote=tcp%3A127.0.0.1%3A${port}&udid=${encodeURIComponent(serial)}`;
}

function killStreamServer(streamProcess) {
  if (streamProcess && typeof streamProcess.kill === 'function') {
    try { streamProcess.kill(); } catch (_) {}
  }
}

module.exports = { startStreamServer, buildStreamUrl, killStreamServer };
