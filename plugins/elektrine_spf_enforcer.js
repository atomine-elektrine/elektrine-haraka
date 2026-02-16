/**
 * Elektrine SPF Enforcer Plugin
 * 
 * Strictly enforces SPF for emails claiming to be from protected domains.
 * Prevents spoofing of local domain addresses.
 */

'use strict';

const constants = require('haraka-constants');

// Shared library modules
const { domains } = require('../lib');

exports.register = function() {
    const plugin = this;
    
    plugin.loginfo(`SPF Enforcer loaded - protecting: ${domains.get_local_domains().join(', ')}`);
};

exports.hook_mail = function(next, connection, params) {
    const plugin = this;
    const mail_from = params[0];
    
    if (!mail_from || !mail_from.host) {
        return next();
    }
    
    const from_domain = mail_from.host.toLowerCase();
    
    // Check if email claims to be from one of our protected domains
    if (!domains.is_local_domain(from_domain)) {
        return next(); // Not our domain, let other plugins handle it
    }
    
    // Store that this is from our domain for later checks
    connection.transaction.notes.from_protected_domain = true;
    connection.transaction.notes.protected_domain = from_domain;
    
    plugin.loginfo(`Email claims to be from protected domain: ${from_domain}`);
    
    return next();
};

exports.hook_data_post = function(next, connection) {
    const plugin = this;
    const transaction = connection.transaction;
    
    // Only check emails claiming to be from our domains
    if (!transaction.notes.from_protected_domain) {
        return next();
    }
    
    const protected_domain = transaction.notes.protected_domain;
    
    // Check SPF result
    const spf_result = transaction.results.get('spf');
    
    if (!spf_result) {
        plugin.logwarn(`No SPF result for email from ${protected_domain} - accepting anyway`);
        return next();
    }
    
    const spf_status = spf_result.result;
    
    plugin.loginfo(`SPF check for ${protected_domain}: ${spf_status}`);
    
    // Reject if SPF failed
    if (spf_status === 'Fail' || spf_status === 'fail') {
        plugin.logwarn(`Rejecting spoofed email from ${protected_domain} - SPF: ${spf_status}`);
        return next(constants.DENY, 
            `Email rejected: SPF validation failed for ${protected_domain}. This email appears to be spoofed.`);
    }
    
    // Reject on SPF errors (suspicious)
    if (spf_status === 'TempError' || spf_status === 'PermError') {
        plugin.logwarn(`Rejecting email from ${protected_domain} due to SPF error: ${spf_status}`);
        return next(constants.DENYSOFT, 
            `Email temporarily rejected: SPF check failed for ${protected_domain}`);
    }
    
    // Accept if SPF passed or softfail
    plugin.loginfo(`Accepting email from ${protected_domain} - SPF: ${spf_status}`);
    return next();
};
