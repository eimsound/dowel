# 关闭编辑期自动影子库规范化，改为手动规范化按钮与关键出口按需触发

2026-11-27 决定（看板 #3「关闭编辑期自动影子库规范化，改为手动校验按钮与关键出口按需触发」）。

## 背景

派生数据（[04-ir-design.md](../04-ir-design.md) 2.6）原先在每次编辑提交后由 `OpaqueRefresher` 防抖 300ms 在后台调影子库：从黄金基线（`branches.baseline`）重放到当前模型，读回引擎规范形式（CHECK / 默认值 / 生成列 / 表达式索引 / 分区表达式，以及依赖改名后的不透明对象 DDL）并写回。实际使用暴露了几类问题：

1. **编辑期影子库负载与噪音**：每次提交都可能连影子库建一遍模型（大模型几秒到几十秒）；PG 多副本下还要抢 `job:derive:<branchId>` 锁、短延迟重排，画布修改历史里夹着大量 `derive` 提交。影子库是同实例 `{库名}_dowel` 时，这些负载落在目标实例上。
2. **乐观并发自冲突**：恢复画布历史、应用版本、作废 / 取消作废同步工作副本、拉取 / 接入确认覆盖前都先 `flush()`；刷新写回推进 `seq`，于是用户确认时带的 `workingSeq` 立刻对不上，自己跟自己冲突返回 `409 working_changed`。
3. **基线投毒**：没有待规范化对象时 `runLocked` 把当前模型直接写成基线；从零规范化失败时也“只能接受当前模型作为基线”；恢复历史时 `ctx.replace` 把可能没规范化过的历史模型写成基线。之后真正需要规范化的对象相对这份基线“看起来没变”，被永久跳过。

## 决定

1. **编辑期间零影子库调用**：删掉 `Rooms.onCommit → refresher.schedule()`、添加环境 / 接入后的 `schedule()`，以及 `OpaqueRefresher` 的 `schedule` / `timers` / `delayMs` / 后台防抖与 `tryWithJobLock` 重排。`Rooms.onCommit` 保留为可选空钩子。
2. **关键出口按需规范化（`flush()`）**：发布、`resolveModelRef`（`/migration`、`/ddl`、`/verify`，MCP `get_ddl` / `preview_migration` / `verify_migration`、`dowel://…/ddl`）、版本 `canvas-diff`、历史详情 `GET /history/:seq`、拉取预览（或不带 `workingSeq` 的直接覆盖）、接入预览（`!confirmOverwrite`）、MCP `get_model` / `get_table`。这些出口返回的 `seq` 是 flush 之后的，恰好就是后续确认请求要带的 `workingSeq`。
   - 单机与 HA 统一：本地按分支串行队列 + `withExclusiveLock`（PG 多副本是阻塞版 `job:derive:<branchId>`，超时抛 `DeriveBusyError` → `503 normalize_busy`）；队列里尚未开始的同分支 flush 合并成一次。
   - 锁内先用纯函数 `pendingRefreshIds(good ?? 空模型, cur)` 判断，没有待规范化对象就 **0 影子库 I/O** 返回 `clean`；`ShadowError`（没有影子库、连不上）与 canonicalize 失败都安静返回 `skipped`，不报错、不改基线——没有影子库的项目照样能看迁移、导出 DDL、发布未验证版本。
3. **确认阶段不再 flush**：`POST /history/:seq/restore`、`POST /versions/:vid/apply`、作废 / 取消作废的 `syncWorkingCopy`、拉取确认（`preview === false && workingSeq` 给定）、接入确认（`confirmOverwrite`）。它们的 `workingSeq` 来自上面已经 flush 过的预览。
4. **黄金基线不变量**：基线只在两种情况下推进——canonical 替换（`ctx.replace` 默认 `canonical: true`：导入 SQL、拉取、接入领先版本，走 `runWithReset`，用调用方传入的模型写基线，#17）与一次成功的 canonicalize（基线 = 本次规范化的模型 + 规范形式）。
   - 没有待规范化对象时不写基线；canonicalize 失败（连接 / SQL / 表达式错误）时不写基线。
   - 已验证版本的应用 / 作废 / 取消作废用 `canonical: 'ifClean'`：闭环验证比较的是影子库读回的结构而不是模型原文，“已验证”不保证模型里的表达式是规范形式（例如发布时 flush 因影子库不可用或写回冲突被跳过）。所以在 derive 锁内判断该模型相对当前黄金基线没有待规范化对象时才推进基线，否则只替换房间（之后由出口 flush 或手动规范化补齐）。不需要改平台库 schema。
   - 非 canonical 替换（`canonical: false`：恢复画布历史、未验证版本）走 `runWithoutReset`：同样排在本地队列与 derive 锁里（在途规范化先排空，不会被旧 canonical 覆盖），只替换房间、不碰基线。
5. **待规范化判定**（`apps/server/src/derive-pending.ts`，`derive.ts` 再导出）：
   - 表的“列上下文”：表沿 `partitionOf` 解析到根父表（分区子表没有自己的列；基线与当前模型各自解析，覆盖多级分区与 attach / detach，#134），按列名（MySQL / MSSQL / SQLite 忽略大小写）对齐两边的列；某个两边都有的列名对应列的 `type` / `typeRef`（含枚举完整限定名）/ `collation`（大小写不敏感的方言再加列名原文）不同即算变了——表达式按列名引用列，所以列名对调、删列后新建同名列也算（#133）；只在一边出现的列名（新增、删除、改名到新名字）不算；
   - 不透明对象：依赖或父对象完整限定名变了；`deps` 集合变了；依赖的列（按 ID 及按列名对齐）的 `type` / `typeRef` / `collation` 变了，或依赖表 / 父表的列上下文变了；DDL 文本变了；依赖的不透明对象本身待规范化（沿依赖传递，带环保护，#136）；
   - 带表达式的普通对象：表达式变了，或所在表的列上下文变了；列自己的默认值 / 生成列另按 ID 比较列自身类型；只有分区边界、没有表达式分区键的表不看自身列上下文，而是检查是否改挂到另一个分区父表，以及直接父表的分区键签名（策略、各键的列签名或表达式、opclass、collation；父表含表达式键或是解析不出来的存量字符串时再看父表的列上下文）是否变化——opclass / collation / 策略是有意的过近似；
   - 表达式直接写了枚举名（如 `'ok'::public.mood`，所在表不一定有列引用这个枚举，#146）：相对基线有枚举的名字绑定变了（改名、对调、换 schema、删除 / 新建），且对象的表达式（含不透明对象 DDL、直接父表的表达式分区键）里按词（忽略大小写）出现了其中某个枚举两边的名字。PG 按 OID 存表达式，读回时类型名跟着影子库里的绑定走；稳态下没有绑定变化，不做任何文本扫描；
   - MSSQL 持久化计算列（#145）：SQL Server 按表达式与被引用列的可空性推断 `is_nullable`，canonicalize 写回 `notNull`；列自己的 `notNull` 变了，或所在表按列名对齐的列 `notNull` 变了即待规范化。其他方言与非持久化计算列不看 `notNull`。
6. **canonicalize 自愈**：基线自己在影子库里建不出来（旧版本遗留 / 升级后不兼容，`StepError`）且没有依赖改名的不透明对象时，直接从空库建出 `next`（与增量迁移等价）；有改名依赖时如实报错。基础设施故障统一经 `isInfraFailure` → `toShadowError` 映射为 `ShadowError`。
7. **手动规范化接口与按钮**：
   - `GET /api/projects/:pid/normalize`（`project.read`，查看者即可）：`{ seq, pending, pendingCount, objects（≤50）, truncated, baseline, shadow }`，0 影子库 I/O、不拿 derive 锁；`shadow` 来自 `Shadows.configState`（`memory` / `configured` / `none`，纯平台库查询、复用 `candidatePriority`）。
   - `POST /api/projects/:pid/normalize`（新动作 `model.normalize`，编辑者以上；严格请求体 `{ env?: string }`）：外部影子库方言过连接限速（#15），预连接失败（`ShadowError.preConnect`）或静态 `validate` 不通过（`422 model_invalid`）精确退回（#8 #9）；指定的环境不存在（404）、`normalize_busy`、`shutting_down` 同样退回。未指定 `env` 时影子库句柄在 derive 锁内按需解析：基线等于当前模型时直接返回 `clean`（不解析、不连影子库，额度退回，`shadow` 为 `null`）；否则在影子库里 canonicalize、写回（`room_commits.op_name = 'derive'`）、推进基线，返回 `normalized` / `verified`。错误码：`422 shadow_unavailable`、`422 canonicalize_failed`（经 `scrubSecrets`）、`409 working_changed`、`503 normalize_busy`、`503 shutting_down`；规范化期间项目被删（分支被 `forget()`）返回 `404`（同项目不存在，#144；若尚未解析影子库句柄则精确退回限速额度）。不写 `audit_events`（派生写回已在画布修改历史里）。
   - 模型页底部状态栏（不进顶栏，`迁移` 仍是唯一 `.btn.primary`）：`bg-ok` 圆点 +“表达式已规范化”或 `bg-warn` 圆点 +“N 处待规范化”（查看者也能看到）；编辑者另有紧凑 ghost 按钮“规范化”：没有可用影子库或未同步时 `aria-disabled` 并说明原因（点击给中性提示），运行中 `disabled` + `aria-busy` + 旋转图标。成功后失效 `normalize` / `migration` / `ddl` / `canvas-history` / `history-head` 查询（#32）。关键出口（迁移预览 / 验证、发布、历史详情）与环境、schema 范围变更后也失效 `['normalize', pid]`：零改写的 flush 只推进基线、`seq` 不变，不主动重查状态栏会一直停在“N 处待规范化”。状态查询只在防抖后的 `seq` 追上当前 `seq` 时启用，避免同步恢复瞬间按旧 `seq` 多查一次。
   - 状态栏的影子库来源与服务端 `forProjectTarget` 对齐：先选最低已知版本组（该组不可用时依次回退），组内按显式 `shadowUrl` > 非生产 > 允许同实例的生产挑选，没有可用影子库时显示“没有可用的影子库”。

## 两种方案与取舍

| 方案                                  | 做法                                                         | 优点                                                                                        | 代价                                                                                        |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A. 保留后台防抖，修补自冲突与基线投毒 | 确认阶段跳过 flush；canonical 标记；失败不写基线             | 画布里的表达式“自己变成”规范形式，零操作                                                    | 编辑期影子库负载与 HA 锁争用依旧；`derive` 提交噪音依旧；行为难以预期（何时变、为什么没变） |
| **B. 按需规范化（采纳）**             | 编辑期零影子库调用；关键出口 flush；手动按钮；黄金基线不变量 | 编辑期零外部 I/O；影子库只在用户需要结果时才连；HA 锁只在出口争用；行为可解释（状态栏有数） | 画布里的表达式在规范化前显示用户原文；需要用户（或出口）触发；迁移 / DDL 第一次打开可能稍慢 |

选 B 的理由：迁移、DDL、发布、验证这些真正“要求规范形式”的地方都会先 flush，结果的正确性不受影响；画布上暂时显示原文是可以接受的（状态栏明确告诉用户还有几处没规范化，一键处理）。

另外两个被否决的方向：

- **手动“全量重查”入口**（`POST /normalize { full: true }`，配状态栏 / MCP 入口，不看黄金基线、从空库重新规范化全部对象）：用户无从判断什么时候该点；Dowel 尚未公开发布，没有旧逻辑留下的未规范化数据需要补救；按 [ADR 0017](0017-verified-means-executable.md)，发布时的读回核对会直接拒绝并报告写法不一致，不需要靠用户手动兜底。
- **在 IR 里给每个对象记“已规范化”标记**：消除不了三处根本耦合——规范形式只有引擎能给出、写回会推进 `seq`、导出要求规范形式；还要改 IR 的 `FORMAT` 与 `dowel.history` 的存储格式，并破坏 [04-ir-design.md](../04-ir-design.md) D7。

## 影响与边界

- 发布 / 迁移 / DDL 等出口的正确性不变：直接使用 `flush()` 返回的 `model` / `seq`（MCP 读模型工具仍在 `flush()` 后读 `canvasState` 以在同一把房间锁内拿到对象版本与板块）；没有影子库时与以前一样跳过（发布为未验证）。
- 停机：`stop()` 后 `normalize()` 拒绝（`503 shutting_down`），`flush()` 返回 `skipped`；`drain()` 等待在途任务（#19）。`forget()` 后在途任务不回写内存 / 库基线（#41 #44 #45），也不报成功：`flush()` 在已读到房间状态后返回 `skipped('forgotten')`，排队 `flush()` 在第一轮尚未读到任何房间状态前因房间已卸载而 `rooms.state` 抛错且分支已删时，**不得编造空模型**，而是抛 `BranchForgottenError`（`app.onError` 统一映射为 HTTP 404「项目不存在」，MCP 工具映射为 `project_not_found`，MCP 资源映射为 `ResourceNotFoundError`）；`normalize()` 同样抛 `BranchForgottenError`（#137 #144）。删除项目事务提交后必须**先**调 `refresher.forgetBranches(branchIds)`（同步 forget 本副本，再经 `EventBus` 广播 `{ t: 'derive.forget', branchIds }`），再 `rooms.kickBranches` 与 `shadows.forget*`，避免房间/影子库报错先到达 catch 时 `forgotten` 仍为 `false`；同一副本按 await 顺序发出的 NOTIFY 按提交顺序送达，其他副本因此先于 `room.refresh` / `shadows.forget` 收到 `derive.forget` 并在处理器里**同步** forget（#153）。事件晚到 / 丢失（总线断开、广播失败）时不靠事件：`OpaqueRefresher` 在失败路径（解析不到影子库、`canonicalize` 抛错、写回 / 读回 / 保存基线抛错、`normalize()` 抛任何错）上复查一次 `branches` 存在性（查询失败保守视作仍存在；`shadowOf` 在查不到分支行或 `ShadowError.preConnect` 时直接返回 `'forgotten'` / `'no_shadow'`，避免无环境项目的 `no_shadow` 常态出口多查一次 `branches`，仅返回 `null` 时走 `gone()` 复核），保存基线 `update … returning id` 更新 0 行也按已删处理——`flush()` 报 `skipped('forgotten')`、`normalize()` 抛 `BranchForgottenError`；稳态（成功路径）不加查询。`bus.onReconnect` 与不带 `branchIds` 的退化事件：同步清空本副本内存基线（PG 多副本模式下 `loadGood` 始终读 `branches.baseline`，内存里只是副本，0 查库），只对在途分支按 `branches` 复核、已删的打标记（没有在途分支时不查库）；不排队的 `status()` 读基线跨过 forget / 复核（代际 `forgetGen` 变了）时不写回内存。`forgotten` 标记只在该分支本地队列非空时存在（集合大小不超过在途分支数），`reset` / `runWithReset` 不清它（分支 ID 不复用，标记只打在确实已删的分支上）；`POST /normalize` 的 `catch` 在排除了已有明确语义的异常（`BranchForgottenError` / `RefresherStoppedError` / `DeriveBusyError` / `HTTPException`）之后，于所有类型化映射（`ShadowError` / `StepError` / `PlanError` / `InstanceLevelStatementError` / `NormalizeConflictError`）与通用报错之前复查 `branches` 存在性（查询失败保守视作仍存在；已消失且 `!resolved` 时退回限速并返回 404），同时覆盖 PG 跨连接 / 跨副本删除窗口以及请求停在 `rooms.model` 尚未入队时删除路由已执行 `forget()` 但未打标记的窗口。

> **2026-11-27 部分修订（按 [ADR 0017](0017-verified-means-executable.md)；MySQL 读回容忍于 #162 移除，其余随 Issue #132 的实现合入）**：
>
> - 决定 2：发布将不再属于“没有影子库或 `flush()` 被跳过时照常放行”的出口。没有可用影子库、或 `flush()` 返回 `skipped` 且仍有待规范化对象时，发布将被拒绝；查看迁移、导出 DDL 等其余出口不变。
> - 决定 4：按 ADR 0017，闭环验证增加了与执行读回校验一致的读回核对，“已验证”意味着同版本数据库上的读回校验一定通过；MySQL 原先 `alignMysqlImportedLive` 的表达式纯格式容忍已于 #162 移除，四种方言均按冻结的版本模型严格读回校验。`canonical: 'ifClean'` 仍保留，理由转为：验证记录按数据库完整版本号区分，在其他版本上验证通过的版本不保证是当前影子库的规范形式；SQL Server 生成列的 `type` 规划器不比较，“已验证”不约束它；以及推进黄金基线前的防御性确认。
> - 决定 4（Issue #123 安全不变量）：接手与接入领先版本时直接用链头版本模型作为黄金基线（`canonical: true`），依赖两道严格读回——执行读回校验（`verifyAndRecord`，当前已对四种方言严格，MySQL 表达式纯格式容忍已于 #162 移除）与恢复时闭环验证的读回核对（ADR 0017，随 #132 合入）。放宽其中任何一道，都要重新审视这条路径。
> - 「影响与边界」第一条“发布……正确性不变：……没有影子库时与以前一样跳过（发布为未验证）”已随 #132 废止：原做法会产生已验证却无法执行的版本，现在没有影子库不能发布；`flush()` 被跳过且仍有待规范化对象时发布在验证之前就被拒绝（`normalize_pending`，列出待处理对象）。

> **2026-11-28 部分修订（[ADR 0019](0019-mssql-explicit-vs-inferred-not-null.md)，Issue #161）**：
>
> - 决定 5「MSSQL 持久化计算列（#145）」：canonicalize 改为只写回引擎推断的 `ext.mssql.inferredNotNull`，不再改写显式 `notNull`；判定另加“列自己的推断值相对基线变了”（[ADR 0019](0019-mssql-explicit-vs-inferred-not-null.md)，Issue #161）。

> **2026-11-28 部分修订（按 [ADR 0020](0020-per-version-readback-truth.md)，Issue #201；待后续实现 PR 落地）**：
>
> - 工作副本按需规范化与状态栏继续保持单影子库（`Shadows.forProjectTarget` 优先最低已知版本组、拿到首个可用影子库即返回），用于维护单份基准模型；跨完整版本的读回差异改由发布 / 重新验证 / 接手时按数据库完整版本号分别记录至 `version_engine_diffs` 与目标库 `dowel.versions.version_diff`，不因跨版本回显差异将对象卡死在工作副本或发布口。
> - 补齐 SQL Server 的最低主版本（2019 / 2022 / 2025）选影优先排序，与 PostgreSQL、MySQL 保持一致。
> - 接手 / 接入领先版本的 #123 黄金基线安全不变量衔接 [ADR 0020](0020-per-version-readback-truth.md) 决定 5：恢复时按参与环境各可用数据库完整版本号逐组闭环验证，重建各版本差异记录。
