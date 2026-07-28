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
 * Scrcpy Engine for a single device.
 * Connects only a control socket (video=false) for ultra-low-latency input injection.
 * Screen capture is handled separately by FrameCaptureEngine.
 */
class ScrcpyEngine extends EventEmitter {
  constructor(serial) {
    super();
    this.serial = serial;
    this.serverProc = null;
    this.controlSocket = null;
    this.isRunning = false;
    this.videoPort = null;
    // Real device screen dimensions — fetched once on start, used for touch scaling
    this.screenWidth  = 1080;
    this.screenHeight = 2400;
  }

  get isReady() {
    return this.isRunning && this.controlSocket && !this.controlSocket.destroyed;
  }

  async start(videoPort) {
    if (this.isRunning) return;
    this.videoPort = videoPort;
    this.isRunning = true;

    try {
      // Fetch real screen dimensions first — avoids "different device size" warnings
      try {
        const sizeOut = await this._execAdb(['shell', 'wm', 'size']);
        const m = sizeOut.match(/Physical size:\s*(\d+)x(\d+)/);
        if (m) {
          this.screenWidth  = parseInt(m[1], 10);
          this.screenHeight = parseInt(m[2], 10);
          logger.info(`[ScrcpyEngine ${this.serial}] Screen size: ${this.screenWidth}x${this.screenHeight}`);
        }
      } catch (_) { /* keep defaults */ }

      await this._execAdb(['push', SCRCPY_JAR_PATH, '/data/local/tmp/scrcpy-server.jar']);
      await this._execAdb(['forward', `tcp:${videoPort}`, 'localabstract:scrcpy']);

      const scrcpyArgs = [
        '-s', this.serial,
        'shell',
        'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
        'app_process', '/',
        'com.genymobile.scrcpy.Server', '2.4',
        'tunnel_forward=true',
        'video=false',
        'audio=false',
        'control=true',
        'display_id=0',
        'show_touches=false',
        'stay_awake=true',
        'power_off_on_close=false',
        'clipboard_autosync=false',
        'cleanup=true',
        'power_on=true',
      ];

      this.serverProc = spawn(ADB_BIN, scrcpyArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (this.serverProc.stderr) {
        this.serverProc.stderr.on('data', (d) => {
          const msg = d.toString().trim();
          if (msg) logger.warn(`[ScrcpyEngine ${this.serial}] ${msg}`);
        });
      }

      this.serverProc.on('error', (err) => {
        logger.error(`[ScrcpyEngine ${this.serial}] Process error: ${err.message}`);
      });

      this.serverProc.on('close', (code) => {
        logger.warn(`[ScrcpyEngine ${this.serial}] Process exited (${code}) — restarting in 1s`);
        this.serverProc = null;
        if (this.controlSocket) {
          try { this.controlSocket.destroy(); } catch (_) {}
          this.controlSocket = null;
        }
        if (this.isRunning) setTimeout(() => this._restart(), 1000);
      });

      await this._connectControl();
      logger.info(`[ScrcpyEngine ${this.serial}] Control socket ready`);
    } catch (err) {
      logger.error(`[ScrcpyEngine ${this.serial}] Failed to start: ${err.message}`);
      this.stop();
      throw err;
    }
  }

  stop() {
    this.isRunning = false;
    if (this.controlSocket) {
      try { this.controlSocket.destroy(); } catch (_) {}
      this.controlSocket = null;
    }
    if (this.serverProc) {
      try { this.serverProc.kill(); } catch (_) {}
      this.serverProc = null;
    }
    if (this.videoPort) {
      this._execAdb(['forward', '--remove', `tcp:${this.videoPort}`]).catch(() => {});
    }
    this.emit('stopped');
  }

  /**
   * Inject touch event via Scrcpy Control Protocol (v2.4).
   * action: 0=DOWN, 1=UP, 2=MOVE
   *
   * Correct 32-byte layout per scrcpy unit tests:
   *   [0]     type           = 2 (INJECT_TOUCH_EVENT)
   *   [1]     action         = 0/1/2
   *   [2-9]   pointer_id     = i64 BE  (use -1 = POINTER_ID_VIRTUAL)
   *   [10-13] x              = i32 BE
   *   [14-17] y              = i32 BE
   *   [18-19] screen width   = u16 BE  (must match real device width)
   *   [20-21] screen height  = u16 BE  (must match real device height)
   *   [22-23] pressure       = u16 BE  (0xFFFF = 1.0)
   *   [24-27] action_button  = i32 BE  (1 = PRIMARY, 0 for MOVE/UP)
   *   [28-31] buttons        = i32 BE  (1 = PRIMARY held)
   */
  sendTouchEvent(action, x, y, width, height, pressure = 1.0) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;

    const W = (width  && width  > 100) ? width  : this.screenWidth;
    const H = (height && height > 100) ? height : this.screenHeight;

    // action_button: 1 (PRIMARY) on DOWN, 0 on MOVE/UP
    // buttons: 1 (PRIMARY held) on DOWN/MOVE, 0 on UP
    const actionButton = (action === 0) ? 1 : 0;
    const buttons      = (action === 1) ? 0 : 1;

    const buf = Buffer.allocUnsafe(32);
    buf.writeUInt8(2, 0);                              // INJECT_TOUCH_EVENT
    buf.writeUInt8(action, 1);
    buf.writeBigInt64BE(-1n, 2);                       // POINTER_ID_VIRTUAL
    buf.writeInt32BE(Math.round(x), 10);
    buf.writeInt32BE(Math.round(y), 14);
    buf.writeUInt16BE(W, 18);
    buf.writeUInt16BE(H, 20);
    buf.writeUInt16BE(Math.floor(pressure * 65535), 22);
    buf.writeInt32BE(actionButton, 24);                // action_button
    buf.writeInt32BE(buttons, 28);                     // buttons
    try {
      this.controlSocket.write(buf);
      return true;
    } catch (err) {
      logger.error(`[ScrcpyEngine ${this.serial}] Touch write error: ${err.message}`);
      return false;
    }
  }

  /**
   * Inject keycode via Scrcpy Control Protocol.
   * action: 0=DOWN, 1=UP
   */
  sendKeycode(action, keycode, repeat = 0, metastate = 0) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    const buf = Buffer.allocUnsafe(14);
    buf.writeUInt8(0, 0);           // INJECT_KEYCODE
    buf.writeUInt8(action, 1);
    buf.writeInt32BE(keycode, 2);
    buf.writeInt32BE(repeat, 6);
    buf.writeInt32BE(metastate, 10);
    try {
      this.controlSocket.write(buf);
      return true;
    } catch (_) { return false; }
  }

  sendText(text) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    const textBuf = Buffer.from(text, 'utf-8');
    const buf = Buffer.allocUnsafe(5 + textBuf.length);
    buf.writeUInt8(1, 0);           // INJECT_TEXT
    buf.writeInt32BE(textBuf.length, 1);
    textBuf.copy(buf, 5);
    try {
      this.controlSocket.write(buf);
      return true;
    } catch (_) { return false; }
  }

  async _connectControl() {
    let retries = 30;
    while (retries-- > 0 && this.isRunning) {
      try {
        await new Promise((resolve, reject) => {
          const cs = net.connect({ port: this.videoPort, host: '127.0.0.1' }, () => {
            // Disable Nagle — send control messages immediately
            cs.setNoDelay(true);
            cs.setKeepAlive(true, 1000);
            this.controlSocket = cs;
            cs.on('close', () => {
              this.controlSocket = null;
              if (this.isRunning) setTimeout(() => this._reconnectControl(), 500);
            });
            cs.on('error', () => { this.controlSocket = null; });
            resolve();
          });
          cs.on('error', reject);
        });
        return;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('Timeout connecting to scrcpy control socket');
  }

  async _reconnectControl() {
    if (!this.isRunning) return;
    try {
      await new Promise((resolve, reject) => {
        const cs = net.connect({ port: this.videoPort, host: '127.0.0.1' }, () => {
          cs.setNoDelay(true);
          cs.setKeepAlive(true, 1000);
          this.controlSocket = cs;
          cs.on('close', () => {
            this.controlSocket = null;
            if (this.isRunning) setTimeout(() => this._reconnectControl(), 500);
          });
          cs.on('error', () => { this.controlSocket = null; });
          resolve();
        });
        cs.on('error', reject);
      });
    } catch (_) {
      if (this.isRunning) setTimeout(() => this._reconnectControl(), 1000);
    }
  }

  async _restart() {
    if (!this.isRunning) return;
    logger.info(`[ScrcpyEngine ${this.serial}] Restarting...`);
    try {
      await this._execAdb(['forward', `tcp:${this.videoPort}`, 'localabstract:scrcpy']);
      const scrcpyArgs = [
        '-s', this.serial, 'shell',
        'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
        'app_process', '/', 'com.genymobile.scrcpy.Server', '2.4',
        'tunnel_forward=true', 'video=false', 'audio=false', 'control=true',
        'display_id=0', 'show_touches=false', 'stay_awake=true',
        'power_off_on_close=false', 'clipboard_autosync=false', 'cleanup=true', 'power_on=true',
      ];
      this.serverProc = spawn(ADB_BIN, scrcpyArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (this.serverProc.stderr) {
        this.serverProc.stderr.on('data', (d) => {
          const msg = d.toString().trim();
          if (msg) logger.warn(`[ScrcpyEngine ${this.serial}] ${msg}`);
        });
      }
      this.serverProc.on('error', () => {});
      this.serverProc.on('close', (code) => {
        logger.warn(`[ScrcpyEngine ${this.serial}] Process exited (${code}) — restarting in 1s`);
        this.serverProc = null;
        if (this.controlSocket) { try { this.controlSocket.destroy(); } catch (_) {} this.controlSocket = null; }
        if (this.isRunning) setTimeout(() => this._restart(), 1000);
      });
      await this._connectControl();
      logger.info(`[ScrcpyEngine ${this.serial}] Restarted successfully`);
    } catch (err) {
      logger.warn(`[ScrcpyEngine ${this.serial}] Restart failed: ${err.message} — retrying in 3s`);
      if (this.isRunning) setTimeout(() => this._restart(), 3000);
    }
  }

  _execAdb(args) {
    return new Promise((resolve, reject) => {
      execFile(ADB_BIN, ['-s', this.serial, ...args], (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
  }
}

module.exports = ScrcpyEngine;
