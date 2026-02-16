/**
 * Elektrine Webhook Plugin
 * 
 * Processes inbound emails and forwards them to the Phoenix application
 * via webhook. Handles email parsing, spam detection, and attachment extraction.
 */

'use strict';

const crypto = require('crypto');
const constants = require('haraka-constants');

// Shared library modules
const { 
    config, 
    http: httpClient, 
    mime,
    domains, 
    spam: spamExtractor, 
    attachments: attachmentHandler,
    bounce: bounceDetector,
    text
} = require('../lib');

// Retry configuration
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

exports.register = function() {
    const plugin = this;

    // Load configuration from .ini file with environment variable overrides
    plugin.load_config();

    // Validate critical config at startup
    if (!plugin.cfg.phoenix_api_key) {
        plugin.logerror('CRITICAL: Phoenix API key is not configured. Set PHOENIX_API_KEY environment variable.');
    }
    if (!plugin.cfg.webhook_url) {
        plugin.logerror('CRITICAL: Webhook URL is not configured. Set PHOENIX_WEBHOOK_URL environment variable.');
    }

    // Initialize domain cache from Phoenix (async)
    // This fetches custom domains in addition to built-in domains
    domains.init((msg) => plugin.loginfo(`[domains] ${msg}`))
        .then(() => {
            plugin.loginfo('Domain cache initialized successfully');
        })
        .catch((err) => {
            plugin.logwarn(`Domain cache initialization failed: ${err.message}`);
        });

    // Register for the queue event (when email is fully received)
    plugin.register_hook('queue', 'send_to_elektrine');
};

exports.load_config = function() {
    const plugin = this;
    
    // Load Haraka .ini config
    const haraka_cfg = plugin.config.get('elektrine_webhook.ini', {
        booleans: [
            '+main.enabled',
            '+main.include_headers',
            '+main.include_body', 
            '+main.include_attachments'
        ]
    }, function() {
        plugin.load_config();
    });
    
    // Merge with centralized config
    plugin.cfg = config.load(haraka_cfg);
};

exports.send_to_elektrine = function(next, connection) {
    const plugin = this;
    
    if (!plugin.cfg.webhook_enabled) {
        return next(constants.ok, 'Webhook disabled');
    }
    
    const transaction = connection.transaction;
    if (!transaction) {
        return next(constants.ok, 'No transaction');
    }
    
    // Only process emails TO local domains (inbound emails)
    const is_inbound = transaction.rcpt_to.some(rcpt => {
        return domains.is_local_domain(rcpt.host);
    });
    
    if (!is_inbound) {
        plugin.loginfo('Skipping outbound email - not destined for local domains');
        return next(constants.ok, 'Not inbound email');
    }
    
    // Parse email and send webhook
    plugin.parse_and_send(transaction, connection, next);
};

exports.parse_and_send = function(transaction, connection, next) {
    const plugin = this;
    
    if (!transaction.message_stream) {
        return next(constants.ok, 'No message stream available');
    }

    mime.read_message_stream(transaction.message_stream)
        .then((raw_buffer) => mime.parse_mime(raw_buffer, {
            logger: (level, message) => {
                if (level === 'warn') plugin.logwarn(message);
            }
        }))
        .then((parsed) => {
            // Build email data for webhook
            const email_data = plugin.build_webhook_data(transaction, connection, parsed);

            // Check for bounce message
            if (email_data.is_bounce) {
                plugin.loginfo(`Skipping bounce message: ${email_data.subject}`);
                return next(constants.ok, 'Bounce message - not forwarding');
            }

            // Send to Phoenix
            plugin.send_webhook(email_data, next);
        })
        .catch((err) => {
            plugin.logerror(`Email parsing failed: ${err.message}`);
            return next(constants.ok, 'Message queued despite parsing error');
        });
};

exports.build_webhook_data = function(transaction, connection, parsed) {
    const plugin = this;
    
    const message_id = transaction.uuid || crypto.randomUUID();
    const mail_from = transaction.mail_from ? transaction.mail_from.address() : '';
    const rcpt_to = transaction.rcpt_to.map(rcpt => rcpt.address());
    
    // Extract from email
    const from_email = text.normalize_header(parsed.from ? parsed.from.text : mail_from);
    const subject = text.normalize_header(parsed.subject || '');
    const text_body = parsed.text || '';
    const html_body = parsed.html || '';
    const to_email = text.normalize_header(parsed.to ? parsed.to.text : rcpt_to[0] || '');
    
    // Check if bounce
    const is_bounce = bounceDetector.is_bounce(from_email, subject, text_body);
    
    // Extract spam info
    const spam_data = spamExtractor.extract(connection, transaction, parsed.headers);
    
    // Extract attachments
    const attachment_data = attachmentHandler.extract(transaction, parsed, {
        include_content: plugin.cfg.include_attachments
    });
    
    return {
        message_id: message_id,
        from: from_email,
        to: to_email,
        rcpt_to: text.normalize_header(rcpt_to[0] || ''),
        mail_from: text.normalize_header(mail_from),
        subject: subject,
        text_body: text_body,
        html_body: html_body,
        headers: plugin.cfg.include_headers ? parsed.headers : undefined,
        spam_status: spam_data.status,
        spam_score: spam_data.score,
        spam_threshold: spam_data.threshold,
        spam_report: spam_data.report,
        spam_status_header: spam_data.status_header,
        attachments: attachment_data.attachments,
        attachment_count: attachment_data.count,
        has_attachments: attachment_data.has_attachments,
        size: transaction.data_bytes,
        timestamp: new Date().toISOString(),
        is_bounce: is_bounce
    };
};

exports.send_webhook = function(email_data, next) {
    const plugin = this;

    plugin.send_webhook_with_retry(email_data, 0, next);
};

exports.send_webhook_with_retry = function(email_data, attempt, next) {
    const plugin = this;

    httpClient.send_webhook(plugin.cfg.webhook_url, email_data, {
        api_key: plugin.cfg.phoenix_api_key,
        timeout: plugin.cfg.webhook_timeout,
        logger: (msg) => plugin.loginfo(msg)
    })
    .then((result) => {
        plugin.loginfo(`Email sent to Elektrine successfully: ${result.message_id || email_data.message_id}`);
        return next(constants.ok, 'Message accepted');
    })
    .catch((err) => {
        plugin.logerror(`Webhook failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}`);

        // Don't retry client errors (4xx) - they won't succeed on retry
        if (err.status && err.status >= 400 && err.status < 500) {
            return plugin.handle_webhook_error(err.status, next);
        }

        // Retry on server errors (5xx) and network errors
        if (attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
            plugin.loginfo(`Retrying webhook in ${delay}ms...`);
            setTimeout(() => {
                plugin.send_webhook_with_retry(email_data, attempt + 1, next);
            }, delay);
            return;
        }

        // All retries exhausted
        if (err.status) {
            return plugin.handle_webhook_error(err.status, next);
        }

        // Network failure after all retries - defer so sending server retries later
        plugin.logwarn('Webhook failed after all retries, deferring');
        return next(constants.denysoft, 'Temporary delivery failure, please retry');
    });
};

exports.handle_webhook_error = function(status_code, next) {
    const plugin = this;
    
    if (status_code === 404 || status_code === 400) {
        // Mailbox does not exist or invalid recipient - hard bounce
        plugin.loginfo('Bouncing email - mailbox does not exist or invalid recipient');
        return next(constants.deny, 'Mailbox does not exist');
    }

    if (status_code === 401 || status_code === 403 || status_code === 429) {
        // Auth/rate-limit errors are usually operational and should not hard-bounce inbound mail.
        plugin.logwarn(`Deferring email - upstream auth/rate-limit issue (${status_code})`);
        return next(constants.denysoft, 'Temporary upstream authentication/rate-limit failure');
    }
    
    if (status_code === 507) {
        // Storage limit exceeded - soft bounce
        plugin.loginfo('Deferring email - mailbox storage limit exceeded');
        return next(constants.denysoft, 'Mailbox storage limit exceeded');
    }
    
    if (status_code >= 500) {
        // 5xx errors - soft bounce (temporary failure)
        plugin.loginfo('Deferring email - temporary server error');
        return next(constants.denysoft, 'Temporary server error');
    }
    
    // Other 4xx errors - hard bounce
    plugin.loginfo('Bouncing email - client error');
    return next(constants.deny, 'Client error');
};
