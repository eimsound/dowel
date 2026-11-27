# AI 编程助手（MCP） {#mcp}

Dowel 内置 [Model Context Protocol](https://modelcontextprotocol.io)（MCP）服务。Claude Code、Cursor、VS Code 等 AI 编程助手可以**以你的身份**读取模型、预览迁移、在影子库验证，并修改工作副本；修改和在画布上编辑一样走冲突规则、记审计。

服务和网页在同一个端口：`POST /api/mcp`（无状态 Streamable HTTP），多副本部署在负载均衡后面也不需要粘性会话。

---

## 1. AI 能做什么、不能做什么 {#boundaries}

| AI 能做                                                          | AI 不能做                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| 列出项目，读取模型、表、视图 / 函数等对象、DDL、版本链和迁移预览 | 发布版本                                             |
| 从**平台缓存**读取环境状态和漂移（带缓存时间）                   | 连接环境的目标库（不能实时读状态、读历史或检查漂移） |
| 在影子库验证迁移（需要“在影子库验证”权限）                       | 执行、回滚、标记为已执行，提交或审批执行申请         |
| 整批原子地修改工作副本（需要“修改工作副本”权限）                 | 修改连接串、执行策略、令牌，或整库导入覆盖           |
| 增量调整画布板块（需要“修改工作副本”权限）                       | 写入表在画布上的坐标（由自动排布与人工拖动决定）     |
| 查看画布修改历史和每次修改的差异                                 | 恢复画布修改历史（只能由人在界面上恢复）             |

发布和执行始终由人在 Dowel 界面上完成，走执行策略与审批；恢复画布修改历史也只能由人在界面上操作。

AI 的修改和画布编辑走同一个同步层：AI 读取之后，如果它依据的对象被别人改过或删掉，整批修改以 `conflict` 拒绝，一条都不生效。生效的修改会实时出现在所有打开模型的人面前，在**画布修改历史**里记在你名下并带 `MCP` 标记，可以像其他修改一样恢复。

## 2. 新建 MCP 令牌 {#create-token}

MCP 令牌属于**你本人**，不属于项目：

1. 打开 **个人设置 → MCP 访问**，选择 **新建 MCP 令牌**。
2. 选择权限：
   - **读取**：始终包含。
   - **在影子库验证**：在影子库里执行迁移并比对结果。
   - **修改工作副本**：需要在该项目上是项目编辑者及以上角色。
3. 选择项目范围：我能访问的全部项目，或只允许指定项目（最多 50 个）。
4. 选择有效期（7 天到 1 年，默认 30 天）。令牌必须设置有效期。
5. 复制令牌或现成的客户端配置。**令牌只显示这一次。**

每个请求的实际权限 = 你**当前**的项目角色 ∩ 令牌的权限 ∩ 令牌的项目范围。你失去某个项目的权限或被降权时，令牌也立刻跟着失去。

每人最多 20 个有效的 MCP 令牌。在同一页面吊销令牌，立即失效。

## 3. 配置客户端 {#clients}

把 `https://dowel.example.com` 换成你的 Dowel 地址，`dwm_…` 换成你的令牌。

**Claude Code**

```bash
claude mcp add --transport http --scope user dowel https://dowel.example.com/api/mcp \
  --header "Authorization: Bearer dwm_…"
```

**Cursor**（`~/.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "dowel": {
      "url": "https://dowel.example.com/api/mcp",
      "headers": { "Authorization": "Bearer dwm_…" }
    }
  }
}
```

**VS Code**（运行命令 **MCP: Open User Configuration**）

```json
{
  "servers": {
    "dowel": {
      "type": "http",
      "url": "https://dowel.example.com/api/mcp",
      "headers": { "Authorization": "Bearer dwm_…" }
    }
  }
}
```

!!! warning "不要把令牌提交到仓库"
把配置写在**用户级**设置里。不要把含 MCP 令牌的文件提交到项目的 `.cursor/mcp.json` 或 `.vscode/mcp.json`。

其他支持 **Streamable HTTP** 传输的 MCP 客户端，使用地址 `/api/mcp` 和请求头 `Authorization: Bearer dwm_…` 即可。

## 4. 工具 {#tools}

工具的 `project` 参数可以是项目 ID，也可以是 `owner/project` 路径。客户端只会看到令牌权限允许的工具。

| 工具                | 权限 | 作用                                                                                                                                                                 |
| ------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`     | 读取 | 你能访问的项目（限令牌的项目范围）                                                                                                                                   |
| `get_model`         | 读取 | 工作副本：摘要，或带版本号的完整对象，以及当前 `seq`；另附画布板块、方言能力和推导出的最低目标版本；可按 schema、板块、关键字过滤，可附带诊断（见下文）              |
| `get_table`         | 读取 | 一张表的列、主键、约束、索引和分区，以及所在板块 `sectionId`、挂在表上的触发器 / 策略 / 排他约束（`opaques`）和依赖这张表的视图、函数等（`dependentOpaques`）        |
| `get_objects`       | 读取 | 枚举、序列、扩展，以及视图、函数、触发器等不透明对象的完整定义（含 DDL 与依赖）；按 ID、种类、schema 或关键字查询，见下文[对象上下文](#objects)                      |
| `get_ddl`           | 读取 | 工作副本或某个版本的 `CREATE` DDL                                                                                                                                    |
| `list_versions`     | 读取 | 版本链                                                                                                                                                               |
| `get_version`       | 读取 | 一个版本及其冻结的升级 / 回滚迁移                                                                                                                                    |
| `preview_migration` | 读取 | 两个版本之间的升级 / 回滚 SQL（默认：最新版本 → 工作副本）                                                                                                           |
| `list_environments` | 读取 | 环境及其缓存的当前版本、漂移状态和缓存时间                                                                                                                           |
| `list_history`      | 读取 | 画布修改历史（默认按编辑会话归组），见下文[画布修改历史](#history)                                                                                                   |
| `get_history_diff`  | 读取 | 一条历史或一整组编辑会话的净变化与迁移差异，见下文[画布修改历史](#history)                                                                                           |
| `list_mutators`     | 读取 | 可用的修改操作（复合宏 `defineTable` / `alterColumn` 排在最前）及其说明和参数的 JSON Schema                                                                          |
| `verify_migration`  | 验证 | 在影子库里执行迁移并比对结果（等同界面上的“在影子库验证”，与发布同一套验证）；不指定环境时 `ok` 为 true 才表示现在发布能通过验证，否则 `code` 给出发布会被拒绝的原因 |
| `apply_changes`     | 修改 | 整批原子执行修改操作；参数 `baseSeq`（来自 `get_model`）、`ops`（最多 100 个）、可选 `summary`（意图说明，最多 500 字）、`dryRun`；新对象的 ID 写 `"$ref:<别名>"`    |
| `manage_sections`   | 修改 | 增量调整画布板块；参数 `actions`（最多 50 个）、`dryRun`；见下文[画布板块](#sections)                                                                                |

典型流程：`get_model`（记下 `seq`）→ 用这个 `baseSeq` 调 `apply_changes` → `preview_migration` → `verify_migration` → 由人在 Dowel 里评审并发布。

`apply_changes` 的几点约定：

- **一次调用 = 一次提交**：整批操作作为一个提交写入工作副本（一个新的 `seq`），在 **画布修改历史** 里只占一条“批量修改”记录，带上你传的 `summary`；要整批撤销，在历史里恢复到它的前一条即可。响应里的 `opCount` 是展开后的底层操作数（最多 500 个）。
- **冲突与错误定位**：任一操作不合法，或基于旧 `baseSeq` 依据的对象已被别人修改，整批都不会提交，错误里的 `index` 指向最早出错的那个操作；复合宏出错时还会带上 `path`（宏内位置）和 `mutator`（展开出的底层操作），见下文。
- **没有净变化**（例如建了又删，或者 `alterColumn` 要改的值和现在一样）时返回 `noop: true`，不产生提交、不记审计。
- **严格按对象 ID 修改**：修改、删除已有对象时只认对象 ID（`get_model` / `get_table` 返回的 `id`），或本次调用里前面新建对象的 `"$ref:<别名>"`，绝不按名字猜测；这样改名不会断链，并发冲突也能精确判断。
- **写后自检**：响应（包括 `dryRun: true`）都带 `diagnostics`：完整的模型校验错误，以及按项目里版本最低的环境（读平台缓存的版本号，不连接目标库）做的静态兼容性 `errors` / `warnings`。它们不阻止这次修改，但有校验错误时发布版本会被拒绝（`blocksPublish: true`）。

`get_model` 的附加上下文（`summary`、`full` 以及超过 200 张表时的截断结果都有）：

- `capabilities`：项目方言的能力（是否支持多 schema、枚举、序列、分区、事务性 DDL、标识符长度上限等）。
- `target`：按项目各环境**缓存的**数值版本号推导出的最低目标版本，例如 `{ "label": "PG 15", "features": { "virtualGenerated": false, … }, "source": "platform_cache", "environments": { "total": 3, "withCachedVersion": 2 } }`；与 `apply_changes` 的 `diagnostics.target` 一致。没有环境、版本还没缓存或是 SQLite 时 `label` / `features` 为 `null`。只读平台库，不连接目标库。
- `sections`：画布板块。摘要里是 `{ id, name, color, tableCount }`，每张表另带 `sectionId`（不在板块里为 `null`；分区子表跟随父表，父表在别的 schema 也一样）；`detail: "full"` 时是 `{ id, name, color, tables }`，`objects` 里仍然只有模型对象。已删除的表不会出现在板块里。

`get_model` 的参数（都可省略；同时给出时取交集，`counts` 是过滤后的数量）：

| 参数          | 说明                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`      | 只看一个 schema（ID 或名字）；表上的触发器、策略、排他约束跟随表所在的 schema                                                                                                                           |
| `detail`      | `summary`（默认）或 `full`；`full` 在过滤后超过 200 张表且没给 `schema` 时只返回摘要并标记 `truncated: true`                                                                                            |
| `q`           | 关键字（不区分大小写）：匹配表名、schema 名、表注释和列名（命中的列列在 `matchedColumns`，最多 10 个），以及枚举、序列、扩展、视图等对象的名字和注释；分区父表命中时带上全部分区                        |
| `section`     | 板块 ID、`$none`（不在任何板块里的表），或板块名称（不区分大小写，必须唯一；重名时返回 `invalid_arguments` 并列出候选 ID）；只返回这些表和挂在这些表上的对象，`full` 时另带被这些表的列引用的枚举和序列 |
| `diagnostics` | `true` 时附带和 `apply_changes` 相同的 `diagnostics`（只读平台缓存，不连接目标库）                                                                                                                      |

传了 `q` 或 `section` 时响应带 `filter`（回显生效的 `schema`、`section`、`q`）。摘要里枚举带 `values`，序列带 `options`、`ownedBy`，扩展带所在 `schema`，视图、触发器等对象带 `parentKind`（`schema` 或 `table`）以及所在表的 `tableId` / `table`。

### 对象上下文 {#objects}

`get_objects` 读取表以外的对象：枚举、序列、扩展，以及视图、物化视图、函数、过程、域、类型、聚合、触发器、策略、排他约束这些不透明对象。

- 按 `ids`（最多 50 个；不存在或是表、列等其他对象的 ID 列在 `missing`，表请用 `get_table`）查询，或者用 `kind`（`enum`、`sequence`、`extension`、`opaque`）、`objType`（如 `view`、`function`、`trigger`）、`schema`、`q` 过滤，至少给 `ids`、`kind`、`objType`、`q` 之一。
- 结果顺序固定，用 `limit`（最多 100，默认 50）和 `offset` 翻页，响应带 `total` 与 `nextOffset`。
- 每个对象是完整定义加 `ver`、`schema`；不透明对象另带 `parentKind`、`tableId`、`table` 和解析后的依赖 `deps: [{ id, kind, name }]`。
- 一页的 DDL 合计最多 20 万字符，超出后的对象省略 `ddl` 并标记 `ddlOmitted: true`，响应带 `truncated: true`；需要时按 `ids` 单独读取。

### 画布板块 {#sections}

板块只属于画布布局，不进入模型、SQL、迁移、版本，也不占画布修改历史的 `seq`。`manage_sections` 在服务器上基于**最新**的板块逐个应用增量动作，不会整体覆盖别人刚建的板块；结果实时推送给打开模型的人。

| 动作            | 参数                                                       | 说明                                                                             |
| --------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `create`        | `name`，可选 `ref`、`color`（`peer-1`…`peer-8`）、`tables` | 新建板块；ID 由服务器生成，`refs` 返回 `{ 别名: 板块 ID }`；不给颜色时按顺序轮换 |
| `rename`        | `section`、`name`                                          | 改名（1–64 个字符）                                                              |
| `recolor`       | `section`、`color`                                         | 改色                                                                             |
| `delete`        | `section`                                                  | 删除板块，其中的表变成未分组                                                     |
| `add_tables`    | `section`、`tables`                                        | 把表加入板块；已在其他板块的表会被移过来（响应的 `moved`）                       |
| `remove_tables` | `section`、`tables`                                        | 把表移出板块；表本来不在板块里时什么也不做                                       |

- `section` 写板块 ID，或者 `"$ref:<别名>"` 引用同一次调用里前面 `create` 的 `ref`；不会按名称猜测板块。表 ID 来自 `get_model`；分区子表不能单独加入（跟随父表）。
- 一次调用里的动作要么全部生效，要么都不生效；错误码有 `section_not_found`、`table_not_found`（带 `tableIds`）、`invalid`，`index` 指向出错的动作。参数里出现坐标（如 `x`、`y`、`positions`）或其他未知字段时返回 `invalid_arguments`。
- 最多 200 个板块，每个动作最多 500 张表。没有净变化时返回 `noop: true`；`dryRun: true` 只预演。两者都不写入、不记审计。
- 响应：`{ dryRun, sectionsVer, sections, refs, moved }`。如果提交时恰好有人在画布上改了板块，Dowel 会把这批动作重放到他的最新结果上；无法重放（例如目标板块刚被删除）时以人的修改为准，响应带 `superseded: true`。

```json
{
  "project": "acme/orders",
  "actions": [
    { "action": "create", "ref": "billing", "name": "计费", "tables": ["<表 ID>"] },
    { "action": "add_tables", "section": "$ref:billing", "tables": ["<表 ID>"] },
    { "action": "recolor", "section": "$ref:billing", "color": "peer-3" }
  ]
}
```

### 复合宏：`defineTable` 与 `alterColumn` {#macros}

`ops` 里除了底层操作，还可以写两个复合宏。它们由服务端在预演时展开成底层操作，可以和底层操作混排在同一次调用里，共用同一套 `$ref` 别名；整次调用仍然只产生一个提交，画布修改历史和提交记录里看到的都是展开后的底层操作。展开后的底层操作总数最多 500 个（即响应里的 `opCount`）。

**`defineTable`**：一次声明整张表，包括列（字段与 `addColumn` 相同，另可写 `comment`；列顺序就是数组顺序）、`primaryKey`、`uniques`、`checks`、`indexes`、`foreignKeys`、表 `comment`、`ext`，以及可选的 `partitionBy` / `partitions`。约束和索引可以写 `name`（显式名）与 `comment`。各对象的 `id` 都可以省略（自动生成），需要在后面引用时写 `"$ref:<别名>"`。

```json
{
  "name": "defineTable",
  "args": {
    "id": "$ref:orders",
    "schema": "public",
    "name": "orders",
    "comment": "订单",
    "columns": [
      { "id": "$ref:orders.id", "name": "id", "type": "bigint", "identity": { "always": true } },
      { "name": "user_id", "type": "bigint", "notNull": true },
      { "name": "status", "typeRef": "public.order_status" },
      { "name": "parent_id", "type": "bigint" }
    ],
    "primaryKey": { "columns": ["id"] },
    "checks": [{ "name": "ck_orders_user", "expr": "user_id > 0" }],
    "indexes": [{ "elements": [{ "column": "user_id" }] }],
    "foreignKeys": [
      { "columns": ["user_id"], "refTable": "public.users", "refColumns": ["id"] },
      { "columns": ["parent_id"], "refTable": "orders", "refColumns": ["id"], "onDelete": "cascade" }
    ]
  }
}
```

名称解析的边界：

- **本表的列**：约束、索引、分区键可以按列名、列 ID 或 `$ref` 引用本次新建的列（大小写规则与方言一致：SQLite / MySQL / SQL Server 不区分大小写）。
- **新建时的引用**：`schema`（省略时用方言默认 schema，如 `public` / `dbo`；模型里只有一个 schema 时就用它）、列的 `typeRef`（PostgreSQL 枚举）与 `default.nextval`（序列）、外键的 `refTable` / `refColumns`、`partitions[].schema`，可以写对象 ID、`$ref`、限定名（`schema.name`）或全局唯一的名字。外键可以引用本表（自引用）或本次调用里前面已建的表。
- **`alterColumn` 的引用**：`typeRef` 与 `default.nextval` 只是对枚举 / 序列的引用，规则同上（对象 ID、`$ref`、限定名或全局唯一的名字）；但要修改的列本身（`id`）只认列 ID 或 `$ref`，不按名字解析。
- 名字找不到、或者有多个同名对象（例如两个 schema 里都有 `users`）时报错，并列出候选，请改用限定名或对象 ID。
- **循环外键**（A 引用 B、B 又引用 A）：先用 `defineTable` 建好所有表，再在同一次调用的末尾用底层 `addForeignKey` 补上剩下的外键。

各方言的自增写法：PostgreSQL 用列的 `identity`；SQL Server 用 `ext.mssql.identity`（`{ "seed": "1", "increment": "1" }`）；MySQL 用 `ext.mysql.autoIncrement`；SQLite 用 `INTEGER` 单列主键加 `ext.sqlite.autoincrement`。在不支持的方言上写 `identity`、`typeRef` 或 `partitionBy` 会直接报错。

SQLite 的列类型按写入的声明保留（只做大写与空白压缩），`BIGINT`、`INT`、`BOOLEAN` 不会被换成 `INTEGER`；`INT` / `BIGINT` 单列主键不是 rowid 别名，不能加 `ext.sqlite.autoincrement`。非 STRICT 表里显式传 `type: ""` 表示无类型列（BLOB 亲和性，与 `ANY`、`TEXT` 不同）；`defineTable` 省略 `type` 仍会报缺少类型；STRICT 表只接受 `INT`、`INTEGER`、`REAL`、`TEXT`、`BLOB`、`ANY`。详见[数据库方言](dialects.md#sqlite-features)。

**`alterColumn`**：声明式地修改一个已有列。`id` 必须是已有列的 ID，或本次调用里前面新建的列的 `$ref`，**不接受列名**。可改字段：`name`、`type` / `typeRef`、`notNull`、`default`、`identity`、`ext`（整体替换，`null` 清空）、`comment`；不写表示不改，写 `null` 表示清除。

`ext` 是整体替换：传入的内容就是改完后的完整列扩展，`null` 清空。SQL Server 有一个例外：本次修改后列仍有默认值（按同一个 `alterColumn` 里改完 `default` 之后的结果判断；`default: null` 清掉默认值时不保留）、且默认约束用的是显式名（`ext.mssql.defaultNameMode: "explicit"`）时，只要你没在 `ext.mssql` 里写 `defaultName` / `defaultNameMode`，原来的显式名会自动保留，不会因为改了别的扩展项（如 `sparse`）被改回 `DF_<表>_<列>`；传 `ext: null` 或显式写这两个字段时按你的要求处理。

```json
{ "name": "alterColumn", "args": { "id": "0192…", "type": "bigint", "identity": { "always": false } } }
```

服务端按固定的安全顺序展开：取消 identity → 清除默认值 → 改名 → 改类型 → 改 NOT NULL → 设默认值 → 设 identity → 改 `ext` → 改注释；值已经一致的步骤直接跳过。所以把有默认值的列改成 identity、或者反过来，都可以一步写完。同时写 `identity` 和 `default`、或 `identity` 配 `notNull: false` 会直接报错。

**错误定位**：宏出错时，错误里除了 `index`，还有 `path`（宏内的位置）和 `mutator`（出错的底层操作；参数本身不合法时没有），消息以 `ops[<index>] <path>` 开头，例如：

```json
{
  "code": "invalid",
  "index": 0,
  "path": "defineTable(orders).foreignKeys[0]",
  "mutator": "addForeignKey",
  "message": "ops[0] defineTable(orders).foreignKeys[0] addForeignKey：两边列数必须相同",
  "currentSeq": 12
}
```

另有只读资源：`dowel://projects`、`dowel://projects/{owner}/{project}/model`、`…/ddl`、`…/versions`、`…/environments` 和 `dowel://mutators`。

### 画布修改历史（只读） {#history}

AI 可以查看[画布修改历史](modeling.md#canvas-history)，但不能恢复：恢复只能由人在画布的 **修改历史** 面板里确认完成。这两个工具只读平台库里的历史记录，不规范化模型、不连接影子库或目标库，也不记审计。

- `list_history`：从新到旧列出历史。默认 `grouped: true`，和界面一样把同一个人连续的普通编辑归成一个编辑会话（`seqFrom`…`seq`、`stepCount`、`ops`）；`grouped: false` 逐条列出。用 `beforeSeq`（上一页的 `nextBeforeSeq`）翻页，`limit` 最多 50（默认 20）。每条带操作人、时间、对象摘要、所在版本 `version`，MCP 修改带 `via: "mcp"` 和意图说明 `opSummary`（列表里超过 200 字的截断并标记 `opSummaryTruncated`）。
- `get_history_diff`：查看一条历史（`seq`）或一整组编辑会话（`from` = 组的 `seqFrom`，`seq` = 组尾，最多 50 步）。返回 `entry`（完整的 `opSummary`）、`objects`（新增 / 删除 / 修改的对象，最多 200 条）和 `diff`（迁移式差异，前 `maxItems` 条，默认 30、最多 100；单条 SQL 超过 2000 字截断并标记 `sqlTruncated`，`includeSql: false` 不返回 SQL）；`includeSteps: true` 另返回组内每一步。不返回完整模型，也不和当前画布比较（需要时用 `get_model` / `preview_migration`）。`seq` 超过当前序号时返回 `history_not_found`（带 `currentSeq`），区间不合法时返回 `invalid_arguments`。

### Prompts {#prompts}

Dowel 还提供 MCP Prompts（客户端里通常显示为斜杠命令或模板），引导 AI 按推荐顺序调用工具：

| Prompt                       | 需要的权限   | 参数                                      | 作用                                                                                                  |
| ---------------------------- | ------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `review_unpublished_changes` | 读取         | `project`                                 | 审阅还没发布的修改：迁移 SQL 风险、可能丢数据的操作，以及对应的修改历史                               |
| `review_canvas_history`      | 读取         | `project`，可选 `beforeSeq`、`limit`      | 浏览归组后的画布修改历史，总结每个编辑会话的净变化                                                    |
| `design_tables`              | 修改工作副本 | `project`、`requirements`，可选 `section` | 按需求设计新表，用一次 `apply_changes`（`defineTable` / `addForeignKey`）原子建好并检查 `diagnostics` |
| `refactor_column`            | 修改工作副本 | `project`、`table`、`column`、`change`    | 先查依赖再用 `alterColumn` 按列 ID 安全地改名、改类型                                                 |

- 客户端只会看到令牌权限允许的 Prompt；令牌带“在影子库验证”权限时，Prompt 才会建议运行 `verify_migration`。
- Prompt 只是指引文字：生成时不查询项目（不存在的项目也不会报错），项目权限在 AI 随后调用工具时检查。所有 Prompt 都会提醒 AI：发布版本、连接或在目标库执行迁移、恢复画布修改历史只能由人在 Dowel 里完成。

## 5. 安全与管理 {#security}

- **隔离**：MCP 令牌（`dwm_…`）只能访问 `/api/mcp`，`/api/mcp` 也只接受 MCP 令牌；会话 cookie 与 CI 令牌在这里一律被拒绝，MCP 令牌访问其他任何接口（包括 `/api/ci/...`）返回 `403 forbidden`。
- **审计**：修改（`model.mutate`）、调整画布板块（`sections.update`）与影子库验证（`model.verify`）记在你名下，带 `MCP` 标记和令牌前缀；新建、吊销令牌也记审计。
- **自动吊销**：用户被停用、管理员重置其密码、使用重置密码链接时，该用户的全部 MCP 令牌被永久吊销（重新启用不会恢复）；自己修改密码不吊销。用户需要先修改临时密码期间，其令牌的请求返回 `403 password_change_required`。
- **实例管理员**可以在 **管理后台 → 用户** 查看并吊销任意用户的 MCP 令牌；在 **管理后台 → 实例设置** 关闭 **允许 MCP 访问** 后，所有人都不能新建令牌，已有令牌的请求返回 `403 mcp_disabled`，重新打开后恢复。
- **限流**（按副本计数，多副本部署的总配额约为设定值 × 副本数）：
  - 按来源 IP 的认证失败：`DOWEL_MCP_FAIL_LIMIT`（默认 20）次 / `DOWEL_MCP_FAIL_WINDOW_MS`（默认 10 分钟）。缺头或格式不对不计数；IP 被限时，有效令牌仍可使用。
  - 每个令牌的请求：`DOWEL_MCP_RATE_LIMIT`（默认 120）次 / `DOWEL_MCP_RATE_WINDOW_MS`（默认 1 分钟）。
  - `verify_migration` 另计入按用户的连接限速（`DOWEL_CONNECTION_LIMIT`）。

### HTTP 错误 {#errors}

认证类错误在处理任何 MCP 消息之前以 JSON `{ "error": "…", "code": "…" }` 返回：

| 状态码 | `code`                                                                              |
| ------ | ----------------------------------------------------------------------------------- |
| 401    | `token_missing`、`token_invalid`、`token_expired`、`token_revoked`、`user_disabled` |
| 403    | `password_change_required`、`mcp_disabled`、`forbidden`                             |
| 429    | `rate_limited`（带 `Retry-After`）                                                  |

浏览器内客户端如果携带跨源 `Origin` 请求头，会在认证之前被来源校验拦截，返回 HTTP `403` 与通用的 `{ "error": "…" }` JSON（不含 `code` 字段，而不是 `McpHttpErrorBody`）。

工具执行失败在 MCP 消息里以 `isError: true` 返回，`code` 如 `project_not_found`、`forbidden`、`scope_required`、`invalid_arguments`、`conflict`、`invalid`、`base_seq_ahead`、`table_not_found`、`section_not_found`、`history_not_found`、`shadow_unavailable`、`shadow_config_changed`（影子库配置在验证途中变了，可直接重试）。
