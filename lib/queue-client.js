/**
 * Redis-backed queue helper for async inbound processing.
 */

'use strict';

const { createClient } = require('redis');

class QueueClient {
    constructor(cfg, logger) {
        this.cfg = cfg;
        this.logger = logger;
        this.client = null;
        this.connecting = null;
    }

    async connect() {
        if (this.client && this.client.isReady) return;
        if (this.connecting) return this.connecting;

        this.client = createClient({ url: this.cfg.redis_url });

        this.client.on('error', (err) => {
            this.logger.error('redis_client_error', { message: err.message });
        });

        this.client.on('reconnecting', () => {
            this.logger.warn('redis_reconnecting');
        });

        this.connecting = this.client.connect()
            .then(() => {
                this.logger.info('redis_connected', { redis_url: this.cfg.redis_url });
            })
            .finally(() => {
                this.connecting = null;
            });

        return this.connecting;
    }

    async enqueue(queue_name, payload) {
        await this.connect();
        await this.client.lPush(queue_name, JSON.stringify(payload));
    }

    async pop(queue_name, timeout_sec) {
        await this.connect();
        const result = await this.client.brPop(queue_name, timeout_sec);
        if (!result) return null;
        return result.element;
    }

    async enqueue_dlq(queue_name, payload) {
        await this.enqueue(queue_name, payload);
    }

    async close() {
        if (this.client && this.client.isOpen) {
            await this.client.quit();
        }
    }
}

module.exports = {
    QueueClient
};
