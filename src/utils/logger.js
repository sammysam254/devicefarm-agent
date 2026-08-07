'use strict';

const path = require('path');
const winston = require('winston');
const crypto = require('crypto');
const fs = require('fs');
require('winston-daily-rotate-file');

const { app } = require('electron');

// Hash device serials to prevent forensic enumeration if logs are compromised
function hashSerial(serial) {
  if (!serial || typeof serial !== 'string') return 'unknown';
  const hash = crypto.createHash('sha256').update(serial).digest('hex');
  return `[${hash.substring(0, 8)}]`; // Show first 8 chars of hash
}

// Sanitize error messages to remove tool names and infrastructure identifiers
function sanitizeMessage(message) {
  if (typeof message !== 'string') return String(message);
  
  return message
    // Remove tool names
    .replace(/scrcpy/gi, 'video_engine')
    .replace(/cloudflared/gi, 'tunnel_proxy')
    .replace(/localtunnel/gi, 'tunnel_service')
    .replace(/genymobile/gi, 'mobile_service')
    // Remove specific URLs and paths
    .replace(/https:\/\/github\.com[^\s]*/g, '[github_url]')
    .replace(/cloudflare\.com/gi, '[cdn]')
    .replace(/C:\\cloudflared\\/gi, 'C:\\System\\')
    .replace(/\/root\//g, '/system/')
    // Remove process names that reveal infrastructure
    .replace(/\[ScrcpyEngine\]/g, '[VideoEngine]')
    .replace(/\[StreamServer\]/g, '[StreamService]')
    .replace(/\[TunnelService\]/g, '[ProxyService]')
    .replace(/\[StealthService\]/g, '[SystemService]')
    .replace(/\[BindingService\]/g, '[ConfigService]')
    .replace(/\[LicenseService\]/g, '[AuthService]')
    .replace(/\[DashboardServer\]/g, '[AdminPanel]')
    // Remove binary/executable names
    .replace(/\.exe(?!\s)/gi, '.bin')
    .replace(/\.jar(?!\s)/gi, '.lib');
}

// Encryption utility for log file protection
class LogEncryptor {
  constructor() {
    // Use a static key derived from machine hardware + module path (not random)
    // This ensures logs can be encrypted/decrypted consistently on same machine
    const keyMaterial = require('os').hostname() + __dirname;
    this.key = crypto.createHash('sha256').update(keyMaterial).digest();
  }
  
  encrypt(plaintext) {
    // Use random IV for each message to prevent pattern detection
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    // Return IV + encrypted data
    return iv.toString('hex') + ':' + encrypted;
  }
  
  decrypt(ciphertext) {
    try {
      const [ivHex, encrypted] = ciphertext.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', this.key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (_) {
      return ciphertext; // Return original if decrypt fails
    }
  }
}

const logEncryptor = new LogEncryptor();

function getLogDir() {
  try {
    return path.join(app.getPath('userData'), 'logs');
  } catch (_err) {
    return path.join(process.cwd(), 'logs');
  }
}

const logDir = getLogDir();

// Use standard file transport for now (encryption can be added later if needed)
const fileRotateTransport = new winston.transports.DailyRotateFile({
  dirname: logDir,
  filename: 'agent-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  zippedArchive: false,
});

const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      // Clean ASCII string sanitize for Windows CMD / PowerShell compatibility
      const cleanMessage = sanitizeMessage(String(message)).replace(/[^\x00-\x7F]/g, '');
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level}] ${cleanMessage}${metaStr}`;
    }),
  ),
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      // Sanitize message before formatting to JSON
      const sanitized = sanitizeMessage(String(message));
      return JSON.stringify({
        timestamp,
        level,
        message: sanitized,
        ...meta
      });
    }),
  ),
  defaultMeta: { service: 'device-agent' },
  transports: [consoleTransport, fileRotateTransport],
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

module.exports = logger;
module.exports.hashSerial = hashSerial;
module.exports.sanitizeMessage = sanitizeMessage;
module.exports.logEncryptor = logEncryptor;
