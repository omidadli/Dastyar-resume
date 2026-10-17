# HOVIDA (هویدا) — production image of the Node server.
#
# Built by `wrangler deploy` for Cloudflare Containers (see wrangler.jsonc), and
# usable on any Docker host as well:
#   docker build -t hovida .
#   docker run -p 8080:8080 -v hovida-data:/app/data -e APP_SECRET=… hovida
# On Cloudflare the data lives in R2 (STORAGE_DRIVER=remote is set by the
# Worker); elsewhere it lives in /app/data — mount a volume there.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
# node itself is PID 1: SIGTERM reaches the server, which finishes open
# requests and saves the data before exiting.
CMD ["node", "dist/server.cjs"]
