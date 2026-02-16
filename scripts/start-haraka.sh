#!/bin/sh
set -eu

ROLE="${HARAKA_ROLE:-inbound-mx}"
SOURCE_CONFIG_DIR="/app/config"
SOURCE_PLUGINS_DIR="/app/plugins"
SOURCE_LIB_DIR="/app/lib"
SOURCE_NODE_MODULES_DIR="/app/node_modules"
RUNTIME_ROOT_DIR="/tmp/haraka-config"
RUNTIME_CONFIG_DIR="$RUNTIME_ROOT_DIR/config"
RUNTIME_PLUGINS_DIR="$RUNTIME_ROOT_DIR/plugins"
RUNTIME_LIB_DIR="$RUNTIME_ROOT_DIR/lib"
RUNTIME_NODE_MODULES_DIR="$RUNTIME_ROOT_DIR/node_modules"

rm -rf "$RUNTIME_ROOT_DIR"
mkdir -p "$RUNTIME_CONFIG_DIR"
cp -R "$SOURCE_CONFIG_DIR"/. "$RUNTIME_CONFIG_DIR"/

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

echo "Starting Haraka with role=$ROLE"
exec haraka -c "$RUNTIME_ROOT_DIR"
