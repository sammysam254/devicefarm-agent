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

      // 2. Push server jar (once per device session)
      if (!this._jarPushed) {
        await this._adb(['push', SCRCPY_JAR_PATH, '/data/local/tmp/scrcpy-server.jar']);
        this._jarPushed = true;
      }

      // 3. Remove any stale forward, then add fresh one
      try { await this._adb(['forward', '--remove', `tcp:${videoPort}`]); } catch (_) {}
      await this._adb(['forward', `tcp:${videoPort}`, 'localabstract:scrcpy']);

      // 4. Start scrcpy server
      //    - max_fps=60 for near-zero latency
      //    - max_size=720 keeps bandwidth and decode cost low
      //    - video_bit_rate=4Mbps for good quality at 60fps
      //    - send_frame_meta=true so we can strip the 12-byte meta header
      //    - send_dummy_byte=true required for tunnel_forward
      this._spawnServer();

      // 5. Connect sockets (video + control)
      await this._connectSockets();
      logger.info(`[ScrcpyEngine ${this.serial}] Ready — video+control sockets connected`);

    } catch (err) {
      logger.error(`[ScrcpyEngine ${this.serial}] Start failed: ${err.message}`);
      this.stop();
      throw err;
    }
  }

  _spawnServer() {
    const args = [
      '-s', this.serial, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/', 'com.genymobile.scrcpy.Server', '2.4',
      'tunnel_forward=true',
      'video=true',
      'audio=false',
      'control=true',
      'display_id=0',
      'max_size=720',
      'video_bit_rate=2500000',
      'max_fps=60',
      'i_frame_interval=1',
      'stay_awake=true',
      'power_on=true',
      'show_touches=false',
      'power_off_on_close=false',
      'clipboard_autosync=false',
      'cleanup=true',
      'send_device_meta=true',
      'send_codec_meta=true',
      'send_frame_meta=true',
      'send_dummy_byte=true',
    ];

    this.serverProc = spawn(ADB_BIN, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
    this._cleanup();
    if (this.videoPort) {
      this._adb(['forward', '--remove', `tcp:${this.videoPort}`]).catch(() => {});
    }
    this.wsClients.clear();
    this.emit('stopped');
  }

  _cleanup() {
    if (this.videoSocket)   { try { this.videoSocket.destroy();   } catch (_) {} this.videoSocket   = null; }
    if (this.controlSocket) { try { this.controlSocket.destroy(); } catch (_) {} this.controlSocket = null; }
    if (this.serverProc)    { try { this.serverProc.kill();       } catch (_) {} this.serverProc    = null; }
  }

  // ── Socket connection ─────────────────────────────────────────────────────

  async _connectSockets() {
    // Give scrcpy server ~800ms to open the abstract socket
    await new Promise(r => setTimeout(r, 800));

    // tunnel_forward: first connect = video socket, second connect = control socket
    this.videoSocket = await this._connectOne(this.videoPort);
    this.videoSocket.setNoDelay(true);

    this.controlSocket = await this._connectOne(this.videoPort);
    this.controlSocket.setNoDelay(true);
    this.controlSocket.setKeepAlive(true, 1000);

    // Read and discard the handshake header on the video socket
    await this._readVideoHeader(this.videoSocket);

    // Start the H264 relay pipeline
    this._pipeVideoToClients(this.videoSocket);

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
   * Read the scrcpy v2.x handshake header from the video socket.
   *
   * With tunnel_forward + send_dummy_byte=true:
   *   Byte 0       : dummy byte (always 0)
   *
   * With send_device_meta=true (v2.x):
   *   Bytes 1-64   : device name (64 bytes, null-padded)
   *
   * With send_codec_meta=true (v2.x):
   *   Bytes 65-68  : codec id u32BE  (e.g. 0x68323634 = "h264")
   *   Bytes 69-72  : initial width  u32BE
   *   Bytes 73-76  : initial height u32BE
   *
   * Total with both: 1 + 64 + 4 + 4 + 4 = 77 bytes
   *
   * NOTE: send_device_meta alone only sends name (65 bytes total).
   *       We set BOTH flags so we always get the full 77-byte header.
   */
  _readVideoHeader(socket) {
    return new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const HEADER_LEN = 77; // 1 dummy + 64 device name + 4 codec ID + 4 width + 4 height

      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= HEADER_LEN) {
          socket.removeListener('data', onData);

          const deviceName = buf.slice(1, 65).toString('utf8').replace(/\0/g, '');
          const codecId = buf.readUInt32BE(65);
          const w = buf.readUInt32BE(69);
          const h = buf.readUInt32BE(73);

          if (w > 0 && h > 0) {
            this.screenWidth = w;
            this.screenHeight = h;
          }

          logger.info(`[ScrcpyEngine ${this.serial}] Header: "${deviceName}" codec=0x${codecId.toString(16)} resolution=${this.screenWidth}x${this.screenHeight}`);

          // Push back any bytes that belong to the video stream
          if (buf.length > HEADER_LEN) {
            socket.unshift(buf.slice(HEADER_LEN));
          }
          resolve();
        }
      };

      socket.on('data', onData);
      socket.once('error', resolve);
      socket.once('close', resolve);
    });
  }

  /**
   * Relay raw H264 NAL units from the video socket to all WS clients.
   *
   * scrcpy frame meta (12 bytes per packet):
   *   [0-7]  PTS u64BE — top bit set = config (SPS/PPS) packet
   *   [8-11] payload size u32BE
   *
   * We strip the meta header and send the raw Annex-B payload to clients.
   * Config packets are cached and re-sent to each new client connection.
   */
  _pipeVideoToClients(socket) {
    let buf = Buffer.alloc(0);
    const META = 12;

    socket.on('data', (chunk) => {
      // Append incoming chunk
      buf = Buffer.concat([buf, chunk]);

      // Process as many complete packets as possible
      while (buf.length >= META) {
        const pktSize = buf.readUInt32BE(8);
        if (buf.length < META + pktSize) break; // need more data

        const ptsHigh  = buf.readUInt32BE(0);
        const isConfig = (ptsHigh & 0x80000000) !== 0; // top bit

        const payload = buf.slice(META, META + pktSize);
        buf = buf.slice(META + pktSize);

        // Cache config (SPS/PPS) — sent to every new client on join
        if (isConfig) {
          this._configPacket = Buffer.from(payload);
          logger.info(`[ScrcpyEngine ${this.serial}] SPS/PPS config cached (${payload.length} bytes)`);
        }

        this._broadcastVideo(payload, isConfig);
      }

      // Safety: prevent unbounded growth (>1MB means something is badly wrong)
      if (buf.length > 1024 * 1024) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Buffer overflow — resetting`);
        buf = Buffer.alloc(0);
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

  _broadcastVideo(payload, isConfig) {
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
