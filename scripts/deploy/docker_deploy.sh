#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deployment"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.same-server.yml"
ENV_FILE="$DEPLOY_DIR/.env"

usage() {
  cat <<'EOF'
Usage: scripts/deploy/docker_deploy.sh [--env-file deployment/.env] [docker compose args...]

Deploys elektrine-haraka for the same-host Docker layout.
EOF
}

ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d redis clamav spamassassin
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d haraka-inbound haraka-submission haraka-outbound haraka-worker cert-copier

if [[ "${#ARGS[@]}" -gt 0 ]]; then
  exec docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "${ARGS[@]}"
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
