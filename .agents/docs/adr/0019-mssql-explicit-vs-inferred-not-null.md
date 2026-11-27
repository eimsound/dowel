# SQL Server 持久化计算列：显式 NOT NULL 与引擎推断的非空分开存

2026-11-28 决定（[Issue #161](https://github.com/eimsound/dowel/issues/161)，来源 PR #157；部分修订 [ADR 0016](0016-on-demand-shadow-normalization.md) 决定 5）。

## 背景

SQL Server 按表达式推断持久化计算列是否可空：`cp AS ([code]) PERSISTED` 在 `code` 为 NOT NULL 时读回 `is_nullable = 0`。模型原先只有一个 `notNull`，影子库规范化把推断结果写回 `notNull`，规划器又把 `notNull: true` 渲染成 `PERSISTED NOT NULL`。于是“用户写的 NOT NULL”和“引擎推断出来的非空”混在一起：`code` 改回可空后，迁移仍带着用户从没写过的 `NOT NULL`，目标库插不进 `code` 为 NULL 的行。

实测（SQL Server 2022）：`sys.columns.is_nullable`、`COLUMNPROPERTY(…, 'AllowsNull')`、`sys.computed_columns` 的所有列，对 `AS ([code]) PERSISTED` 与 `AS ([code]) PERSISTED NOT NULL` 完全一样，也没有对应的约束对象。系统目录分不出两者。

## 决定

1. **两个字段**：`notNull` 只表示用户显式声明的 `PERSISTED NOT NULL`，生成 DDL 只看它；`ext.mssql.inferredNotNull` 表示引擎从表达式推断为非空，只由影子库规范化写回，从不渲染进 DDL，写入入口（`addColumn`、`setColumnExt`、MCP 宏）忽略调用方传入的值。普通列、非持久化计算列不用这个字段。
2. **有效可空性** = `notNull || inferredNotNull`。规划器按它比较（显式与推断互换、有效值不变时不生成迁移），执行读回校验复用规划器，因此同样按它严格比较；不加任何容忍。主键校验也按有效可空性。
3. **规范化怎么算推断值**：保证推断结果不依赖影子库的构建路径（从零建库或从基线增量迁移）。读回已可空时推断值必为 false；读回非空时，只有当该列在本次构建中确定以非显式从零新建（整库从零建或所在表不在基线中）才直接取读回值，其余情形（`next` 为显式声明，或所在表已存在于基线中、增量迁移后物理列可能保留基线的显式 `NOT NULL`）均在影子库同表临时加一个同表达式的非持久化计算列，读它的 `is_nullable` 再删掉（实测 27 个表达式，持久化与非持久化计算列、`sys.dm_exec_describe_first_result_set` 的推断结果一致）。推断与显式无关，显式 `notNull` 永不被改写。
4. **导入**：从目标库读结构时一律记成推断（`notNull: false` + `inferredNotNull: true`）。有参考模型时（拉取、漂移检查、标记核对），同一列表达式未变、有效可空性一致就沿用参考模型的拆分，保住显式声明。影子库导入 SQL 时可以再探测一次：表达式本身推断为可空、读回却非空的，只能是显式声明，还原成显式。
5. **待规范化判定**（`derive-pending.ts`）：在 #145 的“所在表按列名对齐的普通列 notNull 变了”之外，列自己的推断值相对基线变了也算；列自己的显式 `notNull` 变了仍算（推断与它无关，但旧规则写回的存量基线没有 `inferredNotNull`，借此补算）。稳态仍是 0 影子库 I/O。
6. **界面**：“非空”复选框只绑显式 `notNull`；只由推断得出非空时不勾选，下方显示只读提示“由表达式推断为非空……”，列表 `NN` 按有效值显示，推断的用虚线框区分。

## Considered Options

- **一个字段，读回比较时把推断值当等价**：改动小，但规划器仍会把写回的推断值渲染成 NOT NULL，问题原样存在；而且是 ADR 0017 明确拒绝的“比较时容忍”。
- **规范化不写回**：模型 `notNull: false`、读回非空，读回校验报不一致，推断非空的列永远执行不了。
- **导入时用 `sys.dm_exec_describe_first_result_set` 在目标库上只读推断表达式**：能把“显式声明在可空表达式上”的列还原成显式，但它不是计算列自己的推断路径（只是实测一致），本次不做，留给负责人决定。

## 影响

- 存量数据（不考虑兼容，同 ADR 0017 原则）：旧规则写回过 `notNull: true` 的列，模型分不出是不是用户写的，按显式处理——DDL 与以前相同，仍会带 NOT NULL；用户取消勾选后会触发一次规范化，补上推断值，有效值不变时不生成迁移。
- **待定：导入时如何区分显式与推断**：当前从已有数据库读结构时一律记成推断（`notNull: false` + `inferredNotNull: true`）。对于表达式本身可空、却在目标库上显式写了 `PERSISTED NOT NULL` 的列（例如 `AS (CONVERT(varchar(10), [a])) PERSISTED NOT NULL`）：
  - **向导「从已有数据库」导入（无参考模型）**：
    - **不作主键时**：v0 基线的 `up` 脚本不带 `NOT NULL`，闭环验证会通过（从零建与执行脚本两边都可空），但在新的空环境上执行 v0 时读回为可空、与模型有效值非空不一致，会报 `readback_mismatch`；之后只要分支里任何对象触发规范化，`canonicalize` 都会比对全部对象，把这列静默写回为可空（`inferredNotNull: false`），后续迁移把这列重建成可空且不会报错。
    - **作主键时**：v0 基线在影子库里直接建不出来，导致整个分支无法规范化、所有发布都被拦下（不只是这张表）。
  - **环境「保留线上修改」拉取（有参考模型）**：`alignMssqlImportedLive` 只对工作副本里已经存在且表达式、有效可空性未变的列沿用参考模型的显式声明；线上新加的列不在参考模型里，若属于上述情形同样会被记成推断并触发上述后果。
  - 如何处理这一导入边界（保持现状 / 目标库只读调用 `sys.dm_exec_describe_first_result_set` / 影子库探测等）待负责人另行决定。
- `ext.mssql` 只被 SQL Server 方言读取，其他方言即使带着这个键也不理会；粘贴不跨方言，同方言粘贴的列不带推断值，由下一次规范化算出。
