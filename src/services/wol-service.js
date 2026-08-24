'use strict';

/**
 * DeviceFarm Agent — Wake-on-LAN (WoL) Remote Power-On Service
 *
 * Constructs and broadcasts standard WoL Magic Packets (UDP port 9/7)
 * to remotely turn on or wake sleeping / powered-off computers on the network.
 */

const dgram = require('dgram');
let logger;
try {
  logger = require('../utils/logger');
} catch (_) {
  logger = {
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a),
  };
}

/**
 * Clean and format a MAC address into a 6-byte buffer.
 * Accepts formats: "00:11:22:33:44:55", "00-11-22-33-44-55", "001122334455"
 *
 * @param {string} mac - The target machine MAC address
 * @returns {Buffer} 6-byte Buffer
 */
function parseMacAddress(mac) {
  if (!mac || typeof mac !== 'string') {
    throw new Error('Invalid MAC address provided');
  }

  const cleanMac = mac.replace(/[^0-9A-Fa-f]/g, '');
  if (cleanMac.length !== 12) {
    throw new Error(`Invalid MAC address length (${cleanMac.length}). Expected 12 hexadecimal characters.`);
  }

  const buffer = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    buffer[i] = parseInt(cleanMac.substr(i * 2, 2), 16);
  }
  return buffer;
}

/**
 * Creates a standard Wake-on-LAN Magic Packet:
 * 6 bytes of 0xFF followed by 16 repetitions of the target 6-byte MAC address (102 bytes total).
 *
 * @param {string} mac - Target MAC address
 * @returns {Buffer} 102-byte Magic Packet
 */
function createMagicPacket(mac) {
  const macBuffer = parseMacAddress(mac);
  const magicPacket = Buffer.alloc(102);

  // 6 bytes of 0xFF
  for (let i = 0; i < 6; i++) {
    magicPacket[i] = 0xff;
  }

  // 16 repetitions of target MAC
  for (let i = 0; i < 16; i++) {
    macBuffer.copy(magicPacket, 6 + i * 6, 0, 6);
  }

  return magicPacket;
}

/**
 * Broadcasts a Wake-on-LAN Magic Packet over UDP.
 *
 * @param {string} mac - Target physical MAC address
 * @param {string} [broadcastAddress='255.255.255.255'] - Subnet broadcast IP or global broadcast
 * @param {number} [port=9] - Target UDP port (typically 9 or 7)
 * @returns {Promise<{success: boolean, mac: string, target: string}>}
 */
function sendWakeOnLan(mac, broadcastAddress = '255.255.255.255', port = 9) {
  return new Promise((resolve, reject) => {
    try {
      const packet = createMagicPacket(mac);
      const socket = dgram.createSocket('udp4');

      socket.on('error', (err) => {
        logger.error(`[WoL] Socket error: ${err.message}`);
        socket.close();
        reject(err);
      });

      socket.bind(() => {
        socket.setBroadcast(true);

        socket.send(packet, 0, packet.length, port, broadcastAddress, (err) => {
          socket.close();
          if (err) {
            logger.error(`[WoL] Failed to send Magic Packet to ${mac}: ${err.message}`);
            return reject(err);
          }

          logger.info(`[WoL] Magic Packet successfully sent to ${mac} via ${broadcastAddress}:${port}`);
          resolve({ success: true, mac, target: `${broadcastAddress}:${port}` });
        });
      });
    } catch (err) {
      logger.error(`[WoL] Error constructing Magic Packet: ${err.message}`);
      reject(err);
    }
  });
}

/**
 * Listen for remote Wake-on-LAN commands issued from Seed Admin via Supabase.
 * Any online farm machine can act as a local WoL dispatcher to wake sleeping neighbors!
 */
let wolSubscription = null;

function startWolRemoteListener(supabaseUrl, supabaseKey) {
  if (!supabaseUrl || !supabaseKey) return;

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);

    wolSubscription = supabase
      .channel('wol_broadcast_channel')
      .on('broadcast', { event: 'WAKE_MACHINE' }, async ({ payload }) => {
        if (payload && payload.mac) {
          logger.info(`[WoL] Received remote wake request for MAC: ${payload.mac}`);
          try {
            await sendWakeOnLan(payload.mac, payload.broadcastAddress || '255.255.255.255');
          } catch (err) {
            logger.warn(`[WoL] Remote wake execution notice: ${err.message}`);
          }
        }
      })
      .subscribe();

    logger.info('[WoL] Remote Wake-on-LAN relay listener is ACTIVE');
  } catch (err) {
    logger.warn(`[WoL] Remote relay init notice: ${err.message}`);
  }
}

function stopWolRemoteListener() {
  if (wolSubscription) {
    try { wolSubscription.unsubscribe(); } catch (_) {}
    wolSubscription = null;
  }
}

module.exports = {
  createMagicPacket,
  sendWakeOnLan,
  startWolRemoteListener,
  stopWolRemoteListener,
};
