#!/bin/bash

# SSL Certificate Initialization Script for elektrine-haraka
# This script runs inside Docker and sets up Let's Encrypt SSL certificates

set -e

DOMAIN="${HARAKA_DOMAIN:-haraka.elektrine.com}"
EMAIL="${SSL_EMAIL:-admin@elektrine.com}"
STAGING=${STAGING:-0}

echo "🔐 Setting up SSL certificates for $DOMAIN"

# Check if certificates already exist
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "✅ SSL certificates already exist for $DOMAIN"
    exit 0
fi

echo "📋 Starting SSL certificate setup..."

# Wait for nginx to be ready
sleep 10

# Request certificate using certbot
echo "📄 Requesting SSL certificate..."
if [ "$STAGING" = "1" ]; then
    echo "⚠️  Using Let's Encrypt staging environment"
    STAGING_FLAG="--staging"
else
    STAGING_FLAG=""
fi

# Use certbot with webroot method
certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email $EMAIL \
    --agree-tos \
    --no-eff-email \
    --non-interactive \
    $STAGING_FLAG \
    -d $DOMAIN

echo "✅ SSL certificate obtained successfully!"

# Update Haraka TLS configuration to use the certificates
echo "🔧 Updating Haraka TLS configuration..."
cat > /etc/letsencrypt/haraka-tls.ini << EOF
[main]
# Let's Encrypt certificates (mounted from Docker volume)
key=/app/ssl/live/$DOMAIN/privkey.pem
cert=/app/ssl/live/$DOMAIN/fullchain.pem

# Security settings
ciphers=ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES128-SHA256
requestCert=false
rejectUnauthorized=false

# TLS versions
# secureProtocol=TLSv1_2_method
EOF

echo "🎉 SSL setup complete! Certificates ready for use."
