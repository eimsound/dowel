# 一、PostgreSQL 连接池、分布式锁与冷启动（HA1 / HA4）

涉及模块：`apps/server/src/db.ts`、`apps/server/src/ha.ts`、`apps/server/src/routes/setup.ts`、`apps/server/src/setup.ts`、`apps/server/src/main.ts`、`apps/server/src/app.ts`。

---

## 1. `withAdvisoryLock` 共用业务连接池、无 reserve 超时与解锁失败未销毁连接（`#37` · Critical）

- **【反模式】**
  1. 在 PG 模式下直接对业务共用 `postgres` 连接池（默认 `max = 10`、`queue_timeout = 0`）调用 `await sql.reserve()` 持有会话级 advisory lock，并在 `await fn()` 全程占用不归还；
  2. `await sql.reserve()` 无超时取消，池满时无视 `tryOnly: true` 或 `timeoutMs` 永久阻塞；
  3. `finally` 中仅 `.catch()` 打日志、不校验 `pg_advisory_unlock` 返回的 `ok === true`，随后无条件 `reserved.release()` 把连接放回空闲池。
- **【会出什么事】**
  1. **100% 自死锁与心跳饿死**：并发 `>= max` 个 `withAdvisoryLock`（如 `EnvLocks.acquire` + `drift.sweep` + `derive:<branch>`）占满主池后，回调内部继续向同一主池发起业务查询/事务全部进入无限等待，持锁方无法结束；`HaCoordinator.renew()` 同步饿死，15s TTL 到期被判离线，触发他副本误将在线迁移标记为 `interrupted`；
  2. 锁池拥塞时 `tryOnly` / `timeoutMs` 形同虚设，调用方永久卡死；
  3. 解锁失败或返回 `false` 后连接被归还复用，会话级 advisory lock 永久泄漏，后续依赖该锁的任务永远拿不到锁。
- **【Dowel 正确做法】**（已验证于 `db.ts` / `ha-foundation.test.ts`）
  1. 在 `openPg` 中按需延迟创建独立的 `lockSql` 专用锁池（默认 `max = 16`、`idle_timeout = 30s`），与主查询池和 `HaCoordinator.renew()` 物理隔离，`db.close()` 时用 `Promise.allSettled` 同步关闭两池并唤醒取消等待队列；
  2. 维护基于 `lockPoolMax` 的槽位计数与可取消 FIFO 等待队列，并对 `lockSql.reserve()` 叠加 `raceWithTimeout` 有界超时（超时后若迟到连接返回则自动 `release` 防泄漏），确保池满时 `tryOnly` / `timeoutMs` 严格按时限返回 `{ acquired: false }`；
  3. 加锁时记录 `pg_backend_pid()`，`finally` 严格校验 `pg_advisory_unlock` 返回 `rows[0]?.ok === true`；若非 `true` 或抛错，走 `destroyReserved` 销毁底层会话（必要时经主池 `pg_terminate_backend` 强杀后端）绝不放回空闲池。

---

## 2. 多副本并发冷启动 `migrate()` 无跨副本锁，且失败未关闭连接池（`#38` · High）

- **【反模式】**
  1. `migrate(db)` 直接并发执行 `create table if not exists dowel_migrations`、读 `max(version)` 与跑增量 DDL，全程无跨副本锁；
  2. `openPlatformDb` 未对 `await migrate(db)` 包裹 `try/catch` 清理资源。
- **【会出什么事】**
  1. 多副本首次部署或版本升级同时冷启动时，并发建 `dowel_migrations` 在 `pg_type_typname_nsp_index` 撞 `23505`，并发跑迁移 DDL 撞 `42P07` / `42701` / `23505`，竞争落败的副本直接崩溃；
  2. 迁移抛错或锁超时时连接池未关闭，残留活跃连接与句柄泄漏。
- **【Dowel 正确做法】**（已验证于 `db.ts` / `ha-foundation.test.ts`）
  1. PG 模式下将整个 `migrate(db)`（建表、查版本号、执行增量迁移循环）整体包裹在 `db.withAdvisoryLock('platform:migrate', ..., { timeoutMs: 60_000 })` 中串行执行，超时未获锁必须抛错绝不跳过；
  2. `openPlatformDb`（以及 `openSqlite` 初始化）在 `try/catch` 中捕获失败后立即 `await db.close().catch(() => {})` 再重抛错误；
  3. 集成测试覆盖真实 PG 下多副本 `Promise.all([openPlatformDb(url), ...])` 冷启动及 DDL 失败后 `pg_stat_activity`/`pg_locks` 归零。

---

## 3. `openPg` 缺连接/保活超时且 `HaCoordinator.renew()` 无单次超时（`#23` · Medium）

- **【反模式】**
  1. `openPg` 创建 `postgres` 连接池沿用默认 `connect_timeout: 30s`、`query_timeout: 0`、`keep_alive: 60s`；
  2. `HaCoordinator.renew()` 无单次超时，仅用 `if (this.inFlightRenew) return` 防并发；`ha.stop()` 无界 `await this.inFlightRenew`。
- **【会出什么事】**
  - 一旦某次续租落到半开 TCP 连接或拥塞池上挂起，`inFlightRenew` 持续非空，后续每 5s 的心跳回调全部直接跳过重试；15s 租约到期后存活副本被判离线，引发误接管与误判 `interrupted`；停机时 `ha.stop()` 也会被永久卡住。
- **【Dowel 正确做法】**
  1. 在 `openPg` 配置合理的 `connect_timeout`（如 5–10s）与 `keep_alive`（如 10–15s），注意不要用全局 `idle_timeout` 或会话超时破坏 `sql.listen` 长连接；
  2. `HaCoordinator.renew()` 为单次续租施加明确超时（事务内 `SET LOCAL statement_timeout` / `lock_timeout` 结合受控超时竞争），超时立即清理 `inFlightRenew`，保证下一心跳周期从池中取健康连接重试；
  3. `ha.stop()` 等待 `inFlightRenew` 必须带上限超时，避免停机死等。

---

## 4. `POST /api/setup` 锁外校验共享令牌 + 非主创副本内存 `ctx.setupToken` 不一致（`#43` · Medium）

- **【反模式】**
  1. `main.ts` 通过 `ensureSetupToken` 拿到多副本一致的持久化共享令牌后仅打日志，未同步更新或隔离 `ctx.setupToken`，导致非主创副本内存中仍是本机独立随机值；
  2. `POST /api/setup` 在 `pg_advisory_xact_lock(hashtext(SETUP_LOCK_KEY))` 事务锁**之外**调用 `needsSetup(db)` 与 `readStoredSetupToken(db)`。
- **【会出什么事】**
  - 双副本并发初始化时，副本 B 先过 `needsSetup`，副本 A 随后入锁完成建首个管理员并删掉 `instance_settings('setup_token')`；副本 B 紧接着读到 `stored.exists === false` 并回退比对本机未同步的随机 `ctx.setupToken`，错误返回 **`403 初始化令牌不正确`**，破坏“已初始化后一律返回 `409`”的接口契约。
- **【Dowel 正确做法】**
  1. 将 `countUsers(tx) > 0`（返回 `409`）与 `readStoredSetupToken(tx)` 令牌校验（返回 `403`）**全部移入 `SETUP_LOCK_KEY` 事务锁内部**，严格保持“先判已初始化，再验令牌”的原子顺序；
  2. 明确区分“单测显式传入的内存自定义令牌”与“多副本持久化共享令牌”，禁止共享令牌已消费后回落比对本机随机内存值；
  3. 用真实 PG 双副本并发 `POST /api/setup` 测试断言结果必为一个 `201` + 一个 `409`，绝不出现 `403`。

---

## 5. 崩溃节点遗留的过期 `ha_leases` 行永不清理（`#45` · Low）

- **【反模式】**
  - 仅在优雅停机 `ha.stop()` 时删除本副本的 `node:<uuid>` 租约行，不对长期过期的历史行做清理。
- **【会出什么事】**
  - 副本被 `SIGKILL` / OOM 强杀后，`ha_leases` 表会永久堆积大量过期 `node:<uuid>` 僵尸行。
- **【Dowel 正确做法】**
  - 在 `HaCoordinator` 心跳或分布式定时巡检中顺带清理过期已久的节点租约行（如 `expires_at < now() - interval '1 hour'`），保留短期内供排障观测的窗口即可。
