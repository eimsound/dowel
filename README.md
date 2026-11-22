# Dowel

Dowel 是开源、可自托管、支持多人实时协作的数据库 schema 建模与迁移平台，当前目标库支持 PostgreSQL（15–19）、SQLite、MySQL（8.4 / 9.7）与 SQL Server（2019 / 2022 / 2025）。

## 核心特点

- **按稳定对象 ID 生成迁移**：每个表、列、约束、索引都有独立 ID。改表名或改列名生成 `RENAME`（SQL Server 生成 `sp_rename`），推导的约束名、索引名和表达式引用同步更新。
- **真实影子库闭环验证与实测风险**：发布版本时冻结升级与回滚脚本，并在影子库实测升级后结构与目标版本一致、回滚后回到起点（SQLite 使用内置 `:memory:` 影子库，PostgreSQL / MySQL / SQL Server 默认使用同实例 `{原库名}_dowel` 或显式配置的独立影子库），同时实测锁类型与整表重写风险。
- **多方言与版本能力检查**：按项目全部环境的最低目标版本静态检查不兼容语法与类型，并在多版本环境混部时按版本组分别验证；支持 PostgreSQL 分区表编辑与 SQLite 12 步表重建。
- **托管执行、漂移检测与可接手历史**：目标库中的 `dowel` schema（SQLite / MySQL 为同库 `dowel_` 前缀表）保存完整模型与冻结脚本，支持执行预演、非事务或隐式提交 DDL 的断点续跑、漂移修复脚本与“标记为已执行”；即使平台库丢失，也能从目标库接手恢复整条版本链。
- **协作治理与 CI 集成**：支持实例 → 组 → 项目 → 环境四层执行策略（逐层只收紧不放宽）、多环节审批流程与紧急执行、组级 Webhook（通用 JSON、钉钉、飞书、企业微信、Slack），以及只读加向前执行的 CI HTTP API 与内置 `actions/execute` 脚本。
- **单容器与无 Redis 高可用**：默认内置 SQLite 平台库，单容器即可运行；将 `DOWEL_DB` 切换为外部 PostgreSQL 即可启动多个无状态副本实现高可用多活，无需引入 Redis。

## 快速开始

1. 启动服务：

```sh
docker compose up -d
```

2. 部署前修改 [docker-compose.yml](docker-compose.yml) 中的 `DOWEL_SECRET` 为至少 16 个字符的随机字符串（用于加密保存数据库连接串和 Webhook 密钥，配置后不要更改）。
3. 打开 <http://localhost:4600>，使用容器日志打印的一次性初始化令牌完成 `/setup` 创建首个实例管理员（或在环境变量中预设 `DOWEL_ADMIN_USERNAME` 与 `DOWEL_ADMIN_PASSWORD`）。

详细步骤与各数据库配置见 [上手指南](docs/getting-started.md)。

## 文档导航

完整用户文档位于 [docs/](docs/index.md)，也可在本地运行 `pnpm docs:dev` 预览文档站点。

| 文档                                             | 内容                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [文档首页](docs/index.md)                        | 产品概览、核心工作流与角色入口                                                         |
| [上手指南](docs/getting-started.md)              | 5 分钟启动、初始化、建项目、发布、验证与执行最小闭环                                   |
| [部署与配置](docs/deployment.md)                 | Docker Compose、源码构建、20 项环境变量、外部 PG 多副本 HA、反代与白名单               |
| [账户、OIDC 与权限](docs/accounts-and-access.md) | 单公司模型、邀请与重置、OIDC（Google/GitLab）、组与授权、项目转组/删除、审计与个人设置 |
| [建模、版本与画布历史](docs/modeling.md)         | 稳定 ID、导入与影子库边界、实时协作与画布修改历史、发布与风险分析、PG 分区表编辑       |
| [多方言与版本支持](docs/dialects.md)             | PostgreSQL 15–19、SQLite、MySQL 8.4/9.7、SQL Server 2019/2022/2025 能力与限制矩阵      |
| [接手现有项目与灾难恢复](docs/takeover.md)       | 向导接手、多环境合并、强制影子库验证、接入领先历史与平台库丢失恢复                     |
| [执行迁移、回滚与漂移](docs/execution.md)        | 预演、认领、`dowel` 历史表、非事务与断点续跑、漂移处理与标记为已执行                   |
| [执行策略与执行者](docs/execution-policy.md)     | 四层策略合并规则、特权操作、执行者授权、超时映射与审批流程配置                         |
| [执行申请与审批](docs/approvals.md)              | 申请生命周期、四眼原则、绑定与失效、紧急执行与收件箱                                   |
| [组级 Webhook](docs/webhooks.md)                 | 5 种通知格式、事件列表、HMAC 签名校验、SSRF 出站限制与重试队列                         |
| [CI HTTP API](docs/api.md)                       | CI 令牌安全边界、只读与执行端点、请求响应示例与完整错误码表                            |
| [CI 流水线集成](docs/ci-action.md)               | GitHub / Gitea / Forgejo / GHES 复合 Action 与 `actions/execute/run.sh` 通用用法       |
| [术语表](docs/glossary.md)                       | 平台核心概念与术语辨析（对齐 [GLOSSARY.md](GLOSSARY.md)）                              |

## 本地开发与测试

根目录 `.tool-versions` 固定运行时为 `node 26.13.0` 与 `pnpm 12.21.0`。

```sh
pnpm install      # 安装工作区依赖
pnpm dev          # 同时启动服务端（4600，--conditions=@dowel/source 直读源码）与前端开发服务器（5173）
pnpm check        # 运行 Oxlint（--type-aware --deny-warnings）、Oxfmt 校验、tsc --noEmit 与 Vitest 单元测试
pnpm build        # 使用 tsdown 构建内部包与服务端，并用 Vite 构建前端产物
pnpm start        # 以编译后的生产产物启动服务端（http://localhost:4600）
pnpm e2e          # 运行 Playwright 端到端测试
pnpm docs:dev     # 本地预览 Zensical 用户文档站点（http://localhost:8000）
pnpm docs:build   # 严格构建文档站点到 site/（检查死链与锚点）
```

> 本地运行文档命令需要已安装 `uv`（通过 `uvx zensical==0.1.3` 无污染运行，无需创建 Python 虚拟环境）。

## 当前范围与限制

- **目标库方言**：已支持 PostgreSQL（15–19）、SQLite、MySQL（8.4 / 9.7）与 SQL Server（2019 / 2022 / 2025）。
- **无命令行工具**：Dowel 不提供独立的命令行工具，CI 流水线直接调用 HTTP API 或仓库内置的 [actions/execute](actions/execute/README.md)。
- **未实现功能**：模型分支与变更评审、浏览器离线 IndexedDB 模式、MCP 服务以及邮件通知均尚未实现。

## 协议

本项目全部代码采用 [MIT](LICENSE) 协议开源。
