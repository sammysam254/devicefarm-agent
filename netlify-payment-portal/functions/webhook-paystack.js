'use strict';

const axios = require('axios');

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);

    if (body.event === 'charge.success') {
      const data = body.data;
      const metadata = data.metadata || {};
      const targetIdentifier = metadata.targetIdentifier || 'RENTAL_USER_DEFAULT';
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();

      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

      if (supabaseUrl && supabaseAnonKey) {
        // Upsert paid device rental status into Supabase
        await axios.post(
          `${supabaseUrl.replace(/\/$/, '')}/rest/v1/device_rentals`,
          {
            serial_number: targetIdentifier,
            user_id: targetIdentifier,
            status: 'active',
            monthly_fee: 30.0,
            currency: 'USD',
            expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          },
          {
            headers: {
              apikey: supabaseAnonKey,
              Authorization: `Bearer ${supabaseAnonKey}`,
              Prefer: 'resolution=merge-duplicates',
              'Content-Type': 'application/json',
            },
          }
        );
      }
    }

    return { statusCode: 200, body: JSON.stringify({ status: 'success' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
