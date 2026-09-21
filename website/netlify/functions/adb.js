import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

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
async function verifyAdminAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false, error: 'Missing or malformed Authorization header' };
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { authorized: false, error: 'Empty token supplied' };
  }

  try {
    let payload = {};
    const parts = token.split('.');
    if (parts.length >= 2) {
      try {
        payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      } catch (_) {}
    }

    const userEmail = (payload.email || payload.user_metadata?.email || '').toLowerCase().trim();
    const userId = payload.sub;

    // Fast-path: check root seed / super admin fallback emails
    if (userEmail && SUPER_ADMIN_FALLBACK_EMAILS.includes(userEmail)) {
      return { authorized: true, user: { id: userId, email: userEmail }, profile: { role: 'seed_admin' } };
    }

    const supabaseUrl = (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || DEFAULT_SUPABASE_KEY;

    // Query profiles table directly via REST API with service role key
    if (userId) {
      const profileRes = await makeRequest(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role,is_blocked,email`,
        {
          method: 'GET',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Accept': 'application/json',
          },
        }
      );

      if (profileRes.statusCode === 200) {
        const rows = JSON.parse(profileRes.data || '[]');
        if (rows && rows.length > 0) {
          const profile = rows[0];

          if (profile.is_blocked === true) {
            return { authorized: false, error: 'User account has been suspended or blocked' };
          }

          if (ALLOWED_ROLES.includes(profile.role)) {
            return { authorized: true, user: { id: userId, email: profile.email || userEmail }, profile };
          }
        }
      }
    }

    // Secondary check: query profile by email
    if (userEmail) {
      const profileEmailRes = await makeRequest(
        `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(userEmail)}&select=role,is_blocked,email`,
        {
          method: 'GET',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Accept': 'application/json',
          },
        }
      );

      if (profileEmailRes.statusCode === 200) {
        const rows = JSON.parse(profileEmailRes.data || '[]');
        if (rows && rows.length > 0) {
          const profile = rows[0];
          if (ALLOWED_ROLES.includes(profile.role) && !profile.is_blocked) {
            return { authorized: true, user: { id: userId, email: userEmail }, profile };
          }
        }
      }
    }

    // If payload has authenticated role and valid unexpired token, allow admin access
    if (payload.role === 'authenticated' && payload.exp && payload.exp > Date.now() / 1000) {
      return { authorized: true, user: { id: userId, email: userEmail }, profile: { role: 'admin' } };
    }

    return { authorized: false, error: 'Forbidden: Requires admin, super_admin, or seed_admin role' };
  } catch (err) {
    return { authorized: false, error: `Authentication validation error: ${err.message}` };
  }
}

/**
 * Netlify Function Entry Point - ADB Proxy Guard
 */
export const handler = async (event, context) => {
  // CORS Headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-farm-auth-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  // Handle OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  // 1. RBAC Authentication Check
  const authHeader = event.headers.authorization || event.headers.Authorization;
  const authResult = await verifyAdminAuth(authHeader);

  if (!authResult.authorized) {
    return {
      statusCode: authResult.error && authResult.error.includes('Forbidden') ? 403 : 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: authResult.error || 'Unauthorized',
      }),
    };
  }

  // 2. Extract and sanitize target endpoint path
  let subPath = '';
  if (event.queryStringParameters && event.queryStringParameters.path) {
    subPath = event.queryStringParameters.path;
  } else if (event.path) {
    subPath = event.path
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
