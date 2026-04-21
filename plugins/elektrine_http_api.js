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

const fs = require('fs');
const http = require('http');
const path = require('path');
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
        sent_error: 0,
        dkim_sync_ok: 0,
        dkim_sync_error: 0,
        dkim_delete_ok: 0,
        dkim_delete_error: 0
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
    const request_path = plugin.get_request_path(req);

    if (req.method === 'GET' && (request_path === '/status' || request_path === '/healthz')) {
        if (!plugin.is_ops_request_allowed(req, request_path)) {
            return plugin.send_response(res, 403, { ok: false, error: 'Forbidden' });
        }
        return plugin.send_response(res, 200, {
            ok: true,
            role: plugin.cfg.role,
            started_at: plugin.stats.started_at
        });
    }

    if (req.method === 'GET' && request_path === '/metrics') {
        if (!plugin.is_ops_request_allowed(req, request_path)) {
            return plugin.send_response(res, 403, { ok: false, error: 'Forbidden' });
        }
        return plugin.send_metrics(res);
    }

    // CORS headers - only allow same-origin requests (API is internal)
    const allowed_origin = plugin.cfg.cors_origin || null;
    if (allowed_origin) {
        res.setHeader('Access-Control-Allow-Origin', allowed_origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const route = plugin.resolve_api_route(req.method, request_path);
    if (!route) {
        plugin.logwarn(
            `Unmatched HTTP route method=${req.method || 'UNKNOWN'} url=${req.url || ''} path=${request_path}`
        );
        return plugin.send_response(res, 404, { success: false, error: 'Not found' });
    }

    if (!plugin.authenticate_api_request(req, res)) {
        return;
    }

    if (!plugin.check_rate_limit_or_reject(req, res)) {
        return;
    }

    if (route.kind === 'send') {
        return plugin.read_request_body(req, res, (body) => {
            plugin.process_send_request(body, res);
        });
    }

    if (route.kind === 'dkim_upsert') {
        return plugin.read_request_body(req, res, (body) => {
            plugin.process_dkim_upsert_request(route.domain, body, res);
        });
    }

    if (route.kind === 'dkim_get') {
        return plugin.process_dkim_get_request(route.domain, res);
    }

    if (route.kind === 'dkim_delete') {
        return plugin.process_dkim_delete_request(route.domain, res);
    }
};

exports.resolve_api_route = function(method, request_path) {
    if (method === 'POST' && request_path === '/api/v1/send') {
        return { kind: 'send' };
    }

    const dkim_domain = this.get_dkim_domain_from_path(request_path);
    if (!dkim_domain) return null;

    if (method === 'GET') {
        return { kind: 'dkim_get', domain: dkim_domain };
    }

    if (method === 'PUT') {
        return { kind: 'dkim_upsert', domain: dkim_domain };
    }

    if (method === 'DELETE') {
        return { kind: 'dkim_delete', domain: dkim_domain };
    }

    return null;
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
    const raw_target = String(req.url || '').trim();

    if (!raw_target) return '/';
    if (raw_target === '*') return '*';

    let path_target = raw_target;

    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path_target)) {
        const scheme_sep = path_target.indexOf('://');
        const authority_start = scheme_sep >= 0 ? scheme_sep + 3 : 0;
        const first_slash = path_target.indexOf('/', authority_start);
        path_target = first_slash >= 0 ? path_target.slice(first_slash) : '/';
    } else if (!path_target.startsWith('/')) {
        // Some lightweight clients send a non-standard request target like
        // `127.0.0.1:8080/status`; normalize that into a path instead of
        // falling back to `/` and returning a misleading 404.
        const first_slash = path_target.indexOf('/');
        path_target = first_slash >= 0 ? path_target.slice(first_slash) : `/${path_target}`;
    }

    const query_index = path_target.indexOf('?');
    const hash_index = path_target.indexOf('#');
    let cut_index = -1;

    if (query_index >= 0 && hash_index >= 0) {
        cut_index = Math.min(query_index, hash_index);
    } else if (query_index >= 0) {
        cut_index = query_index;
    } else if (hash_index >= 0) {
        cut_index = hash_index;
    }

    if (cut_index >= 0) {
        path_target = path_target.slice(0, cut_index);
    }

    if (!path_target) return '/';
    return path_target.startsWith('/') ? path_target : `/${path_target}`;
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

exports.authenticate_api_request = function(req, res) {
    const plugin = this;
    const api_key = plugin.get_header_value(req, 'x-api-key');
    const expected_key = plugin.cfg.http_api_key || '';

    if (!plugin.constant_time_equal(api_key, expected_key)) {
        plugin.stats.auth_failures += 1;
        plugin.send_response(res, 401, { success: false, error: 'Unauthorized' });
        return false;
    }

    return true;
};

exports.check_rate_limit_or_reject = function(req, res) {
    const plugin = this;
    const client_ip = plugin.get_client_ip(req);

    if (!plugin.check_rate_limit(client_ip)) {
        plugin.stats.rate_limited += 1;
        plugin.send_response(res, 429, { success: false, error: 'Rate limit exceeded' });
        return false;
    }

    return true;
};

exports.read_request_body = function(req, res, callback) {
    const plugin = this;
    let body = '';
    let body_size = 0;
    let finished = false;

    const finish_once = (handler) => {
        if (finished) return;
        finished = true;
        clearTimeout(body_timeout);
        handler();
    };

    const body_timeout = setTimeout(() => {
        req.destroy();
        finish_once(() => {
            plugin.send_response(res, 408, { success: false, error: 'Request timeout' });
        });
    }, BODY_READ_TIMEOUT_MS);

    req.on('data', (chunk) => {
        if (finished) return;

        body_size += chunk.length;
        if (body_size > MAX_BODY_SIZE) {
            req.destroy();
            return finish_once(() => {
                plugin.send_response(res, 413, { success: false, error: 'Request body too large' });
            });
        }

        body += chunk;
    });

    req.on('end', () => {
        finish_once(() => callback(body));
    });

    req.on('error', () => {
        finish_once(() => {});
    });
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
    if (plugin.is_internal_api_request_authenticated(req)) {
        return true;
    }

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

exports.is_internal_api_request_authenticated = function(req) {
    const api_key = this.get_header_value(req, 'x-api-key');
    const expected_key = this.cfg.http_api_key || '';
    return this.constant_time_equal(api_key, expected_key);
};

exports.get_dkim_domain_from_path = function(request_path) {
    const match = request_path.match(/^\/api\/v1\/dkim\/domains\/([^/]+)$/);
    if (!match) return null;

    try {
        const decoded = decodeURIComponent(match[1]);
        return this.normalize_dkim_domain(decoded);
    } catch (err) {
        return null;
    }
};

exports.normalize_dkim_domain = function(value) {
    const domain = String(value || '').trim().toLowerCase().replace(/\.+$/, '');
    if (!domain) return null;

    const labels = domain.split('.');
    if (labels.length < 2) return null;

    for (const label of labels) {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
            return null;
        }
    }

    return domain;
};

exports.normalize_dkim_selector = function(value) {
    const selector = String(value || '').trim();
    if (!selector) return null;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(selector)) {
        return null;
    }
    return selector;
};

exports.normalize_private_key = function(value) {
    if (typeof value !== 'string') return null;

    const private_key = value.replace(/\r\n/g, '\n').trim();
    if (!private_key.includes('-----BEGIN') || !private_key.includes('PRIVATE KEY-----')) {
        return null;
    }
    if (private_key.includes('\u0000')) {
        return null;
    }

    return `${private_key}\n`;
};

exports.get_dkim_storage_dir = function() {
    const configured = String(this.cfg.dkim_storage_dir || '').trim();
    if (configured) return configured;

    const runtime_dir = '/tmp/haraka-config/config/dkim';
    if (fs.existsSync(runtime_dir)) {
        return runtime_dir;
    }

    return path.resolve(process.cwd(), 'config', 'dkim');
};

exports.process_dkim_upsert_request = function(domain, body, res) {
    const plugin = this;
    let payload;

    try {
        payload = JSON.parse(body || '{}');
    } catch (err) {
        plugin.stats.dkim_sync_error += 1;
        return plugin.send_response(res, 400, { success: false, error: 'Invalid JSON' });
    }

    const selector = plugin.normalize_dkim_selector(payload.selector);
    const private_key = plugin.normalize_private_key(payload.private_key);

    if (!selector || !private_key) {
        plugin.stats.dkim_sync_error += 1;
        return plugin.send_response(res, 400, {
            success: false,
            error: 'selector and private_key are required'
        });
    }

    try {
        plugin.upsert_dkim_domain(domain, selector, private_key);
        plugin.stats.dkim_sync_ok += 1;
        plugin.loginfo(`Installed DKIM key for ${domain} with selector ${selector}`);
        return plugin.send_response(res, 200, {
            success: true,
            domain,
            selector
        });
    } catch (err) {
        plugin.stats.dkim_sync_error += 1;
        plugin.logerror(`Failed to install DKIM key for ${domain}: ${err.message}`);
        return plugin.send_response(res, 500, {
            success: false,
            error: `Failed to install DKIM key: ${err.message}`
        });
    }
};

exports.process_dkim_delete_request = function(domain, res) {
    const plugin = this;

    try {
        const deleted = plugin.delete_dkim_domain(domain);
        plugin.stats.dkim_delete_ok += 1;
        plugin.loginfo(`${deleted ? 'Removed' : 'DKIM key not present for'} ${domain}`);
        return plugin.send_response(res, 200, {
            success: true,
            domain,
            deleted
        });
    } catch (err) {
        plugin.stats.dkim_delete_error += 1;
        plugin.logerror(`Failed to remove DKIM key for ${domain}: ${err.message}`);
        return plugin.send_response(res, 500, {
            success: false,
            error: `Failed to remove DKIM key: ${err.message}`
        });
    }
};

exports.process_dkim_get_request = function(domain, res) {
    const plugin = this;

    try {
        const dkim_domain = plugin.read_dkim_domain(domain);
        return plugin.send_response(res, 200, {
            success: true,
            domain,
            selector: dkim_domain.selector,
            public_key: dkim_domain.public_key_pem,
            value: dkim_domain.value,
            private_key_present: true
        });
    } catch (err) {
        const not_found = err && err.code === 'ENOENT';
        return plugin.send_response(res, not_found ? 404 : 500, {
            success: false,
            error: not_found ? `DKIM key not found for ${domain}` : `Failed to read DKIM key: ${err.message}`
        });
    }
};

exports.upsert_dkim_domain = function(domain, selector, private_key) {
    const storage_dir = this.get_dkim_storage_dir();
    const domain_dir = path.join(storage_dir, domain);
    const private_path = path.join(domain_dir, 'private');
    const selector_path = path.join(domain_dir, 'selector');

    fs.mkdirSync(domain_dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(domain_dir, 0o755);

    this.atomic_write_file(private_path, private_key, 0o600);
    this.atomic_write_file(selector_path, `${selector}\n`, 0o644);
};

exports.delete_dkim_domain = function(domain) {
    const domain_dir = path.join(this.get_dkim_storage_dir(), domain);
    if (!fs.existsSync(domain_dir)) {
        return false;
    }

    fs.rmSync(domain_dir, { recursive: true, force: true });
    return true;
};

exports.read_dkim_domain = function(domain) {
    const domain_dir = path.join(this.get_dkim_storage_dir(), domain);
    const private_path = path.join(domain_dir, 'private');
    const selector_path = path.join(domain_dir, 'selector');

    const private_key = fs.readFileSync(private_path, 'utf8');
    const selector = String(fs.readFileSync(selector_path, 'utf8') || '').trim();
    const public_key = this.derive_public_key_from_private(private_key);

    return {
        selector,
        private_key,
        public_key_pem: public_key.pem,
        public_key_dns: public_key.dns,
        value: `v=DKIM1; k=rsa; p=${public_key.dns}`
    };
};

exports.derive_public_key_from_private = function(private_key) {
    const private_object = crypto.createPrivateKey({ key: private_key, format: 'pem' });
    const public_object = crypto.createPublicKey(private_object);

    const pem = public_object.export({ type: 'spki', format: 'pem' }).toString();
    const dns = public_object.export({ type: 'spki', format: 'der' }).toString('base64');

    return { pem, dns };
};

exports.atomic_write_file = function(target_path, contents, mode) {
    const directory = path.dirname(target_path);
    const temp_path = path.join(
        directory,
        `.${path.basename(target_path)}.${process.pid}.${Date.now()}.tmp`
    );

    fs.writeFileSync(temp_path, contents, { mode });
    fs.renameSync(temp_path, target_path);
    fs.chmodSync(target_path, mode);
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
        '# HELP elektrine_http_api_dkim_sync_ok_total Successful DKIM sync requests',
        '# TYPE elektrine_http_api_dkim_sync_ok_total counter',
        `elektrine_http_api_dkim_sync_ok_total ${plugin.stats.dkim_sync_ok}`,
        '# HELP elektrine_http_api_dkim_sync_error_total Failed DKIM sync requests',
        '# TYPE elektrine_http_api_dkim_sync_error_total counter',
        `elektrine_http_api_dkim_sync_error_total ${plugin.stats.dkim_sync_error}`,
        '# HELP elektrine_http_api_dkim_delete_ok_total Successful DKIM delete requests',
        '# TYPE elektrine_http_api_dkim_delete_ok_total counter',
        `elektrine_http_api_dkim_delete_ok_total ${plugin.stats.dkim_delete_ok}`,
        '# HELP elektrine_http_api_dkim_delete_error_total Failed DKIM delete requests',
        '# TYPE elektrine_http_api_dkim_delete_error_total counter',
        `elektrine_http_api_dkim_delete_error_total ${plugin.stats.dkim_delete_error}`,
        '# HELP elektrine_http_api_uptime_seconds Process uptime in seconds',
        '# TYPE elektrine_http_api_uptime_seconds gauge',
        `elektrine_http_api_uptime_seconds ${uptime_seconds}`
    ];

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(`${lines.join('\n')}\n`);
};
