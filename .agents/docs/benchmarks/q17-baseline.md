# Q17 Phase 2：100 / 1,000 表三层基准压测基线报告

> 本文档记录 Q17 Phase 2 在真实代码库、Chromium 浏览器与 PostgreSQL 18 影子库上的首次实测基线数据，作为 Phase 3 千表红线验收与瓶颈治理的对照基准。不阻塞常规 CI，所有脚本按需执行。

---

## 1. 测试环境与复现命令

### 1.1 运行环境

| 组件       | 实测配置                                                                              |
| ---------- | ------------------------------------------------------------------------------------- |
| CPU        | `AMD Ryzen 5 5600X 6-Core Processor`（Node 可见 `8 cores`）                           |
| 内存       | `15.62 GiB`                                                                           |
| 操作系统   | `Linux 6.12.115+deb13.1-amd64` (`#1 SMP PREEMPT_DYNAMIC Debian 6.12.115-2`, `x86_64`) |
| Node.js    | `v26.13.0`                                                                            |
| 浏览器     | `Chromium 159.0.8154.6` (`Playwright 1.65.1`)                                         |
| PostgreSQL | `PostgreSQL 18.7 (Debian 18.7-1.pgdg12+2)`（Testcontainers `pgvector/pgvector:pg18`） |
| 影子库超时 | `SHADOW_STATEMENT_TIMEOUT_MS = 120_000`（120s，见 `apps/server/src/shadow.ts:111`）   |

### 1.2 按需运行命令

```bash
# Layer 1: @dowel/core & @dowel/sync 性能与内存（默认 100,1000，可用 --tables=100 过滤）
pnpm bench:core

# 构建前端静态产物（Layer 2 真实服务端托管 apps/web/dist）
pnpm build

# Layer 2: Playwright Chromium 真实前端压测（Canvas + Sidebar + elkjs + Long Tasks）
pnpm bench:ui

# Layer 3: PostgreSQL 18 影子库 DDL / 快照 / SQL 导入 / verify 压测（支持 DOWEL_TEST_PG 指定外部实例）
pnpm bench:shadow

# 串行执行 Layer 1 + 2 + 3 全部压测
pnpm bench:all
```

> 说明：`bench/generator.ts` 的快速正确性单元测试 `bench/generator.test.ts` 已纳入 `vitest.config.ts`；三层重压测脚本均**未**纳入 `pnpm test`、`pnpm e2e` 或 `.github/workflows/ci.yml`。

---

## 2. 确定性大 Schema 夹具画像（`bench/generator.ts`）

`generateLargeSchema` 按 10 个业务域前缀（`auth`、`org`、`catalog`、`order`、`inventory`、`billing`、`ledger`、`notif`、`audit`、`analytics`）跨 5 个 schema（`public`、`commerce`、`finance`、`ops`、`analytics`）确定性生成 PostgreSQL 模型，并通过 Phase 1 `suggestSectionsByPrefix` 自动划分为 10 个画布板块：

| 指标                | `100` 顶级表夹具 | `1,000` 顶级表夹具 | 说明                                            |
| ------------------- | ---------------- | ------------------ | ----------------------------------------------- |
| **总 IR 对象数**    | `1,932`          | `19,093`           | 1,000 表落在 Q17 约 1.5 万–2 万对象规格区间     |
| Schemas             | `5`              | `5`                | 5 个业务 schema                                 |
| Enums / Sequences   | `20` / `10`      | `20` / `100`       | 每域 2 个枚举，每 10 表 1 个序列                |
| 分区父表 / 子分区   | `2` / `6`        | `20` / `60`        | 每父表 3 个子分区                               |
| 列 (`column`)       | `1,212`          | `12,120`           | 含复合主键列、多外键列、枚举/数值/文本/JSONB 列 |
| 主键 / 唯一约束     | `100` / `59`     | `1,000` / `588`    | 含复合 PK 与复合 Unique                         |
| 外键 (`foreignKey`) | `150`            | `1,500`            | 域内及跨域无环参照关系（1,000 表准确 1,500 条） |
| 检查约束 / 索引     | `70` / `200`     | `700` / `2,000`    | 含 CHECK 与单列/复合 B-Tree 索引                |
| 模型 JSON 体积      | `718.1 KiB`      | `6.97 MiB`         | `JSON.stringify(model)` UTF-8 字节数            |
| `generate` 耗时     | `49.42 ms`       | `420.50 ms`        | 近似 `O(N)` 线性生成                            |
| `validate(model)`   | `errs = 0`       | `errs = 0`         | 均 0 校验错误，且可通过 PG 18 完整 DDL 执行     |

小改动基准变体 `createSmallChangeVariant` 对 `order` 域目标表施加 3 项典型修改（`addColumn`、`addIndex`、`renameColumn`），对应 `plan(v1, v2)` 产出 `3` 步迁移。

---

## 3. Layer 1 实测数据：`@dowel/core` & `@dowel/sync`（`pnpm bench:core`）

### 3.1 核心引擎与同步往返耗时

`mutate` 往返在内存房间（`Room` + `SyncClient`）内测量单步操作经历 `client.mutate()`、`room.handle()` 与 `client.receive()` 的完整耗时（含消息跨传输 `structuredClone`）。

| 指标                         | 100 表 (`n`)         | 1,000 表 (`n`)             | 10× 规模放大倍数（按 p50） | 详情                                                                                                                                    |
| ---------------------------- | -------------------- | -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `validate(model)`            | `74.69 ms` (`n=20`)  | **`11,864.65 ms`** (`n=5`) | **158.85×**                | 100t: p95 `83.79 ms` max `87.08 ms`；1000t: min `10.86 s` mean `11.62 s` p95 `12.25 s` max `12.32 s`                                    |
| `plan(v1, v2)`（3 步小改动） | `151.39 ms` (`n=20`) | **`15,740.27 ms`** (`n=5`) | **103.97×**                | 100t: p95 `180.39 ms` max `198.75 ms`；1000t: min `14.85 s` mean `15.73 s` p95 `16.67 s` max `16.82 s`                                  |
| `createAll(model)`           | `105.68 ms` (`n=10`) | **`7,364.75 ms`** (`n=5`)  | **69.69×**                 | 100t: `730 steps` / SQL `123.5 KiB`（max `174.25 ms`）；1000t: `7,073 steps` / SQL `1.19 MiB`（min `6.75 s` p95 `7.65 s` max `7.65 s`） |
| `sync mutate` 汇总 (`all`)   | `105.30 ms` (`n=30`) | **`1,030.81 ms`** (`n=16`) | **9.79×**                  | 100t: p95 `188.84 ms` max `223.29 ms`；1000t: min `645.90 ms` mean `1.04 s` p95 `1.43 s` max `1.47 s`                                   |
| └─ `setComment` 往返         | `78.40 ms` (`n=15`)  | `704.48 ms` (`n=8`)        | **8.99×**                  | 1000t: `cli p50=464.50 ms`（p95 `533.52 ms` max `564.47 ms`），`srv p50=235.96 ms`，`rcv=0.05 ms`                                       |
| └─ `renameColumn` 往返       | `119.11 ms` (`n=15`) | **`1,357.27 ms`** (`n=8`)  | **11.40×**                 | 1000t: `cli p50=908.86 ms`（p95 `973.20 ms` max `974.62 ms`），`srv p50=445.07 ms`，`rcv=0.05 ms`                                       |

> 注意：`SyncClient.mutate()` 在本地先调用一次 `execute()`（`structuredClone` + 全对象 `deepEqual`），随后又在 `rebuild()` 内对本地待确认队列再执行一次 `execute()`，加之 `renameColumn` 触发派生约束/索引名重算，导致客户端单次 `mutate`（~909 ms）约占 1,000 表往返耗时的 67%，服务端 `room.handle()`（~445 ms）占 33%。

### 3.2 Node 进程内存占用（`bench/core.ts`）

| 规模     | `baseHeap`  | `afterGenHeap`（模型增量） | `endHeap`（压测后）        | 进程 `RSS`（`ΔRSS`）         |
| -------- | ----------- | -------------------------- | -------------------------- | ---------------------------- |
| 100 表   | `15.60 MiB` | `16.49 MiB` (`+918.1 KiB`) | `19.07 MiB`                | `216.71 MiB` (`+115.75 MiB`) |
| 1,000 表 | `17.48 MiB` | `22.90 MiB` (`+5.42 MiB`)  | `28.64 MiB` (`+11.16 MiB`) | `510.60 MiB` (`+294.14 MiB`) |

---

## 4. Layer 2 实测数据：Playwright Chromium UI（`pnpm bench:ui`）

> 测量说明：`PerformanceObserver({ type: 'longtask', buffered: true })` 统计 `> 50 ms` 主线程长任务；`TBT = Σ max(0, duration - 50 ms)`。

### 4.1 首屏、聚焦、板块展开与 `elkjs` 布局

| 场景                                          | 渲染表节点数   | 端到端耗时                | 长任务数 (`ltCount`) | 最大单次长任务 (`ltMax`)  | 主线程阻塞总时间 (`TBT`) |
| --------------------------------------------- | -------------- | ------------------------- | -------------------- | ------------------------- | ------------------------ |
| `100t` 平铺首屏 + `elkjs` 自动布局            | `100`          | `1,098.9 ms (1.10 s)`     | `6`                  | `241.00 ms`               | `504.00 ms`              |
| `1000t` 默认 `>100` 折叠摘要首屏              | `10`（摘要卡） | **`4,142.8 ms (4.14 s)`** | `4`                  | **`3,454.0 ms (3.45 s)`** | `3,646.0 ms (3.65 s)`    |
| `1000t` 1 跳邻域聚焦冷启动首屏                | `5`            | **`4,764.1 ms (4.76 s)`** | `5`                  | **`3,663.0 ms (3.66 s)`** | `3,711.0 ms (3.71 s)`    |
| `1000t` 聚焦状态从 1 跳切换至 2 跳            | `11`           | **`7,180.6 ms (7.18 s)`** | `2`                  | **`6,971.0 ms (6.97 s)`** | `6,955.0 ms (6.96 s)`    |
| `1000t` 2 跳邻域聚焦冷启动首屏                | `11`           | **`5,439.4 ms (5.44 s)`** | `5`                  | **`4,184.0 ms (4.18 s)`** | `4,296.0 ms (4.30 s)`    |
| `1000t` 展开单个板块（`order` 100 表）+ `elk` | `100`          | **`5,507.9 ms (5.51 s)`** | `4`                  | **`4,260.0 ms (4.26 s)`** | `4,898.0 ms (4.90 s)`    |
| `1000t` 已展开 `order` 显式点击「自动布局」   | `100`          | `1,741.3 ms (1.74 s)`     | `4`                  | `516.00 ms`               | `1,024.0 ms (1.02 s)`    |

> **关键发现**：即便画布上仅渲染 `10` 张折叠摘要卡或 `5` 张 1 跳聚焦表，首屏与切换仍伴随 **3.45 s – 6.97 s 的单次主线程长任务**；而真正仅运行 100 表 `elkjs` 重排时，耗时为 `1.74 s`（最大长任务 `516 ms`、`TBT 1,024 ms`）。说明折叠/聚焦首屏卡顿的主要放大器来自整模型级别的全量计算与侧边栏同步渲染，而 `elkjs` 在主线程执行则另外贡献了约 0.5–1.0s 的 TBT 阻塞。

### 4.2 1,000 表项目交互延迟（`order` 板块已展开，画布 100 表）

| 交互动作                                  | 样本数 (`n`) | `min`         | `p50`                      | `p95`                      | `max`                      | 长任务 (`ltCount` / `ltMax` / `TBT`)                        |
| ----------------------------------------- | ------------ | ------------- | -------------------------- | -------------------------- | -------------------------- | ----------------------------------------------------------- |
| 点击选中画布表节点                        | `5`          | `4,219.51 ms` | **`4,551.49 ms (4.55 s)`** | **`6,721.09 ms (6.72 s)`** | **`6,875.79 ms (6.88 s)`** | `11` 次 / max **`6,544 ms`** / TBT `25,137 ms`              |
| 拖拽表节点 `requestAnimationFrame` 帧间隔 | `170` 帧     | `16.60 ms`    | **`183.30 ms`**            | **`509.13 ms`**            | **`766.70 ms`**            | `95` 次（5 轮拖拽会话共享）/ max `610 ms` / TBT `24,642 ms` |
| 拖拽结束释放稳定 (`drop settle`)          | `5`          | `659.47 ms`   | `707.19 ms`                | `796.41 ms`                | `814.43 ms`                | 见上行拖拽会话                                              |
| Sidebar 搜索框输入过滤                    | `5`          | `3,415.07 ms` | **`3,935.99 ms (3.94 s)`** | **`4,668.14 ms (4.67 s)`** | **`4,749.01 ms (4.75 s)`** | `5` 次 / max **`4,611 ms`** / TBT `18,833 ms`               |
| Sidebar 切换「按 Schema」→「按板块」      | `5`          | `4,298.42 ms` | **`4,501.99 ms (4.50 s)`** | **`4,810.56 ms (4.81 s)`** | **`4,884.30 ms (4.88 s)`** | `5` 次 / max **`4,187 ms`** / TBT `19,599 ms`               |
| Sidebar 切换「按板块」→「按 Schema」      | `5`          | `4,266.50 ms` | **`4,331.64 ms (4.33 s)`** | **`4,692.57 ms (4.69 s)`** | **`4,699.50 ms (4.70 s)`** | `5` 次 / max **`4,183 ms`** / TBT `19,541 ms`               |

---

## 5. Layer 3 实测数据：真实 PostgreSQL 18 影子库（`pnpm bench:shadow`）

针对 Docker `pgvector/pgvector:pg18`（`PostgreSQL 18.7`）实测全套影子库路径；其中 `verify` 验证了 `upDiffCount = 0`、`downDiffCount = 0`，`importSql` 验证准确导入 `100` / `1,000` 张顶级表。

| 阶段                                    | 100 表 (`1,932` 对象)       | 1,000 表 (`19,093` 对象)      | 备注 / 细项拆解（1,000 表）                                                             |
| --------------------------------------- | --------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `createAll` 生成计划 (`plan()`)         | `82.35 ms`                  | `9,977.9 ms (9.98 s)`         | `730` → `7,073` 步 DDL                                                                  |
| `createAll` 逐条执行 (`runSteps()`)     | `877.65 ms`                 | `11,509.0 ms (11.51 s)`       | 单句 `p50=1.24 ms` / `max=51.96 ms`（最慢建表 `finance.ledger_snap_053`）               |
| `readSnapshot(db)`（p50，1000t `n=3`）  | `50.89 ms` (max `59.99 ms`) | `448.93 ms` (max `491.22 ms`) | 快照 JSON `471.4 KiB` → `4.58 MiB`；最慢目录查询 `pg_attribute` `218.68 ms`             |
| `importSnapshot(snap)`                  | `33.77 ms`                  | `369.03 ms`                   | 纯内存快照转 IR 耗时随规模线性增长                                                      |
| `importSql` 端到端总计                  | `449.03 ms`                 | `5,786.18 ms (5.79 s)`        | `ddl=1.20 MiB`：`resetAndPrepare=1.38 s` + `singleExec=3.32 s` + `readAndImport=1.09 s` |
| `verify`: `plan(up) + plan(down)`       | `285.22 ms`                 | **`35,431.24 ms (35.43 s)`**  | 含 `up=3`、`down=3` 两次完整计划构建                                                    |
| `verify`: `buildTarget(v2)`             | `1,116.2 ms (1.12 s)`       | **`20,812.97 ms (20.81 s)`**  | `resetShadow` + `createAll(v2)` + `readSnapshot`                                        |
| `verify`: `buildTarget(v1)`             | `1,205.7 ms (1.21 s)`       | **`18,171.64 ms (18.17 s)`**  | `resetShadow` + `createAll(v1)` + `readSnapshot`                                        |
| `verify`: `run up + snap + diff`        | `114.37 ms`                 | `728.56 ms`                   | `runUp=4.16 ms` + `readAfterUp=349.20 ms` + `diffUp=375.20 ms` (`upDiff=0`)             |
| `verify`: `run down + snap + diff`      | `113.58 ms`                 | `696.30 ms`                   | `runDown=5.39 ms` + `readAfterDown=342.28 ms` + `diffDown=348.63 ms` (`downDiff=0`)     |
| `verify`: `analyze()` [第 3 次全库重建] | `1,640.1 ms (1.64 s)`       | **`19,304.69 ms (19.30 s)`**  | `risks=3`（`packages/engines/src/pg/engine.ts` `analyze()` 再次全量重建）               |
| **`TOTAL shadowOps.verify()`**          | `4,475.3 ms (4.48 s)`       | **`95,145.42 ms (95.15 s)`**  | 端到端闭环验证总耗时                                                                    |
| 最慢单条 SQL / 占 120s 超时比例         | `244.92 ms` (`0.20%`)       | `3,316.78 ms` (`2.76%`)       | `[importSql] SET search_path = public; ...` 单批 Simple Query                           |
| 最慢 `DROP SCHEMA ... CASCADE`          | `51.45 ms` (`0.04%`)        | `495.03 ms` (`0.41%`)         | `DROP SCHEMA commerce CASCADE`                                                          |

---

## 6. Phase 3 性能红线记分牌（1,000 表基线对照）

| 指标                      | Phase 3 红线    | 100 表实测                  | 1,000 表实测                                             | 当前差距（1,000 表）                   | 判定      |
| ------------------------- | --------------- | --------------------------- | -------------------------------------------------------- | -------------------------------------- | --------- |
| `validate(model)`         | `< 100 ms`      | `74.69 ms`                  | **`11,864.65 ms`** (`11.86 s`)                           | 超标 **118.6×**                        | ❌ 未达标 |
| 小改动 `plan(v1, v2)`     | `< 200 ms`      | `151.39 ms`                 | **`15,740.27 ms`** (`15.74 s`)                           | 超标 **78.7×**                         | ❌ 未达标 |
| 单次 `sync mutate` 往返   | `< 30 ms`       | `105.30 ms`                 | **`1,030.81 ms`** (`renameColumn 1.36 s`)                | 超标 **34.4×**（`renameColumn` 45.2×） | ❌ 未达标 |
| 1/2 跳聚焦首屏            | `< 1,000 ms`    | —（100t 平铺 `1.10 s`）     | **`4.76 s` (1 跳) / `5.44 s` (2 跳)**                    | 超标 **4.8× – 5.4×**                   | ❌ 未达标 |
| 选中画布节点              | `< 50 ms`       | —                           | **`4,551.49 ms`**（max `6.88 s`）                        | 超标 **91.0×**                         | ❌ 未达标 |
| 节点拖拽（帧间隔 / 落定） | `< 50 ms`       | —                           | **`183.30 ms` p50 / `509.13 ms` p95**（max `766.70 ms`） | 超标 **3.7× – 10.2×**                  | ❌ 未达标 |
| Sidebar 搜索过滤          | `< 50 ms`       | —                           | **`3,935.99 ms`**（max `4.75 s`）                        | 超标 **78.7×**                         | ❌ 未达标 |
| `elkjs` 主线程长任务阻塞  | `0 ms` (Worker) | `241 ms` max / `504 ms` TBT | `516 ms` max / `1,024 ms` TBT（显式重排 100t）           | 仍运行于主线程                         | ❌ 未达标 |

---

## 7. `SHADOW_STATEMENT_TIMEOUT_MS = 120_000` 实测评估

结合 Layer 3 实测数据，**建议继续保持 `SHADOW_STATEMENT_TIMEOUT_MS = 120_000`（`apps/server/src/shadow.ts:111`）不变**：

1. **PostgreSQL 单条语句远未触及 120s 上限**：
   - 在 1,000 表（19,093 对象）规模下，`createAll` 单条建表 DDL 最大仅 `51.96 ms`（p50 `1.24 ms`），`pg_attribute` 目录查询 `218.68 ms`，`DROP SCHEMA commerce CASCADE` 为 `495.03 ms`（占超时阈值 `0.41%`）。
   - 唯一较重的单句是 `importSql()` 将 1.20 MiB DDL 作为单批 Simple Query 执行，实测 `3,316.78 ms`（仅占 120s 上限的 `2.76%`，仍有约 **36×** 安全余量应对较慢的远程/容器环境或更大批量索引创建）。
2. **`shadowOps.verify()` 总耗时高达 `95.15 s` 的根因并非单句 SQL 超时，而是 JS 侧重复计划与 3 次全库重建**：
   - 仅 JS `plan(up+down)` 与两次 `buildTarget` 内部 `createAll().plan()` 合计就消耗 `35.43 s + 2 × 9.98 s ≈ 55.4 s`；
   - `verify()` 为构建目标与基准态执行了 2 次 `createAll` + `runSteps`（`~23 s`），随后 `analyze()`（`packages/engines/src/pg/engine.ts`）又执行了第 3 次完整 `resetShadow` + `createAll` + 执行（`19.30 s`）。
   - Phase 3 完成 `plan` / `createAll` 索引化并复用 `buildTarget(v1)` 快照/状态消除 `analyze()` 第 3 次重建后，端到端 `verify()` 有望从 `95.15 s` 降至约 `10–25 s` 量级。

---

## 8. Phase 3 瓶颈优先级与代码定位

按**对千表红线影响面 × 当前超标倍数**排序：

### P0-1：`packages/core` 缺乏对象索引，`O(T × N)` 全对象线性扫描

- **实测表现**：10× 表规模导致 `validate` 退化 **158.9×**（`11.86 s`）、小改动 `plan` 退化 **104.0×**（`15.74 s`）、`createAll` 退化 **69.7×**（`7.36 s`）。
- **代码定位**：
  - `packages/core/src/model.ts`：`all()` 每次调用均执行 `Object.values(m.objects)` 遍历并过滤；`childrenOf()`、`columnsOf()`、`partitionsOf()` 均全量扫描 `all()`。`validate()` 在全对象循环外又对全部表调用 `childrenOf(m, t.id, 'primaryKey')`。
  - `packages/core/src/pg/dialect.ts`：`validateModel(m)` 对每张表调用 `childrenOf`、`partitionDescendants`、`partitionsOf`。
  - `packages/core/src/pg/plan.ts`：`plan()` 内执行 `structuredClone`（`clone(from)`）、`normalizeAllPartitionFamilies` 与 `checkPgCompatibility`，并在 `from`/`to` 间高频调用上述无索引辅助函数。
- **Phase 3 方向**：构建挂靠在 `Model` 实例生命周期上的惰性索引（`WeakMap<Model, ModelIndex>`：`byKind`、`childrenByParent`、`partitionsByParent` 等），在不污染序列化 JSON 结构的前提下将查询复杂度降至 `O(1)` / `O(children)`。

### P0-2：前端 `Sidebar.tsx` 的 `O(T²)` 构树计算与无虚拟滚动 DOM 爆炸，同步拖垮画布聚焦/选中响应

- **实测表现**：即使画布仅展示 10 张折叠卡或 5 张聚焦表，首屏与切换仍出现 **3.45 s – 6.97 s** 主线程长任务；点击画布表节点 p50 高达 **`4.55 s`**（max `6.88 s`）；Sidebar 搜索 filter p50 **`3.94 s`**、Schema↔板块切换 p50 **`4.33–4.50 s`**。
- **代码定位**：
  - `apps/web/src/pages/Workspace.tsx`（L228–260）：`useShellPanel` 的依赖数组包含 `selected` 与 `model`，导致每次点击画布节点选表都会重新渲染 `<Sidebar>`。
  - `apps/web/src/components/Sidebar.tsx`：未做 `useMemo` 的 `filteredTables = topLevelTables.map((x) => buildTableNode(...))` 在每次渲染时对 1,000 张顶级表逐表调用 `partitionsOf(model, tb.id)`（每次全扫 `all(m, 'table')`），形成 **`O(T²)`** 算法复杂度，同时直接挂载上千个未虚拟化的 `<ul>`/`<li>` DOM 节点。
  - `apps/web/src/sections.ts`：`collectNeighborhood()` 每次调用重建全量 `foreignKey` 邻接表。
- **Phase 3 方向**：依赖 core 索引化（或 Sidebar 内部一次建表按 `parentTable` 分组）消除 `O(T²)`；将 `filteredTables`/树构型 memo 化并隔离 `selected` 高频变化；为 Sidebar 列表接入虚拟滚动（如 `@tanstack/react-virtual`）；缓存/增量维护邻域邻接表。

### P0-3：`@dowel/sync` 单步 `mutate` 重复全量 `structuredClone` 与全模型 `deepEqual` 对比

- **实测表现**：1,000 表下单个字段改名往返 **`1.36 s`**（`setComment` `704.5 ms`），远超 `< 30 ms` 红线。
- **代码定位**：
  - `packages/sync/src/protocol.ts`：`execute()` 对整个 `Model` 执行 `structuredClone(m)`，随后遍历 `Object.entries(next.objects)` 与全量 `deepEqual()` 计算变更集与 `refreshDerivedNames`。
  - `packages/sync/src/client.ts`：`SyncClient.mutate()` 调用 `execute()`（第 1 次全量拷贝）→ `opReads()` → `rebuild()` 再次调用 `execute()`（第 2 次全量拷贝）；随后 `Room.process()`（`packages/sync/src/server.ts`）再次执行 `execute()`（第 3 次）。
- **Phase 3 方向**：采用不可变对象按键增量写时复制（只浅克隆顶层及被修改对象 ID），直接按受影响对象集合生成 diff 与局部刷新派生名，并避免 `SyncClient.mutate()` 在未冲突队列下的双倍执行。

### P1-1：`Canvas.tsx` 拖拽与选中期间全量节点/边重建 + 大量 `<Handle>`

- **实测表现**：100 表已展开画布上拖拽表节点 `rAF` 帧间隔 `p50 = 183.30 ms`、`p95 = 509.13 ms`、`max = 766.70 ms`（红线 `< 50 ms`）。
- **代码定位**：
  - `apps/web/src/components/Canvas.tsx`：`onNodesChange` 在每次指针移动 `dragging` 帧更新 React state，直接使 `tableNodes` 与 `edges` 的 `useMemo` 失效，进而对全模型重复运行 `all(model, 'foreignKey' | 'primaryKey' | 'unique')` 与 `columnsOf`；同时 `RowHandles` 为每个可见列渲染 4 个 React Flow `<Handle>`。
- **Phase 3 方向**：将拖拽临时坐标与实体 `tableNodes`/`edges` 依赖解耦（仅让 React Flow 管理受控节点位置或局部位置补丁）；拆分表结构计算与位置/选中态更新；减少不必要的 `<Handle>` DOM 数量。

### P1-2：`elkjs` 迁入 Web Worker 消除主线程长任务阻塞

- **实测表现**：`elkjs` 在主线程同步/阻塞运行导致 100 表平铺 `504 ms` TBT、显式重排 `1,024 ms` TBT（max `516 ms`）。
- **代码定位**：`apps/web/src/components/Canvas.tsx`（`autoLayout()` 中直接 `new ELK()`）。
- **Phase 3 方向**：将 `elkjs` 封装至专用 Web Worker 异步计算坐标，配合布局版本号取消过期响应，实现 `0 ms` 主线程布局长任务阻塞。

### P2：`shadowOps.verify()` 消除 `analyze()` 第 3 次全库重建

- **实测表现**：`verify()` 总计 `95.15 s` 中有 `19.30 s`（约 20%）花在 `analyze()`（`packages/engines/src/pg/engine.ts`）重复清空并第三次建全库。
- **Phase 3 方向**：在 core `plan()`/`createAll()` 索引化提速之外，支持 `analyze()` 复用 `verify()` 已验证或已构建的影子库状态/快照，去掉冗余的第三次重建。
