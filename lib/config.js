/**
 * Centralized Configuration Module
 *
 * Single source of truth for all Elektrine Haraka plugin configuration.
 * Prioritizes environment variables over .ini file settings.
 */

'use strict';

// Default configuration values
const DEFAULTS = {
    // Runtime role
    role: 'inbound-mx',

    // Phoenix API endpoints
    webhook_url: 'https://elektrine.com/api/haraka/inbound',
    verify_url: 'https://elektrine.com/api/haraka/verify-recipient',
    domains_url: 'https://elektrine.com/api/haraka/domains',

    // Directional API authentication
    // phoenix_api_key: used when Haraka calls Phoenix endpoints
    // http_api_key: used to authenticate callers to Haraka /api/v1/send
    phoenix_api_key: '',
    http_api_key: '',

    // HTTP server settings
    http_port: 8080,
    http_host: '0.0.0.0',
    cors_origin: '',

    // HTTP endpoint access controls
    ops_allowed_cidrs: ['127.0.0.1/32', '::1/128'],
    metrics_allowed_cidrs: ['127.0.0.1/32', '::1/128'],
    trusted_proxy_cidrs: [
        '127.0.0.1/32',
        '::1/128',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        'fc00::/7'
    ],

    // Timeouts (milliseconds)
    webhook_timeout: 30000,
    verify_timeout: 5000,

    // Webhook retry controls
    webhook_max_retries: 5,
    webhook_retry_base_delay_ms: 1000,

    // Rate limiting
    rate_limit_window_ms: 60000,  // 1 minute
    rate_limit_max_requests: 50,  // 50 requests per window

    // Local domains (protected from spoofing, receive inbound mail)
    local_domains: ['elektrine.com', 'z.org'],

    // Domain cache behavior
    domain_cache_ttl_ms: 5 * 60 * 1000,

    // Async queue settings
    redis_url: 'redis://redis:6379',
    queue_name: 'elektrine:inbound',
    queue_dlq_name: 'elektrine:inbound:dlq',
    queue_pop_timeout_sec: 5,
    queue_max_raw_bytes: 25 * 1024 * 1024,

    // Feature flags
    webhook_enabled: true,
    include_headers: true,
    include_body: true,
    include_attachments: true
};

function to_int(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function to_bool(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function parse_string_list(value, { lowercase = false } = {}) {
    if (!value) return null;

    const normalized = Array.isArray(value)
        ? value.map((entry) => String(entry).trim()).filter(Boolean)
        : String(value).split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);

    if (normalized.length === 0) return null;
    if (!lowercase) return normalized;
    return normalized.map((entry) => entry.toLowerCase());
}

function parse_domain_list(value) {
    return parse_string_list(value, { lowercase: true });
}

function parse_cidr_list(value) {
    return parse_string_list(value, { lowercase: true });
}

function apply_env_overrides(config) {
    if (process.env.HARAKA_ROLE) config.role = process.env.HARAKA_ROLE;
    if (process.env.PHOENIX_WEBHOOK_URL) config.webhook_url = process.env.PHOENIX_WEBHOOK_URL;
    if (process.env.PHOENIX_VERIFY_URL) config.verify_url = process.env.PHOENIX_VERIFY_URL;
    if (process.env.PHOENIX_DOMAINS_URL) config.domains_url = process.env.PHOENIX_DOMAINS_URL;

    if (process.env.PHOENIX_API_KEY) config.phoenix_api_key = process.env.PHOENIX_API_KEY;
    if (process.env.HARAKA_HTTP_API_KEY) config.http_api_key = process.env.HARAKA_HTTP_API_KEY;
    if (process.env.HARAKA_API_KEY) {
        if (!process.env.PHOENIX_API_KEY) {
            config.phoenix_api_key = process.env.HARAKA_API_KEY;
        }
        if (!process.env.HARAKA_HTTP_API_KEY) {
            config.http_api_key = process.env.HARAKA_API_KEY;
        }
    }

    if (process.env.HARAKA_HTTP_PORT) config.http_port = to_int(process.env.HARAKA_HTTP_PORT, DEFAULTS.http_port);
    if (process.env.HARAKA_HTTP_HOST) config.http_host = process.env.HARAKA_HTTP_HOST;
    if (process.env.HARAKA_CORS_ORIGIN !== undefined) config.cors_origin = process.env.HARAKA_CORS_ORIGIN;
    if (process.env.LOCAL_DOMAINS) config.local_domains = parse_domain_list(process.env.LOCAL_DOMAINS) || DEFAULTS.local_domains;
    if (process.env.OPS_ALLOWED_CIDRS) {
        config.ops_allowed_cidrs = parse_cidr_list(process.env.OPS_ALLOWED_CIDRS) || DEFAULTS.ops_allowed_cidrs;
    }
    if (process.env.METRICS_ALLOWED_CIDRS) {
        config.metrics_allowed_cidrs = parse_cidr_list(process.env.METRICS_ALLOWED_CIDRS) || DEFAULTS.metrics_allowed_cidrs;
    }
    if (process.env.HARAKA_TRUSTED_PROXY_CIDRS) {
        config.trusted_proxy_cidrs = parse_cidr_list(process.env.HARAKA_TRUSTED_PROXY_CIDRS) || DEFAULTS.trusted_proxy_cidrs;
    }

    if (process.env.REDIS_URL) config.redis_url = process.env.REDIS_URL;
    if (process.env.ELEKTRINE_QUEUE_NAME) config.queue_name = process.env.ELEKTRINE_QUEUE_NAME;
    if (process.env.ELEKTRINE_DLQ_NAME) config.queue_dlq_name = process.env.ELEKTRINE_DLQ_NAME;
    if (process.env.ELEKTRINE_QUEUE_POP_TIMEOUT) {
        config.queue_pop_timeout_sec = to_int(process.env.ELEKTRINE_QUEUE_POP_TIMEOUT, DEFAULTS.queue_pop_timeout_sec);
    }
    if (process.env.ELEKTRINE_QUEUE_MAX_RAW_BYTES) {
        config.queue_max_raw_bytes = to_int(process.env.ELEKTRINE_QUEUE_MAX_RAW_BYTES, DEFAULTS.queue_max_raw_bytes);
    }

    if (process.env.WEBHOOK_MAX_RETRIES) {
        config.webhook_max_retries = to_int(process.env.WEBHOOK_MAX_RETRIES, DEFAULTS.webhook_max_retries);
    }
    if (process.env.WEBHOOK_RETRY_BASE_MS) {
        config.webhook_retry_base_delay_ms = to_int(process.env.WEBHOOK_RETRY_BASE_MS, DEFAULTS.webhook_retry_base_delay_ms);
    }
    if (process.env.DOMAIN_CACHE_TTL_MS) {
        config.domain_cache_ttl_ms = to_int(process.env.DOMAIN_CACHE_TTL_MS, DEFAULTS.domain_cache_ttl_ms);
    }
    if (process.env.HARAKA_INCLUDE_HEADERS !== undefined) {
        config.include_headers = to_bool(process.env.HARAKA_INCLUDE_HEADERS, config.include_headers);
    }
    if (process.env.HARAKA_INCLUDE_BODY !== undefined) {
        config.include_body = to_bool(process.env.HARAKA_INCLUDE_BODY, config.include_body);
    }
    if (process.env.HARAKA_INCLUDE_ATTACHMENTS !== undefined) {
        config.include_attachments = to_bool(process.env.HARAKA_INCLUDE_ATTACHMENTS, config.include_attachments);
    }
}

/**
 * Load configuration from environment variables and optional Haraka config
 * @param {Object} haraka_config - Optional Haraka plugin config object
 * @returns {Object} Merged configuration object
 */
function load(haraka_config = null) {
    const config = { ...DEFAULTS };

    // Environment variables (highest priority)
    apply_env_overrides(config);

    // Haraka .ini config overrides (if provided)
    if (haraka_config && haraka_config.main) {
        const main = haraka_config.main;

        if (main.role) config.role = main.role;
        if (main.url) config.webhook_url = main.url;
        if (main.verify_url) config.verify_url = main.verify_url;
        if (main.domains_url) config.domains_url = main.domains_url;

        if (main.phoenix_api_key) config.phoenix_api_key = main.phoenix_api_key;
        if (main.http_api_key) config.http_api_key = main.http_api_key;
        if (main.api_key) {
            if (!main.phoenix_api_key) config.phoenix_api_key = main.api_key;
            if (!main.http_api_key) config.http_api_key = main.api_key;
        }

        if (main.port) config.http_port = to_int(main.port, config.http_port);
        if (main.host) config.http_host = main.host;
        if (main.cors_origin !== undefined) config.cors_origin = main.cors_origin;
        if (main.timeout) config.webhook_timeout = to_int(main.timeout, config.webhook_timeout);
        if (main.verify_timeout) config.verify_timeout = to_int(main.verify_timeout, config.verify_timeout);

        if (main.domain_cache_ttl_ms) {
            config.domain_cache_ttl_ms = to_int(main.domain_cache_ttl_ms, config.domain_cache_ttl_ms);
        }

        // Boolean flags
        if (main.enabled !== undefined) config.webhook_enabled = main.enabled;
        if (main.include_headers !== undefined) config.include_headers = main.include_headers;
        if (main.include_body !== undefined) config.include_body = main.include_body;
        if (main.include_attachments !== undefined) config.include_attachments = main.include_attachments;
    }

    if (haraka_config && haraka_config.http_api) {
        const http_api = haraka_config.http_api;
        if (http_api.port) config.http_port = to_int(http_api.port, config.http_port);
        if (http_api.host) config.http_host = http_api.host;
        if (http_api.cors_origin !== undefined) config.cors_origin = http_api.cors_origin;
        if (http_api.ops_allowed_cidrs) {
            const parsed_ops_cidrs = parse_cidr_list(http_api.ops_allowed_cidrs);
            if (parsed_ops_cidrs && parsed_ops_cidrs.length > 0) {
                config.ops_allowed_cidrs = parsed_ops_cidrs;
            }
        }
        if (http_api.metrics_allowed_cidrs) {
            const parsed_metrics_cidrs = parse_cidr_list(http_api.metrics_allowed_cidrs);
            if (parsed_metrics_cidrs && parsed_metrics_cidrs.length > 0) {
                config.metrics_allowed_cidrs = parsed_metrics_cidrs;
            }
        }
        if (http_api.trusted_proxy_cidrs) {
            const parsed_trusted_proxy_cidrs = parse_cidr_list(http_api.trusted_proxy_cidrs);
            if (parsed_trusted_proxy_cidrs && parsed_trusted_proxy_cidrs.length > 0) {
                config.trusted_proxy_cidrs = parsed_trusted_proxy_cidrs;
            }
        }
    }

    if (haraka_config && haraka_config.ops && haraka_config.ops.allowed_cidrs) {
        const parsed_ops_cidrs = parse_cidr_list(haraka_config.ops.allowed_cidrs);
        if (parsed_ops_cidrs && parsed_ops_cidrs.length > 0) {
            config.ops_allowed_cidrs = parsed_ops_cidrs;
        }
    }

    if (haraka_config && haraka_config.metrics && haraka_config.metrics.allowed_cidrs) {
        const parsed_metrics_cidrs = parse_cidr_list(haraka_config.metrics.allowed_cidrs);
        if (parsed_metrics_cidrs && parsed_metrics_cidrs.length > 0) {
            config.metrics_allowed_cidrs = parsed_metrics_cidrs;
        }
    }

    if (haraka_config && haraka_config.rate_limit) {
        const rate_limit = haraka_config.rate_limit;
        if (rate_limit.window_ms) {
            config.rate_limit_window_ms = to_int(rate_limit.window_ms, config.rate_limit_window_ms);
        }
        if (rate_limit.max_requests) {
            config.rate_limit_max_requests = to_int(rate_limit.max_requests, config.rate_limit_max_requests);
        }
    }

    if (haraka_config && haraka_config.domains) {
        const domains = haraka_config.domains;
        if (domains.local) {
            const parsed = parse_domain_list(domains.local);
            if (parsed && parsed.length > 0) {
                config.local_domains = parsed;
            }
        }
        if (domains.cache_ttl_ms) {
            config.domain_cache_ttl_ms = to_int(domains.cache_ttl_ms, config.domain_cache_ttl_ms);
        }
    }

    if (haraka_config && haraka_config.queue) {
        const queue = haraka_config.queue;
        if (queue.redis_url) config.redis_url = queue.redis_url;
        if (queue.name) config.queue_name = queue.name;
        if (queue.dlq_name) config.queue_dlq_name = queue.dlq_name;
        if (queue.pop_timeout_sec) {
            config.queue_pop_timeout_sec = to_int(queue.pop_timeout_sec, config.queue_pop_timeout_sec);
        }
        if (queue.max_raw_bytes) {
            config.queue_max_raw_bytes = to_int(queue.max_raw_bytes, config.queue_max_raw_bytes);
        }
    }

    if (haraka_config && haraka_config.worker) {
        const worker = haraka_config.worker;
        if (worker.webhook_max_retries) {
            config.webhook_max_retries = to_int(worker.webhook_max_retries, config.webhook_max_retries);
        }
        if (worker.webhook_retry_base_delay_ms) {
            config.webhook_retry_base_delay_ms = to_int(worker.webhook_retry_base_delay_ms, config.webhook_retry_base_delay_ms);
        }
    }

    // Re-apply env values last so they always win over any .ini value.
    apply_env_overrides(config);
    config.api_key = config.phoenix_api_key;

    return config;
}

/**
 * Get a specific configuration value with fallback
 * @param {string} key - Configuration key
 * @param {*} fallback - Fallback value if key not found
 * @returns {*} Configuration value
 */
function get(key, fallback = null) {
    const loaded = load();
    return Object.prototype.hasOwnProperty.call(loaded, key) ? loaded[key] : fallback;
}

module.exports = {
    load,
    get,
    DEFAULTS
};
