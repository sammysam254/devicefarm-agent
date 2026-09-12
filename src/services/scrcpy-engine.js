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
  for (let i = 0; i < Math.min(buf.length - 4, 1024); i++) {
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
    this.scrcpyServerWidth = 0;
    this.scrcpyServerHeight = 0;
    this._jarPushed = false;
    this._screencapActive = false;
    this.enableAudio = true;
    this._audioDisabled = false;
    this._audioReady = false;
    this._audioCodec = 'opus';
    this.audioSocket = null;
  }

  get isReady() {
    return this.isRunning && this.controlSocket && !this.controlSocket.destroyed;
  }

  _captureSnapshot() {
    return new Promise((resolve) => {
      const p = spawn(ADB_BIN, ['-s', this.serial, 'exec-out', 'screencap -p'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const chunks = [];
      p.stdout.on('data', c => chunks.push(c));
      p.on('close', code => {
        if (code !== 0 || !chunks.length) return resolve(null);
        resolve(Buffer.concat(chunks));
      });
      p.on('error', () => resolve(null));
    });
  }

  /**
   * Register a WS client. We immediately flush the cached SPS/PPS + IDR keyframe
   * so the WebCodecs decoder is initialised before any new delta frame arrives.
   */
  addClient(ws) {
    this.wsClients.add(ws);
    // Send exactly one bootstrap packet: the combined SPS/PPS+IDR keyframe if available,
    // otherwise just the SPS/PPS config. Sending both separately causes duplicate-init
    // errors in WebCodecs VideoDecoder which can leave the decoder in a broken state.
    if (ws.readyState === 1) {
      const bootstrap = this._keyframeBuffer || this._configPacket;
      if (bootstrap) {
        try { ws.send(bootstrap, { binary: true }); } catch (_) {}
      }
    }
    // Nudge Android window compositor to immediately produce a fresh IDR keyframe
    try {
      this._adb(['shell', 'input', 'keyevent', '0']).catch(() => {});
    } catch (_) {}

    // Instant screen paint: send snapshot if no keyframe buffer is cached yet
    if (!this._keyframeBuffer) {
      this._captureSnapshot().then(buf => {
        if (buf && ws.readyState === 1) {
          try { ws.send(buf, { binary: true }); } catch (_) {}
        }
      }).catch(() => {});
    }
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

    try {
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

      // 2. Push scrcpy-server.jar to device
      await this._pushServerJar();

      // 3. Setup ADB port forwarding for scrcpy
      try { await this._adb(['forward', '--remove', `tcp:${this.videoPort}`]); } catch (_) {}
      await this._adb(['forward', `tcp:${this.videoPort}`, 'localabstract:scrcpy']);

      // 4. Spawn scrcpy-server process on device
      this._spawnServer();

      // 5. Connect video and control sockets
      await this._connectSockets();

      logger.info(`[ScrcpyEngine ${this.serial}] High-speed 60FPS Scrcpy H264 engine active`);

    } catch (err) {
      logger.warn(`[ScrcpyEngine ${this.serial}] Scrcpy start failed: ${err.message} — will retry in 3s`);
      setTimeout(() => { if (this.isRunning) this._restart(); }, 3000);
    }
  }

  _spawnServer() {
    // Diagnostic: verify scrcpy-server.jar exists before spawning
    if (!fs.existsSync(SCRCPY_JAR_PATH)) {
      logger.error(`[ScrcpyEngine ${this.serial}] CRITICAL: ${SCRCPY_JAR_PATH} not found! Streaming will fail.`);
      logger.error(`[ScrcpyEngine ${this.serial}] Download from: https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4`);
    }

    const args = [
      '-s', this.serial, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/', 'com.genymobile.scrcpy.Server', '2.4',
      'tunnel_forward=true',
      'audio=' + (this.enableAudio ? 'true' : 'false'),
      'require_audio=false',       // Critical: audio failure or focus switch must NEVER crash video streaming
      'audio_codec=opus',
      'audio_bit_rate=128000',
      'control=true',
      'cleanup=false',
      'send_dummy_byte=true',
      'video_source=display',
      'max_size=1080',            // Crisp 1080p Full HD resolution
      'video_bit_rate=4000000',   // 4.0 Mbps: Instant hardware encoding on phone CPU with zero network delay
      'max_fps=60',
      'video_codec_options=i-frame-interval=1',
      'send_frame_meta=true',
      'show_touches=false',
      'stay_awake=true',
    ];

    logger.info(`[ScrcpyEngine ${this.serial}] Spawning scrcpy server with args: ${args.slice(2).join(' ')}`);

    this.serverProc = spawn(ADB_BIN, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Return a Promise that resolves when scrcpy prints its ready line and audio state is known.
    this._serverReady = new Promise((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };
      let audioWaitTimer = null;

      const onOutput = (chunk, isErr) => {
        const msg = chunk.toString().trim();
        if (!msg) return;
        if (isErr) logger.warn(`[ScrcpyEngine ${this.serial}] stderr: ${msg}`);
        else logger.info(`[ScrcpyEngine ${this.serial}] stdout: ${msg}`);
        
        if (msg.includes('Audio disabled') || msg.includes('Audio: error') || msg.includes('Audio capture error') || msg.includes('continue without audio')) {
          this._audioDisabled = true;
          this._audioReady = false;
          logger.warn(`[ScrcpyEngine ${this.serial}] Audio capture not supported on this phone model — streaming 60FPS video & controls`);
          if (audioWaitTimer) { clearTimeout(audioWaitTimer); audioWaitTimer = null; }
          done();
        } else if (msg.includes('Audio:') || msg.includes('Audio encoder')) {
          this._audioReady = true;
          this._audioDisabled = false;
          logger.info(`[ScrcpyEngine ${this.serial}] Audio encoder confirmed active`);
          if (audioWaitTimer) { clearTimeout(audioWaitTimer); audioWaitTimer = null; }
          done();
        }

        const dimMatch = msg.match(/\((\d+)x(\d+)\)/);
        if (dimMatch) {
          const sw = parseInt(dimMatch[1], 10);
          const sh = parseInt(dimMatch[2], 10);
          if (sw > 0 && sh > 0) {
            this.videoWidth  = sw;
            this.videoHeight = sh;
            logger.info(`[ScrcpyEngine ${this.serial}] Server-negotiated resolution: ${sw}x${sh}`);
          }
        }

        if (msg.includes('Device:') || msg.includes('device:')) {
          if (!this.enableAudio) {
            done();
          } else if (!audioWaitTimer && !this._audioReady && !this._audioDisabled) {
            // Give scrcpy up to 1.2s after "Device:" to see if it announces audio encoder
            audioWaitTimer = setTimeout(() => {
              audioWaitTimer = null;
              if (!this._audioReady) {
                this._audioDisabled = true;
              }
              done();
            }, 1200);
          }
        }
      };

      this.serverProc.stdout.on('data', d => onOutput(d, false));
      this.serverProc.stderr.on('data', d => onOutput(d, true));

      // Global safety timeout
      setTimeout(() => {
        if (audioWaitTimer) { clearTimeout(audioWaitTimer); audioWaitTimer = null; }
        done();
      }, 5000);
    });

    this.serverProc.on('error', (e) => {
      logger.error(`[ScrcpyEngine ${this.serial}] proc error: ${e.message}`);
    });

    this._procStartTime = Date.now();
    this._restartPending = false;

    this.serverProc.on('close', (code) => {
      // Ignore close events triggered by our own stop() call
      if (!this.isRunning) return;
      // Ignore if a restart is already queued
      if (this._restartPending) return;

      const uptime = Date.now() - this._procStartTime;
      logger.warn(`[ScrcpyEngine ${this.serial}] proc exited (code=${code}, uptime=${uptime}ms)`);

      this._cleanup();

      // Always restart scrcpy — no screenrecord fallback.
      // Back off longer if it died quickly (likely an audio startup error).
      if (!this._restartPending) {
        this._restartPending = true;
        if (uptime < 4000 && this.enableAudio) {
          logger.info(`[ScrcpyEngine ${this.serial}] Scrcpy exited quickly — permanently disabling audio for hardware stability`);
          this.enableAudio = false;
          this._audioDisabled = true;
          this._audioReady = false;
        }
        const delay = uptime < 3000 ? 3000 : 1500;
        logger.info(`[ScrcpyEngine ${this.serial}] Restarting scrcpy in ${delay}ms...`);
        setTimeout(() => {
          this._restartPending = false;
          if (this.isRunning) this._restart();
        }, delay);
      }
    });
  }


  stop() {
    this.isRunning = false;
    this._cleanup();
    this.wsClients.clear();
    this.emit('stopped');
  }

  _cleanup() {
    if (this.videoSocket) {
      try { this.videoSocket.destroy(); } catch (_) {}
      this.videoSocket = null;
    }
    if (this.audioSocket) {
      try { this.audioSocket.destroy(); } catch (_) {}
      this.audioSocket = null;
    }
    if (this.controlSocket) {
      try { this.controlSocket.destroy(); } catch (_) {}
      this.controlSocket = null;
    }
    if (this.serverProc) {
      try { this.serverProc.kill(); } catch (_) {}
      this.serverProc = null;
    }
  }

  // ── Socket connection ─────────────────────────────────────────────────────

  async _connectSockets() {
    logger.info(`[ScrcpyEngine ${this.serial}] Waiting for scrcpy server ready signal...`);
    if (this._serverReady) await this._serverReady;

    await new Promise(r => setTimeout(r, 100));

    logger.info(`[ScrcpyEngine ${this.serial}] Connecting video socket...`);
    // tunnel_forward socket 1 = video stream
    this.videoSocket = await this._connectOne(this.videoPort);
    this.videoSocket.setNoDelay(true);
    this._pipeVideoToClients(this.videoSocket);

    await new Promise(r => setTimeout(r, 100));

    // tunnel_forward socket 2 = audio stream (ONLY when confirmed ready by scrcpy)
    if (this.enableAudio && this._audioReady && !this._audioDisabled) {
      try {
        logger.info(`[ScrcpyEngine ${this.serial}] Connecting audio socket...`);
        this.audioSocket = await this._connectOne(this.videoPort, 15);
        this.audioSocket.setNoDelay(true);
        this._pipeAudioToClients(this.audioSocket);
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Audio socket notice: ${err.message}`);
        this.audioSocket = null;
        this._audioDisabled = true;
      }
    }

    // tunnel_forward socket (last) = control socket
    logger.info(`[ScrcpyEngine ${this.serial}] Connecting control socket...`);
    this.controlSocket = await this._connectOne(this.videoPort, 25);
    this.controlSocket.setNoDelay(true);
    this.controlSocket.setKeepAlive(true, 1000);

    this.controlSocket.on('close', () => {
      this.controlSocket = null;
      if (this.isRunning) setTimeout(() => this._reconnectControl(), 300);
    });
    this.controlSocket.on('error', () => { this.controlSocket = null; });
  }

  _connectOne(port, retries = 50) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const s = net.connect({ port, host: '127.0.0.1' }, () => resolve(s));
        s.on('error', (e) => {
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
    // Pre-allocate a growing buffer to avoid repeated Buffer.concat() GC pressure at 60fps
    let buf = Buffer.alloc(0);
    let bufUsed = 0; // tracks how many bytes in buf are valid data
    let headerDone = false;
    let lastDataTime = Date.now();
    const DEVICE_HEADER_LEN = 77;
    const META = 12; // 8-byte PTS + 4-byte size

    function appendChunk(chunk) {
      const needed = bufUsed + chunk.length;
      if (needed > buf.length) {
        // Grow buffer with headroom to reduce future allocations
        const newBuf = Buffer.allocUnsafe(Math.max(needed * 2, 65536));
        if (bufUsed > 0) buf.copy(newBuf, 0, 0, bufUsed);
        buf = newBuf;
      }
      chunk.copy(buf, bufUsed);
      bufUsed += chunk.length;
    }

    function consumeBytes(n) {
      if (n >= bufUsed) { bufUsed = 0; return; }
      buf.copy(buf, 0, n, bufUsed);
      bufUsed -= n;
    }

    socket.on('data', (chunk) => {
      lastDataTime = Date.now();
      appendChunk(chunk);

      // 1. Skip the device-info header exactly once & parse real video stream size
      if (!headerDone) {
        if (bufUsed < DEVICE_HEADER_LEN) return;

        try {
          const w = buf.readUInt32BE(69);
          const h = buf.readUInt32BE(73);
          if (w > 0 && h > 0 && w < 10000 && h < 10000) {
            this.videoWidth = w;
            this.videoHeight = h;
            this.scrcpyServerWidth = w;
            this.scrcpyServerHeight = h;
            logger.info(`[ScrcpyEngine ${this.serial}] Scrcpy stream resolution: ${w}x${h}`);
          }
        } catch (_) {}

        if (bufUsed >= DEVICE_HEADER_LEN + META) {
          const firstPktSize = buf.readUInt32BE(DEVICE_HEADER_LEN + 8);
          if (firstPktSize === 0 || firstPktSize > 2 * 1024 * 1024) {
            logger.warn(`[ScrcpyEngine ${this.serial}] Unexpected first packet size ${firstPktSize} — trying 1-byte header`);
            consumeBytes(1);
          } else {
            consumeBytes(DEVICE_HEADER_LEN);
          }
        } else {
          consumeBytes(DEVICE_HEADER_LEN);
        }

        logger.info(`[ScrcpyEngine ${this.serial}] Device-info header consumed, stream parsing started`);
        headerDone = true;
      }

      // 2. Process video frame packets
      let consumed = 0;
      while (bufUsed - consumed >= META) {
        const pktSize = buf.readUInt32BE(consumed + 8);
        if (bufUsed - consumed < META + pktSize) break;

        const ptsHigh = buf.readUInt32BE(consumed);
        const payload = buf.subarray(consumed + META, consumed + META + pktSize);
        consumed += META + pktSize;

        const nalType = payload.length > 4 ? (payload[4] & 0x1f) : -1;
        const isSps = hasSpsNal(payload);
        const isIdr = nalType === 5 || hasIdrNal(payload);
        const isConfig = isSps || (ptsHigh & 0x80000000) !== 0;

        if (isSps || (isConfig && !this._configPacket)) {
          this._configPacket = Buffer.from(payload);

          try {
            const spsW = parseSpsWidth(payload);
            const spsH = parseSpsHeight(payload);
            if (spsW > 16 && spsH > 16 && spsW < 10000 && spsH < 10000) {
              if (this.videoWidth !== spsW || this.videoHeight !== spsH) {
                logger.info(`[ScrcpyEngine ${this.serial}] SPS resolution: ${spsW}x${spsH}`);
              }
              this.videoWidth  = spsW;
              this.videoHeight = spsH;
              this.scrcpyServerWidth = spsW;
              this.scrcpyServerHeight = spsH;
            }
          } catch (err) {
            logger.warn(`[ScrcpyEngine ${this.serial}] SPS parse error: ${err.message}`);
          }
        }

        if (isIdr) {
          if (this._configPacket) {
            this._keyframeBuffer = Buffer.concat([this._configPacket, payload]);
          } else {
            this._keyframeBuffer = Buffer.from(payload);
          }
        }

        this._broadcastVideo(payload);
      }
      if (consumed > 0) consumeBytes(consumed);

      // Safety reset — prevent unbounded memory growth
      if (bufUsed > 2 * 1024 * 1024) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Buffer overflow (${bufUsed} bytes) — resetting`);
        bufUsed = 0;
      }
    });

    socket.on('close', () => {
      logger.warn(`[ScrcpyEngine ${this.serial}] Video socket closed`);
      this.videoSocket = null;
    });

    socket.on('error', (e) => {
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
        if (buf.length < 5) return;

        let offset = 0;
        if (buf[0] === 0x00) offset = 1;

        const codecStr = buf.toString('utf8', offset, offset + 4).toLowerCase().trim().replace(/\0/g, '');
        logger.info(`[ScrcpyEngine ${this.serial}] Audio codec header detected: "${codecStr}"`);
        this._audioCodec = codecStr;
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

      // Prevent unbounded audio buffer growth
      if (buf.length > 256 * 1024) {
        buf = Buffer.alloc(0);
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

    const BACKPRESSURE_LIMIT = 48 * 1024; // 48KB — skip non-critical audio for slow consumers
    for (const ws of this.wsClients) {
      if (ws.readyState !== 1) {
        this.wsClients.delete(ws);
        continue;
      }
      // Skip audio for slow consumers — audio is less critical than keyframes
      if (ws.bufferedAmount > BACKPRESSURE_LIMIT) continue;
      try { ws.send(audioFrame, { binary: true }); } catch (_) {
        this.wsClients.delete(ws);
      }
    }
  }

  _broadcastVideo(payload) {
    // Detect if this frame contains a keyframe (IDR/SPS/PPS) — always send these
    const isKeyframe = hasSpsNal(payload) || (payload.length > 4 && (payload[4] & 0x1f) === 5);
    const BACKPRESSURE_LIMIT = 48 * 1024; // 48KB — drop delta frames immediately if client network lags to enforce sub-second live time

    for (const ws of this.wsClients) {
      if (ws.readyState !== 1) {
        this.wsClients.delete(ws);
        continue;
      }
      // Backpressure check: if the client's send buffer is too full, drop delta frames
      // but always send keyframes so the client can resync when it catches up
      if (!isKeyframe && ws.bufferedAmount > BACKPRESSURE_LIMIT) {
        // Drop this delta frame for this slow consumer
        continue;
      }
      try { ws.send(payload, { binary: true }); } catch (_) {
        this.wsClients.delete(ws);
      }
    }
  }

  // Task #7 & #10: request a fresh IDR keyframe from Android without a full reconnect
  _requestIdrKeyframe() {
    // scrcpy control message type 8 = SET_SCREEN_POWER_MODE — not ideal.
    // Best available no-side-effect approach: send an adb shell keyevent 0 (WAKE)
    // which nudges the compositor to emit a new IDR without interrupting the stream.
    try {
      this._adb(['shell', 'input', 'keyevent', '0']).catch(() => {});
    } catch (_) {}
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
  sendTouchEvent(action, x, y, width, height, pressure = 1.0, pointerId = 0) {
    if (!this.controlSocket || this.controlSocket.destroyed) {
      return false;
    }

    // Determine target resolution. Must strictly match the scrcpy-server videoSize on device.
    // Client width/height comes from the WebCodecs decoded frame (live truth).
    const clientW = (width > 10) ? Math.round(width) : 0;
    const clientH = (height > 10) ? Math.round(height) : 0;
    const targetW = this.videoWidth || this.scrcpyServerWidth || clientW || this.screenWidth || 1080;
    const targetH = this.videoHeight || this.scrcpyServerHeight || clientH || this.screenHeight || 2340;

    const srcW = clientW || targetW;
    const srcH = clientH || targetH;
    
    const scaledX = Math.round((x / srcW) * targetW);
    const scaledY = Math.round((y / srcH) * targetH);

    // Clamp to valid range
    const finalX = Math.max(0, Math.min(targetW - 1, scaledX));
    const finalY = Math.max(0, Math.min(targetH - 1, scaledY));

    const buf = Buffer.allocUnsafe(32);
    buf.writeUInt8(2, 0);                 // INJECT_TOUCH_EVENT
    buf.writeUInt8(action, 1);            // 0=DOWN, 1=UP, 2=MOVE

    // In scrcpy 2.x, SC_POINTER_ID_GENERIC_FINGER = -2n (0xFFFFFFFFFFFFFFFEn).
    // Controller.java maps pointerId !== POINTER_ID_MOUSE directly to:
    //   source   = InputDevice.SOURCE_TOUCHSCREEN
    //   toolType = MotionEvent.TOOL_TYPE_FINGER
    //   buttons  = 0, action_button = 0
    // This allows Android's gesture recognizers (swiping, scrolling, flinging)
    // to track touch dragging across all mobile apps and home screen without rejection.
    const pId = (pointerId === 0 || pointerId === undefined || pointerId === -1 || pointerId === -1n)
      ? BigInt('-2')
      : (typeof pointerId === 'bigint' ? pointerId : BigInt(pointerId));
    buf.writeBigInt64BE(pId, 2);          // pointerId
    buf.writeInt32BE(finalX, 10);
    buf.writeInt32BE(finalY, 14);
    buf.writeUInt16BE(targetW, 18);
    buf.writeUInt16BE(targetH, 20);
    buf.writeUInt16BE(action === 1 ? 0 : Math.floor(pressure * 65535), 22);
    buf.writeInt32BE(0, 24);              // action_button: 0 for touchscreen
    buf.writeInt32BE(0, 28);              // buttons: 0 for touchscreen
    try {
      this.controlSocket.write(buf);
      return true;
    } catch (e) { 
      return false; 
    }
  }

  /**
   * INJECT_SCROLL_EVENT (21 bytes scrcpy 2.x)
   *   [0]     msg type = 3
   *   [1-4]   x i32BE
   *   [5-8]   y i32BE
   *   [9-10]  screen width u16BE
   *   [11-12] screen height u16BE
   *   [13-14] hscroll i16BE (signed fixed point: 0x7FFF = 1.0, -0x8000 = -1.0)
   *   [15-16] vscroll i16BE (signed fixed point: 0x7FFF = 1.0, -0x8000 = -1.0)
   *   [17-20] buttons i32BE (0)
   */
  sendScrollEvent(x, y, width, height, hScroll = 0, vScroll = 0) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    const clientW = (width > 10) ? Math.round(width) : 0;
    const clientH = (height > 10) ? Math.round(height) : 0;
    const targetW = this.videoWidth || this.scrcpyServerWidth || clientW || this.screenWidth || 1080;
    const targetH = this.videoHeight || this.scrcpyServerHeight || clientH || this.screenHeight || 2340;
    const srcW = clientW || targetW;
    const srcH = clientH || targetH;
    const finalX = Math.max(0, Math.min(targetW - 1, Math.round((x / srcW) * targetW)));
    const finalY = Math.max(0, Math.min(targetH - 1, Math.round((y / srcH) * targetH)));

    const buf = Buffer.allocUnsafe(21);
    buf.writeUInt8(3, 0);                 // INJECT_SCROLL_EVENT
    buf.writeInt32BE(finalX, 1);
    buf.writeInt32BE(finalY, 5);
    buf.writeUInt16BE(targetW, 9);
    buf.writeUInt16BE(targetH, 11);

    // Convert float (-1.0 to 1.0) to signed 16-bit fixed point for scrcpy Binary.i16FixedPointToFloat
    const toFixed16 = (val) => {
      const clamped = Math.max(-1.0, Math.min(1.0, val));
      return clamped === 1.0 ? 0x7FFF : Math.round(clamped * 0x8000);
    };
    buf.writeInt16BE(toFixed16(hScroll), 13);
    buf.writeInt16BE(toFixed16(vScroll), 15);
    buf.writeInt32BE(0, 17);              // buttons
    try {
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
    try { 
      this.controlSocket.write(buf);
      return true; 
    }
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
    try { 
      this.controlSocket.write(buf);
      return true; 
    }
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

  async _restart() {
    if (!this.isRunning) return;
    logger.info(`[ScrcpyEngine ${this.serial}] Restarting...`);
    // Clear stale keyframe cache so fresh SPS/PPS+IDR are sent after restart
    this._configPacket   = null;
    this._keyframeBuffer = null;
    this._restartPending = false;
    // Tell connected browsers to reset their decoders before new stream data arrives
    const resetMsg = Buffer.from(JSON.stringify({ type: 'stream_reset' }));
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) try { ws.send(resetMsg); } catch (_) {}
    }
    try {
      try { await this._adb(['forward', '--remove', `tcp:${this.videoPort}`]); } catch (_) {}
      await this._adb(['forward', `tcp:${this.videoPort}`, 'localabstract:scrcpy']);
      this._spawnServer();
      await this._connectSockets();
      logger.info(`[ScrcpyEngine ${this.serial}] Restarted successfully`);
    } catch (err) {
      logger.warn(`[ScrcpyEngine ${this.serial}] Restart failed: ${err.message} — retry in 3s`);
      if (this.isRunning) setTimeout(() => this._restart(), 3000);
    }
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
