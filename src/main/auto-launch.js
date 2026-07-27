'use strict';

const { app } = require('electron');
const logger = require('../utils/logger');

/**
 * Enable or disable auto-launch at system login.
 * Uses Electron's built-in login item settings API.
 */

/**
 * Enable auto-launch on system startup.
 * The app will start hidden (no visible window) on login.
 */
function enable() {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      path: app.getPath('exe'),
      args: ['--hidden'],
    });
    logger.info('Auto-launch enabled');
  } catch (err) {
    logger.error('Failed to enable auto-launch', { error: err.message });
  }
}

/**
 * Disable auto-launch on system startup.
 */
function disable() {
  try {
    app.setLoginItemSettings({
      openAtLogin: false,
    });
    logger.info('Auto-launch disabled');
  } catch (err) {
    logger.error('Failed to disable auto-launch', { error: err.message });
  }
}

/**
 * Check if auto-launch is currently enabled.
 *
 * @returns {boolean}
 */
function isEnabled() {
  try {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  } catch (err) {
    logger.error('Failed to check auto-launch status', { error: err.message });
    return false;
  }
}

/**
 * Toggle auto-launch on/off.
 *
 * @returns {boolean} The new state after toggling.
 */
function toggle() {
  if (isEnabled()) {
    disable();
    return false;
  } else {
    enable();
    return true;
  }
}

/**
 * Check if the app was started with the --hidden flag
 * (i.e., auto-launched at login).
 *
 * @returns {boolean}
 */
function wasLaunchedHidden() {
  return process.argv.includes('--hidden');
}

module.exports = {
  enable,
  disable,
  isEnabled,
  toggle,
  wasLaunchedHidden,
};
