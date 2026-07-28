'use strict';

const { spawn, exec, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const logger = require('../utils/logger');

const ADB_BIN = process.platform === 'win32' ? 'C:\\platform-tools\\adb.exe' : 'adb';
const SCRCPY_JAR_PATH = path.join(process.cwd(), 'scrcpy-server.jar');

/**
 * Scrcpy Engine for a single device.
 * Pushes scrcpy-server.jar, starts device server, connects to video & control sockets,
 * parses H.264 video streams, and injects touchscreen input events natively via InputManager.
 */
class ScrcpyEngine extends EventEmitter {
  constructor(serial) {
    super();
    this.serial = serial;
    this.serverProc = null;
    this.controlSocket = null;
    this.isRunning = false;
    this.videoPort = null;
    this.wsClients = new Set();
  }

  get isReady() {
    return this.isRunning && this.controlSocket && !this.controlSocket.destroyed;
  }

  async start(videoPort, controlPort) {
    if (this.isRunning) return;
    this.videoPort = videoPort;
    this.controlPort = controlPort;
    this.isRunning = true;

    try {
      // 1. Push scrcpy-server.jar to device /data/local/tmp
      await this._execAdb(['push', SCRCPY_JAR_PATH, '/data/local/tmp/scrcpy-server.jar']);

      // 2. Setup socket port forwards
      await this._execAdb(['forward', `tcp:${videoPort}`, 'localabstract:scrcpy']);

      // 3. Launch scrcpy server on device — video=false: control-only, no PiP, no video socket
      const scrcpyArgs = [
        '-s',
        this.serial,
        'shell',
        'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        '2.4',
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
        'power_on=true'
      ];

      this.serverProc = spawn(ADB_BIN, scrcpyArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (this.serverProc.stderr) {
        this.serverProc.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) logger.warn(`[ScrcpyEngine ${this.serial} stderr] ${msg}`);
        });
      }

      this.serverProc.on('error', (err) => {
        logger.error(`[ScrcpyEngine ${this.serial}] Server process error:`, err.message);
      });

      this.serverProc.on('close', (code) => {
        logger.warn(`[ScrcpyEngine ${this.serial}] Server process exited with code ${code} — auto-restarting...`);
        this.serverProc = null;
        if (this.controlSocket) { try { this.controlSocket.destroy(); } catch (_) {} this.controlSocket = null; }
        if (this.isRunning) setTimeout(() => this._restart(), 1000);
      });

      // 4. Connect control socket (video=false: only control)
      await this._connectSockets();

      logger.info(`[ScrcpyEngine ${this.serial}] Started successfully`);
    } catch (err) {
      logger.error(`[ScrcpyEngine ${this.serial}] Failed to start:`, err.message);
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

    this.wsClients.clear();
    this.emit('stopped');
  }

  addClient(ws) {
    this.wsClients.add(ws);
  }

  removeClient(ws) {
    this.wsClients.delete(ws);
  }

  /**
   * Inject touch event directly via Scrcpy Control Protocol.
   * Action: 0 = AMOTION_EVENT_ACTION_DOWN, 1 = UP, 2 = MOVE
   * Injected natively as SOURCE_TOUCHSCREEN via Android InputManager.
   */
  sendTouchEvent(action, x, y, width, height, pointerId = 0n, pressure = 1.0) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;

    const buf = Buffer.alloc(28);
    buf.writeUInt8(2, 0); // INJECT_TOUCH_EVENT
    buf.writeUInt8(action, 1);
    buf.writeBigInt64BE(BigInt(pointerId), 2);
    buf.writeInt32BE(Math.round(x), 10);
    buf.writeInt32BE(Math.round(y), 14);
    buf.writeUInt16BE(Math.round(width), 18);
    buf.writeUInt16BE(Math.round(height), 20);
    buf.writeUInt16BE(Math.floor(pressure * 65535), 22);
    buf.writeInt32BE(0, 24); // buttons

    try {
      this.controlSocket.write(buf);
      return true;
    } catch (err) {
      logger.error(`[ScrcpyEngine ${this.serial}] Touch write error:`, err.message);
      return false;
    }
  }

  /**
   * Inject Keycode via Scrcpy Control Protocol.
   * Action: 0 = ACTION_DOWN, 1 = ACTION_UP
   */
  sendKeycode(action, keycode, repeat = 0, metastate = 0) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;

    const buf = Buffer.alloc(14);
    buf.writeUInt8(0, 0); // INJECT_KEYCODE
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
    const buf = Buffer.alloc(5 + textBuf.length);
    buf.writeUInt8(1, 0); // INJECT_TEXT
    buf.writeInt32BE(textBuf.length, 1);
    textBuf.copy(buf, 5);

    try {
      this.controlSocket.write(buf);
      return true;
    } catch (_) { return false; }
  }

  async _connectSockets() {
    let retries = 30;
    while (retries > 0 && this.isRunning) {
      try {
        // video=false: only one control socket is opened by scrcpy
        await new Promise((resolve, reject) => {
          const cs = net.connect({ port: this.videoPort, host: '127.0.0.1' }, () => {
            this.controlSocket = cs;
            cs.on('close', () => {
              logger.warn(`[ScrcpyEngine ${this.serial}] Control socket closed — reconnecting...`);
              this.controlSocket = null;
              if (this.isRunning) setTimeout(() => this._reconnectControl(), 500);
            });
            cs.on('error', () => { this.controlSocket = null; });
            resolve();
          });
          cs.on('error', reject);
        });
        return;
      } catch (err) {
        retries--;
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
        'power_off_on_close=false', 'clipboard_autosync=false',
        'cleanup=true', 'power_on=true'
      ];
      this.serverProc = spawn(ADB_BIN, scrcpyArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (this.serverProc.stderr) {
        this.serverProc.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) logger.warn(`[ScrcpyEngine ${this.serial} stderr] ${msg}`);
        });
      }
      this.serverProc.on('error', () => {});
      this.serverProc.on('close', (code) => {
        logger.warn(`[ScrcpyEngine ${this.serial}] Server process exited with code ${code} — auto-restarting...`);
        this.serverProc = null;
        if (this.controlSocket) { try { this.controlSocket.destroy(); } catch (_) {} this.controlSocket = null; }
        if (this.isRunning) setTimeout(() => this._restart(), 1000);
      });
      await this._connectSockets();
      logger.info(`[ScrcpyEngine ${this.serial}] Restarted successfully`);
    } catch (err) {
      logger.warn(`[ScrcpyEngine ${this.serial}] Restart failed: ${err.message} — retrying in 3s`);
      if (this.isRunning) setTimeout(() => this._restart(), 3000);
    }
  }

  _execAdb(args) {
    return new Promise((resolve, reject) => {
      execFile(ADB_BIN, ['-s', this.serial, ...args], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }
}

module.exports = ScrcpyEngine;
