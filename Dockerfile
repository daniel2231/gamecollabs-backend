# syntax=docker/dockerfile:1
# One Dockerfile, two images: `--target api` and `--target mcp`.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm -r run build
RUN pnpm deploy --legacy --filter @gamecollabs/api --prod /out/api && \
    pnpm deploy --legacy --filter @gamecollabs/mcp --prod /out/mcp

FROM node:24-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api ./
COPY prompts ./prompts
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

FROM node:24-slim AS mcp
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/mcp ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
