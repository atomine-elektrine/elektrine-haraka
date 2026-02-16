/**
 * Elektrine Haraka Library
 * 
 * Central export for all shared modules used by Elektrine Haraka plugins.
 */

'use strict';

module.exports = {
    config: require('./config'),
    http: require('./http-client'),
    mime: require('./mime-parser'),
    domains: require('./domains'),
    email: require('./email-builder'),
    spam: require('./spam-extractor'),
    attachments: require('./attachment-handler'),
    bounce: require('./bounce-detector'),
    text: require('./text-normalizer')
};
