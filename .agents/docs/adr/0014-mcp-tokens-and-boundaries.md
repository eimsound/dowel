# MCP 服务：个人 MCP 令牌、正交 scope、绝不连目标库，CI 接口单独生成 OpenAPI

2026-11-24 决定（M3-C，落实 Q26「M3 提供 MCP 服务，AI 的修改走同样的冲突规则和评审，不开后门」）：AI 编程助手通过 `POST /api/mcp`（无状态 Streamable HTTP）以**个人 MCP 令牌**接入。实现见 `packages/api/src/mcp.ts`、`apps/server/src/mcp-tokens.ts`、`apps/server/src/routes/{mcp,mcp-tokens}.ts`、`Rooms.applyMcpOps`；界面规格 `.agents/docs/ui/mcp-tokens.md`；用户文档 `docs/{en,zh}/mcp.md`。

1. **身份：MCP 令牌属于用户，不属于项目。** 明文 `dwm_` + 32 字节随机数（base64url），库里只存 SHA-256（同 [ADR 0009](0009-ci-tokens-and-api.md) 的理由：高熵随机数不需要慢哈希，不绑 `DOWEL_SECRET`）。每个请求实时计算权限 = 用户**当前**生效项目角色 ∩ 令牌 scope ∩ 可选项目白名单（≤ 50 个）；降权、移出组立即生效。修改和审计都记在本人名下（`actor_kind = 'user'`，`data.via = 'mcp'`，`data.mcpToken = { id, name, prefix }`），画布修改历史显示本人并带 MCP 标记。所有活跃用户都能在个人设置自助签发，不复用 CI 令牌的三层“谁能创建”规则（[ADR 0010](0010-token-creator-policy.md)）；实例设置「允许 MCP 访问」（默认开）是总开关，关闭后不能新建、已有令牌一律 `403 mcp_disabled`（不删除令牌）。实例管理员可在「用户」页查看并吊销任意用户的 MCP 令牌。`mcp_tokens.kind` 预留给以后的 OAuth 2.1 访问令牌（目前只有 `personal`，不加 CHECK 免得 SQLite 重建表）。
   - **与 [02-consensus.md](../02-consensus.md) 11.4「不做个人令牌」的关系**：那条结论只针对 CI（流水线凭据应当随项目而不随人，离职不影响流水线）。MCP 的使用者是坐在终端前的人，AI 代表他本人工作，权限和责任都应当跟人走，所以 MCP 用个人令牌；CI 仍然只有项目级令牌。
2. **scope 正交、只能收窄。** `read` 是基线（总是包含：项目、模型、DDL、版本链、迁移预览、环境的平台缓存状态）；`verify` 只授权影子库验证（等同界面的 `model.verify`）；`write` 只授权工作副本的整批原子修改（还要求项目编辑者以上，`sync.edit`）。`verify` 与 `write` 可独立勾选，都隐含 `read`。令牌必须过期：默认 30 天，最长 1 年，没有永不过期；每个用户最多 20 个有效令牌。
3. **写边界：只有工作副本与影子库。** `apply_changes` 的每个操作都是 `@dowel/core` 的 mutator，经 `Rooms.applyMcpOps` 走与 WebSocket 编辑完全相同的路径：分支行锁（PG `for update`）+ 追赶外部提交、`reads` 冲突检测（以 AI 读取时的 `baseSeq` 为依据：之后被别人改过或删掉的对象一律 `conflict`）、实时广播给在线协作者、`OpaqueRefresher` 派生刷新、画布修改历史可一键恢复。整批原子：先在写时复制的副本上把整批预执行一遍，任何一步会被拒绝就整批不提交、不写 `room_rejections`；支持 `dryRun`；新对象用 `$ref:<alias>` 由服务端生成 UUIDv7。客户端标识 `mcp:{userId}:{tokenId}` 与 WebSocket 客户端（`{userId}:{raw}`，raw 不含冒号）和 `system` 结构上不相交。
   - **绝不连目标库**：环境状态与漂移只读平台缓存（带缓存时间与 `source: 'platform_cache'`），MCP 代码不调用任何目标库连接（读历史、实时漂移、执行器）。影子库验证可以连影子库（含同实例影子库 `{原库名}_dowel`），这是界面 `model.verify` 的既有能力，不碰目标库的结构与历史。
   - **不开放**：发布版本、提交执行申请、执行 / 回滚 / 紧急执行 / 标记为已执行 / 写基线 / 接入 / 认领 / 审批、改连接串或执行策略、整库导入覆盖。发布和执行始终由人在界面上完成，走原有的审批流程。
4. **隔离、吊销与限流。** `rejectTokens` 双向隔离：`Bearer dwl_…`（CI 令牌）只能访问 `/api/ci/…`，`Bearer dwm_…` 只能访问 `/api/mcp`，越界一律 403、不回落 cookie；`/api/mcp` 只认 `Bearer dwm_…`，会话 cookie 与 CI 令牌都不接受。用户被停用、管理员重置密码、使用重置密码链接时**永久吊销**该用户的全部 MCP 令牌（与吊销会话一致，经 `EventBus` 的 `mcp_tokens.changed` 让其他副本清空缓存）；删除用户级联删除；自己改密码不吊销；`must_change_password = true`（如首次启动的临时密码）期间请求实时 `403 password_change_required`。认证失败按来源 IP 限速并配活跃令牌快照防误杀（pitfalls #8 #9，`DOWEL_MCP_FAIL_LIMIT` / `_WINDOW_MS`），每令牌限速 `DOWEL_MCP_RATE_LIMIT` / `_WINDOW_MS`；影子库验证另受连接限速（按用户计，防多建令牌绕过）。HA 多副本下限流按副本计数。
5. **传输：官方 SDK 的无状态 handler。** 用 `@modelcontextprotocol/server@2.4.0`（只依赖 zod 4 与 `@modelcontextprotocol/core`，满足 7 天 `minimumReleaseAge` 与 provenance `trustPolicy`）的 `createMcpHandler(factory, { legacy: 'stateless' })`：同时服务 2026-07-28 版协议（无握手、逐请求）与 2025 代客户端的无状态回退；不发 `Mcp-Session-Id`、不开 SSE（GET / DELETE 返回 405），多副本无需粘性路由。工具的输入 schema 直接由 zod 4 的 `z.toJSONSchema()` 生成。
6. **OpenAPI 只给 CI 接口。** 把 `routes/ci.ts` 的 7 个对外 REST 接口迁到独立的 `OpenAPIHono` 子应用（`@hono/zod-openapi`），生成 `GET /api/ci/openapi.json`（OpenAPI 3.1）和 `GET /api/ci/docs`（Scalar 交互文档）；主应用和约 100 个内部接口不动。这两个文档端点接受有效会话 cookie（需已完成强制改密）或有效 CI 令牌，匿名 401、MCP 令牌 403；7 个业务端点仍只认 CI 令牌。Scalar 的脚本由 web 构建打包到同源 `/vendor/scalar/`，页面无内联脚本，不放宽全局 CSP `script-src 'self'`，不加载任何外部 CDN。

## Considered Options

- **项目级 MCP 令牌（类似 CI 令牌）**：修改记在令牌名下而不是人名下，协作冲突提示与审计失去“谁”；跨项目工作要配 N 个 MCP server；容易与 CI 的免审批执行通道混淆。
- **OAuth 2.1（MCP 授权规范：授权服务器、PKCE、客户端注册、同意页）**：Claude Desktop / claude.ai 连接器可以一键登录，但要在 Dowel 里实现完整授权服务器，且无浏览器环境不友好；作为以后的扩展，令牌表预留 `kind`。
- **允许 MCP 实时连目标库读状态 / 检查漂移**：对 AI 有用，但会让 AI 驱动对生产库的连接，SSRF 面和生产库压力都不可控；平台缓存（定时漂移检查、执行后同步）已能回答“环境在哪个版本、有没有漂移”。
- **允许 MCP 发布版本或提交执行申请**：版本链只追加不可删，AI 循环重试容易产生脏版本；执行申请会发收件箱通知与 Webhook，造成噪声。发布与执行保持人工。
- **手写 JSON-RPC 处理器（零依赖）**：2026-07-28 版协议有 `_meta` 信封、`server/discover`、头 / 体版本不一致等一整套校验，再加上 2025 代客户端兼容，自己追两代协议的合规风险高；SDK v2 已不带 express / cors / jose，供应链面可控。
- **全量迁移到 `@hono/zod-openapi`**：约 100 个内部接口随界面频繁变化，没有外部消费者，全量迁移收益低、冲突面大；MCP 的工具 schema 不需要 OpenAPI。
