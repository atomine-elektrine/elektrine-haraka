#!/bin/sh
set -eu

cleanup() {
  trap - INT TERM EXIT
  kill 0 2>/dev/null || true
}

trap cleanup INT TERM EXIT

mkdir -p /data/redis /data/caddy /app/ssl /app/logs

redis-server \
  --appendonly yes \
  --appendfsync everysec \
  --save 900 1 \
  --save 300 10 \
  --save 60 10000 \
  --dir /data/redis &

HARAKA_ROLE=outbound-relay /app/scripts/start-haraka.sh &

caddy run --config /app/docker/caddy/Caddyfile --adapter caddyfile &
/app/scripts/sync-caddy-certs.sh &

/app/scripts/configure-tls.sh || true

HARAKA_ROLE=inbound-mx /app/scripts/start-haraka.sh &
HARAKA_ROLE=submission /app/scripts/start-haraka.sh &
node /app/scripts/elektrine-worker.js &

wait -n
exit $?
