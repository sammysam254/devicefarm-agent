'use strict';

const { spawn, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const logger = require('../utils/logger');

const ADB_BIN = (() => {
  const candidates = [
    path.join(process.cwd(), 'assets', 'bin', 'adb.exe'),
    'C:\\platform-tools\\adb.exe',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'adb';
})();

const SCRCPY_JAR_PATH = path.join(process.cwd(), 'scrcpy-server.jar');

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

const _cfg = loadConfig();
const _isTunnel = !!(_cfg.cloudflareToken || _cfg.cloudflaredToken || _cfg.domain);

// Track devices that do not support Android AudioRecord / scrcpy audio to prevent crash loops
const _unsupportedAudioSerials = new Set();


function hasSpsNal(buf) {
  if (!buf || buf.length < 4) return false;
  for (let i = 0; i < Math.min(buf.length - 4, 128); i++) {
    if (buf[i] === 0 && buf[i+1] === 0) {
      if (buf[i+2] === 1 && i + 3 < buf.length) {
        if ((buf[i+3] & 0x1f) === 7) return true;
      } else if (buf[i+2] === 0 && buf[i+3] === 1 && i + 4 < buf.length) {
        if ((buf[i+4] & 0x1f) === 7) return true;
      }
    }
  }
  return false;
}

function hasIdrNal(buf) {
  if (!buf || buf.length < 4) return false;
  for (let i = 0; i < Math.min(buf.length - 4, 128); i++) {
    if (buf[i] === 0 && buf[i+1] === 0) {
      if (buf[i+2] === 1 && i + 3 < buf.length) {
        if ((buf[i+3] & 0x1f) === 5) return true;
      } else if (buf[i+2] === 0 && buf[i+3] === 1 && i + 4 < buf.length) {
        if ((buf[i+4] & 0x1f) === 5) return true;
      }
    }
  }
  return false;
}

/**
 * Extract the encoded frame dimensions directly from an H.264 SPS NAL unit.
 * This is the ground truth — the exact size the scrcpy encoder configured,
 * and the value the server uses to validate INJECT_TOUCH_EVENT dimensions.
 *
 * Reads pic_width_in_mbs_minus1 and pic_height_in_map_units_minus1 from the
 * SPS RBSP. These values encode the picture size in 16-pixel macroblocks.
 * The full formula also accounts for frame_crop_* fields.
 */
function _findSpsStart(buf) {
  for (let i = 0; i < Math.min(buf.length - 4, 256); i++) {
    if (buf[i] === 0 && buf[i+1] === 0) {
      if (buf[i+2] === 1 && (buf[i+3] & 0x1f) === 7) return i + 4;
      if (buf[i+2] === 0 && buf[i+3] === 1 && (buf[i+4] & 0x1f) === 7) return i + 5;
    }
  }
  return -1;
}

function _readUEGolomb(data, bitOffset) {
  // Count leading zeros
  let zeros = 0;
  while (bitOffset < data.length * 8 && !((data[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1)) {
    zeros++;
    bitOffset++;
  }
  bitOffset++; // skip the 1 bit
  if (zeros === 0) return { val: 0, bitOffset };
  let val = 1;
  for (let i = 0; i < zeros; i++) {
    val = (val << 1) | ((data[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1);
    bitOffset++;
  }
  return { val: val - 1, bitOffset };
}

function parseSpsWidth(payload) {
  const start = _findSpsStart(payload);
  if (start < 0 || start + 10 >= payload.length) return 0;
  try {
    let bit = 0;
    const profileIdc = payload[start];
    bit = (start * 8) + 8 + 8 + 8; // skip profile/constraints/level
    
    // seq_parameter_set_id (UE)
    let r = _readUEGolomb(payload, bit); bit = r.bitOffset;
    
    // For profile 100/110/122/244 — these need chroma/bit-depth parsing (skip for now)
    const needsExtended = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138].includes(profileIdc);
    if (needsExtended && start + 20 >= payload.length) return 0;
    
    if (needsExtended) {
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // chroma_format_idc
      if (r.val === 3) bit++; // separate_colour_plane_flag
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // bit_depth_luma_minus8
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // bit_depth_chroma_minus8
      bit++; // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = (payload[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
      if (seqScalingMatrixPresent) return 0; // too complex
    }
    
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // log2_max_frame_num_minus4
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_order_cnt_type
    if (r.val === 0) { r = _readUEGolomb(payload, bit); bit = r.bitOffset; }
    else if (r.val === 1) {
      bit++; // delta_pic_order_always_zero_flag
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // offset_for_non_ref_pic
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // offset_for_top_to_bottom_field
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // num_ref_frames_in_pic_order_cnt_cycle
      for (let i = 0; i < Math.min(r.val, 256); i++) { 
        r = _readUEGolomb(payload, bit); bit = r.bitOffset; 
      }
    }
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // max_num_ref_frames
    bit++; // gaps_in_frame_num_value_allowed_flag
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_width_in_mbs_minus1
    const widthInMbs = r.val + 1;
    return Math.max(16, widthInMbs * 16);
  } catch (err) {
    return 0;
  }
}

function parseSpsHeight(payload) {
  const start = _findSpsStart(payload);
  if (start < 0 || start + 10 >= payload.length) return 0;
  try {
    let bit = 0;
    const profileIdc = payload[start];
    bit = (start * 8) + 8 + 8 + 8;
    
    let r = _readUEGolomb(payload, bit); bit = r.bitOffset; // seq_parameter_set_id
    
    const needsExtended = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138].includes(profileIdc);
    if (needsExtended && start + 20 >= payload.length) return 0;
    
    if (needsExtended) {
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // chroma_format_idc
      if (r.val === 3) bit++;
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // bit_depth_luma_minus8
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // bit_depth_chroma_minus8
      bit++;
      const sm = (payload[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
      if (sm) return 0;
    }
    
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // log2_max_frame_num_minus4
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_order_cnt_type
    if (r.val === 0) { r = _readUEGolomb(payload, bit); bit = r.bitOffset; }
    else if (r.val === 1) {
      bit++;
      r = _readUEGolomb(payload, bit); bit = r.bitOffset;
      r = _readUEGolomb(payload, bit); bit = r.bitOffset;
      r = _readUEGolomb(payload, bit); bit = r.bitOffset;
      for (let i = 0; i < Math.min(r.val, 256); i++) { 
        r = _readUEGolomb(payload, bit); bit = r.bitOffset; 
      }
    }
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // max_num_ref_frames
    bit++;
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_width_in_mbs_minus1
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_height_in_map_units_minus1
    const heightInMapUnits = r.val + 1;
    const frameMbsOnly = (payload[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
    const heightInMbs = frameMbsOnly ? heightInMapUnits : heightInMapUnits * 2;
    let height = heightInMbs * 16;
    
    // Parse frame cropping if present
    bit++; // direct_8x8_inference_flag
    const frameCroppingFlag = (payload[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
    if (frameCroppingFlag && start + 30 < payload.length) {
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // crop_left
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // crop_right
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // crop_top
      const cropBottom = r.val; r = _readUEGolomb(payload, bit); bit = r.bitOffset;
      height -= (cropBottom + r.val) * (frameMbsOnly ? 2 : 4);
    }
    return Math.max(16, height);
  } catch (err) {
    return 0;
  }
}

/**
 * ScrcpyEngine — manages a scrcpy server session for one device.
 *
 * VIDEO MODE: scrcpy streams H264 over the video socket. We relay raw
 * H264 NAL units directly to WebSocket clients. The browser decodes
 * them using the WebCodecs VideoDecoder API.
 *
 * Zero-latency design:
 *  - max_fps=60, max_size=720, bit_rate=4Mbps
 *  - send_frame_meta=true so we can strip the 12-byte header cleanly
 *  - SPS/PPS config packet sent immediately to every new client
 *  - Backpressure threshold lowered to 64KB (was 512KB) to avoid jitter
 */
class ScrcpyEngine extends EventEmitter {
  constructor(serial) {
    super();
    this.serial        = serial;
    this.serverProc    = null;
    this.videoSocket   = null;
    this.controlSocket = null;
    this.isRunning     = false;
    this.videoPort     = null;

    // Device dimensions — populated by scrcpy stdout and video header
    // Initialize to common Android portrait defaults so commands don't fail before stream starts
    this.screenWidth  = 1080;
    this.screenHeight = 2340;

    // Connected WS clients receiving H264 stream & audio
    this.wsClients = new Set();
    this._configPacket = null;
    this._keyframeBuffer = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.serverVideoWidth = 0;
    this.serverVideoHeight = 0;
    this.isAndroid15 = false;
    this._jarPushed = false;
    this._screencapActive = false;
    this.enableAudio = !_unsupportedAudioSerials.has(serial);
    this._audioDisabled = _unsupportedAudioSerials.has(serial);
    this.audioSocket = null;

    // Intelligent in-place auto-healing & resilience state
    this._watchdogTimer = null;
    this._keepAwakeTimer = null;
    this._healingInProgress = false;
    this._healAttemptCount = 0;
    this._lastHealTime = Date.now();
    this._startTime = Date.now();
    this._lastFrameTime = Date.now();
  }

  get isReady() {
    return this.isRunning && this.controlSocket && !this.controlSocket.destroyed;
  }

  /**
   * Register a WS client. We immediately flush the cached SPS/PPS + IDR keyframe
   * so the WebCodecs decoder is initialised before any new delta frame arrives.
   */
  addClient(ws) {
    this.wsClients.add(ws);
    // Send cached SPS/PPS config & IDR keyframe immediately so WebCodecs decodes instantly
    const initialPacket = this._keyframeBuffer || this._configPacket;
    if (initialPacket && ws.readyState === 1) {
      try { ws.send(initialPacket, { binary: true }); } catch (_) {}
    }
    // Nudge Android window compositor with WAKEUP (224) and dismiss-keyguard
    try {
      this._adb(['shell', 'input', 'keyevent', '224']).catch(() => {});
      this._adb(['shell', 'wm', 'dismiss-keyguard']).catch(() => {});
      this._adb(['shell', 'svc', 'power', 'stayon', 'true']).catch(() => {});
    } catch (_) {}
  }

  removeClient(ws) {
    this.wsClients.delete(ws);
  }

  async _pushServerJar() {
    if (this._jarPushed) return;
    if (!fs.existsSync(SCRCPY_JAR_PATH)) {
      logger.error(`[ScrcpyEngine ${this.serial}] CRITICAL: ${SCRCPY_JAR_PATH} not found!`);
      throw new Error(`scrcpy-server.jar missing at ${SCRCPY_JAR_PATH}`);
    }
    logger.info(`[ScrcpyEngine ${this.serial}] Pushing scrcpy-server.jar to /data/local/tmp/scrcpy-server.jar...`);
    await this._adb(['push', SCRCPY_JAR_PATH, '/data/local/tmp/scrcpy-server.jar']);
    this._jarPushed = true;
    logger.info(`[ScrcpyEngine ${this.serial}] scrcpy-server.jar pushed successfully`);
  }

  async start(videoPort) {
    if (this.isRunning) return;
    this.videoPort = videoPort;
    this.isRunning = true;
    this._startTime = Date.now();
    this._lastHealTime = Date.now();

    try {
      // 0. Clean port forward
      try {
        await this._adb(['forward', '--remove', `tcp:${this.videoPort}`]).catch(() => {});
      } catch (_) {}

      // Wake display, keep screen on, and unlock so hardware H.264 encoder never feeds black frames
      try {
        await this._adb(['shell', 'svc', 'power', 'stayon', 'true']).catch(() => {});
        await this._adb(['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '3']).catch(() => {});
        await this._adb(['shell', 'input', 'keyevent', '224']).catch(() => {}); // KEYCODE_WAKEUP
        await this._adb(['shell', 'wm', 'dismiss-keyguard']).catch(() => {});  // Dismiss keyguard
      } catch (_) {}

      // 1. Fetch real screen dimensions
      try {
        const out = await this._adb(['shell', 'wm', 'size']);
        const m = out.match(/Physical size:\s*(\d+)x(\d+)/);
        if (m) {
          this.screenWidth  = parseInt(m[1], 10);
          this.screenHeight = parseInt(m[2], 10);
        }
      } catch (_) {}
      logger.info(`[ScrcpyEngine ${this.serial}] Screen: ${this.screenWidth}x${this.screenHeight}`);

      // Pre-calculate target video dimensions based on max_size=1280
      // scrcpy scales so max(w,h) <= 1280, aligning minor dimension to multiple of 8
      const maxDim = 1280;
      const major = Math.max(this.screenWidth, this.screenHeight);
      const minor = Math.min(this.screenWidth, this.screenHeight);
      if (major > maxDim) {
        const scaledMinor = Math.round((minor * maxDim) / major) & ~7;
        if (this.screenWidth > this.screenHeight) {
          this.videoWidth  = maxDim;
          this.videoHeight = scaledMinor;
        } else {
          this.videoWidth  = scaledMinor;
          this.videoHeight = maxDim;
        }
      } else {
        this.videoWidth  = this.screenWidth;
        this.videoHeight = this.screenHeight;
      }
      logger.info(`[ScrcpyEngine ${this.serial}] Pre-negotiated video dimensions: ${this.videoWidth}x${this.videoHeight}`);

      // 2. Push scrcpy-server.jar to device
      await this._pushServerJar();

      // 3. Setup ADB port forwarding for scrcpy
      try { await this._adb(['forward', '--remove', `tcp:${this.videoPort}`]); } catch (_) {}
      await this._adb(['forward', `tcp:${this.videoPort}`, 'localabstract:scrcpy']);

      // 4. Spawn scrcpy-server process on device
      this._spawnServer();

      // 5. Connect video and control sockets
      await this._connectSockets();

      // 6. Keep Android display awake
      this._startKeepAwakeLoop();

      logger.info(`[ScrcpyEngine ${this.serial}] High-speed 60FPS Scrcpy H264 engine active`);

    } catch (err) {
      logger.warn(`[ScrcpyEngine ${this.serial}] Scrcpy start failed: ${err.message}`);
    }
  }

  _spawnServer() {
    // Diagnostic: verify scrcpy-server.jar exists before spawning
    if (!fs.existsSync(SCRCPY_JAR_PATH)) {
      logger.error(`[ScrcpyEngine ${this.serial}] CRITICAL: ${SCRCPY_JAR_PATH} not found! Streaming will fail.`);
      logger.error(`[ScrcpyEngine ${this.serial}] Download from: https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4`);
    }

    let bitRate = _isTunnel ? '1500000' : '3500000';
    let maxFps  = _isTunnel ? '30' : '60';
    let maxSize = _isTunnel ? '960' : '1280';

    if (this._healAttemptCount >= 2) {
      bitRate = '1200000';
      maxFps  = '24';
      maxSize = '800';
      logger.info(`[ScrcpyEngine ${this.serial}] Using compatibility profile (800 max size, 24 fps, 1.2Mbps)`);
    } else if (_isTunnel) {
      logger.info(`[ScrcpyEngine ${this.serial}] Tunnel mode active — using ${bitRate} bps / ${maxFps} fps / max_size=${maxSize}`);
    }

    if (_unsupportedAudioSerials.has(this.serial) || this._healAttemptCount >= 1) {
      this.enableAudio = false;
      this._audioDisabled = true;
    }
    const audioEnabled = Boolean(this.enableAudio && !this._audioDisabled);

    const args = [
      '-s', this.serial, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/', 'com.genymobile.scrcpy.Server', '2.4',
      'tunnel_forward=true',
      'audio=' + (audioEnabled ? 'true' : 'false'),
    ];
    if (audioEnabled) {
      args.push('audio_codec=opus', 'audio_bit_rate=128000');
    }
    args.push(
      'control=true',
      'cleanup=true',
      'send_dummy_byte=true',
      'video_source=display',
      `video_bit_rate=${bitRate}`,
      `max_size=${maxSize}`,
      `max_fps=${maxFps}`,
      'video_codec_options=i-frame-interval=1',
      'send_frame_meta=true',
      'show_touches=false',
      'stay_awake=true',
    );

    logger.info(`[ScrcpyEngine ${this.serial}] Spawning scrcpy server with args: ${args.slice(2).join(' ')}`);

    if (this.serverProc) {
      const oldProc = this.serverProc;
      this.serverProc = null;
      try {
        oldProc.removeAllListeners();
        if (oldProc.stdout) oldProc.stdout.removeAllListeners();
        if (oldProc.stderr) oldProc.stderr.removeAllListeners();
        if (oldProc.pid) {
          try { oldProc.kill('SIGTERM'); } catch (_) { try { process.kill(oldProc.pid); } catch (_) {} }
        }
      } catch (_) {}
    }

    const currentProc = spawn(ADB_BIN, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.serverProc = currentProc;

    // Return a Promise that resolves when scrcpy prints its "Device:" ready line.
    // This avoids the race condition where we connect sockets before the server is ready.
    this._serverReady = new Promise((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      if (!this._audioDisabled) {
        this._audioActive = false;
      }

      this.serverProc.stdout.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) logger.info(`[ScrcpyEngine ${this.serial}] stdout: ${msg}`);
        const lower = msg.toLowerCase();
        if (lower.includes('audio disabled')) {
          _unsupportedAudioSerials.add(this.serial);
          this._audioDisabled = true;
          this.enableAudio = false;
          this._audioActive = false;
          logger.warn(`[ScrcpyEngine ${this.serial}] Audio capture disabled by device`);
          done();
        }
        if (lower.includes('using audio encoder') || lower.includes('audio codec')) {
          this._audioActive = true;
          this._audioDisabled = false;
          logger.info(`[ScrcpyEngine ${this.serial}] Audio encoder confirmed active`);
          done();
        }
        if (lower.includes('using video encoder')) {
          setTimeout(done, 250);
        }
        if (lower.includes('android 15')) {
          this.isAndroid15 = true;
          logger.info(`[ScrcpyEngine ${this.serial}] Android 15 detected`);
        }
        // scrcpy prints "Device: <model> (<WxH>)" once the encoder is initialised.
        // Parse the negotiated resolution so touch events use the exact same dimensions.
        const dimMatch = msg.match(/\((\d+)x(\d+)\)/);
        if (dimMatch) {
          const sw = parseInt(dimMatch[1], 10);
          const sh = parseInt(dimMatch[2], 10);
          if (sw > 0 && sh > 0) {
            this.serverVideoWidth  = sw;
            this.serverVideoHeight = sh;
            this.videoWidth  = sw;
            this.videoHeight = sh;
            logger.info(`[ScrcpyEngine ${this.serial}] Server-negotiated resolution: ${sw}x${sh}`);
          }
        }
        if (!audioEnabled && (msg.includes('Device:') || msg.includes('device:'))) done();
        else if (msg.includes('Device:') || msg.includes('device:')) {
          setTimeout(done, 1200); // Allow audio encoder check to run if present
        }
      });

      this.serverProc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) logger.warn(`[ScrcpyEngine ${this.serial}] stderr: ${msg}`);
        const lower = msg.toLowerCase();
        if (
          lower.includes('audio disabled') ||
          lower.includes('aborted') ||
          lower.includes('audiorecord') ||
          lower.includes('audio error') ||
          lower.includes('could not start audio')
        ) {
          _unsupportedAudioSerials.add(this.serial);
          this._audioDisabled = true;
          this.enableAudio = false;
          this._audioActive = false;
          logger.warn(`[ScrcpyEngine ${this.serial}] Audio capture unsupported on device (stderr: ${msg}) — audio disabled permanently`);
          done();
        }
        if (msg.includes('Address already in use')) {
          logger.warn(`[ScrcpyEngine ${this.serial}] Socket conflict on device — releasing port forward`);
          this._adb(['forward', '--remove', `tcp:${this.videoPort}`]).catch(() => {});
        }
      });

      // Safety timeout — if no ready signal within 3.5s, proceed anyway
      setTimeout(done, 3500);
    });

    this.serverProc.on('error', (e) => {
      logger.error(`[ScrcpyEngine ${this.serial}] proc error: ${e.message}`);
    });

    this._procStartTime = Date.now();
    this._restartPending = false;

    currentProc.on('close', (code) => {
      // CRITICAL: ignore if this is an old superseded process, or engine stopped, or healing already in progress
      if (this.serverProc !== currentProc) return;
      if (!this.isRunning || this._healingInProgress) return;

      const uptime = Date.now() - this._procStartTime;
      logger.warn(`[ScrcpyEngine ${this.serial}] scrcpy proc exited (code=${code}, uptime=${uptime}ms)`);

      if (code === 134 || uptime < 3000) {
        _unsupportedAudioSerials.add(this.serial);
        this._audioDisabled = true;
        this.enableAudio = false;
      }
    });
  }

  isHealthy() {
    if (!this.isRunning) return false;
    if (this._healingInProgress) return true; // Actively healing in-place, do NOT kill device session
    // Startup grace period (30s) while scrcpy initializes
    if (this._startTime && Date.now() - this._startTime < 30000) return true;
    // If video socket is active and not destroyed, and process has not exited
    if (this.videoSocket && !this.videoSocket.destroyed) {
      if (!this.serverProc || (this.serverProc.exitCode === null && !this.serverProc.killed)) {
        return true;
      }
    }
    return false;
  }

  stop() {
    this.isRunning = false;
    this._healingInProgress = false;
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._keepAwakeTimer) {
      clearInterval(this._keepAwakeTimer);
      this._keepAwakeTimer = null;
    }
    this._screencapActive = false;
    this._cleanup();
    this.wsClients.clear();
    this.emit('stopped');
  }

  _cleanup() {
    if (this.videoSocket) {
      try { this.videoSocket.destroy(); } catch (_) {}
      this.videoSocket = null;
    }
    if (this.controlSocket) {
      try { this.controlSocket.destroy(); } catch (_) {}
      this.controlSocket = null;
    }
    if (this.serverProc) {
      const sp = this.serverProc;
      this.serverProc = null;
      try {
        if (sp.pid) {
          try { sp.kill('SIGTERM'); } catch (_) { try { process.kill(sp.pid); } catch (_) {} }
        }
      } catch (_) {}
    }
  }

  // ── Socket connection ─────────────────────────────────────────────────────

  async _connectSockets() {
    // Wait for scrcpy server to print its "Device:" ready signal before connecting.
    // This eliminates the race condition where we connected before the server was ready.
    logger.info(`[ScrcpyEngine ${this.serial}] Waiting for scrcpy server ready signal...`);
    if (this._serverReady) await this._serverReady;

    // Small additional buffer to ensure the ADB forward socket is fully open
    await new Promise(r => setTimeout(r, 200));

    logger.info(`[ScrcpyEngine ${this.serial}] Connecting video socket...`);
    // tunnel_forward socket 1 = video stream
    this.videoSocket = await this._connectOne(this.videoPort);
    this.videoSocket.setNoDelay(true);
    this.videoSocket.setKeepAlive(true, 1000);
    this._pipeVideoToClients(this.videoSocket);

    await new Promise(r => setTimeout(r, 150));

    // tunnel_forward socket 2 = audio stream (when audio=true and not disabled by device)
    const audioEligible = Boolean(this.enableAudio && !this._audioDisabled && !_unsupportedAudioSerials.has(this.serial));
    if (audioEligible) {
      try {
        logger.info(`[ScrcpyEngine ${this.serial}] Connecting audio socket...`);
        this.audioSocket = await this._connectOne(this.videoPort, 15);
        this.audioSocket.setNoDelay(true);
        this._pipeAudioToClients(this.audioSocket);
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Audio socket notice: ${err.message}`);
        this.audioSocket = null;
      }
    }

    // Next socket = control socket
    logger.info(`[ScrcpyEngine ${this.serial}] Connecting control socket...`);
    try {
      this.controlSocket = await this._connectOne(this.videoPort, 20);
      this.controlSocket.setNoDelay(true);
      this.controlSocket.setKeepAlive(true, 1000);
    } catch (err) {
      // Self-healing recovery: if control socket on connection 3 failed but socket 2 was connected,
      // it means socket 2 was actually the control socket (server disabled audio internally).
      if (this.audioSocket) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Re-routing socket 2 to control socket (device disabled audio)`);
        this.controlSocket = this.audioSocket;
        this.audioSocket = null;
        this.controlSocket.removeAllListeners('data');
        this.controlSocket.setNoDelay(true);
        this.controlSocket.setKeepAlive(true, 1000);
      } else {
        throw err;
      }
    }

    this.controlSocket.on('close', () => { this.controlSocket = null; });
    this.controlSocket.on('error', () => { this.controlSocket = null; });
  }

  _connectOne(port, retries = 50) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        let settled = false;
        const s = net.connect({ port, host: '127.0.0.1' }, () => {
          // If socket closes within 35ms, remote forward target was closed by scrcpy
          const onEarlyClose = () => {
            if (settled) return;
            settled = true;
            s.destroy();
            if (n <= 0) return reject(new Error(`Socket closed immediately on port ${port}`));
            setTimeout(() => attempt(n - 1), 150);
          };
          s.once('close', onEarlyClose);
          setTimeout(() => {
            if (!settled) {
              s.removeListener('close', onEarlyClose);
              if (!s.destroyed) {
                settled = true;
                resolve(s);
              } else {
                settled = true;
                if (n <= 0) reject(new Error(`Socket destroyed on port ${port}`));
                else setTimeout(() => attempt(n - 1), 150);
              }
            }
          }, 35);
        });
        s.on('error', (e) => {
          if (settled) return;
          settled = true;
          s.destroy();
          if (n <= 0) return reject(new Error(`Timeout connecting to port ${port}: ${e.message}`));
          setTimeout(() => attempt(n - 1), 150);
        });
      };
      attempt(retries);
    });
  }

  /**
   * Relay raw H264 NAL units from the video socket to all WS clients.
   * Zero-copy buffer slicing & minimal latency stream pipeline.
   */
  _pipeVideoToClients(socket) {
    let buf = Buffer.alloc(0);
    let headerDone = false;
    this._lastFrameTime = Date.now();
    const DEVICE_HEADER_LEN = 77;
    const META = 12; // 8-byte PTS + 4-byte size

    socket.on('data', (chunk) => {
      this._lastFrameTime = Date.now();
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

      // 1. Skip the device-info header exactly once & parse real video stream size
      if (!headerDone) {
        if (buf.length < DEVICE_HEADER_LEN) return;

        try {
          // scrcpy 2.4 video socket header layout (77 bytes total):
          //   [0]      dummy byte (0x00)
          //   [1-4]    codec ID ASCII ("h264")
          //   [5-68]   device name, 64 bytes null-padded
          //   [69-72]  uint32 BE — negotiated encoder width
          //   [73-76]  uint32 BE — negotiated encoder height
          const w = buf.readUInt32BE(69);
          const h = buf.readUInt32BE(73);
          if (w > 0 && h > 0 && w < 10000 && h < 10000) {
            this.serverVideoWidth = w;
            this.serverVideoHeight = h;
            this.videoWidth = w;
            this.videoHeight = h;
            logger.info(`[ScrcpyEngine ${this.serial}] Scrcpy stream resolution: ${w}x${h}`);
          }
        } catch (_) {}

        if (buf.length >= DEVICE_HEADER_LEN + META) {
          const firstPktSize = buf.readUInt32BE(DEVICE_HEADER_LEN + 8);
          if (firstPktSize === 0 || firstPktSize > 2 * 1024 * 1024) {
            logger.warn(`[ScrcpyEngine ${this.serial}] Unexpected first packet size ${firstPktSize} — trying 1-byte header`);
            buf = buf.subarray(1);
          } else {
            buf = buf.subarray(DEVICE_HEADER_LEN);
          }
        } else {
          buf = buf.subarray(DEVICE_HEADER_LEN);
        }

        logger.info(`[ScrcpyEngine ${this.serial}] Device-info header consumed, stream parsing started`);
        headerDone = true;
      }

      // 2. Process video frame packets zero-copy
      while (buf.length >= META) {
        const pktSize = buf.readUInt32BE(8);
        if (buf.length < META + pktSize) break;

        const ptsHigh  = buf.readUInt32BE(0);
        const payload  = buf.subarray(META, META + pktSize);
        buf = buf.subarray(META + pktSize);

        const isSps = hasSpsNal(payload);
        const isIdr = hasIdrNal(payload);
        const isConfig = isSps || (ptsHigh & 0x80000000) !== 0;
        const isKeyframe = isConfig || isIdr || isSps;

        if (isSps || (isConfig && !this._configPacket)) {
          this._configPacket = Buffer.from(payload);
          logger.info(`[ScrcpyEngine ${this.serial}] SPS/PPS config cached (${payload.length} bytes)`);

          // Parse width/height from SPS NAL — the most authoritative source.
          // If parsing fails, keep the dimensions we already have.
          try {
            const spsW = parseSpsWidth(payload);
            const spsH = parseSpsHeight(payload);
            if (spsW > 16 && spsH > 16 && spsW < 10000 && spsH < 10000) {
              if (this.videoWidth !== spsW || this.videoHeight !== spsH) {
                logger.info(`[ScrcpyEngine ${this.serial}] SPS resolution: ${spsW}x${spsH} (previously ${this.videoWidth}x${this.videoHeight})`);
              }
              this.videoWidth        = spsW;
              this.videoHeight       = spsH;
              this.serverVideoWidth  = spsW;
              this.serverVideoHeight = spsH;
              this.isLandscape       = spsW > spsH;
            } else {
              logger.warn(`[ScrcpyEngine ${this.serial}] SPS parse gave invalid dims ${spsW}x${spsH}, keeping ${this.videoWidth}x${this.videoHeight}`);
            }
          } catch (err) {
            logger.warn(`[ScrcpyEngine ${this.serial}] SPS parse error: ${err.message}`);
          }
        }

        if (isIdr) {
          if (this._configPacket && !hasSpsNal(payload)) {
            this._keyframeBuffer = Buffer.concat([this._configPacket, payload]);
          } else {
            this._keyframeBuffer = Buffer.from(payload);
          }
        }

        this._broadcastVideo(payload, isKeyframe);
      }

      // Safety reset
      if (buf.length > 1024 * 1024) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Buffer overflow — resetting`);
        buf = Buffer.alloc(0);
      }
    });

    const currentSocket = socket;
    socket.on('close', () => {
      if (this.videoSocket !== currentSocket) return;
      logger.warn(`[ScrcpyEngine ${this.serial}] Video socket closed`);
      this.videoSocket = null;
    });

    socket.on('error', (e) => {
      if (this.videoSocket !== currentSocket) return;
      logger.warn(`[ScrcpyEngine ${this.serial}] Video socket error: ${e.message}`);
      this.videoSocket = null;
    });
  }

  _pipeAudioToClients(socket) {
    let buf = Buffer.alloc(0);
    let headerDone = false;

    socket.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

      if (!headerDone) {
        // Scrcpy 2.x sends: 1 dummy byte (0x00) + 4-byte codec ID (e.g. "opus")
        // Total header = 5 bytes minimum
        if (buf.length < 5) return;

        let offset = 0;
        if (buf[0] === 0x00) offset = 1;

        const codecStr = buf.toString('utf8', offset, offset + 4).toLowerCase().trim().replace(/\0/g, '');
        logger.info(`[ScrcpyEngine ${this.serial}] Audio codec header detected: "${codecStr}"`);
        this._audioCodec = codecStr; // 'opus' or 'raw'
        buf = buf.subarray(offset + 4);
        headerDone = true;
      }

      const META = 12; // 8-byte PTS + 4-byte size
      while (buf.length >= META) {
        const pktSize = buf.readUInt32BE(8);
        if (pktSize === 0 || pktSize > 512 * 1024) {
          buf = buf.subarray(1);
          continue;
        }
        if (buf.length < META + pktSize) break;
        const payload = buf.subarray(META, META + pktSize);
        buf = buf.subarray(META + pktSize);
        this._broadcastAudio(payload);
      }
    });
    socket.on('close', () => { this.audioSocket = null; });
    socket.on('error', (e) => {
      logger.warn(`[ScrcpyEngine ${this.serial}] Audio socket error: ${e.message}`);
      this.audioSocket = null;
    });
  }

  _broadcastAudio(payload) {
    // Frame layout: [0x41][codec_byte][...payload]
    // codec_byte: 0x4F ('O') = opus, 0x52 ('R') = raw PCM
    const codec = (this._audioCodec === 'opus') ? 0x4F : 0x52;
    const audioFrame = Buffer.allocUnsafe(2 + payload.length);
    audioFrame[0] = 0x41; // 'A' = audio frame tag
    audioFrame[1] = codec; // 'O' = opus, 'R' = raw
    payload.copy(audioFrame, 2);

    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(audioFrame, { binary: true }); } catch (_) {}
      }
    }
  }

  _broadcastVideo(payload, isKeyframe = false) {
    const BACKPRESSURE_LIMIT = 64 * 1024; // 64 KB (prevents multi-second buffer bloat and lag)
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        if (isKeyframe || ws.bufferedAmount < BACKPRESSURE_LIMIT) {
          try { ws.send(payload, { binary: true }); } catch (_) { this.wsClients.delete(ws); }
        }
      } else {
        this.wsClients.delete(ws);
      }
    }
  }

  /**
   * Simple, reliable screencap streaming.
   * Captures PNG screenshots continuously and sends as base64 to clients.
   * ~10-15 fps, works on all devices, no codec issues.
   */
  _startScreencapStream() {
    if (this._screencapActive) return;
    this._screencapActive = true;

    const captureLoop = async () => {
      while (this._screencapActive && this.isRunning) {
        try {
          const startTime = Date.now();
          
          // Capture screenshot
          const proc = spawn(ADB_BIN, ['-s', this.serial, 'exec-out', 'screencap -p'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore']
          });

          const chunks = [];
          proc.stdout.on('data', c => chunks.push(c));
          
          await new Promise((resolve) => {
            proc.on('close', () => resolve());
            proc.on('error', () => resolve());
          });

          if (chunks.length > 0) {
            // exec-out via spawn stdio:pipe delivers clean binary — no CRLF stripping needed
            const pngData = Buffer.concat(chunks);
            
            // Send to all connected clients
            for (const ws of this.wsClients) {
              if (ws.readyState === 1) {
                try {
                  ws.send(pngData, { binary: true });
                } catch (_) {
                  this.wsClients.delete(ws);
                }
              } else {
                this.wsClients.delete(ws);
              }
            }
          }

          // Maintain ~15 fps (67ms per frame)
          const elapsed = Date.now() - startTime;
          const delay = Math.max(1, 67 - elapsed);
          await new Promise(r => setTimeout(r, delay));

        } catch (err) {
          logger.warn(`[ScrcpyEngine ${this.serial}] Screencap error: ${err.message}`);
          await new Promise(r => setTimeout(r, 100));
        }
      }
    };

    captureLoop();
    logger.info(`[ScrcpyEngine ${this.serial}] Screencap streaming started`);
  }

  // ── Control protocol ──────────────────────────────────────────────────────

  /**
   * INJECT_TOUCH_EVENT (32 bytes, scrcpy 2.x)
   *   [0]     msg type = 2
   *   [1]     action: 0=DOWN 1=UP 2=MOVE
   *   [2-9]   pointer id i64BE (-1 = virtual)
   *   [10-13] x i32BE
   *   [14-17] y i32BE
   *   [18-19] screen width u16BE
   *   [20-21] screen height u16BE
   *   [22-23] pressure u16BE (0xFFFF = 1.0)
   *   [24-27] action_button i32BE (1=PRIMARY on DOWN)
   *   [28-31] buttons i32BE (1 on DOWN/MOVE, 0 on UP)
   */
  sendTouchEvent(action, x, y, width, height, pressure = 1.0) {
    if (!this.controlSocket || this.controlSocket.destroyed) {
      return false;
    }

    // Determine target coordinate space (matching current video orientation).
    // If client supplied width & height, (x, y) is already mapped directly in that coordinate space.
    const targetW = (width > 10) ? Math.round(width) : (this.videoWidth || this.serverVideoWidth || 720);
    const targetH = (height > 10) ? Math.round(height) : (this.videoHeight || this.serverVideoHeight || 1600);

    let finalX, finalY;
    if (width > 10 && height > 10 && (width !== targetW || height !== targetH)) {
      finalX = Math.round((x / width) * targetW);
      finalY = Math.round((y / height) * targetH);
    } else {
      finalX = Math.round(x);
      finalY = Math.round(y);
    }

    // Clamp strictly within [0, targetW - 1] and [0, targetH - 1]
    finalX = Math.max(0, Math.min(targetW - 1, finalX));
    finalY = Math.max(0, Math.min(targetH - 1, finalY));

    const buf = Buffer.allocUnsafe(32);
    buf.writeUInt8(2, 0);                 // INJECT_TOUCH_EVENT
    buf.writeUInt8(action, 1);            // 0=DOWN, 1=UP, 2=MOVE
    buf.writeBigInt64BE(-2n, 2);          // pointerId -2n (POINTER_ID_GENERIC_FINGER)
    buf.writeInt32BE(finalX, 10);
    buf.writeInt32BE(finalY, 14);
    buf.writeUInt16BE(targetW, 18);
    buf.writeUInt16BE(targetH, 20);
    buf.writeUInt16BE(action === 1 ? 0 : Math.floor(pressure * 65535), 22);
    buf.writeInt32BE(0, 24);              // action_button = 0 (STRICT requirement for touch on Android 14/15)
    buf.writeInt32BE(0, 28);              // buttons = 0 (STRICT requirement: touch events MUST NOT have button state on Android 14/15)
    try {
      this.controlSocket.cork();
      this.controlSocket.write(buf);
      this.controlSocket.uncork();
      return true;
    } catch (e) { 
      logger.warn(`[ScrcpyEngine ${this.serial}] touch write failed: ${e.message}`);
      return false; 
    }
  }

  /**
   * Rotate Device screen via scrcpy control message 11 (SC_CONTROL_MSG_TYPE_ROTATE_DEVICE)
   */
  rotateDevice() {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    try {
      const buf = Buffer.allocUnsafe(1);
      buf.writeUInt8(11, 0); // SC_CONTROL_MSG_TYPE_ROTATE_DEVICE = 11
      this.controlSocket.write(buf);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * INJECT_KEYCODE (14 bytes)
   *   [0]     msg type = 0
   *   [1]     action 0=DOWN 1=UP
   *   [2-5]   keycode i32BE
   *   [6-9]   repeat i32BE
   *   [10-13] metastate i32BE
   */
  sendKeycode(action, keycode, repeat = 0, metastate = 0) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    const buf = Buffer.allocUnsafe(14);
    buf.writeUInt8(0, 0);
    buf.writeUInt8(action, 1);
    buf.writeInt32BE(keycode, 2);
    buf.writeInt32BE(repeat, 6);
    buf.writeInt32BE(metastate, 10);
    try { this.controlSocket.write(buf); return true; }
    catch (_) { return false; }
  }

  /**
   * INJECT_TEXT (variable)
   *   [0]     msg type = 1
   *   [1-4]   text length i32BE
   *   [5...]  UTF-8 text
   */
  sendText(text) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    const tb = Buffer.from(text, 'utf-8');
    const buf = Buffer.allocUnsafe(5 + tb.length);
    buf.writeUInt8(1, 0);
    buf.writeInt32BE(tb.length, 1);
    tb.copy(buf, 5);
    try { this.controlSocket.write(buf); return true; }
    catch (_) { return false; }
  }

  // ── Reconnect / restart ───────────────────────────────────────────────────

  async _reconnectControl() {
    if (!this.isRunning) return;
    try {
      const cs = await this._connectOne(this.videoPort, 10);
      cs.setNoDelay(true);
      cs.setKeepAlive(true, 1000);
      this.controlSocket = cs;
      cs.on('close', () => {
        this.controlSocket = null;
        if (this.isRunning) setTimeout(() => this._reconnectControl(), 300);
      });
      cs.on('error', () => { this.controlSocket = null; });
    } catch (_) {
      if (this.isRunning) setTimeout(() => this._reconnectControl(), 1000);
    }
  }

  // ── Reset stream state on restart ────────────────────────────────────────
  _resetStreamState() {
    this._configPacket   = null;
    this._keyframeBuffer = null;
    // Notify all connected browsers to reset their decoders
    const resetMsg = Buffer.from(JSON.stringify({ type: 'stream_reset' }));
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(resetMsg); } catch (_) {}
      }
    }
  }

  // ── Engine-Level Persistent Watchdog & Keepalive ──────────────────────────

  _startEngineWatchdog() {
    // Disabled — strict no-self-heal policy
  }

  _startKeepAwakeLoop() {
    if (this._keepAwakeTimer) clearInterval(this._keepAwakeTimer);
    // Keep Android display permanently awake and unlocked without causing ADB process storms
    const applyWakeAndUnlock = async () => {
      if (!this.isRunning) return;
      try {
        await this._adb(['shell', 'input keyevent 224 && wm dismiss-keyguard']).catch(() => {});
      } catch (_) {}
    };

    // Run every 5 minutes (300,000ms) - initial setup was already completed in start()
    this._keepAwakeTimer = setInterval(applyWakeAndUnlock, 300000);
  }

  _broadcastControlMessage(msgObj) {
    const raw = Buffer.from(JSON.stringify(msgObj));
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(raw); } catch (_) {}
      }
    }
  }

  // ── Intelligent In-Place Auto-Healing (Never Drops Stream Server or Port) ────

  async autoHeal(reason = 'watchdog') {
    // Completely removed as requested by user — strict zero self-healing
    return false;
  }

  async _restart() {
    return this.autoHeal('manual_restart_requested');
  }

  _adb(args) {
    return new Promise((resolve, reject) => {
      execFile(ADB_BIN, ['-s', this.serial, ...args], { timeout: 10000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout || '');
      });
    });
  }
}

module.exports = ScrcpyEngine;
