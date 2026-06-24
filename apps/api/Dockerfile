FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --filter @nexus/api... --frozen-lockfile=false

FROM deps AS build
COPY apps/api apps/api
RUN pnpm --filter @nexus/api prisma generate
RUN pnpm --filter @nexus/api build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/server.js"]
