'use strict';

const axios = require('axios');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { email, targetIdentifier, price_amount, price_currency } = JSON.parse(event.body);
    const nowpaymentsApiKey = process.env.NOWPAYMENTS_API_KEY;

    if (!nowpaymentsApiKey) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'ok',
          demoMode: true,
          message: 'NOWPayments API Key not configured in Netlify Env variables. Set NOWPAYMENTS_API_KEY in Netlify settings.',
          invoiceUrl: `https://nowpayments.io/payment/?iid=demo&email=${encodeURIComponent(email)}&ref=${encodeURIComponent(targetIdentifier)}`,
        }),
      };
    }

    const appBaseUrl = process.env.VITE_APP_URL || process.env.NETLIFY_PUBLIC_APP_URL || process.env.URL || 'https://devicepay.netlify.app';

    const payload = {
      price_amount: price_amount || 30,
      price_currency: price_currency || 'usd',
      order_id: `RENTAL_${Date.now()}_${targetIdentifier}`,
      order_description: `DeviceFarm Monthly Rental Subscription ($30 USD/mo) for ${targetIdentifier}`,
      ipn_callback_url: `${appBaseUrl.replace(/\/$/, '')}/.netlify/functions/webhook-nowpayments`,
      success_url: `${appBaseUrl.replace(/\/$/, '')}/?payment=success&ref=${encodeURIComponent(targetIdentifier)}`,
      cancel_url: `${appBaseUrl.replace(/\/$/, '')}/?payment=cancelled`,
    };

    const response = await axios.post('https://api.nowpayments.io/v1/invoice', payload, {
      headers: {
        'x-api-key': nowpaymentsApiKey,
        'Content-Type': 'application/json',
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'ok',
        invoiceUrl: response.data.invoice_url,
        invoiceId: response.data.id,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'error', message: err.message }),
    };
  }
};
