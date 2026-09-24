'use strict';

const winston = require('winston');
const Transport = require('winston-transport');
const { createClient } = require('@supabase/supabase-js');
const bindingService = require('./binding-service');

const RING_BUFFER_MAX = 500;
const ringBuffer = [];
let bufferSeq = 0;
let realtimeChannel = null;
let supabaseClient = null;
let pendingBatch = [];
let batchFlushTimer = null;
let isInitialized = false;

class RealtimeLogTransport extends Transport {
  constructor(opts) {
    super(opts);
  }

  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    if (info && info.message) {
      pushLog(info);
    }
    callback();
  }
}

function categorizeLog(message = '', level = 'info') {
  const msgLower = String(message).toLowerCase();
  const lvlLower = String(level).toLowerCase();

  if (msgLower.includes('autoheal') || msgLower.includes('auto-heal') || msgLower.includes('recovering') || msgLower.includes('self-healing') || msgLower.includes('healed') || msgLower.includes('recovered')) {
    return 'auto_heal';
  }
  if (lvlLower === 'error' || msgLower.includes('error') || msgLower.includes('failed') || msgLower.includes('crash') || msgLower.includes('critical') || msgLower.includes('unauthorized') || msgLower.includes('offline')) {
    return 'error';
  }
  if (lvlLower === 'warn' || msgLower.includes('warn') || msgLower.includes('stall') || msgLower.includes('disconnected')) {
    return 'warn';
  }
  if (msgLower.includes('device') || msgLower.includes('stream') || msgLower.includes('provision') || msgLower.includes('scrcpy') || msgLower.includes('usb')) {
    return 'device';
  }
  return 'system';
}

function pushLog(info) {
  const bindingCode = bindingService.getOrGenerateBindingCode ? bindingService.getOrGenerateBindingCode() : 'UNKNOWN';
  const rawMsg = typeof info.message === 'string' ? info.message : JSON.stringify(info.message);
  const level = info.level || 'info';
  const category = categorizeLog(rawMsg, level);

  const entry = {
    id: ++bufferSeq,
    timestamp: info.timestamp || new Date().toISOString(),
    level: level,
    category: category,
    message: rawMsg,
    bindingCode,
    meta: info.meta || undefined,
  };

  // Keep ring buffer size bounded
  ringBuffer.push(entry);
  if (ringBuffer.length > RING_BUFFER_MAX) {
    ringBuffer.shift();
  }

  pendingBatch.push(entry);

  if (!batchFlushTimer) {
    batchFlushTimer = setTimeout(flushBatch, 400);
  }
}

function flushBatch() {
  batchFlushTimer = null;
  if (pendingBatch.length === 0) return;

  const batchToSend = [...pendingBatch];
  pendingBatch = [];

  if (realtimeChannel && realtimeChannel.state === 'joined') {
    try {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'log_batch',
        payload: {
          logs: batchToSend,
          bindingCode: bindingService.getOrGenerateBindingCode ? bindingService.getOrGenerateBindingCode() : '',
          hostname: require('os').hostname(),
        },
      });
    } catch (_) {}
  }
}

function broadcastHistory() {
  if (realtimeChannel && realtimeChannel.state === 'joined') {
    try {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'log_history',
        payload: {
          logs: ringBuffer.slice(-250),
          bindingCode: bindingService.getOrGenerateBindingCode ? bindingService.getOrGenerateBindingCode() : '',
          hostname: require('os').hostname(),
        },
      });
    } catch (_) {}
  }
}

function initLogRelay(loggerInstance) {
  if (isInitialized) return;
  isInitialized = true;

  try {
    const creds = bindingService.getSupabaseCredentials ? bindingService.getSupabaseCredentials() : {};
    if (creds.supabaseUrl && (creds.supabaseAnonKey || creds.supabaseServiceRoleKey)) {
      supabaseClient = createClient(creds.supabaseUrl, creds.supabaseAnonKey || creds.supabaseServiceRoleKey, {
        realtime: {
          params: {
            eventsPerSecond: 20,
          },
        },
      });

      realtimeChannel = supabaseClient.channel('system_logs_broadcast', {
        config: { broadcast: { self: false } },
      });

      // Listen for website requesting previous log history on modal open
      realtimeChannel.on('broadcast', { event: 'request_history' }, () => {
        broadcastHistory();
      });

      realtimeChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Send initial announcement with recent history
          broadcastHistory();
          flushBatch();
        }
      });
    }
  } catch (err) {
    // Gracefully handle offline or standalone setups
  }

  // Hook into logger if provided
  if (loggerInstance && typeof loggerInstance.add === 'function') {
    const transport = new RealtimeLogTransport({ level: 'info' });
    loggerInstance.add(transport);
  }
}

function getRecentLogs(limit = 200) {
  return ringBuffer.slice(-Math.min(limit, RING_BUFFER_MAX));
}

module.exports = {
  initLogRelay,
  pushLog,
  getRecentLogs,
  broadcastHistory,
  RealtimeLogTransport,
};
