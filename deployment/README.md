# Deployment

Compose-based production deployment for the multi-role Haraka topology. This is
the supported deployment path for this repository.

## Services

- `haraka-inbound`: public MX listener on `:25`
- `haraka-outbound`: internal HTTP send/ops API on `:8080`
- `haraka-worker`: Redis consumer for inbound delivery to Phoenix
- `haraka-submission`: optional authenticated submission role, not published by default
- `redis`, `clamav`, `spamassassin`

## Setup

```bash
cd deployment
cp .env.example .env
# edit .env
./start.sh
```

## Same-server setup

For a single-host deployment beside the main Elektrine stack:

```bash
cp .env.same-server.example .env
# edit .env
../scripts/deploy/docker_deploy.sh
```

This uses `docker-compose.same-server.yml`, publishes MX on `25`, binds the
Haraka HTTP API to `127.0.0.1:18080`, and reads certificates from the main
Elektrine Caddy volume. It also joins the main Elektrine Docker network so
Haraka can call `http://elektrine_app:8080` directly.

## Useful Commands

```bash
# inspect all services
docker compose ps

# view role logs
docker compose logs -f haraka-inbound
docker compose logs -f haraka-submission
docker compose logs -f haraka-outbound
docker compose logs -f haraka-worker

# queue state
docker compose exec redis redis-cli LLEN elektrine:inbound
docker compose exec redis redis-cli LLEN elektrine:inbound:dlq

# queue alert check (non-zero exit when thresholds exceeded)
../scripts/check-queues.sh

# health checks from the host running Haraka
curl -s -H 'X-API-Key: <key>' http://127.0.0.1:18080/status
curl -s -H 'X-API-Key: <key>' http://127.0.0.1:18080/metrics
```

## Notes

- Elektrine should call the HTTP API through `HARAKA_BASE_URL`, commonly `http://127.0.0.1:18080` on same-host installs or `http://haraka-outbound:8080` on a shared Docker network.
- SMTP HTTP API traffic is served directly by `haraka-outbound:8080` inside Compose.
- Inbound SMTP processing is async: accept fast on `haraka-inbound`, parse/deliver from `haraka-worker`.
- Client SMTP submission normally lives in Elektrine. Publish `haraka-submission` only if you intentionally want Haraka-managed submission.
- `/status`, `/healthz`, and `/metrics` accept `X-API-Key` by default.
- Set `OPS_ALLOWED_CIDRS` and `METRICS_ALLOWED_CIDRS` in `.env` only if you also want keyless access from trusted networks.
- Use immutable `HARAKA_IMAGE_TAG` values for reproducible rollouts.
- Override `HARAKA_IMAGE` in `.env` if you need to pull from a different registry/repo.
