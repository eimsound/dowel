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

除 SQLite 直接使用进程内建的 `:memory:` 影子库外，PostgreSQL、MySQL 与 SQL Server 均使用真实的同方言数据库实例作为影子库来规范化表达式、导入 SQL、做闭环验证并实测风险。编辑画布期间 Dowel **不会**在后台连接影子库（见下方[表达式规范化](#normalization)），只有导入、验证、发布、生成迁移 / 导出 DDL 或点击“规范化”时才会使用：

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

### 托管数据库与受限权限配置 {#managed-shadow-db}

#### 推荐拓扑：独立近端影子库 {#managed-shadow-topology}

使用 AWS RDS / Aurora、Google Cloud SQL、Neon、Supabase、Azure 等托管数据库时，推荐在**同地域私网或近端自托管实例**上为环境显式配置独立的 `shadowUrl`（保持与目标库主版本一致）：

- **降低网络往返开销**：闭环验证与风险实测包含多个串行数据库往返；公网直连远端托管库时较高的网络延迟（RTT）会显著拖慢发布、导入与规范化体验；
- **保护生产环境资源**：生产环境默认禁止同实例自动建影子库（检查与清库会消耗实例连接数与 I/O）；使用独立影子库实例即可在不放开生产限制的前提下完成闭环验证。

#### PostgreSQL 连接模式要求（禁用 Transaction Pooler） {#pg-connection-mode}

PostgreSQL 目标库与影子库均必须配置为**直连端点**或 **Session Mode**（通常为端口 `5432`），**不要使用 Transaction Pooler（事务池化器）**，例如：

- Supabase Supavisor Transaction Mode（`*.pooler.supabase.com:6543`）；
- Neon 池化端点（主机名含 `-pooler.`）；
- PgBouncer `pool_mode = transaction`（常见于端口 `6543` 或查询参数 `?pgbouncer=true`）。

原因在于 Dowel 的影子库与生命周期操作依赖**会话级**机制（`pg_try_advisory_lock` / `pg_advisory_unlock` 会话级咨询锁、跨语句持久的 `SET lock_timeout` / `SET statement_timeout` 会话参数，以及非事务块执行的 `CREATE DATABASE`）。如果连接串使用事务池化器，连接在事务结束后会被归还池中，导致锁状态丢失或会话参数失效。

#### 最小权限 SQL 配置指南 {#shadow-minimal-privileges}

##### PostgreSQL（15–19） {#pg-shadow-privileges}

- **方式 1（允许自动建 `{原库名}_dowel` 同实例影子库）**：为 Dowel 使用的数据库角色授予 `CREATEDB` 权限（无需 `SUPERUSER`）：

  ```sql
  CREATE ROLE dowel_user NOSUPERUSER CREATEDB LOGIN PASSWORD '<强密码>';
  ```

- **方式 2（无 `CREATEDB` 权限 / 由 DBA 预建独立影子库）**：由管理员预先创建空数据库，并将新库**所有权（`OWNER`）**直接交给 Dowel 角色：

  ```sql
  CREATE ROLE dowel_user NOSUPERUSER NOCREATEDB LOGIN PASSWORD '<强密码>';
  CREATE DATABASE app_dowel OWNER dowel_user;
  ```

- **托管 PG 常见坑与说明**：
  - 在 RDS / Aurora / Cloud SQL 等非真超级用户托管实例上，管理账号执行 `CREATE DATABASE ... OWNER dowel_user` 前需先让自己成为目标角色的成员：`GRANT dowel_user TO admin_user;`；
  - 仅执行 `GRANT ALL PRIVILEGES ON DATABASE app_dowel TO dowel_user` **不够**：Dowel 认领影子库时需执行 `COMMENT ON DATABASE`（要求当前角色为库所有者），且 PG 15+ 每次验证前清空影子库会执行 `DROP SCHEMA public CASCADE`（要求当前角色拥有 `public` 及相关 schema 所有权，设置数据库 `OWNER` 即可让其通过 `pg_database_owner` 默认拥有 `public`）；
  - 如影子库内存在其他角色创建的残留 schema，还需补授所有权：`ALTER SCHEMA <schema> OWNER TO dowel_user;`。

##### MySQL（8.4 / 9.7） {#mysql-shadow-privileges}

当 Dowel 使用的数据库用户没有实例级建库权限时，由管理员预建空库（推荐使用 `utf8mb4` 字符集），并仅授予该影子库上的完整 DDL/DML 权限（供维护 `__dowel_shadow_mark` 哨兵表及清空重放）：

```sql
CREATE DATABASE app_dowel CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON `app_dowel`.* TO 'dowel_user'@'%';
```

##### SQL Server（2019–2025） {#mssql-shadow-privileges}

由管理员预先创建独立空用户数据库（切勿使用 `master`、`tempdb`、`model`、`msdb` 系统库），并在该影子库内为 Dowel 用户授予 `db_owner` 角色（供写入 `dowel_shadow` 数据库扩展属性、`sys.sp_getapplock` 会话锁与清空重放）：

```sql
CREATE DATABASE [app_dowel];
GO
USE [app_dowel];
GO
CREATE USER [dowel_user] FOR LOGIN [dowel_user];
ALTER ROLE [db_owner] ADD MEMBER [dowel_user];
GO
```

!!! danger "安全红线：切勿将包含业务数据的数据库设置为影子库"

    每次执行导入 SQL、闭环验证或规范化前，Dowel 都会先核对专属标记并将影子库内的全部用户对象彻底清空。切勿将存放业务数据的数据库填入环境的影子库地址，也不要人为给非空数据库打上影子库标记。

## 实时协作与画布修改历史 {#collab-and-history}

### 先到先得的并发冲突控制 {#optimistic-concurrency}

- 所有在线编辑者的修改通过 WebSocket 发送至服务端，按到达顺序串行校验并持久化，再向房间内所有客户端广播结果。
- 当你在属性面板中修改某个对象期间（例如编写 `CHECK` 表达式或重命名列），若另一位协作者先修改了同一对象或你引用的列，你的保存会被服务端拒绝并提示是谁做了修改；页面随即刷新为最新状态，避免静默覆盖他人修改。
- 拖动画布节点位置属于独立的布局变更通道，不触发结构版本冲突，也不进入数据库版本快照。

### 表达式规范化 {#normalization}

CHECK 约束、默认值、生成列、表达式索引与分区表达式在数据库里有“规范写法”（例如 PostgreSQL 会把 `total >= 0` 存成 `(total >= (0)::numeric)`）；给视图、触发器等不透明对象引用的表或列改名后，它们的定义也要由数据库重新生成。Dowel 把这一步叫**规范化**：在影子库里重放模型、读回引擎的规范写法并写回工作副本，这样与线上库读出的结构可以直接比较。

- **编辑时不自动规范化**：保存后画布上保留你写的原文，模型页底部状态栏显示“N 处待规范化”（没有待处理的时显示“表达式已规范化”）；
- **手动规范化**：项目编辑者可以随时点状态栏的**规范化**按钮，在影子库里校验并写回规范写法；没有可用影子库（例如只有不允许同实例影子库的生产环境）时按钮不可用并说明原因；表达式在影子库里执行出错时会提示错误，工作副本保持原样；
- **关键操作前自动规范化**：发布版本、生成迁移、导出 DDL、在影子库验证、查看版本或历史差异、从环境导入的预览、MCP 读取模型之前，服务器都会先规范化待处理的对象，结果始终基于规范写法；没有影子库时跳过这一步（例如发布为未验证版本），不影响查看迁移与 DDL；
- 规范化产生的写回会作为“系统规范化”提交记入画布修改历史。

### 画布修改历史与一键恢复 {#canvas-history}

工作副本的每一次结构提交都按递增序号（`seq`）持久化保留：

- 在画布工具栏打开**修改历史**，可按时间线浏览每次操作（包含通过导入、接手领先环境覆盖或系统规范化产生的提交）；
- 点击任意历史节点可同时查看**该步的单步差异**以及**与当前工作副本之间的差异**；
- 点击**恢复到此状态**时，服务端会将其作为一次新的提交写入工作副本（不销毁原有历史记录），并携带当前查看的 `workingSeq`；若在此期间画布已被其他协作者改动，服务端返回 `409 working_changed` 并展示最新差异供重新确认。

### 复制粘贴表、列、约束与索引 {#copy-paste}

可以从当前画布、画布修改历史中的任一历史状态，或同类型数据库的其他项目复制对象，粘贴到当前画布。

- **可以复制什么**：
  - **表**：一张表、多张表（在画布上按住 ⌘ / Ctrl 或 Shift 点击表增减选择，或按住 Shift 拖动框选；⌘ / Ctrl+A 选中画布上显示的全部表），或折叠的板块汇总卡片里的全部表。复制表会带上它的列（顺序、类型、默认值、生成列与自增设置、方言专属选项）、主键、唯一约束与 `CHECK` 约束、索引和外键；PostgreSQL 分区表的子分区随父表一起复制。
  - **表内对象**：一列、一个约束或一个索引（属性面板中每行的复制按钮），或一张表的全部列 / 全部约束 / 全部索引（属性面板标题栏的“复制”菜单，也可以在这里复制整张表）。
  - **从画布修改历史复制**：打开**修改历史**，选中一条记录，切到**当时状态**，在**画布**里选中表后复制，或在**表结构**里复制一张表、勾选的多张表、一列、一个约束或索引；关闭修改历史后在画布上粘贴。
- **如何粘贴**：在画布上（不在输入框里）按 ⌘V / Ctrl+V，或点击顶栏的**粘贴**。列、约束与索引粘贴进当前选中的表（也可以用属性面板顶部的“粘贴列、约束或索引到表 …”）。查看者可以复制表和“复制”菜单里的内容，不能粘贴。
- **只能在同类型数据库之间粘贴**：粘贴来自其他数据库类型项目的内容（例如把 SQLite 的表粘贴到 PostgreSQL 项目）会直接报错，模型不做任何改动。
- **绝不覆盖**：粘贴出的每个对象都使用新的 ID；名字已被占用时自动加后缀（`orders` → `orders_copy`，再粘贴为 `orders_copy2`，超出标识符长度上限时自动截短）；自动命名的约束和索引按新表重新命名；已有对象一律不改动。
- **外键**：一起复制的表之间的外键连到新表上；指向未复制的表的外键，按 schema、表名与列名在目标项目里找同名的表和列，列存在、类型一致且被主键或唯一约束覆盖时自动接上，否则跳过。
- **表内粘贴**按列名把约束和索引对应到目标表的列（优先对应同一次粘贴的新列）；缺少所需列的对象、目标表已有主键时的主键、与已有定义完全相同的对象会被跳过。
- **Schema、枚举与序列**：表放进同名 schema，目标项目没有同名 schema 时放进默认 schema；被复制列引用的 PostgreSQL 枚举，仅在目标项目存在同名枚举且其取值是来源取值的超集时复用，否则新建加 `_copy` 后缀的枚举；被复制列拥有的序列（如 `serial` 或显式归属该列的序列）总是新建并归属到新列，未被复制列拥有的序列在目标有同名序列时按名复用、否则新建。视图、触发器等以 SQL 文本保存的对象不会被复制。
- **粘贴结果**：有对象被改名或跳过时，画布左下方会显示粘贴结果面板，列出改名的对象、跳过的外键和对象及原因，以及其他说明；关闭前一直保留。
- **一次粘贴就是一条修改历史**：粘贴通过正常的实时同步作为一次修改提交，遵循与其他编辑相同的冲突规则，其他协作者立即可见，并在画布修改历史中记为一条“粘贴”，可以从那里恢复到粘贴之前。
- **剪贴板说明**：复制的内容是带版本号的 JSON。Dowel 把它写进系统剪贴板，同时在浏览器本地存储里保留一份，所以即使浏览器不允许读取系统剪贴板，在同一 Dowel 站点的其他标签页里也能粘贴；如果在 Dowel 里复制之后又复制了别的文字，以系统剪贴板里较新的内容为准，Dowel 不会粘贴旧的那份。

## 画布板块、默认折叠与邻域聚焦 {#canvas-sections}

当项目规模达到数十至上百张表时，可以使用纯布局层的**板块（Section）**、大表默认折叠与单表邻域聚焦来整理视图：

- **纯布局语义（零 DDL 副作用）**：板块仅存储在布局层，**绝不进入**数据模型、SQL 预览、结构差异、版本快照或迁移脚本；调整或删除板块不会改动任何数据库表结构。
- **共享定义与本地视图分离**：
  - 板块的名称、颜色与成员表在项目内实时同步给所有在线协作者（查看者仅可浏览，不可修改），且一张顶层表最多归属一个板块、板块不可嵌套、与数据库 schema 互不相干；
  - 侧边栏视图切换（按 Schema / 按板块）、画布视图模式（按板块 / 平铺）、各个板块的展开/折叠状态，以及单表邻域聚焦仅保存在各自浏览器的本地存储中，互不干扰。
- **按表名前缀一键建议**：在“管理板块”或侧边栏点击“前缀建议”，系统会按 `_` / `-` 首段前缀为尚未归属的表自动预览建议板块（忽略 `t_`、`tbl_`、`tb_` 等常见前缀并合并基础单复数，仅保留至少包含 2 张表的候选），确认后可微调名称与颜色再应用。
- **超过 100 张表自动折叠汇总**：顶层表数量不超过 100 张时保持完整平铺画布；超过 100 张表时默认折叠为板块汇总卡片（未配置板块时按 schema 汇总展示），卡片上显示表数量与跨板块（或跨 schema）外键数量，点击**展开**即可按需加载并自动排布该板块内的表，随时也可切回平铺模式。
- **1 跳 / 2 跳外键邻域聚焦**：在侧边栏表行或属性面板顶部点击**聚焦邻域**，画布将仅显示与目标表存在 1 跳或 2 跳无向外键关联的表与连线，并可通过顶部浮动条快速切换 `1 跳` / `2 跳` 或退出聚焦。

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

- **不透明对象**：视图、物化视图、函数、存储过程、触发器、策略（RLS）、域、自定义复合类型与排他约束以不透明对象形式保存。它们可被导入、在迁移规划中按依赖顺序删建，引用到的表或列改名后在[规范化](#normalization)时（手动点击或发布、生成迁移前自动）由影子库更新定义，但**不能直接在画布表单编辑**（需通过导入更新）。
- **SQL 视图只读**：界面提供的 SQL 预览与 DDL 视图为只读，修改模型通过画布与属性面板操作（或导入 SQL）。
- **枚举类型**：PostgreSQL 支持独立的 `ENUM` 对象，新增枚举值生成 `ALTER TYPE … ADD VALUE`；删除或重排已有值会自动生成重建枚举类型及修改相关列类型的迁移步骤。MySQL 使用列级 `enum(...)` / `set(...)` 定义。
