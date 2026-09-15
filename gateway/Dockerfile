# NIAC Live Gateway Container (Node.js 24 Alpine)
FROM node:24-alpine AS runner

WORKDIR /app

# Create unprivileged user and app data directory
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production \
    GATEWAY_PORT=3000 \
    DATA_DIR=/app/data

# Copy source code and modules
COPY --chown=node:node package.json ./
COPY --chown=node:node gateway/ ./gateway/
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node config/ ./config/

USER node

VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/gateway/health || exit 1

CMD ["node", "gateway/server.mjs"]
