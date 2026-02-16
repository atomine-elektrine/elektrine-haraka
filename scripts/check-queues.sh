#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="${SCRIPT_DIR}/../deployment"

if [ ! -d "$DEPLOY_DIR" ]; then
  echo "ERROR: deployment directory not found at ${DEPLOY_DIR}"
  exit 3
fi

cd "$DEPLOY_DIR"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "ERROR: docker compose or docker-compose is required"
  exit 3
fi

QUEUE_NAME="${ELEKTRINE_QUEUE_NAME:-elektrine:inbound}"
DLQ_NAME="${ELEKTRINE_DLQ_NAME:-elektrine:inbound:dlq}"
QUEUE_WARN_THRESHOLD="${QUEUE_WARN_THRESHOLD:-1000}"
DLQ_CRIT_THRESHOLD="${DLQ_CRIT_THRESHOLD:-10}"

inbound_depth=$(compose exec -T redis redis-cli LLEN "$QUEUE_NAME" | tr -d '\r')
dlq_depth=$(compose exec -T redis redis-cli LLEN "$DLQ_NAME" | tr -d '\r')

if ! [[ "$inbound_depth" =~ ^[0-9]+$ ]] || ! [[ "$dlq_depth" =~ ^[0-9]+$ ]]; then
  echo "ERROR: failed to read queue depth (inbound=${inbound_depth}, dlq=${dlq_depth})"
  exit 3
fi

echo "inbound_queue=${QUEUE_NAME} depth=${inbound_depth}"
echo "dlq_queue=${DLQ_NAME} depth=${dlq_depth}"

if [ "$dlq_depth" -ge "$DLQ_CRIT_THRESHOLD" ]; then
  echo "CRITICAL: DLQ depth ${dlq_depth} >= ${DLQ_CRIT_THRESHOLD}"
  exit 2
fi

if [ "$inbound_depth" -ge "$QUEUE_WARN_THRESHOLD" ]; then
  echo "WARNING: inbound queue depth ${inbound_depth} >= ${QUEUE_WARN_THRESHOLD}"
  exit 1
fi

echo "OK: queue depths are within thresholds"
exit 0
