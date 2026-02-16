# elektrine-haraka

This repository runs Elektrine's mail stack.

In plain terms: SMTP comes in, gets checked, gets queued, and a worker posts clean message data to Phoenix. It is split into small services so delivery stays fast and failures are easier to debug.

## Services

- `haraka-inbound` (`25`): accepts inbound mail for local domains.
- `haraka-submission` (`587`): authenticated client submission.
- `haraka-outbound` (internal `8080`): HTTP send API plus health/metrics.
- `haraka-worker`: reads Redis queue and posts to Phoenix.
- Support services: `redis`, `clamav`, `spamassassin`, `caddy`, `cert-copier`, `fail2ban`.

## Quick start

```bash
cp deployment/.env.example deployment/.env
# edit deployment/.env
cd deployment
docker compose pull
docker compose up -d
```

For local image builds, edit `deployment/docker-compose.yml` and switch Haraka services from `image:` to `build: ../`, then run:

```bash
docker compose up -d --build
```

## Required environment variables

Set these in `deployment/.env`:

- `PHOENIX_API_KEY`
- `HARAKA_HTTP_API_KEY`
- `HARAKA_DOMAIN`
- `PHOENIX_WEBHOOK_URL`
- `PHOENIX_VERIFY_URL`
- `PHOENIX_DOMAINS_URL`

Optional but useful:

- `REDIS_URL` (default: `redis://redis:6379`)
- `ELEKTRINE_QUEUE_NAME` (default: `elektrine:inbound`)
- `ELEKTRINE_DLQ_NAME` (default: `elektrine:inbound:dlq`)
- `WEBHOOK_MAX_RETRIES`
- `WEBHOOK_RETRY_BASE_MS`
- `OPS_ALLOWED_CIDRS`
- `METRICS_ALLOWED_CIDRS`
- `HARAKA_TRUSTED_PROXY_CIDRS`

Notes:

- `HARAKA_API_KEY` still works as a fallback key for both directions, but separate keys are recommended.
- Set `HARAKA_IMAGE_TAG` to an immutable tag (for example a commit SHA) for reproducible deploys.

## API

Served through Caddy over HTTPS:

- `POST /api/v1/send`
- `GET /status`
- `GET /healthz`
- `GET /metrics`

Authentication:

- `POST /api/v1/send` requires `X-API-Key: <HARAKA_HTTP_API_KEY>`.
- `/status`, `/healthz`, and `/metrics` are CIDR-restricted in both Caddy and the Haraka API plugin.

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

## Deployment

CI/CD workflow:

- `.github/workflows/ci-build-publish-deploy.yml`

If you change plugin or config behavior, deploy all Haraka roles plus the worker together.

## Troubleshooting

- `421` or temporary inbound failures: check Redis and worker logs.
- Mail accepted but not reaching Phoenix: check worker logs and DLQ depth.
- Submission auth errors: check `auth/auth_proxy` config and Phoenix auth endpoint.
- TLS issues: check Caddy logs and the `ssl-certs` volume.
