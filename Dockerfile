# GreanTeaDawy — production image: Node 22 on Alpine with ffmpeg (MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF export),
# running as an unprivileged user with a health check. Build: `docker build -t greanteadawy .`
# Run: see docker-compose.yml and docs/docker.md.

# ---- build: install everything, build the web client, then drop dev dependencies
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY server server
COPY client client
RUN npm run build && npm prune --omit=dev --no-audit --no-fund \
  && rm -rf client/src client/test client/public client/index.html client/vite.config.js server/test packages/*/test

# ---- runtime
FROM node:22-alpine
# ffmpeg for the export formats; tini reaps child processes (ffmpeg, workers) and forwards signals
RUN apk add --no-cache ffmpeg tini \
  && mkdir -p /data && chown node:node /data
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/data \
    CLIENT_DIST=/app/client/dist
COPY --from=build --chown=root:root /app /app
COPY LICENSE README.md ./
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.js"]
