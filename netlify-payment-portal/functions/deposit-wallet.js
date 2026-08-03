'use strict';

const axios = require('axios');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { email, amount, provider } = JSON.parse(event.body);
    const depositAmount = parseFloat(amount || 30);
    const targetEmail = email || 'sammyseth260@gmail.com';
    const appBaseUrl = process.env.VITE_APP_URL || process.env.NETLIFY_PUBLIC_APP_URL || 'https://devicepay.netlify.app';

    if (provider === 'paystack') {
      const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackSecretKey) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            status: 'ok',
            demoMode: true,
            message: `Demo Mode: Depositing $${depositAmount.toFixed(2)} USD into wallet for ${targetEmail}`,
            checkoutUrl: `${appBaseUrl}?deposit=success&amount=${depositAmount}`,
          }),
        };
      }

      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: targetEmail,
          amount: Math.round(depositAmount * 100),
          currency: 'USD',
          metadata: { deposit: true, userId: targetEmail },
          callback_url: `${appBaseUrl.replace(/\/$/, '')}/?deposit=success&amount=${depositAmount}`,
        },
        { headers: { Authorization: `Bearer ${paystackSecretKey}` } }
      );

      return {
        statusCode: 200,
        body: JSON.stringify({ status: 'ok', checkoutUrl: response.data.data.authorization_url }),
      };
    }

    // Default Crypto NOWPayments
    const nowpaymentsApiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!nowpaymentsApiKey) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'ok',
          demoMode: true,
          message: `Demo Crypto Deposit: $${depositAmount.toFixed(2)} USD for ${targetEmail}`,
          invoiceUrl: `${appBaseUrl}?deposit=success&amount=${depositAmount}`,
        }),
      };
    }

    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: depositAmount,
        price_currency: 'usd',
        order_id: `WALLET_DEPOSIT_${Date.now()}`,
        order_description: `Wallet Deposit of $${depositAmount} USD for ${targetEmail}`,
        success_url: `${appBaseUrl.replace(/\/$/, '')}/?deposit=success&amount=${depositAmount}`,
      },
      { headers: { 'x-api-key': nowpaymentsApiKey } }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'ok', invoiceUrl: response.data.invoice_url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'error', message: err.message }),
    };
  }
};
