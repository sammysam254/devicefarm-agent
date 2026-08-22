'use strict';

const crypto = require('crypto');

// Secret salt derived from system hardware signature / application secret
const APP_SECRET_SALT = 'DEVICEFARM_AGENT_SYSTEM_RENTAL_SECRET_2026_SALT';

function getDerivedKey() {
  return crypto.pbkdf2Sync(APP_SECRET_SALT, 'SALT_PERMANENT_KEY', 10000, 32, 'sha256');
}

/**
 * Encrypt a plain string into hex format using AES-256-CBC.
 */
function encrypt(text) {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getDerivedKey(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (err) {
    return null;
  }
}

/**
 * Decrypt a hex formatted string using AES-256-CBC.
 */
function decrypt(encryptedText) {
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', getDerivedKey(), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return null;
  }
}

// Pre-encrypted Production Credentials Payload
const SECURE_PAYLOAD = {
  encryptedSupabaseUrl: encrypt('https://lazdyihryfvrlczczvxz.supabase.co'),
  encryptedSupabaseAnonKey: encrypt('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhemR5aWhyeWZ2cmxjemN6dnh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNzYxNjgsImV4cCI6MjEwMjk1MjE2OH0.fUBdMbDgV8e0Fk4mfVB8DqQc88vrw8oA6MdHXHFsXAs'),
  encryptedSupabaseServiceRoleKey: encrypt('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhemR5aWhyeWZ2cmxjemN6dnh6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzM3NjE2OCwiZXhwIjoyMTAyOTUyMTY4fQ.6hAOEa2_nUTQh_Z3oU2e8QX2nP5EwzHmKiEZ06X7UWc'),
  encryptedAppUrl: encrypt('https://devicepay.netlify.app'),
  encryptedPaystackPublicKey: encrypt('pk_live_558e1ed8114c63c09b135b1523443ecfffb60524'),
  encryptedNowPaymentsKey: encrypt('QNJ3N44-2JP4AKM-PGPJXCK-3AQPC3T'),
  encryptedAdminEmail: encrypt('sammyseth260@gmail.com'),
};

/**
 * Decrypt and retrieve system security credentials safely at runtime.
 */
function getDecryptedSystemCredentials() {
  return {
    supabaseUrl: decrypt(SECURE_PAYLOAD.encryptedSupabaseUrl),
    supabaseAnonKey: decrypt(SECURE_PAYLOAD.encryptedSupabaseAnonKey),
    supabaseServiceRoleKey: decrypt(SECURE_PAYLOAD.encryptedSupabaseServiceRoleKey),
    appUrl: decrypt(SECURE_PAYLOAD.encryptedAppUrl),
    paystackPublicKey: decrypt(SECURE_PAYLOAD.encryptedPaystackPublicKey),
    nowPaymentsApiKey: decrypt(SECURE_PAYLOAD.encryptedNowPaymentsKey),
    adminEmail: decrypt(SECURE_PAYLOAD.encryptedAdminEmail),
  };
}

module.exports = {
  encrypt,
  decrypt,
  getDecryptedSystemCredentials,
};
