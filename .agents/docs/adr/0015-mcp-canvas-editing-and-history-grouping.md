# MCP 画布编辑能力扩展与画布修改历史降噪

2026-11-26 决定（规划已确定，待实现；承接 [ADR 0014](0014-mcp-tokens-and-boundaries.md)）：Dowel **不在平台本体内置 LLM**，AI 能力聚焦外部 AI 编程助手经内置 MCP 服务（`POST /api/mcp`）**修改画布**。继续严格维持 ADR 0014 的两条安全红线（绝不连接目标库；不能发布版本，也不能提交、审批或执行迁移）；OAuth 2.1 暂缓，沿用个人 MCP 令牌（`dwm_…`，表 `mcp_tokens.kind` 仍保留扩展点）。

1. **画布布局层边界：开放板块（Section）读写，不开放像素坐标。**
   - 像素坐标继续由前端 Web Worker `elkjs` 自动排布（无持久化坐标的新表排到已有内容右侧）与人工拖拽管理，MCP 不暴露坐标写接口，避免 LLM 二维排版重叠或制造布局并发噪音。
   - 板块读写归入现有 `write` scope（且要求项目编辑者及以上角色），不新增第 4 个 MCP scope。
   - 新增增量语义工具 `manage_sections`（支持创建、重命名、改色、删除板块，以及将表加入或移出板块；单表移入新板块时自动从旧板块迁出，保持 `branches.sections` 单表至多归属 1 个板块的不变式），由服务端在房间锁内基于最新 `branches.sections` 合并、落库、记审计（带 `via: 'mcp'`）并经 WebSocket / `EventBus` 实时广播，防止多人协作时全量替换误抹同事新建板块。
   - `get_model` 摘要同步返回板块列表与每张表的 `sectionId`。

2. **高层复合写能力：在 `apply_changes` 内支持编译型复合宏（`defineTable` + `alterColumn`），不做整表覆盖 diff 与任意 SQL 反解析合并。**
   - 在保留全部既有底层 mutator（`packages/core/src/mutators.ts`）的前提下，`apply_changes` 输入层新增两个编译型复合宏，由服务端在预演阶段展开为标准底层 mutator，可与底层 op 自由混排在同一批原子提交中：
     - **`defineTable`**：一次声明建表 + 列（支持 `addColumn` 全部字段与列 `comment`；列 `id` 可选，省略时自动生成 UUIDv7，跨表引用可传 `$ref:<alias>`）+ 主键 / 唯一 / CHECK / 外键 / 索引（支持显式 `name` 自动展开 `renameKey`，支持 `comment`）+ 表 `comment` + `ext` + 可选 `partitionBy` / `partitions`。本表约束与索引可直接按**列名**引用本批新建列；新建引用（`schema`、外键 `refTable` / `refColumns`）允许按对象 ID、`$ref:<alias>` 或限定名 / 列名解析（不存在或重名报明确错误）。
     - **`alterColumn`**：声明式 patch 修改已有列（`name`、`type` / `typeRef`、`notNull`、`default`、`identity`、`comment`、`ext`；省略即 `undefined` 不改，`null` 显式清除），严格要求提供列 ID。服务端按固定安全顺序展开：`取消 identity → 清除 default → renameColumn → setColumnType → setNotNull → 设 default → 设 identity → setColumnExt → setComment`，消除互斥约束顺序冲突。
   - **批量上限与错误定位**：输入 op 上限保持 100 条（含复合宏），**展开后的底层子操作上限提升至 500 条**；验证或冲突报错映射回外层输入 `index` 与子路径提示（如 `ops[0] defineTable(orders).foreignKeys[0]`）。
   - **稳定对象 ID 底线**：修改与删除既有对象继续严格要求对象 ID，绝不按名猜测或做整表期望状态 diff，确保改名不断链与并发精确判冲。

3. **同步层受控 `batch` mutator：一次 `apply_changes` = 1 个 `seq` = 画布修改历史 1 条原子记录。**
   - 在 `@dowel/core` 新增受控原子批处理 mutator `batch`（`{ ops, summary? }`），与既有 `paste` 同构：仅允许常规白名单 mutator，禁止嵌套 `batch` 与 `paste`，受最大展开子操作数限制；`list_mutators` 隐藏 `batch` 防止 AI 嵌套调用。
   - `Rooms.applyMcpOps` 在房间锁内先预演并合并整批外部 `reads` 冲突检测，通过后作为 **1 个 `Op` / 1 个 `seq` / 1 条 `room_commits` / 1 次 WebSocket 广播** 提交，并将可选 `summary` 意图说明写入画布修改历史与审计日志；人类在画布修改历史中可一键查看整批 `opDiff`，恢复到 `seq - 1` 即整批撤销。
   - **响应契约收口**：`apply_changes` 响应从逐 op 的 `committed: [{ index, seq }]` 收敛为单个 `seq` 与展开的 `opCount`（附带 `refs`、`changed` 与 `diagnostics`）；Dowel 尚未发布首个公开版本，直接收敛不保留多 seq 兼容包袱。

4. **人类连续手工编辑的画布历史降噪：服务端读时「编辑会话归组 + 整组净差异 + 可展开单步」（Google Docs 模式）。**
   - 底层 `room_commits` 与实时同步 `seq` 保持零改写：多人实时协作客户端的 `versions` 冲突基准与精确审计依赖真实递增的 `seq`，不在底层原地合并已提交行。
   - 服务端画布修改历史列表（`Rooms.listHistory`）默认在读时把**同一用户、非 MCP、连续普通单步编辑、相邻间隔 ≤ 5 分钟（单组总跨度上限 30 分钟且 ≤ 50 步）**聚合为 1 条编辑会话组（返回 `seqFrom..seqTo`、`stepCount` 与汇总摘要），分页游标 `beforeSeq` 按整组边界对齐，避免把同一次连续编辑劈成两页；右侧「本次修改」默认直接计算并展示整组净差异 `modelAt(seqFrom - 1) → modelAt(seqTo)`，同时支持展开查看组内每一步及按单步或组尾恢复。
   - **硬断点**（绝不跨界合并）：换人、已发布版本（`vN`）、MCP `batch`、`paste`、导入 / 恢复 / 应用版本到画布。
   - MCP 只读历史工具复用同一归组能力（默认返回归组视图，支持传 `grouped: false` 读取原始单步）。

5. **写后静态自检：沿用画布准入门槛 + 零往返附带 `diagnostics`。**
   - `apply_changes` 沿用与画布 UI 一致的准入门槛（单步 mutator 合法即提交，允许工作副本存在多步草稿中间态，不被存量校验或兼容性问题阻塞），并在响应（含 `dryRun: true`）中自动附带 `diagnostics`：完整 `validate(model)` 错误列表与基于项目最低目标环境的静态兼容性 `errors` / `warnings`。
   - `get_model` 同步暴露当前项目方言能力摘要与推导目标版本，让 AI 在起草修改前即可预知方言约束。

6. **只读上下文补全、MCP Prompts 与历史恢复红线。**
   - 补齐只读上下文：枚举值详情、不透明对象 DDL、按关键字 / 板块过滤表、只读画布修改历史（`list_history`、`get_history_diff`），并注册 **MCP Prompts**（如安全改画布工作流、未发布变更审阅指引）。
   - **不开放 `restore_history` 写工具**：整库覆盖式的画布历史恢复继续保留给人在界面确认完成（与 ADR 0014 禁止整库导入覆盖一致）。

## Considered Options

- **平台本体内置 LLM 助手**：需维护模型提供商、密钥、配额与提示注入安全面，且外部 IDE / CLI 编程助手天然拥有业务代码与 schema 双重上下文；坚持外置 MCP，不做内置 LLM。
- **向 MCP 开放像素坐标写接口或全量替换 `set_sections`**：LLM 不擅长二维像素排版，易造成节点重叠与无关布局冲突；全量 `sections` 覆盖会在并发协作下静默抹掉他人新建的板块，故仅开放锁内增量的 `manage_sections`。
- **独立平行高层写工具、整表期望状态 diff（`syncTable`）或任意 SQL 反解析合并**：独立工具无法与底层 mutator 组成单次原子提交与单条画布历史；`syncTable` 与任意 SQL 反解析无法可靠区分“改名”与“删列再加列”（破坏稳定对象 ID）且强依赖影子库，故采用在 `apply_changes` 内编译展开 `defineTable` / `alterColumn`。
- **保持 MCP 逐 op 写多条 `room_commits` 并在历史 UI 按 `batch_id` 折叠**：一次调用占用几十个 `seq`、触发几十次 WS 广播，且分页游标 `beforeSeq`、快照与恢复逻辑都要重写区间语义；采用同步层单 `batch` op 与 `paste` 完全同构。
- **底层原地合并人类连续手工编辑的 `room_commits`，或仅在前端对当前页视觉折叠**：原地改写历史行会破坏协同客户端锚定的 `seq` 与审计；仅前端按页内 30 条折叠会在分页边界劈断会话且拿不到整组净差异，故采用服务端读时会话归组。
- **`apply_changes` 提交前对 `validate` 或目标版本兼容性做硬拦截**：会导致包含历史遗留问题的项目无法局部修改，也会阻断分步草稿编辑；改为沿用画布准入门槛并在响应中自动附带 `diagnostics`。
- **开放 MCP `restore_history` 写工具**：属整库级覆盖替换，若未受严格限制易误退他人刚确认的修改；配合 `batch` 单条原子历史，人可在画布历史中一键撤销，故保持只读历史。
- **本期实现 OAuth 2.1**：构建完整授权服务器与同意流范围较大，主流编程助手使用个人 MCP 令牌已足够顺畅，继续暂缓。
