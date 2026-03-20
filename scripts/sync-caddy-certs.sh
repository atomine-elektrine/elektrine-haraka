#!/bin/sh
set -eu

DOMAIN="${HARAKA_DOMAIN:-mail.example.com}"
SSL_DIR="/app/ssl"
mkdir -p "$SSL_DIR"

find_cert_dir() {
  for base in \
    "/root/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory" \
    "/root/.local/share/caddy/certificates/acme-staging-v02.api.letsencrypt.org-directory" \
    "/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory" \
    "/data/caddy/certificates/acme-staging-v02.api.letsencrypt.org-directory"
  do
    if [ -d "$base/$DOMAIN" ]; then
      printf '%s\n' "$base/$DOMAIN"
      return 0
    fi
  done

  return 1
}

copy_if_present() {
  cert_dir="$(find_cert_dir || true)"

  if [ -n "$cert_dir" ] && [ -f "$cert_dir/$DOMAIN.crt" ] && [ -f "$cert_dir/$DOMAIN.key" ]; then
    cp "$cert_dir/$DOMAIN.crt" "$SSL_DIR/cert.crt"
    cp "$cert_dir/$DOMAIN.key" "$SSL_DIR/cert.key"
    chmod 644 "$SSL_DIR/cert.crt"
    chmod 600 "$SSL_DIR/cert.key"
    return 0
  fi

  return 1
}

while true; do
  copy_if_present || true
  sleep 15
done
