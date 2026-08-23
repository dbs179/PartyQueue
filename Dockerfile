# ---- Client bundle (esbuild; not needed at runtime) ------------------------
FROM node:20-alpine AS client-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY public ./public
COPY src ./src
COPY scripts/build-client.mjs ./scripts/build-client.mjs
RUN npm run build:client

# ---- Runtime image ---------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

# DJ Voice applies non-default speech tempo locally after downloading TTS.
RUN apk add --no-cache ffmpeg

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY --from=client-build /app/public/js/dist ./public/js/dist

# Drop root: the app only needs to write /app/data (stores, TTS, banners) and
# /app itself (Settings saves credentials to .env). Everything else is read-only.
RUN mkdir -p /app/data && chown node:node /app /app/data
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Process + writable data/ (HTTP 200 from /api/ready). Do not require partyReady
# here — missing Spotify keys or brief Sonos discovery must not restart-loop.
# Deploy smoke still waits for ready + partyReady; autoheal uses this check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
