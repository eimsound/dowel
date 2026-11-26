# 四、影子库生命周期、目标库接手/接入/拉取与漂移检测

涉及模块：`apps/server/src/targets.ts`、`apps/server/src/shadow.ts`、`apps/server/src/executions.ts`、`apps/server/src/takeover.ts`、`apps/server/src/rooms.ts`、`apps/server/src/rooms/*`、`apps/server/src/routes/{wizard,takeover,claims,environments}.ts`。

---

## 1. 同实例影子库建/清无互斥，且 `dropSameInstanceShadow` 用 `WITH (FORCE)` 强杀验证连接（`#11` · Medium）

- **【反模式】**
  1. `ensureSameInstanceShadow` / `dropSameInstanceShadow` 生命周期无跨请求互斥，首次并发建库未处理 `42P04`（`duplicate_database`）回退复用；
  2. `dropSameInstanceShadow` 直接执行 `DROP DATABASE IF EXISTS ... WITH (FORCE)`；
  3. 路由清理同实例影子库前未先关闭本请求自身的影子库连接。
- **【会出什么事】**
  - 请求 1 清理（含正常返回 `409 working_dirty_confirm` 的分支）会无视验证锁强杀并发请求 2（如版本发布 `verifyScripts`）的连接（PG `57P01`）；`shadow.ts` 把 `57P` 归类为 `ShadowUnavailableError`，导致版本发布**静默标为未验证（`verified_at = null`）**，并污染 `Shadows.cache`。
- **【Dowel 正确做法】**（已验证于 `targets.ts` / `routes/{wizard,takeover,claims}.ts` / `shadow-pg.test.ts`）
  1. 在目标实例维护库连接上加会话级 advisory lock（`dowel_shadow_lifecycle` + 库名），串行化同实例影子库的创建、认领与清理；
  2. `ensureSameInstanceShadow` 持锁后复查 `pg_database`，遇 `42P04` / `23505` 回退 `claimShadow` 复用并保持 `created = false`；`claimShadow` 同步处理 `COMMENT ON DATABASE` 并发 `XX000`；
  3. **`dropSameInstanceShadow` 彻底禁止 `WITH (FORCE)`**：清理前路由先关闭自身影子连接；删库前校验 `SHADOW_MARK` 并以非阻塞方式探查验证锁 `dowel_shadow`，遇活跃连接 `55006` 或锁被占用时安静跳过（已打标的同实例影子库可安全复用）。

---

## 2. 漂移检查（含 `recordError`）与预演依赖进程内 `locks.busy()`，旧检查覆写新状态（`#24` · Medium）

- **【反模式】**
  1. `checkEnvDriftDetailed` 读完目标库释放目标库锁后，仅靠进程内 `x.locks.busy(env.id)` 判断就写回 `setDrift`；`catch` 路径调 `recordError` 直接写 `setDrift(..., 'error', ...)` 无任何并发校验；
  2. `dryRunExecution` 仅检查进程内 `locks.busy(env.id)` 做快速短路。
- **【会出什么事】**
  1. 跨副本下，副本 B 刚因 `runExecution` 的 `readback_mismatch` 写下 `drift_status = 'drifted'`，副本 A 进程内 `busy()` 恒为 `false`，随即用旧的 `'ok'` 覆盖隐藏漂移告警；
  2. `PATCH /environments/:eid` 更换连接串重置 `drift_status = 'unknown'` 后，另一副本拿着旧 `url_enc` 探测旧库的在途检查（正常或 `recordError`）回写污染新库记录；
  3. 跨副本预演无法快速短路，白白连库等 `DRY_RUN_LOCK_WAIT_MS`（3s）。
- **【Dowel 正确做法】**
  1. 为 `EnvLocks` 补齐跨副本非阻塞忙态检测/短暂持锁（PG 走 `withAdvisoryLock('env:' + id, ..., { tryOnly: true })`），同步接入 `dryRunExecution`；
  2. `checkEnvDriftDetailed` 的正常写回与 `recordError` 路径**均须在跨副本环境锁内复核** `url_enc` 未变且 `current_version_id` / `last_drift_check` 未被更新操作推进后，才写入 `setDrift`。

---

## 3. `POST /environments/:eid/pull` 调 `ctx.replace` 漏传 `workingSeq`（`#42` · Medium）

- **【反模式】**
  - 先在应用层做 `workingChanged()` 检查，随后调 `ctx.replace(a.branch, user, live.model, 'pullSchema')` 时漏传第 5 个参数 `expectedSeq`（`workingSeq`），也未捕获 `WorkingChangedError`。
- **【会出什么事】**
  - 从 `workingChanged()` 返回到 `ctx.replace` 拿到 `branches ... for update` 行锁的异步窗口内，本地或他副本协作者提交的编辑会被静默覆盖，破坏乐观并发保护。
- **【Dowel 正确做法】**
  - 凡带乐观锁语义的 `ctx.replace`（如 `pull`、`canvas-history` 恢复、`claims` 接入），**必须传入 `expectedSeq`** 做行锁内原子校验，并捕获 `WorkingChangedError` 返回结构化 `409 working_changed`（附带基于 `e.currentModel` / `e.currentSeq` 生成的最新预览）。

---

## 4. 恢复版本把 `v.number` 写进 `versions.seq` 且历史查询未过滤 `restored_at`（`#13` · Low）

- **【反模式】**
  1. `takeover.ts` 的 `insertRestoredVersions` 将版本号 `v.number`（`0, 1, 2, 3`）写入 `versions.seq`；
  2. `rooms/history.ts` 的 `versionsInRange` 仅按 `branch_id` 与 `seq` 区间查，未过滤 `and restored_at is null`。
- **【会出什么事】**
  - 接手项目后画布从 `seq = 0`（实际是链头 `v3`）起步，后续普通画布编辑的 `room_commits.seq = 1, 2, 3` 与恢复版本的 `versions.seq` 撞号，导致画布修改历史把未发布的普通编辑错标为“已发布 `v1`/`v2`/`v3`”；接入领先环境也会错标早期普通提交。
- **【Dowel 正确做法】**
  1. `versionsInRange` 必须追加 `and restored_at is null`，严格区分“在当前画布序列发布的版本”与“历史恢复版本”；
  2. `insertRestoredVersions` 写入恢复版本时不再把 `v.number` 冒充为画布提交序号 `versions.seq`（统一写哨兵值如 `-1`）。

---

## 5. 并发接手触发唯一约束冲突时 SSE 落入无错误码兜底（`#14` · Low）

- **【反模式】**
  - 在耗时的 `verifyVersionChain` 之前、事务之外检查 `projects.id` / `versions.id` 与 `pickProjectSlug`，而 `db.transaction(...)` 未捕获 `isUniqueViolation(e)`。
- **【会出什么事】**
  - 并发接手同一项目时，后提交方在事务内撞上 `projects.id` / `versions.id` / `(group_id, slug)` 唯一约束，落入兜底分支返回无错误码的“服务器内部错误”。
- **【Dowel 正确做法】**
  - 事务写入阶段显式捕获 `isUniqueViolation(e)`：
    - `projects.id` / `versions.id` 冲突转为结构化 `TakeoverRejected('project_exists', ...)`（注意不向无权限者泄露已有项目名称或归属）；
    - `(group_id, slug)` 冲突则重算 `pickProjectSlug` 重试一次或返回明确结构化冲突码。

---

## 6. `attach` / `claim` 连库限速仅扣 1 次与实际建连数严重失配（`#15` · Low）

- **【反模式】**
  - `attach` 单次请求实际建立 2–8 个外部连接（`inspectTarget` + `claimShadow` + `inspectAttach` + 影子验证/清理 + `claimInstance` + `readTargetState`），`claim` 建立 2 个连接，却都只调用 `connectionLimit(c, ctx)` 扣 1 次。
- **【会出什么事】**
  - 限流额度被成倍放大，且同一目标库反复 TCP/TLS/PG 握手造成不必要延迟与连接抖动。
- **【Dowel 正确做法】**
  1. 在 `attach` / `claim` 内复用同一目标 URL 的短生命周期连接（合并 `inspectTarget` / `inspectAttach` 及 `claimInstance` / `readTargetState`）；
  2. 对齐 `takeover.ts`，按实际剩余外部探测连接数调用 `connectionLimit(c, ctx, n)` 按实扣减。
