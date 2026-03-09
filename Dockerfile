FROM node:18-alpine

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

ENV HARAKA_DKIM_DIR=/data/haraka/dkim

# Install system dependencies and Haraka globally.
# iconv must be global because Haraka is installed/executed globally.
RUN apk add --no-cache libarchive-tools openssl && npm install -g Haraka toobusy-js iconv

# Create app directory  
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy configuration and plugins
COPY config/ ./config/
COPY plugins/ ./plugins/
COPY lib/ ./lib/
COPY scripts/ ./scripts/

# Create runtime directories. DKIM keys are normalized into per-domain directories at container start.
RUN mkdir -p ./config/dkim ./logs "$HARAKA_DKIM_DIR" && \
    chmod 755 ./config ./plugins ./lib ./scripts ./logs ./config/dkim "$HARAKA_DKIM_DIR" && \
    chmod +x ./scripts/*.sh ./scripts/*.js 2>/dev/null || true && \
    find ./config/dkim -mindepth 1 -maxdepth 1 -type d -exec chmod 755 {} + 2>/dev/null || true && \
    for f in ./config/dkim/*/private; do [ -f "$f" ] && chmod 644 "$f"; done; \
    for f in ./config/dkim/*/selector; do [ -f "$f" ] && chmod 644 "$f"; done; \
    true

# Expose SMTP ports
EXPOSE 25 587 8080

# Start Haraka role selected by HARAKA_ROLE
CMD ["/app/scripts/start-haraka.sh"]
