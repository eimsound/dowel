# CI 令牌：SHA-256 存储、禁止令牌回滚、独立 /api/ci 路由与同步执行错误码契约

2026-11-20 决定（P6，T1 / T3）：为 CI 流水线提供项目级令牌与 HTTP 执行接口。实现见 `packages/api/src/tokens.ts`、`apps/server/src/tokens.ts`、`apps/server/src/routes/ci.ts`，用户文档 `docs/api.md`。

**令牌哈希用 SHA-256，不用慢哈希也不做 HMAC。** 令牌格式为 `dwl_` + 32 字节密码学随机数的 base64url（43 字符，256 位熵），列表辨认用的前缀取前 12 个字符（`dwl_` + 8 字符，仅占 48 位，剩余 208 位熵）。高熵随机令牌不存在离线词典爆破风险，因此不需要 Argon2/scrypt 等慢哈希（每个 API 请求都要校验令牌，慢哈希会引入额外 CPU 放大面）。同时不与 `DOWEL_SECRET` 做 HMAC：会话令牌与邀请令牌在 `auth.ts` 里已经统一用 SHA-256；如果 CI 令牌依赖 `DOWEL_SECRET`，轮换实例加密密钥会导致所有流水线里的长期令牌瞬间全部失效，运维成本过高。数据库泄露且攻击者拿到明文前提下才能冒充，而拿到哈希值无法反推 256 位随机明文。

**令牌只能访问 `/api/ci/…`，不能走普通界面端点。** 在 `routes/index.ts` 最前面挂 `rejectTokens` 中间件：携带 `Authorization: Bearer dwl_…` 访问任何 `/api/ci/…` 之外的接口一律直接返回 `403 forbidden`，不回落到会话 Cookie。这样结构上就把“只读 + 执行”的能力边界锁死了：编辑模型、发布、改策略、改连接串、标记为已执行（`mark`）、认领、接手、令牌管理本身都不可能被令牌调用，也便于在 `permission-matrix.test.ts` 里遍历全部路由表做穷举断言。非 `dwl_` 的 Bearer 头在普通路由上放行（例如反向代理注入的 OIDC 令牌），而在 `/api/ci/*` 里会按 `token_invalid` 拒绝。

**令牌不能回滚（`409 rollback_not_allowed`）。** 执行接口固定传 `direction: 'up'`；如果目标版本早于环境当前版本，拒绝并返回 `409 rollback_not_allowed`（`details.current` 标明当前版本）。回滚属于高风险的数据破坏性操作（往往伴随 `DROP TABLE` / `DROP COLUMN`），应当由人在界面上确认并经过环境的审批流程或紧急执行，而不是由 CI 流水线在分支切换或误填旧版本号时静默触发。

**执行接口同步等待完成，返回结构化 JSON 和一对一的错误码映射；环境状态接口拆清职责、零过期缓存（2026-11-21 修订）。** CI 流水线（`curl`、自建 Actions）最直接的交互是一次 HTTP POST 拿到最终结果和退出码，不需要在 shell 里解析 SSE 流或自己写轮询循环。错误码与 HTTP 状态码一一映射（`CI_ERROR_STATUS`），区分认证失败（`401`）、策略拒绝（`403`）、资源或归属不符（`404`）、状态冲突如漂移 / 回滚被拒（`409`，原前置环境错误码已随功能移除）、目标版本不存在或 SQL 执行失败（`422`）、等执行锁超时（`423`）、限速（`429`）和目标库不可达（`502`）。只读/检测接口按开销拆分为三类：项目与环境列表（`GET /api/ci/projects/:owner/:project`，仅返回平台配置，不返回过期缓存状态）、单环境实时状态（`GET .../environments/:env`，轻量实时读目标库 `dowel.history` 返回 `currentVersion` / `unfinished` / `pending`，不返回缓存漂移）、实时漂移检测（`POST .../environments/:env/drift`，实时读全库结构快照比对）。

**等锁期间的并发保护与锁内复查。** CI 执行与界面执行、执行申请共用 `EnvLocks` 与目标库项目锁，且总等待时间（默认 30 秒，可在请求里调小）扣除等环境锁消耗后交给目标库项目锁。拿到环境锁之后、连接目标库之前通过 `beforeConnect` 钩子复查令牌是否被吊销/过期、环境生效的 `allowTokens` 开关是否被关闭，并取最新的语句 / 锁等待超时，避免等锁窗口内的状态漂移导致越权执行。

**通知范围：Webhook 覆盖全部环境，收件箱只通知生产环境。** 非生产环境在 CI 里高频执行，如果每次都发站内收件箱通知会淹没审批消息；因此所有环境都发 `token.executed` 组级 Webhook 事件（可按需订阅），只有生产环境的令牌执行（成功或失败）才给项目管理员和当前审批流程里的审批人发 `token_execution` 站内通知。
