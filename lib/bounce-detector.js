/**
 * Bounce Detector Module
 * 
 * Detects bounce/DSN (Delivery Status Notification) messages
 * to prevent forwarding them to webhooks and avoid bounce loops.
 */

'use strict';

/**
 * Indicators that suggest an email is a bounce message
 */
const BOUNCE_INDICATORS = {
    // Common bounce sender addresses
    sender_patterns: [
        'mailer-daemon',
        'postmaster',
        'mail-daemon',
        'mailerdaemon'
    ],
    
    // Common bounce subject keywords
    subject_patterns: [
        'delivery',
        'bounce',
        'failure',
        'undelivered',
        'returned',
        'undeliverable',
        'delivery status',
        'delivery failed',
        'mail delivery',
        'delivery notification',
        'could not be delivered',
        'not delivered'
    ],
    
    // DSN (Delivery Status Notification) body indicators
    body_patterns: [
        'Original-Envelope-Id:',
        'Reporting-MTA:',
        'Final-Recipient:',
        'Action: failed',
        'Action: delayed',
        'Diagnostic-Code:',
        'Remote-MTA:',
        'X-Postfix-Queue-ID:',
        'This is the mail system at host',
        'This message was created automatically',
        'Delivery to the following recipient'
    ]
};

/**
 * Check if an email is a bounce message
 * 
 * @param {string} from_email - Sender email address
 * @param {string} subject - Email subject
 * @param {string} text_body - Plain text body
 * @param {Object} [options] - Options
 * @param {boolean} [options.strict=false] - Require multiple indicators
 * @param {boolean} [options.debug=false] - Enable debug logging
 * @param {Function} [options.logger] - Logger function
 * @returns {boolean} True if message appears to be a bounce
 */
function is_bounce(from_email, subject, text_body, options = {}) {
    const { strict = false, debug = false, logger = console.log } = options;
    const envelope_from = options.envelope_from;
    const indicators_found = [];
    let sender_indicator = false;
    let subject_indicator = false;
    let body_indicator_count = 0;
    let null_sender = false;

    // Prefer envelope sender when available. True bounces normally use "<>".
    if (typeof envelope_from === 'string') {
        const trimmed = envelope_from.trim();
        if (!trimmed || trimmed === '<>') {
            null_sender = true;
            indicators_found.push('envelope:null_sender');
        }
    } else if (!from_email || from_email.trim() === '') {
        null_sender = true;
        indicators_found.push('header:empty_sender');
    }

    // Check sender patterns
    if (from_email) {
        const from_lower = from_email.toLowerCase();
        for (const pattern of BOUNCE_INDICATORS.sender_patterns) {
            if (from_lower.includes(pattern)) {
                sender_indicator = true;
                indicators_found.push(`sender:${pattern}`);
                break;
            }
        }
    }
    
    // Check subject patterns
    if (subject) {
        const subject_lower = subject.toLowerCase();
        for (const pattern of BOUNCE_INDICATORS.subject_patterns) {
            if (subject_lower.includes(pattern)) {
                subject_indicator = true;
                indicators_found.push(`subject:${pattern}`);
                break;
            }
        }
    }
    
    // Check body patterns (DSN indicators)
    if (text_body) {
        for (const pattern of BOUNCE_INDICATORS.body_patterns) {
            if (text_body.includes(pattern)) {
                body_indicator_count += 1;
                indicators_found.push(`body:${pattern}`);
            }
        }
    }
    
    if (debug && indicators_found.length > 0) {
        logger(`Bounce indicators found: ${indicators_found.join(', ')}`);
    }
    
    // In strict mode, require stronger DSN evidence.
    if (strict) {
        if (null_sender && (subject_indicator || body_indicator_count >= 1 || sender_indicator)) return true;
        if (body_indicator_count >= 2) return true;
        if (sender_indicator && (subject_indicator || body_indicator_count >= 1)) return true;
        if (subject_indicator && body_indicator_count >= 1) return true;
        return false;
    }

    // Default mode: avoid false positives (e.g. noreply notifications) by
    // requiring correlated bounce/DSN signals instead of a single keyword.
    if (null_sender && (subject_indicator || body_indicator_count >= 1 || sender_indicator)) return true;
    if (body_indicator_count >= 2) return true;
    if (sender_indicator && (subject_indicator || body_indicator_count >= 1)) return true;
    if (subject_indicator && body_indicator_count >= 1) return true;
    return false;
}

/**
 * Get detailed bounce analysis
 * 
 * @param {string} from_email - Sender email address
 * @param {string} subject - Email subject
 * @param {string} text_body - Plain text body
 * @returns {Object} Detailed bounce analysis
 */
function analyze(from_email, subject, text_body) {
    const result = {
        is_bounce: false,
        confidence: 'none',
        indicators: [],
        dsn_detected: false,
        bounce_type: null
    };
    
    // Check empty sender header
    if (!from_email || from_email.trim() === '') {
        result.indicators.push({ type: 'sender', reason: 'empty_sender_header' });
    }
    
    // Check sender patterns
    if (from_email) {
        const from_lower = from_email.toLowerCase();
        for (const pattern of BOUNCE_INDICATORS.sender_patterns) {
            if (from_lower.includes(pattern)) {
                result.indicators.push({ type: 'sender', reason: pattern });
            }
        }
    }
    
    // Check subject patterns
    if (subject) {
        const subject_lower = subject.toLowerCase();
        for (const pattern of BOUNCE_INDICATORS.subject_patterns) {
            if (subject_lower.includes(pattern)) {
                result.indicators.push({ type: 'subject', reason: pattern });
            }
        }
    }
    
    // Check body patterns
    if (text_body) {
        let dsn_indicators = 0;
        for (const pattern of BOUNCE_INDICATORS.body_patterns) {
            if (text_body.includes(pattern)) {
                result.indicators.push({ type: 'body', reason: pattern });
                dsn_indicators++;
            }
        }
        // If multiple DSN indicators, it's definitely a DSN
        if (dsn_indicators >= 2) {
            result.dsn_detected = true;
        }
    }
    
    result.is_bounce = is_bounce(from_email, subject, text_body);

    // Determine confidence (conservative: single weak indicator is low confidence
    // but not necessarily classified as a bounce).
    const count = result.indicators.length;
    if (!result.is_bounce && count === 0) {
        result.confidence = 'none';
    } else if (count <= 1) {
        result.confidence = 'low';
    } else if (count === 2) {
        result.confidence = 'medium';
    } else {
        result.confidence = 'high';
    }
    
    // Determine bounce type
    if (result.is_bounce) {
        if (result.dsn_detected) {
            result.bounce_type = 'dsn';
        } else if (result.indicators.some(i => i.reason === 'empty_sender' || i.reason === 'empty_sender_header')) {
            result.bounce_type = 'null_sender';
        } else {
            result.bounce_type = 'automated';
        }
    }
    
    return result;
}

/**
 * Check if message is an auto-reply (out of office, etc.)
 * 
 * @param {Object} headers - Email headers
 * @returns {boolean} True if auto-reply
 */
function is_auto_reply(headers) {
    if (!headers) return false;
    
    // Check Auto-Submitted header (RFC 3834)
    const auto_submitted = headers['auto-submitted'] || headers['Auto-Submitted'];
    if (auto_submitted && auto_submitted !== 'no') {
        return true;
    }
    
    // Check X-Auto-Response-Suppress header
    const auto_suppress = headers['x-auto-response-suppress'] || headers['X-Auto-Response-Suppress'];
    if (auto_suppress) {
        return true;
    }
    
    // Check Precedence header
    const precedence = headers['precedence'] || headers['Precedence'];
    if (precedence) {
        const prec_lower = precedence.toLowerCase();
        if (prec_lower === 'bulk' || prec_lower === 'junk' || prec_lower === 'auto_reply') {
            return true;
        }
    }
    
    return false;
}

module.exports = {
    is_bounce,
    analyze,
    is_auto_reply,
    BOUNCE_INDICATORS
};
