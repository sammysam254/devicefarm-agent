'use strict';

const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const { app } = require('electron');

function getLogDir() {
  try {
    return path.join(app.getPath('userData'), 'logs');
  } catch (_err) {
    return path.join(process.cwd(), 'logs');
  }
}

const logDir = getLogDir();

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
      const cleanMessage = String(message).replace(/[^\x00-\x7F]/g, '');
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
    winston.format.json(),
  ),
  defaultMeta: { service: 'device-agent' },
  transports: [consoleTransport, fileRotateTransport],
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

module.exports = logger;
