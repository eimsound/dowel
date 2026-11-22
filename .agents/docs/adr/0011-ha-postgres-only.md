# 高可用（HA）采用纯平台 PostgreSQL 多活，不引入 Redis；限流保留进程内计数

2026-11-21 决定（P7）：多副本高可用部署仅依赖外部平台 PostgreSQL（单机 SQLite 模式保留，仅支持单副本），不引入 Redis 等额外中间件。

- **无状态实时协作房间**：WebSocket 写操作通过平台 PG 按 `branch_id` 行锁串行提交到 `room_commits`，提交后通过 `LISTEN/NOTIFY` 向其他副本广播轻量通知（事件 ID / `seq`），由各副本向本地连接推送或按 `seq` 从库补齐（规避 `NOTIFY` 的 8 KB 负载上限与断线不重放问题）。停用踢人、角色即时降级、收件箱 SSE 实时推送复用同一套 `NOTIFY` 通道。副本之间完全对等无状态，负载均衡无需粘性路由（Sticky Session）。
- **持久化后台任务与巡检**：Webhook 投递与重试队列迁入平台 PG 表（`FOR UPDATE SKIP LOCKED`），审批过期巡检、定时漂移检查与影子库派生队列通过平台 PG 锁/租约防多副本重复执行；首次启动管理员引导（`bootstrapAdmin` / `SETUP_LOCK_KEY` 事务级 advisory lock）保证多副本冷启动只建一次管理员。
- **限流器保留副本本地内存计数**：登录失败、连库探测、CI 令牌失败与请求速率 4 类限流器不迁入数据库，避免给数据库增加限流写压；全部限流维度（上限与窗口时长）统一开放环境变量配置，并在 `docker-compose.yml` 与运维文档中明确提示「HA 多副本下实际总配额约为设定值 × 副本数」。

## Considered Options

- **平台 PG + Redis 多活**：吞吐更高且限流可全局精确，但公司内网自托管多维护一套 Redis（高可用还需 Sentinel/Cluster），且与平台 PG 跨系统双写存在一致性与降级复杂度。
- **平台 PG + Active/Passive 选主**：内存逻辑改动较小，但流量压在单主节点且主备切换时全员 WebSocket 断线冷启动，不具备多活扩展能力。
