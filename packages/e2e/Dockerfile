# Shared image for the app, worker and migrate services. The build context is the repository root (compose.yaml: context ../..).
FROM oven/bun:1.3.14-slim
WORKDIR /repo
COPY package.json bun.lock ./
COPY packages/db-multi/package.json packages/db-multi/
COPY packages/db-single/package.json packages/db-single/
COPY packages/redis/package.json packages/redis/
COPY packages/e2e/package.json packages/e2e/
RUN bun install --frozen-lockfile --production
COPY packages/db-multi packages/db-multi
COPY packages/redis packages/redis
COPY packages/e2e/src packages/e2e/src
USER bun
