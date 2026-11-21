# Dowel 单容器镜像：服务端 + 前端（同一个端口）
FROM node:26-trixie-slim AS build
RUN npm install -g pnpm@12.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsdown.config.ts ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm build

# 运行阶段：只装服务端及其依赖的生产依赖，仅复制构建产物 dist（不含源码与 tsconfig.json）
FROM node:26-trixie-slim
RUN npm install -g pnpm@12.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json ./packages/api/
COPY packages/core/package.json ./packages/core/
COPY packages/engines/package.json ./packages/engines/
COPY packages/executor/package.json ./packages/executor/
COPY packages/sync/package.json ./packages/sync/
COPY packages/verifier/package.json ./packages/verifier/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --prod --frozen-lockfile --filter "@dowel/server..."
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/engines/dist ./packages/engines/dist
COPY --from=build /app/packages/executor/dist ./packages/executor/dist
COPY --from=build /app/packages/sync/dist ./packages/sync/dist
COPY --from=build /app/packages/verifier/dist ./packages/verifier/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production \
    PORT=4600 \
    DOWEL_DB=/data/dowel.db
VOLUME /data
EXPOSE 4600
CMD ["node", "apps/server/dist/main.js"]
