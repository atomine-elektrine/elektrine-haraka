/**
 * Elektrine HTTP API Plugin
 * 
 * Provides a REST API endpoint for sending emails via Haraka.
 * Supports structured email data and raw MIME format.
 * 
 * Endpoint: POST /api/v1/send
 * Authentication: X-API-Key header
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const constants = require('haraka-constants');

// Shared library modules
const { config, domains, email: emailBuilder } = require('../lib');

// Maximum request body size (50MB - handles large attachments)
const MAX_BODY_SIZE = 50 * 1024 * 1024;

// Request body read timeout (30 seconds)
const BODY_READ_TIMEOUT_MS = 30000;

exports.register = function() {
    const plugin = this;

    // Load configuration
    plugin.load_config();
    plugin.stats = {
        started_at: new Date().toISOString(),
        requests_total: 0,
        auth_failures: 0,
        rate_limited: 0,
        sent_ok: 0,
        sent_error: 0
    };

    // Validate critical config at startup
    if (!plugin.cfg.http_api_key || plugin.cfg.http_api_key === 'elektrine_webhook_key_default') {
        plugin.logerror('CRITICAL: HTTP API key is not configured. Set HARAKA_HTTP_API_KEY environment variable.');
    }

    // Initialize rate limiting storage
    plugin.rate_limit_storage = new Map();
    plugin.allowlists = {
        trusted_proxies: null,
        ops: null,
        metrics: null
    };
    plugin.rebuild_allowlists();

    // Start HTTP server
    plugin.start_server();
};

exports.load_config = function() {
    const plugin = this;

    const haraka_cfg = plugin.config.get('elektrine.ini', {
        booleans: [
            '+main.enabled',
            '+main.include_headers',
            '+main.include_body',
            '+main.include_attachments'
        ]
    }, function() {
        plugin.load_config();
    });

    plugin.cfg = config.load(haraka_cfg);
    plugin.rebuild_allowlists();
};

exports.start_server = function() {
    const plugin = this;
    
    const server = http.createServer((req, res) => {
        plugin.handle_request(req, res);
    });
    
    const port = plugin.cfg.http_port;
    const host = plugin.cfg.http_host;
    
    server.listen(port, host, () => {
        plugin.loginfo(`HTTP API listening on ${host}:${port}`);
    });
};

exports.handle_request = function(req, res) {
    const plugin = this;
    plugin.stats.requests_total += 1;
    const path = plugin.get_request_path(req);

    if (req.method === 'GET' && (path === '/status' || path === '/healthz')) {
        if (!plugin.is_ops_request_allowed(req, path)) {
            return plugin.send_response(res, 403, { ok: false, error: 'Forbidden' });
        }
        return plugin.send_response(res, 200, {
            ok: true,
            role: plugin.cfg.role,
            started_at: plugin.stats.started_at
        });
    }

    if (req.method === 'GET' && path === '/metrics') {
        if (!plugin.is_ops_request_allowed(req, path)) {
            return plugin.send_response(res, 403, { ok: false, error: 'Forbidden' });
        }
        return plugin.send_metrics(res);
    }

    // CORS headers - only allow same-origin requests (API is internal)
    const allowed_origin = plugin.cfg.cors_origin || null;
    if (allowed_origin) {
        res.setHeader('Access-Control-Allow-Origin', allowed_origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Route check
    if (req.method !== 'POST' || path !== '/api/v1/send') {
        return plugin.send_response(res, 404, { success: false, error: 'Not found' });
    }

    // API key authentication (constant-time comparison to prevent timing attacks)
    const api_key = plugin.get_header_value(req, 'x-api-key');
    const expected_key = plugin.cfg.http_api_key || '';
    if (!plugin.constant_time_equal(api_key, expected_key)) {
        plugin.stats.auth_failures += 1;
        return plugin.send_response(res, 401, { success: false, error: 'Unauthorized' });
    }

    // Rate limiting
    const client_ip = plugin.get_client_ip(req);

    if (!plugin.check_rate_limit(client_ip)) {
        plugin.stats.rate_limited += 1;
        return plugin.send_response(res, 429, { success: false, error: 'Rate limit exceeded' });
    }

    // Parse request body with size limit and timeout
    let body = '';
    let body_size = 0;
    let timed_out = false;

    const body_timeout = setTimeout(() => {
        timed_out = true;
        req.destroy();
        plugin.send_response(res, 408, { success: false, error: 'Request timeout' });
    }, BODY_READ_TIMEOUT_MS);

    req.on('data', chunk => {
        body_size += chunk.length;
        if (body_size > MAX_BODY_SIZE) {
            clearTimeout(body_timeout);
            req.destroy();
            return plugin.send_response(res, 413, { success: false, error: 'Request body too large' });
        }
        body += chunk;
    });

    req.on('end', () => {
        clearTimeout(body_timeout);
        if (!timed_out) {
            plugin.process_send_request(body, res);
        }
    });

    req.on('error', () => {
        clearTimeout(body_timeout);
    });
};

exports.rebuild_allowlists = function() {
    const plugin = this;
    plugin.allowlists = {
        trusted_proxies: plugin.build_cidr_allowlist(plugin.cfg.trusted_proxy_cidrs || []),
        ops: plugin.build_cidr_allowlist(plugin.cfg.ops_allowed_cidrs || []),
        metrics: plugin.build_cidr_allowlist(plugin.cfg.metrics_allowed_cidrs || [])
    };
};

exports.build_cidr_allowlist = function(cidr_values) {
    const plugin = this;
    const allowlist = new net.BlockList();

    for (const raw_value of cidr_values) {
        if (!raw_value) continue;
        const value = String(raw_value).trim();
        if (!value) continue;

        try {
            if (value.includes('/')) {
                const [raw_ip, raw_prefix] = value.split('/');
                const ip = plugin.parse_ip(raw_ip);
                const family = net.isIP(ip);
                const prefix = Number.parseInt(raw_prefix, 10);

                if (!family || !Number.isInteger(prefix)) {
                    plugin.logwarn(`Skipping invalid CIDR allowlist entry: ${value}`);
                    continue;
                }

                if ((family === 4 && (prefix < 0 || prefix > 32)) ||
                    (family === 6 && (prefix < 0 || prefix > 128))) {
                    plugin.logwarn(`Skipping CIDR allowlist entry with invalid prefix: ${value}`);
                    continue;
                }

                allowlist.addSubnet(ip, prefix, family === 4 ? 'ipv4' : 'ipv6');
                continue;
            }

            const ip = plugin.parse_ip(value);
            const family = net.isIP(ip);
            if (!family) {
                plugin.logwarn(`Skipping invalid allowlist IP entry: ${value}`);
                continue;
            }

            allowlist.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
        } catch (err) {
            plugin.logwarn(`Skipping malformed allowlist entry (${value}): ${err.message}`);
        }
    }

    return allowlist;
};

exports.get_request_path = function(req) {
    try {
        return new URL(req.url || '/', 'http://localhost').pathname;
    } catch (err) {
        return '/';
    }
};

exports.get_header_value = function(req, key) {
    const value = req.headers[key];
    if (Array.isArray(value)) return value[0] || '';
    return value || '';
};

exports.constant_time_equal = function(received, expected) {
    if (!received || !expected) return false;
    const received_buffer = Buffer.from(String(received));
    const expected_buffer = Buffer.from(String(expected));
    if (received_buffer.length !== expected_buffer.length) return false;
    return crypto.timingSafeEqual(received_buffer, expected_buffer);
};

exports.parse_ip = function(value) {
    if (!value) return '';

    let candidate = String(value).trim();
    if (!candidate) return '';

    if (candidate.startsWith('"') && candidate.endsWith('"') && candidate.length > 1) {
        candidate = candidate.slice(1, -1).trim();
    }

    if (candidate.startsWith('for=')) {
        candidate = candidate.slice(4).trim();
    }

    if (candidate.startsWith('[')) {
        const closing_index = candidate.indexOf(']');
        if (closing_index > 0) {
            candidate = candidate.slice(1, closing_index);
        }
    } else {
        const ipv4_port_match = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
        if (ipv4_port_match) {
            candidate = ipv4_port_match[1];
        }
    }

    if (candidate.startsWith('::ffff:')) {
        candidate = candidate.slice('::ffff:'.length);
    }

    return net.isIP(candidate) ? candidate : '';
};

exports.is_ip_allowlisted = function(ip, allowlist) {
    if (!allowlist) return false;
    const parsed_ip = this.parse_ip(ip);
    const family = net.isIP(parsed_ip);
    if (!family) return false;
    return allowlist.check(parsed_ip, family === 4 ? 'ipv4' : 'ipv6');
};

exports.get_forwarded_for_chain = function(req) {
    const forwarded_header = this.get_header_value(req, 'x-forwarded-for');
    if (!forwarded_header) return [];

    return forwarded_header
        .split(',')
        .map((entry) => this.parse_ip(entry))
        .filter(Boolean);
};

exports.get_client_ip = function(req) {
    const plugin = this;
    const remote_ip = plugin.parse_ip(req.socket && req.socket.remoteAddress);
    const trusted_proxies = plugin.allowlists && plugin.allowlists.trusted_proxies;

    if (!plugin.is_ip_allowlisted(remote_ip, trusted_proxies)) {
        return remote_ip || '0.0.0.0';
    }

    const forwarded_chain = plugin.get_forwarded_for_chain(req);
    if (forwarded_chain.length > 0) {
        // Walk right-to-left to find the first untrusted hop.
        for (let i = forwarded_chain.length - 1; i >= 0; i -= 1) {
            const hop_ip = forwarded_chain[i];
            if (!plugin.is_ip_allowlisted(hop_ip, trusted_proxies)) {
                return hop_ip;
            }
        }

        // If every forwarded hop is trusted, use the left-most original value.
        return forwarded_chain[0];
    }

    const real_ip = plugin.parse_ip(plugin.get_header_value(req, 'x-real-ip'));
    if (real_ip && !plugin.is_ip_allowlisted(real_ip, trusted_proxies)) {
        return real_ip;
    }

    return remote_ip || real_ip || '0.0.0.0';
};

exports.is_ops_request_allowed = function(req, path) {
    const plugin = this;
    const client_ip = plugin.get_client_ip(req);
    const allowlist = path === '/metrics'
        ? plugin.allowlists.metrics
        : plugin.allowlists.ops;

    const allowed = plugin.is_ip_allowlisted(client_ip, allowlist);
    if (!allowed) {
        plugin.logwarn(`Denied ${path} request from ${client_ip || 'unknown'}`);
    }
    return allowed;
};

exports.process_send_request = function(body, res) {
    const plugin = this;
    
    try {
        const email_data = JSON.parse(body);
        
        // Validate required fields
        if (!email_data.from || !email_data.to) {
            return plugin.send_response(res, 400, { 
                success: false, 
                error: 'Missing required fields: from and to' 
            });
        }
        
        // Subject required for non-raw emails
        if (!email_data.raw && !email_data.raw_base64 && email_data.subject === undefined) {
            return plugin.send_response(res, 400, { 
                success: false, 
                error: 'Missing required field: subject (required for non-raw emails)' 
            });
        }
        
        // Queue email for delivery
        plugin.queue_email(email_data, (err, message_id) => {
            if (err) {
                plugin.stats.sent_error += 1;
                plugin.send_response(res, 400, { success: false, error: err.message });
            } else {
                plugin.stats.sent_ok += 1;
                plugin.send_response(res, 200, { success: true, message_id: message_id });
            }
        });
        
    } catch (e) {
        plugin.send_response(res, 400, { success: false, error: 'Invalid JSON' });
    }
};

exports.queue_email = function(email_data, callback) {
    const plugin = this;
    
    try {
        const message_id = crypto.randomUUID();
        const all_recipients = emailBuilder.collect_recipients(email_data);
        if (all_recipients.length === 0) {
            throw new Error('Invalid recipient list');
        }
        
        let email_content;
        let sender_email;
        
        // Handle raw email formats
        if (email_data.raw_base64) {
            plugin.loginfo('Using base64-encoded raw email format');
            email_content = Buffer.from(email_data.raw_base64, 'base64').toString('binary');
            sender_email = domains.extract_email(String(email_data.from || '').replace(/[\r\n]+/g, ' ').trim());
        } else if (email_data.raw) {
            plugin.loginfo('Using raw email format');
            email_content = email_data.raw;
            sender_email = domains.extract_email(String(email_data.from || '').replace(/[\r\n]+/g, ' ').trim());
        } else {
            // Build email from structured data
            const built = emailBuilder.build(email_data, message_id);
            email_content = built.email_content;
            sender_email = built.sender_email;
        }

        if (!/^[^\s@<>]+@[A-Za-z0-9.-]+$/.test(sender_email)) {
            throw new Error('Invalid from address');
        }
        
        // Always deliver through Haraka outbound.
        // Local domains are steered back to inbound-mx by elektrine_local_mx.
        if (domains.all_recipients_local(all_recipients)) {
            plugin.loginfo(`All recipients are local; routing via SMTP/local MX for message: ${message_id}`);
        }
        plugin.deliver_outbound(sender_email, all_recipients, email_content, message_id, callback);
        
    } catch (err) {
        plugin.logerror(`Error building email: ${err.message}`);
        callback(err);
    }
};

exports.deliver_outbound = function(sender_email, recipients, email_content, message_id, callback) {
    const plugin = this;
    const outbound = require('./outbound');
    
    plugin.loginfo(`Processing outbound delivery for: ${recipients.join(', ')}`);
    
    outbound.send_email(sender_email, recipients, email_content, (code, msg) => {
        if (code === constants.cont || (msg && msg.includes('Message Queued'))) {
            plugin.loginfo(`Email queued successfully: ${message_id}`);
            callback(null, message_id);
        } else {
            plugin.logerror(`Email queueing failed: ${msg}`);
            callback(new Error(msg || 'Failed to queue email'));
        }
    });
};

exports.check_rate_limit = function(ip) {
    const plugin = this;
    const now = Date.now();
    const window_ms = plugin.cfg.rate_limit_window_ms;
    const max_requests = plugin.cfg.rate_limit_max_requests;
    
    // Clean expired entries
    for (const [stored_ip, timestamps] of plugin.rate_limit_storage.entries()) {
        const valid = timestamps.filter(time => now - time < window_ms);
        if (valid.length === 0) {
            plugin.rate_limit_storage.delete(stored_ip);
        } else {
            plugin.rate_limit_storage.set(stored_ip, valid);
        }
    }
    
    // Check current IP
    const timestamps = plugin.rate_limit_storage.get(ip) || [];
    const valid_timestamps = timestamps.filter(time => now - time < window_ms);
    
    if (valid_timestamps.length >= max_requests) {
        plugin.logwarn(`Rate limit exceeded for IP: ${ip}`);
        return false;
    }
    
    // Record this request
    valid_timestamps.push(now);
    plugin.rate_limit_storage.set(ip, valid_timestamps);
    
    return true;
};

exports.send_response = function(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
};

exports.send_metrics = function(res) {
    const plugin = this;
    const uptime_seconds = Math.floor((Date.now() - Date.parse(plugin.stats.started_at)) / 1000);

    const lines = [
        '# HELP elektrine_http_api_requests_total Total HTTP requests handled',
        '# TYPE elektrine_http_api_requests_total counter',
        `elektrine_http_api_requests_total ${plugin.stats.requests_total}`,
        '# HELP elektrine_http_api_auth_failures_total Authentication failures',
        '# TYPE elektrine_http_api_auth_failures_total counter',
        `elektrine_http_api_auth_failures_total ${plugin.stats.auth_failures}`,
        '# HELP elektrine_http_api_rate_limited_total Requests rejected by rate limit',
        '# TYPE elektrine_http_api_rate_limited_total counter',
        `elektrine_http_api_rate_limited_total ${plugin.stats.rate_limited}`,
        '# HELP elektrine_http_api_sent_ok_total Successful send requests',
        '# TYPE elektrine_http_api_sent_ok_total counter',
        `elektrine_http_api_sent_ok_total ${plugin.stats.sent_ok}`,
        '# HELP elektrine_http_api_sent_error_total Failed send requests',
        '# TYPE elektrine_http_api_sent_error_total counter',
        `elektrine_http_api_sent_error_total ${plugin.stats.sent_error}`,
        '# HELP elektrine_http_api_uptime_seconds Process uptime in seconds',
        '# TYPE elektrine_http_api_uptime_seconds gauge',
        `elektrine_http_api_uptime_seconds ${uptime_seconds}`
    ];

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(`${lines.join('\n')}\n`);
};
