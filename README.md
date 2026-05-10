# elektrine-haraka

Haraka mail relay for Elektrine.

Elektrine owns mailbox storage, webmail, IMAP/POP3/JMAP, user authentication,
and the Phoenix API endpoints. This repo owns the Haraka side: public MX intake,
inbound queueing, outbound internet delivery, DKIM signing, and the internal HTTP
send API Elektrine calls for external mail.

Docker Compose is the supported deployment path.

## Architecture

The stack is split into small roles:

- `haraka-inbound`: public MX listener on port `25`.
- `haraka-outbound`: internal HTTP send and ops API on port `8080`.
- `haraka-worker`: Redis consumer that parses inbound mail and posts it to Phoenix.
- `haraka-submission`: optional Haraka-managed SMTP submission role, not published by default.
- `redis`, `clamav`, `spamassassin`: supporting services for queueing and scanning.

Normal inbound path:

1. Remote mail arrives at `haraka-inbound` on port `25`.
2. Haraka verifies recipients against Phoenix.
3. Haraka queues the raw RFC 5322 message in Redis.
4. `haraka-worker` parses the queued message and posts it to Phoenix.
5. Elektrine stores and displays the message.

Normal outbound path from Elektrine:

1. Elektrine accepts mail from webmail, SMTP submission, or another Elektrine mail interface.
2. Elektrine calls `haraka-outbound` at `POST /api/v1/send`.
3. Haraka builds or accepts the RFC 5322 message.
4. Haraka signs with DKIM and queues outbound SMTP delivery.

Client SMTP submission usually lives in Elektrine. Only publish
`haraka-submission` if you explicitly want Haraka to handle authenticated client
submission.

## Quick Start

```bash
cp deployment/.env.example deployment/.env
# edit deployment/.env
cd deployment
./start.sh
```

For manual Compose control:

```bash
cd deployment
docker compose up -d
```

For local image builds, change the Haraka services in
`deployment/docker-compose.yml` from `image:` to `build: ../`, then run:

```bash
docker compose up -d --build
```

## Same-Host Deploy

When Elektrine and Haraka run on the same host, use the same-server deployment:

```bash
cp deployment/.env.same-server.example deployment/.env
# edit deployment/.env
scripts/deploy/docker_deploy.sh
```

This mode:

- publishes public MX SMTP on port `25`.
- binds Haraka's HTTP API to `127.0.0.1:18080`.
- joins the main Elektrine Docker network so Haraka can call Phoenix directly.
- copies TLS certificates from the main Elektrine Caddy volume.
- avoids running a second public `80/443` reverse proxy.

Configure Elektrine with a matching Haraka URL, commonly:

```dotenv
HARAKA_BASE_URL=http://127.0.0.1:18080
```

If both containers share a Docker network, use the service URL instead:

```dotenv
HARAKA_BASE_URL=http://haraka-outbound:8080
```

## Configuration

Required environment values:

- `HARAKA_DOMAIN`: mail host name, for example `mail.example.com`.
- `PHOENIX_WEBHOOK_URL`: inbound webhook endpoint.
- `PHOENIX_VERIFY_URL`: recipient verification endpoint.
- `PHOENIX_DOMAINS_URL`: local-domain cache endpoint.
- `PHOENIX_API_KEY`: key Haraka uses when calling Phoenix.
- `HARAKA_HTTP_API_KEY`: key Elektrine uses when calling Haraka.

Legacy fallback:

- `HARAKA_API_KEY`: accepted as a shared fallback when directional keys are not set.

Common optional values:

- `REDIS_URL`, default `redis://redis:6379`.
- `ELEKTRINE_QUEUE_NAME`, default `elektrine:inbound`.
- `ELEKTRINE_DLQ_NAME`, default `elektrine:inbound:dlq`.
- `WEBHOOK_MAX_RETRIES`.
- `WEBHOOK_RETRY_BASE_MS`.
- `HARAKA_IMAGE`.
- `HARAKA_IMAGE_TAG`.
- `OPS_ALLOWED_CIDRS`.
- `METRICS_ALLOWED_CIDRS`.
- `HARAKA_TRUSTED_PROXY_CIDRS`.

See `deployment/.env.example` and `deployment/.env.same-server.example` for
the deployment templates.

## HTTP API

The HTTP API is served by `haraka-outbound` on port `8080`.

Endpoints:

- `POST /api/v1/send`
- `GET /status`
- `GET /healthz`
- `GET /metrics`

`POST /api/v1/send` requires `X-API-Key: <HARAKA_HTTP_API_KEY>`.

Structured send payload:

```json
{
  "from": "sender@example.com",
  "to": "recipient@example.net",
  "subject": "Hello",
  "text_body": "Plain text body",
  "html_body": "<p>HTML body</p>"
}
```

Required fields for structured mail:

- `from`
- `to`
- `subject`

Accepted plain-text body fields:

- `text_body`
- `text`
- `body`

Accepted HTML body fields:

- `html_body`
- `html`

When text and HTML are both present, Haraka builds a `multipart/alternative`
message. Attachments use the `attachments` array with base64 data.

For prebuilt RFC 5322 messages, send `raw_base64` plus `from` and `to`. Prefer
structured fields unless you intentionally need to preserve a supplied MIME tree.

Ops endpoints accept `X-API-Key` by default. `OPS_ALLOWED_CIDRS` and
`METRICS_ALLOWED_CIDRS` can allow keyless access from trusted networks.

## Useful Commands

```bash
# from deployment/
docker compose ps

docker compose logs -f haraka-inbound
docker compose logs -f haraka-outbound
docker compose logs -f haraka-worker
docker compose logs -f haraka-submission

# queue depth
docker compose exec redis redis-cli LLEN elektrine:inbound

# dead-letter queue depth
docker compose exec redis redis-cli LLEN elektrine:inbound:dlq

# queue alarm helper
../scripts/check-queues.sh

# local API checks
curl -s -H 'X-API-Key: <key>' http://127.0.0.1:18080/status
curl -s -H 'X-API-Key: <key>' http://127.0.0.1:18080/metrics
```

## DKIM

DKIM keys live under `config/dkim/<domain>/` and are normalized at container
start. Use the helper when provisioning a local key:

```bash
scripts/generate-dkim-keys.sh example.com
```

Publish the generated DNS record before relying on outbound delivery for that
domain.

## Troubleshooting

- `421` or other temporary inbound failures: check Redis, `haraka-inbound`, and `haraka-worker` logs.
- Mail is accepted but never reaches Elektrine: check worker logs and `elektrine:inbound:dlq` depth.
- Outbound mail has an empty body: check the `POST /api/v1/send` payload contains `text_body`, `text`, `body`, `html_body`, or `html`; then check `haraka-outbound` logs.
- Outbound delivery is rejected for authentication: verify `HARAKA_HTTP_API_KEY` matches Elektrine's Haraka API key.
- Recipient verification fails: verify `PHOENIX_VERIFY_URL`, `PHOENIX_DOMAINS_URL`, and `PHOENIX_API_KEY`.
- TLS issues: check the `ssl-certs` volume and same-server certificate copier logs.

## Notes

- Redeploy all Haraka roles and the worker together after plugin or shared library changes.
- Use immutable `HARAKA_IMAGE_TAG` values for reproducible deploys.
- Plugin role profiles are documented in `docs/Plugins.md`.
