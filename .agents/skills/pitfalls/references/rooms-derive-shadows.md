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
  3. **反模式（基线投毒）**：`!needsRefresh` 时把当前模型写成基线、canonicalize 失败时“接受当前模型作为基线”、恢复历史时把历史模型写成基线。正确做法：黄金基线只在 canonical 替换或成功 canonicalize 后推进；非 canonical 替换走 `runWithoutReset`（同样排队持锁，不碰基线）；
  4. 显式 `normalize()` 停机中拒绝（`503 shutting_down`），`forget()` 后在途任务不回写基线；只读 `status()` 不拿锁、不连影子库。

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
  1. 缓存条目保存 `projectId` 与完整配置 SHA-256 指纹（`name`/`url`/`shadowUrl`/`production`/`allowSameInstance`/`schemas`），指纹不匹配则先关旧连接再按新配置重建或拒绝；
  2. 引入 `invalidationGen` 与 `closed` 标记，防止并发 `prepareShadow` 完成后把旧句柄回写进缓存；
  3. 接入 `EventBus` 广播 `{ t: 'shadows.forget', origin, all?, envIds?, projectId? }`，删项目同步 `forgetProject(pid)`，`bus.onReconnect` 清空关闭本地缓存，`close()` 退订并释放全部连接。

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
