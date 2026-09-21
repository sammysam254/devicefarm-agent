'use strict';

const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/**
 * Returns the absolute path to the FlexPulse wallpaper asset.
 * If the asset is missing, creates a fallback wallpaper file so that ADB push never fails.
 */
function ensureFlexPulseWallpaper() {
  const primaryPath = path.join(__dirname, '../../assets/flexpulse_wallpaper.png');
  const fallbackAssetsDir = path.join(__dirname, '../../assets');

  if (fs.existsSync(primaryPath)) {
    return primaryPath;
  }

  if (!fs.existsSync(fallbackAssetsDir)) {
    fs.mkdirSync(fallbackAssetsDir, { recursive: true });
  }

  // Check if an existing icon or template exists
  const iconPath = path.join(fallbackAssetsDir, 'icon.png');
  if (fs.existsSync(iconPath)) {
    try {
      fs.copyFileSync(iconPath, primaryPath);
      logger.info('[Wallpaper] Generated fallback wallpaper from icon.png');
      return primaryPath;
    } catch (e) {
      logger.warn(`[Wallpaper] Failed copying icon to wallpaper: ${e.message}`);
    }
  }

  // Create a minimal valid 1x1 or base PNG header if absolutely nothing exists
  // Minimal valid 1x1 sky-blue (#0284c7) PNG
  const minimalPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0x64, 0x60, 0xf8, 0x0f,
    0x00, 0x01, 0x04, 0x01, 0x02, 0x27, 0x22, 0x2e,
    0xa3, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82
  ]);

  try {
    fs.writeFileSync(primaryPath, minimalPng);
    logger.info('[Wallpaper] Generated minimal fallback PNG at ' + primaryPath);
  } catch (err) {
    logger.error(`[Wallpaper] Failed to create wallpaper: ${err.message}`);
  }

  return primaryPath;
}

module.exports = {
  ensureFlexPulseWallpaper,
};
