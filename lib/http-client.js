/**
 * Shared HTTP Client Module
 * 
 * Provides a unified HTTP/HTTPS request helper used by all Elektrine plugins.
 * Handles timeouts, error handling, and JSON parsing consistently.
 */

'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

/**
 * Make an HTTP/HTTPS request
 * @param {Object} options - Request options
 * @param {string} options.url - Full URL to request
 * @param {string} [options.method='POST'] - HTTP method
 * @param {Object} [options.data] - Data to send (will be JSON stringified)
 * @param {Object} [options.headers] - Additional headers
 * @param {number} [options.timeout=30000] - Request timeout in milliseconds
 * @param {string} [options.api_key] - API key to include in X-API-Key header
 * @param {Function} [options.logger] - Logger function for debug output
 * @returns {Promise<Object>} Response object with status, data, and headers
 */
// Connection pooling agents for keep-alive
const http_agent = new http.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 30000 });
const https_agent = new https.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 30000 });

function request(options) {
    return new Promise((resolve, reject) => {
        const {
            url: request_url,
            method = 'POST',
            data = null,
            headers = {},
            timeout = 30000,
            api_key = null,
            logger = null
        } = options;

        const parsed_url = url.parse(request_url);

        // Validate URL scheme to prevent SSRF via non-HTTP protocols
        if (parsed_url.protocol !== 'http:' && parsed_url.protocol !== 'https:') {
            return reject(new Error(`Invalid URL scheme: ${parsed_url.protocol} (only http/https allowed)`));
        }

        const payload = data ? JSON.stringify(data) : null;
        
        const request_options = {
            hostname: parsed_url.hostname,
            port: parsed_url.port || (parsed_url.protocol === 'https:' ? 443 : 80),
            path: parsed_url.path || '/',
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'elektrine-haraka/1.0',
                ...headers
            },
            timeout: timeout
        };

        // Add content length for POST/PUT requests
        if (payload) {
            request_options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        // Add API key if provided
        if (api_key) {
            request_options.headers['X-API-Key'] = api_key;
        }

        // Use pooled agents for connection reuse
        const is_https = parsed_url.protocol === 'https:';
        const protocol = is_https ? https : http;
        request_options.agent = is_https ? https_agent : http_agent;

        const req = protocol.request(request_options, (res) => {
            let response_data = '';

            res.on('data', (chunk) => {
                response_data += chunk;
            });

            res.on('end', () => {
                const result = {
                    status: res.statusCode,
                    headers: res.headers,
                    raw: response_data,
                    data: null
                };

                // Try to parse JSON response
                if (response_data) {
                    try {
                        result.data = JSON.parse(response_data);
                    } catch (e) {
                        result.data = response_data;
                    }
                }

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(result);
                } else {
                    const error = new Error(`HTTP ${res.statusCode}: ${response_data}`);
                    error.status = res.statusCode;
                    error.response = result;
                    reject(error);
                }
            });
        });

        req.on('error', (err) => {
            if (logger) logger(`HTTP request error: ${err.message}`);
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            const error = new Error('Request timed out');
            error.code = 'ETIMEDOUT';
            reject(error);
        });

        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

/**
 * Send a webhook to the Phoenix app
 * @param {string} webhook_url - Webhook URL
 * @param {Object} data - Data to send
 * @param {Object} options - Additional options
 * @param {string} [options.api_key] - API key
 * @param {number} [options.timeout=30000] - Timeout in milliseconds
 * @param {Function} [options.logger] - Logger function
 * @returns {Promise<Object>} Response data
 */
async function send_webhook(webhook_url, data, options = {}) {
    const result = await request({
        url: webhook_url,
        method: 'POST',
        data: data,
        headers: options.headers || {},
        api_key: options.api_key,
        timeout: options.timeout || 30000,
        logger: options.logger
    });
    
    return result.data;
}

/**
 * Verify a recipient with the Phoenix app
 * @param {string} verify_url - Verification URL
 * @param {string} email - Email address to verify
 * @param {Object} options - Additional options
 * @param {string} [options.api_key] - API key
 * @param {number} [options.timeout=5000] - Timeout in milliseconds
 * @param {Function} [options.logger] - Logger function
 * @returns {Promise<boolean>} True if recipient exists
 */
async function verify_recipient(verify_url, email, options = {}) {
    try {
        const result = await request({
            url: verify_url,
            method: 'POST',
            data: { email: email },
            api_key: options.api_key,
            timeout: options.timeout || 5000,
            logger: options.logger
        });
        
        return result.data && result.data.exists === true;
    } catch (err) {
        // 404 means recipient does not exist
        if (err.status === 404) {
            return false;
        }
        throw err;
    }
}

/**
 * Fetch list of valid domains from the Phoenix app
 * This includes built-in domains (elektrine.com, z.org) plus any custom domains
 * that have email enabled.
 * @param {string} domains_url - Domains API URL
 * @param {Object} options - Additional options
 * @param {string} [options.api_key] - API key
 * @param {number} [options.timeout=10000] - Timeout in milliseconds
 * @param {Function} [options.logger] - Logger function
 * @returns {Promise<string[]>} Array of domain names
 */
async function fetch_domains(domains_url, options = {}) {
    try {
        const result = await request({
            url: domains_url,
            method: 'GET',
            api_key: options.api_key,
            timeout: options.timeout || 10000,
            logger: options.logger
        });
        
        if (result.data && Array.isArray(result.data.domains)) {
            return result.data.domains;
        }
        
        if (options.logger) {
            options.logger('Unexpected domains response format, using empty list');
        }
        return [];
    } catch (err) {
        if (options.logger) {
            options.logger(`Failed to fetch domains: ${err.message}`);
        }
        throw err;
    }
}

module.exports = {
    request,
    send_webhook,
    verify_recipient,
    fetch_domains
};
