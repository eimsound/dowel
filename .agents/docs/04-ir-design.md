# IR 与协作同步设计

状态：**已确定（2026-11-17）**，按 [02-consensus.md](02-consensus.md) 1.1 的决策方式定下；实现中发现问题时直接修订本文并注明。 针对 [03-open-questions.md](03-open-questions.md) 中阻塞 M1 开工的 Q1（IR 格式）、Q2（协作同步）、Q6（结构相等），以及 Q4（M1 范围）、Q5（人工步骤）。依据的实验数据见 [01-research.md](01-research.md) 第 5～9 节。

汇总见 [02-consensus.md](02-consensus.md) 第 10 节。

## 0. 要点

| #   | 提案                                                                                                                                          | 依据                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| D1  | 所有对象放在一个**扁平**的表里，按 ID 索引，用 `parent` 表示从属关系；不嵌套                                                                  | 修改和冲突判断都以单个对象为单位，粒度最细（实验 7）        |
| D2  | 协作同步：修改是具名操作，服务器按顺序处理；**依据的对象被别人改过就拒绝**                                                                    | 已确定方案的具体协议，原型验证见第 2 节                     |
| D3  | 顺序用**分数索引排序键**，每列一个 `pos`                                                                                                      | 移动一列只改这一列，不会和别人对其他列的修改冲突            |
| D4  | 列顺序只是**展示顺序**，PG 闭环验证不比较物理顺序                                                                                             | ADD COLUMN 永远追加到最后（实验 5）                         |
| D5  | 约束、索引、序列的名字**全部写进 IR**；按 PG 规则推导出来的名字标记为 `derived`，改名时跟着改并生成 `RENAME`；可锁定单个名字                  | 自动生成的名字不跟着改名走，否则闭环验证必然失败（实验 5）  |
| D6  | 表达式**存原文**（直接写列名）；改列名时由同一个修改把引用它的表达式一起改写                                                                  | 并发冲突由服务器拒绝（D2），不再需要占位符（原型场景 1、3） |
| D7  | ~~表达式存两份~~ → **2026-11-18 改**：服务器在影子库里把表达式换成引擎规范形式后直接写回（带版本检查），不再保留原文，见 05-implementation.md | 数据结构更简单；界面本来就显示规范形式                      |
| D8  | 影子库会话固定 `TimeZone`、`DateStyle`、`IntervalStyle`、`search_path` 等参数；**迁移 SQL 输出规范形式**                                      | 会话参数会改变字面量的语义（实验 6.2）                      |
| D9  | 落盘格式：JSON，**一张表一个文件**，键顺序固定                                                                                                | 对 Git diff / merge 友好；不自创 DSL                        |
| D10 | M1 把分区表从“可编辑”降为“只读导入”，挪到 M2                                                                                                  | 随机闭环测试是 M1 验收标准，分区会让状态空间翻倍            |

---

## 1. IR 结构（Q1）

### 1.1 总体

```ts
type Id = string; // UUIDv7，小写，带连字符
type Dialect = 'pg' | 'sqlite' | 'mysql' | 'mssql';

interface Model<D extends Dialect = Dialect> {
  format: 1; // IR 格式版本，见 1.8
  dialect: D;
  objects: Record<Id, Obj<D>>; // 扁平：所有对象都在这里
}
```

**为什么扁平**：嵌套结构里，父对象被删除时子对象一起消失；在 CRDT 里这意味着“A 删表，B 同时给这张表加列”会让 B 的修改无声无息地丢失。扁平结构下合并后会留下 `parent` 指向不存在对象的孤儿，可以检测并交给人处理（符合“语义冲突只检测、不自动解决”）。

所有对象共有的字段：

```ts
interface Base {
  id: Id;
  kind: Kind;
  parent?: Id; // 列、约束、索引 → 表；表、枚举 → schema
  name: string;
  comment?: string;
}
```

### 1.2 对象种类（PG，M1）

```ts
type Kind =
  | 'schema'
  | 'extension'
  | 'table'
  | 'column'
  | 'primaryKey'
  | 'unique'
  | 'foreignKey'
  | 'check'
  | 'index'
  | 'enum'
  | 'sequence'
  | 'opaque'; // 见 1.7
```

NOT NULL 不是独立对象，而是列的属性（带一个可选的名字，见 1.4）：PG 18 之前它不是约束，SQLite / MySQL 也不是。

```ts
interface Column extends Base {
  kind: 'column';
  parent: Id; // 表
  pos: string; // 排序键（分数索引），见 2.3
  type: TypeRef;
  notNull: boolean;
  notNullName?: Named; // 仅 PG 18+ 有意义
  default?: Expr;
  generated?: { expr: Expr; stored: boolean }; // PG 18 必须显式写 STORED / VIRTUAL
  identity?: { always: boolean; sequence: Named; options?: SeqOptions };
  collation?: string;
}

/** 类型拆成结构，而不是一个字符串，方便判断 varchar(50)→(500) 这类变更是否安全 */
interface TypeRef {
  name: string; // 引擎规范名：'integer'、'character varying'、'timestamp with time zone'
  ref?: Id; // 用户自定义类型（枚举、域）指向 IR 对象，改名时不需要改这里
  mods?: number[]; // (255)、(10,2)
  arrayDims?: number;
}
```

### 1.3 方言扩展字段（实际落地，`packages/core/src/ir.ts`）

项目只绑定一种方言，对象在核心字段外挂载按方言分区的可选 `ext` 槽位（省略时不改变既有 PG IR 序列化），并在 `packages/core/src/dialect.ts` 中由各 `DialectSpec` 统一声明 `DialectCapabilities`：

- **`Table.ext`**：
  - `sqlite`：`{ withoutRowid?: boolean, strict?: boolean }`
  - `mysql`：`{ engine?: string, charset?: string, collation?: string }`
  - `mssql`：`{}`（预留）
- **`Table.partitionBy` / `Table.partitionOf`**（PG 分区表编辑落地后结构化）：`partitionBy` 支持结构化 `PartitionSpec`（`{ strategy: 'range' | 'list' | 'hash', keys: PartitionKey[] }`）并向后兼容存量 `format: 1` 中的 `pg_get_partkeydef` 字符串。
- **`Column.ext`**：
  - `sqlite`：`{ autoincrement?: boolean }`
  - `mysql`：`{ unsigned?: boolean, zerofill?: boolean, autoIncrement?: boolean, charset?: string, onUpdateCurrentTimestamp?: boolean, enumValues?: string[], setValues?: string[] }`
  - `mssql`：`{ identity?: { seed: string, increment: string }, defaultName?: string, defaultNameMode?: 'derived' | 'explicit', sparse?: boolean, rowguidcol?: boolean }`
- **`PrimaryKey.ext` / `Unique.ext`**：
  - `mssql`：`{ clustered?: boolean }`
- **`Index.ext`**：
  - `mysql`：`{ indexType?: 'BTREE' | 'HASH' | 'FULLTEXT' | 'SPATIAL', lengths?: (number | null)[] }`
  - `mssql`：`{ clustered?: boolean, fillFactor?: number }`（`1`–`100`）

**边界原则**：只有“至少两种方言都有、且语义一致”的才进核心字段；方言专属属性放入对应 `ext.<dialect>`，升级或提升公共字段再走 `Model.format` 递增（1.8）。

### 1.4 名字：显式还是推导（D5）

实验 5 表明 PG 自动生成的约束、索引、序列名**不会跟着表名、列名改变**。对策：

```ts
type Named = { name: string; mode: 'derived' | 'explicit' };
```

- 约束、索引、序列、PG 18 的 NOT NULL 约束都带 `Named`，**名字总是写进 IR**。
- `derived`：名字由 `@dowel/core` 按 PG 规则（[实验 5.1](01-research.md#51-pg-自动命名规则)）算出。表或列改名时，core 重新计算，diff 会额外生成 `ALTER … RENAME CONSTRAINT / ALTER INDEX … RENAME / ALTER SEQUENCE … RENAME`。
- `explicit`：用户手动起的名字、用户锁定的名字（业务代码里引用了它），或推导规则算不出来的（例如重名时 PG 加的 `1`、`2` 后缀）。改名时不动。
- 从数据库导入时：用规则算一遍，和实际名字相同就记为 `derived`，否则 `explicit`。
- 闭环验证**严格比较名字**，所以“名字跟着改”这件事本身也被验证了。

需要验证的点：截断规则（两段名字按比例截）和非 ASCII 名字的字节长度，要用随机测试对照引擎结果。

### 1.5 表达式（D6、D7、D8）

```ts
interface Expr {
  src: string; // 用户写的原文，直接写列名：  email <> ''
  canon?: { of: string; sql: string }; // 引擎规范形式；of = 生成时依据的原文，不等于当前 src 就视为过期
}
```

**存原文，改名时一起改写**：

- 改列名的操作会找出本表中引用这一列的表达式，在同一个修改里把列名改掉（原型场景 3）。
- “李四改表达式的同时张三改了名”这类并发，由同步层的冲突规则拒绝后到者（第 2.3 节），不需要像早先草案那样把列引用存成 ID 占位符。
- 找出表达式里的列名需要各方言的**词法分析器**：跳过字符串和注释；标识符后面跟 `(` 的是函数名；`::` 后面的是类型名；剩下的标识符如果和本表某列同名，就是列引用。边界情况（列名和函数名、关键字同名）要用影子库归一化的结果对照测试。

**引擎规范形式**（实验 6）：

- 规范形式是不动点，diff 和闭环验证都比较规范形式，不需要自己判断两个表达式是否等价。
- 规范形式中的字面量自带完整信息，**迁移 SQL 输出规范形式**，在目标库上以任何会话参数执行都得到同样的值。
- 界面上默认显示规范形式（去掉最外层多余括号）；用户编辑时显示原文。
- `canon` 由服务器在影子库归一化后写入（第 2.6 节“派生数据”）。

### 1.6 影子库会话参数（D8，四方言现状）

每个影子库会话与下载的迁移脚本开头按方言固定会话设置，保证在任意客户端或实例执行结果一致：

- **PostgreSQL**（`packages/engines/src/pg/db.ts`）：
  ```sql
  SET TimeZone = 'UTC';
  SET DateStyle = 'ISO, MDY';
  SET IntervalStyle = 'postgres';
  SET search_path = '';
  SET extra_float_digits = 3;
  SET check_function_bodies = false;
  ```
- **SQLite**（`packages/engines/src/sqlite/db.ts`）：`PRAGMA foreign_keys = ON`、`PRAGMA legacy_alter_table = OFF`（12 步表重建步骤内部在事务外临时关闭并在 `finally` 恢复）。
- **MySQL**（`packages/engines/src/mysql/db.ts`）：`SET SESSION time_zone = '+00:00'`、`SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'`、`SET SESSION information_schema_stats_expiry = 0`。
- **SQL Server**（`packages/engines/src/mssql/db.ts`）：`SET ANSI_NULLS ON`、`SET QUOTED_IDENTIFIER ON`、`SET XACT_ABORT ON`（后接 `GO`）。

用户在界面上看到的 PostgreSQL / SQL Server 表达式和类型名去掉项目默认 schema 前缀。

### 1.7 不透明对象

视图、物化视图、函数、过程、触发器、RLS 策略、域、复合类型等在 M1 先作为不透明对象：

```ts
interface Opaque extends Base {
  kind: 'opaque';
  objType: 'view' | 'materializedView' | 'function' | 'trigger' | 'policy' | 'domain' | 'type' | …;
  ddl: string;               // 引擎读出的规范 DDL（pg_get_viewdef / pg_get_functiondef 等）
  deps: Id[];                // 从 pg_depend 读出：依赖了哪些表、列、类型
}
```

- 能导入、能原样输出、参与 diff（`ddl` 变了就生成 `CREATE OR REPLACE` 或先删后建）。
- **依赖关系必须记录**：PG 里被视图引用的列不能直接改类型，编排器要先删视图、改列、再重建视图。
- 不能在画布上可视化编辑，只能在 SQL 视图里改。

### 1.8 格式版本与升级

- `Model.format` 是整数；`@dowel/core` 内置 `upgrade(n → n+1)` 函数链。
- 服务器加载房间时先升级 IR（服务器是唯一写者），再允许客户端连接。
- 客户端代码的 `format` 低于文档时，进入只读并提示刷新。

### 1.9 落盘格式（D9，给 CLI 和 Git 工作流用）

```
dowel/
  project.json             方言、format、环境列表
  schemas/
    public/
      _schema.json         schema 本身、枚举、序列、扩展
      users.json           一张表：表、列、约束、索引，按 pos / 名字排序
      orders.json
  opaque/
    public.active_users.view.json
  layout.json              画布布局（不参与 schema diff）
```

- JSON，键顺序固定，2 空格缩进，用 zod 生成 JSON Schema 供编辑器补全。
- 一张表一个文件：两个分支改不同的表时 Git 能自动合并。
- 表达式原样写出；ID 仍然写在每个对象上。
- 不选 YAML（隐式类型转换等坑）；不自创 DSL（需要维护解析器）。以后可以单独提供 DBML 导入导出。

---

## 2. 协作同步（Q2）

依据：[02-consensus.md](02-consensus.md) 4.2（服务器按顺序处理、冲突拒绝、同步层自己写）。协议已用原型验证，见 [01-research.md](01-research.md) 第 9 节。

### 2.1 基本概念

| 概念                | 说明                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 房间                | 一个分支的工作副本。服务器在内存里保存它的当前 IR                                                                                   |
| 序号 `seq`          | 房间内每接受一个修改加 1，全局有序                                                                                                  |
| 对象版本 `v`        | 该对象最后一次被修改时的 `seq`                                                                                                      |
| 修改（op）          | `{ client, n, name, args, reads }`：第 n 个修改（每个客户端从 1 递增）、操作名（如 `renameColumn`）、参数、发起时读过的对象及其版本 |
| 操作函数（mutator） | 纯函数 `(tx, args) => void`，放在 `@dowel/core`，客户端和服务器共用；不合法就抛出拒绝原因                                           |

### 2.2 一次修改的流程

```
客户端                                   服务器（按到达顺序逐个处理）
───────                                  ─────────────────────────────
执行 mutator（本地校验，不合法直接报错）
放入待确认队列，界面立即更新
发送 op ───────────────────────────────▶ 1. 去重：n 已处理过 → 忽略
                                         2. 顺序：n 必须是上一个 + 1
                                         3. 冲突：reads 里的对象被别人改过 → 拒绝
                                         4. 在最新状态上重新执行 mutator → 抛错则拒绝
                                         5. 分配 seq，写操作日志，应用修改
◀── 广播 commit（seq、谁、改了哪些对象）──
◀── 或只发给发起者 reject（原因） ──────
收到自己的 commit：移出队列
收到 reject：移出队列，提示原因
收到任何 commit：在新状态上重放队列（rebase）
```

- **广播的是修改结果**（哪些对象变成了什么），不是让其他客户端重新执行 mutator。因此客户端代码版本落后时也能正确显示；mutator 只用于发起者的乐观更新和服务器校验。
- 服务器以自己执行的结果为准。客户端本地执行结果与服务器不同时，以收到的 commit 覆盖。

### 2.3 冲突规则：先到先得

一个修改被拒绝，当且仅当：

1. **它依据的数据已被别人改过**：`reads` 里任一对象的当前版本，和发起时看到的不同（或已被删除）；
2. **或者它在最新状态上不合法**：服务器重新执行 mutator 时抛错（例如列名已被别人占用）；
3. **或者它依赖的自己的上一个修改被拒绝了**。

`reads` 的来源：

- mutator 里通过 `tx.get(id)` 取用的对象自动记入。**只记真正用到的对象**：遍历子对象时不算读，只有找到并取出的那个才算。所以“张三改 `age`”不会和“李四改引用 `email` 的 CHECK”冲突。
- **草稿**：编辑框打开时记下当时的数据，保存时 `reads` 取打开时的版本。这对应“李四写了半分钟，期间张三改了名”的情况。
- 读到的是自己尚未确认的修改写的值时，版本记为 `p:{客户端}:{n}`，服务器换算成那个修改的提交序号；那个修改被拒绝了，这个也拒绝（规则 3）。

规则 1 只看“读过的对象”，遍历时漏掉的并发新增（如张三删列的同时李四加了引用它的 CHECK）由规则 2 兜住：服务器在最新状态上重新执行时会发现。**所以服务器上的数据永远满足 mutator 里写的校验**，原型的随机测试验证了这一点。

原型中的例子：

| 场景                                                                             | 结果                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 李四打开 CHECK 编辑框；张三把 `email` 改名为 `mail`；李四保存 `email like '%@%'` | 拒绝，提示“column mail 已被 张三 修改，请在最新数据上重新操作”；李四的页面刷新到最新 |
| 同上，但李四保存时页面已经刷新                                                   | 本地直接报错“表达式引用了不存在的列 email”，不发给服务器                             |
| 张三改 `age`，李四同时给 `email` 加 CHECK                                        | 都成功                                                                               |
| 先有 CHECK `email <> ''`，再把 `email` 改名为 `mail`                             | CHECK 自动变成 `mail <> ''`                                                          |
| 李四连发三个修改：改名（与张三冲突）→ 引用新名字的 CHECK → 无关的加列            | 前两个被拒绝，第三个成功                                                             |

### 2.4 断线与重连

```
客户端 ── hello(lastSeq) ──────────────▶ 服务器
       ◀── welcome(lastProcessed, 被拒绝的修改及原因)
       ◀── lastSeq = 0：完整快照（含 lastProcessed）
           否则：补发 lastSeq 之后的所有 commit
客户端重发 n > lastProcessed 的待确认修改，然后才允许发送新修改
```

原型的随机测试发现并修正了两个容易漏掉的点，正式实现必须保留：

- **收到 welcome 之前不能发送新修改**。否则新修改会先于断线期间积压的修改到达服务器，顺序被打乱。
- **快照必须带上 `lastProcessed`**。客户端原本靠“收到自己修改的 commit”来清理队列；收到的是快照时没有这些 commit，修改会永远卡在队列里。

另外：

- commit 按 `seq` 依次应用，跳号的先缓存。重连瞬间新广播可能比补发的旧 commit 先到。
- 服务器按 `(client, n)` 去重：修改已送达、但确认消息因断线丢失时，客户端会重发同一个修改。
- `client` 是每个浏览器标签页的会话 ID，刷新页面就是新的客户端。刷新前未发出的修改会丢失，界面上要提示“有未保存的修改”。

### 2.5 持久化

- 平台 PG 里两张表：操作日志（房间、seq、client、n、用户、操作名、参数、修改结果、时间）和快照（房间、seq、IR）。
- **先写操作日志再广播**。服务器重启后从最近的快照加上之后的日志恢复。
- 定期写快照（例如每 500 个修改），断线太久的客户端直接发快照。
- 操作日志长期保留，同时用于历史记录、审计、评审中“谁改了什么”、分支合并的三方对比（Q10）。

### 2.6 其他

| 主题                                 | 做法                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在线状态、光标、“正在编辑”           | 同一条 WebSocket 上的临时消息，不进日志。显示“李四正在编辑这个 CHECK”，从源头减少冲突                                                                                 |
| 撤销 / 重做                          | 撤销 = 发起一个反向修改，同样走冲突规则；别人已经改过同一对象时，撤销会被拒绝并提示                                                                                   |
| 画布布局                             | 单独一类修改，不检查冲突（拖动不应该被拒绝），同一属性后到的覆盖先到的；拖动时节流；不进 schema 的版本快照                                                            |
| 派生数据（表达式规范形式、检查结果） | 服务器以“系统”身份发起修改，`reads` 包含所依据的对象。用户在检查期间又改了原文，这个派生修改会因冲突被自动丢弃，不会写回过期结果。取代了原先单独的 `derived` Map 设计 |
| 顺序（D3、D4）                       | 每列一个 `pos` 排序键（分数索引），移动只改这一列的 `pos`；列顺序只是展示顺序，见下                                                                                   |
| 规模                                 | 1000 张表约 1.9 万个对象，内存中几 MB；首次连接的快照可压缩                                                                                                           |
| 多台服务器（SaaS）                   | 同一个房间的连接路由到同一个进程（Figma 的做法）。自托管单进程不涉及，M3 之后再做                                                                                     |

列顺序（D4）：

- PG：只改顺序不生成迁移（界面提示“PG 中列的物理顺序只能通过重建表改变”）；闭环验证不比较顺序；从库里读回结构时，已有列保留 IR 中的 `pos`，新增列排在最后。
- SQLite：反正要重建表，重建时按 IR 顺序建。
- MySQL（M4）：可以用 `AFTER`。

### 2.7 正式实现要注意的

- **mutator 必须用 `tx.get()` 取它依据的对象**，否则那个对象被并发修改时不会判为冲突。服务器重新执行时的校验仍能保证数据合法，但“先到先得”的语义会变弱。代码评审和测试要覆盖这一点。
- 操作参数要有 zod schema 和版本号，旧客户端发来的修改由服务器按版本转换或拒绝。
- 原型里的随机测试（多客户端、随机延迟、断线、草稿）要作为 `packages/sync` 的常驻测试，断言“所有客户端最终与服务器一致”和“服务器状态满足语义不变量”。

---

## 3. 结构快照与“结构相等”（Q6）

闭环验证、漂移检测、导入都需要一个从引擎读出来的**结构快照**，以及“IR 渲染出的期望快照”和它的比较。

### 3.1 快照

- 在固定参数的会话里（1.6）从系统目录读出，格式和 IR 类似，但**没有 ID，按全限定名索引**。
- 期望快照：IR 按当前名字渲染，表达式取规范形式。
- 两者都经过同一个规范化函数后再比较。

### 3.2 比较时忽略的

| 忽略                       | 原因                                       |
| -------------------------- | ------------------------------------------ |
| OID、relfilenode、统计信息 | 与结构无关                                 |
| 列的物理顺序（PG）         | 见 2.3                                     |
| 所有者、权限（M1）         | 权限管理以后再做；作为单独的一类比较       |
| 表空间                     | 自托管用户可能在意，先忽略，以后做成可选项 |

### 3.3 严格比较的

- 所有名字（包括 derived 名字，见 1.4）。
- 表达式的规范形式（不动点，直接比较字符串）。
- 版本差异由“按版本读取”的代码统一：例如 PG 18 之前 NOT NULL 读出 `attnotnull`，18+ 读出约束及其名字；在快照里都表示成列的 `notNull` + 可选的 `notNullName`，比较 18 以下版本时不比较 `notNullName`。

### 3.4 IR 和快照之间的映射

- 导入：快照 → IR，为每个对象生成新 ID。
- 再次导入 / 漂移检测：快照中的对象按全限定名匹配 IR 中已有的对象，继承 ID；匹配不上的视为新增或删除，**可能的改名列出来让用户确认**（同表内类型相同、名字不同）。

---

## 4. 四方言覆盖范围现状（2026-11-22 更新）

| 方言                                 | 可视化建模对象                                                                                                                                                                                                                                                                                                          | 不透明对象 / 特殊支持                                                           | 明确不支持 / 只读边界                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PostgreSQL（15–19）**              | 多 schema、扩展、表、列、主键、唯一（`NULLS NOT DISTINCT` 15+）、外键、CHECK、NOT NULL（18+ 显式命名）、索引（部分/表达式/`INCLUDE`/方法）、枚举、序列、identity、生成列（`STORED`/`VIRTUAL`）、注释、**声明式分区表及子分区（RANGE/LIST/HASH、边界编辑、ATTACH/DETACH）**                                              | 视图、物化视图、函数、过程、触发器、RLS 策略、域、复合类型、排他约束            | 已发布分区表的分区策略只读；多级子分区在属性面板以只读徽标展示；不支持继承表、外部表、事件触发器、publication/subscription                       |
| **SQLite**                           | 单一 `main` schema、表（`STRICT`、`WITHOUT ROWID`）、列（`INTEGER PRIMARY KEY AUTOINCREMENT`、生成列、列顺序调整）、主键、唯一、外键、CHECK、索引（部分/表达式/排序）                                                                                                                                                   | 视图、触发器（通过 SQL 导入与 12 步表重建自动迁移重建）                         | 不支持多 schema、独立枚举、独立序列、对象注释、`INCLUDE`、`NULLS NOT DISTINCT`、声明式分区表                                                     |
| **MySQL（8.4 / 9.7）**               | 单一 `default` schema、表（`engine`/`charset`/`collation`）、列（`UNSIGNED`/`ZEROFILL`/`AUTO_INCREMENT`/`ON UPDATE CURRENT_TIMESTAMP`/列级 `enum`/`set`/列顺序 `FIRST`/`AFTER`）、主键（`PRIMARY`）、唯一、外键（含 InnoDB `KEY_GENERATED` 隐式索引管理）、CHECK、索引（`BTREE`/`HASH`/`FULLTEXT`/`SPATIAL`、前缀长度） | 视图、触发器、函数、存储过程                                                    | 不支持多 schema、独立枚举对象、独立序列、分区表编辑、部分索引 `WHERE` 与 `INCLUDE`；9.0+ `VECTOR(n)` 在 8.4 目标下静态拦截                       |
| **SQL Server（2019 / 2022 / 2025）** | 多 schema（默认 `dbo`）、表、列（`IDENTITY(seed, increment)`、带名默认约束 `DF_*`、计算列 `PERSISTED`/`SPARSE`/`ROWGUIDCOL`）、序列、主键/唯一/索引（`CLUSTERED`/`NONCLUSTERED`、`FILLFACTOR`、`INCLUDE`）、外键、CHECK、扩展属性注释                                                                                   | 视图、触发器、存储过程、函数、用户自定义类型/同义词；独占行 `GO [count]` 批切分 | 不支持独立枚举、扩展、声明式分区表编辑、直接表达式索引（需用计算列）、`DEFERRABLE` 外键；2025 原生 `json` 与 `vector(n)` 在 2019/2022 下静态拦截 |

---

## 5. 人工步骤与数据迁移（Q5）

操作列表里加入两种特殊步骤：

```ts
type Step =
  | GeneratedStep // AddColumn、RenameColumn……
  | { kind: 'sql'; id: Id; sql: string; after: Id | null; note?: string } // 用户写的 SQL，挂在某一步之后
  | { kind: 'pause'; id: Id; note: string }; // 阶段分界：expand 和 contract 之间部署应用代码
```

- **用户 SQL 照样在影子库里执行**（带样本数据时还能验证回填逻辑），闭环验证要求最终结构等于目标版本。
- 一次评审产生一个迁移计划；`pause` 把计划分成多个阶段，导出时每个阶段是一个迁移文件（Flyway / Prisma 等格式里就是多个文件）。
- 用户直接修改生成的 SQL 也允许：此时迁移标记为“已手改”，靠闭环验证保证结果仍等于目标版本；IR 变化后重新生成时提示冲突，不静默覆盖。

---

## 6. 下一步

按顺序：

1. **`packages/core` 类型草稿**：把第 1 节的类型写成 zod schema，导入一个约 50 张表的真实 PG schema（可选：GitLab、Mastodon、Discourse 的开源 schema），检查表达力。
2. **命名规则复现**：TS 实现 PG 的推导命名规则，用 fast-check 生成随机表名 / 列名（含超长、非 ASCII），与 PGlite 实际结果对照。
3. **闭环验证最小原型**（Q20 第 4 条）：只支持表、列、索引、外键 + 改名；随机修改 IR → 生成迁移 → 在 PGlite 中执行 → 读快照 → 比较。
4. **表达式列引用识别**：PG 词法分析器，找出表达式中的列名并支持改写，对照引擎归一化结果测试。
5. **`packages/sync` 正式实现**：在原型基础上接入 Hono WebSocket、Better Auth 会话、PG 操作日志；保留随机测试。

---

## 7. 目标库里的 `dowel` 迁移历史（P4a / Stage 2 四方言开发者说明）

决策见 [ADR 0003](adr/0003-version-content-in-target-db.md)，各引擎实现位于 `packages/engines/src/{pg,sqlite,mysql,mssql}/history.ts`（统一实现 `HistoryStore` 接口，只依赖 `Db` 接口）。用户文档见 [docs/execution.md](../../docs/execution.md)，执行器读写逻辑位于 `packages/executor/src/`。

**双存储模型（`DialectCapabilities.historyStorage`）**：

- **`schema` 模式（PostgreSQL / SQL Server）**：固定存放在 `dowel` schema（`dowel.meta`、`dowel.projects`、`dowel.versions`、`dowel.history`、`dowel.claims`），不提供改名；无建 schema 权限时抛 `HistoryError('no_schema_privilege')` 并提示 DBA 授权语句。PG 通过 `pg_advisory_xact_lock` + 事务建表；MSSQL 通过 `sp_getapplock` + 事务建表，`history` 与 `claims` 用 `AFTER UPDATE, DELETE` 触发器（`tr_history_guard` / `tr_claims_guard`）保护只追加语义。
- **`prefix` 模式（SQLite / MySQL）**：同库存储 5 张表（`dowel_meta`、`dowel_projects`、`dowel_versions`、`dowel_history`、`dowel_claims`），在建模器保留字检查与快照读取中硬编码排除；SQLite 与 MySQL 均使用 `BEFORE UPDATE` / `BEFORE DELETE` 触发器强制 `dowel_history` 与 `dowel_claims` 的只追加语义。

**跨实例项目互斥锁（`withProjectLock`）**：PG 用会话级 advisory lock；MSSQL 用独占单连接 Session 级 `sp_getapplock`；MySQL 用独占连接 `GET_LOCK` / `RELEASE_LOCK`（释放失败时销毁连接防锁泄漏）；SQLite 用按规范路径隔离的进程内互斥锁。

其余 `meta.format_version`（当前 `1`）、`projects`（认领 `instance_id`）、`versions`（含完整 `model` 与 `scope`）、`claims`、`history`（含 `step_index` 断点与 `direction` = `baseline | up | down | mark`）及 `verifyChain` 规则在四方言间保持 1:1 字段与语义对齐。
