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
    // Null/empty sender is typical for bounces
    empty_sender: true,
    
    // Common bounce sender addresses
    sender_patterns: [
        'mailer-daemon',
        'postmaster',
        'mail-daemon',
        'mailerdaemon',
        'bounce',
        'noreply',
        'no-reply'
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
    
    const indicators_found = [];
    
    // Check for empty/null sender
    if (!from_email || from_email.trim() === '') {
        indicators_found.push('empty_sender');
    }
    
    // Check sender patterns
    if (from_email) {
        const from_lower = from_email.toLowerCase();
        for (const pattern of BOUNCE_INDICATORS.sender_patterns) {
            if (from_lower.includes(pattern)) {
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
                indicators_found.push(`subject:${pattern}`);
                break;
            }
        }
    }
    
    // Check body patterns (DSN indicators)
    if (text_body) {
        for (const pattern of BOUNCE_INDICATORS.body_patterns) {
            if (text_body.includes(pattern)) {
                indicators_found.push(`body:${pattern}`);
                break;
            }
        }
    }
    
    if (debug && indicators_found.length > 0) {
        logger(`Bounce indicators found: ${indicators_found.join(', ')}`);
    }
    
    // In strict mode, require at least 2 indicators
    if (strict) {
        return indicators_found.length >= 2;
    }
    
    // In normal mode, any indicator is enough
    return indicators_found.length > 0;
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
    
    // Check empty sender
    if (!from_email || from_email.trim() === '') {
        result.indicators.push({ type: 'sender', reason: 'empty_sender' });
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
    
    // Determine confidence and bounce status
    const count = result.indicators.length;
    
    if (count === 0) {
        result.confidence = 'none';
        result.is_bounce = false;
    } else if (count === 1) {
        result.confidence = 'low';
        result.is_bounce = true;
    } else if (count === 2) {
        result.confidence = 'medium';
        result.is_bounce = true;
    } else {
        result.confidence = 'high';
        result.is_bounce = true;
    }
    
    // Determine bounce type
    if (result.is_bounce) {
        if (result.dsn_detected) {
            result.bounce_type = 'dsn';
        } else if (result.indicators.some(i => i.reason === 'empty_sender')) {
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
