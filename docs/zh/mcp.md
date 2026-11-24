# AI 编程助手（MCP） {#mcp}

Dowel 内置 [Model Context Protocol](https://modelcontextprotocol.io)（MCP）服务。Claude Code、Cursor、VS Code 等 AI 编程助手可以**以你的身份**读取模型、预览迁移、在影子库验证，并修改工作副本；修改和在画布上编辑一样走冲突规则、记审计。

服务和网页在同一个端口：`POST /api/mcp`（无状态 Streamable HTTP），多副本部署在负载均衡后面也不需要粘性会话。

---

## 1. AI 能做什么、不能做什么 {#boundaries}

| AI 能做                                          | AI 不能做                                              |
| ------------------------------------------------ | ------------------------------------------------------ |
| 列出项目，读取模型、表、DDL、版本链和迁移预览    | 发布版本                                               |
| 从**平台缓存**读取环境状态和漂移（带缓存时间）   | 连接环境的目标库（不能实时读状态、读历史或检查漂移）   |
| 在影子库验证迁移（需要“在影子库验证”权限）       | 执行、回滚、标记为已执行、写入基线，提交或审批执行申请 |
| 整批原子地修改工作副本（需要“修改工作副本”权限） | 修改连接串、执行策略、令牌，或整库导入覆盖             |

发布和执行始终由人在 Dowel 界面上完成，走执行策略与审批。

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

| 工具                | 权限 | 作用                                                                                                                     |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `list_projects`     | 读取 | 你能访问的项目（限令牌的项目范围）                                                                                       |
| `get_model`         | 读取 | 工作副本：摘要，或带版本号的完整对象，以及当前 `seq`                                                                     |
| `get_table`         | 读取 | 一张表的列、主键、约束、索引和分区                                                                                       |
| `get_ddl`           | 读取 | 工作副本或某个版本的 `CREATE` DDL                                                                                        |
| `list_versions`     | 读取 | 版本链                                                                                                                   |
| `get_version`       | 读取 | 一个版本及其冻结的升级 / 回滚迁移                                                                                        |
| `preview_migration` | 读取 | 两个版本之间的升级 / 回滚 SQL（默认：最新版本 → 工作副本）                                                               |
| `list_environments` | 读取 | 环境及其缓存的当前版本、漂移状态和缓存时间                                                                               |
| `list_mutators`     | 读取 | 可用的修改操作及其参数的 JSON Schema                                                                                     |
| `verify_migration`  | 验证 | 在影子库里执行迁移并比对结果（等同界面上的“在影子库验证”）                                                               |
| `apply_changes`     | 修改 | 整批原子执行修改操作；参数 `baseSeq`（来自 `get_model`）、`ops`（最多 100 个）、`dryRun`；新对象的 ID 写 `"$ref:<别名>"` |

典型流程：`get_model`（记下 `seq`）→ 用这个 `baseSeq` 调 `apply_changes` → `preview_migration` → `verify_migration` → 由人在 Dowel 里评审并发布。

另有只读资源：`dowel://projects`、`dowel://projects/{owner}/{project}/model`、`…/ddl`、`…/versions`、`…/environments` 和 `dowel://mutators`。

## 5. 安全与管理 {#security}

- **隔离**：MCP 令牌（`dwm_…`）只能访问 `/api/mcp`，`/api/mcp` 也只接受 MCP 令牌；会话 cookie 与 CI 令牌在这里一律被拒绝，MCP 令牌访问其他任何接口（包括 `/api/ci/...`）返回 `403 forbidden`。
- **审计**：修改（`model.mutate`）与影子库验证（`model.verify`）记在你名下，带 `MCP` 标记和令牌前缀；新建、吊销令牌也记审计。
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

工具执行失败在 MCP 消息里以 `isError: true` 返回，`code` 如 `project_not_found`、`forbidden`、`scope_required`、`conflict`、`invalid`、`base_seq_ahead`、`shadow_unavailable`。
