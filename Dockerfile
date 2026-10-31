FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY meydan/package.json meydan/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY meydan/ ./
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY meydan/package.json meydan/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=10000
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '10000') + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server/production.js"]
