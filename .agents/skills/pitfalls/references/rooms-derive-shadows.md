# 三、无状态实时协作房间、派生刷新与影子库缓存（HA2 / Sync）

涉及模块：`apps/server/src/rooms.ts`、`apps/server/src/rooms/*`、`apps/server/src/derive.ts`、`apps/server/src/shadows.ts`、`apps/server/src/bus.ts`、`apps/server/src/app.ts`、`apps/server/src/routes/sync.ts`、`packages/sync/src/protocol.ts`、`packages/sync/src/server.ts`、`packages/sync/src/client.ts`。

---

## 1. 无粘性多副本下 `OpaqueRefresher` 跨副本 `flush` 空返、锁跳过漏刷与旧基线覆盖（`#17` · High）

- **【反模式】**
  1. 仅收到 WS 提交的副本 A 调 `refresher.schedule(branchId)`；用户随后的 HTTP 发布/`/migration`/`/ddl`/`/verify`/历史恢复落到副本 B 时，`flush()` 只查本机内存 `timers`/`running`，空即 0ms 返回；
  2. 后台刷新用非阻塞 `tryWithJobLock`，拿不到锁直接放弃且不重排；
  3. `ctx.replace` 锁外依次调 `flush` → `rooms.replace` → 事后重读 `rooms.model(branch)` → `refresher.reset`；旧 `canonicalize` 结束后无条件回写 `branches.baseline`。
- **【会出什么事】**
  1. 跨副本发布/导出拿到未规范化的陈旧表达式或旧版本差异；
  2. 并发提交被跳过永久漏刷新；
  3. 旧 `canonicalize` 覆盖 `replace` 后的新基线，或 `rooms.replace` 与重读 `rooms.model` 之间的并发用户编辑被误当成规范基线写入并清掉待刷定时器。
- **【Dowel 正确做法】**（已验证于 `derive.ts` / `ha.ts` / `app.ts` / `rooms.ts` / `rooms/ops.ts`）
  1. HA 模式下 `flush(branchId)` 通过按分支串行队列 + 阻塞版 `withJobLock('derive:' + branchId, ..., { timeoutMs })`，基于 DB `branches.baseline` 循环追齐最新 `rooms.state` 后才返回（无变化跳过 `shadowOf` 与冗余写库）；
  2. 后台防抖 `runBackground` 拿不到锁时短延迟重排，持锁结束后若 `seq` 前进则循环补刷（设上限并重排）；`apply()` 在 `rooms.patch` 被拒时不覆写 `branches.baseline`；
  3. `ctx.replace` 统一走 `refresher.runWithReset(branch, model, () => rooms.replace(...))`，在 `job:derive:<branchId>` 锁内保持单向锁序（derive 锁 → room 行锁），并**直接使用规范化 `model` 入参重置基线**，绝不事后重读 `rooms.model`。
- **【2026-11-27 演进：按需规范化（ADR 0016）】**
  1. 后台防抖（`schedule` / `timers` / `runBackground`）已整体移除，编辑期间 0 影子库调用；`flush()` 只在关键出口调用，单机与 HA 统一阻塞持锁（超时 `DeriveBusyError` → `503 normalize_busy`），同分支排队未开始的 flush 合并；
  2. **反模式**：在带 `workingSeq` 的确认请求（恢复历史、应用版本、作废/取消作废同步工作副本、拉取/接入确认覆盖）里先 `flush()`——规范化写回推进 `seq`，用户确认立刻 `409 working_changed`（自冲突）。正确做法：只在返回 `workingSeq` 的预览/详情接口 flush；
  3. **反模式（黄金基线投毒）**：`!needsRefresh` 时把当前模型写成黄金基线、canonicalize 失败时“接受当前模型作为黄金基线”、恢复历史时把历史模型写成黄金基线。正确做法：黄金基线只在 canonical 替换或成功 canonicalize 后推进；非 canonical 替换走 `runWithoutReset`（同样排队持锁，不碰黄金基线）；已验证版本用 `canonical: 'ifClean'`（ADR 0017 / `#132`：验证记录按数据库完整版本号区分、SQL Server 生成列 `type` 规划器不比较，“已验证”不保证是当前影子库的规范形式，同时作为推进黄金基线前的防御性确认）；
  4. 显式 `normalize()` 停机中拒绝（`503 shutting_down`），`forget()` 后在途任务不回写黄金基线、也不报成功（`normalizeLocked` 入口及每个 await 之后复查 `forgotten`，期间抛的错也归为 forgotten：`flush()` → `skipped('forgotten')`，`normalize()` → `BranchForgottenError` / 404）；只读 `status()` 不拿锁、不连影子库。**反模式（删除顺序倒挂）**：删除项目事务提交后先 `rooms.kickBranches` / `shadows.forget*`、最后才 `refresher.forget()`，导致房间被踢或影子库关闭引发的异常先到达 catch 时 `forgotten` 仍为 `false`（`normalize()` 误回 500 / 422、`flush()` 误报 `store_failed`）。**正确做法**：事务提交后**先同步调用 `refresher.forget()`**，再踢房间、关影子库；并在 `POST /normalize` 的 `catch` 中（排除 `BranchForgottenError` / `RefresherStoppedError` / `DeriveBusyError` / `HTTPException` 后）**先于**类型化映射（`ShadowError` / `StepError` / `PlanError` / `InstanceLevelStatementError` / `NormalizeConflictError`）与通用报错复查 `branches` 存在性（查库失败保守视作仍存在；已消失且 `!resolved` 时退回限速并返回 404），以同时覆盖 PG 跨连接窗口以及请求停在 `rooms.model` 尚未入队时删除路由已执行 `forget()` 未打标记的窗口。
     **【补充：forget 只在本副本生效（`#153`）】** 反模式：删除路由只调本副本 `refresher.forget()`，其他副本既不清内存基线，在途任务也看不到 `forgotten`——收到 `shadows.forget` 关掉影子库后 `normalize()` 报 `422 shadow_unavailable`，`canonicalize` 恰好返回空时甚至报 `200 verified`（保存基线更新 0 行被静默忽略），`flush()` 报 `shadow_unavailable` / `store_failed` / `no_shadow`；另一个反模式是 `reset` / `runWithReset` 入口 `forgotten.delete()`，删除前已过权限检查的导入晚到时清掉标记，让旧任务给已删分支回写基线。正确做法：
     - 删除路由事务提交后**先** `await refresher.forgetBranches(branchIds)`（同步 forget 本副本 + 广播 `derive.forget`），再踢房间、关影子库；接收方处理器**同步** forget（不能先 await 再 forget，否则 `room.refresh` / `shadows.forget` 的处理可能先生效）；
     - 不依赖事件一定送达：失败路径（`shadowOf` 返回 `null`、`canonicalize` 抛错、写回 / 读回 / 保存基线抛错、`normalize()` 的 catch）复查 `branches` 存在性（查库失败保守视作仍存在；`shadowOf` 已知分支缺失或 `ShadowError.preConnect` 直接返回 `'forgotten'` / `'no_shadow'`，避免无环境项目 `no_shadow` 多查一次 `branches`），保存基线用 `update … returning id`，0 行按已删 forget；成功路径不加查询（稳态 0 额外 I/O）；
     - `bus.onReconnect` 与不带 `branchIds` 的退化 `derive.forget`：同步清空 `good`（PG 模式下它只是 `branches.baseline` 的副本，0 查库），只对 `running` 里的分支按 `branches` 复核打标记（没有在途分支时不查库）；不排队的 `status()` → `loadGood` 跨过 forget（`forgetGen` 变了）时不写回 `good`；排队的 `flush()` 轮到时 `rooms.state` 抛错（房间已被踢）也先复核，**首轮尚未读到任何房间状态时绝不编造空模型**，已删直接抛 `BranchForgottenError`（`app.onError` 统一映射 HTTP 404「项目不存在」，MCP 工具映射 `project_not_found`，MCP 资源映射 `ResourceNotFoundError`），后续轮次已读到真实状态才报 `skipped('forgotten')`，活分支照旧抛出；
     - `forgotten` 只随本地队列存在（排空即清），`reset` / `runWithReset` 不清它。回归见 `apps/server/test/derive-cross-replica.test.ts`（假总线逐一覆盖事件先到 / 丢失 × 各 await 步骤）与 `apps/server/test/ha-derive-forget.test.ts`（真实 PG 双副本，含强杀 LISTEN 重连）。
  5. **反模式（flush 后二次读房间 TOCTOU，#132 路径 B）**：关键出口调用 `await refresher.flush(branch)` 后再 `await rooms.model(branch)` 读一次房间——两次调用之间插进来的并发编辑没经过规范化判定，却会被冻进已验证版本或用于迁移 / DDL / 预览。正确做法：直接使用 `flush()` 返回的 `{ model, seq }`（发布、`resolveModelRef`、版本 `canvas-diff`、历史详情、拉取 / 接入预览均如此）；仅只读 MCP 读模型工具（`get_model` / `get_table` / `get_objects`）因需在同一把房间锁内原子拿到对象版本与板块，仍按设计在 `flush()` 后读 `canvasState`。
  6. **依赖（接手 / 接入领先版本直接作黄金基线，`#123`）**：接手（`restoreChain`）与接入领先版本（`attachAhead`，`canonical: true`）直接把目标库 `dowel.history` 里冻结的链头版本模型写成黄金基线，不再经过影子库规范化。其安全性依赖严格读回核对：当前执行读回校验（executor `verifyAndRecord`）已对四种方言严格校验（MySQL 表达式纯格式容忍已于 `#162` 移除），恢复时闭环验证（`verifyVersionChain`）也随 `#132` 增加了读回核对（verifier `readbackDiff`，与执行读回校验同一个比较，按冻结 scope 读回）。**反模式**：为某个方言重新放宽读回比较（例如恢复 MySQL 表达式纯格式容忍），或让恢复跳过读回核对，却不重新审视接手 / 接入领先版本路径——未规范化的链头版本模型会成为黄金基线，之后的对象相对它“看起来没变”而被永久跳过规范化。**取舍说明（ADR 0017）**：按需规范化只在 `Shadows.forProjectTarget` 选出的单一影子库（优先最低已知版本组）上做，而发布 / 重新验证的读回核对会在每个数据库完整版本的影子库上做；如果同项目内不同大版本对同一表达式的回显写法不同，非规范化版本那一侧会稳定地报 `readback_mismatch`。

---

## 2. `Rooms.join` 未重查 `users.role` 且与 `refreshLoadedLocal` 并发覆盖（`#39` · High）

- **【反模式】**
  1. `userActive()` 仅查 `select status from users where id = $1`，信任 WS 升级瞬间缓存的 `peer.user.role`；
  2. `join` 先把 `peer` 放进 `r.peers` 再 `await resolveRole(...)`，恢复后不检查 `r.peers.has(peer)` 与刷新代际直接写 `peer.role`；
  3. 连续多次 `room.refresh` 并发跑 `refreshLoadedLocal` 无互斥队列。
- **【会出什么事】**
  - 实例管理员在 WS 升级与 `join` 之间被降级，仍以 `'admin'` 权限混入私有项目；`join` 挂起期间被 `room.refresh` 降级或踢出，恢复后又被旧查询覆盖回 `'editor'`；多次 `room.refresh` 乱序完成导致旧结果反杀新降级。
- **【Dowel 正确做法】**（已验证于 `rooms.ts` / `rooms/access.ts` / `rooms/kernel.ts` / `rooms.test.ts` / `ha-rooms.test.ts`）
  1. 用 `fetchUserState()` 同时查 `role, status`，在 `join` 与 `runRefreshLoadedLocal` 中同步刷新 `peer.user.role` 后再 `resolveRole`；
  2. 为 `Rooms` 维护**单飞串行刷新队列 + 目标合并重跑**（全量/按分支）与**递增刷新代际**（`globalRefreshGen` / `branchRefreshGen`）；
  3. `join` 在每次 `await` 后检查 `r.peers.has(peer)` 与代际是否推进，代际变化则循环重算最新角色后再写入并下发。

---

## 3. `Shadows` 缓存跨副本无失效且仅校验 `scope`（`#41` · High）

- **【反模式】**
  1. `Shadows.forProject` 命中缓存仅校验 `hit.scope === scope`，不校验 `url`、`shadowUrl`、`production`、`allowSameInstance`、`schemas`；
  2. 改/删环境或删项目仅调本副本 `shadows.forget(eid)`，不跨副本广播也不在 `bus.onReconnect` 清理。
- **【会出什么事】**
  - 副本 A 改连接串或把环境标为 `production: true, allowSameInstance: false` 后，副本 B 仍复用旧影子库甚至绕过生产禁同实例影子库的安全规则；删环境/删项目后他副本旧连接池永久泄漏。
- **【Dowel 正确做法】**（已验证于 `shadows.ts` / `bus.ts` / `routes/projects.ts`）
  1. 缓存条目保存 `projectId` 与完整配置 SHA-256 指纹（`name`/`url`/`shadowUrl`/`production`/`allowSameInstance`/`schemas`/`engineVersionNum`），指纹不匹配则先关旧连接再按新配置重建或拒绝；
  2. 引入 `invalidationGen` 与 `closed` 标记，防止并发 `prepareShadow` 完成后把旧句柄回写进缓存；
  3. 接入 `EventBus` 广播 `{ t: 'shadows.forget', origin, all?, envIds?, projectId? }`，删项目同步 `forgetProject(pid)`，`bus.onReconnect` 清空关闭本地缓存，`close()` 退订并释放全部连接。
- **【补充：晚到的 `shadows.forget` 不能盲目关闭（`#148`）】**
  - 反模式：远端 `shadows.forget` 到达就无条件 `forgetLocal`。事件是异步送达的，副本 B 可能在事件到达**之前**就已经 `forProject` 读到新配置、按新指纹重建了条目并开始 `verify`；晚到的事件把这个**按最新配置建立的**新连接 `close()` 掉，在途验证以“影子库不可用：连接失败：write CONNECTION_ENDED”失败（数据库本身正常）。`invalidationGen` 只覆盖“事件在 `prepareShadow` 期间到达”，覆盖不了“条目入缓存之后才到达”。
  - 正确做法：收到远端 `envIds` / `projectId` 事件先同步 `invalidationGen++`，再对每个本地条目按平台库最新配置复核指纹（`revalidateLocal`）——一致就保留，不一致 / 环境或项目已删（404）/ 读配置失败才关闭移除；`all` 与 `onReconnect` 仍然无条件清空。回归见 `apps/server/test/shadows-stale-forget.test.ts`。
- **【补充：关闭过的影子库句柄绝不重连；`forProject` 每次 await 之后都要复查（`#154`）】**
  - 反模式 1：外部影子库句柄（`pgShadow` / `mysqlShadow` / `mssqlShadow`）里 `conn ??= connect()`，`close()` 只关连接、不标记“已关闭”。缓存淘汰（配置变了、环境 / 项目被删）关掉的只是连接，拿着旧句柄的调用方下一步操作会悄悄连回旧影子库——例如环境刚被改成生产、禁止同实例影子库，在途请求的下一步仍连回同实例影子库，而且这条新连接不在缓存里、没人负责关闭。反过来只把 `close()` 改成“先置空 conn 再 await 关闭”更糟：被淘汰的句柄不再报错，而是静默重连。
  - 正确做法：三个外部实现共用 `serialShadowConnection`（`apps/server/src/targets/shadow-handle.ts`）：`close()` 同步标记已关闭再关连接；之后新调用的、排队中尚未开始的操作直接抛 `ShadowConfigChangedError`，不建连、拿不到正在关闭的连接；关闭时正在跑的那次操作无论成功失败都以 `ShadowConfigChangedError` 结束、结果丢弃（底层对在途语句的处理因方言而异：PG `sql.end({ timeout: 5 })` 客户端最多宽限 5 秒后销毁 socket，服务端语句可能继续跑到 `statement_timeout`；MySQL `pool.end()` 将 `COM_QUIT` 排在当前命令后，DDL 等当前语句会跑完；MSSQL `ConnectionPool.close()` 等待借出连接归还，当前请求或事务会跑完）。新增外部方言的影子库实现必须复用它，不要自己写 `conn ??=`。SQLite `:memory:` 影子库同样遵守关闭后拒绝的契约。
  - 反模式 2：`forProject` 只在某个 await 之前查一次 `closed` / `invalidationGen` 就淘汰旧条目、调 `prepareShadow` 或 `cache.set`。无论是读配置（`this.env` + 白名单复查）、关掉缓存里过期的条目（`forgetLocal`）还是 `prepareShadow` 都需要 await，期间可能又来一次失效事件、其他副本并发写入了最新条目或发生 `Shadows.close()`——不复核就直接关掉指纹不同的缓存条目或拿旧快照去 `prepareShadow`，或者重读配置之后重新 `cache.get` 却不核对是否还是重读之前看到的那一个对象就关掉，都会把刚按最新配置建好的条目误杀（甚至反手缓存旧快照）；不复核就 `cache.set`，则会把旧配置句柄或关闭之后建出的句柄放进缓存（没人关、拖住停机）。同理，`forgetProjectLocal` 先查库再逐个 `forgetLocal`、`pruneRemovedForProject` 查库后不核对身份直接淘汰，也会误杀并发期间按新配置入缓存的条目。
  - 正确做法：`forProject` 在 `prepareShadow` 之前通过 `resolveBeforePrepare`、之后通过 `admit`，**每次 await 之后**都重新检查 `closed`、失效代际和缓存中的冲突条目；只要代际推进或条目指纹不一致就先重读最新配置再决定谁过期，且重读后**仅关闭重读之前就已经观察到的同一缓存对象**（`stale === hit` / `stale === existing`）且重读期间代际未推进（被并发替换或代际推进则回循环开头重评）；`forgetProjectLocal` 先同步推进代际并摘除旧缓存再去关闭与查库，`pruneRemovedForProject` 在查库前先快照再用对象身份校验淘汰。复核次数有上限，用尽抛 `ShadowConfigChangedError`。精确保证：只要决策时刻可读配置是最新的、或缓存已有新条目、或失效事件已送达，绝不关闭指纹与最新配置一致的条目，也绝不用已知过期的快照调 `prepareShadow`；跨副本客观边界：若缓存为空、远端 `shadows.forget` 尚未送达且唯一一次读配置拿到的就是旧快照，可能暂按旧配置建库，直至事件送达由 `revalidateLocal` 关闭。
  - 错误映射：`ShadowConfigChangedError`（“影子库配置已变更，请重试”，不带“影子库不可用：”前缀）是可重试的暂时状态：HTTP 全局 503 + `shadow_config_changed`（规范化路由同样），MCP 工具错误码 `shadow_config_changed`；发布遇到它不能当成“影子库不可用”发布成未验证版本，多版本验证 / 选影也不能把它当成该版本组不可用而跳过，必须整体抛出；派生 flush 安静跳过（`shadow_unavailable`）。前端 `api.ts` 按错误码换成中英文界面文案。回归见 `apps/server/test/shadow-closed.test.ts`。

---

## 4. WS `hello.client` 未校验归属与保留字 `system`，可冒用静默丢弃他人编辑（`#12` · Medium）

- **【反模式】**
  1. `hello` 直接信任客户端上报的 `msg.client`，不校验非法字符/长度/保留字 `'system'`，也不与当前认证用户绑定；
  2. `Room.process()` 拒绝 `readOnly` 成员的 `op` 后仍推进 `s.processed[client] = op.n` 并写 `room_rejections`。
- **【会出什么事】**
  - 同项目成员甚至只读 `viewer` 从广播的在线列表拿到他人 `client` ID 后冒用握手并抢发 `op`，强行推进受害者的 `processed[victimClient]`，导致受害者后续合法编辑命中 `op.n <= done` 被**静默丢弃且无任何报错**；冒用 `'system'` 会干扰系统 `replace`/`patch`。
- **【Dowel 正确做法】**（已验证于 `packages/sync/src/{protocol,server}.ts` / `apps/server/src/rooms.ts` / `apps/server/src/rooms/{client-scope,ops}.ts`）
  1. `isValidClientId()` 严格校验长度与字符集并拒绝大小写不敏感的 `'system'`；禁止同一连接在绑定后变更 `client`（非法关 `4400`，同用户同 `client` 重连踢旧连接 `4409`）；
  2. 服务端进入 `Room` 与落库的同步键统一隔离为 `${peer.user.id}:${rawClient}`，同步重写 `op.reads` 引用，广播 `commit` 时经 `forPeer()` 仅向本人还原原始 `client`（对其他连接置空，不泄露内部键）；
  3. `readOnly` / `viewer` 的 `op` 直接拒绝返回 `reject`（在服务端内存短路不占行锁），**绝不推进 `s.processed[client]`、不写 `room_rejections`、不污染 `outcome`**。

---

## 5. `loadRoom`/`catchUpFrom` 无锁 `READ COMMITTED` 读撕裂与全表扫 `room_rejections`（`#40` · Medium）

- **【反模式】**
  1. 无锁 `READ COMMITTED` 下先查 `room_commits` 再查 `room_rejections`；
  2. 每次 `catchUpFrom`（含每次 `op` 行锁内、`hello`、`getFresh`、`room.commit`）全量读取并重放该分支全部历史 `room_rejections`。
- **【会出什么事】**
  1. 两次查询之间若他副本提交了 `op(n=1)` 并拒绝了 `op(n=2)`，本副本读到落后 `seq` 却配了 `lastProcessed = 2`，客户端收到 `snapshot`/`welcome` 后按 `p.n > lastProcessed` 直接丢弃待确认队列中已提交的 `op(n=1)`；
  2. 随历史拒绝记录增长，每次操作与行锁持有时间线性恶化。
- **【Dowel 正确做法】**
  1. PG 模式下将 `loadRoom` 与无写锁的 `catchUpFrom` 放入同一只读 **`REPEATABLE READ`** 事务，保证 `room_snapshots` / `room_commits` / `room_rejections` 来自同一 MVCC 一致性快照；
  2. 为 `room_rejections` 引入单调序号/游标索引实现增量拉取，杜绝每次全表扫描。

---

## 6. 跨副本在线 `peers` 不可见、大画布 `room.layout` 超限丢弃与 `pendingLayout` 覆写（`#44` · Medium）

- **【反模式】**
  1. `peerList` 只遍历本副本 `r.peers`，无跨副本在线成员同步；
  2. 自动布局把全部表坐标发进单条 `room.layout`（约 110–150 张表即超 `MAX_EVENT_BYTES = 7500`），超限后 `EventBus` 直接丢弃；
  3. 收到远端 `room.layout` 时未清理本地 `r.pendingLayout` 对应表键；设 `layoutTimer` 放在 `await this.publish` 之后；`flush()` 仅判断 `if (!r?.layoutTimer)` 且不等待在途 `flushLayout`。
- **【会出什么事】**
  - 不同副本的协作者彼此不可见；大画布自动布局对其他副本完全不同步；本地防抖定时器晚触发用旧坐标覆写远端新坐标；停机或发布 `flush()` 漏刷挂起窗口与在途布局。
- **【Dowel 正确做法】**
  1. 收到远端 `room.layout` 时立即从 `r.pendingLayout` 删除对应表键；将 `layoutTimer` 调度提前到 `await this.publish` 之前；在 `Loaded` 上追踪 `layoutFlushing` Promise，`flush()` 同时检查 `Object.keys(r.pendingLayout).length > 0` 并等待在途落库完成；
  2. `room.layout` 超 `MAX_EVENT_BYTES` 时立即落库 `branches.layout` 并广播轻量重载事件（如 `{ t: 'room.layout.reload', branchId }`），接收副本从 DB 拉取后推送给本地 peers；
  3. 经 `EventBus` 按 `replicaId` 隔离同步轻量在线成员快照，结合 `ha.aliveNodes()` 与重连全量同步清理离线节点残留。

---

## 7. 空闲房间与 `Room` Map 无界常驻 + SQLite `getFresh` 未提交脏读（`#45` · Low）

- **【反模式】**
  1. HTTP 只读接口加载或成员走空后（`peers.size === 0`）房间永不卸载，持续响应 `room.commit` 查库追赶；`Room` 内 `outcome`、`lastWriter`、`rejections` 无容量上限；
  2. SQLite 且 `!r.dirty` 时 `getFresh` 绕过 `withRoomLock` 直接返回内存 `r`，而写入路径在事务 `COMMIT` 前已就地修改 `r.room.model`/`seq`。
- **【会出什么事】**
  - 长期运行内存与无效 DB 查询单调增长；SQLite 并发读可能读到即将回滚的未提交内存态。
- **【Dowel 正确做法】**
  1. 为空闲房间（`peers.size === 0` 且无 `pendingLayout`/在途写入）配置空闲超时卸载，对 `outcome`/`rejections` 做有界裁剪并在对象删除时清理 `lastWriter`；
  2. SQLite 模式下 `state()`/`model()`/`modelAt()` 同样经 `withRoomLock` 读取快照副本，彻底消除脏读窗口。
