'use strict';

const walletStore = require('./wallet-store');

exports.handler = async (event) => {
  const userId = (event.queryStringParameters ? event.queryStringParameters.userId : null) || 'sammdev.ai@gmail.com';

  try {
    const balance = await walletStore.getBalance(userId);
    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'ok', userId, balance }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'ok', userId, balance: 0.00 }),
    };
  }
};
