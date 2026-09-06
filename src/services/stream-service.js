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
      resolve(Buffer.concat(chunks));
    });
    p.on('error', () => resolve(null));
  });
}

// ─── Shared control dispatcher (Raw, Direct, Zero-Delay) ──────────────────────

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
    const pressure = parseFloat(get(data, 'pressure')) || (action === 1 ? 0 : 1.0);
    const ok = engine.sendTouchEvent(action, x, y, W, H, pressure);
    if (!ok && (action === 0 || action === 1)) {
      const realX = Math.round((x / W) * (engine.screenWidth || W));
      const realY = Math.round((y / H) * (engine.screenHeight || H));
      if (action === 0) try { getInputShell(serial).stdin.write(`input tap ${realX} ${realY}\n`); } catch (_) {}
    }
  } else if (type === 'tap') {
    const x = parseFloat(get(data, 'x')), y = parseFloat(get(data, 'y'));
    engine.sendTouchEvent(0, x, y, W, H, 1.0);
    setTimeout(() => engine.sendTouchEvent(1, x, y, W, H, 0), 40);
  } else if (type === 'swipe') {
    const x1 = parseFloat(get(data, 'x1')), y1 = parseFloat(get(data, 'y1'));
    const x2 = parseFloat(get(data, 'x2')), y2 = parseFloat(get(data, 'y2'));
    const dur = parseInt(get(data, 'duration'), 10) || 120;
    engine.sendTouchEvent(0, x1, y1, W, H, 1.0);
    const steps = 6;
    const dt = dur / steps;
    for (let i = 1; i <= steps; i++) {
      setTimeout(() => {
        const p = i / steps;
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
  } else if (type === 'wake' || type === 'refresh') {
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

<script>
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
        },
        error: function(err) {
          console.error('[Stream] VideoDecoder error:', err);
          resetDecoder();
        }
      });
      decoder.configure({
        codec: 'avc1.42E01E',
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware'
      });
      decoderReady = true;
      return true;
    } catch (err) {
      console.error('[Stream] Failed to init VideoDecoder:', err);
      return false;
    }
  }

  function isH264Keyframe(u8) {
    for (let i = 0; i < Math.min(u8.length - 4, 256); i++) {
      if (u8[i] === 0 && u8[i+1] === 0) {
        let ntype = -1;
        if (u8[i+2] === 1 && i + 3 < u8.length) {
          ntype = u8[i+3] & 0x1f;
        } else if (u8[i+2] === 0 && u8[i+3] === 1 && i + 4 < u8.length) {
          ntype = u8[i+4] & 0x1f;
        }
        // WebCodecs key/config types: NAL 5 (IDR keyframe), NAL 7 (SPS), NAL 8 (PPS)
        if (ntype === 5 || ntype === 7 || ntype === 8) return true;
      }
    }
    return false;
  }

  // ── WebSocket connection ─────────────────────────────────────────────────
  let ws = null, wsOk = false;
  let wsFailCount = 0;
  let wsRetryTimer = null;
  let lastFrameReceivedTime = 0;

  // Watchdog: if WS is connected but no frames arrive for >15s, reconnect the stream.
  setInterval(function() {
    if (!wsOk) return;
    if (lastFrameReceivedTime === 0) return;
    if (Date.now() - lastFrameReceivedTime > 15000) {
      console.warn('[Watchdog] No frames for 15s — reconnecting stream');
      reconnectStream();
    }
  }, 1000);

  // Separate first-frame watchdog — if WS is open but no frame ever arrives in 12s, reconnect
  let firstFrameTimer = null;
  function startFirstFrameWatchdog() {
    if (firstFrameTimer) clearTimeout(firstFrameTimer);
    firstFrameTimer = setTimeout(function() {
      if (wsOk && lastFrameReceivedTime === 0 && !fbRunning) {
        console.warn('[Watchdog] No first frame within 12s — reconnecting stream');
        reconnectStream();
      }
    }, 12000);
  }

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
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws' + location.search);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      wsOk = true;
      wsFailCount = 0;
      lastFrameReceivedTime = 0;
      modeText.textContent = 'LIVE 60FPS';
      resetDecoder();
      initDecoder();
      audioNextPlayTime = 0;
      fbRunning = false;
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(function(){});
      flushQueue();
      // Nudge Android encoder to generate a fresh IDR keyframe immediately on connect
      send({ type: 'wake' });
      // Second nudge at +500ms in case the first fires before the encoder is ready
      setTimeout(function() { if (wsOk) send({ type: 'wake' }); }, 500);
      startFirstFrameWatchdog();
    };

    ws.onmessage = function(e) {
      // JSON control messages (stream_reset, etc.)
      if (typeof e.data === 'string' || e.data instanceof ArrayBuffer && e.data.byteLength > 0 && new Uint8Array(e.data)[0] === 0x7B) {
        try {
          const txt = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
          const msg = JSON.parse(txt);
          if (msg.type === 'stream_reset') {
            console.log('[Stream] Server stream reset — reinitialising decoder');
            resetDecoder();
            fbRunning = false;
            lastFrameReceivedTime = 0;
          }
          return;
        } catch (_) {}
      }

      if (!(e.data instanceof ArrayBuffer)) return;
      lastFrameReceivedTime = Date.now();
      if (fbRunning) { fbRunning = false; modeText.textContent = 'LIVE 60FPS'; }

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

      const u8 = (rawU8[0] === 0x56) ? rawU8.subarray(1) : rawU8;

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
        if (!initDecoder()) {
          startFallback();
          return;
        }
      }

      const key = isH264Keyframe(u8);
      if (key) hasKeyframe = true;
      if (!hasKeyframe) return; // Wait for initial keyframe/config (SPS/PPS)



      try {
        const chunk = new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: performance.now() * 1000,
          data: u8
        });
        decoder.decode(chunk);
      } catch (err) {
        console.warn('[Stream] H264 chunk decode error:', err);
        hasKeyframe = false;
      }
    };

    ws.onerror = function() {};

    ws.onclose = function() {
      wsOk = false;
      wsFailCount++;
      if (wsFailCount >= 15 && !fbRunning) startFallback();
      // Exponential back-off: immediate on first failure, then 200ms, 400ms... capped at 2s
      const delay = wsFailCount <= 1 ? 0 : Math.min(200 * Math.pow(2, wsFailCount - 2), 2000);
      wsRetryTimer = setTimeout(connectWS, delay);
    };
  }

  // ── HTTP screencap fallback ───────────────────────────────────────────────
  // DISABLED — strict scrcpy H264 only, no fallback
  let fbRunning = false;
  function startFallback() {
    // Disabled
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

  // ── Raw Direct Pointer Control (Instant, Zero Delay) ────────────────────
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
    wheelT = setTimeout(() => { wheelT = null; }, 100);
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
    modeText.textContent = 'RECONNECTING';
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

  connectWS();
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
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:;");
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const bindingCode = bindingService.getOrGenerateBindingCode();
    const licenseInfo = await licenseService.checkLicenseStatus(bindingCode);

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

    const linkStatus = url.searchParams.get('status') || url.searchParams.get('link_status');
    if (linkStatus === 'suspended' || linkStatus === 'revoked') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Stream Link Suspended</title></head>
        <body style="background:#090d16; color:#f8fafc; font-family:sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center;">
          <div style="max-width:440px; padding:32px; background:#0f172a; border:1px solid rgba(239,68,68,0.3); border-radius:16px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
            <div style="font-size:48px; margin-bottom:16px;">⛔</div>
            <h2 style="color:#ef4444; margin-bottom:8px;">Stream Link Suspended</h2>
            <p style="color:#94a3b8; font-size:14px; line-height:1.6;">
              This stream link has been suspended or revoked by an Administrator. Contact your Seed Owner or Super Admin for an active link.
            </p>
          </div>
        </body>
        </html>
      `);
      return;
    }

    const dashboardServer = require('../dashboard/server');
    
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
            const devRes = await client.get(`/devices?serial=eq.${encodeURIComponent(udidParam)}&select=stream_url,status`);
            if (devRes.data && Array.isArray(devRes.data) && devRes.data.length > 0 && devRes.data[0].stream_url) {
              const remoteUrl = devRes.data[0].stream_url;
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

    let isPinOrKeyValid = isSeedAdminDedicated;
    if (isLocalHost || isSeedAdminDedicated) {
      isPinOrKeyValid = true;
    } else if (cleanPinParam || keyParam) {
      isPinOrKeyValid = await licenseService.validateDevicePin(serial, cleanPinParam || keyParam, bindingCode);
    }

    const isTokenValid = tokenParam && dashboardServer.SESSION_TOKENS && dashboardServer.SESSION_TOKENS.has(tokenParam);
    const isValidSession = isLocalHost || isPinOrKeyValid || isTokenValid;

    if (!isValidSession) {
      const hasAttemptedPin = Boolean(cleanPinParam);
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Stream Authorization Required — ${serial}</title>
          <script>
            (function() {
              const serial = '${serial}';
              const key = 'device_pin_auth_' + serial;
              const hasPinInUrl = ${hasAttemptedPin ? 'true' : 'false'};
              if (!hasPinInUrl) {
                try {
                  const saved = JSON.parse(localStorage.getItem(key));
                  // 12 Hours cache check (12 * 60 * 60 * 1000 = 43200000 ms)
                  if (saved && saved.pin && saved.ts && (Date.now() - saved.ts < 43200000)) {
                    const u = new URL(window.location.href);
                    u.searchParams.set('pin', String(saved.pin).trim());
                    window.location.href = u.toString();
                  }
                } catch (_) {}
              }
            })();

            function handlePinSubmit(e) {
              e.preventDefault();
              const input = document.getElementById('pinInput');
              const btn = document.getElementById('unlockBtn');
              const rawVal = input ? input.value : '';
              const pin = rawVal.trim().replace(/[^a-zA-Z0-9]/g, '');

              if (!pin) {
                input.focus();
                input.style.borderColor = '#ef4444';
                return;
              }

              btn.disabled = true;
              btn.textContent = '🔄 Unlocking Stream...';
              btn.style.opacity = '0.8';

              try {
                localStorage.setItem('device_pin_auth_${serial}', JSON.stringify({ pin: pin, ts: Date.now() }));
              } catch (_) {}

              const u = new URL(window.location.href);
              u.searchParams.set('pin', pin);
              window.location.href = u.toString();
            }
          </script>
        </head>
        <body style="background:#090d16; color:#f8fafc; font-family:system-ui,-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:16px; box-sizing:border-box;">
          <div style="max-width:440px; width:100%; padding:32px 24px; background:#0f172a; border:1px solid rgba(56,189,248,0.3); border-radius:18px; box-shadow: 0 20px 30px -5px rgba(0,0,0,0.6); text-align:center;">
            <div style="font-size:44px; margin-bottom:14px;">🔐</div>
            <h2 style="color:#38bdf8; margin:0 0 8px 0; font-size:22px; font-weight:800;">Device Authorization</h2>
            <p style="color:#94a3b8; font-size:14px; line-height:1.5; margin:0 0 16px 0;">
              Enter your assigned 6-digit <strong>Stream PIN</strong> to watch and control device <code style="color:#38bdf8; font-family:monospace; background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px;">${serial}</code>.
            </p>

            ${hasAttemptedPin ? `
              <div style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.4); border-radius:8px; padding:10px 12px; margin-bottom:16px; font-size:13px; color:#fca5a5; text-align:center;">
                ❌ Incorrect PIN. Please check your assigned PIN and try again.
              </div>
            ` : ''}

            <form style="margin-top:12px;" onsubmit="handlePinSubmit(event)">
              <input 
                id="pinInput" 
                type="text" 
                inputmode="numeric"
                autocomplete="one-time-code"
                autofocus
                placeholder="Enter 6-Digit PIN" 
                maxlength="16" 
                style="width:100%; padding:14px; border-radius:10px; border:1px solid ${hasAttemptedPin ? 'rgba(239,68,68,0.6)' : 'rgba(255,255,255,0.2)'}; background:rgba(15,23,42,0.9); color:#fff; margin-bottom:14px; font-size:18px; text-align:center; letter-spacing:4px; font-weight:700; box-sizing:border-box; outline:none; transition:border-color 0.2s;"
                onfocus="this.style.borderColor='#38bdf8'"
                onblur="this.style.borderColor='${hasAttemptedPin ? 'rgba(239,68,68,0.6)' : 'rgba(255,255,255,0.2)'}'"
              />
              <button 
                id="unlockBtn"
                type="submit" 
                style="width:100%; padding:14px; border-radius:10px; border:none; background:linear-gradient(135deg,#38bdf8,#0284c7); color:#0f172a; font-weight:800; font-size:15px; cursor:pointer; box-shadow:0 4px 12px rgba(56,189,248,0.3); transition:transform 0.1s, opacity 0.2s;"
                onmousedown="this.style.transform='scale(0.98)'"
                onmouseup="this.style.transform='scale(1)'"
              >
                Unlock & Watch Stream
              </button>
            </form>
          </div>
        </body>
        </html>
      `);
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
    const bindingCode = bindingService.getOrGenerateBindingCode();
    const lic = await licenseService.checkLicenseStatus(bindingCode);

    if (!lic.isActive) {
      ws.close(4003, 'License Revoked');
      return;
    }

    const wsUrl = new URL(req.url, 'http://localhost');
    const pinParam = (wsUrl.searchParams.get('key') || wsUrl.searchParams.get('pin') || wsUrl.searchParams.get('token') || '').trim();
    const tokenParam = wsUrl.searchParams.get('token');
    const remoteIp = req.socket.remoteAddress || '';
    const hostHeader = req.headers.host || '';
    
    const isCloudflareOrRemote = Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (hostHeader && !hostHeader.includes('localhost') && !hostHeader.includes('127.0.0.1')));
    const isLocalHost = !isCloudflareOrRemote && (remoteIp.includes('127.0.0.1') || remoteIp.includes('::1') || remoteIp.includes('localhost') || hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1'));

    const dashboardServer = require('../dashboard/server');
    let isPinValid = false;
    if (isLocalHost) {
      isPinValid = true;
    } else if (pinParam) {
      isPinValid = await licenseService.validateDevicePin(serial, pinParam, bindingCode);
    }
    const isTokenValid = tokenParam && dashboardServer.SESSION_TOKENS && dashboardServer.SESSION_TOKENS.has(tokenParam);
    const isValidWs = isLocalHost || isPinValid || isTokenValid;

    if (!isValidWs) {
      ws.close(4001, 'Unauthorized Stream Access (PIN / Session Token Required)');
      return;
    }

    try { req.socket.setNoDelay(true); } catch (_) {}
    logger.info(`[StreamServer] WS connected for ${serial}`);
    engine.addClient(ws);

    const licCheckTimer = setInterval(async () => {
      const currentLic = await licenseService.checkLicenseStatus(bindingCode);
      if (!currentLic.isActive) {
        engine.removeClient(ws);
        ws.close(4003, 'License Revoked');
        clearInterval(licCheckTimer);
      }
    }, 60000);

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        handleControl(data.type, data, serial, engine);
      } catch (_) {}
    });
    ws.on('close', () => { engine.removeClient(ws); clearInterval(licCheckTimer); });
    ws.on('error', () => { engine.removeClient(ws); clearInterval(licCheckTimer); });
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
  const bindingCode = bindingService.getOrGenerateBindingCode();
  return `${domain}/?udid=${encodeURIComponent(serial)}&pin=${encodeURIComponent(bindingCode)}`;
}

function killStreamServer(streamProcess) {
  if (streamProcess && typeof streamProcess.kill === 'function') {
    try { streamProcess.kill(); } catch (_) {}
  }
}

module.exports = { startStreamServer, buildStreamUrl, killStreamServer };
