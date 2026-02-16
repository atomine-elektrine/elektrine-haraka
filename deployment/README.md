# Deployment

Compose-based production deployment for the multi-role Haraka topology.

## Services

- `haraka-inbound` (`:25`)
- `haraka-submission` (`:587`)
- `haraka-outbound` (internal `:8080` API)
- `haraka-worker` (Redis consumer)
- `redis`, `clamav`, `spamassassin`, `caddy`, `cert-copier`, `fail2ban`

## Setup

```bash
cd deployment
cp .env.example .env
# edit .env
./start.sh
```

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

# health checks
curl -s https://your-domain/status
curl -s https://your-domain/metrics
```

## Notes

- SMTP API traffic is terminated by Caddy and proxied to `haraka-outbound:8080`.
- Inbound SMTP processing is async: accept fast on `haraka-inbound`, parse/deliver from `haraka-worker`.
- Submission uses native Haraka outbound delivery (no smarthost file required).
- `/status`, `/healthz`, and `/metrics` are CIDR-restricted by Caddy (configure in `.env`).
- Use immutable `HARAKA_IMAGE_TAG` values for reproducible rollouts.
