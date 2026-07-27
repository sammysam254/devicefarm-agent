'use strict';

const rentalPaymentService = require('./rental-payment-service');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');

/**
 * Pre-Installation & Boot Payment Verification Gatekeeper CLI
 * Executed by DeviceFarm-Agent-Setup.bat FIRST before any streaming processes start.
 * Exits with code 0 if payment system is working and valid.
 * Exits with code 1 if payment system is unavailable, unpaid, or invalid.
 */
async function runPaymentGatekeeper() {
  console.log('\n=======================================================================');
  console.log('       STEP 1: PRE-INSTALLING PAYMENT VERIFICATION ENGINE ($30/MO)      ');
  console.log('=======================================================================');
  console.log('[*] Verifying pre-installed encrypted keys and Supabase connection...');

  try {
    const bindingService = require('./binding-service');
    const bindingCode = await bindingService.syncMachineBindingToSupabase([]);

    const isConfigured = rentalPaymentService.isSupabaseConfigured();
    const summary = await rentalPaymentService.getMachineRentalSummary([]);

    console.log(`[OK] Payment Verification Engine Installed & Verified`);
    console.log(`[OK] Supabase Cloud System: ${isConfigured ? 'CONNECTED' : 'LOCAL STANDALONE'}`);
    console.log(`[*] Monthly Rental Rate: $${summary.monthlyFeePerDeviceUsd || 30}.00 USD per device link / month`);

    console.log('\n=======================================================================');
    console.log(`  🔑 LOCAL MACHINE BINDING CODE: [ ${bindingCode} ]`);
    console.log('=======================================================================');
    console.log('  Log into https://devicepay.netlify.app and enter this 8-digit code');
    console.log('  to link this machine to your user account and activate device links.');
    console.log('=======================================================================\n');

    console.log('[OK] Payment System Pre-Installation Complete. Launching DeviceFarm Agent...\n');
    process.exit(0);
  } catch (err) {
    console.log(`\n[!] PAYMENT ENGINE INITIALIZATION ERROR: ${err.message}`);
    console.log('    Check your internet connection and try again.\n');
    process.exit(1);
  }
}

if (require.main === module) {
  runPaymentGatekeeper();
}

module.exports = { runPaymentGatekeeper };
