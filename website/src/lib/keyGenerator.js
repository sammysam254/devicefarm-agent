/**
 * Generates a 16-character random word + number key for stream link rotation.
 * Format: 16 characters lowercase alphanumeric, e.g. "flexstream8492k7", "quantumvector391"
 */
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

export function rotateUrlWithKey(currentUrl, serial, newKey) {
  const baseUrl = currentUrl ? currentUrl.split('?')[0] : 'https://agent.dennoh.site/';
  const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${cleanBase}?udid=${encodeURIComponent(serial)}&key=${encodeURIComponent(newKey)}`;
}
