/**
 * Utility functions for API responses and CORS handling
 */

/**
 * Set CORS headers on response
 * @param {Response} res - The response object
 */
export function setCors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Send JSON response with status code
 * @param {Response} res - The response object
 * @param {number} status - HTTP status code
 * @param {object} data - Response data
 */
export function respond(res, status, data) {
  res.status(status).json(data);
}