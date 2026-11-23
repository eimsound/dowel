# 部署与配置

本页说明 Dowel 的部署方式、从源码构建命令、完整服务端环境变量清单、外部 PostgreSQL 多副本高可用（HA）部署、反向代理配置，以及数据库与本地 SQLite 连接安全边界。

## 部署方式 {#deployment-modes}

### Docker Compose（单容器推荐） {#docker-compose}

```sh
docker compose up -d
```

镜像 `Dockerfile` 将后端接口、WebSocket 与前端静态资源打包在同一容器同一端口（默认 `4600`）：

- 平台数据库默认使用挂载卷 `dowel-data` 中的 SQLite 文件（容器内环境变量预设 `DOWEL_DB=/data/dowel.db`）；
- 部署前将 `docker-compose.yml` 中的 `DOWEL_SECRET` 改为至少 16 个字符的随机字符串；
- 如需多副本高可用或切换外部平台库，将 `DOWEL_DB` 改为 `postgres://…` 连接串即可。

### 从源码构建与运行 {#build-from-source}

仓库根目录 `.tool-versions` 固定使用 `node 26.13.0` 与 `pnpm 12.21.0`（可配合 `mise` 自动安装）：

```sh
pnpm install
pnpm build        # tsdown 构建 packages/* 与 apps/server（ESM + .d.ts），Vite 构建 apps/web/dist
pnpm start        # 启动编译后的服务端：http://localhost:4600
```

本地开发与质量检查命令：

```sh
pnpm dev          # 启动服务端（4600，--conditions=@dowel/source 直读源码）与前端开发服务器（5173）
pnpm check        # 依次执行 pnpm lint（Oxlint --type-aware --deny-warnings && oxfmt --check）、tsc --noEmit 与 vitest run
```

在开发模式（`pnpm dev`）或单元测试（`pnpm test`）下，各内部工作区包通过条件导出 `@dowel/source` 直接加载 TypeScript 源码，无需预先执行 `pnpm build`。`pnpm start` 与 Docker 镜像运行编译后的纯 JS `dist` 产物，不包含源码文件。

## 服务端环境变量 {#server-env-vars}

| 环境变量                       | 默认值                              | 说明                                                                                                                                                                                                          |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                         | `4600`                              | 服务监听端口（HTTP 接口、WebSocket 与前端页面共用）                                                                                                                                                           |
| `DOWEL_DB`                     | `./data/dowel.db`                   | 平台数据库路径或连接串：文件路径启用 SQLite（目录不存在时自动创建，Docker 镜像默认 `/data/dowel.db`）；`postgres://…` 或 `postgresql://…` 连接外部 PostgreSQL；`:memory:` 为内存库（重启丢失）                |
| `DOWEL_WEB`                    | `apps/web/dist`                     | 前端构建产物所在目录                                                                                                                                                                                          |
| `DOWEL_SECRET`                 | 无                                  | 加密数据库连接串、OIDC `client_secret` 与 Webhook 地址/密钥的主密钥（至少 16 个字符）。未设置时拒绝保存环境与密钥                                                                                             |
| `DOWEL_TRUST_PROXY`            | 无                                  | 部署在可信反向代理后时设为 `1` 或 `true`，才会读取 `X-Forwarded-For`（取最后一个地址）、`X-Forwarded-Proto` 与 `X-Forwarded-Host`。未启用时一律忽略转发头，防止伪造客户端 IP 或协议                           |
| `DOWEL_PUBLIC_URL`             | 无                                  | 对外访问完整地址（如 `https://dowel.example.com`）。设置后 CSRF Origin 校验、OIDC 回调地址与 Webhook 详情链接优先使用它的协议与主机                                                                           |
| `DOWEL_SQLITE_ROOTS`           | 无                                  | 冒号分隔的本地 SQLite 目标库绝对目录白名单（如 `/var/lib/app-dbs:/srv/sqlite`）。未设置时服务端默认禁止直连任何本地 SQLite 文件作为目标库                                                                     |
| `DOWEL_ADMIN_USERNAME`         | `admin`                             | 首次启动管理员用户名（实例尚无用户时创建首个实例管理员，显示名与用户名相同，须符合用户名校验规则）                                                                                                            |
| `DOWEL_ADMIN_PASSWORD_FILE`    | 无                                  | 从指定文件读取初始管理员密码（去除首尾空白/换行；服务端不删除或改写该文件；设为该值时不需要首次登录改密，与 `DOWEL_ADMIN_PASSWORD` 互斥）                                                                     |
| `DOWEL_ADMIN_PASSWORD`         | 无                                  | 通过环境变量直接设置初始管理员密码（设为该值时不需要首次登录改密；与 `DOWEL_ADMIN_PASSWORD_FILE` 同时设置会导致启动失败）                                                                                     |
| `DOWEL_INITIAL_PASSWORD_FILE`  | `<数据目录>/initial-admin-password` | 未配置 `DOWEL_ADMIN_PASSWORD_FILE` 与 `DOWEL_ADMIN_PASSWORD` 时，首次启动自动生成随机临时密码并按 `0600` 权限写入该路径；`admin` 完成改密或被重置后会自动删除（内存库默认为 `./data/initial-admin-password`） |
| `DOWEL_ALLOW_PASSWORD_LOGIN`   | 无                                  | 设为 `1` 或 `true` 时强制开启密码登录。在实例设置中关闭密码登录后用作应急恢复入口                                                                                                                             |
| `DOWEL_DRIFT_INTERVAL_MINUTES` | `60`                                | 定时漂移检查间隔（分钟）；设为 `0` 关闭定时检查                                                                                                                                                               |
| `DOWEL_LOGIN_LIMIT`            | `10`                                | 登录失败限速：同一 IP + 用户名在窗口内允许的失败次数                                                                                                                                                          |
| `DOWEL_LOGIN_IP_LIMIT`         | `30`                                | 登录失败限速：同一 IP 在窗口内允许的总失败次数（企业 NAT 或共享出口下可调大）                                                                                                                                 |
| `DOWEL_LOGIN_WINDOW_MS`        | `600000`                            | 登录失败限速窗口时长（毫秒，默认 10 分钟）                                                                                                                                                                    |
| `DOWEL_CONNECTION_LIMIT`       | `10`                                | 连库探测限速：单个用户在窗口内允许的连接检查、接手探测、漂移检查或拉取结构次数                                                                                                                                |
| `DOWEL_CONNECTION_WINDOW_MS`   | `60000`                             | 连库探测限速窗口时长（毫秒，默认 1 分钟）                                                                                                                                                                     |
| `DOWEL_TOKEN_FAIL_LIMIT`       | `20`                                | CI 令牌认证失败限速：同一 IP 在窗口内允许的格式合法但认证失败次数（缺头与非法格式不扣减；触限后不阻断同 IP 下的有效活跃令牌）                                                                                 |
| `DOWEL_TOKEN_FAIL_WINDOW_MS`   | `600000`                            | CI 令牌认证失败限速窗口时长（毫秒，默认 10 分钟）                                                                                                                                                             |
| `DOWEL_TOKEN_RATE_LIMIT`       | `120`                               | CI 令牌请求速率限速：单个令牌在窗口内允许的请求次数                                                                                                                                                           |
| `DOWEL_TOKEN_RATE_WINDOW_MS`   | `60000`                             | CI 令牌请求速率限速窗口时长（毫秒，默认 1 分钟）                                                                                                                                                              |

> 限流参数补充说明：上述 9 项限流配置（`DOWEL_*_LIMIT` 与 `DOWEL_*_WINDOW_MS`）仅接受不超过 `2147483647` 的正整数，非法值或超上限时自动回退默认值；所有限流器均为**单副本进程内内存计数**，在多副本 HA 部署下实际全集群总配额约为设定值 × 副本数。

## 多副本高可用部署（HA） {#ha}

将 `DOWEL_DB` 设为外部 PostgreSQL 连接串（`postgres://…`），且所有副本配置相同的 `DOWEL_SECRET` 时，可直接启动多个对等 Dowel 副本实现无状态多活，**无需引入 Redis**：

- **冷启动同步与首次管理员引导**：多个副本同时冷启动时，平台库迁移与首次管理员创建（读取 `DOWEL_ADMIN_PASSWORD_FILE` / `DOWEL_ADMIN_PASSWORD`，或自动生成 `0600` 权限的 `initial-admin-password` 文件）通过平台 PostgreSQL advisory lock 互斥，确保多副本下只初始化一次管理员账号。
- **无粘性负载均衡**：前端实时协作 WebSocket、普通 HTTP 接口与 SSE 可由普通轮询负载均衡转发（需允许 WebSocket 连接升级，不要求 Sticky Session）。
- **跨副本协作与状态同步**：
  - 画布编辑操作通过平台 PostgreSQL 分支行锁串行持久化提交，并经 `LISTEN/NOTIFY` 向所有副本广播轻量通知（操作序号 `seq`、大布局同步、用户停用踢出、项目角色降级、收件箱未读变更与影子库缓存失效）。
  - 副本离线或通知通道重连时，房间与客户端自动按序号追齐状态。
- **分布式任务与租约**：
  - 组级 Webhook 投递队列持久化在 `webhook_jobs` 表中，通过 `FOR UPDATE SKIP LOCKED` 认领任务与租约，重启或单副本宕机不丢任务；
  - 执行中申请记录所属执行副本租约，仅在所属副本心跳租约过期后才由存活副本回收标记为中断，避免误杀仍在运行的迁移；
  - 定时漂移巡检、过期执行申请巡检与派生刷新均通过分布式任务锁互斥防重，环境执行锁在进程内互斥之上叠加平台库 advisory lock。
- **优雅停机排空**：收到 `SIGINT` / `SIGTERM` 后，服务端停止接收新请求并关闭活跃 SSE / WebSocket，等待在途执行、派生刷新与锁排空后，依次关闭后台队列、房间、影子库连接池、事件总线、心跳租约与平台库连接。

> 单机 SQLite 平台库模式（默认 `DOWEL_DB=./data/dowel.db`）仅支持单进程单副本部署。

## 反向代理配置 {#reverse-proxy}

当 Dowel 运行在 Nginx、Caddy、Traefik 或云负载均衡之后时，需满足以下两项配置：

1. **环境变量**：同时设置 `DOWEL_TRUST_PROXY=1` 与 `DOWEL_PUBLIC_URL=https://你的对外域名`。启用后服务端从 `X-Forwarded-For`（取最后一个由可信代理追加的地址）获取客户端 IP，并使用 `DOWEL_PUBLIC_URL` 统一校验 CSRF `Origin` 和生成 OIDC 回调地址。
2. **WebSocket 与 SSE 转发**：代理需正确传递 `Upgrade`、`Connection` 头并配置长连接超时，同时关闭 SSE 响应缓冲以配合服务端返回的 `X-Accel-Buffering: no`，确保协作画布 WebSocket（`/api/projects/:pid/sync`）与收件箱实时 SSE（`/api/me/inbox/stream`）不被提前中断或缓冲延迟；若需要服务端感知真实请求来源，传递 `X-Forwarded-Proto`、`X-Forwarded-Host` 与 `X-Forwarded-For`。

## 数据库连接安全边界 {#connection-security}

### `connection_allowlist`（目标 TCP 地址白名单） {#connection-allowlist}

服务端会代表已登录用户连接数据库（连接检查、建环境、导入结构、验证与执行）。实例管理员可在“管理后台 → 实例设置”中配置 `connection_allowlist` 限制允许访问的 TCP 地址：

- 每行一项（或逗号分隔），支持 CIDR（如 `10.0.0.0/8`、`2001:db8::/32`）、单个 IP 或主机名（如 `db.internal`）。
- 主机名会先解析为 IP 再比对，因此 `localhost`、`127.0.0.1`、`::1` 需按实际使用情况分别允许（或配置 `127.0.0.0/8`、`::1/128`）。解析失败的主机名一律拒绝。
- **留空表示不限制**（自托管默认）。配置后不在列表中的地址在连接检查和创建/更新环境时返回 `422`。
- 为确保白名单有效，服务端强制要求使用标准 TCP authority 格式：
  - **PostgreSQL**：拒绝 `?host=`、`?hostaddr=` 查询参数及 unix socket（`/var/run/postgresql`）；逗号分隔多主机时逐一校验全部主机（托管库连接模式要求与影子库最小权限 SQL 配置见 [托管数据库与受限权限配置](modeling.md#managed-shadow-db)）；
  - **MySQL**：拒绝 `?socketPath=` 查询参数及 unix socket；
  - **SQL Server**：支持标准 `host[:port]` 与 `host\instance` 命名实例格式的主机名校验。

### `DOWEL_SQLITE_ROOTS`（本地 SQLite 目标库路径白名单） {#sqlite-roots}

SQLite 目标库直接读取服务端本地文件系统，不走 TCP 主机白名单，而是通过服务端环境变量 `DOWEL_SQLITE_ROOTS` 实施目录级隔离：

- 连接串必须为 `sqlite:///绝对路径`（不允许 `:memory:`、查询参数、锚点、`..` 或空字节）。
- **未设置 `DOWEL_SQLITE_ROOTS` 时，服务端默认禁用直连任何本地 SQLite 目标库**（只允许用内置 `:memory:` 影子库建模、导入 SQL 与验证）。
- 配置为冒号分隔的绝对目录路径（例如 `/srv/app-dbs:/data/targets`）后，服务端逐段消解目标路径上的所有符号链接（包含尚未创建文件前的中间目录软链），确保解析后的真实路径严格落在允许目录之内。
- **平台库自保护**：服务端自动禁止将平台库 `DOWEL_DB` 自身及其 `-wal`、`-shm`、`-journal` 附属文件配置为任何项目的 SQLite 目标库。
