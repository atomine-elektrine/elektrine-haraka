#!/bin/sh
set -eu

ROLE="${HARAKA_ROLE:-inbound-mx}"
SOURCE_CONFIG_DIR="/app/config"
SOURCE_PLUGINS_DIR="/app/plugins"
SOURCE_LIB_DIR="/app/lib"
SOURCE_NODE_MODULES_DIR="/app/node_modules"
RUNTIME_ROOT_DIR="/tmp/haraka-config-${ROLE}"
RUNTIME_CONFIG_DIR="$RUNTIME_ROOT_DIR/config"
RUNTIME_PLUGINS_DIR="$RUNTIME_ROOT_DIR/plugins"
RUNTIME_LIB_DIR="$RUNTIME_ROOT_DIR/lib"
RUNTIME_NODE_MODULES_DIR="$RUNTIME_ROOT_DIR/node_modules"
PERSISTENT_DKIM_DIR="${HARAKA_DKIM_DIR:-}"

rm -rf "$RUNTIME_ROOT_DIR"
mkdir -p "$RUNTIME_CONFIG_DIR"
cp -R "$SOURCE_CONFIG_DIR"/. "$RUNTIME_CONFIG_DIR"/

escape_sed() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

HARAKA_DOMAIN_VALUE="${HARAKA_DOMAIN:-mail.example.com}"
PHOENIX_WEBHOOK_URL_VALUE="${PHOENIX_WEBHOOK_URL:-}"
PHOENIX_VERIFY_URL_VALUE="${PHOENIX_VERIFY_URL:-}"
PHOENIX_DOMAINS_URL_VALUE="${PHOENIX_DOMAINS_URL:-}"

sed -i "s/example\.com/$(escape_sed "$HARAKA_DOMAIN_VALUE")/g" "$RUNTIME_CONFIG_DIR/elektrine.ini"
sed -i "s/app\.example\.com/host.docker.internal/g" "$RUNTIME_CONFIG_DIR/auth_proxy.ini"

if [ -n "$PHOENIX_WEBHOOK_URL_VALUE" ]; then
  sed -i "s#https://app\.example\.com/api/haraka/inbound#$(escape_sed "$PHOENIX_WEBHOOK_URL_VALUE")#g" "$RUNTIME_CONFIG_DIR/elektrine.ini"
fi

if [ -n "$PHOENIX_VERIFY_URL_VALUE" ]; then
  sed -i "s#https://app\.example\.com/api/haraka/verify-recipient#$(escape_sed "$PHOENIX_VERIFY_URL_VALUE")#g" "$RUNTIME_CONFIG_DIR/elektrine.ini"
fi

if [ -n "$PHOENIX_DOMAINS_URL_VALUE" ]; then
  sed -i "s#https://app\.example\.com/api/haraka/domains#$(escape_sed "$PHOENIX_DOMAINS_URL_VALUE")#g" "$RUNTIME_CONFIG_DIR/elektrine.ini"
fi

printf '%s\n' "$HARAKA_DOMAIN_VALUE" > "$RUNTIME_CONFIG_DIR/host_list"

if [ -n "$PERSISTENT_DKIM_DIR" ]; then
  mkdir -p "$PERSISTENT_DKIM_DIR"
  if [ -d "$SOURCE_CONFIG_DIR/dkim" ] && [ -z "$(ls -A "$PERSISTENT_DKIM_DIR" 2>/dev/null)" ]; then
    cp -R "$SOURCE_CONFIG_DIR"/dkim/. "$PERSISTENT_DKIM_DIR"/
  fi
  rm -rf "$RUNTIME_CONFIG_DIR/dkim"
  ln -s "$PERSISTENT_DKIM_DIR" "$RUNTIME_CONFIG_DIR/dkim"
fi

if [ -d "$RUNTIME_CONFIG_DIR/dkim" ]; then
  for key_file in "$RUNTIME_CONFIG_DIR"/dkim/*.key; do
    [ -f "$key_file" ] || break
    domain="$(basename "$key_file" .key)"
    domain_dir="$RUNTIME_CONFIG_DIR/dkim/$domain"
    mkdir -p "$domain_dir"
    cp "$key_file" "$domain_dir/private"
    if [ ! -f "$domain_dir/selector" ]; then
      printf 'default\n' > "$domain_dir/selector"
    fi
  done

  find "$RUNTIME_CONFIG_DIR/dkim" -mindepth 1 -maxdepth 1 -type d -exec chmod 755 {} +
  find "$RUNTIME_CONFIG_DIR/dkim" -type f -name private -exec chmod 644 {} +
  find "$RUNTIME_CONFIG_DIR/dkim" -type f -name selector -exec chmod 644 {} +
fi

# Haraka resolves custom plugins and local requires relative to the runtime root
# passed with `-c`. Link shared code/dependencies there so local plugins load.
ln -s "$SOURCE_PLUGINS_DIR" "$RUNTIME_PLUGINS_DIR"
ln -s "$SOURCE_LIB_DIR" "$RUNTIME_LIB_DIR"
if [ -d "$SOURCE_NODE_MODULES_DIR" ]; then
  ln -s "$SOURCE_NODE_MODULES_DIR" "$RUNTIME_NODE_MODULES_DIR"
fi

PLUGINS_PROFILE="$RUNTIME_CONFIG_DIR/plugins.${ROLE}"
SMTP_PROFILE="$RUNTIME_CONFIG_DIR/smtp.${ROLE}.ini"
LOG_PROFILE="$RUNTIME_CONFIG_DIR/log.${ROLE}.ini"
PLUGINS_FILE="$RUNTIME_CONFIG_DIR/plugins"

if [ -f "$PLUGINS_PROFILE" ]; then
  cp "$PLUGINS_PROFILE" "$PLUGINS_FILE"
else
  echo "WARN: Role plugins profile not found: $PLUGINS_PROFILE" >&2
  if [ ! -f "$PLUGINS_FILE" ]; then
    echo "ERROR: No fallback plugins file found at $PLUGINS_FILE" >&2
    exit 1
  fi
  echo "WARN: Falling back to $PLUGINS_FILE" >&2
fi

# The karma plugin version in this image is incompatible with Haraka 3.1.1.
if grep -Eq '^[[:space:]]*karma[[:space:]]*$' "$PLUGINS_FILE"; then
  echo "WARN: Removing incompatible plugin 'karma' from runtime plugins list" >&2
  awk '!/^[[:space:]]*karma[[:space:]]*$/' "$PLUGINS_FILE" > "$PLUGINS_FILE.tmp"
  mv "$PLUGINS_FILE.tmp" "$PLUGINS_FILE"
fi

if [ -f "$SMTP_PROFILE" ]; then
  cp "$SMTP_PROFILE" "$RUNTIME_CONFIG_DIR/smtp.ini"
fi

if [ -f "$LOG_PROFILE" ]; then
  cp "$LOG_PROFILE" "$RUNTIME_CONFIG_DIR/log.ini"
fi

TLS_KEY_PATH="/app/ssl/cert.key"
TLS_CERT_PATH="/app/ssl/cert.crt"

if [ ! -f "$TLS_KEY_PATH" ] || [ ! -f "$TLS_CERT_PATH" ]; then
  TLS_KEY_PATH="$RUNTIME_CONFIG_DIR/tls_key.pem"
  TLS_CERT_PATH="$RUNTIME_CONFIG_DIR/tls_cert.pem"
  TLS_DOMAIN="${HARAKA_DOMAIN:-localhost}"

  echo "WARN: TLS certificates not found, generating temporary self-signed certificate for role=$ROLE" >&2
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 \
    -subj "/CN=$TLS_DOMAIN" \
    -keyout "$TLS_KEY_PATH" \
    -out "$TLS_CERT_PATH" >/dev/null 2>&1

  cat > "$RUNTIME_CONFIG_DIR/tls.ini" <<EOF
[main]
key=$TLS_KEY_PATH
cert=$TLS_CERT_PATH
minVersion=TLSv1.2
maxVersion=TLSv1.3
requestCert=false
rejectUnauthorized=false
secureRenegotiation=true
honorCipherOrder=true
EOF
fi

echo "Starting Haraka with role=$ROLE"
exec haraka -c "$RUNTIME_ROOT_DIR"
