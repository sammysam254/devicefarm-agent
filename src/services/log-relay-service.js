'use strict';

const winston = require('winston');
const Transport = require('winston-transport');
const { createClient } = require('@supabase/supabase-js');
const bindingService = require('./binding-service');

const RING_BUFFER_MAX = 200;
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

function pushLog(info) {
  const bindingCode = bindingService.getOrGenerateBindingCode ? bindingService.getOrGenerateBindingCode() : 'UNKNOWN';
  const entry = {
    id: ++bufferSeq,
    timestamp: info.timestamp || new Date().toISOString(),
    level: info.level || 'info',
    message: typeof info.message === 'string' ? info.message : JSON.stringify(info.message),
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
    batchFlushTimer = setTimeout(flushBatch, 800);
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

function initLogRelay(loggerInstance) {
  if (isInitialized) return;
  isInitialized = true;

  try {
    const creds = bindingService.getSupabaseCredentials ? bindingService.getSupabaseCredentials() : {};
    if (creds.supabaseUrl && (creds.supabaseAnonKey || creds.supabaseServiceRoleKey)) {
      supabaseClient = createClient(creds.supabaseUrl, creds.supabaseAnonKey || creds.supabaseServiceRoleKey, {
        realtime: {
          params: {
            eventsPerSecond: 10,
          },
        },
      });

      realtimeChannel = supabaseClient.channel('system_logs_broadcast', {
        config: { broadcast: { self: false } },
      });

      realtimeChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Send initial announcement
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

function getRecentLogs(limit = 100) {
  return ringBuffer.slice(-Math.min(limit, RING_BUFFER_MAX));
}

module.exports = {
  initLogRelay,
  pushLog,
  getRecentLogs,
  RealtimeLogTransport,
};
