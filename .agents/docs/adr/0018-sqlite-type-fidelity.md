# SQLite 列类型按声明原样保留：不折叠整数别名，非 STRICT 表保留无类型列

2026-11-27 决定（[Issue #140](https://github.com/eimsound/dowel/issues/140)、[Issue #141](https://github.com/eimsound/dowel/issues/141) 方案 ③；补充 [ADR 0017](0017-verified-means-executable.md)「版本模型里只存数据库的写法」）。

## 背景

`sqliteNormalizeType` 原先把 `int` / `bigint` / `smallint` / `tinyint` / `mediumint` / `int2` / `int8` / `bool` / `boolean` 统一折叠成 `INTEGER`，把 `varchar` / `clob` 折成 `TEXT`、`double` / `float` 折成 `REAL`、`decimal` 折成 `NUMERIC`，空类型返回 `TEXT`；快照读回又把空类型映射成 `ANY`。这些写法在 SQLite 里并不等价（以 Node 26 内置 SQLite 3.54 实测）：

- **rowid 别名**：只有声明类型恰为 `INTEGER`（不区分大小写）的单列主键才是 rowid 别名。`INT PRIMARY KEY` / `BIGINT PRIMARY KEY` 不是：非 STRICT 表里能存 `NULL` 和非整数值，也不能加 `AUTOINCREMENT`（`AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`）。折叠成 `INTEGER` 后，任何一次 12 步重建都会静默把主键变成 rowid 别名，存量里有非整数值时拷贝数据直接 `datatype mismatch`（#140）。
- **亲和性**：`BOOLEAN` 是 NUMERIC 亲和性而不是 INTEGER；非 STRICT 表里不写类型的列是 BLOB 亲和性（值原样保存），`ANY` 则是 NUMERIC 亲和性（`'1'` 会存成整数），`TEXT` 是 TEXT 亲和性。三者都不是同一列。
- **三套口径**：模型里的空类型是 `''`，规范化函数给 `TEXT`，快照读回给 `ANY`，规划器逐字比较必然要重建，执行读回必然 `readback_mismatch`（#141）。

## 原则

按每种方言真实的数据库语义建模，不用规范化去抹平差异。规范化只允许改变不影响语义的写法。

## 决定

1. **`sqliteNormalizeType` 只做不改语义的写法统一**：去首尾空白、压缩连续空白、整体大写；整段是一个带引号的普通类型名（`"MyType"`、`[weird]`、`` `bt` ``、`'Text'`）时去掉引号，与 `PRAGMA table_xinfo` 读回的写法一致（SQLite 读回时同样去引号）。不再有任何别名折叠：`bigint` 存为 `BIGINT`、`boolean` 存为 `BOOLEAN`、`varchar(255)` 存为 `VARCHAR(255)`。函数保持幂等，模型写入与引擎读回走同一个函数。
2. **rowid 别名由声明类型决定**：`INTEGER` 单列主键是 rowid 别名并可用 `AUTOINCREMENT`；`INT` / `BIGINT` 等单列主键按原类型保留，建表与 12 步重建都输出原类型，不会变成 rowid 别名。IR 不另设 rowid 标记。`AUTOINCREMENT` 的写入校验与模型校验仍要求类型为 `INTEGER`，因此 `BIGINT` 主键不能再借折叠拿到 `AUTOINCREMENT`。
3. **STRICT 白名单按真实规则**：`INT`、`INTEGER`、`REAL`、`TEXT`、`BLOB`、`ANY`（不区分大小写）；`BIGINT`、`BOOLEAN` 等别名不再因折叠被放行。
4. **非 STRICT 表保留无类型列**：`type: ''` 是合法的 SQLite 列定义，模型、规范化函数、快照读回（不再映射成 `ANY`）、规划器与建表 / 重建 DDL（省略类型）统一为 `''`。属性面板清空类型框、`addColumn` / `setColumnType`、`defineTable` / `alterColumn`（需显式传 `type: ""`，省略仍报缺少类型）与粘贴都可以写入。
5. **STRICT 表继续拒绝无类型列**：写入（`addColumn` / `setColumnType` / 粘贴 / 宏）、模型校验、以及给含无类型列的表开启 STRICT，都报错并说明 STRICT 只接受上述六种类型。其他方言的空类型规则不变（PG 枚举列 `typeRef` + `''` 仍表示非数组枚举）。

## 影响与边界

- 只改 SQLite；PostgreSQL、MySQL、SQL Server 的类型规范化不变。
- 按 ADR 0017「不考虑旧数据兼容」：旧模型里因折叠存成 `INTEGER` / `TEXT` / `ANY` 而目标库实际是 `BIGINT` / 无类型等写法的，读回后会如实显示为差异，按正常的拉取或修改处理，不做存量迁移。
- 带引号且不是整段普通类型名的写法（如 `"varchar"(10)`，SQLite 读回为 `varchar`）不做特殊处理，差异由验证读回核对暴露。
