/**
 * Email Builder Module
 * 
 * Constructs RFC 5322 compliant email messages with proper MIME structure.
 * Supports plain text, HTML, multipart/alternative, and attachments.
 */

'use strict';

const crypto = require('crypto');
const domains = require('./domains');

const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function sanitize_header_value(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function sanitize_header_name(name) {
    const normalized = sanitize_header_value(name);
    if (!normalized || !HEADER_TOKEN_RE.test(normalized)) return '';
    return normalized;
}

function sanitize_message_id(value) {
    const normalized = sanitize_header_value(value).replace(/[^A-Za-z0-9._-]/g, '');
    return normalized || crypto.randomUUID();
}

function normalize_address(value) {
    const extracted = sanitize_header_value(domains.extract_email(sanitize_header_value(value)));
    if (!extracted) return '';
    if (!/^[^\s@<>]+@[A-Za-z0-9.-]+$/.test(extracted)) return '';
    return extracted;
}

function normalize_address_list(value) {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => normalize_address(entry)).filter(Boolean);
}

/**
 * Build an RFC 5322 compliant email message
 * @param {Object} email_data - Email data object
 * @param {string} email_data.from - Sender email address
 * @param {string|string[]} email_data.to - Recipient(s)
 * @param {string} [email_data.cc] - CC recipients
 * @param {string} [email_data.subject] - Email subject
 * @param {string} [email_data.text_body] - Plain text body
 * @param {string} [email_data.html_body] - HTML body
 * @param {string} [email_data.reply_to] - Reply-To address
 * @param {Object} [email_data.headers] - Custom headers
 * @param {Array} [email_data.attachments] - Attachments array
 * @param {string} [message_id] - Optional message ID (generated if not provided)
 * @returns {Object} Object with email_content and message_id
 */
function build(email_data, message_id = null) {
    message_id = sanitize_message_id(message_id || crypto.randomUUID());

    const safe_from = normalize_address(email_data.from);
    const safe_reply_to = normalize_address(email_data.reply_to || email_data.from) || safe_from;
    const safe_to_recipients = normalize_address_list(email_data.to);
    const safe_cc_recipients = normalize_address_list(email_data.cc);
    const safe_subject = sanitize_header_value(email_data.subject || '');

    if (!safe_from) {
        throw new Error('Invalid from address');
    }
    if (safe_to_recipients.length === 0) {
        throw new Error('Invalid to recipient list');
    }
    
    // Extract sender domain for Message-ID
    const sender_email = domains.extract_email(safe_from);
    const sender_domain = domains.extract_domain(safe_from) || 'haraka.local';
    
    // Build recipient list
    const recipients = safe_to_recipients;
    
    // Start building headers
    const headers = [
        `Message-ID: <${message_id}@${sender_domain}>`,
        `Date: ${new Date().toUTCString()}`,
        `From: ${safe_from}`,
        `Reply-To: ${safe_reply_to}`,
        `To: ${recipients.join(', ')}`
    ];
    
    // Add CC if present
    if (safe_cc_recipients.length > 0) {
        headers.push(`Cc: ${safe_cc_recipients.join(', ')}`);
    }
    
    // Add subject
    headers.push(`Subject: ${safe_subject}`);
    headers.push('MIME-Version: 1.0');
    
    // Add custom headers (with injection prevention)
    if (email_data.headers) {
        for (const [key, value] of Object.entries(email_data.headers)) {
            const safe_key = sanitize_header_name(key);
            if (!safe_key) continue;

            const safe_value = sanitize_header_value(value);
            // Skip dangerous headers that could override critical fields
            const lower_key = safe_key.toLowerCase();
            if (['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'mime-version'].includes(lower_key)) {
                continue;
            }
            headers.push(`${safe_key}: ${safe_value}`);
        }
    }
    
    // Determine email structure and build body
    const has_attachments = email_data.attachments && 
                           Array.isArray(email_data.attachments) && 
                           email_data.attachments.length > 0;
    
    let body_parts;
    
    if (has_attachments) {
        body_parts = build_multipart_mixed(email_data);
    } else if (email_data.text_body && email_data.html_body) {
        body_parts = build_multipart_alternative(email_data.text_body, email_data.html_body);
    } else if (email_data.html_body) {
        body_parts = build_html_body(email_data.html_body);
    } else {
        body_parts = build_text_body(email_data.text_body || '');
    }
    
    // Combine headers and body
    const email_content = [...headers, ...body_parts].join('\r\n');
    
    return {
        email_content,
        message_id,
        sender_email
    };
}

/**
 * Build a plain text body
 * @param {string} text - Plain text content
 * @returns {string[]} Body lines
 */
function build_text_body(text) {
    return [
        'Content-Type: text/plain; charset=utf-8',
        '',
        text
    ];
}

/**
 * Build an HTML body
 * @param {string} html - HTML content
 * @returns {string[]} Body lines
 */
function build_html_body(html) {
    return [
        'Content-Type: text/html; charset=utf-8',
        '',
        html
    ];
}

/**
 * Build a multipart/alternative body (text + HTML)
 * @param {string} text - Plain text content
 * @param {string} html - HTML content
 * @returns {string[]} Body lines
 */
function build_multipart_alternative(text, html) {
    const boundary = `boundary-${crypto.randomUUID()}`;
    
    return [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        text,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        html,
        '',
        `--${boundary}--`
    ];
}

/**
 * Build a multipart/mixed body (content + attachments)
 * @param {Object} email_data - Email data with attachments
 * @returns {string[]} Body lines
 */
function build_multipart_mixed(email_data) {
    const mixed_boundary = `boundary-mixed-${crypto.randomUUID()}`;
    const parts = [
        `Content-Type: multipart/mixed; boundary="${mixed_boundary}"`,
        '',
        `--${mixed_boundary}`
    ];
    
    // Add message body as first part
    if (email_data.text_body && email_data.html_body) {
        // Nested multipart/alternative for text + HTML
        const alt_boundary = `boundary-alt-${crypto.randomUUID()}`;
        parts.push(
            `Content-Type: multipart/alternative; boundary="${alt_boundary}"`,
            '',
            `--${alt_boundary}`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            email_data.text_body,
            '',
            `--${alt_boundary}`,
            'Content-Type: text/html; charset=utf-8',
            '',
            email_data.html_body,
            '',
            `--${alt_boundary}--`
        );
    } else if (email_data.html_body) {
        parts.push(
            'Content-Type: text/html; charset=utf-8',
            '',
            email_data.html_body
        );
    } else {
        parts.push(
            'Content-Type: text/plain; charset=utf-8',
            '',
            email_data.text_body || ''
        );
    }
    
    // Add attachment parts
    for (const attachment of email_data.attachments) {
        const safe_content_type = sanitize_header_value(attachment.content_type || 'application/octet-stream') || 'application/octet-stream';
        parts.push(
            '',
            `--${mixed_boundary}`,
            `Content-Type: ${safe_content_type}`,
            'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; filename="${(attachment.filename || 'attachment').replace(/["\\\/\r\n]/g, '_')}"`,
            '',
            attachment.data
        );
    }
    
    // Close boundary
    parts.push('', `--${mixed_boundary}--`);
    
    return parts;
}

/**
 * Convert structured email data to webhook format for local delivery
 * @param {Object} email_data - Structured email data
 * @param {string} message_id - Message ID
 * @returns {Object} Webhook-formatted data
 */
function to_webhook_format(email_data, message_id) {
    return {
        message_id: message_id,
        from: email_data.from,
        to: Array.isArray(email_data.to) ? email_data.to[0] : email_data.to,
        cc: email_data.cc,
        bcc: email_data.bcc,
        subject: email_data.subject,
        text_body: email_data.text_body || email_data.body,
        html_body: email_data.html_body,
        attachments: email_data.attachments || [],
        timestamp: new Date().toISOString(),
        id: message_id
    };
}

/**
 * Collect all recipients from email data (to, cc, bcc)
 * @param {Object} email_data - Email data
 * @returns {string[]} Array of all recipient email addresses
 */
function collect_recipients(email_data) {
    const recipients = [];
    
    // Add TO recipients
    if (email_data.to) {
        const to_list = normalize_address_list(email_data.to);
        recipients.push(...to_list);
    }
    
    // Add CC recipients
    if (email_data.cc) {
        const cc_list = normalize_address_list(email_data.cc);
        recipients.push(...cc_list);
    }
    
    // Add BCC recipients
    if (email_data.bcc) {
        const bcc_list = normalize_address_list(email_data.bcc);
        recipients.push(...bcc_list);
    }
    
    return recipients;
}

module.exports = {
    build,
    build_text_body,
    build_html_body,
    build_multipart_alternative,
    build_multipart_mixed,
    to_webhook_format,
    collect_recipients
};
