/**
 * Spam Extractor Module
 * 
 * Extracts spam information from Haraka connection/transaction notes
 * and email headers. Supports SpamAssassin results.
 */

'use strict';

/**
 * Default spam info structure
 * @returns {Object} Default spam info object
 */
function get_default_spam_info() {
    return {
        status: 'unknown',
        score: 0.0,
        threshold: 5.0,
        report: null,
        status_header: null
    };
}

/**
 * Extract spam information from multiple sources
 * Checks transaction notes, connection notes, and headers in order of priority.
 * 
 * @param {Object} connection - Haraka connection object
 * @param {Object} transaction - Haraka transaction object
 * @param {Object} headers - Parsed email headers (from mailparser)
 * @param {Object} [options] - Optional settings
 * @param {boolean} [options.debug=false] - Enable debug logging
 * @param {Function} [options.logger] - Logger function
 * @returns {Object} Spam info object
 */
function extract(connection, transaction, headers, options = {}) {
    const { debug = false, logger = console.log } = options;
    
    if (debug) logger('Starting spam extraction');
    
    const spam_info = get_default_spam_info();
    
    // Method 1: Check transaction notes (highest priority)
    if (transaction && transaction.notes && transaction.notes.spamassassin) {
        if (debug) logger('Found spamassassin in transaction.notes');
        return parse_spamassassin_notes(transaction.notes.spamassassin, spam_info, debug, logger);
    }
    
    // Method 2: Check connection notes
    if (connection && connection.notes && connection.notes.spamassassin) {
        if (debug) logger('Found spamassassin in connection.notes');
        return parse_spamassassin_notes(connection.notes.spamassassin, spam_info, debug, logger);
    }
    
    // Method 3: Check email headers (fallback)
    if (headers) {
        const header_result = parse_spam_headers(headers, spam_info, debug, logger);
        if (header_result.status !== 'unknown') {
            return header_result;
        }
    }
    
    if (debug) logger('No spam info found in any source');
    return spam_info;
}

/**
 * Parse SpamAssassin notes from Haraka
 * @param {Object} sa - SpamAssassin notes object
 * @param {Object} spam_info - Base spam info object
 * @param {boolean} debug - Debug mode
 * @param {Function} logger - Logger function
 * @returns {Object} Updated spam info
 */
function parse_spamassassin_notes(sa, spam_info, debug, logger) {
    if (debug) logger(`Parsing SpamAssassin notes: ${JSON.stringify(sa)}`);
    
    if (sa.score !== undefined) {
        spam_info.score = parseFloat(sa.score) || 0.0;
    }
    
    if (sa.reqd !== undefined) {
        spam_info.threshold = parseFloat(sa.reqd) || 5.0;
    }
    
    if (sa.flag !== undefined) {
        spam_info.status = sa.flag === 'Yes' ? 'spam' : 'ham';
    }
    
    if (sa.tests) {
        spam_info.report = sa.tests;
    }
    
    return spam_info;
}

/**
 * Parse spam information from email headers
 * @param {Object} headers - Email headers (Map or object)
 * @param {Object} spam_info - Base spam info object
 * @param {boolean} debug - Debug mode
 * @param {Function} logger - Logger function
 * @returns {Object} Updated spam info
 */
function parse_spam_headers(headers, spam_info, debug, logger) {
    if (debug) logger('Checking headers for spam info');
    
    // Get header values (handle both Map and object formats)
    const get_header = (name) => {
        if (headers instanceof Map) {
            return headers.get(name) || headers.get(name.toLowerCase());
        }
        return headers[name] || headers[name.toLowerCase()];
    };
    
    const spam_status = get_header('X-Spam-Status') || get_header('x-spam-status');
    const spam_score = get_header('X-Spam-Score') || get_header('x-spam-score');
    const spam_report = get_header('X-Spam-Report') || get_header('x-spam-report');
    
    if (spam_status || spam_score) {
        if (debug) logger(`Found spam headers - Status: ${spam_status}, Score: ${spam_score}`);
        
        if (spam_status && typeof spam_status === 'string') {
            spam_info.status_header = spam_status;
            
            // Parse "Yes, score=5.2, required=5.0" or "No, score=-1.6, required=5.0"
            const score_match = spam_status.match(/score=([-\d.]+)/);
            const req_match = spam_status.match(/required=([-\d.]+)/);
            
            if (score_match) {
                spam_info.score = parseFloat(score_match[1]) || 0.0;
            }
            if (req_match) {
                spam_info.threshold = parseFloat(req_match[1]) || 5.0;
            }
            
            spam_info.status = spam_status.startsWith('Yes') ? 'spam' : 'ham';
        }
        
        // Override score if separate header exists
        if (spam_score && typeof spam_score === 'string') {
            spam_info.score = parseFloat(spam_score) || spam_info.score;
        }
        
        // Add report if available
        if (spam_report && typeof spam_report === 'string') {
            spam_info.report = spam_report;
        }
    }
    
    return spam_info;
}

/**
 * Determine if an email should be marked as spam based on score
 * @param {number} score - Spam score
 * @param {number} [threshold=5.0] - Spam threshold
 * @returns {boolean} True if spam
 */
function is_spam(score, threshold = 5.0) {
    return score >= threshold;
}

module.exports = {
    extract,
    get_default_spam_info,
    parse_spamassassin_notes,
    parse_spam_headers,
    is_spam
};
