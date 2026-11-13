FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
ENV NPM_CONFIG_FETCH_TIMEOUT=600000
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package-lock.json ./
# Derive an install-only manifest from the lockfile so script-only package.json
# changes don't force a dependency download and native SQLite rebuild.
RUN node -e "const fs=require('node:fs');const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));const root=lock.packages[''];const keys=['name','version','dependencies','devDependencies','optionalDependencies','peerDependencies','engines'];const manifest=Object.fromEntries(keys.filter((key)=>root[key]!==undefined).map((key)=>[key,root[key]]));fs.writeFileSync('package.json',JSON.stringify(manifest))" \
  && npm ci --ignore-scripts --no-audit --no-fund \
  && npm rebuild better-sqlite3 --build-from-source --foreground-scripts

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV CHANGEGRAPH_DB_PATH=:memory:
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build \
  && ./node_modules/.bin/esbuild src/worker.ts --bundle --platform=node --format=esm --external:better-sqlite3 --outfile=.next/worker/worker.mjs

FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV CHANGEGRAPH_DB_PATH=/app/data/changegraph.db
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/scripts ./scripts
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://localhost:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]

FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV CHANGEGRAPH_DB_PATH=/app/data/changegraph.db
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=builder --chown=node:node /app/.next/worker/worker.mjs ./worker.mjs
COPY --from=dependencies --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=dependencies --chown=node:node /app/node_modules/bindings ./node_modules/bindings
COPY --from=dependencies --chown=node:node /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
USER node
CMD ["node", "worker.mjs"]
