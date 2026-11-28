# 按数据库完整版本号分别记录闭环读回差异，以各版本真实结构为真相

2026-11-28 决定（[Issue #201](https://github.com/eimsound/dowel/issues/201)；部分修订 [ADR 0017](0017-verified-means-executable.md)、[ADR 0016](0016-on-demand-shadow-normalization.md) 与 [ADR 0012](0012-strict-verify-on-restore.md)，补充 [ADR 0003](0003-version-content-in-target-db.md)；待后续实现 PR 落地）。

## 背景

在 [ADR 0016](0016-on-demand-shadow-normalization.md) 与 [ADR 0017](0017-verified-means-executable.md)（PR #194、PR #205）之后，Dowel 的工作副本规范化与发布验证分别运行在两套选影粒度上：

- **按需规范化**（`OpaqueRefresher`）只在 `Shadows.forProjectTarget` 选出的**单一影子库**（优先最低已知版本组，拿到首个可用影子库即返回）上执行，将表达式、默认值、不透明对象 DDL 等写回工作副本，形成单份基准模型；
- **发布与重新验证**（`verifyOnShadows` → `forProjectEngineVersions`）会在项目环境的**每一个数据库完整版本号**对应的影子库上执行闭环验证与读回核对（`readbackDiff`），执行与漂移检查复用同一套 `diffAgainst` 严格比较。

因为一个版本只冻结单一的 `v.model`（[ADR 0002](0002-frozen-migration-chain.md)），当同一项目下存在不同版本的环境（例如 PG 15 与 PG 18、MySQL 8.4 与 9.7、SQL Server 2019 与 2025），且不同数据库版本对同一表达式、视图、函数或约束的系统目录反解析写法存在差异时，单一基准 `v.model` 无法同时等于两种读回文本：

1. 非规范化那一侧（如 PG 18）会稳定触发 `readback_mismatch`；原错误提示（`routes/versions.ts` 与 `i18n.ts`）又引导用户“按数据库读回一列修改模型后重试”，用户照改后下次发布会被规范化侧或另一版本再次打回，形成死循环。
2. 当项目原地完成全量大版本升级（例如所有环境从 PG 15 升至 PG 18）后，已发布的旧对象若在工作副本里保持未动，仍带着旧版本的规范写法；强求“规范化同版本零差异”或全量重刷都会卡死后续版本发布或为未改动历史对象制造多余的重建迁移。

## 原则

- **以真相为主，按完整版本号分别记录差异。** 各数据库完整版本在影子库闭环执行后实测读回的结构就是该版本的真实结构；不靠读回层的模糊或纯格式容忍抹平差异，也不强求不同数据库版本反解析文本完全一致，而是在单一基准模型之上按数据库完整版本号分别记录增量差异。
- **不考虑旧数据兼容**（同 ADR 0017）。Dowel 尚未公开发布，平台库与目标库历史表结构直接演进，不做存量数据兼容迁移。

## 决定

1. **验证门禁与读回真相记录（外部影子库方言 vs SQLite）**
   - **PostgreSQL、MySQL、SQL Server 等使用外部影子库的方言**：以影子库闭环一致性（`upDiff` 与 `downDiff` 均为空）作为验证通过的门禁，**不设硬编码的“可差异字段白名单”**。闭环验证通过后，按版本冻结的 `scope` 读回升级后与回滚后的真实结构并对齐对象 ID，将相对基准 `v.model` 的全部差异如实记录为该数据库完整版本号的增量差异（无差异时不写记录）。
   - **SQLite**：使用单一内置 `:memory:` 影子库，不存在跨版本引擎反解析分歧，继续维持严格零差异读回核对（发现任意差异仍报 `readback_mismatch` 拒绝）。
   - **写入层与规范化防线**：[ADR 0017](0017-verified-means-executable.md) 决定 6 的写入层规范化继续由各写入入口与单测 / 集成测试（断言同版本零差异）守门；服务端在闭环验证期间，**仅当与规范化所用影子库相同的完整版本号**仍产生非空读回差异时记录 `console.warn` 告警日志便于排查，不阻断正常跨版本或大版本升级后的发布流程。

2. **平台库独立增量表 `version_engine_diffs`**
   - 将按数据库完整版本号记录的模型读回差异从不可变版本正文及 `versions.verify_report` 中解耦，在平台库新增独立增量表 `version_engine_diffs`：主键为 `(version_id, engine_version)`，存储相对基准 `v.model` 的增量差异 `diff` 与记录时间 `recorded_at`，外键关联 `versions(id) ON DELETE CASCADE`；稀疏存储，无差异时不存行。
   - **零侵入冻结基线与验证记录**：记录或更新增量差异绝不改写已冻结的 `versions.model`，也不改变 `versions.verify_report.records` 的验证通过状态。
   - **升级与回滚双向采集**：闭环验证 `vN`（`from → to`）在数据库完整版本号 `E` 上通过时：
     - `up` 方向读回相对 `to.model` 的差异写入 `(vN.id, E)`；
     - `down` 方向读回相对父版本 `from.model` 的差异：若 `(from.id, E)` 已存在记录则核对两者一致；若尚不存在（例如项目先在 PG 15 发布 `v1`，新增 PG 18 后直接发布 `v2`），按需将 `from` 在 `E` 的差异写入 `(from.id, E)`，且**绝不**因此将父版本 `from` 标记为在 `E` 上已验证（父版本自身的迁移脚本仍须经过专门的重新验证通过后才可执行）。
   - 链上最新且尚未在任何环境执行过的版本在人工编辑冻结脚本并清空验证记录时，同步清理该版本的 `version_engine_diffs` 记录。

3. **统一有效模型合成与全链路消费**
   - 定义纯函数 `effectiveModel(version, engineVersion)`：将 `version_engine_diffs[(version.id, engineVersion)]` 叠加到基准 `version.model` 上得到该数据库完整版本号对应的有效模型；无差异记录时直接返回基准 `version.model`。
   - **执行读回校验（`verifyAndRecord`）、漂移检测（`checkDrift`）、标记为已执行（`markApplied`）与修复脚本（`repair-script`）** 统一改用 `effectiveModel(version, targetEngineVersion)` 与目标库实测快照执行严格 `diffAgainst` 比对，不引入任何近似或格式容忍。
   - **缺失当前版本差异记录时的回退**：当目标库处于某个尚未采集过读回差异的完整版本号时（例如目标库原地大版本升级后尚未重检），`checkDrift`、`markApplied` 与 `repair-script` 回退使用基准 `v.model` 比对，绝不在只读或标记路径上自动连接影子库或猜测未验证版本；若因此报出漂移或 `mark_mismatch` 且该版本尚未在该目标库完整版本号上验证通过，在提示文案中引导用户“若目标库刚升级过数据库版本，请先到版本详情页对该版本执行‘重新验证’以采集新版本的读回真相”。

4. **目标库迁移历史 `dowel.versions`（[ADR 0003](0003-version-content-in-target-db.md)）存基准 + 本库差异**
   - 四种方言的目标库历史表 `dowel.versions`（PostgreSQL / SQL Server）与 `dowel_versions`（MySQL / SQLite）直接新增 `engine_version` 与 `version_diff` 两列（`dowel.versions` 无只追加触发器；按不考虑旧数据兼容原则直接调整建表定义）。
   - `model` 列在所有目标库继续统一存基准 `v.model`；`engine_version` 记录写入该版本行时的目标库完整版本号；`version_diff` 记录该版本号对应的增量差异（与平台库 `version_engine_diffs.diff` 结构一致，无差异存 `null`）；`fingerprint` 继续存该库实测快照哈希。
   - **多环境接手合并无冲突**：[`mergeHistories`](../../../packages/executor/src/merge.ts) 照常严格校验各来源环境同名版本的基准 `model`、`checksum`、`up_steps`、`down_steps`、`scope` 完全一致，保留完整的防篡改能力；各环境各自记录的 `(engine_version, version_diff)` 按版本号汇总收集，互不冲突。

5. **接手与接入领先环境的多完整版本影子库验证（补充 [ADR 0012](0012-strict-verify-on-restore.md)）**
   - 将 `verifyVersionChain` 从单影子库（`pickShadow`）升级为按参与环境中所有不同数据库完整版本号逐组挑选可用影子库执行闭环验证（与发布、重新验证的 `forProjectEngineVersions` 逻辑对齐），并将各个完整版本实测得到的增量差异写入新平台库的 `version_engine_diffs`（以及补充汇总目标库历史自带的差异）。
   - 若接手或接入时某些参与环境的数据库完整版本号暂缺可用影子库，对应环境照常标为未覆盖，待配置同版本影子库并在版本详情页点“重新验证”后补采；在此之前，目标库只要未发生手工篡改，其自身记录的 `fingerprint` 仍可保证日常漂移检查不误报。

6. **画布按需规范化保持单影子库，补齐 SQL Server 最低主版本选影**
   - 工作副本按需规范化（`OpaqueRefresher`）的职责是为工作副本产出一份基准规范写法，保持 `Shadows.forProjectTarget` 单影子库（按版本组升序、优先最低已知版本组、拿到首个可用影子库即返回）不变，不为规范化引入多影子库并发连接开销。
   - 补齐 SQL Server（`packages/core/src/mssql/versioning.ts`）的 `versioning.matrix` 分组与按最低主版本（2019 < 2022 < 2025）优先排序，使其单影子库选影行为与 PostgreSQL、MySQL 保持一致。

7. **界面透明展示（“数据库版本差异”）**
   - 在版本详情页与迁移预览验证报告中，当某个数据库完整版本号闭环验证通过且记录了非空增量差异时，以中性、直白的“数据库版本差异”进行展示（如“有 N 处数据库版本差异”），支持展开对照对象、属性、基准模型值与该数据库版本实测读回值；不报错、不阻断发布。

8. **增量差异数据格式与规划器边界**
   - 增量差异按稳定对象 ID 记录相对基准 `v.model` 发生变化的字段值（及必要的对象级增量差异），平台库 `version_engine_diffs.diff` 与目标库 `dowel.versions.version_diff` 共用同一结构。
   - 迁移规划 `plan(from, to)`、版本 `canvas-diff` 与画布编辑始终基于基准 `v.model` 计算，确保跨版本环境验证或全量原地大版本升级后，未发生业务变更的历史对象不会产生多余的 `DROP/ADD` 迁移步骤。

## Considered Options

- **坚持单一模型同源一致（跨版本回显分歧时在发布阶段拒发并提示改写）**：保住了单模型简单性，但对于由数据库引擎内部反解析规则改版导致的不可避免写法差异（用户无法通过改写 SQL 使其在两个大版本上回显相同），会彻底阻断多版本混部窗口的发布与旧版本重检。
- **在 `readbackDiff` / `diffAgainst` 恢复纯格式或词法容忍**：直接破坏 [ADR 0017](0017-verified-means-executable.md) 核心原则（刚刚在 PR #162 移除 MySQL 表达式纯格式容忍），会重新掩盖规范化漏刷与写入层缺陷。
- **硬编码“可差异派生字段白名单” + 要求规范化同版本必须零差异**：白名单难以覆盖 PG 17/18 非显式 `NOT NULL`、域约束等跨版本目录演进；且当项目全部环境原地升到新大版本后，工作副本中未改动的旧对象仍带旧版规范写法，要求“规范化同版本零差异”会卡死下一版本发布。
- **按每个数据库完整版本号保存一份完整 `Model` 快照**：查询时无需合成函数，但会在多版本项目中使平台库版本存储体积成倍膨胀，且无法直接向用户展示“该版本具体差了哪几处”。
- **不建独立增量表，而在 `versions.verify_report.records` 里同时塞 `up` / `down` 覆写，或发布时反向更新父版本 `verify_report`**：要么让数据结构背负别扭的双份 `up`/`down` 覆写，要么打破“发布新版本不修改已冻结父版本行”的清晰边界，并发锁和半状态处理均不如独立表 `version_engine_diffs` 干净。
- **目标库 `dowel.versions.model` 各自直接存本库版本的有效模型**：单看单个目标库时直观，但会直接破坏多环境接手合并（`mergeHistories` 无法分辨“合法的跨版本差异”与“历史模型被篡改”）。
- **漂移检测 / 标记为已执行缺当前版本差异记录时现场连影子库采集**：能消除原地大版本升级后首次检查的临时提示，但会打破漂移检测“不连影子库、不写版本数据”的只读边界，拖慢状态查询并引入影子库限速复杂度。

## 影响与边界

- **零额外存储膨胀**：单版本项目或跨版本回显完全一致的对象在 `version_engine_diffs` 中不产生行，在目标库 `dowel.versions.version_diff` 中为 `null`。
- **多版本混部与大版本升级畅通**：跨大版本混部环境（如 PG 15 与 PG 18 共存）及单环境原地大版本升级后发布的迁移，只要闭环一致通过即可正常发布，并在各版本目标库上以对应的真实有效模型通过执行读回校验。
- **接手黄金基线不变量（#123）保持有效**：工作副本与黄金基线仍统一围绕基准 `v.model`，接手与接入领先环境通过多版本影子库闭环验证保证基准模型与冻结脚本的严格一致性。
- **文档与后续实现**：[GLOSSARY.md](../../../GLOSSARY.md)、[ADR 0012](0012-strict-verify-on-restore.md)、[ADR 0016](0016-on-demand-shadow-normalization.md)、[ADR 0017](0017-verified-means-executable.md) 与踩坑指南已先期对齐；用户文档（`docs/zh/` 与 `docs/en/`）随后续代码实现 PR 一并更新，以免上线前文档超前于行为。
