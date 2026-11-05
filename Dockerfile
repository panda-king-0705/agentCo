# AgentCo image: the server runs its TypeScript directly on Node (type stripping, node:sqlite)
# with zero runtime npm dependencies; only the console build needs react, react-dom and esbuild.
#
#   docker compose up -d --build            (recommended; see docs/DEPLOY.md)
#   docker build -t agentco .
#
# Off loopback the API requires APP_AUTH_TOKEN (24+ characters): without it the container stops
# at boot with a message saying how to generate one. State lives in the /data volume.

ARG NODE_IMAGE=node:24-slim

# ── build: install dev dependencies, build the console, assemble the runtime tree ──────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /src
# Whole context (minus .dockerignore): robust to new workspaces; the install is small.
COPY . .
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else echo "no package-lock.json: falling back to npm install" && npm install --no-audit --no-fund; fi
RUN node apps/web/build.mjs
# Only what the server needs at runtime. catalog/ (agency-agents) is read at runtime when present.
RUN set -eu; \
    mkdir -p /out/apps/server /out/apps/web /out/packages; \
    cp package.json /out/; \
    cp apps/server/package.json /out/apps/server/; \
    cp -R apps/server/src /out/apps/server/src; \
    cp apps/web/package.json /out/apps/web/; \
    cp -R apps/web/dist /out/apps/web/dist; \
    cp -R packages/shared /out/packages/shared; \
    rm -rf /out/packages/shared/node_modules; \
    if [ -d catalog ]; then cp -R catalog /out/catalog; fi; \
    test -f /out/apps/web/dist/index.html

# ── runtime: Node only, non-root, state in /data ───────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
# Code is owned by root and read-only for the app user; only /data is writable.
COPY --from=build /out/ /app/
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
# No curl in slim images: probe with node. /api/health needs no token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"]
