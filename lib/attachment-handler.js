/**
 * Attachment Handler Module
 * 
 * Extracts and processes email attachments from parsed emails.
 * Converts attachment content to base64 for API transmission.
 */

'use strict';

/**
 * Extract attachment information from a parsed email
 * 
 * @param {Object} transaction - Haraka transaction object
 * @param {Object} parsed - Parsed email from mailparser
 * @param {Object} [options] - Options
 * @param {boolean} [options.include_content=true] - Include base64 content
 * @param {boolean} [options.debug=false] - Enable debug logging
 * @param {Function} [options.logger] - Logger function
 * @returns {Object} Object with attachments array and count
 */
function extract(transaction, parsed, options = {}) {
    const { 
        include_content = true, 
        debug = false, 
        logger = console.log 
    } = options;
    
    if (debug) logger('Extracting attachment information');
    
    let attachments = [];
    let attachment_count = 0;
    
    // Primary: Use mailparser attachments (best source for content)
    if (parsed && parsed.attachments && parsed.attachments.length > 0) {
        if (debug) logger(`Found ${parsed.attachments.length} parsed attachments`);
        
        attachment_count = parsed.attachments.length;
        attachments = parsed.attachments.map((att, index) => {
            return format_attachment(att, index, include_content, debug, logger);
        });
    }
    // Fallback: Check transaction notes for attachment plugin results
    else if (transaction && transaction.notes && transaction.notes.attachment) {
        if (debug) logger('Using attachment notes fallback');
        
        const att_notes = transaction.notes.attachment;
        
        if (att_notes.files && Array.isArray(att_notes.files)) {
            attachment_count = att_notes.files.length;
            attachments = att_notes.files.map((file, index) => ({
                filename: file.filename || file.name || `attachment_${index}`,
                content_type: file.ctype || file.content_type || 'application/octet-stream',
                size: file.bytes || file.size || 0,
                md5: file.md5,
                content: null,  // No content available from plugin notes
                encoding: 'base64',
                index: index
            }));
        }
    }
    
    if (debug) {
        const with_content = attachments.filter(a => a.content).length;
        logger(`Final attachment count: ${attachment_count}, with content: ${with_content}`);
    }
    
    return {
        attachments,
        count: attachment_count,
        has_attachments: attachment_count > 0
    };
}

/**
 * Format a single attachment for API transmission
 * 
 * @param {Object} att - Attachment object from mailparser
 * @param {number} index - Attachment index
 * @param {boolean} include_content - Include base64 content
 * @param {boolean} debug - Debug mode
 * @param {Function} logger - Logger function
 * @returns {Object} Formatted attachment object
 */
function format_attachment(att, index, include_content, debug, logger) {
    let content_base64 = null;
    
    if (include_content && att.content) {
        content_base64 = to_base64(att.content);
    }
    
    const attachment_info = {
        filename: att.filename || att.name || `attachment_${index}`,
        content_type: att.contentType || att.content_type || 'application/octet-stream',
        size: att.size || (att.content ? att.content.length : 0),
        content_id: att.cid || null,
        content: content_base64,
        encoding: 'base64',
        index: index
    };
    
    if (debug) {
        logger(`Attachment ${index}: ${attachment_info.filename}, ` +
               `${attachment_info.size} bytes, type: ${attachment_info.content_type}`);
    }
    
    return attachment_info;
}

/**
 * Convert content to base64 string
 * 
 * @param {Buffer|string} content - Content to convert
 * @returns {string|null} Base64 encoded string or null
 */
function to_base64(content) {
    if (!content) return null;
    
    if (Buffer.isBuffer(content)) {
        return content.toString('base64');
    }
    
    if (typeof content === 'string') {
        return Buffer.from(content).toString('base64');
    }
    
    return null;
}

/**
 * Calculate total attachment size
 * 
 * @param {Array} attachments - Array of attachment objects
 * @returns {number} Total size in bytes
 */
function get_total_size(attachments) {
    if (!attachments || !Array.isArray(attachments)) return 0;
    
    return attachments.reduce((total, att) => {
        return total + (att.size || 0);
    }, 0);
}

/**
 * Check if any attachment exceeds size limit
 * 
 * @param {Array} attachments - Array of attachment objects
 * @param {number} max_size - Maximum size in bytes
 * @returns {boolean} True if any attachment exceeds limit
 */
function has_oversized(attachments, max_size) {
    if (!attachments || !Array.isArray(attachments)) return false;
    
    return attachments.some(att => (att.size || 0) > max_size);
}

/**
 * Filter attachments by content type
 * 
 * @param {Array} attachments - Array of attachment objects
 * @param {string|string[]} content_types - Content type(s) to match
 * @returns {Array} Filtered attachments
 */
function filter_by_type(attachments, content_types) {
    if (!attachments || !Array.isArray(attachments)) return [];
    
    const types = Array.isArray(content_types) ? content_types : [content_types];
    
    return attachments.filter(att => {
        const att_type = (att.content_type || '').toLowerCase();
        return types.some(type => att_type.includes(type.toLowerCase()));
    });
}

module.exports = {
    extract,
    format_attachment,
    to_base64,
    get_total_size,
    has_oversized,
    filter_by_type
};
