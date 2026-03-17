# elektrine-haraka

This repo runs Elektrine's Haraka mail stack.

It is split into separate roles so the SMTP path stays short and the webhook work happens off to the side:

- `haraka-inbound` accepts mail for local domains on port `25`.
- `haraka-submission` handles authenticated client submission on port `587`.
- `haraka-outbound` serves the internal HTTP send API and ops endpoints on port `8080`.
- `haraka-worker` pulls queued mail from Redis and posts parsed message data to Phoenix.

The normal inbound path looks like this:

1. Mail arrives at `haraka-inbound`.
2. Haraka verifies the recipient and queues the raw message in Redis.
3. `haraka-worker` reads the queue, parses the message, and sends it to Phoenix.

## Quick start

```bash
cp deployment/.env.example deployment/.env
# edit deployment/.env
cd deployment
./start.sh
```

`deployment/start.sh` checks the required environment variables first, then brings the stack up in dependency order.

If you prefer to run Compose yourself:

```bash
cd deployment
docker compose up -d
```

For local image builds, switch the Haraka services in `deployment/docker-compose.yml` from `image:` to `build: ../`, then run:

```bash
docker compose up -d --build
```

## Configuration

Set these in `deployment/.env`:

- `HARAKA_DOMAIN`
- `PHOENIX_WEBHOOK_URL`
- `PHOENIX_VERIFY_URL`
- `PHOENIX_DOMAINS_URL`
- `PHOENIX_API_KEY` or legacy `HARAKA_API_KEY`
- `HARAKA_HTTP_API_KEY` or legacy `HARAKA_API_KEY`

Common optional settings:

- `REDIS_URL` (default: `redis://redis:6379`)
- `ELEKTRINE_QUEUE_NAME` (default: `elektrine:inbound`)
- `ELEKTRINE_DLQ_NAME` (default: `elektrine:inbound:dlq`)
- `WEBHOOK_MAX_RETRIES`
- `WEBHOOK_RETRY_BASE_MS`
- `HARAKA_IMAGE` (default: `ghcr.io/atomine-elektrine/elektrine-haraka`)
- `HARAKA_IMAGE_TAG` (default: `latest`)
- `OPS_ALLOWED_CIDRS`
- `METRICS_ALLOWED_CIDRS`
- `HARAKA_TRUSTED_PROXY_CIDRS`

`deployment/.env.example` has the rest of the knobs and defaults used by the Compose stack.

## Services

- `haraka-inbound`: public MX listener on `25`
- `haraka-submission`: authenticated submission on `587`
- `haraka-outbound`: internal HTTP service on `8080`
- `haraka-worker`: Redis consumer that delivers to Phoenix
- `redis`, `clamav`, `spamassassin`, `caddy`, `cert-copier`: supporting services

## HTTP API

Caddy terminates TLS and proxies requests to `haraka-outbound`.

- `POST /api/v1/send`
- `GET /status`
- `GET /healthz`
- `GET /metrics`

`POST /api/v1/send` requires `X-API-Key: <HARAKA_HTTP_API_KEY>`.

`/status`, `/healthz`, and `/metrics` are CIDR-restricted.

## Useful commands

```bash
# from deployment/
docker compose ps

docker compose logs -f haraka-inbound
docker compose logs -f haraka-submission
docker compose logs -f haraka-outbound
docker compose logs -f haraka-worker

# queue depth
docker compose exec redis redis-cli LLEN elektrine:inbound

# dead-letter queue depth
docker compose exec redis redis-cli LLEN elektrine:inbound:dlq

# queue alarm helper
../scripts/check-queues.sh
```

## Notes

- If you change plugin or config behavior, redeploy all Haraka roles and the worker together.
- Use an immutable `HARAKA_IMAGE_TAG` for reproducible deploys.
- Plugin role profiles are documented in `docs/Plugins.md`.

## Troubleshooting

- `421` or other temporary inbound failures: check Redis and worker logs first.
- Mail is accepted but never reaches Phoenix: check worker logs and DLQ depth.
- Submission auth errors: check `auth/auth_proxy` config and the Phoenix auth endpoint.
- TLS issues: check Caddy logs and the `ssl-certs` volume.
