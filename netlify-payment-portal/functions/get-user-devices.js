'use strict';

const axios = require('axios');

exports.handler = async (event) => {
  const bindingCode = event.queryStringParameters ? event.queryStringParameters.bindingCode : null;
  const rawUserId = event.queryStringParameters ? event.queryStringParameters.userId : null;
  const userId = rawUserId ? rawUserId.toLowerCase().trim() : null;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://dnpuqnmukawehtjxfqct.supabase.co';
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRucHVxbm11a2F3ZWh0anhmcWN0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTQ4ODY2NSwiZXhwIjoyMTAwNTQ4ODA1fQ.ShfY3xyc01tZVEtcIlufacZdaGsCSpcUTLf2M3P0f4c';

  try {
    const client = axios.create({
      baseURL: `${supabaseUrl.replace(/\/$/, '')}/rest/v1`,
      timeout: 6000,
      headers: {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
    });

    let devices = [];
    const seenSerials = new Set();

    // 1. Fetch devices matching user_id = normalized email
    if (userId) {
      try {
        const resUser = await client.get(`/device_rentals?user_id=eq.${encodeURIComponent(userId)}&select=*`);
        if (resUser.data && Array.isArray(resUser.data)) {
          resUser.data.forEach(d => {
            if (!seenSerials.has(d.serial_number)) {
              seenSerials.add(d.serial_number);
              devices.push(d);
            }
          });
        }
      } catch (_) {}
    }

    // 2. Fetch default devices matching RENTAL_USER_DEFAULT
    try {
      const resDefault = await client.get('/device_rentals?user_id=eq.RENTAL_USER_DEFAULT&select=*');
      if (resDefault.data && Array.isArray(resDefault.data)) {
        resDefault.data.forEach(d => {
          if (!seenSerials.has(d.serial_number)) {
            seenSerials.add(d.serial_number);
            devices.push(d);
          }
        });
      }
    } catch (_) {}

    // 3. Query by bindingCode if provided
    if (bindingCode) {
      try {
        const resCode = await client.get(`/device_rentals?user_id=eq.${encodeURIComponent(bindingCode)}&select=*`);
        if (resCode.data && Array.isArray(resCode.data)) {
          resCode.data.forEach(d => {
            if (!seenSerials.has(d.serial_number)) {
              seenSerials.add(d.serial_number);
              devices.push(d);
            }
          });
        }
      } catch (_) {}
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'ok', devices }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'ok', devices: [] }),
    };
  }
};
