'use strict';

const axios = require('axios');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { email, targetIdentifier, amount } = JSON.parse(event.body);
    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!paystackSecretKey) {
      // Demo Mode / Sandbox Fallback response if keys not yet set on Netlify
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'ok',
          demoMode: true,
          message: 'Paystack Secret Key not configured in Netlify Env variables. Set PAYSTACK_SECRET_KEY in Netlify settings.',
          checkoutUrl: `https://paystack.com/pay/devicefarm-demo?email=${encodeURIComponent(email)}&ref=${encodeURIComponent(targetIdentifier)}`,
        }),
      };
    }

    const appBaseUrl = process.env.VITE_APP_URL || process.env.NETLIFY_PUBLIC_APP_URL || process.env.URL || 'https://devicepay.netlify.app';

    const payload = {
      email: email,
      amount: (amount || 30) * 100, // Paystack uses smallest currency unit (kobo/cents)
      currency: 'USD',
      metadata: { targetIdentifier },
      callback_url: `${appBaseUrl.replace(/\/$/, '')}/?payment=success&ref=${encodeURIComponent(targetIdentifier)}`,
    };

    const response = await axios.post('https://api.paystack.co/transaction/initialize', payload, {
      headers: {
        Authorization: `Bearer ${paystackSecretKey}`,
        'Content-Type': 'application/json',
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'ok',
        checkoutUrl: response.data.data.authorization_url,
        reference: response.data.data.reference,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'error', message: err.message }),
    };
  }
};
