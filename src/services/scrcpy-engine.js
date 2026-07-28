'use strict';

const { spawn, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const logger = require('../utils/logger');

const ADB_BIN = (() => {
  const candidates = [
    'C:\\platform-tools\\adb.exe',
    path.join(process.cwd(), 'assets', 'bin', 'adb.exe'),
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
 * them using the WebCodecs VideoDecoder API — no screencap, no PNG,
 * no JPEG. Typical throughput: 15-30 fps over USB, 8-15 fps over WiFi.
 *
 * CONTROL MODE: touch/key events injected via the control socket using
 * the scrcpy binary control protocol.
 *
 * Socket connection order (tunnel_forward=true):
 *   1. video socket  (first connection accepted by device)
 *   2. control socket (second connection)
 * The device sends a 69-byte device metadata header on the video socket
 * before streaming begins.
 */
class ScrcpyEngine extends EventEmitter {
  constructor(serial) {
    super();
    this.serial       = serial;
    this.serverProc   = null;
    this.videoSocket  = null;
    this.controlSocket = null;
    this.isRunning    = false;
    this.videoPort    = null;
    this.controlPort  = null;

    // Real device dimensions fetched via adb shell wm size
    this.screenWidth  = 720;
    this.screenHeight = 1600;

    // Connected WS clients receiving H264 stream
    this.wsClients = new Set();

    // SPS/PPS config accumulated from first keyframe — sent to new clients
    this._spsBuffer = null;
  }

  get isReady() {
    return this.isRunning && this.controlSocket && !this.controlSocket.destroyed;
  }

  addClient(ws) {
    this.wsClients.add(ws);
    // Send cached SPS/PPS so the decoder can initialise immediately
    if (this._spsBuffer && ws.readyState === 1) {
      try { ws.send(this._spsBuffer, { binary: true }); } catch (_) {}
    }
  }

  removeClient(ws) {
    this.wsClients.delete(ws);
  }

  async start(videoPort, controlPort) {
    if (this.isRunning) return;
    this.videoPort   = videoPort;
    this.controlPort = controlPort;
    this.isRunning   = true;

    try {
      // 1. Real screen dimensions
      try {
        const out = await this._adb(['shell', 'wm', 'size']);
        const m = out.match(/Physical size:\s*(\d+)x(\d+)/);
        if (m) {
          this.screenWidth  = parseInt(m[1], 10);
          this.screenHeight = parseInt(m[2], 10);
        }
      } catch (_) {}
      logger.info(`[ScrcpyEngine ${this.serial}] Screen: ${this.screenWidth}x${this.screenHeight}`);

      // 2. Push server jar
      await this._adb(['push', SCRCPY_JAR_PATH, '/data/local/tmp/scrcpy-server.jar']);

      // 3. Forward ports — video on videoPort, control reuses same port via scrcpy's
      //    two-connection handshake (tunnel_forward opens both on same abstract socket)
      await this._adb(['forward', `tcp:${videoPort}`, 'localabstract:scrcpy']);

      // 4. Start scrcpy server with VIDEO enabled, max_size=720 to keep bandwidth low
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
        'video_bit_rate=2000000',
        'max_fps=30',
        'stay_awake=true',
        'power_on=true',
        'show_touches=false',
        'power_off_on_close=false',
        'clipboard_autosync=false',
        'cleanup=true',
        'send_device_meta=true',
        'send_frame_meta=true',
        'send_dummy_byte=true',
      ];

      this.serverProc = spawn(ADB_BIN, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.serverProc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) logger.warn(`[ScrcpyEngine ${this.serial}] ${msg}`);
      });

      this.serverProc.on('error', (e) => logger.error(`[ScrcpyEngine ${this.serial}] proc error: ${e.message}`));
      this.serverProc.on('close', (code) => {
        logger.warn(`[ScrcpyEngine ${this.serial}] proc exited (${code}) — restarting in 2s`);
        this._cleanup();
        if (this.isRunning) setTimeout(() => this._restart(), 2000);
      });

      // 5. Connect sockets — scrcpy tunnel_forward: first connect = video, second = control
      await this._connectSockets();
      logger.info(`[ScrcpyEngine ${this.serial}] Video + control sockets ready`);

    } catch (err) {
      logger.error(`[ScrcpyEngine ${this.serial}] Start failed: ${err.message}`);
      this.stop();
      throw err;
    }
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

  // ── Socket connection ───────────────────────────────────────────────────────

  async _connectSockets() {
    // Wait for scrcpy server to start listening
    await new Promise(r => setTimeout(r, 500));

    // First connection → video socket
    this.videoSocket = await this._connectOne(this.videoPort);
    this.videoSocket.setNoDelay(true);

    // Second connection → control socket
    this.controlSocket = await this._connectOne(this.videoPort);
    this.controlSocket.setNoDelay(true);
    this.controlSocket.setKeepAlive(true, 1000);

    // Read and discard the dummy byte + device metadata header (69 bytes) on video socket
    await this._readVideoHeader(this.videoSocket);

    // Start relaying H264 NAL units to WS clients
    this._pipeVideoToClients(this.videoSocket);

    this.controlSocket.on('close', () => {
      this.controlSocket = null;
      if (this.isRunning) setTimeout(() => this._reconnectControl(), 500);
    });
    this.controlSocket.on('error', () => { this.controlSocket = null; });
  }

  _connectOne(port, retries = 40) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const s = net.connect({ port, host: '127.0.0.1' }, () => resolve(s));
        s.on('error', (e) => {
          if (n <= 0) return reject(new Error(`Timeout connecting to port ${port}: ${e.message}`));
          setTimeout(() => attempt(n - 1), 150);
        });
      };
      attempt(retries);
    });
  }

  /**
   * Read and discard the scrcpy handshake header from the video socket.
   * With tunnel_forward + send_dummy_byte=true:
   *   - 1 dummy byte
   *   - 64-byte device name string
   *   - 4-byte codec id (e.g. "h264" = 0x68323634)
   *   - 4-byte initial width
   *   - 4-byte initial height
   * Total: 1 + 64 + 4 + 4 + 4 = 77 bytes
   */
  _readVideoHeader(socket) {
    return new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const HEADER_LEN = 77; // 1 dummy + 64 device name + 4 codec + 4 w + 4 h

      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= HEADER_LEN) {
          socket.removeListener('data', onData);
          // Parse device name and initial dimensions
          const deviceName = buf.slice(1, 65).toString('utf8').replace(/\0/g, '');
          const codec  = buf.readUInt32BE(65);
          const width  = buf.readUInt32BE(69);
          const height = buf.readUInt32BE(73);
          logger.info(`[ScrcpyEngine ${this.serial}] Stream Header: ${deviceName} (${width}x${height}) codec=0x${codec.toString(16)}`);
          if (width > 0 && height > 0) {
            this.screenWidth  = width;
            this.screenHeight = height;
          }
          // Push back any bytes beyond the header for the video pipeline
          if (buf.length > HEADER_LEN) {
            socket.unshift(buf.slice(HEADER_LEN));
          }
          resolve();
        }
      };

      socket.on('data', onData);
      socket.on('error', resolve);
      socket.on('close', resolve);
    });
  }

  /**
   * Relay raw H264 data from the video socket to all WS clients.
   *
   * scrcpy wraps each H264 packet with a 12-byte frame meta header:
   *   [0-7]  PTS (u64 BE) with flags in top 3 bits
   *   [8-11] packet size (u32 BE)
   *
   * We strip the meta header and forward raw NAL unit payloads so the
   * browser WebCodecs decoder gets a clean Annex-B H264 stream.
   */
  _pipeVideoToClients(socket) {
    let buf = Buffer.alloc(0);
    const META = 12; // frame meta header size

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      while (buf.length >= META) {
        const pktSize = buf.readUInt32BE(8);
        if (buf.length < META + pktSize) break; // wait for full packet

        const pts   = buf.readBigUInt64BE(0);
        const isConfig = Boolean(pts & 0x8000000000000000n); // top bit = config packet

        const payload = buf.slice(META, META + pktSize);
        buf = buf.slice(META + pktSize);

        // Cache SPS/PPS config packet — sent to new clients on connect
        if (isConfig) {
          this._spsBuffer = Buffer.from(payload);
        }

        this._broadcastVideo(payload, isConfig);
      }

      // Safety: cap buffer at 2MB
      if (buf.length > 2 * 1024 * 1024) buf = Buffer.alloc(0);
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
      // Backpressure: drop non-config frames if client is behind
      if (!isConfig && ws.bufferedAmount > 512 * 1024) continue;
      try { ws.send(payload, { binary: true }); } catch (_) { this.wsClients.delete(ws); }
    }
  }

  // ── Control protocol ────────────────────────────────────────────────────────

  /**
   * INJECT_TOUCH_EVENT — 32 bytes (scrcpy 2.x protocol, verified against unit tests)
   *   [0]     type=2
   *   [1]     action  0=DOWN 1=UP 2=MOVE
   *   [2-9]   pointer_id i64BE = -1 (POINTER_ID_VIRTUAL)
   *   [10-13] x i32BE
   *   [14-17] y i32BE
   *   [18-19] screen width u16BE
   *   [20-21] screen height u16BE
   *   [22-23] pressure u16BE (0xFFFF=1.0)
   *   [24-27] action_button i32BE (1=PRIMARY on DOWN, 0 otherwise)
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
   * INJECT_KEYCODE — 14 bytes
   *   [0]     type=0
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
   * INJECT_TEXT — variable
   *   [0]     type=1
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

  // ── Reconnect / restart ─────────────────────────────────────────────────────

  async _reconnectControl() {
    if (!this.isRunning) return;
    try {
      const cs = await this._connectOne(this.videoPort, 10);
      cs.setNoDelay(true);
      cs.setKeepAlive(true, 1000);
      this.controlSocket = cs;
      cs.on('close', () => { this.controlSocket = null; if (this.isRunning) setTimeout(() => this._reconnectControl(), 500); });
      cs.on('error', () => { this.controlSocket = null; });
    } catch (_) {
      if (this.isRunning) setTimeout(() => this._reconnectControl(), 1000);
    }
  }

  async _restart() {
    if (!this.isRunning) return;
    logger.info(`[ScrcpyEngine ${this.serial}] Restarting...`);
    try {
      await this._adb(['forward', `tcp:${this.videoPort}`, 'localabstract:scrcpy']);
      const args = [
        '-s', this.serial, 'shell',
        'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
        'app_process', '/', 'com.genymobile.scrcpy.Server', '2.4',
        'tunnel_forward=true', 'video=true', 'audio=false', 'control=true',
        'display_id=0', 'max_size=720', 'video_bit_rate=2000000', 'max_fps=30',
        'stay_awake=true', 'power_on=true', 'show_touches=false',
        'power_off_on_close=false', 'clipboard_autosync=false', 'cleanup=true',
        'send_device_meta=true', 'send_frame_meta=true', 'send_dummy_byte=true',
      ];
      this.serverProc = spawn(ADB_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.serverProc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) logger.warn(`[ScrcpyEngine ${this.serial}] ${m}`); });
      this.serverProc.on('error', () => {});
      this.serverProc.on('close', (code) => {
        logger.warn(`[ScrcpyEngine ${this.serial}] proc exited (${code}) — restarting in 2s`);
        this._cleanup();
        if (this.isRunning) setTimeout(() => this._restart(), 2000);
      });
      await this._connectSockets();
      logger.info(`[ScrcpyEngine ${this.serial}] Restarted`);
    } catch (err) {
      logger.warn(`[ScrcpyEngine ${this.serial}] Restart failed: ${err.message} — retry in 3s`);
      if (this.isRunning) setTimeout(() => this._restart(), 3000);
    }
  }

  _adb(args) {
    return new Promise((resolve, reject) => {
      execFile(ADB_BIN, ['-s', this.serial, ...args], (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
  }
}

module.exports = ScrcpyEngine;
