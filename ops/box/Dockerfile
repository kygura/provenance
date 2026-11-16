# The pipeline on a server: one always-running process (apps/worker/src/box/scheduler.ts) that runs the launch
# lane, the gated full run and the brief at the slots the GitHub workflows used. Build context is the repo root.
# See ops/box/README.md.
FROM oven/bun:1.4.4
WORKDIR /app
# Workspace manifests first so the install layer is cached. The dashboard is a workspace too; only its manifest
# is copied, and the filter keeps Next.js and React out of the image.
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
# researcher.ts imports a fixture JSON statically, so the fixtures ship too.
COPY fixtures ./fixtures
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN bun install --frozen-lockfile --production --filter '@provenance/worker' \
 && mkdir -p data && chown -R bun:bun data
ENV NODE_ENV=production \
    PROVENANCE_DATA_DIR=/app/data \
    ALERT_FILE_SINK=/app/data/alerts.jsonl
USER bun
# Mount a persistent volume here: the chain-read cache (data/rpc-cache, capped at 256 MB), the alert file and the
# scheduler heartbeat. The database itself is Turso (DATABASE_URL).
VOLUME ["/app/data"]
# No HTTP port. Healthy = the scheduler wrote its heartbeat in the last 3 minutes (it writes one every minute).
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "const f=require('fs');try{const b=JSON.parse(f.readFileSync('/app/data/box-scheduler.json','utf8')).beat;process.exit(Date.now()-Date.parse(b)<180000?0:1)}catch{process.exit(1)}"]
CMD ["bun", "apps/worker/src/box/scheduler.ts"]
