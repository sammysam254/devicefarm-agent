'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_SUPABASE_URL = 'https://lazdyihryfvrlczczvxz.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhemR5aWhyeWZ2cmxjemN6dnh6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzM3NjE2OCwiZXhwIjoyMTAyOTUyMTY4fQ.6hAOEa2_nUTQh_Z3oU2e8QX2nP5EwzHmKiEZ06X7UWc';
const DEFAULT_FARM_TUNNEL_URL = 'https://agent.dennoh.site';

const ALLOWED_ROLES = ['admin', 'super_admin', 'seed_admin'];
const SUPER_ADMIN_FALLBACK_EMAILS = ['sammdev.ai@gmail.com', 'sammyseth260@gmail.com'];

/**
 * Perform a clean HTTP/HTTPS request with promises.
 */
function makeRequest(targetUrl, options, postData = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const reqOpts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 25000,
    };

    const req = client.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Target request timed out after 25s'));
    });

    req.on('error', err => reject(err));

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

/**
 * Authenticate caller with Supabase JWT and verify administrative role.
 */
async function verifyAdminRole(authHeader) {
  if (!authHeader) {
    return { ok: false, error: 'Missing Authorization header' };
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { ok: false, error: 'Malformed Bearer token' };
  }

  const supabaseUrl = (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_KEY;

  // 1. Get user identity from Supabase Auth
  let userRes;
  try {
    userRes = await makeRequest(`${supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${token}`,
      },
    });
  } catch (err) {
    return { ok: false, error: `Authentication network error: ${err.message}` };
  }

  if (userRes.statusCode !== 200) {
    return { ok: false, error: 'Invalid or expired authentication session' };
  }

  let user;
  try {
    user = JSON.parse(userRes.data);
  } catch (_) {
    return { ok: false, error: 'Invalid response from auth provider' };
  }

  const userEmail = (user.email || '').toLowerCase().trim();
  const userId = user.id;

  // Super admin fallback whitelist
  if (SUPER_ADMIN_FALLBACK_EMAILS.includes(userEmail)) {
    return { ok: true, user, role: 'super_admin' };
  }

  // 2. Fetch role from public.profiles table
  let profileRes;
  try {
    profileRes = await makeRequest(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role,is_blocked`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Accept': 'application/json',
        },
      }
    );
  } catch (err) {
    return { ok: false, error: `Profile lookup error: ${err.message}` };
  }

  let profiles = [];
  try {
    profiles = JSON.parse(profileRes.data);
  } catch (_) {}

  const profile = profiles[0] || {};
  if (profile.is_blocked === true) {
    return { ok: false, error: 'Account has been restricted or blocked' };
  }

  const role = profile.role || 'worker';
  if (!ALLOWED_ROLES.includes(role)) {
    return { ok: false, error: `Unauthorized: Role '${role}' lacks kiosk administration rights` };
  }

  return { ok: true, user, role };
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-farm-auth-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: '',
    };
  }

  // 1. RBAC Guard: Verify JWT & Role
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const authCheck = await verifyAdminRole(authHeader);

  if (!authCheck.ok) {
    return {
      statusCode: authCheck.error.includes('Unauthorized') ? 403 : 401,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'error',
        message: authCheck.error,
      }),
    };
  }

  // 2. Resolve Forwarded API Path
  let subPath = '';
  if (event.queryStringParameters && event.queryStringParameters.path) {
    subPath = event.queryStringParameters.path;
  } else {
    subPath = (event.path || '')
      .replace(/^\/\.netlify\/functions\/adb/, '')
      .replace(/^\/api\/adb/, '')
      .replace(/^\/api/, '');
  }

  if (!subPath.startsWith('/')) {
    subPath = '/' + subPath;
  }

  // Whitelist / validate supported kiosk routes
  const isAllowedPath = 
    subPath === '/devices' ||
    /^\/devices\/[^/]+\/apps$/.test(subPath) ||
    /^\/devices\/[^/]+\/lockdown$/.test(subPath) ||
    /^\/devices\/[^/]+\/unlock$/.test(subPath) ||
    /^\/devices\/[^/]+\/install-playstore$/.test(subPath);

  if (!isAllowedPath) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'error',
        message: `Endpoint '${subPath}' is not a permitted kiosk route`,
      }),
    };
  }

  // 3. Proxy to Cloudflare Tunnel Target
  const tunnelBase = (process.env.FARM_TUNNEL_URL || DEFAULT_FARM_TUNNEL_URL).replace(/\/$/, '');
  const targetUrl = `${tunnelBase}/api${subPath}`;
  const farmSecretKey = process.env.FARM_SECRET_KEY || '';

  try {
    const proxyRes = await makeRequest(targetUrl, {
      method: event.httpMethod,
      headers: {
        'Content-Type': 'application/json',
        'x-farm-auth-key': farmSecretKey,
      },
    }, event.body);

    return {
      statusCode: proxyRes.statusCode,
      headers: {
        ...corsHeaders,
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
      },
      body: proxyRes.data,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'error',
        message: `Cloudflare Tunnel connection failed: ${err.message}`,
        targetUrl,
      }),
    };
  }
};
