# 二、优雅停机、后台队列、巡检与跨副本 SSE（HA3）

涉及模块：`apps/server/src/main.ts`、`apps/server/src/shutdown.ts`、`apps/server/src/requests.ts`、`apps/server/src/routes/requests.ts`、`apps/server/src/webhooks.ts`、`apps/server/src/executions.ts`、`apps/server/src/drift-scheduler.ts`。

---

## 1. 停机未排空在途请求与迁移即关 `webhooks`/`ha`/`db` 且无信号防重入（`#19` · Critical）

- **【反模式】**
  1. 收到 `SIGINT`/`SIGTERM` 后不等待 `server.close()` 回调与在途环境迁移锁，立刻顺序执行 `webhooks.close()` → `ha.stop()` → `db.close()` → `process.exit(0)`；
  2. 信号处理器无防重入保护，重复信号并发跑两遍停机；
  3. 提前调 `db.close()`（`sql.end()` 将连接池置 `ending`），随后在途请求或迁移收尾查询全部直抛 `CONNECTION_ENDED`。
- **【会出什么事】**
  1. 目标库迁移刚提交完成，写平台库 `versions.executed_at`（`confirmVersion`）与 `requests.finish()` 因 `CONNECTION_ENDED` 失败或被 `process.exit(0)` 强杀，永久丢失执行标记与申请终态；
  2. `webhooks.close()` 提前置 `closed = true`，在途请求收尾事件被静默丢弃；
  3. 提前删 `ha_leases` 导致他副本立刻将在途迁移误判为 `interrupted`。
- **【Dowel 正确做法】**（已验证于 `shutdown.ts` / `main.ts` / `shutdown.test.ts`）
  1. 幂等防重入：重复信号复用同一个 `stopping` Promise，并挂 `.unref()` 兜底强制超时（如 25s，超时强清残留连接并单次退出）；
  2. 严格按以下顺序停机：
     - 停新后台任务并切断长连接：`drift.stop()`、`requests.stop()`（主动唤醒关闭活跃收件箱 SSE）、`refresher.stop()`；
     - 发起 `server.close()`、优雅断开在线 WS 与空闲 keep-alive 连接；
     - **保持 `webhooks`、`ha`、`db` 存活**，等待 `server.close` 与 `exec.locks.drain()` / `refresher.drain()` / `drift.drain()` / `requests.drain()` 全部排空；
     - 最后依次关闭：`webhooks.close()` → `rooms.flush()` → `rooms.close()` → `shadows.close()` → `bus.close()` → `ha.stop()` → `db.close()`。

---

## 2. `runSweep` 全量巡检二次改写刚恢复的 `interrupted` 申请并击穿 `finish()` 兜底（`#18` · High）

- **【反模式】**
  1. `SWEEP_WHERE` 包含所有 `'failed'` 状态且未排除 `result.code === 'interrupted'`；
  2. `runSweep({ all: true })` 先执行 `recoverInterrupted()` 将离线副本的 `executing` 改为 `failed` + `interrupted` 并发送失败通知/Webhook，紧接着同轮又用 `SWEEP_WHERE` 把同一条申请捞出，经 `closeStale` 二次改写为 `invalid`/`expired`；
  3. `recheck`、详情操作与 `decideIn` 允许对 `interrupted` 申请直接重试、撤回或重检失效。
- **【会出什么事】**
  - 抹除 `interrupted` 中断原因，连发自相矛盾的第二条通知与 `request.invalidated` Webhook；更严重的是 `finish()` 仅允许覆写 `executing` 或 `failed(interrupted)`，被改成 `invalid`/`expired` 后，原节点短暂心跳抖动恢复完成时的 `finish()` 终态兜底被彻底击穿。
- **【Dowel 正确做法】**（已验证于 `requests.ts` / `routes/requests.ts`）
  1. 使用 `isInterrupted(req)` 与 PG/SQLite 双语法兼容的 `sweepWhere(dialect)`，在 `runSweep`、`closeStale`（锁内重查）及详情 `recheck` 中统一排除 `status = 'failed' && result.code === 'interrupted'`；
  2. `setStatus` 增加防线：仅允许携带 `extra.result` 的 `finish()` 覆写 `interrupted` 申请，并同步更新内存 `req.result`；
  3. `actionsFor` 与 `decideIn` 对 `interrupted` 申请禁用直接重试与撤回（返回 `409`），提示人工核对目标环境历史后再新建申请。

---

## 3. 业务路径提交后异步 `emit` Webhook，存在崩溃丢通知窗口（`#20` · Medium）

- **【反模式】**
  - 虽已实现事务内持久化方法 `webhooks.enqueueIn(tx, ...)`，但业务代码在事务 `COMMIT` 之后才调用不 `await` 的 `this.webhooks.emit(...)` 异步写 `webhook_jobs`。
- **【会出什么事】**
  - 进程在事务提交后、异步写 `webhook_jobs` 完成前遇到 OOM/`SIGKILL` 或数据库瞬断，审计与收件箱已落库但 Webhook 通知永久丢失，违背持久化不丢通知的承诺。
- **【Dowel 正确做法】**（已验证于 `requests.ts` / `routes/requests.ts` / `webhooks.ts`）
  1. 在所有带平台库事务的业务路径（申请创建、审批、驳回、撤回、过期/失效、中断恢复、`finish` 等），于事务提交前 `await webhooks.enqueueIn(tx, ...)` 原子写入 `webhook_jobs`，回滚自动零残留；事务提交后在 `flushEffects` 统一调用 `webhooks.wake(true)` 唤醒本地与集群；
  2. 对 `afterDirectRun` / `afterTokenRun` 等收尾路径，同步 `await webhooks.enqueueIn(...)`（生产非 noop 场景合并进写 `inbox_items` 的同一事务）再 `wake(true)`，确保接口返回前事件已落盘。

---

## 4. `webhooks.ts` `executeJob` 删除与重试更新未校验 `locked_by`（`#21` · Medium）

- **【反模式】**
  - `executeJob` 中 hook 停用删除、投递完成删除以及失败重试 `update webhook_jobs set attempts = ..., locked_by = null, locked_until = null` 仅写 `where id = $1`，未校验 `and locked_by = $...`。
- **【会出什么事】**
  - 副本 A 持锁期间因 GC/慢响应超过 `leaseMs`，副本 B 接管任务（`locked_by = 'B'`）并推进 `attempts`；副本 A 迟到的 `update`/`delete` 会清空副本 B 的锁导致第三方并发重复投递、用旧值回退 `attempts` 或直接误删任务。
- **【Dowel 正确做法】**（已验证于 `webhooks.ts` / `webhooks.test.ts` / `ha-jobs.test.ts`）
  - 所有持锁任务的状态写回（停用删除、终态删除、PG/SQLite 失败重试更新）统一追加 `and locked_by = $...`（绑定当前 `this.workerId`）；
  - 重试更新附带 `returning id`，仅在确实命中行时才调度 `scheduleWake`。

---

## 5. `requests.ts` `sweep()`/`drain()` 撞非阻塞锁误推进 `done` 与 `onReconnect` 漏巡检（`#22` · Medium）

- **【反模式】**
  1. `drain()` 调 `tryWithJobLock('requests.sweep', ...)` 未获锁返回 `0` 时，仍清空 `this.pending` 并推进 `this.done = gen`；
  2. `bus.onReconnect` 只重推未读数与 `requests: true`，未触发全量巡检补漏。
- **【会出什么事】**
  1. 显式调用 `await requests.sweep(...)` 在多副本撞锁时提前返回 `0`，违背等待契约；局部不同环境的 `kick` 在总线瞬断期被本地静默丢弃；
  2. 总线断连期间错过的 `requests.kick` 无人补巡，申请状态延迟失效。
- **【Dowel 正确做法】**
  1. 区分后台事件/定时驱动的非阻塞巡检与显式 `await sweep()`：显式 `sweep()` 使用带超时的阻塞分布式锁确保真正执行完毕再推进 `done`，未获锁时不得误推进调用者的 `done` 或静默清空未执行的局部 `pending`；
  2. `bus.onReconnect` 回调内补充 `this.kickLocal({ all: true })`。

---

## 6. 收件箱 SSE 先查后订丢事件、心跳未 `unref` 且停机不主动收流（`#26` · Low）

- **【反模式】**
  1. `GET /api/me/inbox/stream` 先查并发送初始 `unread`，再调用 `requests.subscribe(...)`；
  2. 25s 心跳 `setTimeout` 未调用 `.unref?.()`；
  3. `requests.stop()` 不通知活跃 SSE 流退出。
- **【会出什么事】**
  - 查初始值到订阅之间的 `inbox.changed` 事件丢失，角标漂移；心跳定时器和长挂 SSE 拖住优雅停机。
- **【Dowel 正确做法】**（已验证于 `requests.ts` / `routes/requests.ts`）
  1. 非 `once` 模式下**先注册 `s.onAbort` 与 `requests.subscribe`（期间到达事件入缓冲队列），再查询并发送初始 `unread`**，随后消费缓冲进入主循环；
  2. 心跳 `setTimeout` 必须调用 `t.unref?.()` 并在唤醒后 `clearTimeout`；
  3. `Requests` 维护 `stopped` 标记与 `stopListeners`，`requests.stop()` 立即唤醒并优雅关闭所有活跃 SSE 流（`start()` 复位状态）。

---

## 7. `webhooks.close()` 排空入队或放锁后未广播 `webhooks.wake`（`#27` · Low）

- **【反模式】**
  - `webhooks.close()` 入口即置 `this.closed = true`，导致正在排空的 `enqueuing` 写完后跳过 `wake(true)`，释放本副本残留 `locked_by` 行锁后也不广播 `webhooks.wake`。
- **【会出什么事】**
  - 虽有其他副本 1s 轮询兜底不丢任务，但滚动发布/缩容时引入无谓的接管延迟。
- **【Dowel 正确做法】**
  - 在 `Webhooks.close()` 排空 `enqueuing`/`inFlight` 并释放残留 `locked_by` 后（此时 `bus` 尚未关闭），若期间有新入队或释放了非零行锁，向 `this.bus` 发一次 `{ t: 'webhooks.wake' }`（忽略发布异常）。

---

## 8. HA / Webhook 测试漏覆盖硬崩溃接管与未关闭后台轮询（`#25` · Low）

- **【反模式】**
  1. HA 测试将错误行为（如跨副本 `flush` 跳过）写进断言；模拟崩溃前先等 `locked_by = null` 再优雅关闭，未测“持锁硬崩溃 + 等 `locked_until` 过期接管 + 过期前不重投”；
  2. `Webhooks` 构造即自启 `pollTimer`，但测试里调用 `createApp` 后未 `await webhooks.close()`（甚至调用了 `close()` 却漏 `await`）。
- **【会出什么事】**
  - 线上最致命的持锁硬崩溃与租约过期边界缺乏回归保护；测试销毁数据库时后台轮询仍在并发打连接池，造成偶发竞态报错与句柄泄漏。
- **【Dowel 正确做法】**
  1. 所有涉及 `Webhooks` / `createApp` 的测试在 `afterEach`/`afterAll` 统一 `await webhooks.close()`（绝不漏 `await`）；
  2. HA 队列测试必须覆盖 `locked_by` 非空硬崩溃、过期前不重投、`locked_until` 过期后他副本自动接管，以及结合 `#18` 的环境变更/过期中断恢复用例。
