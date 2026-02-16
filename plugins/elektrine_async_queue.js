/**
 * Elektrine Async Queue Plugin
 *
 * Keeps SMTP transactions fast by enqueueing inbound messages to Redis,
 * then acknowledging the SMTP queue hook immediately.
 */

'use strict';

const crypto = require('crypto');
const constants = require('haraka-constants');

const {
    config,
    domains
} = require('../lib');
const queue_lib = require('../lib/queue-client');
const telemetry = require('../lib/telemetry');

function parse_stream_data(arg1, arg2) {
    if (arg2 !== undefined) {
        if (arg1 instanceof Error) throw arg1;
        return arg2;
    }

    return arg1;
}

function read_transaction_raw(transaction) {
    return new Promise((resolve, reject) => {
        const message_stream = transaction && transaction.message_stream;
        if (!message_stream) {
            return resolve(Buffer.from(''));
        }

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

            reject(new Error('transaction.message_stream does not support get_data')); // eslint-disable-line max-len
        } catch (err) {
            reject(err);
        }
    });
}

function transaction_spam_notes(transaction) {
    const notes = transaction && transaction.notes ? transaction.notes : {};
    const spamassassin = notes.spamassassin || null;

    if (!spamassassin || typeof spamassassin !== 'object') return null;

    return {
        score: spamassassin.score !== undefined ? spamassassin.score : null,
        required: spamassassin.reqd !== undefined ? spamassassin.reqd : null,
        flag: spamassassin.flag !== undefined ? spamassassin.flag : null,
        tests: spamassassin.tests || null
    };
}

exports.register = function () {
    this.load_config();
    this.logger = telemetry.create_plugin_logger(this, 'async_queue');
    this.queue_client = new queue_lib.QueueClient(this.cfg, this.logger);

    domains.init((msg) => this.logger.info('domains_init', { message: msg }))
        .then(() => {
            this.logger.info('domains_cache_ready');
        })
        .catch((err) => {
            this.logger.warn('domains_cache_init_failed', { message: err.message });
        });

    this.register_hook('queue', 'enqueue_inbound_message');
};

exports.load_config = function () {
    const haraka_cfg = this.config.get('elektrine_queue.ini', {
        booleans: ['+main.enabled', '+main.include_headers', '+main.include_body', '+main.include_attachments']
    }, () => {
        this.load_config();
    });

    this.cfg = config.load(haraka_cfg);
};

exports.enqueue_inbound_message = function (next, connection) {
    const plugin = this;
    const transaction = connection.transaction;

    if (!plugin.cfg.webhook_enabled) {
        plugin.logger.warn('queue_disabled');
        return next(constants.DENYSOFT, 'Inbound processing is temporarily disabled');
    }

    if (!transaction) {
        return next(constants.OK, 'No transaction to enqueue');
    }

    const rcpt_to = transaction.rcpt_to.map((rcpt) => rcpt.address());
    const has_local_recipient = transaction.rcpt_to.some((rcpt) => domains.is_local_domain(rcpt.host));

    if (!has_local_recipient) {
        plugin.logger.warn('non_local_recipient_in_inbound_profile', {
            transaction_id: transaction.uuid,
            recipients: rcpt_to
        });
        return next(constants.DENY, 'Inbound role only accepts local recipients');
    }

    read_transaction_raw(transaction)
        .then((raw_buffer) => {
            if (raw_buffer.length > plugin.cfg.queue_max_raw_bytes) {
                throw new Error(`Message exceeds queue_max_raw_bytes (${raw_buffer.length} > ${plugin.cfg.queue_max_raw_bytes})`); // eslint-disable-line max-len
            }

            const message_id = transaction.uuid || crypto.randomUUID();
            const payload = {
                schema_version: 1,
                message_id,
                enqueued_at: new Date().toISOString(),
                mail_from: transaction.mail_from ? transaction.mail_from.address() : '',
                rcpt_to,
                data_bytes: transaction.data_bytes || raw_buffer.length,
                remote: {
                    ip: connection.remote && connection.remote.ip,
                    host: connection.remote && connection.remote.host,
                    info: connection.remote && connection.remote.info
                },
                hello: connection.hello ? {
                    host: connection.hello.host,
                    verb: connection.hello.verb
                } : null,
                tls: Boolean(connection.tls),
                spamassassin: transaction_spam_notes(transaction),
                raw_rfc822_base64: raw_buffer.toString('base64')
            };

            return plugin.queue_client.enqueue(plugin.cfg.queue_name, payload)
                .then(() => {
                    plugin.logger.info('message_enqueued', {
                        transaction_id: transaction.uuid,
                        message_id,
                        rcpt_count: rcpt_to.length,
                        bytes: payload.data_bytes,
                        queue: plugin.cfg.queue_name
                    });

                    return next(constants.OK, 'Queued for async processing');
                });
        })
        .catch((err) => {
            plugin.logger.error('enqueue_failed', {
                transaction_id: transaction.uuid,
                message: err.message
            });

            return next(constants.DENYSOFT, 'Temporary queueing failure, please retry');
        });
};
