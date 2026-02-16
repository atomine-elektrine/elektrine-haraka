/**
 * Minimal structured telemetry helper.
 */

'use strict';

function compact(fields) {
    const out = {};
    Object.entries(fields || {}).forEach(([key, value]) => {
        if (value !== undefined) out[key] = value;
    });
    return out;
}

function emit(log_fn, level, scope, event, fields = {}) {
    const payload = compact({
        ts: new Date().toISOString(),
        level,
        scope,
        event,
        ...fields
    });

    const line = JSON.stringify(payload);
    log_fn(line);
}

function create_plugin_logger(plugin, scope) {
    return {
        info(event, fields) {
            emit((line) => plugin.loginfo(line), 'info', scope, event, fields);
        },
        warn(event, fields) {
            emit((line) => plugin.logwarn(line), 'warn', scope, event, fields);
        },
        error(event, fields) {
            emit((line) => plugin.logerror(line), 'error', scope, event, fields);
        },
        debug(event, fields) {
            emit((line) => plugin.logdebug(line), 'debug', scope, event, fields);
        }
    };
}

function create_console_logger(scope) {
    return {
        info(event, fields) {
            emit((line) => console.log(line), 'info', scope, event, fields);
        },
        warn(event, fields) {
            emit((line) => console.warn(line), 'warn', scope, event, fields);
        },
        error(event, fields) {
            emit((line) => console.error(line), 'error', scope, event, fields);
        },
        debug(event, fields) {
            emit((line) => console.debug(line), 'debug', scope, event, fields);
        }
    };
}

module.exports = {
    create_plugin_logger,
    create_console_logger
};
