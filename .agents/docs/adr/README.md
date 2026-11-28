# 架构决策记录（ADR）

本目录按**领域**组织架构决策：每个文件是一个领域当前有效的完整决定，不再按时间逐条追加。开始一项任务前先看下面的总览表，分清哪些决定**已生效**（描述当前 `main`）、哪些**已拍板待实现**（尚不代表当前代码行为）。

## 总览

| 文件                                                                         | 领域                   | 当前决定（一句话）                                                                                                     | 状态                                   | 相关 Issue / PR              |
| ---------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------- |
| [01-org-and-deployment.md](01-org-and-deployment.md)                         | 组织与部署             | 一个实例一家公司、用组承载归属；HA 只靠平台 PostgreSQL 多活，不引入 Redis，限流按副本本地计数                          | 已生效（Implemented）                  | P7                           |
| [02-version-chain-and-recovery.md](02-version-chain-and-recovery.md)         | 版本链与恢复           | 发布时冻结、沿链执行；目标库存完整版本；链尾作废代替模型分支；漂移两个出口 + `mark`；接手 / 接入严格验证               | 已生效（Implemented）                  | #123、#132、#159             |
| [03-execution-governance.md](03-execution-governance.md)                     | 执行治理               | 四层策略单调收紧、放宽是特权操作；审批按快照走、不给执行权、不能自批；申请绑定在三处判定、以目标库历史为准             | 已生效（Implemented）                  | P5a、P5b                     |
| [04-webhooks.md](04-webhooks.md)                                             | Webhook 出站           | 独立允许列表、默认只放行公网、连接时检查、不跟随重定向、有限重试、平台库持久化队列（至少一次）                         | 已生效（Implemented）                  | P5b、P7 HA3                  |
| [05-ci-tokens-and-api.md](05-ci-tokens-and-api.md)                           | CI 令牌与 API          | SHA-256 存储、只能访问 `/api/ci`、不能回滚、同步执行契约、按版本号的 `verifiedOn` / `verifiedHere`、三层取与的创建规则 | 已生效（Implemented）                  | P6、#204                     |
| [06-mcp-and-canvas-editing.md](06-mcp-and-canvas-editing.md)                 | MCP 与画布编辑         | 个人 MCP 令牌、正交 scope、绝不连目标库、不能发布 / 执行；复合宏 + `batch` 单条原子历史；人类编辑读时归组              | 已生效（Implemented）                  | M3-C、#117、#119～#122       |
| [07-normalization-and-verification.md](07-normalization-and-verification.md) | 规范化与验证           | 编辑期零影子库 I/O、关键出口按需规范化；发布 = 规范化 → 闭环验证 → 冻结；严格读回核对；按数据库完整版本号把关执行      | 已生效（Implemented）                  | #132、#162、#194、#205、#209 |
| [08-dialect-fidelity.md](08-dialect-fidelity.md)                             | 方言保真               | 按引擎真实语义建模：SQLite 类型按声明保留；SQL Server 持久化计算列显式 / 推断非空分开存                                | 已生效（Implemented）                  | #140、#141、#161             |
| [09-per-version-readback-truth.md](09-per-version-readback-truth.md)         | 多数据库版本的读回真相 | 外部影子库方言闭环一致即通过，按完整版本号记录读回差异，执行 / 漂移 / 标记用有效模型比较                               | 已拍板待实现（Pending Implementation） | #201                         |

## 治理规则

### 状态

| 状态                                   | 含义                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| 已生效（Implemented）                  | 已在当前 `main` 实现；文中描述的就是当前行为                                   |
| 已拍板待实现（Pending Implementation） | 决定已确定，代码尚未实现；**永远不代表当前 `main` 的行为**                     |
| 已部分修订（Amended）                  | 部分条款被后来的决定修改；被修改的条款已在原处改写或删除线标注，并指向修订来源 |
| 已作废（Superseded）                   | 整体被另一份 ADR 取代；文件只保留指向取代者的说明                              |

### 规则

1. **待实现的 ADR 不代表当前行为。** `GLOSSARY.md`、`docs/`、`.agents/skills/pitfalls/` 与 [02-consensus.md](../02-consensus.md) 只描述已实现的行为，与实现 PR 一起更新；实现 PR 同时把对应 ADR 的状态改为“已生效”，或把它的决定并入对应的领域 ADR。
2. **ADR 记录持久的东西**：原则、边界、取舍、被否决的方案与重审触发条件。不记易变的函数名 / 行号、审查轮次的过程记录或界面文案细节；实现细节放 [05-implementation.md](../05-implementation.md)，反模式与并发细节放 `pitfalls/`。
3. **修订就地改写。** 修改一项决定时，在原条款处改写（或用删除线标注并写明修订来源与日期），不在文件末尾堆叠脚注、让过期正文原样留着。
4. **每份 ADR 带标准头部**：状态、领域 / 范围、合并自（原 ADR 编号与关键 Issue / PR）、重审触发条件。
5. **新决定**优先写进对应领域的文件；确实跨领域或尚未实现时才新建编号文件，并加入上面的总览表与下面的映射表。

## 历史编号映射

代码、测试与旧文档里的 `ADR 00XX` 引用（含“决定 N”“第 N 节 / 条”）按下表对应到新文件。原文件已删除，旧文件名列在第二列便于检索。

| 原编号   | 原文件（已删除）                                   | 新位置                                                                                                                                                                     |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR 0001 | `0001-single-company-groups`                       | [01](01-org-and-deployment.md) 第 1 节                                                                                                                                     |
| ADR 0002 | `0002-frozen-migration-chain`                      | [02](02-version-chain-and-recovery.md) 第 1 节                                                                                                                             |
| ADR 0003 | `0003-version-content-in-target-db`                | [02](02-version-chain-and-recovery.md) 第 2 节                                                                                                                             |
| ADR 0004 | `0004-drift-resolution-by-mark-as-applied`         | [02](02-version-chain-and-recovery.md) 第 3 节（含原 0013 对 `mark` 的修订、#159 后的隐式基线）                                                                            |
| ADR 0005 | `0005-execution-policy-layers`                     | [03](03-execution-governance.md) 第 1 节（标量全序 1.1、审批流程偏序 1.2、超时与 `lock_timeout` 豁免 1.3、放宽是特权操作 1.4、原子写入 1.5、执行者授权 1.6、存储 1.7）     |
| ADR 0006 | `0006-approval-snapshot-and-execution-right`       | [03](03-execution-governance.md) 第 2 节（放宽不走审批在 1.4、锁在 2.7）                                                                                                   |
| ADR 0007 | `0007-request-invalidation`                        | [03](03-execution-governance.md) 第 3 节（申请有效期在 1.1）                                                                                                               |
| ADR 0008 | `0008-webhook-outbound`                            | [04](04-webhooks.md) 全文（队列已改为第 5 节的持久化队列）                                                                                                                 |
| ADR 0009 | `0009-ci-tokens-and-api`                           | [05](05-ci-tokens-and-api.md) 第 1～7 节                                                                                                                                   |
| ADR 0010 | `0010-token-creator-policy`                        | [05](05-ci-tokens-and-api.md) 第 8～10 节                                                                                                                                  |
| ADR 0011 | `0011-ha-postgres-only`                            | [01](01-org-and-deployment.md) 第 2 节；Webhook 持久化队列见 [04](04-webhooks.md) 第 5 节                                                                                  |
| ADR 0012 | `0012-strict-verify-on-restore`                    | [02](02-version-chain-and-recovery.md) 第 5 节                                                                                                                             |
| ADR 0013 | `0013-retire-tail-version-instead-of-branches`     | [02](02-version-chain-and-recovery.md) 第 4 节（原第 1 节 → 4.1～4.3；原第 2 节“复制粘贴” → 4.4；对 `mark` 的修订 → 第 3 节）                                              |
| ADR 0014 | `0014-mcp-tokens-and-boundaries`                   | [06](06-mcp-and-canvas-editing.md) 第 1～6 节（原第 1 条 → 1，2 → 2，3 → 3、4，4 → 4，5 → 5，6 → 6）                                                                       |
| ADR 0015 | `0015-mcp-canvas-editing-and-history-grouping`     | [06](06-mcp-and-canvas-editing.md) 第 7～12 节（原第 1 → 7，第 2 → 8，第 3 → 9，第 4 → 10，第 5 → 11，第 6 → 12）                                                          |
| ADR 0016 | `0016-on-demand-shadow-normalization`              | [07](07-normalization-and-verification.md)（决定 1～3 → 第 1 节，决定 4 → 第 2 节，决定 5 → 第 3 节，决定 6 → 第 4 节，决定 7 → 第 5 节，“影响与边界” → 第 10 节与“影响”） |
| ADR 0017 | `0017-verified-means-executable`                   | [07](07-normalization-and-verification.md)（决定 1、3 → 第 6 节，决定 2、4 → 第 7 节，决定 5 → 第 8 节，决定 6 → 第 9 节）                                                 |
| ADR 0018 | `0018-sqlite-type-fidelity`                        | [08](08-dialect-fidelity.md) 第 1 节（决定 N → 第 1 节第 N 条）                                                                                                            |
| ADR 0019 | `0019-mssql-explicit-vs-inferred-not-null`         | [08](08-dialect-fidelity.md) 第 2 节（决定 N → 第 2 节第 N 条）；待规范化判定另见 [07](07-normalization-and-verification.md) 第 3 节                                       |
| ADR 0020 | `0020-per-version-readback-truth`（未合入 `main`） | [09](09-per-version-readback-truth.md)（决定 N → 决定 N；已拍板待实现）                                                                                                    |
