'use strict';

const fs = require('fs');
const path = require('path');
let logger;
try {
  logger = require('./logger');
} catch (_) {
  logger = console;
}

/**
 * Discovers all existing adbkey files on the Windows system
 * and sets the ADB_VENDOR_KEYS environment variable so the ADB server
 * attempts authentication using all known host authorization keys.
 */
function ensureAdbVendorKeys() {
  const discoveredKeys = new Set();

  // 1. Current user profile
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  if (userProfile) {
    const p = path.join(userProfile, '.android', 'adbkey');
    if (fs.existsSync(p)) discoveredKeys.add(path.resolve(p));
  }

  // 2. All user profiles on Windows (e.g. C:\Users\<Username>\.android\adbkey)
  try {
    const usersDir = 'C:\\Users';
    if (fs.existsSync(usersDir)) {
      const entries = fs.readdirSync(usersDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          const k = path.join(usersDir, ent.name, '.android', 'adbkey');
          if (fs.existsSync(k)) discoveredKeys.add(path.resolve(k));
        }
      }
    }
  } catch (_) {}

  // 3. SYSTEM profile (C:\Windows\System32\config\systemprofile\.android\adbkey)
  try {
    const sysKey = 'C:\\Windows\\System32\\config\\systemprofile\\.android\\adbkey';
    if (fs.existsSync(sysKey)) discoveredKeys.add(path.resolve(sysKey));
  } catch (_) {}

  // 4. Any keys already in ADB_VENDOR_KEYS
  if (process.env.ADB_VENDOR_KEYS) {
    process.env.ADB_VENDOR_KEYS.split(path.delimiter).forEach(p => {
      const clean = p.trim();
      if (clean && fs.existsSync(clean)) discoveredKeys.add(path.resolve(clean));
    });
  }

  const keyList = Array.from(discoveredKeys);
  if (keyList.length > 0) {
    process.env.ADB_VENDOR_KEYS = keyList.join(path.delimiter);
    logger.info(`[ADB Keys] Configured ADB_VENDOR_KEYS with ${keyList.length} host key(s): ${keyList.join('; ')}`);

    // Ensure the current user's .android has an adbkey file
    if (userProfile) {
      const myAndroidDir = path.join(userProfile, '.android');
      const myKey = path.join(myAndroidDir, 'adbkey');
      const myPub = path.join(myAndroidDir, 'adbkey.pub');
      if (!fs.existsSync(myKey) && keyList[0]) {
        try {
          if (!fs.existsSync(myAndroidDir)) fs.mkdirSync(myAndroidDir, { recursive: true });
          fs.copyFileSync(keyList[0], myKey);
          if (fs.existsSync(keyList[0] + '.pub')) {
            fs.copyFileSync(keyList[0] + '.pub', myPub);
          }
          logger.info(`[ADB Keys] Seeded missing user adbkey from ${keyList[0]}`);
        } catch (_) {}
      }
    }

    // Ensure SYSTEM profile has the same key if it exists
    try {
      const sysAndroidDir = 'C:\\Windows\\System32\\config\\systemprofile\\.android';
      if (fs.existsSync('C:\\Windows\\System32\\config\\systemprofile')) {
        const sysKey = path.join(sysAndroidDir, 'adbkey');
        const sysPub = path.join(sysAndroidDir, 'adbkey.pub');
        if (!fs.existsSync(sysKey) && keyList[0]) {
          if (!fs.existsSync(sysAndroidDir)) fs.mkdirSync(sysAndroidDir, { recursive: true });
          fs.copyFileSync(keyList[0], sysKey);
          if (fs.existsSync(keyList[0] + '.pub')) {
            fs.copyFileSync(keyList[0] + '.pub', sysPub);
          }
        }
      }
    } catch (_) {}
  } else {
    logger.warn('[ADB Keys] No existing adbkey files found in standard profile paths.');
  }

  return keyList;
}

module.exports = { ensureAdbVendorKeys };
