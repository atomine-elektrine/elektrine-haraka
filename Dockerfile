FROM node:18-alpine

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

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

# Create directories and organize DKIM keys (keys are mounted at runtime, may not exist at build time)
RUN mkdir -p ./config/dkim/elektrine.com ./config/dkim/z.org ./logs && \
    cp ./config/dkim/elektrine.com.key ./config/dkim/elektrine.com/private 2>/dev/null || true && \
    cp ./config/dkim/z.org.key ./config/dkim/z.org/private 2>/dev/null || true && \
    chmod 755 ./config ./plugins ./lib ./scripts ./logs ./config/dkim && \
    chmod 755 ./config/dkim/elektrine.com ./config/dkim/z.org && \
    chmod +x ./scripts/*.sh ./scripts/*.js 2>/dev/null || true && \
    for f in ./config/dkim/*/private; do [ -f "$f" ] && chmod 644 "$f"; done; \
    for f in ./config/dkim/*/selector; do [ -f "$f" ] && chmod 644 "$f"; done; \
    true

# Expose SMTP ports
EXPOSE 25 587 8080

# Start Haraka role selected by HARAKA_ROLE
CMD ["/app/scripts/start-haraka.sh"]
