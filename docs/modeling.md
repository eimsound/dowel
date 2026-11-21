# 建模、版本与画布历史

Dowel 的数据模型以带稳定 ID 的中间表示（IR）为唯一数据源：画布编辑、SQL 预览、差异对比与迁移脚本均从同一份 IR 派生。本页说明稳定对象 ID、结构导入、影子库隔离边界、实时协作与画布历史、版本发布与风险分析，以及 PostgreSQL 分区表编辑。

## 稳定对象 ID 与改名识别 {#stable-object-ids}

- 每个 schema、表、列、约束、索引、枚举与序列都有全局唯一的 UUIDv7 对象 ID。
- 修改表名或列名时，操作直接更新对象属性而不重建对象 ID，因此发布版本时生成 `ALTER TABLE … RENAME` / `ALTER … RENAME COLUMN`（SQL Server 生成 `sp_rename`），同时保留原有数据。
- **推导名与显式锁定**：按引擎规则自动生成的约束名、索引名或序列名默认标记为推导名（`derived`），当表名或列名修改时自动重算并生成改名 DDL；需要业务代码固定引用时可将其锁定为显式名（`explicit`），改名后保持不变。
- **表达式同步改写**：列改名时，同一张表上的 `CHECK` 约束、默认值与生成列表达式中引用的列名会随同一个原子编辑操作自动改写。

## 结构导入 {#importing}

Dowel 支持**从已连接环境导入**和**从 SQL 文件导入**两种方式，均只读取结构，不读取也不写入业务数据：

1. **从目标库导入**：在新建项目向导或“环境 → 从此库导入结构”触发。服务端以只读方式查询系统目录，并将结构按限定名与当前工作副本已有对象对齐以沿用对象 ID（尽量保住画布布局与改名轨迹）。
   - PostgreSQL：需要目标库 `CONNECT`、相关 schema `USAGE` 与表 `SELECT` 权限；`dowel` schema 永远自动跳过；
   - SQLite：受 `DOWEL_SQLITE_ROOTS` 白名单限制，读取当前数据库，忽略 `sqlite_*` 与 `dowel_*` 表；
   - MySQL：读取当前默认库目录，忽略 `dowel_*` 与 `__dowel_shadow_mark`；
   - SQL Server：读取用户 schema 与对象，忽略系统 schema 及 `dowel` schema。
2. **从 SQL 导入**：粘贴或选择 `.sql` 脚本（例如 `pg_dump --schema-only`、`mysqldump --no-data`、SQLite `.schema` 或 T-SQL DDL）。服务端会自动过滤常见的导出噪声语句（如 PostgreSQL 的 `OWNER TO` / `GRANT` / `REVOKE`，MySQL 的 `LOCK TABLES` / `UNLOCK TABLES`，SQLite 的 `BEGIN TRANSACTION` / `COMMIT`，SQL Server 的顶层 `USE` 语句），在影子库执行后读出完整模型。

## 影子库机制与安全边界 {#shadow-database}

除 SQLite 直接使用进程内建的 `:memory:` 影子库外，PostgreSQL、MySQL 与 SQL Server 均使用真实的同方言数据库实例作为影子库来规范化表达式、导入 SQL、做闭环验证并实测风险：

- **影子库选择顺序**：
  1. 环境上显式配置的独立影子库连接串；
  2. 未显式配置时，在目标库所在实例自动创建并使用 `{原库名}_dowel`（超出引擎标识符长度上限时自动截断并拼接短哈希）。
- **生产环境隔离**：标记为“生产环境”的目标库默认**禁止**在同一实例上自动建影子库（检查与清库操作会占用实例 I/O 与连接）。需显式配置独立影子库实例，或在环境设置中主动勾选允许使用同一实例。
- **空库保护与专属标记**：Dowel 绝不清空未带有自身标记的非空数据库：
  - PostgreSQL 通过数据库级 `COMMENT` 标记；
  - MySQL 通过库内 `__dowel_shadow_mark` 哨兵表标记；
  - SQL Server 通过数据库扩展属性 `dowel_shadow` 标记（并明确拒绝系统库 `master`/`tempdb`/`model`/`msdb`）。
- **高权限账号与实例级语句防护**：
  - 建议为影子库配置独立的低权限账号（仅拥有影子库自身的所有权或建表/删表权限，不赋予超级用户权限）；
  - 规划与导入前会对脚本做词法级高危检查，拦截跨库或实例级语句（如 PG `CREATE DATABASE`/`ALTER SYSTEM`/`TABLESPACE`/`ROLE`；SQLite `ATTACH`/`DETACH`/`VACUUM INTO`/危险 `PRAGMA`；MySQL `CREATE DATABASE`/`GRANT`/`SET GLOBAL`、跨库 `db.obj` 与危险 `sql_mode`；MSSQL `USE`/`KILL`/`xp_cmdshell`/`OPENROWSET`/`BULK INSERT`/跨库三段名），以及任何试图修改 `dowel` / `dowel_*` 历史对象的操作。该静态检查用于防范误操作，真正的安全隔离边界仍取决于影子库账号权限与实例隔离。

## 实时协作与画布修改历史 {#collab-and-history}

### 先到先得的并发冲突控制 {#optimistic-concurrency}

- 所有在线编辑者的修改通过 WebSocket 发送至服务端，按到达顺序串行校验并持久化，再向房间内所有客户端广播结果。
- 当你在属性面板中修改某个对象期间（例如编写 `CHECK` 表达式或重命名列），若另一位协作者先修改了同一对象或你引用的列，你的保存会被服务端拒绝并提示是谁做了修改；页面随即刷新为最新状态，避免静默覆盖他人修改。
- 拖动画布节点位置属于独立的布局变更通道，不触发结构版本冲突，也不进入数据库版本快照。

### 画布修改历史与一键恢复 {#canvas-history}

工作副本的每一次结构提交都按递增序号（`seq`）持久化保留：

- 在画布工具栏打开**画布历史**，可按时间线浏览每次操作（包含通过导入、接手领先环境覆盖或系统规范化产生的提交）；
- 点击任意历史节点可同时查看**该步的单步差异**以及**与当前工作副本之间的差异**；
- 点击**恢复到此状态**时，服务端会将其作为一次新的提交写入工作副本（不销毁原有历史记录），并携带当前查看的 `workingSeq`；若在此期间画布已被其他协作者改动，服务端返回 `409 working_changed` 并展示最新差异供重新确认。

## 发布、验证与风险分析 {#publish-and-verify}

### 发布与冻结脚本 {#publish-and-freeze}

- 点击**发布**将工作副本冻结为只读版本快照，并在发布时生成相邻版本之间的升级（`up`）与回滚（`down`）迁移脚本（`v0 · 基线` 没有回滚脚本）。
- 仅**链上最新且从未在任何环境执行过**的版本允许手工微调脚本；修改脚本后该版本自动回到“未验证”状态，须重新验证通过才可执行。
- 在“版本”或“迁移”页可随时下载包含固定会话设置（时区、严格模式等）的 `.sql` 脚本文件。

### 闭环验证与锁/重写风险实测 {#verification-and-risk}

点击**在影子库验证**后，Dowel 执行两项验证：

1. **闭环一致性**：从前一个版本的结构出发，执行升级脚本并读回快照核对与新版本一致；再执行回滚脚本并读回快照核对回到原版本。
2. **风险实测**：在影子库逐步执行并统计每条语句的实际锁模式、全表扫描及整表重写情况，标注高（`high`）/ 中（`medium`）/ 低（`low`）风险：
   - **PostgreSQL**：读取 `pg_locks` 关系锁、`relfilenode` 变更检测整表重写，以及 `pg_stat_xact_user_tables` 顺序扫描计数；
   - **SQLite**：识别 12 步表重建（`EXCLUSIVE` 锁与整表重写）、`VACUUM` 全库重写，以及 `DROP COLUMN` / `CREATE INDEX`（`RESERVED` 锁）；
   - **MySQL**：对单表 `ALTER TABLE` 依次按 `ALGORITHM=INSTANT`（低风险）→ `ALGORITHM=INPLACE, LOCK=NONE`（中风险）→ `ALGORITHM=INPLACE, LOCK=SHARED`（中风险）→ `COPY`（高风险、整表重写）渐进试跑实测真实执行算法；
   - **SQL Server**：在事务内实测 `sys.dm_tran_locks` 对象锁（`Sch-M` / `X`）以及 `sys.partitions.hobt_id` 变更检测数据页重写。

## PostgreSQL 分区表编辑与建模限制 {#partitioning-and-limits}

### PostgreSQL 分区表编辑 {#pg-partitioning}

- 支持在建模器中新建或编辑声明式分区表：配置分区策略（`RANGE` / `LIST` / `HASH`）、列或表达式分区键（支持指定运算符类与排序规则）。
- 支持增删改子分区及其边界（如 `FOR VALUES FROM (...) TO (...)`、`FOR VALUES IN (...)`、`FOR VALUES WITH (modulus M, remainder R)` 与每张父表最多 1 个的 `DEFAULT` 子分区）。
- 支持将已有普通表挂载为子分区（生成 `ATTACH PARTITION`）以及将子分区脱离为独立普通表（生成 `DETACH PARTITION`）。
- 限制说明：受 PostgreSQL 引擎约束，**已发布版本中的分区表不能直接在原表上修改分区策略**（属性面板策略字段为只读）；多级嵌套子分区（子分区同时作为下级父表）在属性面板中以只读徽标展示。分区表的主键与唯一约束必须包含全部分区键列（含表达式分区键时不可建主键或唯一约束）。

### 其他通用建模边界 {#modeling-limits}

- **不透明对象**：视图、物化视图、函数、存储过程、触发器、策略（RLS）、域、自定义复合类型与排他约束以不透明对象形式保存。它们可被导入、在迁移规划中按依赖顺序删建，且在引用到的表或列改名时同步更新定义，但**不能直接在画布表单编辑**（需通过导入更新）。
- **SQL 视图只读**：界面提供的 SQL 预览与 DDL 视图为只读，修改模型通过画布与属性面板操作（或导入 SQL）。
- **枚举类型**：PostgreSQL 支持独立的 `ENUM` 对象，新增枚举值生成 `ALTER TYPE … ADD VALUE`；删除或重排已有值会自动生成重建枚举类型及修改相关列类型的迁移步骤。MySQL 使用列级 `enum(...)` / `set(...)` 定义。
