/**
 * Elektrine Local MX Routing Plugin
 *
 * Routes local/protected domains to the internal inbound service instead of
 * external/public MX records. This keeps local delivery on the
 * inbound -> queue -> worker -> Phoenix path.
 */

'use strict';

const constants = require('haraka-constants');
const { domains } = require('../lib');

const DEFAULTS = {
    enabled: true,
    host: 'haraka-inbound',
    port: 25
};

function to_int(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

exports.register = function () {
    this.load_config();
    this.register_hook('get_mx', 'route_local_mx');

    domains.init((msg) => this.logdebug(`domains: ${msg}`))
        .catch((err) => {
            this.logwarn(`Domain cache init failed: ${err.message}`);
        });

    if (this.cfg.enabled) {
        this.loginfo(`Local MX routing enabled -> ${this.cfg.host}:${this.cfg.port}`);
    } else {
        this.loginfo('Local MX routing disabled');
    }
};

exports.load_config = function () {
    const plugin = this;
    const cfg = this.config.get('elektrine_local_mx.ini', {
        booleans: ['+main.enabled']
    }, () => {
        plugin.load_config();
    });

    const main = (cfg && cfg.main) ? cfg.main : {};

    this.cfg = {
        enabled: main.enabled !== undefined ? main.enabled : DEFAULTS.enabled,
        host: main.host || DEFAULTS.host,
        port: to_int(main.port, DEFAULTS.port)
    };

    if (process.env.ELEKTRINE_LOCAL_MX_HOST) {
        this.cfg.host = process.env.ELEKTRINE_LOCAL_MX_HOST;
    }
    if (process.env.ELEKTRINE_LOCAL_MX_PORT) {
        this.cfg.port = to_int(process.env.ELEKTRINE_LOCAL_MX_PORT, this.cfg.port);
    }
};

exports.route_local_mx = function (next, hmail, domain) {
    if (!this.cfg.enabled) return next();

    const recipient_domain = String(domain || '').toLowerCase();
    if (!recipient_domain) return next();

    if (!domains.is_local_domain(recipient_domain)) return next();

    this.loginfo(`Routing local domain ${recipient_domain} to ${this.cfg.host}:${this.cfg.port}`);
    return next(constants.OK, {
        priority: 0,
        exchange: this.cfg.host,
        port: this.cfg.port
    });
};
