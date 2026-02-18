/**
 * MIME parsing helpers with charset-decoding fallback behavior.
 */

'use strict';

const { simpleParser } = require('mailparser');
const text_normalizer = require('./text-normalizer');

let cached_libmime = undefined;

let cached_iconv = undefined;

function get_iconv_constructor() {
    if (cached_iconv !== undefined) return cached_iconv;

    try {
        cached_iconv = require('iconv').Iconv;
    } catch (err) {
        cached_iconv = null;
    }

    return cached_iconv;
}

function get_libmime() {
    if (cached_libmime !== undefined) return cached_libmime;

    try {
        cached_libmime = require('libmime');
    } catch (err) {
        cached_libmime = null;
    }

    return cached_libmime;
}

function is_charset_decode_error(err) {
    if (!err || !err.message) return false;

    const message = String(err.message).toLowerCase();
    return (
        message.includes('charset') ||
        message.includes('encoding') ||
        message.includes('iconv') ||
        message.includes('decode')
    );
}

function count_mojibake_pairs(value) {
    if (typeof value !== 'string' || value.length < 2) return 0;

    let count = 0;
    for (let i = 0; i < value.length - 1; i += 1) {
        const a = value.charCodeAt(i);
        const b = value.charCodeAt(i + 1);
        if (a >= 0x00C2 && a <= 0x00F4 && b >= 0x0080 && b <= 0x00BF) {
            count += 1;
        }
    }

    return count;
}

function parsed_mojibake_score(parsed) {
    if (!parsed || typeof parsed !== 'object') return 0;

    const fields = [
        parsed.subject,
        parsed.text,
        parsed.html,
        parsed.from && parsed.from.text,
        parsed.to && parsed.to.text,
        parsed.cc && parsed.cc.text
    ];

    let score = 0;
    for (const value of fields) {
        if (typeof value !== 'string') continue;
        const sample = value.length > 4096 ? value.slice(0, 4096) : value;
        score += count_mojibake_pairs(sample);
    }

    return score;
}

function text_quality_score(value) {
    if (typeof value !== 'string') return Number.MAX_SAFE_INTEGER;

    const mojibake_pairs = count_mojibake_pairs(value);
    const control_count = (value.match(/[\u0080-\u009F]/g) || []).length;
    const replacement_count = (value.match(/\uFFFD/g) || []).length;

    // Lower is better.
    return mojibake_pairs * 5 + control_count * 3 + replacement_count * 8;
}

function decode_subject_from_header_lines(parsed) {
    if (!parsed || !Array.isArray(parsed.headerLines)) return null;

    const subject_line = parsed.headerLines.find((line) => line && line.key === 'subject');
    if (!subject_line || typeof subject_line.line !== 'string') return null;

    const raw = subject_line.line.replace(/^subject\s*:/i, '').trim();
    if (!raw) return null;

    const libmime = get_libmime();

    try {
        if (libmime && typeof libmime.decodeWords === 'function') {
            return String(libmime.decodeWords(raw));
        }
    } catch (_err) {
        // fall through to returning raw text for further normalization
    }

    return raw;
}

function choose_best_subject(parsed_subject, header_line_subject) {
    const parsed_candidate = text_normalizer.normalize_header(parsed_subject || '');
    const header_candidate = text_normalizer.normalize_header(header_line_subject || '');

    const parsed_score = text_quality_score(parsed_candidate);
    const header_score = text_quality_score(header_candidate);

    if (header_candidate && header_score < parsed_score) {
        return header_candidate;
    }

    return parsed_candidate;
}

function normalize_parsed_headers(parsed) {
    if (!parsed || typeof parsed !== 'object') return parsed;

    const decoded_subject = decode_subject_from_header_lines(parsed);
    parsed.subject = choose_best_subject(parsed.subject || '', decoded_subject || '');

    return parsed;
}

function parse_stream_data(arg1, arg2) {
    if (arg2 !== undefined) {
        if (arg1 instanceof Error) throw arg1;
        return arg2;
    }

    return arg1;
}

function read_message_stream(message_stream) {
    return new Promise((resolve, reject) => {
        if (!message_stream) return resolve(Buffer.from(''));

        const on_data = (arg1, arg2) => {
            try {
                const raw = parse_stream_data(arg1, arg2);
                if (Buffer.isBuffer(raw)) return resolve(raw);
                if (typeof raw === 'string') return resolve(Buffer.from(raw, 'binary'));
                return resolve(Buffer.from(String(raw || ''), 'utf8'));
            } catch (err) {
                return reject(err);
            }
        };

        try {
            if (typeof message_stream.get_data === 'function') {
                message_stream.get_data(on_data);
                return;
            }

            if (typeof message_stream.get_data_string === 'function') {
                message_stream.get_data_string((raw) => {
                    if (typeof raw === 'string') {
                        resolve(Buffer.from(raw, 'binary'));
                    } else {
                        resolve(Buffer.from(''));
                    }
                });
                return;
            }

            reject(new Error('message_stream does not support get_data/get_data_string'));
        } catch (err) {
            reject(err);
        }
    });
}

async function parse_mime(input, options = {}) {
    const iconv = get_iconv_constructor();
    const logger = options.logger;

    if (iconv) {
        try {
            const parsed_with_iconv = await simpleParser(input, { Iconv: iconv });
            const iconv_score = parsed_mojibake_score(parsed_with_iconv);

            if (iconv_score === 0) {
                return normalize_parsed_headers(parsed_with_iconv);
            }

            const parsed_with_iconv_lite = await simpleParser(input);
            const iconv_lite_score = parsed_mojibake_score(parsed_with_iconv_lite);

            if (iconv_lite_score < iconv_score) {
                if (logger) {
                    logger(
                        'warn',
                        `native iconv output looked mojibake-prone (score ${iconv_score}), using iconv-lite result (score ${iconv_lite_score})`
                    );
                }
                return normalize_parsed_headers(parsed_with_iconv_lite);
            }

            return normalize_parsed_headers(parsed_with_iconv);
        } catch (err) {
            if (!is_charset_decode_error(err)) throw err;
            if (logger) {
                logger('warn', `native iconv parsing failed, retrying with iconv-lite: ${err.message}`);
            }
        }
    }

    const parsed = await simpleParser(input);
    return normalize_parsed_headers(parsed);
}

module.exports = {
    parse_mime,
    read_message_stream,
    get_iconv_constructor
};
