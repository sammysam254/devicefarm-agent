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

    // Real device dimensions
    this.screenWidth  = 720;
    this.screenHeight = 1600;

    // Connected WS clients receiving H264 stream
    this.wsClients = new Set();

    // Last SPS/PPS config packet — sent immediately to new clients so
    // the decoder can initialise before any keyframe arrives
    this._configPacket = null;

    // Whether the scrcpy server has been pushed to the device already
    this._jarPushed = false;

    // Fast real-time screencap streaming
    this._screencapActive = false;
  }

  get isReady() {
    return this.isRunning && this.controlSocket && !this.controlSocket.destroyed;
  }

  /**
   * Register a WS client. We immediately flush the cached SPS/PPS config
   * so the WebCodecs decoder is initialised before the next keyframe.
   */
  addClient(ws) {
    this.wsClients.add(ws);
    if (this._configPacket && ws.readyState === 1) {
      try { ws.send(this._configPacket, { binary: true }); } catch (_) {}
    }
  }

  removeClient(ws) {
    this.wsClients.delete(ws);
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

      // 2. Use screencap as primary method - it's reliable and works everywhere
      logger.info(`[ScrcpyEngine ${this.serial}] Starting with screencap streaming (reliable mode)`);
      this._startScreencapStream();

    } catch (err) {
      logger.error(`[ScrcpyEngine ${this.serial}] Start failed: ${err.message}`);
      this.stop();
      throw err;
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
      'audio=false',
      'control=true',
      'cleanup=true',
      'send_dummy_byte=true',
      // Required for a visible, correctly framed H264 stream:
      'video_source=display',      // explicitly capture the display (not camera)
      'max_size=720',              // cap resolution — keeps bitrate and decode cost manageable
      'video_bit_rate=4000000',    // 4 Mbps — good quality at up to 60fps
      'max_fps=30',                // 30fps is plenty for remote control; reduces load
      'send_frame_meta=true',      // MUST be true — enables the 12-byte PTS+size header we parse
    ];

    logger.info(`[ScrcpyEngine ${this.serial}] Spawning scrcpy server with args: ${args.slice(2).join(' ')}`);

    this.serverProc = spawn(ADB_BIN, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.serverProc.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) logger.info(`[ScrcpyEngine ${this.serial}] stdout: ${msg}`);
    });

    this.serverProc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) logger.warn(`[ScrcpyEngine ${this.serial}] stderr: ${msg}`);
    });

    this.serverProc.on('error', (e) => {
      logger.error(`[ScrcpyEngine ${this.serial}] proc error: ${e.message}`);
    });

    this.serverProc.on('close', (code) => {
      logger.warn(`[ScrcpyEngine ${this.serial}] proc exited (${code}) — restarting in 1.5s`);
      this._cleanup();
      if (this.isRunning) setTimeout(() => this._restart(), 1500);
    });
  }

  stop() {
    this.isRunning = false;
    this._screencapActive = false;
    this._cleanup();
    this.wsClients.clear();
    this.emit('stopped');
  }

  _cleanup() {
    // Nothing to clean up for screencap mode
  }

  // ── Socket connection ─────────────────────────────────────────────────────

  async _connectSockets() {
    // Give scrcpy server ~800ms to open the abstract socket
    await new Promise(r => setTimeout(r, 800));

    // tunnel_forward: 1st connect = video socket, 2nd connect = control socket
    this.videoSocket = await this._connectOne(this.videoPort);
    this.videoSocket.setNoDelay(true);

    // Start video relay pipeline immediately so dummy/header bytes are consumed
    this._pipeVideoToClients(this.videoSocket);

    // Wait 250ms for scrcpy encoder initialization before connecting control socket
    await new Promise(r => setTimeout(r, 250));

    this.controlSocket = await this._connectOne(this.videoPort);
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
   *
   * scrcpy 2.x tunnel_forward stream layout (send_frame_meta=true):
   *   - 1 byte:  dummy byte (required by tunnel_forward, value = 0)
   *   - 64 bytes: device name (null-padded)
   *   - 4 bytes:  codec ID (0x68323634 = "h264")
   *   - 4 bytes:  initial width  (u32BE)
   *   - 4 bytes:  initial height (u32BE)
   *   Total device-info header = 77 bytes (1 dummy + 68 device info + 8 resolution)
   *
   * Then for every video packet:
   *   - 8 bytes: PTS (u64BE, high bit set on config/key frames)
   *   - 4 bytes: payload size (u32BE)
   *   - N bytes: raw H264 NAL unit(s)
   */
  _pipeVideoToClients(socket) {
    let buf = Buffer.alloc(0);
    let headerDone = false;
    let lastDataTime = Date.now();
    // scrcpy 2.x device-info header: 1 dummy + 64 name + 4 codec + 4 W + 4 H = 77 bytes
    const DEVICE_HEADER_LEN = 77;
    const META = 12; // 8-byte PTS + 4-byte size

    // Watchdog: if no data received for 3 seconds, fall back to screenrecord
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataTime > 3000 && !this._fallbackActive) {
        logger.warn(`[ScrcpyEngine ${this.serial}] No video data for 3s — starting screenrecord fallback`);
        this._startScreenrecordFallback();
      }
    }, 1000);

    socket.on('data', (chunk) => {
      lastDataTime = Date.now();
      buf = Buffer.concat([buf, chunk]);

      // 1. Skip the device-info header exactly once
      if (!headerDone) {
        if (buf.length < DEVICE_HEADER_LEN) return; // wait for the full header

        // Sanity-check: bytes [69..72] should be a plausible frame payload size
        // (after 1 dummy + 64 name + 4 codec ID = 69 bytes of prefix, then 8-byte PTS at 69, size at 77)
        // Actually the first META starts at DEVICE_HEADER_LEN, so read the size there:
        // If we have enough bytes, verify the size field looks reasonable.
        if (buf.length >= DEVICE_HEADER_LEN + META) {
          const firstPktSize = buf.readUInt32BE(DEVICE_HEADER_LEN + 8);
          // A sane first-packet size is > 0 and less than 2MB
          if (firstPktSize === 0 || firstPktSize > 2 * 1024 * 1024) {
            // Header length mismatch — fall back to 1-byte dummy-only mode
            logger.warn(`[ScrcpyEngine ${this.serial}] Unexpected first packet size ${firstPktSize} — trying 1-byte header`);
            buf = buf.slice(1);
          } else {
            buf = buf.slice(DEVICE_HEADER_LEN);
          }
        } else {
          buf = buf.slice(DEVICE_HEADER_LEN);
        }

        logger.info(`[ScrcpyEngine ${this.serial}] Device-info header consumed, stream parsing started`);
        headerDone = true;
      }

      // 2. Process video frame packets
      while (buf.length >= META) {
        const pktSize = buf.readUInt32BE(8);
        if (buf.length < META + pktSize) break; // need more data

        const ptsHigh  = buf.readUInt32BE(0);
        const payload  = buf.slice(META, META + pktSize);
        buf = buf.slice(META + pktSize);

        const isSps = hasSpsNal(payload);
        const isConfig = isSps || (ptsHigh & 0x80000000) !== 0;

        // Cache config packet (SPS/PPS) — sent to every new client on join
        if (isSps || (isConfig && !this._configPacket)) {
          this._configPacket = Buffer.from(payload);
          logger.info(`[ScrcpyEngine ${this.serial}] SPS/PPS config cached (${payload.length} bytes)`);
        }

        this._broadcastVideo(payload, isConfig);
      }

      // Safety: prevent unbounded growth
      if (buf.length > 1024 * 1024) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Buffer overflow — resetting`);
        buf = Buffer.alloc(0);
      }
    });

    socket.on('close', () => {
      clearInterval(watchdog);
      logger.warn(`[ScrcpyEngine ${this.serial}] Video socket closed`);
      this.videoSocket = null;
      // Start fallback if socket closes unexpectedly
      if (this.isRunning && !this._fallbackActive) {
        this._startScreenrecordFallback();
      }
    });

    socket.on('error', (e) => {
      clearInterval(watchdog);
      logger.warn(`[ScrcpyEngine ${this.serial}] Video socket error: ${e.message}`);
      this.videoSocket = null;
    });
  }

  _broadcastVideo(payload, isConfig) {
    // Add logging to track frame source
    const nalType = payload.length > 4 ? (payload[4] & 0x1f) : -1;
    const source = this._fallbackActive ? 'fallback' : 'scrcpy';
    
    if (isConfig || nalType === 5) {
      logger.info(`[ScrcpyEngine ${this.serial}] Broadcasting ${isConfig ? 'config' : 'IDR'} frame from ${source} (${payload.length} bytes, NAL type: ${nalType})`);
    }

    for (const ws of this.wsClients) {
      if (ws.readyState !== 1) { this.wsClients.delete(ws); continue; }

      if (isConfig) {
        ws._needsKeyframe = false;
      } else if (ws._needsKeyframe) {
        // Skip P-frames after backpressure drop until next keyframe/config
        continue;
      }

      // Drop non-config frames only when client is significantly behind (64KB).
      if (!isConfig && ws.bufferedAmount > 64 * 1024) {
        ws._needsKeyframe = true;
        continue;
      }

      try { ws.send(payload, { binary: true }); } catch (_) { this.wsClients.delete(ws); }
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
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    const W = (width  > 10) ? width  : this.screenWidth;
    const H = (height > 10) ? height : this.screenHeight;
    const buf = Buffer.allocUnsafe(32);
    buf.writeUInt8(2, 0);
    buf.writeUInt8(action, 1);
    buf.writeBigInt64BE(-1n, 2);
    buf.writeInt32BE(Math.round(x), 10);
    buf.writeInt32BE(Math.round(y), 14);
    buf.writeUInt16BE(W, 18);
    buf.writeUInt16BE(H, 20);
    buf.writeUInt16BE(Math.floor(pressure * 65535), 22);
    buf.writeInt32BE(action === 0 ? 1 : 0, 24);
    buf.writeInt32BE(action === 1 ? 0 : 1, 28);
    try { this.controlSocket.write(buf); return true; }
    catch (e) { logger.error(`[ScrcpyEngine ${this.serial}] touch write: ${e.message}`); return false; }
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

  async _restart() {
    if (!this.isRunning) return;
    logger.info(`[ScrcpyEngine ${this.serial}] Restarting...`);
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
