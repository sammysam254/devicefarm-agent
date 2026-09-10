/**
 * Key and PIN Generator for Device Stream Access
 */

// Generates a 16-character random word + number key for URL stream link
export function generate16CharKey() {
  const words = ['flex', 'pulse', 'cloud', 'agent', 'cyber', 'hyper', 'nexus', 'shield', 'matrix', 'stream', 'turbo', 'quantum', 'vector', 'blaze', 'alpha', 'delta'];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000).toString();
  let key = `${w1}${w2}${num}`.toLowerCase();
  if (key.length > 16) key = key.substring(0, 16);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  while (key.length < 16) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// Generates a clean 6-digit PIN for stream unlock & dashboard copy
export function generate6DigitPin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Generates a clean, unique cryptographic key for URL stream link
export function generateCleanStreamKey() {
  const words = ['flex', 'pulse', 'cloud', 'agent', 'cyber', 'hyper', 'nexus', 'shield', 'matrix', 'stream', 'turbo', 'quantum', 'vector', 'blaze', 'alpha', 'delta', 'vortex', 'titan', 'apex', 'prism', 'zenith', 'stellar', 'omega'];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  let hex = '';
  try {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
      const arr = new Uint8Array(4);
      window.crypto.getRandomValues(arr);
      hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) {}
  if (!hex) {
    hex = Math.floor(10000000 + Math.random() * 90000000).toString(16);
  }
  return `${w1}${w2}_${hex}`;
}

// Generates a new clean stream URL completely unique from previous ones
export function generateCleanDeviceUrl(currentUrl, serial) {
  const baseUrl = currentUrl ? currentUrl.split('?')[0] : 'https://agent.dennoh.site/';
  const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const newKey = generateCleanStreamKey();
  return {
    streamUrl: `${cleanBase}?udid=${encodeURIComponent(serial)}&key=${encodeURIComponent(newKey)}`,
    key: newKey,
  };
}

// Constructs stream URL with key (clean link)
export function rotateUrlWithKeyAndPin(currentUrl, serial, newKey, newPin) {
  const baseUrl = currentUrl ? currentUrl.split('?')[0] : 'https://agent.dennoh.site/';
  const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const key = newKey || generateCleanStreamKey();
  return `${cleanBase}?udid=${encodeURIComponent(serial)}&key=${encodeURIComponent(key)}`;
}
