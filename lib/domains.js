/**
 * Domain Utilities Module
 * 
 * Single source of truth for local/protected domain management.
 * Provides helper functions for domain-related operations.
 * 
 * Supports dynamic domain loading from Phoenix API for custom domains.
 */

'use strict';

const config = require('./config');
const http_client = require('./http-client');

// Cache for domains fetched from Phoenix
let cached_domains = null;
let cache_timestamp = 0;
let refresh_interval = null;

// Flag to track if we're currently refreshing
let refresh_in_progress = false;

/**
 * Get the list of local domains from configuration
 * These are domains that receive inbound mail and are protected from spoofing.
 * @returns {string[]} Array of local domain names
 */
function get_local_domains() {
    const cfg = config.load();
    const cache_ttl_ms = cfg.domain_cache_ttl_ms || config.DEFAULTS.domain_cache_ttl_ms;
    
    // If we have cached domains from Phoenix, use them
    if (cached_domains && (Date.now() - cache_timestamp < cache_ttl_ms)) {
        return cached_domains;
    }
    
    // Return config domains while we refresh in background
    return cfg.local_domains || ['elektrine.com', 'z.org'];
}

/**
 * Refresh the domain cache from Phoenix API
 * This is called periodically and on startup
 * @param {Function} [logger] - Optional logger function
 * @returns {Promise<string[]>} Array of domain names
 */
async function refresh_domains(logger = null) {
    if (refresh_in_progress) {
        if (logger) logger('Domain refresh already in progress, skipping');
        return cached_domains || get_local_domains();
    }
    
    refresh_in_progress = true;
    const cfg = config.load();
    
    try {
        if (logger) logger(`Fetching domains from ${cfg.domains_url}`);
        
        const domains = await http_client.fetch_domains(cfg.domains_url, {
            api_key: cfg.phoenix_api_key,
            timeout: 10000,
            logger: logger
        });
        
        if (domains && domains.length > 0) {
            cached_domains = domains.map(d => d.toLowerCase());
            cache_timestamp = Date.now();
            
            if (logger) {
                logger(`Domain cache updated with ${domains.length} domains: ${domains.join(', ')}`);
            }
            
            return cached_domains;
        } else {
            if (logger) logger('No domains returned from Phoenix, keeping existing cache');
            return cached_domains || cfg.local_domains || ['elektrine.com', 'z.org'];
        }
    } catch (err) {
        if (logger) {
            logger(`Failed to refresh domains from Phoenix: ${err.message}`);
        }
        // On error, keep using cached domains or fall back to config
        return cached_domains || cfg.local_domains || ['elektrine.com', 'z.org'];
    } finally {
        refresh_in_progress = false;
    }
}

/**
 * Initialize the domain cache
 * Call this on Haraka startup to pre-populate the cache
 * @param {Function} [logger] - Optional logger function
 * @returns {Promise<void>}
 */
async function init(logger = null) {
    if (logger) logger('Initializing domain cache from Phoenix');
    const cfg = config.load();
    const cache_ttl_ms = cfg.domain_cache_ttl_ms || config.DEFAULTS.domain_cache_ttl_ms;
    
    // Initial fetch
    await refresh_domains(logger);
    
    // Set up periodic refresh once per process
    if (!refresh_interval) {
        refresh_interval = setInterval(() => {
            refresh_domains(logger).catch(err => {
                if (logger) logger(`Periodic domain refresh failed: ${err.message}`);
            });
        }, cache_ttl_ms);
    }
    
    if (logger) logger('Domain cache initialized');
}

/**
 * Check if a domain is a local (protected) domain
 * @param {string} domain - Domain name to check
 * @returns {boolean} True if domain is local
 */
function is_local_domain(domain) {
    if (!domain) return false;
    const local_domains = get_local_domains();
    return local_domains.includes(domain.toLowerCase());
}

/**
 * Check if all recipients are on local domains
 * @param {string[]} recipients - Array of email addresses
 * @returns {boolean} True if all recipients are on local domains
 */
function all_recipients_local(recipients) {
    if (!recipients || recipients.length === 0) return false;
    
    const local_domains = get_local_domains();
    
    return recipients.every(recipient => {
        const domain = extract_domain(recipient);
        return domain && local_domains.includes(domain);
    });
}

/**
 * Check if any recipient is on a local domain
 * @param {string[]} recipients - Array of email addresses
 * @returns {boolean} True if any recipient is on a local domain
 */
function any_recipient_local(recipients) {
    if (!recipients || recipients.length === 0) return false;
    
    const local_domains = get_local_domains();
    
    return recipients.some(recipient => {
        const domain = extract_domain(recipient);
        return domain && local_domains.includes(domain);
    });
}

/**
 * Extract domain from an email address
 * Handles formats like "email@domain.com" and "Display Name <email@domain.com>"
 * @param {string} email - Email address (possibly with display name)
 * @returns {string|null} Domain name or null if invalid
 */
function extract_domain(email) {
    if (!email) return null;
    
    // Handle "Display Name <email@domain.com>" format
    const match = email.match(/<([^>]+)>/);
    const clean_email = match ? match[1] : email;
    
    // Extract domain part
    const parts = clean_email.split('@');
    if (parts.length !== 2) return null;
    
    return parts[1].toLowerCase().trim();
}

/**
 * Extract the clean email address from potentially formatted input
 * Handles formats like "email@domain.com" and "Display Name <email@domain.com>"
 * @param {string} email - Email address (possibly with display name)
 * @returns {string} Clean email address
 */
function extract_email(email) {
    if (!email) return '';
    
    // Handle "Display Name <email@domain.com>" format
    const match = email.match(/<([^>]+)>/);
    return match ? match[1] : email.trim();
}

/**
 * Filter recipients by local/external domain
 * @param {string[]} recipients - Array of email addresses
 * @returns {Object} Object with 'local' and 'external' arrays
 */
function partition_recipients(recipients) {
    const result = {
        local: [],
        external: []
    };
    
    if (!recipients || recipients.length === 0) return result;
    
    const local_domains = get_local_domains();
    
    recipients.forEach(recipient => {
        const domain = extract_domain(recipient);
        if (domain && local_domains.includes(domain)) {
            result.local.push(recipient);
        } else {
            result.external.push(recipient);
        }
    });
    
    return result;
}

/**
 * Get the current cached domains (for debugging/monitoring)
 * @returns {Object} Cache status and domains
 */
function get_cache_status() {
    const cfg = config.load();
    const cache_ttl_ms = cfg.domain_cache_ttl_ms || config.DEFAULTS.domain_cache_ttl_ms;

    return {
        cached: cached_domains !== null,
        domains: cached_domains || [],
        age_ms: cached_domains ? Date.now() - cache_timestamp : null,
        ttl_ms: cache_ttl_ms
    };
}

module.exports = {
    init,
    refresh_domains,
    get_local_domains,
    is_local_domain,
    all_recipients_local,
    any_recipient_local,
    extract_domain,
    extract_email,
    partition_recipients,
    get_cache_status
};
