# 多方言与版本支持

Dowel 的每个项目在创建时绑定一种目标数据库方言，并在全仓库层面统一提供建模校验、迁移规划、影子库验证、风险实测、托管执行与漂移检测。当前已支持以下四种数据库方言。

## 方言能力总览 {#dialect-matrix}

| 特性 / 机制         | PostgreSQL                           | SQLite                                | MySQL                                      | SQL Server                         |
| ------------------- | ------------------------------------ | ------------------------------------- | ------------------------------------------ | ---------------------------------- |
| 支持版本            | 15、16、17、18、19                   | Node 26 内置 `node:sqlite`            | 8.4（LTS）、9.7（Innovation）              | 2019（15）、2022（16）、2025（17） |
| 连接串协议          | `postgres://` / `postgresql://`      | `sqlite:///绝对路径`                  | `mysql://`                                 | `mssql://` / `sqlserver://`        |
| 默认逻辑 schema     | `public`                             | `main`（单 schema）                   | `default`（单 schema）                     | `dbo`                              |
| 多 schema 支持      | 是                                   | 否                                    | 否                                         | 是                                 |
| 独立枚举 / 独立序列 | 枚举：是；序列：是                   | 否 / 否                               | 否（列级 `enum(...)`）/ 否                 | 否 / 是                            |
| 分区表编辑          | 支持（`RANGE` / `LIST` / `HASH`）    | 否                                    | 否                                         | 否                                 |
| DDL 默认事务原子性  | 是（除 `CONCURRENTLY` 等语句）       | 是（外键开关与 `VACUUM` 除外）        | 否（DDL 隐式自动提交）                     | 是（`SET XACT_ABORT ON`）          |
| 影子库来源          | 独立配置或同实例 `{原库名}_dowel`    | 内置进程内 `:memory:`（无需配置环境） | 独立配置或同实例 `{原库名}_dowel`          | 独立配置或同实例 `{原库名}_dowel`  |
| 目标库历史存储      | `dowel` schema（5 张表）             | 同库 `dowel_` 前缀表（5 张表）        | 同库 `dowel_` 前缀表（5 张表）             | `[dowel]` schema（5 张表）         |
| 标识符长度上限      | 63 字节                              | 128 字符                              | 64 字符                                    | 128 字符                           |
| 锁 / 语句超时映射   | `lock_timeout` / `statement_timeout` | `PRAGMA busy_timeout` / 无语句超时    | `lock_wait_timeout` / `max_execution_time` | `SET LOCK_TIMEOUT` / 驱动请求取消  |

## PostgreSQL（15–19） {#postgresql}

### 版本目标推导与多版本验证 {#pg-versions}

探测项目下每个环境时，服务端自动记录其 `server_version_num` 与主版本号（15–19），并取所有已知环境大版本的**最小值**作为项目的**目标兼容版本**。

- **多版本环境验证**：当项目同时连接不同大版本的环境（例如 `dev` 为 PG 18、`prod` 为 PG 15）时，点击“在影子库验证”会按环境大版本分组依次在对应版本的代表影子库上实测迁移。
- **最低版本强制门禁**：若缺少项目最低目标版本对应的可用影子库（例如未给 PG 15 生产环境配置独立影子库且不允许同实例），Dowel 会保留各版本组的实测结果但拒绝将该版本标为“已验证”，也不允许执行到目标库。
- **连接模式与托管库配置**：PostgreSQL 需使用直连地址或 Session Mode（如端口 `5432`），请勿使用 Supabase `6543`、Neon `-pooler` 等 Transaction Pooler；托管库拓扑与最小权限 SQL 见 [托管数据库与受限权限配置](modeling.md#managed-shadow-db)。

### PostgreSQL 15–19 版本能力与静态检查 {#pg-capabilities}

| 特性                                          | 最低要求版本   | 低于目标版本时的处理                             |
| --------------------------------------------- | -------------- | ------------------------------------------------ |
| 唯一约束 / 唯一索引 `NULLS NOT DISTINCT`      | PostgreSQL 15+ | 静态规划直接拦截报错                             |
| 分区表上的 `IDENTITY` 列                      | PostgreSQL 17+ | 静态规划直接拦截报错，提示改用独立序列           |
| 分区表上的排他约束（`EXCLUDE`）               | PostgreSQL 17+ | 静态规划直接拦截报错                             |
| 虚拟生成列（`VIRTUAL`）                       | PostgreSQL 18+ | 静态规划直接拦截报错，提示改为 `STORED`          |
| 显式命名的列级 `NOT NULL` 约束                | PostgreSQL 18+ | 静态规划直接拦截报错                             |
| `NOT NULL NOT VALID` / 分区表约束 `NOT VALID` | PostgreSQL 18+ | 验证比对时自动按版本对齐约束名差异               |
| `uuidv7()` 内置函数调用                       | PostgreSQL 18+ | 静态规则发出兼容警告（不阻断用户自定义同名函数） |
| `REPACK`                                      | PostgreSQL 19+ | 按 PG 19 能力标识                                |

### serial 写法 {#pg-serial}

列类型输入 `serial`、`bigserial` 或 `smallserial`（也可写 `serial4`、`serial8`、`serial2`，不区分大小写；带双引号的 `"serial"` 视为自定义类型名，不展开）时，Dowel 在写入模型时把它展开成 PostgreSQL 实际建出的结构，模型里不保存 `serial`：

- 对应的 `integer`、`bigint` 或 `smallint` 列，并设为 `NOT NULL`；
- 一个归属于该列的序列，默认按 `{表名}_{列名}_seq` 派生命名（超长截断、重名加数字后缀的规则与 PostgreSQL 相同），表或列改名时跟着改名；
- 指向该序列的 `nextval(...)` 默认值。

属性面板、MCP 和粘贴等所有写入入口都按这一规则写入。属性面板在某列同时满足“整数类型、默认值指向一个序列、该序列归属于此列”时，把类型显示为 `serial (integer)`、`bigserial (bigint)` 或 `smallserial (smallint)`（列表折叠行简写为 `serial`、`bigserial`、`smallserial`），从数据库导入的同类列也这样显示；类型候选里也有这三项。

- **在 serial 写法之间切换**（如 `serial (integer)` 改成 `bigserial (bigint)`）：列类型和所属序列的类型一起调整，不新建序列。
- **改成其他类型**（包括重新输入 `integer` 等底层整数类型）：只改列类型，默认值与序列保持不变，自增仍然有效；要取消自增，清空默认值即可。清空默认值后再改回 serial 写法，会复用原来归属此列的序列。
- **不能直接改成 serial 的列**：已有其他默认值、`IDENTITY` 或生成列，需先清空默认值或取消 `IDENTITY`；serial 也不能用作数组类型。

### 非事务语句与中断恢复 {#pg-nontx}

`CREATE/DROP INDEX CONCURRENTLY`、`VACUUM`、`REINDEX DATABASE/SYSTEM`、无表名 `CLUSTER` 与 `ALTER TYPE … ADD VALUE` 等在事务外逐段执行并记录断点。对于 `CREATE INDEX CONCURRENTLY` 失败遗留的 `INVALID` 索引，重试前自动精确删除；对于 `ALTER TABLE … DETACH PARTITION … CONCURRENTLY` 因等锁超时停在 `detach pending` 状态的步骤，重试时自动改用 `FINALIZE` 完成分离。

## SQLite {#sqlite}

### 连接与路径白名单 {#sqlite-connection}

- 连接串格式固定为 `sqlite:///绝对路径`（不允许 `:memory:`、查询参数、`..` 与空字节）。
- **默认禁用本地直连**：出于服务端文件隔离要求，未设置环境变量 `DOWEL_SQLITE_ROOTS` 时禁止添加或连接本地 SQLite 目标库；配置冒号分隔的绝对目录白名单后，服务端在每次连接前逐段消解符号链接并校验不得指向平台库 `DOWEL_DB` 本身及其附属文件。
- **免环境配置影子库**：SQLite 项目的 SQL 导入、表达式规范化与迁移闭环验证全部使用 Node 26 内置的 `:memory:` 内存影子库，毫秒级完成且并发互不干扰。

### 方言特性与 12 步表重建 {#sqlite-features}

- **专属表与列属性**：支持表级 `STRICT`（限定列类型为 `INT` / `INTEGER` / `REAL` / `TEXT` / `BLOB` / `ANY`）、`WITHOUT ROWID`（必须有主键且不能混用 `AUTOINCREMENT`），以及单列整数主键 `AUTOINCREMENT`。
- **12 步表重建**：当发生 SQLite 不允许原地 `ALTER TABLE` 的结构变更（如调整列顺序、修改列类型或可空性、增删改主键/约束等）时，规划器自动生成官方 12 步重建步骤：在事务外关闭外键约束检查（`PRAGMA foreign_keys = OFF`），开启 `BEGIN IMMEDIATE` 事务建临时表 `_dowel_tmp_*`、拷贝数据、删旧表、改名并重建索引与触发器，执行 `PRAGMA foreign_key_check` 核对无外键冲突后提交，并在 `finally` 中兜底恢复 `PRAGMA foreign_keys = ON`。
- **历史存储与安全沙箱**：目标库历史写在同库 `dowel_` 前缀表（保留字禁用前缀 `sqlite_` 与 `dowel_`），并启用数据库级防御模式与操作授权器拦截 `ATTACH`、`DETACH`、`VACUUM INTO` 与危险 `PRAGMA`。

## MySQL（8.4 LTS / 9.7 Innovation） {#mysql}

### 连接参数与同实例影子库 {#mysql-connection}

- 连接串格式为 `mysql://user:password@host:3306/dbname`（必须包含数据库名，禁用 `?socketPath=` 与 unix socket）。
- **TLS 参数**：支持查询参数 `ssl`、`ssl-mode` 或 `sslmode`（`DISABLED`、`PREFERRED`、`REQUIRED`/`REQUIRE`、`VERIFY_CA`/`VERIFY-CA`、`VERIFY_IDENTITY`/`VERIFY-FULL`）；启用 TLS 时默认严格校验证书（如需自定义参数可传合法 `ssl` JSON）。
- **同实例影子库**：默认在同实例自动建 `{原库名}_dowel`（超长时截断加 8 位哈希后缀，总长不超过 64 字符），在库内创建 `__dowel_shadow_mark` 哨兵表防误删，并使用会话级 `GET_LOCK` / `RELEASE_LOCK` 串行排队；受限权限预建影子库 SQL 见 [托管数据库与受限权限配置](modeling.md#managed-shadow-db)。

### 专属特性与版本能力 {#mysql-features}

- **表、列与索引属性**：支持表级 `engine`、`charset`、`collation`；列级 `UNSIGNED`、`ZEROFILL`、`AUTO_INCREMENT`（每表至多 1 列，须为非空整数/浮点列、无默认值、非生成列且作为主键或索引首列）、`ON UPDATE CURRENT_TIMESTAMP`、列级 `enum(...)` 与 `set(...)`；索引支持 `BTREE` / `HASH` / `FULLTEXT` / `SPATIAL` 及前缀长度；支持通过 `FIRST` / `AFTER` 调整列顺序。
- **8.4 与 9.7 版本差异**：项目下存在多个版本环境时，服务端按主次版本（`8.4` / `9.7`）分组推导最低目标版本并在对应版本的代表影子库分别验证。**MySQL 9.0+ 新增的 `VECTOR(n)` 类型**在目标环境低于 9.0 时会被静态检查拦截。
- **DDL 隐式提交与崩溃断点恢复**：MySQL 所有 DDL 语句均自动提交且无法包进事务回滚。执行器逐条执行并持久化 `step_index` 断点；若发生“DDL 已提交但断点尚未落盘时进程意外崩溃”，重试时内置基于 `information_schema` 与 MySQL 错误号（已存在 / 不存在）的确定性幂等探测，对可确认已生效的单表或单约束步骤自动跳过续跑（多子句或无法 100% 判定的语句保持保守）。
- **锁与重写风险实测**：通过 `ALGORITHM=INSTANT` → `ALGORITHM=INPLACE, LOCK=NONE` → `ALGORITHM=INPLACE, LOCK=SHARED` → `COPY` 渐进试跑，给出真实算法与锁级别风险报告。

## SQL Server（2019 / 2022 / 2025） {#mssql}

### 连接串与 TLS 证书提示 {#mssql-connection}

- 连接串支持 `mssql://` 或 `sqlserver://`，端口默认 `1433`，支持 `host\instance` 命名实例语法与大小写不敏感查询参数（`encrypt`、`trustServerCertificate`、`connectTimeout`、`requestTimeout`、`appName`）。
- **自签名证书提示**：Dowel 默认启用严格的 TLS 校验（`encrypt=true`、`trustServerCertificate=false`）。当连接测试环境、Docker 容器或使用自签名证书的 SQL Server 实例时，需在连接串后显式加上 `?encrypt=true&trustServerCertificate=true`。
- **同实例影子库**：默认在同实例建 `{原库名}_dowel`（上限 128 字符），明确拒绝使用系统库（`master`、`tempdb`、`model`、`msdb`），使用数据库扩展属性 `dowel_shadow` 标记并使用 `sys.sp_getapplock`（Session 级）互斥；受限权限预建影子库 SQL 见 [托管数据库与受限权限配置](modeling.md#managed-shadow-db)。

### 专属特性与版本能力 {#mssql-features}

- **列与约束映射**：支持列级 `IDENTITY(seed, increment)`（每表至多 1 列、非空且不与默认值或计算列混用）；列默认值使用带名约束（默认推导为 `DF_<table>_<col>`），在删除列或修改默认值前自动先删除对应默认值约束；表、列与索引改名均生成 `EXEC sp_rename` 调用。
- **聚集与计算列**：主键、唯一约束与索引支持 `CLUSTERED` / `NONCLUSTERED`（每表至多 1 个聚集约束/索引，未显式指定时主键默认聚集），索引支持 `FILLFACTOR`（1–100）；支持 `PERSISTED` 计算列（非持久化计算列禁止设为 `NOT NULL`）、`SPARSE` 与 `ROWGUIDCOL`。SQL Server 会按表达式推断持久化计算列是否可空：属性面板的“非空”复选框只表示显式声明 `PERSISTED NOT NULL`，生成的 DDL 也只写显式声明；只由表达式推断为非空的列不勾选，下方提示“由表达式推断为非空”，列表里的 `NN` 显示为虚线框。迁移规划与执行后的结构核对按实际可空性（显式或推断）比较，推断结果在规范化时更新。从已有数据库导入时，系统目录分不出显式声明与推断，非空的持久化计算列一律记为推断。
- **批处理分隔符 `GO`**：导入解析、执行器与导出脚本均内置词法级 `GO [count]` 批分隔符切分（上限重复 `100` 次，不误切字符串与注释内文本）。
- **2019 / 2022 / 2025 版本差异**：
  - **SQL Server 2025（主版本 17）**：支持原生 `json` 与 `vector(n)` 类型；当项目目标版本低于 SQL Server 2025（2019 / 2022）时，两者均会被静态检查拦截：其中原生 `json` 会提示低版本改用 `nvarchar(max)`，而 `vector(n)` 直接提示需要 SQL Server 2025（主版本 17+）。
  - **SQL Server 2022（主版本 16）及以上**：支持 `IS DISTINCT FROM`。
- **历史、事务与风险实测**：历史表固定写在目标库的 `[dowel]` schema（由 `AFTER UPDATE, DELETE` 触发器保护只追加语义）。普通 DDL 在 `SET XACT_ABORT ON` 事务内原子执行；影子库通过 `sys.dm_tran_locks`（`Sch-M` / `X` 对象锁）与 `sys.partitions.hobt_id` 变更检测页级重写风险。
