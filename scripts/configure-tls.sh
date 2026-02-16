#!/bin/bash

# Configure Haraka TLS with Caddy certificates
set -e

DOMAIN=${HARAKA_DOMAIN:-haraka.elektrine.com}
CERT_PATH="/app/ssl/cert.crt"
KEY_PATH="/app/ssl/cert.key"

echo "Setting up TLS for $DOMAIN"

# Wait for certificates
echo "Waiting for SSL certificates..."
timeout=300
elapsed=0
until [ -f "$CERT_PATH" ] && [ -f "$KEY_PATH" ]; do
    if [ $elapsed -ge $timeout ]; then
        echo "Timeout - running without SMTP TLS"
        exit 0
    fi
    echo "Still waiting... ($elapsed/${timeout}s)"
    sleep 5
    elapsed=$((elapsed + 5))
done

echo "Certificates found, updating TLS config..."

# Write TLS config
cat > /app/config/tls.ini << EOF
[main]
key=$KEY_PATH
cert=$CERT_PATH

ciphers=ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA:ECDHE-RSA-AES128-SHA:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256
requestCert=false
rejectUnauthorized=false
EOF

echo "TLS configured - SMTP encryption enabled"