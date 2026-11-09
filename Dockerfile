FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY scripts/build-web.mjs ./scripts/build-web.mjs
COPY docs/web-service.md ./docs/web-service.md
RUN npm run build:web

FROM node:24-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/service ./dist/service
COPY --from=build --chown=node:node /app/dist/web ./dist/web
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3210/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/service/main.cjs"]
