#!/usr/bin/env node

/**
 * Elektrine async worker.
 *
 * Consumes queued inbound RFC822 messages from Redis, parses them,
 * and delivers normalized payloads to the Phoenix webhook endpoint.
 */

'use strict';

const {
    config,
    http,
    mime,
    spam,
    attachments,
    bounce,
    text
} = require('../lib');
const queue = require('../lib/queue-client');
const telemetry = require('../lib/telemetry');

const cfg = config.load();
const logger = telemetry.create_console_logger('worker');
const queue_client = new queue.QueueClient(cfg, logger);

let shutting_down = false;
const counters = {
    consumed: 0,
    delivered: 0,
    skipped_bounce: 0,
    retried: 0,
    failed: 0,
    dlq: 0
};

function as_header_object(headers) {
    if (!(headers instanceof Map)) {
        return headers;
    }

    const out = {};
    headers.forEach((value, key) => {
        if (value === undefined || value === null) return;

        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            out[key] = typeof value === 'string' ? text.normalize_header(value) : value;
            return;
        }

        if (Array.isArray(value)) {
            out[key] = value.map((item) => String(item)).join(', ');
            return;
        }

        if (value && typeof value.text === 'string') {
            out[key] = text.normalize_header(value.text);
            return;
        }

        out[key] = String(value);
    });

    return out;
}

function build_spam_context(envelope) {
    const notes = {};
    if (envelope.spamassassin) {
        notes.spamassassin = {
            score: envelope.spamassassin.score,
            reqd: envelope.spamassassin.required,
            flag: envelope.spamassassin.flag,
            tests: envelope.spamassassin.tests
        };
    }

    return {
        transaction: { notes },
        connection: { notes: {} }
    };
}

function build_webhook_data(envelope, parsed) {
    const from_email = text.normalize_header(parsed.from ? parsed.from.text : envelope.mail_from);
    const subject = text.normalize_header(parsed.subject || '');
    const text_body = cfg.include_body ? (parsed.text || '') : '';
    const html_body = cfg.include_body ? (parsed.html || '') : '';
    const to_email = text.normalize_header(parsed.to ? parsed.to.text : (envelope.rcpt_to && envelope.rcpt_to[0]) || '');
    const rcpt_to = text.normalize_header((envelope.rcpt_to && envelope.rcpt_to[0]) || '');
    const mail_from = text.normalize_header(envelope.mail_from || '');

    const spam_context = build_spam_context(envelope);
    const spam_data = spam.extract(spam_context.connection, spam_context.transaction, parsed.headers);
    const attachment_data = attachments.extract(null, parsed, {
        include_content: cfg.include_attachments
    });

    return {
        message_id: envelope.message_id,
        from: from_email,
        to: to_email,
        rcpt_to: rcpt_to,
        mail_from: mail_from,
        subject,
        text_body,
        html_body,
        headers: cfg.include_headers ? as_header_object(parsed.headers) : undefined,
        spam_status: spam_data.status,
        spam_score: spam_data.score,
        spam_threshold: spam_data.threshold,
        spam_report: spam_data.report,
        spam_status_header: spam_data.status_header,
        attachments: attachment_data.attachments,
        attachment_count: attachment_data.count,
        has_attachments: attachment_data.has_attachments,
        size: envelope.data_bytes,
        timestamp: new Date().toISOString(),
        is_bounce: bounce.is_bounce(from_email, subject, text_body, {
            envelope_from: mail_from
        })
    };
}

async function send_webhook_with_retry(payload) {
    let attempt = 0;
    while (attempt <= cfg.webhook_max_retries) {
        try {
            await http.send_webhook(cfg.webhook_url, payload, {
                api_key: cfg.phoenix_api_key,
                timeout: cfg.webhook_timeout,
                headers: {
                    'X-Message-Id': payload.message_id,
                    'X-Idempotency-Key': payload.message_id
                },
                logger: (message) => logger.debug('http_client', { message })
            });

            return;
        } catch (err) {
            const status = err.status || null;
            const is_permanent_4xx = status >= 400 && status < 500 && status !== 429;
            const exhausted = attempt >= cfg.webhook_max_retries;

            if (is_permanent_4xx || exhausted) {
                throw err;
            }

            counters.retried += 1;
            const delay_ms = cfg.webhook_retry_base_delay_ms * Math.pow(2, attempt);
            logger.warn('webhook_retry', {
                message_id: payload.message_id,
                attempt: attempt + 1,
                status,
                delay_ms,
                message: err.message
            });

            await new Promise((resolve) => setTimeout(resolve, delay_ms));
        }

        attempt += 1;
    }
}

async function push_dlq(envelope, error) {
    const dlq_payload = {
        failed_at: new Date().toISOString(),
        message_id: envelope.message_id,
        error: {
            status: error.status || null,
            message: error.message
        },
        payload: envelope
    };

    await queue_client.enqueue_dlq(cfg.queue_dlq_name, dlq_payload);
    counters.dlq += 1;
}

async function process_message(raw_element) {
    counters.consumed += 1;

    let envelope;
    try {
        envelope = JSON.parse(raw_element);
    } catch (err) {
        counters.failed += 1;
        logger.error('invalid_queue_payload', { message: err.message });
        return;
    }

    try {
        const raw_buffer = Buffer.from(envelope.raw_rfc822_base64 || '', 'base64');
        const parsed = await mime.parse_mime(raw_buffer, {
            logger: (level, message) => {
                if (level === 'warn') logger.warn('mime_parse_fallback', { message });
            }
        });
        const webhook_payload = build_webhook_data(envelope, parsed);

        if (webhook_payload.is_bounce) {
            counters.skipped_bounce += 1;
            logger.info('skip_bounce', {
                message_id: webhook_payload.message_id,
                subject: webhook_payload.subject
            });
            return;
        }

        await send_webhook_with_retry(webhook_payload);
        counters.delivered += 1;
        logger.info('webhook_delivered', {
            message_id: webhook_payload.message_id,
            rcpt_to: webhook_payload.rcpt_to,
            attachment_count: webhook_payload.attachment_count
        });
    } catch (err) {
        counters.failed += 1;
        logger.error('process_failed', {
            message_id: envelope.message_id,
            status: err.status || null,
            message: err.message
        });

        try {
            await push_dlq(envelope, err);
        } catch (dlq_err) {
            logger.error('dlq_write_failed', {
                message_id: envelope.message_id,
                message: dlq_err.message
            });
        }
    }
}

async function run() {
    if (!cfg.phoenix_api_key || !cfg.webhook_url) {
        logger.error('missing_required_config', {
            has_api_key: Boolean(cfg.phoenix_api_key),
            webhook_url: cfg.webhook_url || null
        });
        process.exit(1);
    }

    logger.info('worker_start', {
        queue_name: cfg.queue_name,
        dlq_name: cfg.queue_dlq_name,
        redis_url: cfg.redis_url,
        webhook_url: cfg.webhook_url,
        max_retries: cfg.webhook_max_retries
    });

    setInterval(() => {
        logger.info('worker_stats', { ...counters });
    }, 60000);

    while (!shutting_down) {
        try {
            const raw_element = await queue_client.pop(cfg.queue_name, cfg.queue_pop_timeout_sec);
            if (!raw_element) continue;
            await process_message(raw_element);
        } catch (err) {
            logger.error('worker_loop_error', { message: err.message });
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    await queue_client.close();
    logger.info('worker_stop');
}

function start_shutdown(signal) {
    if (shutting_down) return;
    shutting_down = true;
    logger.warn('shutdown_signal', { signal });
}

process.on('SIGTERM', () => start_shutdown('SIGTERM'));
process.on('SIGINT', () => start_shutdown('SIGINT'));

run().catch((err) => {
    logger.error('worker_fatal', { message: err.message, stack: err.stack });
    process.exit(1);
});
