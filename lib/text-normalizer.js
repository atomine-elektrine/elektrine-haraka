/**
 * Header text normalization helpers.
 *
 * Fixes common mojibake where UTF-8 bytes were interpreted as Latin-1.
 */

'use strict';

function has_c1_controls(value) {
    return /[\u0080-\u009F]/.test(value);
}

function count_mojibake_utf8_latin1_pairs(value) {
    let count = 0;
    for (let i = 0; i < value.length - 1; i += 1) {
        const a = value.charCodeAt(i);
        const b = value.charCodeAt(i + 1);
        // Pattern of UTF-8 byte sequences misread as Latin-1 code points.
        if (a >= 0x00C2 && a <= 0x00F4 && b >= 0x0080 && b <= 0x00BF) {
            count += 1;
        }
    }
    return count;
}

function try_repair_utf8_latin1_mojibake(value) {
    if (typeof value !== 'string' || value.length === 0) return value;

    const cps = Array.from(value, (char) => char.codePointAt(0));
    if (cps.some((cp) => cp > 0xFF)) {
        return value;
    }

    const repaired = Buffer.from(cps).toString('utf8');
    if (!repaired || repaired.includes('\uFFFD')) {
        return value;
    }

    const before_controls = has_c1_controls(value);
    const after_controls = has_c1_controls(repaired);
    const before_pairs = count_mojibake_utf8_latin1_pairs(value);
    const after_pairs = count_mojibake_utf8_latin1_pairs(repaired);

    if (before_controls && !after_controls) {
        return repaired;
    }

    if (before_pairs > 0 && after_pairs < before_pairs) {
        return repaired;
    }

    return value;
}

function normalize_header(value) {
    if (typeof value !== 'string') return value;
    return try_repair_utf8_latin1_mojibake(value);
}

module.exports = {
    normalize_header,
    try_repair_utf8_latin1_mojibake
};
