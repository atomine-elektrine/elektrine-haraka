#!/bin/bash

# elektrine-haraka Setup Script
set -e

cd "$(dirname "$0")/../deployment"

echo "=== elektrine-haraka Setup ==="

# Check if .env file exists, if not create a template
if [ ! -f .env ]; then
    echo "Creating .env file template..."
    cat > .env << EOF_INNER
HARAKA_DOMAIN=your-domain.com
PHOENIX_API_KEY=your-haraka-to-phoenix-key
HARAKA_HTTP_API_KEY=your-phoenix-to-haraka-key
PHOENIX_WEBHOOK_URL=https://your-app.com/api/haraka/inbound
PHOENIX_VERIFY_URL=https://your-app.com/api/haraka/verify-recipient
PHOENIX_DOMAINS_URL=https://your-app.com/api/haraka/domains
REDIS_URL=redis://redis:6379
ELEKTRINE_QUEUE_NAME=elektrine:inbound
ELEKTRINE_DLQ_NAME=elektrine:inbound:dlq
EOF_INNER
    echo ""
    echo "Please edit .env file with your actual values:"
    echo "   - HARAKA_DOMAIN: Your email server domain"
    echo "   - PHOENIX_API_KEY: Key used by Haraka to call Phoenix endpoints"
    echo "   - HARAKA_HTTP_API_KEY: Key required by Haraka HTTP API for send calls"
    echo "   - PHOENIX_WEBHOOK_URL: Your Phoenix app webhook endpoint"
    echo "   - PHOENIX_VERIFY_URL: Recipient verification endpoint"
    echo "   - PHOENIX_DOMAINS_URL: Domain cache endpoint"
    echo ""
    echo "Then run this script again."
    exit 0
fi

echo "Starting elektrine-haraka services..."
docker compose up -d

echo "Services starting up..."
sleep 5

echo "Setup complete!"
echo ""
echo "Your email server is running at: https://$(grep HARAKA_DOMAIN .env | cut -d= -f2)"
echo "Status endpoint: https://$(grep HARAKA_DOMAIN .env | cut -d= -f2)/status"
echo ""
echo "Useful commands:"
echo "   docker compose logs -f haraka-inbound     # View inbound logs"
echo "   docker compose logs -f haraka-submission  # View submission logs"
echo "   docker compose logs -f haraka-outbound    # View outbound API logs"
echo "   docker compose logs -f haraka-worker      # View worker logs"
echo "   docker compose logs -f caddy     # View Caddy logs"
echo "   docker compose ps                # Check service status"
echo "   docker compose down              # Stop all services"
