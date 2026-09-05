FROM debian:bookworm-slim AS synctex-runtime
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends texlive-binaries \
    && rm -rf /var/lib/apt/lists/*

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm install
COPY apps ./apps
COPY packages ./packages
RUN npm run build

FROM node:24-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm install --omit=dev
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY packages/database/migrations ./packages/database/migrations
COPY --from=synctex-runtime /usr/bin/synctex /usr/local/bin/synctex
COPY --from=synctex-runtime /usr/lib/*/libsynctex.so.2.0.0 /usr/local/lib/
RUN ldconfig
RUN mkdir -p /data/projects && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
