/**
 * Elektrine Recipient Verification Plugin
 * 
 * Verifies that recipients exist before accepting email.
 * Prevents backscatter attacks from bouncing to spoofed senders.
 */

'use strict';

const constants = require('haraka-constants');

// Shared library modules
const { config, http: httpClient, domains } = require('../lib');

exports.register = function() {
    const plugin = this;
    
    // Load configuration
    plugin.cfg = config.load();
    
    // Log initial domains (may be updated dynamically from Phoenix)
    const local_domains = domains.get_local_domains();
    plugin.loginfo(`Recipient verification enabled for: ${local_domains.join(', ')}`);
    
    // Log cache status periodically (every 10 minutes)
    setInterval(() => {
        const cache_status = domains.get_cache_status();
        if (cache_status.cached) {
            plugin.logdebug(`Domain cache: ${cache_status.domains.length} domains, age: ${Math.round(cache_status.age_ms / 1000)}s`);
        }
    }, 10 * 60 * 1000);
};

exports.hook_rcpt = function(next, connection, params) {
    const plugin = this;
    const rcpt = params[0];
    
    if (!rcpt || !rcpt.host) {
        return next();
    }
    
    const recipient_domain = rcpt.host.toLowerCase();
    const recipient_email = rcpt.address().toLowerCase();
    
    // Check if this is for a local domain
    const is_local = domains.is_local_domain(recipient_domain);
    
    if (!is_local) {
        // External domain - only allow if authenticated (relay)
        // Check if connection is authenticated (handled by auth/auth_proxy plugin)
        if (connection.relaying) {
            plugin.loginfo(`Authenticated relay to external domain: ${recipient_email}`);
            return next();
        }
        
        // Not authenticated and not local domain - reject (prevent open relay)
        plugin.logwarn(`Rejecting relay attempt to external domain: ${recipient_email}`);
        return next(constants.DENY, `Relay not permitted for ${recipient_domain}`);
    }
    
    // Local domain - verify recipient exists in Phoenix
    plugin.loginfo(`Verifying recipient exists: ${recipient_email}`);
    
    // Verify with Phoenix app
    httpClient.verify_recipient(plugin.cfg.verify_url, recipient_email, {
        api_key: plugin.cfg.phoenix_api_key,
        timeout: plugin.cfg.verify_timeout,
        logger: (msg) => plugin.logdebug(msg)
    })
    .then((exists) => {
        if (exists) {
            plugin.loginfo(`Recipient verified: ${recipient_email}`);
            return next(constants.OK);
        } else {
            plugin.logwarn(`Recipient does not exist: ${recipient_email}`);
            return next(constants.DENY, `Recipient ${recipient_email} does not exist`);
        }
    })
    .catch((err) => {
        plugin.logerror(`Recipient verification failed: ${err.message}`);
        // On error, defer (temp fail) so the sending server retries later
        // This avoids accepting mail for potentially non-existent recipients
        // which would cause backscatter bounces
        return next(constants.DENYSOFT, 'Temporary recipient verification failure, please retry');
    });
};
