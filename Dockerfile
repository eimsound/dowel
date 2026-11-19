# Dowel 单容器镜像：服务端 + 前端（同一个端口）
FROM node:26-trixie-slim AS build
RUN npm install -g pnpm@12.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm build

# 运行阶段：只装服务端及其依赖的生产依赖；前端只要构建产物
FROM node:26-trixie-slim
RUN npm install -g pnpm@12.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --prod --frozen-lockfile --filter "@dowel/server..." && rm -rf apps/web/src
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production \
    PORT=4600 \
    DOWEL_DB=/data/dowel.db
VOLUME /data
EXPOSE 4600
CMD ["node", "apps/server/src/main.ts"]
