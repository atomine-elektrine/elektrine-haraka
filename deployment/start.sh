#!/bin/bash

# Start elektrine-haraka step by step
set -euo pipefail

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
    compose() { docker-compose "$@"; }
else
    echo "ERROR: docker compose or docker-compose is required"
    exit 1
fi

echo "Starting elektrine-haraka deployment..."

# Validate required environment variables from shell and/or deployment/.env
required_vars=(
    "HARAKA_DOMAIN"
    "PHOENIX_WEBHOOK_URL"
    "PHOENIX_VERIFY_URL"
    "PHOENIX_DOMAINS_URL"
)

get_var() {
    local var_name="$1"
    local value="${!var_name:-}"

    if [ -n "$value" ]; then
        printf "%s" "$value"
        return 0
    fi

    if [ -f .env ]; then
        value=$(grep -E "^${var_name}=" .env | tail -n 1 | cut -d '=' -f 2-)
        printf "%s" "$value"
        return 0
    fi

    printf ""
}

for var_name in "${required_vars[@]}"; do
    if [ -z "$(get_var "$var_name")" ]; then
        echo "ERROR: ${var_name} is required (set in shell or deployment/.env)"
        exit 1
    fi
done

if [ -z "$(get_var "PHOENIX_API_KEY")" ] && [ -z "$(get_var "HARAKA_API_KEY")" ]; then
    echo "ERROR: set PHOENIX_API_KEY (recommended) or HARAKA_API_KEY (legacy fallback)"
    exit 1
fi

if [ -z "$(get_var "HARAKA_HTTP_API_KEY")" ] && [ -z "$(get_var "HARAKA_API_KEY")" ]; then
    echo "ERROR: set HARAKA_HTTP_API_KEY (recommended) or HARAKA_API_KEY (legacy fallback)"
    exit 1
fi

# Validate compose interpolation early
compose config >/dev/null

# 1. Start supporting services first
echo "Starting Redis, ClamAV, and SpamAssassin..."
compose up -d redis clamav spamassassin

# 2. Wait for services to be ready
echo "Waiting for services to initialize..."
sleep 10

# 3. Start Haraka roles and worker
echo "Starting Haraka inbound/submission/outbound roles and worker..."
compose up -d haraka-inbound haraka-submission haraka-outbound haraka-worker

# 4. Wait for Haraka roles to be ready
sleep 5

# 5. Start Caddy (handles HTTPS/TLS automatically)
echo "Starting Caddy reverse proxy..."
compose up -d caddy

# 6. Start cert-copier (copies Caddy certs to Haraka for STARTTLS)
echo "Starting certificate copier..."
compose up -d cert-copier

# 7. Start fail2ban (skip if having issues)
echo "Starting fail2ban..."
compose up -d fail2ban || echo "WARNING: Fail2ban had issues, continuing without it"

echo ""
echo "Deployment complete!"
echo ""
echo "Services running:"
compose ps

echo ""
echo "Test your setup:"
echo "  SMTP: telnet $(hostname) 25"
echo "  Submission: telnet $(hostname) 587"
echo "  API:  curl -H 'X-API-Key: <key>' https://$(hostname)/api/v1/send"
