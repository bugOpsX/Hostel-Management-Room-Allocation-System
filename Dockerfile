# ==========================================
# Multi-Stage Production Dockerfile for HMRAS
# ==========================================

# Stage 1: Build stage with native compilation tools for better-sqlite3
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install native dependencies required for node-gyp / C++ bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Stage 2: Minimalist production runtime image
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/hostel.db \
    BACKUP_DIR=/app/backups

# Setup data and backup directories with non-root node ownership
RUN mkdir -p /app/data /app/backups && chown -R node:node /app

COPY --from=builder --chown=node:node /app /app

USER node

EXPOSE 3000

# Container Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
