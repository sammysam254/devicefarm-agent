'use strict';

const net = require('net');

/**
 * Set of ports currently allocated by this agent instance.
 * Prevents double-allocation when multiple devices connect simultaneously.
 */
const allocatedPorts = new Set();

/**
 * Probe whether a single TCP port is available on 127.0.0.1.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find and reserve an available TCP port within [start, end].
 * The port is added to the internal `allocatedPorts` set so that
 * concurrent calls never return the same port.
 *
 * @param {number} start  Lower bound of the port range (inclusive).
 * @param {number} end    Upper bound of the port range (inclusive).
 * @returns {Promise<number>} A free port number.
 * @throws {Error} If no free port is found in the specified range.
 */
async function getFreePort(start, end) {
  for (let port = start; port <= end; port++) {
    if (allocatedPorts.has(port)) {
      continue;
    }
    const free = await isPortFree(port);
    if (free) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error(`No free port available in range ${start}-${end}`);
}

/**
 * Release a previously allocated port back to the available pool.
 * @param {number} port
 */
function releasePort(port) {
  allocatedPorts.delete(port);
}

/**
 * Return a snapshot of all currently allocated ports.
 * @returns {number[]}
 */
function getAllocatedPorts() {
  return Array.from(allocatedPorts);
}

module.exports = {
  getFreePort,
  releasePort,
  getAllocatedPorts,
};
