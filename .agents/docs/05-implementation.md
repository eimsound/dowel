# 实现进展

记录代码的实际结构、测试方法、各阶段完成情况和已知限制。设计见 [04-ir-design.md](04-ir-design.md)，决策见 [02-consensus.md](02-consensus.md)。

## 1. 工程约定

| 项目         | 做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工具版本     | `.tool-versions`：Node 26.13.0、pnpm 12.21.0；TypeScript 7、Vitest 5、Biome 2、fast-check 4、zod 4                                                                                                                                                                                                                                                                                                                                                                       |
| 内部包       | **不设构建步骤**：`exports` 直接指向 `src/index.ts`，Node 26 直接运行 TS，Vite / Vitest 直接编译。只用可擦除的 TS 语法（`erasableSyntaxOnly`），导入写 `.ts` 后缀                                                                                                                                                                                                                                                                                                        |
| Turborepo    | 暂不使用：没有构建步骤，就没有需要缓存的东西。以后有了构建产物再加                                                                                                                                                                                                                                                                                                                                                                                                       |
| 检查命令     | `pnpm check`（= `biome check` + `tsc --noEmit` + `vitest run`）                                                                                                                                                                                                                                                                                                                                                                                                          |
| 测试用 PG    | `test/pg-container.ts`：有 `DOWEL_TEST_PG` 就用它；否则 Testcontainers 起 `pgvector/pgvector:pg18`（账号 `postgres`）。Vitest 的 `globalSetup`（`test/global-setup.ts`）和 Playwright 的 `globalSetup`（`e2e/global-setup.ts`）共用；每个测试文件用 `test/pg.ts` 的 `useTestDb` / `createTestDb` 建自己的库。没有 Docker 时打印警告、跳过需要 PG 的测试；`CI` 环境下没有 Docker 直接失败。拉不到 Docker Hub 时可设 `TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX=mirror.gcr.io/` |
| CI           | `.github/workflows/ci.yml`：check（lint、类型检查、单元测试）、heavy（随机闭环 + 命名规则 `RUNS=5000`）、e2e（Playwright）。本地默认用例少（随机闭环 100 轮约 20 秒），大规模随机测试靠 CI                                                                                                                                                                                                                                                                               |
| 随机测试参数 | `RUNS=轮数`、`SEED=种子`、`TIME_LIMIT=毫秒`（缩小反例的总时长上限）、`TIMING=1` 打印每轮耗时；`STATS=1` 运行生成器覆盖面统计；`CASE='<反例 JSON>'` 运行调试用例，打印两个版本和迁移语句                                                                                                                                                                                                                                                                                  |

## 2. 代码结构

```
packages/
  core/       IR（ir.ts）、模型查询与校验（model.ts）、编辑操作 = 未来的 mutator（edit.ts）、
              PG 命名规则（pg/naming.ts）、标识符引用（pg/quote.ts）、迁移规划器（pg/plan.ts）
  engines/    PG 快照读取（pg/snapshot.ts、pg/opaque.ts）、快照 → IR 导入（pg/import.ts）、Db 接口（pg/db.ts）
  verifier/   影子库清空、执行步骤、闭环验证（src/index.ts）；随机生成器和随机测试（test/）
```

### 2.1 规划器 `plan(from, to)` 的阶段

规划时维护一份“当前状态”，每生成一步就更新它，所以每条语句引用的都是当时实际存在的名字；结束时逐个对象核对与目标版本一致。

| 阶段      | 内容                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| P0        | 删晚期不透明对象（视图、触发器等）：被删除的、定义变了的、所依赖对象要删除 / 重建 / 改类型的     |
| P1～P2    | 删外键；删其他约束和索引（被删除的和要重建的）                                                   |
| P3～P5    | 删要重建的生成列、删表（分区子表先删）、删列（生成列先删）                                       |
| P5b       | 提前去掉 identity 和 NOT NULL（腾出它们占用的名字）                                              |
| P6        | 改名；互换、链式改名先改成临时名 `_dowel_tmp_N`；后面才删除的对象如果占着新名字也先改临时名      |
| P7～P8b   | 建 schema、扩展、枚举（加值；删除或重排值时重建类型）、早期不透明对象（域、类型、函数、聚合）    |
| P9～P10   | 建序列、改序列选项；建表（分区子表先建成普通表再 `ATTACH PARTITION`，与 pg_dump 相同）           |
| P11～P12  | 加普通列；改列（去 identity → 去默认值 → 改类型 → NOT NULL → 设默认值 → 加 identity → 加生成列） |
| P13～P14  | 序列归属；删早期不透明对象、序列、枚举、扩展、schema                                             |
| P15～P16b | 加主键 / 唯一 / CHECK、建索引；加外键；建晚期不透明对象（按依赖排序）                            |
| P17       | 注释                                                                                             |

要点：

- **改类型的 USING**：只在确定有直接转换时直接转（数值类型之间、任一端是文本类型、同一类型只改修饰符），否则经由 `text` 转换；数组维度不变时按元素转（`::text[]`）。
- **晚期 / 早期**：视图、触发器、策略、排他约束总是晚期；域、类型、函数、聚合如果依赖了表、列、序列或晚期对象（例如函数返回表的行类型），也算晚期。

## 3. 测试

| 测试                             | 内容                                                                                                                                                                 | 结果                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `verifier/test/random.test.ts`   | 随机生成两串编辑（30 多种操作，名字池含关键字、空格、超长名、中文），得到版本 1、2，在 PG 18 上做 up / down 双向闭环验证（2026-11-18 前用 PGlite）                   | 见第 4 节                |
| `engines/test/pagila.test.ts`    | pagila（71 张表含 55 个分区、479 列、9 个函数、7 个视图、1 个物化视图、16 个触发器、2 个域、1 个聚合、pgvector）：导入 → 从 IR 重建，快照完全一致；`plan(m, m)` 为空 | 通过                     |
| `engines/test/naming.test.ts`    | 随机表名 / 列名（超长、多字节）建无名约束，推导名与 PG 实际起的名字一致（含重名加数字）                                                                              | 150 轮通过（CI 5000 轮） |
| `engines/test/roundtrip.test.ts` | 基础对象、多 schema、引号与关键字名字的导入往返                                                                                                                      | 通过                     |
| `core/test/edit.test.ts`         | 表达式改写（列改名、类型改名）                                                                                                                                       | 通过                     |

随机生成器每轮平均约 25 个对象、12 步迁移，覆盖 30 种语句；在本地容器里的 PG 18 上每轮约 170ms。

## 4. 进展

### M1a 核心引擎（2026-11-18）

- 两条验收标准：随机闭环测试（目标 100%）、真实 schema 导入后原样导出（pagila，已通过）。
- 随机测试过程中发现并修正的问题（每一个都有对应的修正，记录在这里供以后参考）：
  1. 新建对象的注释没有生成 `COMMENT`（当前状态复制了目标对象的注释）。
  2. 移动列到“自己前面”时排序键重复。
  3. 删列顺序：生成列必须先于它引用的列删除。
  4. 推导名重算时把列自己的 NOT NULL / identity 序列名当成了别人占用。
  5. 加枚举值的反向迁移（删值）不支持 → 实现枚举类型重建。
  6. 枚举重建后注释丢失。
  7. 快照把外键误读为带 `NULLS NOT DISTINCT`（外键的 `conindid` 指向被引用表的唯一索引）。
  8. `bigint → boolean` 没有直接转换 → 没把握时经由 text。
  9. 列改名时把 `::public."user"` 里类型名的后半段当成列引用改掉了。
  10. 生成列在改类型之前加入，导致被引用列无法改类型 → 生成列放到改列之后。
  11. 改名目标被将要去掉的 identity 序列名占用 → identity 和 NOT NULL 提前去掉。
  12. 数组变标量时中转类型错误（`text[]::bigint`）。
  13. 枚举重建时，引用该列的外键必须先删。

### 已知限制

- 分区表只读：表内结构的修改会被规划器拒绝（M2 支持）。
- 表移到其他 schema、列移到其他表：规划器拒绝。
- 扩展只支持新增和删除，不支持修改。
- 视图上的触发器暂不读取。

### M1a 验收结果

- 随机闭环测试：最后一次长测 5000 轮全部通过（约 10 分钟）。
- pagila 导入 → 重建：结构完全一致。

### M1b 服务端（2026-11-18）

| 部分           | 位置                             | 说明                                                                                                                                                                                    |
| -------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mutator 注册表 | `packages/core/src/mutators.ts`  | 30 个操作，zod 校验参数；`readsOf` 取参数里的对象 + 表达式引用的列作为冲突判断的依据                                                                                                    |
| 同步层         | `packages/sync`                  | 按 04 第 2 节实现：`Room`（服务器）、`SyncClient`（客户端）、协议。另有 `Room.replace`（系统身份整体替换，导入 DDL 用）和只读成员拒绝                                                   |
| 服务           | `apps/server`                    | Hono + WebSocket 同一端口；内置认证；平台库（SQLite / PG，2026-11-18 前为 PGlite / PG）；房间按需加载（快照 + 操作日志），每 200 个提交写一次快照；画布布局和在线状态单独转发、不进日志 |
| 影子库         | `apps/server/src/shadow*.ts`     | 导入 DDL、闭环验证 + 锁和重写分析。~~生产用子进程 PGlite、测试用本进程 PGlite~~（2026-11-18 已删除：影子库只能是真实实例）                                                              |
| 风险分析       | `packages/verifier` 的 `analyze` | 每一步单独事务：`pg_locks`、`relfilenode`、`pg_stat_xact_user_tables`；分 high / medium / low                                                                                           |

测试：同步层 5 个场景 + 200 轮随机（4 客户端、延迟、断线、草稿），服务端 6 项集成测试（真实 HTTP + WebSocket）。

M1b 中发现并修正的问题：

1. 客户端重放待确认修改时，目标对象已被别人删除 → `get()` 抛的是普通 Error 导致崩溃；改为 `EditError`（`core/src/errors.ts`）。
2. **编辑操作不检查表达式里的列名**：服务器接受了引用不存在列的 CHECK。加入 `checkExprColumns`（关键字除外）。
3. 子进程影子库超时被杀后，下一个请求发给了正在退出的旧进程。

尚未做（M1 范围内，排在界面之后）：

- 表达式规范形式（`canon`）和不透明对象 DDL 的重新规范化（改名后视图 DDL 会过期，见“已知限制”）。
- ~~连接真实 PG 实例（同实例影子库、从线上库导入）：M1 可用 PGlite（PG 18）完成全部检查；真实实例放到 M2 多版本时一起做。~~（已补完，见下文）

### M1c 界面（2026-11-18）

| 部分     | 位置                               | 说明                                                                                                                                               |
| -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 应用     | `apps/web`                         | React 19 + Vite 8 + Tailwind 4；TanStack Router / Query；中英文（i18next）                                                                         |
| 工作区   | `src/workspace.ts`                 | WebSocket 连接同步房间（断线指数退避重连；只处理当前连接的事件）、`SyncClient`、布局、在线成员；`useSyncExternalStore`                             |
| 画布     | `components/Canvas.tsx`            | @xyflow/react 13 + elkjs 自动布局；分区子表折叠到父表；拖动后同步位置                                                                              |
| 属性面板 | `components/Inspector.tsx`         | 表 / 列 / 约束 / 索引 / 枚举 / 序列编辑；输入框是“草稿”：获得焦点时记下依据的版本，保存时一并提交                                                  |
| 对话框   | `components/Dialogs.tsx`           | 导入 SQL、保存版本、迁移（升级 / 回滚脚本、影子库验证、逐步风险）、成员                                                                            |
| 通用组件 | `Modal` / `Toasts` / `Tabs`        | 按 modern-web-guidance：原生 `<dialog>` + `showModal()`；`popover="manual"` 的通知区；`focusgroup` 选项卡；popover 和 focusgroup 按需加载 polyfill |
| 部署     | `Dockerfile`、`docker-compose.yml` | 单容器（服务端提供前端构建产物）；平台库默认 SQLite（卷 `/data`）                                                                                  |

端到端测试（`pnpm e2e`，Playwright，headless Chromium，服务端用内存中的 SQLite 平台库；需要 PG 的用例用 Testcontainers）：

| 测试                 | 内容                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/basic.spec.ts`  | 建表、改名、加列、改类型、非空、CHECK、SQL 视图、保存版本、列改名后约束名和表达式跟着改、迁移脚本是 `RENAME` 而不是重建、影子库验证通过 |
| `e2e/collab.spec.ts` | 两个浏览器：邀请成员、实时同步；李四编辑表名期间张三先改了名 → 李四保存被拒绝并提示“表 accounts 已被 张三 修改”；只读成员无法编辑       |

M1c 中发现并修正的问题：

1. **WebSocket 在开发模式下不停重连**：React StrictMode 挂载两次，旧连接晚到的 `onclose` 把共用的客户端标为断线并安排重连。改为只处理当前连接的事件。
2. **影子库缺少扩展**：导入 pagila 时 `extension "vector" is not available`。影子库改为加载 PGlite 自带的常用扩展和 pgvector（`apps/server/src/shadow-pglite.ts`），启动约 1.4 秒。
3. **SQL 函数在它引用的表之前创建会失败**：影子库会话固定 `check_function_bodies = false`（与 pg_dump 相同）；pagila 测试补上“从空库迁移到 pagila 再回滚”的闭环验证（原测试碰巧沿用了 pagila 脚本设置的会话参数）。
4. **下载的迁移脚本没有带会话设置**：现在脚本开头带上 `SESSION_SETTINGS`（D8）。
5. **列改名导致 CHECK 被删掉重建**（端到端测试发现）：PG 改名时会自动更新表达式，规划器比较定义前先按改名关系换算旧表达式，相同就只发 `RENAME`。
6. **jsonb 重排键顺序导致假差异**（端到端测试发现：凭空出现 `SET INCREMENT BY 1 …`）：比较模型改用与键顺序无关的 `deepEqual`。
7. **平台库连真实 PG 时 jsonb 被存成字符串**：postgres.js 会按列类型再序列化一次。SQL 里统一写 `$n::text::jsonb`。服务端集成测试现在在 SQLite 和 PG 两种平台库上各跑一遍。
8. 预览浏览器（Tcode）环境不支持 WebSocket（连无关的回显服务也连不上），界面测试改用 Playwright。

### M1b 补完：同实例影子库（2026-11-18）

此前我自行把同实例影子库推到 M2、并把 M1 标为完成，与共识不符；已补完。

| 部分           | 位置                                   | 说明                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 环境           | `apps/server/src/app.ts`、`secrets.ts` | 项目的目标数据库；连接串 AES-256-GCM 加密存储（主密钥 `DOWEL_SECRET`，Q12）；列表只返回脱敏的连接串                                                                                                                                                                 |
| 影子库选择     | `shadows.ts`                           | 环境显式配置的影子库 → 目标实例上的 `{原库名}_dowel`；**项目没有环境或影子库不可用时报错，不兜底**（2026-11-18）。生产环境默认不用同一实例，需明确允许或另配影子库                                                                                                  |
| 同实例影子库   | `targets.ts`                           | 有 `CREATEDB` 就自动建库，否则提示手动执行的语句；名字超长时截断加哈希；单连接、`lock_timeout` / `statement_timeout`、advisory lock 排队                                                                                                                            |
| 安全保护       | `targets.ts`                           | 影子库上打 `COMMENT ON DATABASE` 标记，**只有带标记的库才会被清空**；显式指定的影子库只有为空库时才打标记；每次检查前再核对                                                                                                                                         |
| 从线上库导入   | `pullSchema`                           | 只执行 `SET` 和 `SELECT`                                                                                                                                                                                                                                            |
| 沿用 ID        | `packages/engines/src/pg/reconcile.ts` | 重新导入（SQL 或线上库）时按限定名把对象对回已有 ID（04 3.4），改名识别和画布布局不丢                                                                                                                                                                               |
| 过滤所有者语句 | `shadow.ts` 的 `stripOwnership`        | pg_dump 输出中的 `OWNER TO`、`GRANT`、`REVOKE` 在真实实例上常因角色不存在而失败，且不在 IR 范围内                                                                                                                                                                   |
| 派生数据       | `derive.ts`                            | 修改提交后（防抖 300ms）在影子库里从基线重放到当前模型，读回引擎规范形式：表达式（CHECK、默认值、生成列、索引）和不透明对象 DDL（改名后视图定义随 PG 自动更新）。带版本检查写回；基线持久化在 `branches.baseline`；验证、生成迁移、导出 DDL、保存版本前先等刷新完成 |
| 界面           | `Dialogs.tsx`                          | “环境”对话框（添加、测试连接、从此库导入、删除）；迁移对话框可选验证用的影子库，结果显示实际用的影子库                                                                                                                                                              |

**设计变更**：表达式不再分“原文 + 规范形式”两份存（04 1.5 / D7），而是由服务器直接把原文换成规范形式（带版本检查，不会覆盖并发修改）。数据结构更简单，界面本来也是显示规范形式。

验收（`apps/server/test/targets.test.ts`，用测试 PG 实例）：在真实 PG 18 实例上
“从线上库导入 → 经同步层修改（列改名、加列、加 CHECK、枚举加值）→ 生成迁移 → 自动建 `shop_dowel` 并验证通过 → 把迁移执行到 `shop` 上（业务数据保留）→ 再导入，与工作副本无差异”；
另测：重新导入不产生任何变化（ID 沿用）、生产环境默认拒绝同实例、非空无标记的库拒绝作影子库、导入 SQL 时用环境的影子库且不动业务库。端到端测试 `e2e/environments.spec.ts` 覆盖界面上的同一流程。

补完过程中发现并修正的问题：

1. **列改名后，引用它的视图 DDL 过期**，从零建出目标版本时视图建不出来 → 派生数据刷新（见上）。
2. **表达式原文与引擎规范形式不同**（`(note <> '')` vs `(note <> ''::text)`），从线上库重新导入后被当成变化 → 同上，规范化所有表达式。
3. **派生刷新把第一次运行时的模型当成已规范化的基线**（端到端测试发现：操作很快时，未规范化的 CHECK 成了基线）→ 基线持久化；没有基线时从空模型开始规范化。
4. 测试里执行下载的迁移脚本后，`search_path` 为空，未加 schema 的表名找不到（脚本本身行为正确）。

### 去掉 PGlite 兜底（2026-11-18，用户决定）

用户决定：影子库不用 PGlite 兜底——浪费精力，且 PGlite 与目标实例的版本、扩展不同，可能造成不一致；真实影子库不可用就报错。

- 删除 `shadow-process.ts`（子进程 PGlite）、`shadow-worker.ts`、`shadow-pglite.ts`（扩展加载）、本进程 PGlite 影子库，以及服务端对 `@electric-sql/pglite-pgvector` 的依赖。M1b、M1c 里为 PGlite 影子库做的工作（子进程超时强杀、扩展加载）随之作废。
- 项目没有环境时，导入 SQL、验证迁移返回 422“项目还没有配置环境……”；迁移对话框里禁用验证并提示先配置环境。
- 表达式规范化在后台进行，没有环境时不执行；添加环境后立即补做（从空模型开始规范化）。
- 测试：服务端里需要影子库的测试、端到端的基础流程和环境测试都需要 `DOWEL_TEST_PG`（真实 PG），没有时跳过；不需要影子库的测试照常运行。服务端另有一项测试断言“没有环境时验证、导入直接报错”。
- ~~仍在使用 PGlite 的地方（都不是影子库）：开发时的平台库默认值；core / engines / verifier 的单元测试。~~ 已全部去掉，见下一节。

### 平台库改 SQLite、测试改 Testcontainers（2026-11-18，用户决定）

用户决定：平台库支持 SQLite 或 PostgreSQL，默认 SQLite；需要 PG 的测试用 Testcontainers，没有 Docker 时跳过并警告，大规模测试靠 CI。仓库里不再有 PGlite。

- 平台库（`apps/server/src/db.ts`）：`DOWEL_DB` 为 `postgres://…` 时用 PostgreSQL，`:memory:` 为内存 SQLite，其他值为 SQLite 文件路径（默认 `./data/dowel.db`，镜像里 `/data/dowel.db`）。SQLite 用 `node:sqlite`，WAL、外键开启。
- 业务 SQL 只写一份（PG 写法的子集），SQLite 适配器负责：`$n` → `?n`；去掉 `::text::jsonb`；读出时按“表.列”解析 JSON 列、布尔列转 true/false；写入时 Date → ISO 字符串、布尔 → 0/1。迁移按方言生成列类型（`jsonb`/`text`、`timestamptz`/ISO 文本、`boolean`/`integer`）。会话过期判断改为传入当前时间，不用 `now()`。PG 侧把 `bigint` 读成 number，两种方言返回的数据形状相同。
- SQLite 只有一个同步连接：事务进行中（回调里有 `await`）时，其他语句和事务排队等待，不会混进事务。
- `engines` 的 `fromPglite` 换成 `fromPostgres`（适配 postgres.js，不引入依赖）。
- 测试：见第 1 节“测试用 PG”“CI”。pnpm 12 要求声明构建脚本：`pnpm-workspace.yaml` 的 `allowBuilds` 拒绝了 Testcontainers 间接依赖的 `ssh2`、`cpu-features`、`protobufjs`（可选的原生加速，不需要）。
- 结果：本地有 Docker 时单元测试 32 项通过（约 45 秒），端到端 4 项通过；没有 Docker 时 15 项通过、19 项跳过并打印警告。

### M1 完成情况

M1a、M1b、M1c 的验收标准都已满足（2026-11-18）。未做的：SQL 视图只读（依赖 Q3）；前端打包体积提示；托管数据库（RDS、Supabase、Neon 等）上的实测（Q7，需要云账号）。

### 产品化 P0（2026-11-19）

- **路由结构**：`apps/server/src/app.ts` 只组装依赖和中间件；各领域在 `src/routes/`（`auth`、`projects`、`members`、`versions`、`environments`、`sync`）。共享的 db、rooms、shadows、refresher、`replace`、限速器、`upgradeWebSocket` 放在 `routes/context.ts` 的 `AppContext` 里传给路由模块。`routes/index.ts` 控制注册顺序：认证 → WebSocket Origin → `requireUser` → 各接口；未登录的 WebSocket 还是 HTTP 401，已登录但不是成员时由路由用 4401 关闭。
- **鉴权**：`authz.ts` 的 `can(actor, action, resource)` 是纯函数；`access(c, ctx, action)` 只负责查成员角色再调用它。动作在 `Action` 和 `ACTION_MIN_ROLE` 里登记，现有规则仍是 viewer / editor / owner，实例管理员、令牌、组以后在 `can()` 里扩展。`requireUser` 目前只认会话 cookie，Bearer 的位置已留好。
- **平台库 JSON / 布尔列**：不再按全局列名判断。SQLite 的 `StatementSync.columns()` 给出结果列来自哪张表、哪个原始列，适配器用“表.列”查 `COLUMN_KINDS`，同名列在不同表可以是不同类型；新表 / 列在 `db.ts` 登记（测试用 `registerColumnKind`）。没有改旧列名，也不需要数据迁移。
- **审计**：`audit_events` 迁移（`at` 索引）；`audit(db, c, {...})` 从 `x-forwarded-for` 第一个地址或连接地址取 IP，写失败只记日志、不影响业务。已覆盖注册、登录成功 / 失败、退出、建项目、加成员、发布版本、环境增删、导入、拉取。
- **安全**：`security.ts` 统一 Origin 校验（变更请求和 WebSocket 升级；没有 Origin 放行）。反向代理部署设置 `DOWEL_TRUST_PROXY=1` 后才信任 `X-Forwarded-For`（取最后一个）和 `X-Forwarded-Proto/Host`；`DOWEL_PUBLIC_URL` 优先于转发头，两者都通过 `createApp` 的 `security` 选项注入。`secureHeaders` 的 CSP 是 `default-src 'self'`，放行行内样式和 `data:` 图片，`connect-src` 只写 `'self'`（CSP3 已包含同源 ws/wss）。登录限速在 `rate-limit.ts`：IP + 账号（默认 10 分钟 10 次）和 IP 总量（默认 30 次）分别计数，`attempt()` 同步检查并记录避免并发绕过，成功只撤销 IP + 账号 key；每隔一个窗口清扫过期 key，key 总数上限 10 万。登录 / 注册时先删请求里的旧会话再发新令牌。
- **共享接口类型（F6）**：`packages/api`（`@dowel/api`）只放 zod schema 和 `z.infer` 出来的类型。请求体 schema（登录、建项目、成员、版本、导入、验证、环境）从 server 路由搬到这个包，server 直接 import；响应类型同名导出，server 用 `c.json<T>(...)` 标注，web 从 `@dowel/api` import 形状（`api.ts` 只留 `api()` 和 `ApiError`）。没有用 Hono RPC `hc`：那会让 web 依赖 server 的整张类型图，和 TS 7 / 前端单独 tsconfig 组合起来更容易出问题；纯 schema 包对两端都只是一个普通 workspace 依赖。
- 踩坑：Hono 的 `app.use` 只对之后注册的路由生效，路由顺序本身就是行为的一部分；`c.json` 前设置 `Retry-After` 可以保留在响应里；SQLite 的列类型不能用来区分 JSON / 布尔（旧库都是 text / integer），所以按结果列来源表判断。

### 产品化 P1a 账户（2026-11-19）

- **迁移重建表**：SQLite 改不了 NOT NULL / UNIQUE，`users` 用“建 `users_new` → 拷数据 → 删旧表 → 改名”重建。迁移器新增 `sqliteRebuild` 标记：在事务**外**执行 `pragma foreign_keys = off` 和 `pragma legacy_alter_table = on`（外键 PRAGMA 在事务里不生效；legacy 让 RENAME 不去改写其他表里指向 `users` 的外键），事务里跑 `pragma foreign_key_check` 有问题就回滚，最后恢复两个 PRAGMA。PG 走 `alter table`。数据迁移在同一个事务里用参数化 SQL 跑：用户名由邮箱 @ 前面部分清洗生成，重名加 `-2`、`-3`，按 `created_at` 第一个用户升为 admin。`sessions` 直接重建（新增 id、时间、UA、IP），旧会话不保留，升级后需要重新登录。
- **初始化令牌**：`createApp` 每次生成一个随机令牌放在 `AppContext.setupToken`（只在内存，重启换新的），`main.ts` 在没有用户时打印到日志。`POST /api/setup` 校验后建 admin 并置空令牌，已有用户一律 409。另一种是无人值守：`DOWEL_ADMIN_USERNAME` / `DOWEL_ADMIN_PASSWORD` + `autoSetup(db)`。公开的 `GET /api/instance` 给登录页用（名称、是否可用密码登录、是否需要初始化）。
- **会话表字段**：`sessions(id, token_hash, user_id, expires_at, created_at, last_seen_at, user_agent, ip)`。`userOfToken` 同时检查会话未过期**和** `users.status = 'active'`，所以停用后残留的令牌也立即失效；`last_seen_at` 超过 60 秒才写一次，避免每个请求都写库。`/api/me/sessions` 用当前 cookie 的令牌哈希标出 `current`。
- **停用时断开 WebSocket**：`Peer` 增加可选的 `close(code, reason)`（`routes/sync.ts` 里接到 `ws.close`），`kickUser(userId, reason)` 关闭该用户在已加载房间里的所有连接（4403）、从 peer 集合移除，**只给真正踢掉了人的房间**广播在线列表。`Rooms.message()` 开头先确认 `r.peers.has(peer)`，不在就直接丢弃（不提交、不广播、不回消息），layout 分支再查一次；`leave()` 也只在真的移除了 peer 时才广播。`join()` **先把 peer 放进集合、再查一次 `users.status`**：停用若正好落在 WebSocket 升级和 join 之间，`kickUser` 要么已经看到这个 peer 并踢掉，要么这次查询读到 disabled 后自己关掉，不会漏。停用同时删会话：`PATCH /api/admin/users/:id` 里 `revokeSessions()` + `rooms.kickUser()`。
- **权限**：`authz.ts` 拆出 `ProjectAction` / `InstanceAction`，`can()` 里实例管理员放行一切，实例级动作只有实例管理员能做。`userActor(user)` 从 `users.role` 推出 `instanceAdmin`；`requireInstanceAdmin(action)` 接收动作参数，`routes/index.ts` 按前缀分别传 `instance.manage_users` / `instance.invite` / `instance.manage_settings`。用户名在 `usernameSchema` 里先 `trim` + 转小写再做格式校验（输入 `ZhangSan` 得到 `zhangsan`，不是报错）。
- **邀请与重置**：共用 `invites` 表（`kind` 区分 invite / reset），令牌只存 sha256，邀请默认 7 天、重置链接 24 小时；`group_ids` 先留着给 P1b。**一次性靠事务里的“认领”**：`claimInvite()` 就是一条 `update invites set used_at = …, used_by = … where token_hash = $1 and kind = $2 and used_at is null and revoked_at is null and expires_at > … returning …`；接受邀请时在同一事务里先认领、再建用户（建用户失败例如用户名冲突就整体回滚，令牌保持可用），提交后才开会话；重置密码同理，认领不到就不改密码。路由开头的那次查询只用来区分 404 / 410 的提示。撤销只对未使用的邀请生效（已使用 409），`inviteState()` 先判 used 再判 revoked。
- **密码登录开关**：`instance_settings` 键值表（value 是 JSON）。`password_login` 关闭时登录返回 403；没有 OIDC 提供方时拒绝关闭（422）。`DOWEL_ALLOW_PASSWORD_LOGIN=1` 是应急入口，`GET /api/instance` 也按有效值返回。
- **最后一个管理员 / 用户名唯一**：`PATCH /api/admin/users/:id` 的“先数管理员再更新”放进同一个事务，PG 用 `select … order by id for update` 锁住所有 active 管理员行；SQLite 的单连接事务本身就串行。用户名唯一冲突在 `db.ts` 的 `isUniqueViolation()` 里统一识别（PG `23505`，SQLite `errcode` 2067/1555），接受邀请、管理员建用户、`PATCH /api/me` 都转成 409。
- 坑：PG 推断不出 `$n is null` 的参数类型（`42P08`），这些查询改成按条件拼 SQL 或拆成两条，没有为此扩展 SQLite 适配器的类型转换剥离规则。
- 坑：SQLite 适配器原来的“`await` 检查 busy 再设置 busy”不是互斥锁——两次 `await` 之间两个事务会同时拿到锁，第二个 `BEGIN IMMEDIATE` 报 “cannot start a transaction within a transaction”（并发接受邀请的测试才暴露出来）。改成同步占位、再等上一段的 promise 链互斥锁，所有语句和事务都排成一队。
- 测试：`accounts.test.ts`（SQLite + PG 各跑一遍，含并发用例：同一邀请并发接受、同一重置链接并发使用、初始化并发、两个管理员互相降级、并发建同名用户 / 并发改用户名；以及登录耗时不泄露用户名、`DOWEL_ADMIN_*` 校验与启动失败）、`migration.test.ts`（按 v4 旧结构建库、造数据再升级）、`rooms.test.ts`（被踢出的连接发消息被丢弃、join 时复查状态、只给踢了人的房间广播）、`db.test.ts` 的 `isUniqueViolation()`、`server.test.ts` 增加“停用后 HTTP 401 + WebSocket 4403”。注册接口删除后，测试和 e2e 改用 `makeUser()` / 管理员建用户；e2e 的 `invites.spec.ts` 用独立服务实例读启动日志里的令牌，覆盖“初始化 → 邀请 → 接受 → 登录”。

### 产品化 P1b 组与授权（2026-11-19）

- **表**：`groups(slug 唯一, name, description, default_role, project_creation, created_at)`、`group_members(group_id, user_id, role admin|member)`、`grants(subject_kind user|group, subject_id, role, scope_kind instance|group|project|environment, scope_id, unique(subject, scope))`、`project_redirects(owner_slug, project_slug, project_id)`；`projects` 增加非空 `group_id`、组内唯一的 `slug` 和可空的 `default_role`（空表示沿用组）。`scope_kind` 表里保留了 `environment` 给以后的执行者用，接口只开放三种；实例范围的 `scope_id` 用空串（PG 的唯一约束里 NULL 不冲突，空串更省事）。
- **迁移（第 8 条）**：`projects` 在 SQLite 上重建（新增非空列 + 唯一约束），PG 先加可空列、填完再 `set not null` + 外键 + 唯一索引。数据迁移在同一个事务里跑，目标是升级后每个人的生效权限与升级前完全一致：按 `created_by` 给每个创建者建一个组（slug / 名字都是用户名，重名加后缀），组的 `default_role` 是 `none`；创建者只有当他**名下所有**项目在旧 `project_members` 里都是 owner 时才是组管理员，否则只是组成员，各项目的权限完全由迁移过来的授权决定（被降级 / 被移出项目的人升级后一样）；`created_by` 为空的项目归到 `default` 组，管理员只取 `status = active` 的实例管理员；项目 slug 由名字清洗生成、组内冲突加后缀；`project_members` 变成 `subject=user, scope=project` 的授权（owner → admin）后删除。SQLite 和 PG 的升级都在 `migration.test.ts` 里覆盖，并用 `effectiveRole()` 断言“创建者被降为 viewer / 被移出项目 / 是所有项目的 owner”三种情况。
- **生效角色**：`roles.ts` 的纯函数 `effectiveRole(roleContext, project)` 取四项最高（实例管理员 → admin；组管理员 → admin；组成员 → 项目 / 组的 `default_role`，`none` 表示没有；授权：对象是本用户或他所在的任一组、范围是本项目 / 本组 / 实例）。计算放在 JS：`loadRoleContext()` 每个用户只读一次（组成员 + 和他有关的授权），项目列表一次算完所有项目；比在两种方言里各写一段等价的 `union + max` SQL 更好读，人数规模对自托管实例完全够用。可见性统一在 `routes/context.ts` 的 `access()`：生效角色为空就 404，权限够看不够做才 403；`/api/resolve`、项目列表、组内项目列表和 WebSocket 用同一套判断。
- **即时生效（G6）**：只有一个 `Rooms.refreshLoaded()`：只遍历已经加载的房间，分支 → 项目一次反查，角色上下文和项目按整次刷新缓存（没人在线时零查询）；变了就发 `{t:'role', role}`（客户端切只读 / 可编辑），没了或被停用就 4403 断开（沿用停用账号的关闭码，客户端收到后不再重连）。组成员、默认权限、授权（项目 / 组 / 实例）、转组、删除组、停用或改实例角色之后都调它。`join()` 在把 peer 放进房间后还会用注入的 `resolveRole()` 再算一次（升级和 join 之间可能已经变了），成功时总会发一条 `role`，前端每次重连都先清掉本地角色、以这条消息为准。
- **写保护**：最后一次组管理员用事务内的计数保护（PG 锁组行，SQLite 事务串行），实例管理员例外；最后一次项目管理员在改动后的同一事务里用 `projectHasAdmin()` 检查（一条 SQL：组管理员 + 通过用户 / 组授权拿到 admin 的人；实例管理员不算，否则永远触发不了）。
- **界面**：路由改成 `/project/:owner/:project`，先 `GET /api/resolve/...` 换成项目 ID；旧的 `/p/:pid` 用项目信息跳转，旧路径解析（`redirected=true`）也用 replace 换地址。项目列表按组分区，“新建组”是对话框，建项目必须选组；“成员与授权”对话框分成直接授权 / 来自组默认权限的成员两块，另有项目默认权限和转组。
- **测试**：`groups.test.ts`（生效角色表驱动、每种项目接口对无关用户 404、授权增删改与谁能管、两个“最后一个管理员”保护、转组与旧路径、组有项目不能删、`group_creation=admin`、`project_creation=admins`、邀请加入组、WebSocket 降级 / 升级 / 踢出）；e2e 增加“管理员建组 → 邀请入组 → 能看项目 → 移出后 404 / 旧地址跳转”，协作与只读用例改成用授权实现。
- 坑：`update ... returning` 里的 JSON 列在 SQLite 上不一定能按来源表解析，接受邀请时改成在事务里再 `select group_ids` 读一次；`projectHasAdmin` 的检查因为实例管理员天然是项目管理员而实际难以触发，测试里临时停用实例管理员来覆盖这条分支。

### 产品化 P1c OIDC 与权限矩阵（2026-11-19）

- **OIDC 回调流程**：`/api/auth/oidc/:slug/start` 生成 state、nonce、PKCE（S256）的 code_verifier，302 到提供方；`/callback` 用 `openid-client` 做 discovery、换 token、校验 id_token（issuer、audience、nonce、签名），再按 `sub` 取资料。短时状态（state / nonce / verifier / mode / invite / next）存在平台库 `oidc_states`（10 分钟过期，DELETE RETURNING 一次性消费）；需要本人改用户名时，待确认资料放 `oidc_pending`，回调地址里的 cookie 只是随机令牌的引用。`next` 只允许站内相对路径。
- **回调地址**：优先 `DOWEL_PUBLIC_URL`；没设时复用 `security.ts` 的 `expectedOrigin()`（可信代理的 `X-Forwarded-Proto/Host`，否则请求的协议 + Host），两处规则一致，避免 Origin 校验和 OIDC 回调看到不同的对外地址。
- **身份**：`user_identities(provider_id, subject)` 唯一，`(provider_id, user_id)` 也唯一；已关联直接登录，已登录的 `mode=link` 关联到当前用户；邀请 / `auto_provision` 首次开户复用 `claimInvite()` 事务，用户名冲突整体回滚后转到 `/oidc/confirm`。**绝不按邮箱自动关联**。成功登录复用 `startSession()`，审计动作是 `auth.oidc_login`（密码登录是 `auth.login`）。
- **最后一种登录方式**：解除关联前检查密码或其他身份；删除 / 停用最后一个启用的提供方时，如果密码登录已关闭则 422。关闭密码登录仍然要求至少一个启用的提供方。
- **审计查询（G7）**：`GET /api/admin/audit`，实例管理员专用；action 前缀、actor（ID 或用户名）、target、时间范围过滤，按 `at + id` 倒序游标分页。审计动作清单由 `audit-coverage.test.ts` 用表驱动断言。
- **权限矩阵**：`permission-matrix.test.ts` 遍历 `app.routes`，每个 `method + path` 都必须在矩阵里登记（公开端点显式标 public），否则失败；身份包括未登录、停用、实例管理员、组管理员、组成员、直接授权（查看者 / 编辑者 / 项目管理员）、组授权成员、无关用户。约定：请求体故意用最小非法值，“过了鉴权”表现为 400 / 422；项目看不见是 404、角色不够是 403；需要目标库的端点用 `127.0.0.1:1` 只验证鉴权层，允许 4xx/5xx。WebSocket 单独测未登录 / 停用 / 无关用户被拒和查看者只读。

### 产品化 P2b 个人设置、管理后台、命令面板与窄屏（2026-11-19）

- **个人设置（`/account`）**：资料、密码、登录方式、会话、偏好五节做成嵌套路由，导航放在外壳的侧面板里。P1c 的 OIDC 关联回调默认落在 `/account`，所以沿用这个地址；回调分支里原来硬编码 `c.redirect('/account')`，现在两条关联路径都按 `state.next` 回去（关联入口传 `/account/identities`）。
- **`hasPassword`**：`/api/me` 多了这个字段（`User` 在 `userById` / `userOfToken` / `login` 里用 `toUser()` 把 `password_hash` 换成布尔值，哈希不出这一层）。纯 OIDC 用户第一次设置密码不需要旧密码；已经有密码时必须验证旧密码。
- **管理后台（`/admin`）**：同一个侧面板导航；`AdminLayout` 对非实例管理员渲染普通 404（不是 403），账户菜单里的入口也只对实例管理员渲染。用户管理、邀请、登录方式（含密码登录开关）、实例设置、实例级授权、审计日志六节。服务端的 422（最后一个管理员、关掉密码登录、最后一个启用的提供方）原样显示在界面上。
- **OIDC 提供方接口多返回 `callbackUrl`**：按 `callbackUrl()` 的同一套规则（`DOWEL_PUBLIC_URL` → 可信转发头 → 请求地址）算，管理界面只负责显示 / 复制；算不出来时为 null，并提示设置 `DOWEL_PUBLIC_URL`。
- **删除项目**：`DELETE /api/projects/:pid` 要求 `confirm` 等于 slug；`project.delete` 动作登记在权限矩阵里（项目管理员）。一个事务里删分支、快照、操作日志、拒绝记录、版本、环境、授权、跳转记录和项目本身，审计记录保留。提交后调用 `rooms.kickBranches()` 用 4403 断开在线连接，并把房间从缓存里移除。
- **命令面板（⌘K）**：combobox + listbox，焦点留在输入框；表清单通过可订阅的 `current-tables.ts`（`useSyncExternalStore`）从模型页交给外壳，选中表用 `window` 事件而不是路由参数；“新建项目 / 新建组”用 `/?new=project|group` 路由参数交给“我的项目”页，页面处理完用 `replace` 清掉参数（关掉对话框再重开也不会丢状态；对话框关闭 / 打开在状态里，快速连按 ⌘K 不会被原生的异步 `close` 事件抢走）。
- **窄屏抽屉**：`matchMedia('(max-width: 1023px)')`；抽屉关闭后才渲染“打开侧面板”按钮，所以关闭后的焦点要在一个 effect 里还给它（在关闭的那一刻同步 `focus()` 会拿到 null ref）。窄屏下属性面板改成 `fixed` 浮层。
- **首次设置密码只允许新会话**：`/api/me/password` 在 `password_hash is null` 时要求 `sessions.created_at` 在最近 10 分钟内，否则 403 并提示重新登录；写入用条件更新（`where password_hash is null`），并发只有一个成功、另一个 409；首次设置不吊销其他会话。前端在 403 时显示“用 XX 重新登录”入口（OIDC，回到 `/account/password`）。退出登录和“吊销当前会话”共用 `session.ts` 的 `useSignOut()`（先 `qc.clear()` 再回登录页）。
- **删除项目的内存清理**：事务提交后按被删掉的 ID 清理三份缓存——`rooms.kickBranches()`（断开 4403 并从房间表卸载）、`shadows.forget(eid)`（关掉影子库连接）、`refresher.forget(branchId)`（取消 timer、清空基线和重试计数）；测试用 `rooms.has()` / `shadows.has()` / `refresher.tracked()` 断言。
- **无障碍**：新增 `e2e/a11y.spec.ts`（`@axe-core/playwright`，亮 / 暗、登录页 / 我的项目 / 组首页 / 项目各页 / 个人设置各节 / 后台各页，不允许 serious / critical）。扫描发现并修掉两个真实问题：会话的“吊销”按钮 `aria-label` 没包含可见文字“吊销会话”（wcag253）；后台用户列表用 12.5px 的 `--ok` 文字达到 4.42:1（差一点到 4.5），改成“圆点 + 正文色文字”。
- **登录限速可配置**：e2e 在一个 IP 上反复登录，默认“同一 IP 30 次 / 10 分钟”会把后面的用例挡掉。新增 `DOWEL_LOGIN_LIMIT` / `DOWEL_LOGIN_IP_LIMIT` / `DOWEL_LOGIN_WINDOW_MS`（`loginLimiterFromEnv()`），playwright 配置里调大；反向代理 / NAT 部署同样需要。
- **测试**：`apps/server/test/project-delete.test.ts`（两种方言、403/404/400、数据清空、审计保留、在线连接 4403）；`accounts.test.ts` 增加“改密码要旧密码 / 纯 OIDC 用户第一次设置密码”；e2e 新增 `account`、`admin`、`cmdk`、`narrow`、`project-delete`、`a11y`，`visual` 增加个人设置、后台用户页、窄屏抽屉的亮 / 暗对比。
- 坑：项目删除后，`onClose` 里 `rooms.leave()` 会去加载已经不存在的分支（`分支 … 没有初始快照`），这是未处理的 rejection；`leave()` 和 WebSocket 的 `join` 链都补了 catch。另一个坑是命令面板关闭时仍然渲染整个 listbox，`getByLabel('组')` 之类的选择器会和页面表单撞名——关闭的对话框不渲染内容，既省事也更正确。

### 产品化 P3 新建项目向导（2026-11-19）

- **连接检查**（`POST /api/connection-check`，`routes/connection.ts`）：鉴权复用 `group.create_project`（组对所有人可见，权限不够是 403），限速用新增的 `KeyedLimiter`（每个用户每分钟 10 次，超出 429 + `Retry-After`）。`inspectTarget` 扩展成只读的完整检查：版本、当前用户、是否超级用户、能否建库（`rolcreatedb or rolsuper`）、能否建 schema（`has_database_privilege(current_database(),'CREATE')`）、schema 列表（每个带表数，排除 `pg_*` / `information_schema` / `dowel`）、`dowel` schema 是否存在、里面有没有 `meta` 表。连接超时 5 秒；错误信息统一经 `scrubUrl()` 洗掉连接串和密码（`maskUrl` + 逐处替换密码）。
- **SSRF**（`allowlist.ts`）：只允许 `postgres://` / `postgresql://`（zod 也拦一道）；PG 协议没有重定向，无需处理。实例设置新增 `connection_allowlist`（CIDR / IP / 主机名，空表示不限制）：主机名先解析成 IP 再比对，列表里的主机名也解析后取交集，所以 `localhost` 和 `127.0.0.1` 两种写法都能命中。**入口**：连接检查、环境创建（目标库 + 影子库）、测试连接，以及向导（提交前把所有环境过一遍）。写错的白名单项在保存设置时就 422，避免以后谁都连不上。
- **schema 范围**：`projects.schemas`（JSON 数组，可空 = 全部）。过滤加在**引擎的目录查询里**：`readSnapshot(db, only)` / `readOpaques(db, maps, only)` 用 `userNs(only)` 拼出 `n.nspname <> 'dowel' and n.nspname in (...)`，不读出来再丢弃；`dowel` 在引擎层写死永远排除。范围随 `Shadows.forProject()` 绑到影子库连接上（`pgShadow(url, schemas)`，范围变了就重建），所以导入 SQL、规范化、验证、`pullSchema` 都自动只看范围内；`PATCH /api/projects/:pid` 改范围时调 `shadows.forgetProject()` 丢掉旧连接。
- **创建接口**：新增 `POST /api/projects/wizard`（不改 `POST /api/projects`，后者保持“建一个空项目”的语义，权限矩阵和现有测试都不用变）。请求体带组、名字、slug、可选环境列表、schema 范围和初始内容（`blank` / `database` / `sql`，`takeover` 直接 422“即将推出”）。**边界**：读目标库、在影子库里执行 SQL、规范化都是外部操作，全部在平台库事务**之前**完成，失败就什么都不写；项目 / 授权 / 分支 / 快照 / 基线 / 环境 / v0 版本在**一个事务**里写；事务失败时清掉本次新建的影子库（`dropSameInstanceShadow`，显式配置的影子库不删）。整个流程不写目标库：`database` 只 `SET` + `SELECT`，`sql` 只在影子库里执行。
- **进度用 SSE**（`streamSSE`，`text/event-stream`），阶段粒度：`connect` → `read` → `canonicalize` → `write` → `done`，出错时最后一条带 `error`（HTTP 状态仍是 200，前端按事件判断）。选 SSE 而不是“任务 ID + 轮询”：不用在服务端存任务状态、没有过期清理，建好的项目和最终进度在同一个响应里返回，测试里读一次响应体就能断言全部阶段。
- **v0 基线**：`database` / `sql` 成功后在同一事务里插一条 `versions`（名字 `v0 · 基线`，`seq` 0），并把引擎读出的模型写成 `branches.baseline`；`blank` 不发布。只写平台库，不写目标库（第一次执行到该库时才建 `dowel` schema，见 ADR 0003）。
- **界面**：`/new`（`?group=` 预选组），四步基本信息 / 关联数据库（可跳过）/ 初始内容 / 确认；状态都在一个组件里，后退不丢。“我的项目”页和内联表单删掉，改成主按钮 + 空状态里的入口；⌘K 的“新建项目”改成跳 `/new`。项目设置新增“schema 范围”：有环境时从连接检查的 schema 列表里勾选（没有环境时手动输入）。
- **测试**：`apps/server/test/wizard.test.ts`（连接检查的权限 / schema 列表、只读角色的 `canCreateSchema=false`、白名单拒绝与放行、错误信息不含密码、403、限速 10 次 + `KeyedLimiter` 单元测试；blank / database / sql 三条路径、takeover 422、导入失败不留残留、平台库写入失败会清理影子库、只读账号导入前后目标库快照完全一致且没有 `dowel` schema、schema 范围也管着“从环境拉取”）；`permission-matrix.test.ts` 登记两个新端点；e2e `wizard.spec.ts` 覆盖三条路径。
- 坑：测试里给只读角色授权要在目标库里执行（`grant usage on schema a` 里的 `a` 是当前库的 schema，在 `postgres` 库上执行会报 `schema "a" does not exist`）；平台库的 SQL 不要写 `count(*)::int`（SQLite 适配器只去掉 `::text::jsonb`）；Playwright 的 `getByLabel` 会把标签里的说明文字算进可访问名字，带提示的字段用 `getByRole` + 前缀匹配。

P3 审查后的修正（2026-11-19）：

- **白名单不能只看 `new URL().hostname`**：PG 连接串可以是逗号分隔的多主机，还可以用 `?host=` / `?hostaddr=` 覆盖主机（等于绕过白名单）。现在统一用 `connectionTargets(url)` 手写解析（Node 的 `URL` 不接受多主机）：多主机**每个都检查**，出现 `host` / `hostaddr` 参数或 unix socket 直接 422，`?port=` 只改端口、不参与主机判断。
- **白名单下沉到连接层**：`connectPg(url, timeout, guard)` 在第一条语句之前跑一次 `guard`（postgres.js 是懒连接，所以签名保持同步）。`createApp` 注入 `guard`（读实例设置的 `connection_allowlist`），`Shadows` / 环境路由 / 向导都用它，所以拉取、影子库、规范化、验证、向导全部被覆盖。`Shadows.forProject` 每次还要再过一遍 guard：已经在用的连接不会自动重连，实例设置改严后必须立刻生效。
- **范围自洽**：`packages/engines/src/pg/scope.ts` 的 `checkScope(db, scope)` 在 `readSnapshot` 读完（`importSnapshot` 之前）执行，用系统目录查跨范围引用——快照已经按范围过滤，跨范围的引用在快照里看不到。覆盖外键、分区父表、列类型（枚举 / 域 / 复合类型 / 扩展提供的类型）、排序规则、`OWNED BY`，以及视图 / 函数 / 域 / 触发器 / 策略 / 排他约束在 `pg_depend` 里的依赖；有跨范围引用就抛 `ScopeError`（服务端映射成 422，提示里列出要补进范围的 schema）。
- **向导的两类失败**：事务**提交之后**的失败（写审计、进度发不出去）只记日志，不回滚、不删影子库、不发 error 事件（仍然发 done）；只有提交之前失败才清理本次新建的影子库。`send` 失败只把后续进度丢掉（客户端断线不影响已经开始的工作）。
- **向导里的环境与单独建环境同一套检查**：每个环境先 `inspectTarget`，配了 `shadowUrl` 的还要 `claimShadow`，都在平台库事务之前；向导本身也计入连接限速（每个环境一次 + 每次导入一次，超限在写入之前就 429）。环境名和 `content.env` 都统一 trim（服务端兜底，前端状态里也用 trim 后的名字）。
- **界面**：`/new?group=<slug>` 用 slug 匹配（⌘K 传的是 slug，之前按组 id 比，组永远选不上）；schema 勾选内部一律是显式列表（`projects.schemas` 为 null 时展开成全部 schema 名），全选时保存回 null，一个都不选时不能继续并提示；SQL 导入没有环境时不能下一步。图标栏只列**我加入的组**，正在看的非成员组临时追加（虚线边框 + tooltip），组区域单独滚动，其他组从“我的项目”页新增的“所有组”或 ⌘K 进入（DESIGN.md 已更新）。

### 产品化 P4a 冻结迁移与目标库历史（2026-11-19）

范围：H1 发布 = 冻结迁移，H2 目标库历史模块。执行器、执行界面、漂移检测、接手放到下一轮（P4b / P4c）。表结构说明见 [04-ir-design.md](04-ir-design.md) 第 7 节。

- **steps 格式**：`[{ sql: string, transactional: boolean }]`（`packages/engines/src/steps.ts` 的 `ScriptStep`）。`sql` 是规划器输出的原文，不带结尾分号；`transactional: false` 表示这一步不能放进事务（`CREATE INDEX CONCURRENTLY` 之类）。core 的 `plan()` 输出的步骤本身不带这个信息，由 core 的 `isNontransactionalSql()`（前后端共用，`packages/core/src/pg/nontx.ts`）按语句文本判断：去掉注释、美元引号、字符串和带引号的标识符后，任何带 `CONCURRENTLY` 的语句（CREATE / DROP INDEX、REINDEX、DETACH PARTITION）、`VACUUM`、`ALTER SYSTEM`、`CREATE / DROP DATABASE`、`CREATE / DROP TABLESPACE`、`DISCARD ALL`、`ALTER TYPE … ADD VALUE`（PG 12 起能在事务里执行，但新值同一事务里不能用，而规划器生成的后续步骤可能立刻用到它，所以单独作为非事务步骤）都是非事务；一步里有多条语句时（用户手写的脚本）先去掉字符串、注释、带引号标识符和 `$$` 函数体，再按分号切开逐条检查，任何一条命中就算。去掉这些内容用**单遍扫描**（按字符从左到右，每个位置只被一种记号消耗：单引号字符串含 `''` 和 `E'…'` 的反斜杠转义、双引号标识符、`$tag$…$tag$`、`--` 行注释、可嵌套的 `/* */`），分两遍删（先注释再字符串）会让字符串里的 `--` / `/*` 把后面的语句一起吃掉。规划器生成的 `ADD VALUE` 因此会冻结成 `transactional: false`。`PATCH …/steps` 保存时服务端强制 `transactional = 客户端值 && !isNontransactionalSql(sql)`：检测到非事务语句就一定是 false，用户手动标 false 照样保留；界面上输入时按同一规则自动勾选并且不能取消。
- **checksum 如何规范化**：`stepsChecksum(up, down)` = sha256(`stableJson({ up, down })`)，其中每一步先 `canonicalSteps()`：只保留 `sql` 和 `transactional` 两个字段（`transactional` 缺省或非 false 都算 true），SQL 文本**不做任何改写**（空白、大小写都算内容）；`stableJson` 按键排序，所以序列化顺序不影响结果。`transactional` 标记也参与校验和（只改标记也是篡改）。
- **发布（`POST /api/projects/:pid/versions`）**：from 是链上最新的版本（项目还没有版本时是 `emptyBase()`：带 public schema、public 沿用工作副本里 public 的 ID 的空模型，与原来的 `resolve('empty')` 一致），to 是工作副本；`up = plan(from, to)`、`down = plan(to, from)`，`up` 为空返回 422“没有变更”。项目有可用的影子库就 `shadow.verifyScripts(from, model, frozen.up, frozen.down)`——验证的就是要冻结的那一份脚本，不是重新 plan——没通过返回 422 + `{ error, report }`，不写库。只有“预期的没有影子库”（`ShadowError`：没有环境、生产环境不让用同实例、连不上、被占用）才允许发布但标为未验证，`unverifiedReason` 写成“影子库不可用：…”，界面上发布对话框不关闭、用醒目的提示显示原因；`SecretError`、白名单拒绝的 `HTTPException`、平台库错误继续抛出，不会被当成“没有影子库”。验证在事务之外（很慢）；提交时在事务里先锁项目行，再确认链头没变，冲突返回 409，`unique(project_id, number)` 再兜一层。`number = 上一个的 number + 1`（第一个为 1），和房间操作序号 `seq` 无关，`seq` 保留。
- **v0 基线（向导）**：number 0、parent 为空、down 为空数组；up 是 `plan(emptyBase(model), model)`（**不是**设计里写的 `createAll(model)`：`createAll` 会输出 `CREATE SCHEMA public`，在真实的空库上会因为 public 已存在而失败）。**`emptyBase(model, scope)` 由项目的 schema 范围决定带不带 public**：空库模型表示“范围内的一个全新数据库”，全新的 PG 库本来就有 public。范围覆盖 public（`scope` 为 null / 空，或包含 `'public'`）时空库模型带 public——目标模型里有就沿用它的 ID，没有（用户把 public 删了）就生成一个新 ID，所以会正确冻结出 `DROP SCHEMA public`；范围不含 public（例如 `['app']`）时空库模型里不放它，冻结的 v0 / v1 完全不碰 public。所有调用点（回填迁移读项目行的 `schemas`、`chainFrom`、`freezeBaseline`、预览接口 `/migration?from=empty`、`/verify`、向导）都传入 scope。没有 public 时空库模型里 public 的 ID 是固定常量，回填、重新验证、预览每次算出的结果一致。**版本记下冻结时项目的 schema 范围**（`versions.scope`，JSON，null 表示全部；发布、向导基线写入，旧版本在链迁移 `backfillVersionChain` 里回填成项目行的 `schemas`，没有单独的迁移——P4a 还没发布过），重新验证第一个版本时 `emptyBase` 用这一列，不用项目当前的范围——项目范围之后改了，结果也不变。基线验证发生在向导的 `write` 阶段（没有单独加进度阶段，避免改 SSE 协议）。**`verified_at` 只在真的验证过之后才设**：向导在影子库里（sql 路径用已有的影子库；database 路径用环境的影子库，没有就用同实例的 `{库名}_dowel`，生产环境默认不破例）执行这份冻结的 up（`verifyScripts`，只验证建库那一半，基线没有回滚），读回的结构与模型一致，才把 `verified_at` 设为验证时间，报告写进 `verify_report`。没有影子库（生产环境不让用同实例、没有建库权限、连不上）或脚本执行失败 / 结构对不上，基线照常创建，标为未验证（失败时带着报告），以后可以在界面上“重新验证”（基线上也可用）。**基线验证是可选的，不能挡住项目创建**：验证过程中任何意外错误（不只是 `ShadowError`，包括读结构出错）都只会让基线标为未验证——记日志，`verify_report` 写“基线验证没有完成：原因”；发布和重新验证两个路由遇到未知错误仍然是 500。影子库的选择（显式 `shadowUrl` / 同实例 `{库名}_dowel` / 生产环境限制 / `created`）抽成 `shadows.ts` 的 `prepareShadow()`，`Shadows.forProject`、向导的 SQL 导入、向导的基线验证共用；验证报告的转换 `storedReport()` 在 `shadow.ts`，向导和版本路由共用。验证时向导的 from（空库模型）只构建一次（`freezeBaseline` 返回 `from`），冻结和验证共用。向导基线验证里 `HTTPException`（白名单拒绝）和 `SecretError` 与发布一致，继续抛出，向导以 error 事件结束，已经新建的影子库走原来的 pre-commit 清理；其他意外错误才降级为“未验证”。发布对话框：回调靠 `openRef`（现在是否开着）和 `pendingRef`（请求是否还在进行）判断；提交期间名字输入和按钮都禁用，所以同一时间只会有一个请求，不需要提交序号；请求进行中被关掉时，成功（未验证）和失败（422 验证没通过要写明、其他错误）都改用 toast（整句由 i18n 键带参数生成）；请求还没完成时重新打开**不**重置，继续显示“正在发布”，名字输入和按钮禁用，不能重复提交，完成后在对话框里显示结果；请求已经完成再打开才重置上一次的状态。脚本编辑器有空步骤时保存按钮用 `aria-disabled`（不用 `disabled`，仍在 Tab 顺序里），原因通过 `aria-describedby` 关联到提示。
- **人工编辑（`PATCH /api/projects/:pid/versions/:vid/steps`，`{ up, down }` 整体替换）**：只能编辑链上最新的版本（409），且 `versionExecutedAnywhere()`（TODO P4b：执行记录下一轮才有，现在返回 false）为 false；检查和更新在同一个事务里，事务一开始先锁项目行（PG：`select … for update`；SQLite 的写事务就是串行的：`BEGIN IMMEDIATE` 加上适配器里所有语句排成一队），发布和编辑用同一把锁，检查链头只取 id 和 number，不读模型。内容没变化时什么都不改；改了就 `edited = true`、`verified_at` 和 `verify_report` 清空、checksum 重算。空白的一步 422。
- **重新验证（`POST .../versions/:vid/verify`）**：`verifyScripts(db, from, to, up, down, { checkDown })`（`packages/verifier`）在影子库里建出 from，**执行冻结的 up**，结构必须等于 to；再执行冻结的 down，必须回到 from。升级后的结构不对时不再执行 down（起点就错了，回滚的检查没有意义，还会盖住升级的差异）。v0 基线只验证建库那一半。报告写回 `verify_report`，通过则写 `verified_at`；写回带 `checksum` 条件，验证期间脚本被改了就丢弃这份报告（409）。风险分析是附带信息，失败不影响结论。**验证失败和基础设施故障分开**：只有执行某一步 SQL 报错（SQLSTATE 是 SQL 本身的错）或结构对不上才是 `ok:false` 的验证失败；连接断开、被占用（55P03）、连接 / 资源类 SQLSTATE（08、53、57P）、`CONNECTION_*` / `ECONN*` 这类驱动错误和 `ShadowError` 都抛 `ShadowError`。**57014 和 58 类逐个看**：建 from / 建 to / 执行被验证的 up、down 执行的都是用户模型或迁移的 DDL（不透明对象里的 C 函数、很慢的物化视图、脚本里的死循环）。执行步骤时抛出的 `StepError` 里，**58 类里 58030 以外的**（58P01、58P02，例如 `LANGUAGE C` 引用不存在的库）和**原因是语句超时的 57014**（错误消息含 `statement timeout`，**或者**这一步耗时 ≥ 会话 `statement_timeout`〔`SHADOW_STATEMENT_TIMEOUT_MS`，pgShadow 连接后 SET 的值〕的 90%——`lc_messages` 可能是本地化的，消息里不一定有英文；`StepError.elapsedMs` 是 `runSteps` / analyze 执行时计的时）判验证失败（`ok:false` 带报告，57014 写“执行超时”），向导基线保留这份失败报告。**58030（io_error）任何地方都是基础设施故障**；其他 57014（例如管理员 `pg_cancel_backend`：`canceling statement due to user request`）、以及出现在步骤之外的操作（readSnapshot、重置、pinSession）里的 57014 / 58 类，也是影子库的问题，转成 `ShadowError`。08、53、57P、55P03、58030、驱动的连接错误和 `ShadowError` 出现在任何地方都是基础设施故障（`isConnectionFailure`）。**风险分析（analyze）不影响验证结论也不掩盖失败**：连接类故障抛 `ShadowError`；其余错误（语句超时、58P01、事务里不能执行……）`ok` 不变、风险为空，原因写进报告的 `riskError`（“风险分析没有完成：…”），详情页和迁移对话框在风险列表的位置显示这条说明，不会显示成“没有风险”；发布时验证通过但有 `riskError`，发布对话框同样不关、用警告横幅说明（对话框已经关了就用 toast）。**非事务步骤只看语句文本**（`isNontransactionalSql`，不看 `transactional` 标记）：文本判断为非事务的（CONCURRENTLY 之类，即使标记写成 true）不包进 `BEGIN`，在事务外直接执行，后面的步骤照常分析，风险里给 `note: 'nontransactional'`（是一个代码，界面按 i18n 键 `dlg.riskNote.*` 渲染本地化的说明，不显示风险等级）；其余一律放进 `BEGIN` 测量，即使用户手动标成 `transactional:false`，这样重写整表之类的高风险步骤藏不住。`riskError` 只存原因本身，不带“风险分析没有完成：”前缀，前缀由界面的标题 / i18n 模板提供（详情页和迁移对话框的 `RiskNote`、发布横幅、toast）。**实例级语句不能放进迁移**：`isInstanceLevelSql`（core，与 `isNontransactionalSql` 共用单遍扫描和切分）覆盖 `CREATE / DROP / ALTER DATABASE | TABLESPACE | ROLE | USER | GROUP` 和 `ALTER SYSTEM`（`CREATE USER MAPPING` 不算）。影子库常和线上库在同一实例上，验证执行 up / down、analyze 重放非事务步骤都会真的执行它们。`PATCH …/steps` 和发布（兜底，规划器正常不会生成）遇到返回 422，说明哪一边第几步；`runSteps`、`verify`、`verifyScripts`、`analyze` 在执行**任何一步之前**先扫整份脚本，有就抛 `InstanceLevelStatementError`，影子库侧得到 `ok:false` 和说明，一条 SQL 都不会发给影子库。**analyze 的每个 `BEGIN` 出错都要 `ROLLBACK`**（`try/finally`，ROLLBACK 失败就吞掉），否则连接停在“事务已中止”，后面的 SET、解锁都会失败。**`pgShadow` 的常驻连接**在 SET、拿锁、执行、解锁任一阶段失败（或解锁没成功）时先 `close` 再置空：只写 `conn = null` 的话旧连接还活着，挂在上面的 advisory lock 不会释放，下一次检查会等到“被占用”超时。“影子库不可用：”前缀只在生成 `ShadowError` 的一处加一次：`ShadowUnavailableError`（构造时加前缀）由 `toShadowError`、`pgShadow` 的连接失败 / 被占用生成；`targets.ts` 里的连接失败 / 读取结构失败是 `ConnectError`（不带前缀，因为同样的函数也服务于目标库），`prepareShadow` 在为影子库服务的边界上把它转成 `ShadowUnavailableError`。**建影子库 / 认领影子库**（`ensureSameInstanceShadow` 的 CREATE DATABASE、`claimShadow`、`isMarked`）抛出的原始 PG 错误经 `shadowSetupError(e, step)`：影子库的问题（`isInfraFailure`，含被取消的 57014）→ `ShadowUnavailableError`；其他按做的事分文案、不带前缀：`create` 是“建影子库失败：…”，`claim` 是“认领影子库失败：…”（42501 not owner 提示“当前账号不是该库的所有者”），`check`（isMarked）是“检查影子库失败：…”；发布走“未验证”而不是 500。所有转成 `ShadowError` / `ShadowUnavailableError` 的文本都先经 `scrubSecrets`（`postgres://用户:密码@` → `***`、`password=`），因为这些消息会原样发给客户端。已经是 `ShadowError` 的不重复加。各路由直接用 `e.message`，所以走全局 422 的 `/verify`、canonicalize 也带着它；“没有环境 / 生产环境禁止 / 没有建库权限”这类配置性的 `ShadowError` 保持原来的文案，不加前缀。重新验证路由遇到它沿用现有的 `ShadowError → 422` 映射，不写回 `verified_at` 和 `verify_report`，原有的验证状态保持不变；发布时按“影子库不可用 → 未验证”处理。编辑和重新验证的权限沿用发布（编辑者，动作 `version.edit` / `version.verify`）。
- **平台库迁移**：`versions` 加 `number`、`parent_id`、`up_steps`、`down_steps`、`checksum`、`verified_at`、`verify_report`、`edited`，`unique(project_id, number)`；数据迁移 `backfillVersionChain` 在同一个事务里按 `created_at, seq, id` 排序补齐，用相邻两个版本的模型重新 plan；第一个版本是向导基线（名字为 `BASELINE_VERSION_NAME` 且 seq 为 0）时 number 为 0，否则为 1；`verified_at` 一律留空；规划器对某个旧模型报错时脚本留空、原因写进 `verify_report`。另有一条迁移在 `instance_settings` 里生成 `instance_id`（`GET /api/admin/settings` 只读显示，PATCH 里带了会被忽略）。
- **advisory lock 和连接的关系**：`withProjectLock` 用 `pg_try_advisory_lock(hashtext('dowel:' || project_id))` + 200ms 轮询（阻塞版的 `pg_advisory_lock` 没法设截止时间），超时抛 `lock_timeout`。advisory lock 是**会话级**的，必须在同一个连接上加锁和解锁，而 `Db` 的 query / exec 是连接池的抽象（postgres.js 的 `sql.unsafe` 每次从池里取连接）。所以 `Db` 接口新增可选的 `reserve()` / `release()`，`fromPostgres` 用 postgres.js 的 `sql.reserve()` 实现；`withProjectLock` 先 reserve 一个连接，加锁、`fn(conn)`、解锁都在它上面，最后 release。`fn` 在事务中途抛错时连接停在“事务已中止”状态，unlock 也会失败而把锁带回连接池，所以 finally 里先 `ROLLBACK` 再 unlock。没有 `reserve` 的单连接适配器直接用 db 本身（这时不 rollback，那可能是调用方自己的事务）。测试覆盖：两个连接互斥并超时、等到释放后拿到、fn 抛错（含事务中途）后释放、5 个连接的池里全程同一个 backend pid。
- **fingerprint 剔除了哪些字段**：`fingerprint(snapshot)` = sha256(`stableJson(normalize(snapshot))`)，`normalize` 与 `diffSnapshots` 是同一套：递归按键排序，剔除 `version`（`server_version_num`，换 PG 小版本就变）、`attnum`（列的物理序号，删过列的表和新建的表不同）、`order`（只用于展示顺序，目前快照里没有，防以后加了再引入不稳定）。快照本身没有 OID（按限定名索引），所以不需要另外处理；数组（枚举值、约束列、索引元素）保持原顺序；`dowel` schema 在读快照时已被排除。测试：不同建表顺序、删列再加回、不同 `version` 得到同一指纹；加列 / 改类型 / 加约束 / 改注释 / 加索引 / 改非空 / 改长度 / 换表名各得到不同指纹。
- **界面**：版本列表显示 `v{number}`、名称和“已验证 / 未验证 / 人工编辑”标记（v0 基线的名字显示为“基线”）；详情页显示冻结的升级 / 回滚脚本（非事务的步骤带标记）、校验和、最近一次验证报告，可“重新验证”；链上最新的版本可“编辑脚本”：每一步一个 CodeMirror 编辑器（`SqlView` 给了 `onChange` 就可编辑，长行折行以避免 axe 的 scrollable-region-focusable），可切换“非事务”、删除步骤、在末尾添加。发布对话框发布期间显示“正在影子库里验证…”，失败时显示验证报告。
- **测试**：`engines/test/history.test.ts`（23 项）、`server/test/versions.test.ts`（SQLite + PG 平台库，影子库部分要 PG）、`migration.test.ts` 的版本链回填和实例标识（SQLite + PG）、`wizard.test.ts` 的基线断言和“基线之后发布 v1、重新验证基线”、`permission-matrix` 登记 3 个新端点、`audit-coverage` 加 `version.edit_steps` / `version.verify`；`verifier/test/random.test.ts` 新增“plan 产出的冻结脚本经 verifyScripts 闭环通过”（固定上限 50 轮）；e2e 新增 `versions.spec.ts`，`basic.spec.ts` 加编辑 / 重新验证，`a11y.spec.ts` 扫描版本详情和编辑模式。
- **P4a 审查后的修正**：`emptyBase` 不再硬塞 public；wizard v0 的 `verified_at` 名副其实；发布验证冻结脚本本身；PATCH 强制非事务；发布 / 编辑锁项目行；非事务语句补全（含 `ALTER TYPE … ADD VALUE`）；验证失败与基础设施故障分开（`isInfraFailure`）；发布时 `forProject` 只放过 `ShadowError`；脚本编辑器两边都检查空步骤；链头查询拆成只取 id / number 和带模型两个。新增测试：`core/test/nontx.test.ts`（每类语句）、`server/test/chain.test.ts`（范围不含 public）、`shadow-ops.test.ts`（假 Db 区分验证失败和基础设施故障）、`versions.test.ts`（验证的是冻结脚本、影子库不可用 → 未验证、其他错误继续抛出、重新验证遇到故障状态不变、强制非事务、范围不含 public、PG 行锁）、`wizard.test.ts`（基线验证 / 未验证）。
- **第二轮审查的修正**：`emptyBase` 按 schema 范围判断（见上）；`INFRA_SQLSTATE` 收窄；原因前缀只加一次；基线验证可选；`isNontransactionalSql` 支持多语句；未验证时发布对话框的横幅常驻、不再弹 toast；空步骤提示改普通 hint + `aria-describedby`；`prepareShadow` / `storedReport` 去重；删掉重复的 i18n 键。新增 / 更新测试：`chain.test.ts`（范围 null / ['app'] / 含 public、public 被删）、`nontx.test.ts`（多语句正反例）、`shadow-ops.test.ts`（58、57014 是验证失败）、`versions.test.ts`（前缀只出现一次、范围 [app]、范围全部且删了 public、预览接口）、`migration.test.ts`（回填按项目范围）、`wizard.test.ts`（基线验证抛普通 Error 时项目照常创建）。
- **第三轮审查的修正**：见上面各条（阶段分类、前缀统一、单遍扫描、`versions.scope`、向导基线验证的 catch、固定 public ID、from 只构建一次、`aria-disabled`、对话框关闭时的通知）。新增 / 更新测试：`shadow-ops.test.ts`（按阶段：读结构 / 建 from / 建 to / 重置 / analyze 里的 57014、58 → ShadowError，脚本里的 57014、58P01 → `ok:false`）、`versions.test.ts`（`/verify` 前缀只出现一次、范围改了之后重新验证结果不变）、`nontx.test.ts`（字符串里的 `--` `/*` `$`、嵌套注释）、`chain.test.ts`（确定性 ID）、`migration.test.ts`（回填 `scope`）、`wizard.test.ts`（白名单 / 密钥错误中止并清理影子库）、e2e `versions.spec.ts`（请求进行中关闭对话框）、`a11y.spec.ts`（空步骤的 aria-disabled 按钮）。
- **第四轮审查的修正**：分类规则重划（57014 / 58 看是不是执行步骤时抛的，不再按阶段；`StepError` 的 `phase` 去掉）；风险分析失败写进 `riskError` 并在界面显示；前缀由 `ShadowUnavailableError` / `ConnectError` + `prepareShadow` 边界统一；发布对话框的序号 / 重新打开 / 关闭期间失败的通知；`versions.scope` 并进链迁移（没有单独的迁移）；`nontx.ts` 的美元引号识别改用 sticky 正则（`y` 标志 + `lastIndex`），不再对每个 `$` 复制一遍后缀，2 万个 `$1` 的输入 200ms 内完成；toast 整句走 i18n。**文档教训**：用 `String.replace` 往文档里塞带 `$` 的文本会被当成替换模式（`$` 加反引号会插入匹配之前的全部内容、`$$` 会变成 `$`），上一轮就这样把整篇文档插进了自己中间；改文档用 Edit 工具，或者用 `indexOf` + 切片拼接。新增测试：`shadow-ops.test.ts`（新分类规则、riskError）、`versions.test.ts`（riskError 的发布 / `/verify` / 重新验证路径、第一个环境连不上时前缀只出现一次）、`wizard.test.ts`（基线验证失败保留报告）、`nontx.test.ts`（性能）、e2e `versions.spec.ts`（关闭又重新打开、关闭期间 422）。
- **第五轮审查的修正**：57014 / 58 的判定细化（见上）；analyze 出错必回滚、`pgShadow` 丢弃连接时先关闭；非事务步骤不分析锁、给 `note`；建 / 认领影子库的错误分类（`shadowSetupError`）；发布时 `riskError` 让用户看到（`VersionCreated.riskError`）；去掉发布对话框里的 `submitSeq`（只靠 `openRef` / `pendingRef`：提交期间按钮和名字输入都禁用，不会有第二次提交）；`nontx.ts` 的美元引号标记每个位置只算一次，性能测试改成线性度断言（放大 4 倍，耗时比 < 8）加一个宽松的绝对上限，第二个用例是真正没有闭合的 `$a$`。新增测试：`shadow-pg.test.ts`（真实 PG：analyze 出错后回滚、常驻连接被弄坏后丢弃、非事务步骤、建 / 认领影子库的错误分类）、`shadow-ops.test.ts`（新判定规则）、`versions.test.ts`（riskError 随发布响应返回、建影子库错误 → 未验证）、e2e `versions.spec.ts`（riskError 横幅 / toast）。
- **第六轮审查的修正**：实例级语句拒绝（见上）；错误消息统一脱敏；analyze 只看语句文本决定是否进事务；57014 增加按耗时判断语句超时；影子库错误文案按操作区分；`StepRisk.note` 改代码、`riskError` 去前缀。新增测试：`nontx.test.ts`（`isInstanceLevelSql` 正反例）、`shadow-ops.test.ts`（耗时判断、实例级语句一条都不执行）、`shadow-pg.test.ts`（真实 PG：实例级语句不建库、手动标 false 的 ALTER COLUMN TYPE 仍报重写、CONCURRENTLY 标 true 不产生 riskError、claim 42501 的文案、脱敏）、`versions.test.ts`（PATCH 422、冻结旧版本带 CREATE DATABASE 重新验证 ok:false 且库没建出来、响应不含密码）。
- **实例级语句拦截的定性与安全边界**：实例级语句的拦截（`isInstanceLevelSql` / `findInstanceLevelStatement`）只是**防误操作**，不是安全边界——文本黑名单挡不住 `DO` 块或函数里 `EXECUTE` 的动态 SQL，也不去补。真正的边界是两条：① **生产环境默认不在同一实例上建影子库**（P3 已经这样做，`prepareShadow`）；② **影子库使用权限受限的账号**（不带 `SUPERUSER` / `CREATEROLE`），或者放在独立实例上。用户文档（`docs/getting-started.md` 的“影子库的账号与安全边界”）已经写明并建议给影子库用独立的低权限账号。导入 SQL（`importSql`）在**路由层、准备影子库之前**就检查（`instanceLevelImportProblem`：向导的 SQL 导入在连接任何数据库之前、`POST …/import` 在 `forProject` 之前），命中直接 HTTP 422——不建 `{库名}_dowel`、不拿影子库的检查锁、不执行任何东西；`shadowOps.importSql` 里再检查一次兜底，提示和编辑脚本一致（`INSTANCE_LEVEL_DESCRIPTION`，core 里只维护一份；`chain.ts` 的 `instanceLevelProblem` 和 verifier 的执行前检查共用 `findInstanceLevelStep`）。`CREATE USER MAPPING` 只有 USER 后面紧跟 `MAPPING [IF [NOT] EXISTS] FOR` 才排除，`CREATE USER mapping SUPERUSER` 仍然是实例级语句。
- **analyze 对“标了非事务、但文本看不出来”的步骤**（`transactional:false`，如 `CLUSTER` 不带表名）：先照常放进 `BEGIN` 测量；失败原因是“不能在事务里执行”（SQLSTATE 25001，或消息里有 `cannot run inside a transaction block` / `cannot be executed from a function` 等）就 `ROLLBACK`、改在事务外执行并给 `note: 'nontransactional'`，后面的步骤继续分析；标记为 true 的失败了照旧写 `riskError`。
- **脱敏只有一个实现**：`scrubSecrets`（userinfo 从 `scheme://` 开始，在**同一行**里匹配到最后一个 `@`，中间允许空格、`/`、没转义的 `@`——base64 密码有 `/`、手写密码可能有空格；一行里有多个连接串时每个只匹配到下一个 `scheme://` 之前，所以每一个的密码都遮掉；宁可多遮也不能漏；第一个冒号前的用户名保留；`maskUrl` 能解析的用 `URL.password` 遮再过一遍它，解析不了的给“无效的连接串”提示）。`maskUrl`、`scrubUrl` 都调用它；验证报告的步骤错误（`errorOf`）、`riskError`、导入 SQL 的执行错误、`toShadowError`、`shadowSetupError` 返回或存下来之前都经过它。认领影子库（`claimShadow`）出错时区分 `claim-read`（读目录缺权限：“当前账号缺少读取目录的权限”）和 `claim`（`COMMENT ON DATABASE` 报 42501：“当前账号不是该库的所有者”）。
- **按耗时判断 57014 的误判可以接受**：脚本里自己 `SET statement_timeout`、或者管理员拖了很久才取消，都可能判错；最坏结果只是“未验证”或“验证失败”，不会把版本误判成已验证（代码注释里也写了）。
- **第八轮审查的修正**：`scrubSecrets` 的 userinfo 匹配改成同行内最后一个 `@`（见上，修掉 `maskUrl` 在密码带空格 / `/` 时泄露的回归）；`findInstanceLevelStep` 挪进 core；`Step` 类型带可选的 `transactional`（`@dowel/api` 的 `migrationStepSchema` 里声明为可选，验证 / 重新验证报告里的 `error.step` 带着它）。**脱敏巡查**：在 `apps/server/src` 下搜了所有把 `e.message` / `String(e)` 写进响应、报告或审计 data 的地方——已脱敏：`shadow.ts`（`errorOf`、`riskError`、`toShadowError`、`importSql`）、`targets.ts`（`pgError`）、`wizard.ts`（基线报告、进度里的 error 事件）、`db.ts`（回填迁移写进 `verify_report` 的消息）、`versions.ts`（`unverifiedReason`）、`app.ts`（全局 422 的消息）。**搜到但没改的**：`shadows.ts` 里 `ConnectError` 转 `ShadowUnavailableError` 用的 `e.message`（`ConnectError` 在 `targets.ts` 创建时已经经过 `pgError` / `scrubUrl`）；`rooms.ts` 的 `r.message`（同步层的拒绝原因，来自编辑操作的校验，不是数据库错误）；`oidc.ts` 的“无法读取 OIDC 配置”（OIDC 发现的错误，不涉及数据库连接串）；`setup.ts`（环境变量格式校验的固定文案）；`db.ts` 的 `isUniqueViolation`（只做判断，不输出）。审计 `data` 里没有把错误消息写进去的地方。
- 坑：`CREATE SCHEMA IF NOT EXISTS` 即使 schema 已存在也要库级 CREATE 权限（测试里“DBA 预建 schema”的路径暴露出来）；`has_schema_privilege` 对不存在的 schema 会报错，要先 `to_regnamespace`；空工作副本发布现在是 422，几个旧测试要先加一张表（`test/support.ts` 的 `addTable` / `editModel` 直接替换房间里的模型）；给 `jsonb` 列写数组要 `$n::text::jsonb`（和以往一样）。

### 产品化 P4b 执行器、漂移检测与基础执行权限（2026-11-19）

范围：H3 执行器、H4 漂移检测、H6 基础执行权限、H7 接口与界面、H8 用户文档（执行部分，见 [docs/execution.md](../../docs/execution.md)），以及 P4a 的几项遗留。接手与认领（H5）、实例标识的认领确认、执行策略四层合并 / 审批 / 执行申请 / 执行者授权 / 前置环境、CI 令牌不在本轮。设计依据：[ADR 0002](adr/0002-frozen-migration-chain.md)、[ADR 0003](adr/0003-version-content-in-target-db.md)、02-consensus.md 的 4.5、4.7、11.3、11.5。

- **执行器放在新包 `packages/executor`**（只依赖 core 和 engines）。理由：① 它是仓库里**唯一会写用户生产库**的代码，verifier 的约定是“只碰影子库”，放进去会把这条边界弄糊；单独成包以后审计“谁会写目标库”只看这一个包，将来不论是服务端、CI 还是隔离网络里的执行代理都只需引用它。② 它不需要影子库、不需要服务端的任何东西：平台里的东西（版本链、环境缓存）由调用方整理成 `ChainVersion[]` 传进来，要写平台库的地方用 `beforeMigration` / `afterMigration` 回调。③ 为了让它不依赖服务端，把 `scrubSecrets`（`packages/core/src/scrub.ts`）和 `emptyBase` / `scopeCoversPublic`（`packages/core/src/empty.ts`）从 apps/server 挪进 core，服务端的 `secrets.ts` / `chain.ts` 重新导出，仍然只有一个实现。随机闭环测试（verifier 的测试）把 executor 作为 devDependency 引用。
- **入口**：`execute({ db, projectId, chain, scope, mode: 'migrate' | 'baseline', to, direction, … })`、`checkDrift(…)`、`readState(…)`。`execute` 拿 `withProjectLock` 独占连接（默认等 30 秒）后依次做：①（拿锁前）平台库的版本链过 `verifyChain`；② 目标库历史已存在时先 `ensureHistory`（只为检查格式版本，`format_too_new` 要在读历史之前拒绝），再 `readState`，目标库历史过 `verifyChain`（**冻结脚本按内容重算 checksum**，篡改校验和或脚本都会被发现），并与平台库的链互相对一遍（版本在不在链上、checksum / 序号 / parent 一致），项目行的实例标识必须是本实例；③ 判断路线（沿 up 链还是 down 链），漂移检查（见下）；④ 每个要执行的迁移必须 `verified`（拒绝“未验证”，提示去重新验证，执行前不重新验证）、不含实例级语句（`findInstanceLevelStep`）；⑤ 逐个迁移执行，每个迁移后读回结构必须等于目标版本的模型。**所有检查都在第一次写目标库之前做完**，拒绝时目标库里不会多出任何东西（连 `dowel` schema 都不建）。
- **结构比较**：快照 → `importSnapshot` → `reconcileIds`（按名字沿用版本模型的对象 ID）→ `plan(线上结构, 版本模型)`，步骤为空就是相等。理由：规划器本来就只比较“定义”（不比展示顺序、不比 ID），空数组 = 相等；非空的步骤列表恰好就是“线上结构 → 当前版本模型”的差异（H4 要的表示），不用另写 diff。快速通道：先比 `fingerprint(快照)` 与历史里该版本记下的指纹，相同就不用算（指纹是执行时读回结构记下的，不是判据：指纹不同但 plan 为空也算没有漂移，因为回滚后当前版本的指纹仍是第一次执行时记的）。差异最多保留 100 项（`MAX_DIFF`），另给总数；线上结构怪到 import / plan 抛错时作为一项 `unresolvable` 差异，不让检查本身崩掉。**随机闭环测试验证了这个比较没有误报**：500 轮随机模型经“执行 v1→v2、回滚、再执行”，每一步读回的结构都等于模型。
- **PG 全新库的 `public` 自带注释 `standard public schema`**，而空库模型里 public 没有注释：不处理的话任何全新的库都被判成“结构不符”，空白项目的 v1 永远执行不了（读回校验也会失败）。`diffAgainst` 在模型的 public 没有注释时把库里这条默认注释当成没有；模型里写了注释的（导入自真实库的 v0 带着它）照常比较。`emptyBase` 本身没改（P4a 冻结出来的脚本不能变）。
- **第一次执行到某个库**（目标库没有 `dowel` 历史表，或里面没有这个项目的完成记录）：`classifyFirstRun` 先和链上第一个版本的模型比——相等 → **只写基线**（`ensureHistory` + 项目行 + `recordVersion` + 一条 `baseline` 记录，同一个事务，不执行任何 SQL；mode = `migrate` 时写完基线接着执行后面的版本）；其次和 `emptyBase(第一个版本的模型, 项目 schema 范围)` 比——相等 → 空库，执行第一个版本的 up；都不是 → `first_run_drift`，带着“库 → 基线”的差异。链上第一个版本不一定是 v0：空白项目的第一个版本是 v1，库里恰好已经是 v1 的结构时同样只写基线（随机测试里 v1 是“几乎空的模型”时就是这条路径）。
- **事务与非事务**：没有非事务步骤的迁移是**一个事务**——`startRun`、全部步骤、读回校验、`recordVersion`（版本行，指纹是读回结构的指纹）、`finishRun` 同生共死；失败时事务回滚，再另写一条 `failed` 记录留痕（尽力而为，写不进去只记日志）。含非事务步骤（`transactional: false`，或语句文本判断为非事务，双保险）的迁移：先单独提交一条 `running` 记录，然后依次执行“连续的事务步骤（一个事务，末尾 `markStep`）”和“单个非事务步骤（事务外，成功后 `markStep`）”，最后一段事务里做读回校验、`recordVersion`、`finishRun`（最后一步是非事务步骤时多一个只做收尾的事务）。`step_index` 是已完成的最后一步（0 起）。**为什么 `recordVersion` 放在最后**：版本行带指纹，指纹只有读回结构后才知道，而 `versions` 表只能插入；代价是版本行在迁移成功前不存在，所以“执行过”的判断不能只看目标库的版本行（见下面的登记）。
- **断点续跑**：最后一条记录是 `running`（进程崩了）、或是 `failed` 且 `step_index` 非空（有已提交的部分）就是“上一次停在中途”，`readState().unfinished`。这时库是半途状态：**不做漂移检查**，并且下一次执行的第一个迁移必须就是它（方向、版本都一样），否则 `unfinished_run`（不能在半途状态下改做别的，比如回滚）。续跑时新开一条 history 记录，立刻 `markStep` 沿用上一次的断点（这次再失败也知道已经有进展），从断点的下一步接着跑。纯事务迁移的失败记录 `step_index` 为空，不算“中途”。**`CREATE INDEX CONCURRENTLY` 失败会留下 INVALID 同名索引**，重跑会报“已存在”（带 `IF NOT EXISTS` 的更糟：悄悄跳过，留下不可用的索引）：执行每个非事务步骤之前，如果是 CIC，就把 `pg_index.indisvalid = false`、同名、所在的表在语句里出现过的索引 `DROP INDEX CONCURRENTLY`。
- **并发**：目标库层面靠项目锁（advisory lock，`lock_timeout` 30 秒）；拿到锁后**重新读状态**，所以两个同时到的执行里，后到的看到已经到位就什么都不做（`ran: []`），或等不到锁超时（`lock_timeout`）。服务端层面再加一层单进程内的 `EnvLocks`（每个环境一个互斥，同样等 30 秒，超时 409），因为平台库缓存的同步（见下）不能和另一个正在执行的操作交错。
- **会话设置**：执行用和影子库验证同一份 `pinSession`（`search_path = ''` 等）；`withProjectLock` 里 `finally` 先 `RESET ALL` 再解锁，会话级设置不会留在连接上。
- **平台库（迁移）**：`environments` 加 `exec_policy`（null = 默认）、`current_version_id`、`last_drift_check`、`drift_status`、`drift_summary`；新表 `environment_versions(environment_id, version_id, first_executed_at)`；审查后加 `versions.executed_at`，第二轮审查再给 `environment_versions` 加 `state`（`claimed` / `confirmed`）。**两张表职责分开**：`versions.executed_at` 是**唯一的永久事实**（第一次确认时写入，只写一次、永不清除）；`environment_versions` 是“目标库历史的镜像 + 进行中的登记”。`versionExecutedAnywhere()` 只认两种情况：`executed_at` 非空，或有一条 `claimed`（执行已开始、还没确认）。登记：执行器每个迁移开始前回调 `beforeMigration`，服务端在**和编辑脚本同一把项目行锁**里确认脚本的 checksum / 已验证状态没变（变了 409，所以“编辑”和“登记执行”之间没有竞态），再 `insert … 'claimed' on conflict do nothing returning`，记下这次新登记了哪些。确认（`confirmVersion`：写 `executed_at` + 登记改 `confirmed`）发生在：执行成功（`afterMigration`）、执行失败但目标库已被改动、同步时发现版本在目标库历史里。**判断“目标库有没有被改动”用执行器自己维护的 `touched`，不看错误类型**：执行器在第一次会留下痕迹的写入之前回调 `onTouch(迁移)`——事务型迁移是在 `COMMIT` **成功返回之后**（`COMMIT` 本身可能失败，比如 DEFERRABLE 约束到提交时才检查，失败时库里没有任何变化；COMMIT 成功之后、回调之前进程崩溃也没关系：登记会留下，下一次同步发现目标库历史里已经有这个版本就会确认它），含非事务步骤的迁移是在第一个非事务步骤执行之前、以及每个事务段 `COMMIT` 成功之后（续跑时一开始就算），写基线保持“提交之前”（它没有会失败的脚本）；建 `dowel` schema、写项目行、`startRun` 不算。服务端 `runExecution` 的 `finally` 对这次新登记的版本：`touched` → 确认；否则撤销登记（`ensureHistory` 权限不足、`startRun` 失败、`PostgresError`、事务整体回滚……都一样，版本还能修脚本）。`syncEnvCache` 在目标库项目锁里**完全对齐**镜像（“历史里有的”看**全部**执行记录，不只最后一次：版本行，加上每条碰过目标库的记录——完成、`step_index` 非空、读回失败；只有完全干净的失败不算，见 `runTouched`）：历史里有的 → `confirmed`（并补 `executed_at`），历史里没有的（claimed 残留、换连接串 / 目标库重建后的旧行）**删掉**，当前版本更新；删记录不会丢保护，因为永久事实在 `executed_at`；持锁时不可能有执行在进行，所以 claimed 残留一定是进程崩溃留下的。同步先一次读出现有行（镜像、`versions.executed_at`、环境当前版本），只对有差异的行写，已经对齐时一条写入都没有（有测试数写入）。删除环境时 `environment_versions` 随环境级联删除，`executed_at` 还在。迁移里旧的登记回填成 `executed_at`（保守），`state` 默认 `confirmed`。改连接串会把当前版本和漂移结果作废。
- **同步的竞态（审查后）**：`GET …/history` 和执行结束后的同步都**在目标库的项目锁里读状态并写平台库缓存**（`syncTarget`：`withProjectLock` 不等待，拿不到锁——另一个执行正在进行，可能在别的进程——就只读不同步），读到的状态和写进缓存的状态之间不会插进一个执行；不依赖本进程的 `EnvLocks.busy()`（它只管本进程内的互斥）。
- **漂移检测（H4）**：`checkDrift`（只读，取项目锁但不等待：正在执行 → `skipped: busy`；停在中途 → `skipped: unfinished`；项目没版本 → `skipped: no_versions`）。没有历史时按“第一次执行”的判据（基线 / 空库 → ok，否则 drifted 并给出差异）；有历史时和当前版本比。结果由服务端写进环境缓存（`drift_status`：unknown / ok / drifted / error，`drift_summary` 里是版本、总数、差异列表或错误原因，`last_drift_check`）。执行 / 回滚遇到漂移时也顺手写进缓存。手动检查 `POST …/drift-check`；定时检查是 `DriftScheduler`（`apps/server/src/drift-scheduler.ts`）：`createApp` 只创建不启动，`main.ts` 按 `DOWEL_DRIFT_INTERVAL_MINUTES`（默认 60，0 关闭）启动，定时器 `unref`，不会阻止进程退出；`runOnce()` 逐个环境检查，上一轮没结束不重叠，一个环境出错（连不上 / 白名单拒绝）只记在该环境的 `error` 状态，不影响别的；测试里不启动，直接 `runOnce()` 或 `start(50)` 调短间隔。检查期间环境开始执行就作废结果。
- **基础执行权限（H6，authz.ts）**：三档 `editor` / `admin` / `executor` 存在 `environments.exec_policy`，null = 默认（非生产 editor、生产 admin；`defaultExecPolicy(undefined)` 按严的算）。新增 `EnvAction`：`environment.execute / rollback / baseline / resolve_drift（预留，“接受线上结构”没做）/ change_connection / unmark_production / set_policy / delete`，`can()` 里统一处理：档位看 `meetsPolicy`（editor / admin 看项目角色；**executor 档看 `Resource.isExecutor`，现在没有任何地方会置它，所以只有实例管理员能过——P5 接上执行者授权时只要在构造 Resource 的地方查询并置 `isExecutor`，`can()` 不用改**）；**配置类操作（改连接串 / 影子库、取消生产、改档位、删环境）另外至少要项目管理员**——档位只会收紧、不会放宽：非生产默认档位是编辑者，但不能因此让编辑者改连接串或删环境（原来这些就是管理员的权限）。标成生产（收紧）项目管理员就能做；取消生产标记时没有显式设置过档位的环境把当前生效的档位固定成显式值（`production: false` 不能悄悄把“项目管理员才能执行”放宽成“编辑者就能执行”）。路由用 `envAccess`（先按项目权限看环境，看不见 404；再按档位检查，403 的说明按档位生成）。新增 `PATCH …/environments/:eid`（连接串 / 影子库 / 同实例 / 生产标记 / 档位，每一项按上面规则查；新连接串要连得上，影子库要能认领；改完 `shadows.forget`），环境删除改用 `environment.delete`。模型的编辑和发布不受档位约束。手动检查漂移（`environment.check_drift`）、读历史只是读目标库结构，不算特权操作：前者编辑者以上，后者查看者，都共用连接限速。
- **接口（H7）**：`GET …/environments`（扩展：执行档位、当前版本、漂移、当前用户的权限）、`GET …/status`（只读平台库缓存：版本链按序号升序，每个版本相对当前版本是 applied / current / pending，带验证状态、步数、是否含非事务步骤、风险档、是否在本环境执行过，以及待执行列表）、`GET …/history`（读目标库的 `dowel.history`，最近 100 条，新的在前，带 `unfinished`）、`POST …/drift-check`、`POST …/execute`、`POST …/rollback`、`POST …/baseline`（SSE）。**执行 / 回滚的方向由接口决定**：`execute` 遇到“目标比当前更早”、`rollback` 遇到“目标比当前更新”都是 `wrong_direction`（空操作不受影响），所以权限和审计上两个动作不会混。**生产环境必须在请求里带环境名（`confirm`）**，服务端校验（422），不只是界面上的确认框。进度用 SSE，和向导一样（HTTP 200，出错时最后一条带 `error` / `code` / `details`；阶段 `lock → integrity → drift → plan → migration(start / step / done) → done`）。审计：`environment.execute / rollback / baseline`（成功和失败各一条，`data.ok`）、`environment.update`；动作表在 `audit-coverage` 里登记。连不上目标库等“预期的”错误给原因，意外错误只告诉客户端“服务器内部错误”并记日志。
- **P4a 遗留**：① **`assertImportable(sql)`**（shadow.ts）统一向导、`POST /import`、`shadowOps.importSql` 三个入口：返回品牌类型 `ImportableSql`，`importSql` 只接受它——检查只在入口做一次，下游不可能漏检也不会重复扫描（兜底检查和 `instanceLevelImportProblem` 删掉）；向导里挪到**连接限速之后**、连接任何库之前。② **脱敏收口**：全局 `onError` 的每个分支（含 `HTTPException`）和 SSE 的 `send`（新的 `sse.ts` 的 `sseSender`，递归脱敏每个字符串值，不是对整段 JSON 做正则——userinfo 的匹配会一路吃到同一行最后一个 `@`，JSON 里没有空白会把相邻字段吞掉）统一过 `scrubSecrets`；删掉的重复：向导 error 事件里的 `scrubSecrets(e.message)`、`importSql` 里包 `ShadowError` 的 `scrubSecrets`（错误只会走 onError 或 SSE 出口）、`scrubUrl(pgError(e), url)` 里 `pgError` 的那次（`scrubUrl` 自己就会 `scrubSecrets`）。**保留的**：写进存储（验证报告、`riskError`、目标库历史的 `error`）或进 200 响应体（`unverifiedReason`）之前的脱敏——它们不经过出口。③ `isNontransactionalSql` 增加 `REINDEX (…) DATABASE | SYSTEM` 和不带表名的 `CLUSTER`（含 `(选项)` / `VERBOSE`）；带表名的 `CLUSTER` 和 `REINDEX TABLE | INDEX | SCHEMA` 仍可进事务。这让 analyze 里“标 transactional:true 的裸 `CLUSTER`”不再是“文本看不出来”的例子：shadow-pg 里对应的用例改成断言“文本就能判断，标记写成 true 也在事务外执行”。④ 概览页的版本列表显示序号和验证标记（见界面）。
- **界面**：环境详情页（`pages/Environments.tsx`）新增“执行”区：当前版本（没执行过显示“尚未执行”）、漂移徽标 + “检查漂移”（`skipped` 时说明原因）、执行 / 回滚的目标版本下拉、“写入基线”（只在目标库没有历史、没有当前版本、且链上第一个版本是 v0 时出现）；版本链列出全部版本（复用 `VersionNumber` / `VersionBadges`，另标已执行 / 当前 / 待执行、含非事务步骤、high / medium 风险、风险分析未完成）；执行历史表（读目标库）；漂移差异列表（显示总数，最多 100 项）；`unfinished` 时页面上方红色提示条；“谁能执行”三档 + “默认（…）”，有 `configure` 权限才能改，无权限只读。没有 `permissions.execute` 时按钮用 `aria-disabled`（和编辑脚本的写法一致，不用 `disabled`）并按生效档位给出说明。确认对话框（`components/ExecDialog.tsx`）列出迁移（序号、名字、步数、非事务标注、风险；回滚说明回滚脚本没有锁和重写分析），**生产环境必须输入环境名**才启用确认（输入值原样作为 `confirm`），用 SSE 显示阶段和每个迁移的进度，出错时显示服务端文案、漂移差异、`partial` 提示；结束后刷新环境列表 / 状态 / 历史 / 版本。数据 hook 和 SSE 读取在 `apps/web/src/envs.ts`。图标栏复用 `['envs', pid]` 缓存：任一环境 drifted / error 时“环境”图标出现红点，用 `aria-describedby` 指向 sr-only 文字，**不改链接名**（e2e 里按名字“环境”找链接的写法不受影响）；项目概览新增漂移警告块（环境名、差异数、“查看”），最近版本列表显示 `v{number}` 和 `VersionStatus` 验证标记（v0 显示“基线”，P4a 遗留）。界面取舍：执行者列只显示用户 id 前 8 位，没解析成用户名；没有“生产环境”开关的编辑入口（原来就没有），所以界面上没接取消生产标记（接口有）；执行前不在界面拦未验证版本，由服务端 `unverified` 在对话框里提示；对话框运行中关闭，请求在后台继续、结束时仍会刷新数据但看不到进度；历史和漂移检查共用每人每分钟 10 次的连接限速，连点会遇到 429（toast 显示服务端文案）。e2e：`e2e/execute.spec.ts` 三条（非生产执行 + 回滚并用 `connectPg` 断言目标库结构、执行过的版本保存脚本被拒、概览 v 序号和验证标记；生产环境输入环境名；手工 `ALTER` 触发漂移，图标栏和概览出现警告，执行被拦，还原后恢复）；`a11y.spec.ts` 增加生产执行确认对话框、有版本链 / 历史 / 差异的环境详情、有警告的概览的 axe 扫描（亮暗各一）；`playwright.config.ts` 设 `DOWEL_DRIFT_INTERVAL_MINUTES=0` 关掉定时检查；`wizard.spec.ts` 里两处找概览链接 `v0 · 基线` 的断言改成 `基线`（概览现在把序号和名字分开显示）。
- **P4b 审查后的修正**：
  - **环境锁泄漏**：`runExecution` 原来先拿环境锁再 `decrypt` / 建连接，这两步不在 `finally` 里，密钥轮换或 URL 写错会把环境永久锁到重启。现在 `decrypt` 在拿锁之前，拿锁之后的一切（含建连接）都在 `try` 里，`finally` 一定释放并关连接；`checkEnvDrift` 的解密、建连接也都进了 `try`。
  - **失败记录不丢**：`wrap()` 现在**永远不抛**，任何错误都先整理成 `ExecutorError`（意外错误包成 `unexpected`，消息脱敏，原错误放 `cause`），先写 `failed` 记录，再抛。纯事务路径的失败记录在已回滚的事务之外另起事务写；写失败记录本身失败只记日志，抛的仍是原错误。服务端按 `cause` 再分类（`ScopeError` → `scope`，连接故障 → `connect`，其他 → 内部错误）。`details.reached` 对所有 `ExecutorError` 都会设置。
  - **第一个非事务步骤失败**：第一个非事务步骤执行**之前**先 `markStep(-1)`（“已开始，没完成任何一步”）；`readState` 本来就把 `failed 且 step_index 非空` 当作 `unfinished`，`-1` 因此被识别，续跑前先清理遗留的 INVALID 索引再重跑第 0 步，不会被当成漂移。
  - **读回校验失败且已经动过库**（含非事务步骤的迁移）：失败记录的 `error` 以 `READBACK_MARK`（`[readback_mismatch] `）开头——history 表没有放标记的列，不改表结构，用文本前缀。`readState` 对它给 `readbackFailure` 而不是 `unfinished`；`checkDrift` 把残留的差异报成 `drifted`（带 `needsManual`），执行 / 回滚在漂移检查处被拒绝（`details.needsManual`，文案说明这是上一次执行留下的、需要手工修正），所以不会无限重复同样的读回。纯事务迁移的读回失败整体回滚，库没动，不打标记。API：`RunInfo.readbackFailure`（服务端在 `runInfoOf` 里判断并剥掉文本里的标记；标记只在执行器 `state.ts` 一处识别，导出 `markReadbackError` / `isReadbackFailure` / `stripReadbackMark`，别处不写前缀也不写正则）、`DriftSummary.needsManual = { direction, versionId, versionNumber }`（回滚取被回滚的版本、升级取新版本，由服务端给出，前端照用）、`ExecErrorDetails.needsManual`。环境页顶部红色提示条**只在漂移检查结果仍是 drifted 且带 `needsManual` 时显示**，手工修好、检查返回 ok 之后就消失；摘要里的 `message` 和执行器的 `manualNote` 都只留一句短话，详细说明只在界面文案（`envx.manual.body`）里留一份。
  - **漂移检查的错误分类**（`classifyError`）：连接类故障 → `connect`（“连接目标库失败”）；目标库返回的其他错误（权限等，`PostgresError`）→ `database`；`ExecutorError`（历史与版本链对不上等）→ `integrity`；`ScopeError` → `scope`；`HistoryError` → `history`；其他 → `unexpected`（只记日志，文案不给细节）。状态仍是 `error`，`DriftSummary.errorKind` 给类别，界面按类别显示标题、文案原样显示；执行的 SSE 错误事件用同一套分类。
  - **精确删除无效索引**：`parseCreateIndexConcurrently` 解析出索引名和 `schema.table`（支持带引号、`IF NOT EXISTS`、`ONLY`），查询按 `indisvalid = false`、索引名、表名、表所在 schema 完全相等；没写 schema 或解析不了就不删，失败信息提示手工处理。原来的子串匹配会误删别的 schema 同名表上的同名无效索引。
  - **`toEnvVersion` 的“含非事务步骤”** 改用执行器导出的 `isNonTx`（冻结标记 + 语句文本），和执行器同一条规则。
  - **前端 SSE**：新增 `apps/web/src/sse.ts`（`readSse` / `parseSseFrame`），`streamExec` 和新建项目向导共用；按规范处理多行 `data:`、CRLF / CR（含被切开的 CRLF）、`data:` 冒号后空格可有可无、注释行、多字节字符被切开，流结束时缓冲里的最后一帧也会处理。`apps/web/test/sse.test.ts`。
  - **执行者显示名**：历史接口的 `RunInfo.executedByName`（用户已删除时为 null，界面回退到 id 前 8 位）。
  - 新增 / 更新测试：执行器 7 项（读回阶段普通 Error 和 `ScopeError` 都留下 failed 记录、第一个非事务步骤失败续跑且不是漂移、读回失败不可续跑、`parseCreateIndexConcurrently`、别的 schema 的无效索引不被删、漂移检查用版本冻结的范围）；服务端 `executions.test.ts` 重写“同步缓存”（只增不减）、新增“执行过的版本换 URL / 删除环境后仍 409”“解密失败 / URL 写错后锁不泄漏”“漂移错误分类（范围 / 完整性 / 连接）”“执行者显示名”；`migration.test.ts` 的回退多退一列。
- **P4b 第二轮审查的修正**：
  - **两张表重新划分职责**（见上面“平台库（迁移）”）：`executed_at` 唯一永久；`environment_versions` 加 `state`，镜像目标库历史 + 进行中的登记；`touched` 由执行器维护（`ExecuteOptions.onTouch`），服务端 `finally` 据此确认或撤销，与错误类型无关；`syncEnvCache` 完全对齐。新测试：执行账号没有建 schema 权限 → `ensureHistory` 失败、没有 dowel schema、v1 仍可编辑；人为留下的 claimed 残留被同步清掉、v1 可编辑；换 URL 到空库后 `executedHere` 全 false 但版本仍 409；删环境后仍 409；第二次同步零写入；执行器的 `onTouch` 在回滚 / startRun 出意外错误（不报告）、成功、第一个非事务步骤失败、写基线（报告）下的行为。
  - **平台库错误不再当成目标库错误**：`syncTarget` 里读目标库和写平台库分开 `try`，平台库写入失败只记日志、跳过这次同步，历史（状态）照常返回。测试：把 `environment_versions` 改名让同步出错，`GET …/history` 仍是 200。
  - **CIC 提示局部化**：提示挂在失败的那个 `StepFailure` 上（`hint`），不再是跨步骤的变量；前面一步没能识别索引名的 CIC 成功、后面事务步骤失败时错误里没有“无效索引”的提示（测试），解析不了的 CIC 自己失败时才有。
  - **性能**：执行者名字一次 `where id in (...)` 查完；`syncEnvCache` 先一次读出再按差异写。
  - **手工修好之后 readState 的结论**（回答审查里的问题）：把库改回**当前版本**（读回失败的那次执行的起点）的样子后，`checkDrift` 返回 ok，横幅消失。**`readState` 不会据此认为已经到了目标版本、也不会补写记录**：当前版本仍是最后一条 `done` 的 `to_version`（历史只追加，那条读回失败的记录还在，只是不再有漂移，标记不起作用）；之后的执行从头重新执行那个迁移（新开一条记录），脚本不改的话会再失败一次。如果手工把库改成了**目标版本**的样子，漂移检查是拿它和**当前版本**比，所以仍报漂移——要收下这个结果需要“处理漂移 / 接受线上结构”，目前没有；现在的办法是改回当前版本，或者发布一个新版本。这个行为写进了 docs/execution.md。
- **P4b 第三轮审查的修正**：
  - **touched 的时机**：事务型迁移（含含非事务步骤迁移的事务段）改成 `COMMIT` 成功之后才 `onTouch`，见上。测试：DEFERRABLE INITIALLY DEFERRED 外键在 COMMIT 时失败（SQLSTATE 23503），`onTouch` 没被调用、库没变、版本可编辑。
  - **claim 接管残留**：`claim` 本来就在执行器拿到目标库项目锁之后（`beforeMigration` 在 `locked()` 里）调用；现在遇到已有的 `claimed` 行就**接管**——当作本次的登记，加进 `claimed` 集合，`finally` 里按 `touched` 确认或撤销；已经 `confirmed` 的不动、不进集合。测试把结尾的同步（`ExecContext.syncTarget`，测试可替换，`createApp` 现在也返回 `exec`）打桩成返回 null：执行在第一个非事务步骤之后失败，`executed_at` 已写入，登记是 `confirmed`。 **第四轮修正**：接管来的行没有 touched 时**保持 claimed、不撤销**（不是这次插入的；没动过库不代表上一次崩溃的那次没动过），交给之后锁内的同步按目标库历史决定；只有本次新插入的、没有 touched 才撤销。`claim` 现在返回 `'new' | 'adopted' | null`。
  - **执行中途改 URL / 删环境**：`PATCH` 改 url / shadowUrl 和 `DELETE` 先 `lockEnvIdle`：占住环境锁（拿不到立刻 409，“环境正在执行，稍后再改”）并确认没有 `claimed` 行（有就 409，提示先读一次历史或重试执行让它收尾），改完才释放。`syncEnvCache` 清理 `claimed` 残留依赖“持有目标库项目锁 = 没有执行在进行”，有了这条保护这个前提才成立。**这个前提只在单进程部署下成立**：`EnvLocks` 是进程内的，平台库也是单实例。 **第四轮修正**：有 `claimed` 残留不再返回 409（会把环境锁死——目标库连不上时读历史清不掉残留）。改成：本进程没有在执行（拿到环境锁）时，在**改连接配置 / 删环境的同一个平台库事务里**调用 `settleClaims`：把残留 claimed 的版本写上 `executed_at`（当作执行过），删掉 claimed 行，再继续；只有本进程确实在执行（环境锁被占用）才 409。最坏的结果是一个其实没碰过库的版本不能再编辑，不会让碰过库的版本又能编辑。`allowSameInstance` 也算连接配置，走同一条路径。
  - **已知限制：多进程部署**。两个 Dowel 进程共用同一个平台库和目标库时，A 进程正在执行（环境锁在 A 里），B 进程的 `PATCH` 看不到 A 的环境锁，只能靠 `claimed` 行挡住（有，所以挡得住）；但 B 进程在 A 的 claim 之前改了 URL 就会让 A 往旧库执行。更根本的是 `claimed` 残留的“一定是崩溃留下的”推断也失效。多进程部署需要把环境锁放进平台库（或用平台库的 advisory lock），留作已知限制。
  - **inHistory 看全部历史**：`runTouched(run)` / `runVersionId(run)`（executor 的 `state.ts`）；`syncEnvCache` 对全部执行记录里碰过目标库的版本确认。测试：v2 读回失败（碰过库）、手工修好、再来一次干净的失败（数据相关的事务步骤第一步就报错），同步之后 v2 仍是 `executedHere`，镜像 `confirmed`，`executed_at` 在。
  - **人工修正横幅不丢**：`ExecutorError.details.needsManual` 和 `ExecErrorDetails.needsManual` 改成 `{ direction, versionId }` 对象（和 `DriftSummary.needsManual` 同一个 schema，`versionNumber` 由服务端补）。执行因漂移被拒绝时 `setDrift` 写入的摘要和 `checkDrift` 的格式一致（`summaryOfError`）；执行因 `readback_mismatch` 失败且目标库已被改动（`partial`）时，同一次请求里直接调用 `checkDrift`（执行器的项目锁此时已释放）刷新漂移状态，不会停在前一个迁移设下的 ok。测试：失败之后 status 接口立刻是 drifted、带 `needsManual`；再执行被拒绝后格式不变；手工修好后消失。**e2e 没加**：这个场景需要一个“已验证、但脚本结果不对”的版本，而验证本身（影子库闭环）会把这样的脚本判成失败，只能在平台库里直接改 `verified_at` 才构造得出来，e2e 的平台库是进程内存库，访问不到；服务端测试里用 SQL 构造。
  - **旧格式兼容**：`drift_summary` 里 `needsManual` 不是合格的 `{ direction, … }` 对象（早期的 `true`、方向不合法）时，`sanitizeSummary` 读出时丢掉；前端也再防一道（方向必须是合法值才显示横幅），不会渲染出空方向或问号。测试覆盖三种。
  - **executedHere 只统计 `state = 'confirmed'`**（claimed 只是进行中的登记）。
  - **清理**：`routes/executions.ts` 里“只增不减”的注释更新；`in (…)` 占位符抽成 `db.ts` 的 `inList(ids, startIndex = 1)`，`envs.ts`、`routes/executions.ts`、`rooms.ts` 三处共用。
- **P4b 第四轮审查的修正**：
  - **拿到环境锁之后重新读环境行**：`runExecution` 在 `locks.acquire` 之后 `loadEnv` 再解密（环境已删 → 404，连接串变了 → 用新的）；`checkEnvDrift` 一开始也重新读（定时检查一轮里后面的环境手里的行可能过期；环境已删时调度器忽略 404）。测试：手动占住环境锁模拟“PATCH 持有锁”，执行在等锁期间连接串被改，最终用新库执行、旧库没动；环境在等锁期间被删，执行被拒绝；过期的环境行传给 `checkEnvDrift`，用的是最新连接串。
  - **PATCH 先拿环境锁**（连接配置：url / shadowUrl / allowSameInstance），**再**做 `inspectTarget` / `claimShadow`，最后在一个平台库事务里改：被 409 拒绝的请求不碰任何数据库（测试：占着锁、连接串连不上，响应是 409 而不是连接错误，claimed 仍在、`executed_at` 仍为空）。**只写改动的列**（按字段拼接 update），不拿旧行的值回写；测试用 `db.transaction` 的桩记录 SQL，断言改档位 / 生产标记时 SQL 里没有 `url_enc`。
  - **残留 claimed 不会锁死环境**、**接管来的 claimed 不撤销**：见第三轮两条的“第四轮修正”。
  - **读回校验失败后的漂移状态**直接用执行器带出来的信息：`ExecutorErrorDetails.comparedVersionId / comparedNumber`（差异是线上结构和哪个版本的模型比的：目标版本），加 `needsManual` 和短句，`setDrift` 写 `drifted`；删掉原来多余的 `checkDrift`。缓存写失败不再 `catch(() => {})` 吞掉，记日志（`logFailure`）。之后手动 / 定时检查会把差异换成“线上结构 → 当前版本的模型”。
  - **`checkEnvDrift` 的 `current()`** 走 `driftInfo(env)`，所有返回都经过清洗（busy / unfinished 这些直接返回缓存的路径也是）。
  - **`runVersionId` 只有一份**（executor `state.ts`）：回滚取 `fromVersion`、升级 / 基线取 `toVersion`，对应字段为 null 就返回 null，**不回退到另一个字段**（回退会把别的版本算成“动过”）。`manualOf`、`drift.ts`、`locked()` 里的 `want`、`syncEnvCache` 都调用它；`syncEnvCache` 遇到 null 跳过。
  - **`sanitizeSummary` 用 `needsManualSchema.safeParse`**（额外字段被去掉，类型不对 / 缺字段整体丢掉）。
  - **前端**：`Object.hasOwn(DIRECTION_KEY, …)` 代替 `in`；`详情页也显示环境列表` 的注释挪回 `if (!env)` 之前。
  - 新增测试：`envs.test.ts`（`sanitizeSummary` 的各种坏值、`runVersionId` 的 null 规则、`runTouched`）；`executions.test.ts` 里上面各项。
- **测试**：`packages/executor/test/execute.test.ts`（真实 PG，14 项：链式执行 v1→v3 / 回滚 / 再执行 / 空操作、并发只执行一次 + 锁超时 + 漂移检查跳过、中途失败后停在上一版并重试成功、CIC 失败后断点续跑（含无效索引清理、半途状态下漂移检查跳过、不能改做回滚）、篡改目标库校验和 / 脚本 / 平台链 / 两边对不上、手工 `ALTER TABLE` 识别为漂移并拦住执行和回滚、首次执行的三条路径、未验证 / 实例级语句、读回不一致、脱敏、外来实例、未知版本）；`apps/server/test/executions.test.ts`（SQLite 和 PG 平台库各一遍：接口全流程、生产环境确认、漂移缓存与定时检查、并发 HTTP、干净失败后还能改脚本、写基线、连不上目标库的脱敏、同步缓存）；`exec-policy.test.ts`（`can()` 全部组合 + 接口：默认值、改档位、仅限执行者、配置类操作）；`scrub-exit.test.ts`；`permission-matrix` 登记 7 个新端点；`audit-coverage` 登记 4 个新动作；`migration.test.ts` 的“退回旧版本”要把 P4b 的列和表也退回；`nontx.test.ts` 补 REINDEX / CLUSTER；`verifier/test/random.test.ts` 新增“经执行器 + 历史表”的路径（默认最多 30 轮，约 11 秒；`EXEC_RUNS` 调大做深挖，跑过 500 轮）。
- **取舍和已知限制**：
  - **目标库历史属于另一个实例时拒绝执行**（`foreign_instance`）——共识里“另一个实例认领之后旧实例被拒绝”的前半句；认领流程（P4c）没做，所以现在平台库丢了重装后同一个库的历史会被拒绝，直到 P4c。
  - **半途状态的死胡同**：含非事务步骤的迁移失败后，如果问题出在脚本本身（不是数据），脚本是冻结的、而且已经算“执行过”，只能在目标库手工补完剩下的步骤——但历史里这次执行仍是 `failed`，没有“标记为已处理”的入口。留给 P4c / P5。**审查后细分了一种**：所有步骤都做完、读回校验才失败，续跑解决不了，不再当作“停在中途”（见下面“审查后的修正”）。
  - **只读 SQL 里的对象（`DO` 块、函数里的动态 SQL）不检查**，和影子库一样，实例级语句检查只是防误操作。
  - ~~比较用项目当前的 schema 范围~~ 审查后改了：`ChainVersion.scope` 取自 `versions.scope`，漂移检查 / 执行前的漂移判断用**环境当前版本冻结时的范围**，第一次执行（基线 / 空库判断）用第一个版本的，读回校验用目标版本的；执行器的 `scope` 选项删掉了。
  - 每个迁移的读回校验依赖 `plan(线上结构, 版本模型)` 为空；发布时模型是规范化过的所以不会误报（随机测试验证），但**没有经过规范化的模型**（例如影子库不可用时发布的版本——它们也是未验证的，执行器本来就不放行）不保证。
  - 没有语句级超时和 `lock_timeout`（目标库上的 DDL 可能一直等锁，排在它后面的业务语句也会被挡住）：留给执行策略（P5）。
  - “接受线上结构”（处理漂移）没做，`environment.resolve_drift` 只是预留了动作。
  - 执行时没有“只看不执行”的预演接口：确认对话框用的是平台库缓存的状态和发布时的风险报告。
  - 平台库缓存可能落后于目标库（别人直接动了历史）：读历史 / 执行后会同步，状态页本身不连目标库。
- 坑：postgres.js 的 `unsafe` 带参数时同一个 `$n` 不能同时被推成两种类型（`seq bigint` 和 `number int` 共用 `$4` 会报 `inconsistent types`）；在 SQLite 平台库上 `on conflict do nothing` 可以用；PG 全新库的 `public` 带默认注释（上面）；`withProjectLock` 对没有 `reserve` 的单连接适配器不会在 finally 里 `ROLLBACK`，所以执行器自己每个事务都显式 `ROLLBACK`；测试里 `connect()` 是 `max: 1` 的连接，要测真正的并发必须用两个连接。

## 5. 下一步

M2：SQLite（12 步重建表）、PG 多版本（14～18）与版本能力表、多环境分别验证、分区表编辑。
