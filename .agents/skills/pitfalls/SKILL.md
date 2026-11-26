---
name: pitfalls
description: >-
  Dowel 仓库高频踩坑与防坑指南（提炼自 P6 / P6.5 / P7 审查确认的 #8–#45 真实缺陷）。
  在 Dowel 项目中开发、重构或代码审查以下模块时触发：PostgreSQL 平台库连接池、advisory lock 与冷启动迁移、
  HaCoordinator 租约心跳、优雅停机、Webhook 持久化队列、执行申请巡检与收件箱 SSE、无状态协作房间同步与
  OpaqueRefresher 派生刷新、Shadows 缓存与同实例影子库、目标库接手/接入/拉取与漂移检测、CI 令牌鉴权与限流、
  GitHub Action 脚本、前端多步向导/恢复弹窗/focusgroup 键盘导航/React Query 缓存/i18n 以及用户与架构文档同步。
---

# Dowel 踩坑与防坑指南

> **维护与纠偏说明**：本 Skill 仅作防坑参考，具体行为一律以当前仓库源码为准；如发现条目不准确、已过时或有遗漏，请提交 Issue（注明条目与对应代码位置）待后续修订。

本指南基于 Dowel P6 / P6.5 / P7 深度审查核实的 38 个真实缺陷（GitHub `#8`–`#45`）提炼。开发或审查涉及对应领域时，先扫下方**红线速查**，再按需阅读 `references/` 下对应专题的完整反模式与经过验证的正确做法。

## 专题索引（按需阅读）

| 领域 | 详细文档 | 核心源码模块 | 关联 Issue |
| --- | --- | --- | --- |
| 1. PG 连接池、分布式锁与冷启动 | [pg-ha-locks.md](./references/pg-ha-locks.md) | `apps/server/src/db.ts`, `ha.ts`, `routes/setup.ts`, `main.ts` | `#37` `#38` `#23` `#43` `#45` |
| 2. 优雅停机、队列、巡检与 SSE | [shutdown-queues-sse.md](./references/shutdown-queues-sse.md) | `shutdown.ts`, `main.ts`, `requests.ts`, `webhooks.ts`, `routes/requests.ts` | `#19` `#18` `#20` `#21` `#22` `#26` `#27` `#25` |
| 3. 协作房间、派生刷新与影子缓存 | [rooms-derive-shadows.md](./references/rooms-derive-shadows.md) | `rooms.ts`, `rooms/*`, `derive.ts`, `shadows.ts`, `bus.ts`, `packages/sync/src/*` | `#17` `#39` `#41` `#12` `#40` `#44` `#45` |
| 4. 影子库、接手/接入/拉取与漂移 | [shadow-target-drift.md](./references/shadow-target-drift.md) | `targets.ts`, `executions.ts`, `takeover.ts`, `routes/{takeover,claims,environments}.ts` | `#11` `#24` `#42` `#13` `#14` `#15` |
| 5. 鉴权、限流与 CI 令牌边界 | [auth-ratelimit-ci.md](./references/auth-ratelimit-ci.md) | `routes/ci.ts`, `tokens.ts`, `rate-limit.ts`, `authz.ts`, `actions/execute/*` | `#8` `#9` `#10` `#16` |
| 6. 前端状态机、无障碍、缓存与文档 | [frontend-i18n-docs.md](./references/frontend-i18n-docs.md) | `NewProject.tsx`, `CanvasHistory.tsx`, `Environments.tsx`, `TokenSettings.tsx`, `i18n.ts`, `docs/*` | `#29` `#30` `#31` `#32` `#33` `#35` `#36` `#28` `#34` |

---

## 高频红线速查

### 1. PG 连接池、锁与冷启动
- **锁池与业务池必须彻底隔离**：`withAdvisoryLock` 独占 `lockSql` 专用池，严禁复用主查询池；`reserve()` 须有超时取消，`finally` 必须校验 `pg_advisory_unlock` 返回 `true`，否则销毁连接防会话锁泄漏（`#37`）。
- **冷启动迁移与初始化须入锁**：多副本 `migrate()` 全程包在 `platform:migrate` advisory lock 内，失败必须 `db.close()`（`#38`）；`POST /api/setup` 的已初始化检查（409）与令牌校验（403）必须同在 `SETUP_LOCK_KEY` 事务锁内（`#43`）。
- **心跳与连接池必设超时**：`openPg` 配 `connect_timeout`/`keep_alive`，`HaCoordinator.renew()` 单次续租与 `ha.stop()` 等待均须有界超时（`#23`）；定期清理崩溃节点遗留的过期 `ha_leases`（`#45`）。

### 2. 停机、后台队列、巡检与 SSE
- **停机必须先排空后关基础设施**：先防重入 + 停新巡检/关活跃 SSE/WS + `server.close()`，保持 `webhooks`/`ha`/`db` 存活等待在途请求与 `EnvLocks`/`refresher` 排空，最后才按 `webhooks → rooms → shadows → bus → ha → db` 关闭（`#19`）。
- **绝不二次改写 `interrupted` 申请**：`SWEEP_WHERE`、`closeStale`、`recheck`、重试/撤回均须保护 `status='failed' && result.code='interrupted'`，保留 `finish()` 覆写通道（`#18`）。
- **队列持久化与租约防踩踏**：Webhook 走 `webhooks.enqueueIn(tx)` 随业务事务落库，提交后再 `wake(true)`（`#20`）；`executeJob` 所有删除/重试 SQL 必带 `and locked_by = $...`（`#21`）；`close()` 排空或放锁后补广播 `webhooks.wake`（`#27`）。
- **SSE 订阅先于查初始态**：非 `once` 流先注册 `onAbort` + `subscribe` 缓冲再查 `unread`，心跳 `setTimeout` 必 `.unref()`，`stop()` 主动唤醒结束活跃流（`#26`）；显式 `sweep()` 不因非阻塞锁撞锁误推进 `done`，`onReconnect` 补 `kickLocal({ all: true })`（`#22`）。

### 3. 协作房间、派生刷新与影子缓存
- **跨副本 `flush` 与基线保护**：HA 下 `OpaqueRefresher.flush()` 须阻塞持 `job:derive:<branchId>` 锁循环追齐 DB；`ctx.replace` 与 `reset` 经 `runWithReset` 共用同一锁且直接传规范化 `model` 入参，禁止事后重读 `rooms.model`（`#17`）。
- **权限刷新单飞 + 代际防倒挂**：`Rooms.join` 必重查 `users.role, status`，经单飞串行队列与递增 `refreshGen` 在每次 `await` 后复查归属与代际（`#39`）。
- **WS `client` 服务端强隔离**：拒非法/保留字 `system`，内部键绑定 `${userId}:${rawClient}` 并经 `forPeer()` 还原；`readOnly` 拒 `op` 绝不推进 `processed[client]` 或写 `room_rejections`（`#12`）。
- **缓存指纹完整 + 跨副本失效**：`Shadows` 缓存须按完整配置指纹校验并接 `shadows.forget` / `onReconnect` 清空（`#41`）；跨副本同步 `peers`，大 `room.layout` 超 7500B 落库转轻量重载，远端布局清本地 `pendingLayout`（`#44`）；`loadRoom`/`catchUpFrom` 在 PG 用 `REPEATABLE READ` 防读撕裂且避免全表扫 `room_rejections`（`#40`）；空闲房间与内部 Map 有界清理，SQLite `getFresh` 走 `withRoomLock`（`#45`）。

### 4. 影子库、目标库与漂移
- **同实例影子库禁 `WITH (FORCE)`**：创建/认领/清理走维护库 advisory lock 串行化，建库捕获 `42P04` 回退复用，删库前先关自身连接、验 `SHADOW_MARK` 与验证锁，遇 `55006` 安静跳过（`#11`）。
- **跨副本环境状态写入必锁内验鲜度**：漂移检查（含 `recordError`）与预演不能只查进程内 `locks.busy()`，写 `setDrift` 前锁内核验 `url_enc` 与 `current_version_id`/`last_drift_check`（`#24`）；`pull` 调 `ctx.replace` 必传 `workingSeq` 并捕 `WorkingChangedError` 返 `409`（`#42`）。
- **恢复版本与接手边界**：恢复版本不将 `v.number` 写 `versions.seq`，`versionsInRange` 滤 `restored_at is null`（`#13`）；接手事务捕获 `isUniqueViolation` 转结构化错误且防信息泄露（`#14`）；`attach`/`claim` 复用连接并按实计连库限速（`#15`）。

### 5. 鉴权、限流与 CI 安全
- **共享出口防误杀 + 精确退回**：CI 缺头/格式非法直接内存 401 不扣桶，IP 触限时凭 `ActiveTokenCache` 放行活跃合法令牌强校验（`#8`）；`KeyedLimiter` 禁止 `arr.pop()`，用自增 ID 返回精确幂等 `refund()` 闭包（`#9`）。
- **权限传导必显式警示 & 写接口不盲重试**：允许创建 CI 令牌即间接获得 `allowTokens=true`（非生产默认开）环境免审批执行权，须在 UI/文档/ADR 明示（`#10`）；Action `curl` 必配 `--connect-timeout` / `--max-time`，但绝不对非幂等写接口默认自动重试（`#16`）。

### 6. 前端状态机、无障碍、缓存、i18n 与文档
- **向导与弹窗状态机闭合**：多步向导切组/改 URL/删环境精确失效缓存并配代次防乱序，按稳定 `key` 匹配、消费 SSE `event.code`、绑定确认态、成功后禁回退（`#29`）；409 冲突横幅与后续通用错误独立展示，实时降级 `readOnly` 自动关闭确认弹窗（`#30`）。
- **组件与文案细节**：不与全局 `focusgroup-polyfill` 叠加手写未判 `defaultPrevented` 的方向键监听（`#31`）；条件行添加禁用满额项并防重复（`#35`）；变更环境失效 `activity`/`migration`/`requests` 缓存（`#32`）；审计动作/操作名与中英文 `i18n.ts`、`activity.ts` 全对齐（`#33`）；不往句号后拼后缀、可空版本号不渲染 `v—`（`#36`）。
- **文档与注释同步收口**：功能合入同步清理 `docs/`“当前的限制”与源码单进程旧注释，核对 Webhook 事件、收件箱类型与预检拒绝/`noop` 边界（`#28` `#34`）。

---

## 提交前自检清单（Pre-PR Checklist）

提交代码或发起审查前，对照改动范围逐项勾选：

### 并发、锁与 PostgreSQL HA
- [ ] 是否新增了跨副本锁或长期独占连接？是否使用独立锁池、设置了 `timeoutMs`、并在解锁失败时销毁连接？（`#37` `#23`）
- [ ] 是否涉及冷启动 DDL、初始化或并发建库/接手？是否已加跨副本锁、处理 `isUniqueViolation` / `42P04` 并在失败路径关闭已建连接池？（`#38` `#43` `#11` `#14`）
- [ ] 是否修改了 `EventBus` 事件、内存缓存（如 `Shadows` / `ActiveTokenCache` / `Rooms`）或后台任务？是否同时处理了**跨副本广播**与 **`bus.onReconnect` 补偿/清空**？（`#8` `#22` `#41` `#44`）
- [ ] 多副本下是否有“先查内存态/锁外检查 → 再写库”的 TOCTOU？是否改为锁内校验（含 `locked_by`、`url_enc`、`expectedSeq`、`refreshGen`）？（`#17` `#21` `#24` `#39` `#42`）

### 停机、队列与实时连接
- [ ] 是否新增了后台定时器、SSE/WS 长连接、在途异步任务或连接池？定时器是否 `.unref()`，并在 `shutdown.ts` 正确接入 `stop()` / `drain()` / `close()` 顺序？（`#19` `#26` `#27`）
- [ ] 是否新增了 Webhook 或异步副作用？是否通过 `webhooks.enqueueIn(tx)` 随业务事务原子入队并在提交后 `wake(true)`？（`#20`）
- [ ] 是否改动了执行申请巡检或状态流转？`interrupted` 失败申请是否仍受保护且 `finish()` 兜底可达？（`#18`）
- [ ] 新增或修改的测试（尤其调用 `createApp` / `Webhooks`）是否在结束时 `await` 关闭了后台轮询与连接池？（`#25`）

### 目标库、安全与 CI
- [ ] 是否触及同实例影子库？确认未使用 `WITH (FORCE)` 且清理前已关闭自身连接？（`#11`）
- [ ] 是否触及鉴权、限流、WS 协议或外部连库？确认无共享 IP 误杀、无 `arr.pop()` 错退、WS 标识已按用户隔离、连库限速按实扣减？（`#8` `#9` `#12` `#15`）
- [ ] 是否新增或调整了权限边界（如令牌、审批绕过）或 CI 脚本？是否同步检查了 UI 警示、超时保护与非幂等防重试？（`#10` `#16`）

### 前端、i18n 与文档
- [ ] 多步向导/弹窗是否在切换上下文、SSE 报错、409 重试失败或实时 `readOnly` 降级时状态闭合？（`#29` `#30` `#35`）
- [ ] 是否使用了 `focusgroup`？确认未叠加冲突的手写键盘监听？（`#31`）
- [ ] Mutation 成功后是否失效了全部关联查询（`activity`、`migration`、`requests` 等），而非仅依赖 SSE？（`#32`）
- [ ] 新增审计动作、操作名、文案、Webhook 事件或能力边界时，是否同步更新了 `i18n.ts`（中/英）、`activity.ts`、`docs/` 与源码过时注释？（`#33` `#36` `#28` `#34`）
