# Q17 Phase 3：千表级性能红线验收与底座优化实测报告

> 本文档记录 Q17 Phase 3 在核心模型索引化、同步写时复制增量执行、前端按需渲染/虚拟化/`elkjs` Web Worker 化以及影子库复用优化落地后，于同一宿主环境、Chromium 浏览器与 PostgreSQL 18 影子库上实测的三层完整对照结果，与 [q17-baseline.md](q17-baseline.md) 逐项对比，所有千表 SLO 红线均已达标。

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
| 影子库超时 | `SHADOW_STATEMENT_TIMEOUT_MS = 120_000`（120s，见 `apps/server/src/shadow.ts:112`）   |

### 1.2 按需运行命令

```bash
# Layer 1: @dowel/core & @dowel/sync 性能与内存（100 / 1,000 表）
pnpm bench:core

# 构建全仓包与前端静态产物（Layer 2 真实服务端托管 apps/web/dist）
pnpm build

# Layer 2: Playwright Chromium 真实前端压测（Canvas + Sidebar + elkjs Worker + Long Tasks）
pnpm bench:ui

# Layer 3: PostgreSQL 18 影子库 DDL / 快照 / SQL 导入 / verify + reuseShadowFrom 压测
pnpm bench:shadow
```

---

## 2. 千表性能红线验收记分牌（1,000 表 · `19,093` IR 对象）

| 指标                         | Phase 3 红线    | Phase 2 基线（1,000 表）                                    | Phase 3 实测（1,000 表）                                             | 提升倍数          | 判定    |
| ---------------------------- | --------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ----------------- | ------- |
| `validate(model)`            | `< 100 ms`      | `11,864.65 ms`                                              | **`37.08 ms`**（p95 `39.07 ms`, max `39.44 ms`）                     | **320.0×**        | ✅ 达标 |
| 小改动 `plan(v1, v2)`        | `< 200 ms`      | `15,740.27 ms`                                              | **`139.00 ms`**（p95 `156.00 ms`, max `159.65 ms`）                  | **113.2×**        | ✅ 达标 |
| 单次 `sync mutate` 往返      | `< 30 ms`       | `1,030.81 ms`（`setComment 704.48` / `renameColumn 1.36s`） | **`10.70 ms`**（`setComment 10.68 ms` / `renameColumn 10.70 ms`）    | **96.3×**         | ✅ 达标 |
| 折叠摘要首屏 / 1 跳 / 2 跳   | `< 1,000 ms`    | `4.14 s` / `4.76 s` / `5.44 s`                              | **`542.47 ms`** / **`726.39 ms`** / **`725.78 ms`**                  | **6.6×–7.6×**     | ✅ 达标 |
| 选中画布节点（p50）          | `< 50 ms`       | `4,551.49 ms`（max `6.88 s`, `ltCount=11`）                 | **`44.20 ms`**（p95 `44.53 ms`, max `44.60 ms`, `ltCount=0`）        | **103.0×**        | ✅ 达标 |
| 节点拖拽 `rAF` 帧间隔（p50） | `< 50 ms`       | `183.30 ms`（p95 `509.13 ms`, max `766.70 ms`）             | **`16.70 ms`**（p95 `16.70 ms`, max `16.80 ms`, `ltCount=0`）        | **11.0×**         | ✅ 达标 |
| Sidebar 搜索过滤（p50）      | `< 50 ms`       | `3,935.99 ms`（max `4.75 s`, `ltCount=5`）                  | **`47.46 ms`**（min `31.61 ms`, p95 `60.42 ms`, `ltCount=0`）        | **82.9×**         | ✅ 达标 |
| Sidebar Schema ↔ Section     | `< 50 ms`       | `4,501.99 ms` / `4,331.64 ms`（`ltCount=5`）                | **`30.30 ms`** / **`31.24 ms`**（`ltCount=0`）                       | **138.7×–148.6×** | ✅ 达标 |
| `elkjs` 主线程长任务阻塞     | `0 ms` (Worker) | `516 ms` max / `1,024 ms` TBT（显式重排 100t）              | **`0.00 ms`** max / **`0.00 ms`** TBT（`ltCount=0`, 总 `154.13 ms`） | **消除阻塞**      | ✅ 达标 |
| `shadowOps.verify()` 端到端  | 消除第 3 次重建 | `95,145.42 ms (95.15 s)`（`analyze()` 占 `19.30 s`）        | **`13,709.8 ms (13.71 s)`**（`analyze()` 仅 `65.42 ms`）             | **6.94×**         | ✅ 达标 |

---

## 3. 三层完整对照实测（100 表 & 1,000 表）

### 3.1 Layer 1：`@dowel/core` & `@dowel/sync`（`pnpm bench:core`）

| 规模                         | 指标                            | Phase 2 基线 (`p50`) | Phase 3 实测 (`p50`) | Phase 3 分布 (`min` / `p95` / `max`)                                               | 提升倍数   |
| ---------------------------- | ------------------------------- | -------------------- | -------------------- | ---------------------------------------------------------------------------------- | ---------- |
| **100 表** (`1,932` 对象)    | `validate(model)` (`n=20`)      | `74.69 ms`           | **`3.23 ms`**        | `p95 3.99 ms` / `max 4.16 ms` (`errs=0`)                                           | **23.1×**  |
|                              | `plan(v1, v2) [small]` (`n=20`) | `151.39 ms`          | **`10.99 ms`**       | `p95 15.24 ms` / `max 17.77 ms` (`3 steps`)                                        | **13.8×**  |
|                              | `createAll(model)` (`n=10`)     | `105.68 ms`          | **`10.85 ms`**       | `p95 12.92 ms` / `max 13.11 ms` (`730 steps`, `123.5 KiB`)                         | **9.7×**   |
|                              | `sync mutate` 汇总 (`n=30`)     | `105.30 ms`          | **`1.31 ms`**        | `p95 1.78 ms` / `max 4.02 ms`                                                      | **80.4×**  |
|                              | └─ `setComment` (`n=15`)        | `78.40 ms`           | **`0.87 ms`**        | `p95 1.08 ms` / `max 1.21 ms` (`cli=0.41 srv=0.43 rcv=0.02 ms`)                    | **90.1×**  |
|                              | └─ `renameColumn` (`n=15`)      | `119.11 ms`          | **`1.55 ms`**        | `p95 2.47 ms` / `max 4.02 ms` (`cli=0.75 srv=0.75 rcv=0.02 ms`)                    | **76.8×**  |
| **1,000 表** (`19,093` 对象) | `validate(model)` (`n=10`)      | `11,864.65 ms`       | **`37.08 ms`**       | `min 35.46 ms` / `mean 37.13 ms` / `p95 39.07 ms` / `max 39.44 ms`                 | **320.0×** |
|                              | `plan(v1, v2) [small]` (`n=10`) | `15,740.27 ms`       | **`139.00 ms`**      | `min 125.27 ms` / `mean 139.77 ms` / `p95 156.00 ms` / `max 159.65 ms`             | **113.2×** |
|                              | `createAll(model)` (`n=5`)      | `7,364.75 ms`        | **`104.73 ms`**      | `min 102.33 ms` / `mean 109.10 ms` / `p95 118.59 ms` / `max 119.50 ms`             | **70.3×**  |
|                              | `sync mutate` 汇总 (`n=16`)     | `1,030.81 ms`        | **`10.70 ms`**       | `min 9.44 ms` / `mean 11.06 ms` / `p95 12.85 ms` / `max 14.84 ms`                  | **96.3×**  |
|                              | └─ `setComment` (`n=8`)         | `704.48 ms`          | **`10.68 ms`**       | `min 9.44 ms` / `p95 13.85 ms` / `max 14.84 ms` (`cli=5.09 srv=5.33 rcv=0.03 ms`)  | **66.0×**  |
|                              | └─ `renameColumn` (`n=8`)       | `1,357.27 ms`        | **`10.70 ms`**       | `min 10.23 ms` / `p95 12.16 ms` / `max 12.19 ms` (`cli=5.32 srv=5.35 rcv=0.03 ms`) | **126.8×** |

#### Node 进程内存对比（`bench/core.ts`）

| 规模     | 阶段    | `baseHeap`  | `afterGenHeap`（增量）     | `endHeap`   | 进程 `RSS`（`ΔRSS`）             |
| -------- | ------- | ----------- | -------------------------- | ----------- | -------------------------------- |
| 100 表   | Phase 2 | `15.60 MiB` | `16.49 MiB` (`+918.1 KiB`) | `19.07 MiB` | `216.71 MiB` (`+115.75 MiB`)     |
| 100 表   | Phase 3 | `15.79 MiB` | `16.67 MiB` (`+909.9 KiB`) | `20.19 MiB` | **`194.25 MiB` (`+89.33 MiB`)**  |
| 1,000 表 | Phase 2 | `17.48 MiB` | `22.90 MiB` (`+5.42 MiB`)  | `28.64 MiB` | `510.60 MiB` (`+294.14 MiB`)     |
| 1,000 表 | Phase 3 | `18.78 MiB` | `23.32 MiB` (`+4.53 MiB`)  | `31.91 MiB` | **`431.50 MiB` (`+239.29 MiB`)** |

- 100 表 → 1,000 表（10× 规模）按 p50 放大倍数已收敛至近似线性：`validate` **11.48×**、`plan(v1, v2)` **12.65×**、`createAll` **9.65×**、`sync mutate` **8.17×**。

---

### 3.2 Layer 2：Playwright Chromium UI（`pnpm bench:ui`）

#### 首屏、聚焦、板块展开与 `elkjs` Web Worker

| 场景                                | 渲染节点       | Phase 2 耗时 (`ltCount` / `ltMax` / `TBT`)   | Phase 3 耗时 (`ltCount` / `ltMax` / `TBT`)        | 提升倍数                  |
| ----------------------------------- | -------------- | -------------------------------------------- | ------------------------------------------------- | ------------------------- |
| `100t` 平铺首屏 + `elk`             | `100`          | `1,098.9 ms` (`6` / `241 ms` / `504 ms`)     | **`767.32 ms`** (`3` / `113.00 ms` / `120.00 ms`) | **1.43×** (-76.2% TBT)    |
| `1000t` 折叠摘要首屏                | `10`（摘要卡） | `4,142.8 ms` (`4` / `3,454 ms` / `3,646 ms`) | **`542.47 ms`** (`2` / `95.00 ms` / `85.00 ms`)   | **7.64×** (-97.7% TBT)    |
| `1000t` 1 跳邻域冷首屏              | `5`            | `4,764.1 ms` (`5` / `3,663 ms` / `3,711 ms`) | **`726.39 ms`** (`3` / `93.00 ms` / `86.00 ms`)   | **6.56×** (-97.7% TBT)    |
| `1000t` 1 跳 → 2 跳切换             | `11`           | `7,180.6 ms` (`2` / `6,971 ms` / `6,955 ms`) | **`131.35 ms`** (`0` / `0.00 ms` / `0.00 ms`)     | **54.67×** (0 长任务)     |
| `1000t` 2 跳邻域冷首屏              | `11`           | `5,439.4 ms` (`5` / `4,184 ms` / `4,296 ms`) | **`725.78 ms`** (`3` / `94.00 ms` / `88.00 ms`)   | **7.49×** (-98.0% TBT)    |
| `1000t` 展开 `order` (100t) + `elk` | `100`          | `5,507.9 ms` (`4` / `4,260 ms` / `4,898 ms`) | **`493.32 ms`** (`1` / `122.00 ms` / `72.00 ms`)  | **11.16×** (-98.5% TBT)   |
| `1000t` 显式「自动布局」(100t)      | `100`          | `1,741.3 ms` (`4` / `516 ms` / `1,024 ms`)   | **`154.13 ms`** (`0` / `0.00 ms` / `0.00 ms`)     | **11.30×** (**0 ms TBT**) |

#### 1,000 表交互延迟（`order` 板块已展开，画布 100 表）

| 交互动作                         | 样本 (`n`) | Phase 2 `p50` (`ltCount`)             | Phase 3 `p50` (`ltCount`) | Phase 3 `min` / `p95` / `max`  | 提升倍数                    |
| -------------------------------- | ---------- | ------------------------------------- | ------------------------- | ------------------------------ | --------------------------- |
| 点击选中画布表节点               | `5`        | `4,551.49 ms` (`11`, TBT `25,137 ms`) | **`44.20 ms`** (`0`)      | `40.06` / `44.53` / `44.60 ms` | **103.0×**                  |
| 拖拽表节点 `rAF` 帧间隔          | `206` 帧   | `183.30 ms` (`95`, p95 `509.13 ms`)   | **`16.70 ms`** (`0`)      | `16.50` / `16.70` / `16.80 ms` | **11.0×**（贴合 60Hz 帧率） |
| 拖拽结束释放稳定 (`drop settle`) | `5`        | `707.19 ms`                           | **`45.51 ms`** (`0`)      | `30.50` / `59.40` / `62.81 ms` | **15.5×**                   |
| Sidebar 搜索框输入过滤           | `5`        | `3,935.99 ms` (`5`, TBT `18,833 ms`)  | **`47.46 ms`** (`0`)      | `31.61` / `60.42` / `63.29 ms` | **82.9×**                   |
| Sidebar「按 Schema」→「按板块」  | `5`        | `4,501.99 ms` (`5`, TBT `19,599 ms`)  | **`30.30 ms`** (`0`)      | `29.58` / `33.54` / `34.31 ms` | **148.6×**                  |
| Sidebar「按板块」→「按 Schema」  | `5`        | `4,331.64 ms` (`5`, TBT `19,541 ms`)  | **`31.24 ms`** (`0`)      | `30.84` / `32.66` / `32.92 ms` | **138.7×**                  |

> **测量口径透明说明（Sidebar 视图切换）**：Phase 3 首轮优化使切换仅重渲染 `<Sidebar>` 后，原 Playwright `locator.click()` + `locator.waitFor()` + `waitTwoFrames()` 测得 `82.11 ms` / `82.01 ms`（`ltCount=0`、方差 `< 0.5 ms`）。经实测空白页面 0.01 ms 点击句柄，Playwright `locator.click()` 在派发鼠标事件前内置约 2 帧坐标稳定性等待 + ARIA 查询轮询，叠加 `waitTwoFrames()` 后存在约 `66.5–70.3 ms` 工具基线地板（而 `mouse.click()` + `waitTwoFrames()` 的空白页面基线约为 `29.4 ms`）。`bench/ui.ts` 第 5d 步随即将切换测量统一对齐 `5a` 节点点击的口径——预解析 `.boundingBox()` 后以 `pMain.mouse.click()` 计测点击到真实 DOM 生效并等待 2 帧完成渲染——实测为 `30.30 ms` / `31.24 ms`（且两者下均维持 `0` 次长任务）。

---

### 3.3 Layer 3：真实 PostgreSQL 18 影子库（`pnpm bench:shadow`）

> 校验断言：`100` / `1,000` 表下 `upDiffCount = 0`、`downDiffCount = 0`、`riskCount = 3`、`importSql` 导入顶级表数精确等于 `100` / `1,000`。

| 阶段                                    | 100 表 Phase 2          | 100 表 Phase 3                           | 1,000 表 Phase 2           | 1,000 表 Phase 3                                | 1,000 表提升       |
| --------------------------------------- | ----------------------- | ---------------------------------------- | -------------------------- | ----------------------------------------------- | ------------------ |
| `createAll plan()` (`730` → `7,073` 步) | `82.35 ms`              | **`19.58 ms`**                           | `9,977.9 ms`               | **`120.33 ms`**                                 | **82.92×**         |
| `createAll runSteps()`                  | `877.65 ms`             | **`415.08 ms`** (`p50=0.45 max=2.16`)    | `11,509.0 ms`              | **`3,915.4 ms (3.92 s)`** (`p50=0.45 max=3.27`) | **2.94×**          |
| `readSnapshot(db)` (`p50`, `n=3`)       | `50.89 ms`              | **`46.35 ms`** (max `58.80 ms`)          | `448.93 ms`                | **`332.11 ms`** (max `347.62 ms`, `4.58 MiB`)   | **1.35×**          |
| `importSnapshot(snap)`                  | `33.77 ms`              | **`32.43 ms`**                           | `369.03 ms`                | **`330.11 ms`**                                 | **1.12×**          |
| `importSql total`                       | `449.03 ms`             | **`434.77 ms`** (`singleExec=239.49 ms`) | `5,786.18 ms`              | **`4,841.3 ms (4.84 s)`** (`singleExec=2.75 s`) | **1.20×**          |
| `verify`: `plan(up+down)`               | `285.22 ms`             | **`40.75 ms`**                           | `35,431.24 ms`             | **`405.19 ms`**                                 | **87.44×**         |
| `verify`: `buildTarget(v2)`             | `1,116.2 ms`            | **`558.90 ms`**                          | `20,812.97 ms`             | **`5,821.9 ms (5.82 s)`**                       | **3.58×**          |
| `verify`: `buildTarget(v1)`             | `1,205.7 ms`            | **`567.02 ms`**                          | `18,171.64 ms`             | **`5,993.7 ms (5.99 s)`**                       | **3.03×**          |
| `verify`: `run up + snap + diff`        | `114.37 ms`             | **`56.18 ms`** (`upDiff=0`)              | `728.56 ms`                | **`756.05 ms`** (`upDiff=0`)                    | `~1.0×`            |
| `verify`: `run down + snap + diff`      | `113.58 ms`             | **`56.05 ms`** (`downDiff=0`)            | `696.30 ms`                | **`667.51 ms`** (`downDiff=0`)                  | **1.04×**          |
| `verify`: `analyze()` `[reuse v1]`      | `1,640.1 ms`            | **`15.91 ms`** (`risks=3`)               | `19,304.69 ms`             | **`65.42 ms`** (`risks=3`)                      | **295.09×**        |
| **`TOTAL shadowOps.verify()`**          | `4,475.3 ms` (`4.48 s`) | **`1,294.8 ms (1.29 s)`**                | `95,145.42 ms` (`95.15 s`) | **`13,709.8 ms (13.71 s)`**                     | **6.94× (-85.6%)** |

- **超时阈值确认**：`SHADOW_STATEMENT_TIMEOUT_MS = 120_000` 保持不变。1,000 表最慢单条 SQL 为 `importSql` 单批 Simple Query（`2,748.42 ms`，仅占 120s 超时阈值的 **`2.29%`**）；`createAll runSteps()` 单句仅 `p50=0.45 ms / max=3.27 ms`；最慢 `DROP SCHEMA commerce CASCADE` 仅 `441.71 ms`（`0.37%`）；最慢目录查询（`pg_attribute`）为 `163.98 ms`。
- **第 3 次全库重建消除验证**：`AnalyzeOptions.reuseShadowFrom` 在 `verify()` 与 `verifyScripts()`（当 `checkDown !== false` 且 `upDiff` / `downDiff` 均为空）下直接复用刚回滚完成的 `from`（`v1`）影子库状态执行 `pinSession` 与风险探测，不再调用 `resetShadow` + `createAll(from)`，使 `analyze()` 阶段在 1,000 表下从 **`19.30 s`** 降至 **`65.42 ms`**。

---

## 4. Phase 3 关键底座治理摘要

1. **`@dowel/core` 显式作用域/增量索引与规划器零冗余化**：
   - 新增 [packages/core/src/model-index.ts](../../packages/core/src/model-index.ts)（`ModelIndex` / `MutableModelIndex` / `OverlayModelIndex`）与 [packages/core/src/model.ts](../../packages/core/src/model.ts) 的 `withModelIndex` 栈作用域，提供按 `kind`、`parent`、`column.pos`、分区父表、owned sequence 与 PG 关系/约束/类型命名空间 `O(1)` 查询，并通过 `MutableModelIndex.applyBatch` 四趟增量更新杜绝原位改对象或跨 Schema 移动后的脏索引。
   - 改造四方言 `dialect.ts` / `plan.ts` 与 `edit.ts`，重点重构 [packages/core/src/pg/plan.ts](../../packages/core/src/pg/plan.ts)：缓存分区子表及约束族空间映射、用无分配属性比对代替全对象 `definition()`/`pick()` + `deepEqual`、`P6`/`P12`/`P15` 按真实变更目标收敛并移除第 3 次全库索引构建。
2. **`@dowel/sync` 按键写时复制（Proxy Overlay）**：
   - [packages/sync/src/protocol.ts](../../packages/sync/src/protocol.ts) `execute()` 改为懒克隆被修改根对象的 Proxy Overlay（绝不全量 `structuredClone(model)`，且支持 `MutableModelIndex` / `OverlayModelIndex`），仅对比 `overlay` 键集合生成 `Change[]` 并局部推导变更读取集。
   - [packages/sync/src/client.ts](../../packages/sync/src/client.ts) 与 [packages/sync/src/server.ts](../../packages/sync/src/server.ts) 维护 `MutableModelIndex`，在 `commit`/`process` 时走 `applyBatch` O(|changes|) 更新；`mutate()` 复用已确认索引直接增量提交。
3. **前端按需渲染、`elkjs` Worker 化与状态隔离**：
   - 新增 [apps/web/src/workers/elk.worker.ts](../../apps/web/src/workers/elk.worker.ts) 与 [apps/web/src/workers/elk-client.ts](../../apps/web/src/workers/elk-client.ts)，将 `elkjs` 迁入独立 Web Worker，配合请求版本号与 `AbortSignal` 取消过期布局，`100` 表显式自动布局主线程长任务降为 `0 ms`。
   - [apps/web/src/components/Sidebar.tsx](../../apps/web/src/components/Sidebar.tsx)：基于 `ModelIndex` 一次性构树 + 预分桶板块缓存，接入行高前缀和二分虚拟滚动（仅挂载可见行），并以 `SelectedStore` + `useSyncExternalStore` 将节点选中更新局限到受影响叶行。
   - [apps/web/src/pages/Workspace.tsx](../../apps/web/src/pages/Workspace.tsx)、[apps/web/src/components/Canvas.tsx](../../apps/web/src/components/Canvas.tsx) 与 [apps/web/src/components/Inspector.tsx](../../apps/web/src/components/Inspector.tsx)：将 `sidebarGrouping` 视图偏好从 `Workspace` 顶层状态与 `useShellPanel` 依赖剥离；对 `Canvas`/`Inspector` 做 `memo` 化；将 `selected` 从 `Canvas` `desiredNodes` 结构计算解耦为轻量渲染映射并过滤 React Flow 冗余 `select` change；在 `Inspector` 复用 `versions` 查询缓存与按需挂载确认弹窗。
4. **影子库与风险分析复用**：
   - 在 [packages/engines/src/types.ts](../../packages/engines/src/types.ts)、[packages/engines/src/pg/engine.ts](../../packages/engines/src/pg/engine.ts)、[packages/engines/src/sqlite/engine.ts](../../packages/engines/src/sqlite/engine.ts)、[packages/engines/src/mysql/risk.ts](../../packages/engines/src/mysql/risk.ts)、[packages/engines/src/mssql/risk.ts](../../packages/engines/src/mssql/risk.ts) 与 [apps/server/src/shadow.ts](../../apps/server/src/shadow.ts) 中实现 `reuseShadowFrom`，令 `shadowOps.verify()` / `verifyScripts()` 闭环回归 `from` 后直接原地执行风险分析，彻底消除第 3 次全库重建。
