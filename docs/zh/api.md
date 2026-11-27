# CI HTTP API

本文档说明如何使用 **CI 令牌**通过 HTTP API 查询项目状态并执行数据库迁移。所有面向流水线的接口都在 `/api/ci/…` 下，返回结构化 JSON 和机器可读的错误码。

> CI 流水线（包含 GitHub Actions、自建 Gitea / Forgejo Actions、GitHub Enterprise Server 或 GitLab CI / Jenkins 等 shell 流水线）可直接使用仓库内置的 `actions/execute`（见 [CI 流水线集成](ci-action.md)）。

---

## 1. 认证与安全边界 {#auth-and-security}

### 请求头 {#request-header}

所有 `/api/ci/…` 接口均使用项目 CI 令牌认证：

```http
Authorization: Bearer dwl_<43 位随机字符>
```

- **不走 Cookie 会话，不校验 `Origin`**，适合直接用 `curl` 或各类 CI 运行器调用。（仅 OpenAPI 规范 `/api/ci/openapi.json` 与交互式文档 `/api/ci/docs` 额外允许已登录用户的会话 Cookie；详见 [OpenAPI 规范与交互式文档](#openapi-docs)。）
- **能力范围固定为“只读 + 执行”**：令牌只能访问 `/api/ci/…` 且只能操作它所属的单个项目。携带 `Bearer dwl_…` 访问任何 `/api/ci/…` 之外的接口（包括编辑模型、发布版本、改策略、改连接串、标记为已执行、认领、接手、令牌管理本身）一律返回 `403 forbidden`，不会回落到 Cookie 会话。
- **项目归属**：令牌属于项目，创建者离职或被停用不影响令牌继续工作。
- **必须过期**：创建时必须指定有效天数（默认 90 天，最长 365 天）。过期和吊销均立即生效。
- **限速**（单副本进程内计数，HA 多副本下总配额约为设定值 × 副本数）：
  - 认证失败按来源 IP 限速（默认每 10 分钟最多 20 次格式合法但校验失败的尝试，可用 `DOWEL_TOKEN_FAIL_LIMIT` / `DOWEL_TOKEN_FAIL_WINDOW_MS` 调整），防止爆破；缺头或格式非法的请求直接在内存拒绝且不占失败额度，成功请求不占失败额度，且来源 IP 触及失败上限后仅拦截无效 / 过期 / 已吊销令牌，不阻断同 IP 下的有效活跃令牌。
  - 已认证令牌按令牌 ID 限速（默认每分钟 120 次，可用 `DOWEL_TOKEN_RATE_LIMIT` / `DOWEL_TOKEN_RATE_WINDOW_MS` 调整）；连接目标库的只读 / 检测接口（单环境实时状态、执行历史、漂移检测）另受连接限速约束（默认每分钟 10 次，可用 `DOWEL_CONNECTION_LIMIT` / `DOWEL_CONNECTION_WINDOW_MS` 调整）。

### 校验令牌是否有效 {#verify-token}

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/token"
```

返回示例（`200 OK`）：

```json
{
  "id": "01J...",
  "name": "CI Deploy",
  "prefix": "dwl_AbCdEfGh",
  "expiresAt": "2027-02-18T12:00:00.000Z",
  "project": {
    "id": "01J...",
    "name": "商城",
    "slug": "shop",
    "owner": "acme"
  },
  "createdBy": "张三"
}
```

---

## 2. 令牌管理与“谁能创建令牌”（登录用户接口） {#token-management}

令牌的创建、查看、吊销以及三层创建规则配置属于管理接口，**只能由登录用户通过会话 Cookie 调用**（CI 令牌调用返回 `403 forbidden`）。

### 谁能创建令牌（三层规则） {#who-can-create-tokens}

在 **管理后台 → 执行策略**（实例层）、**组首页**（组层）、**项目设置**（项目层）三处可以分别配置规则，每一层可以勾选项目角色（项目管理员 / 项目编辑者及以上）或指定组的管理员 / 成员（例如 DBA 组、流水线组）。

- **合并规则**：已设置的各层**逐层取与（AND）**——用户必须同时满足每一个已设置的层；三层都未设置时默认为“项目管理员”。下级只能在结构上收窄上级，无法放宽。实例管理员始终允许。
- **自动只读查看权限**：满足组条件而被允许创建令牌的用户，会自动获得范围内项目的只读查看权限（`viewer`），方便在项目设置里创建和管理令牌。

> **安全边界提示**：允许某成员或组创建 CI 令牌，除了组条件带来的项目只读查看权限（`viewer`）外，还等价于授予其对范围内开启 **“允许 CI 令牌执行”** 的环境（**非生产环境默认开启**、生产环境默认关闭）的免审批向前执行权，**不受环境执行策略的“谁能执行”（含“仅限执行者”）与审批流程限制**。若部分非生产环境仍需严格受“谁能执行”或审批约束，请在对应层级的执行策略中关闭“允许 CI 令牌执行”，或收窄令牌创建规则。

### 管理端点示例（Cookie 会话） {#token-admin-examples}

```bash
# 查看项目的令牌列表（项目管理员或被允许创建令牌的人）
curl -fsS -b cookies.txt \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/tokens"

# 创建令牌（明文 token 只在本次 201 响应里出现一次）
curl -fsS -b cookies.txt \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: ${DOWEL_URL}" \
  -d '{"name":"CI Deploy","description":"staging 自动部署","expiresInDays":90}' \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/tokens"

# 吊销令牌（项目管理员、组管理员、实例管理员或令牌创建者本人）
curl -fsS -b cookies.txt \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: ${DOWEL_URL}" \
  -d '{}' \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/tokens/${TOKEN_ID}/revoke"

# 读取 / 更新项目层“谁能创建令牌”规则（实例层 /api/admin/token-policy，组层 /api/groups/:slug/token-policy）
curl -fsS -b cookies.txt \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/token-policy"

curl -fsS -b cookies.txt \
  -X PUT \
  -H "Content-Type: application/json" \
  -H "Origin: ${DOWEL_URL}" \
  -d '{"rule":{"roles":["admin"],"groups":[{"groupId":"GROUP_ID","role":"member"}]}}' \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/token-policy"
```

---

## 3. CI 只读与检测接口 {#ci-readonly-endpoints}

路径中的 `:owner/:project` 必须是令牌所属的项目（转组或改 slug 后的旧路径同样可用）；访问别的项目或不存在的项目一律返回 `404 project_not_found`。

环境相关接口按职责和连接开销明确拆分为三类，**绝不返回可能过期的缓存状态**：

### 3.1 项目与环境列表（纯平台配置，不连目标库） {#get-project}

`GET /api/ci/projects/:owner/:project`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop"
```

返回项目基本信息（`id`、`name`、`slug`、`owner`）、最新版本 `latest`，以及各环境的**纯平台配置**（`name`、`production`、`tokenExecution`）：

```json
{
  "id": "01J...",
  "name": "商城",
  "slug": "shop",
  "owner": "acme",
  "latest": { "id": "01J...", "number": 5, "name": "订单表加备注" },
  "environments": [
    { "name": "staging", "production": false, "tokenExecution": true },
    { "name": "prod", "production": true, "tokenExecution": false }
  ]
}
```

### 3.2 版本链 {#get-versions}

`GET /api/ci/projects/:owner/:project/versions`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/versions"
```

按版本号升序返回项目所有已发布版本（`id`、`number`、`name`、`publishedAt`、`verified`、`checksum`）。

### 3.3 单环境实时状态（轻量连目标库读迁移历史） {#get-environment}

`GET /api/ci/projects/:owner/:project/environments/:env`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging"
```

受连接限速约束（按令牌计）。直连目标库读取历史记录（PostgreSQL / SQL Server 读 `dowel.history`，SQLite / MySQL 读 `dowel_history`，顺带同步平台库缓存），返回环境平台配置（`name`、`production`、`tokenExecution`）与实时 `currentVersion`、`unfinished`、版本链相对状态（`applied` / `current` / `pending`）和待执行版本号列表 `pending`：

```json
{
  "name": "staging",
  "production": false,
  "tokenExecution": true,
  "currentVersion": { "id": "01J...", "number": 4, "name": "加索引" },
  "unfinished": false,
  "versions": [
    { "id": "01J...", "number": 4, "name": "加索引", "state": "current", "verified": true },
    { "id": "01J...", "number": 5, "name": "订单表加备注", "state": "pending", "verified": true }
  ],
  "pending": [5]
}
```

目标库不可达返回 `502 target_unreachable`；历史格式过新、损坏或当前版本不在平台版本链上返回 `409 version_mismatch`。

### 3.4 实时漂移检测（连目标库读全库结构快照比对） {#post-drift}

`POST /api/ci/projects/:owner/:project/environments/:env/drift`

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/drift"
```

受连接限速约束（按令牌计），只读检测（不修改目标库，生产环境即使关闭 `tokenExecution` 也可调用）。直连目标库读取全库结构快照并与当前版本模型比对，同时刷新平台侧漂移状态：

```json
{
  "environment": "staging",
  "currentVersion": { "id": "01J...", "number": 4, "name": "加索引" },
  "status": "drifted",
  "checkedAt": "2026-11-21T02:00:00.000Z",
  "summary": "检测到 1 处结构差异",
  "total": 1,
  "items": [
    {
      "kind": "dropColumn",
      "target": "public.orders.hotfix_col",
      "sql": "ALTER TABLE public.orders DROP COLUMN hotfix_col"
    }
  ],
  "unresolvable": [],
  "firstRun": false,
  "needsManual": null
}
```

- `status`：`clean`（无漂移）、`drifted`（存在漂移）、`unknown`（项目尚未发布任何版本，无法比对）。
- `items`：差异项列表（最多返回 100 项；完整数量见 `total`）；`unresolvable`：`items` 中模型无法表达、需要人工核对的项。
- `needsManual`：若差异来自上一次读回校验失败，返回 `{ direction, versionId, versionNumber }`，否则为 `null`。
- 若环境正在执行返回 `423 lock_timeout`；上次执行停在中途返回 `409 unfinished_run`；目标库不可达或权限不足返回 `502 target_unreachable`；历史格式过新或当前版本不在链上返回 `409 version_mismatch`。

### 3.5 目标库执行历史 {#get-history}

`GET /api/ci/projects/:owner/:project/environments/:env/history`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/history"
```

受连接限速约束（按令牌计）。直连目标库读取 `dowel.history` / `dowel_history`（最近 100 条，新记录在前），同时同步平台库缓存。

---

## 4. CI 执行接口 {#ci-execute}

`POST /api/ci/projects/:owner/:project/environments/:env/execute`

同步等待检查与执行结束，返回结构化 JSON。

### 请求体 {#execute-request-body}

| 字段                 | 类型               | 必填 | 默认值  | 说明                                                           |
| -------------------- | ------------------ | ---- | ------- | -------------------------------------------------------------- |
| `to`                 | `string \| number` | 是   | —       | 目标版本，**必须显式指定**：`latest`、`v5` 或 `5`              |
| `dryRun`             | `boolean`          | 否   | `false` | `true` 时执行全部安全检查并列出将要执行的迁移，不写入目标库    |
| `lockTimeoutSeconds` | `integer`          | 否   | `30`    | 等待执行锁的最长秒数（`0`～`30`），超时返回 `423 lock_timeout` |

### 执行规则与安全检查 {#execution-rules}

- **开关约束**：只看环境生效执行策略里的 **“允许 CI 令牌执行”**（四层逐层收紧；默认非生产开启、生产关闭），**不受“谁能执行”（`whoCanExecute`，含“仅限执行者”）与审批流程限制**。因此，任何被允许创建 CI 令牌的成员，均可通过签发令牌对开启该开关的环境直接向前执行迁移。
- **不允许回滚**：目标版本早于环境当前版本时返回 `409 rollback_not_allowed`；回滚需在界面操作（受审批流程约束）。
- **不自动切换**：环境停在[已作废的版本](execution.md#switch)上、到目标版本要先回滚时返回 `409 switch_requires_web`（`details.current` 为当前版本），需要在网页端人工确认切换；目标版本已作废返回 `409 version_retired`。`latest` 指活跃链头（未作废、编号最大的版本）。
- **安全检查照常**：漂移检测、版本链与校验和完整性、目标库实例认领、迁移影子库验证、执行策略里的锁等待与语句超时全部照常生效，且在拿到环境锁后会复查令牌状态与开关。
- **并发与申请失效**：与界面执行、执行申请共享同一套环境锁与目标库项目锁；令牌执行结束后，该环境上受影响的待处理执行申请会自动失效。
- **审计与通知**：从“允许 CI 令牌执行”策略检查起，每次非预演的执行请求都会写入审计日志（主体标明令牌名称、前缀与创建者）。执行结束（成功或失败）时发送 `token.executed` 组级 Webhook 事件，生产环境还会向项目管理员和该环境审批流程里的审批人发送站内收件箱通知（未配置审批环节时含该环境有执行权限的人）。两处边界：
  - **预检拒绝不发通知**：环境策略未开启“允许 CI 令牌执行”，或在拿到环境锁后复查发现令牌已吊销 / 过期 / 无效、策略已关闭、项目或环境不存在且尚未改动目标库时，仅写审计日志，不发 `token.executed` Webhook 与站内收件箱通知。
  - **生产环境无变更空跑（`noop: true`）不发站内通知**：环境已在目标版本时仍发送 `token.executed` Webhook（`data.noop: true`），但不发站内收件箱通知，避免重复执行刷屏。

### 预演示例 {#execute-dry-run-example}

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"to":"latest","dryRun":true}' \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/execute"
```

### 执行示例 {#execute-example}

```bash
curl -fsS \
  --connect-timeout 15 \
  --max-time 1800 \
  -X POST \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"to":"v5","lockTimeoutSeconds":30}' \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/execute"
```

> **超时与重试建议**：调用执行接口时建议始终设置连接超时（`--connect-timeout`）与整次请求上限（`--max-time`），防止网络黑洞或服务端挂起导致流水线无限阻塞；同时**不要**对该写接口启用自动重试（如 `curl --retry`）——接口支持 `to: "latest"`、可能包含非事务 / 隐式提交 DDL 步骤并会产生审计与 Webhook 通知，超时后应先查询环境实时状态再决定是否重试。

### 内置 CI 脚本 / Action 参数（`actions/execute`） {#builtin-action-params}

使用仓库内置的 [CI 流水线集成](ci-action.md)（支持 GitHub / Gitea / Forgejo / GHES 复合 Action 或直接运行 `bash actions/execute/run.sh`）时，支持以下输入参数与对应环境变量：

| Action 输入       | 环境变量                | 必填 | 默认值  | 说明                                                                                   |
| ----------------- | ----------------------- | ---- | ------- | -------------------------------------------------------------------------------------- |
| `url`             | `DOWEL_URL`             | 是   | —       | Dowel 服务地址（仅允许 `http://` / `https://`）                                        |
| `token`           | `DOWEL_TOKEN`           | 是   | —       | 项目 CI 令牌（`dwl_…`，通过 `curl --config -` 经标准输入传递，不出现在命令行参数中）   |
| `project`         | `DOWEL_PROJECT`         | 是   | —       | 项目路径 `owner/slug`                                                                  |
| `environment`     | `DOWEL_ENVIRONMENT`     | 是   | —       | 目标环境名，例如 `staging`                                                             |
| `to`              | `DOWEL_TO`              | 是   | —       | 目标版本：`latest`、`v5` 或 `5`                                                        |
| `dry-run`         | `DOWEL_DRY_RUN`         | 否   | `false` | `true` 时只预演不写入目标库                                                            |
| `lock-timeout`    | `DOWEL_LOCK_TIMEOUT`    | 否   | `30`    | 等待执行锁的最长秒数（`0`～`30`）                                                      |
| `connect-timeout` | `DOWEL_CONNECT_TIMEOUT` | 否   | `15`    | 建立 HTTP 连接的超时秒数（`1`～`3600`，对应 `curl --connect-timeout`）                 |
| `timeout`         | `DOWEL_TIMEOUT`         | 否   | `1800`  | 整次 HTTP 请求的最长耗时秒数（`0`～`86400`，对应 `curl --max-time`；`0` 表示不限时长） |

脚本输入校验失败返回 `invalid_input`（发起请求前直接退出码 `1`）；建连或请求超时、网络不可达返回 `network_error`（不自动重试）。

### 成功响应（`200 OK`） {#execute-success-response}

```json
{
  "ok": true,
  "dryRun": false,
  "project": "acme/shop",
  "environment": "staging",
  "from": { "id": "01J...", "number": 4, "name": "加索引" },
  "to": { "id": "01J...", "number": 5, "name": "订单表加备注" },
  "reached": { "id": "01J...", "number": 5, "name": "订单表加备注" },
  "migrations": [{ "number": 5, "name": "订单表加备注", "direction": "up" }],
  "noop": false,
  "durationMs": 412
}
```

如果环境已经在目标版本，返回 `200 OK`，`noop: true`，`migrations: []`。

---

## 5. 错误响应与错误码表 {#error-codes}

所有错误响应统一为 JSON：

```json
{
  "ok": false,
  "code": "drift",
  "error": "目标库结构与环境当前版本不一致…",
  "details": { "reason": "drift", "diff": [...], "diffTotal": 2 },
  "reached": { "id": "01J...", "number": 4, "name": "加索引" }
}
```

> `reached` 在执行中途失败时表示环境停在的最后一个成功版本；`details` 仅在存在补充上下文（如 `diff`、`timeout`、`current`、`partial`）时返回。

| 错误码 (`code`)            | HTTP 状态码 | 含义与常见原因                                                                                                                                                                                                                                 |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`          | `400`       | 请求体不是合法 JSON，或 `to` / `dryRun` / `lockTimeoutSeconds` 参数不合法                                                                                                                                                                      |
| `payload_too_large`        | `413`       | 请求体超过 16 MiB 上限，在解析之前就被拒绝                                                                                                                                                                                                     |
| `token_missing`            | `401`       | 缺少 `Authorization` 请求头                                                                                                                                                                                                                    |
| `token_invalid`            | `401`       | 令牌格式不对、不是 `dwl_…` 或不存在                                                                                                                                                                                                            |
| `token_expired`            | `401`       | 令牌已过有效期                                                                                                                                                                                                                                 |
| `token_revoked`            | `401`       | 令牌已被吊销                                                                                                                                                                                                                                   |
| `forbidden`                | `403`       | 用 CI 令牌访问了 `/api/ci/…` 之外的接口                                                                                                                                                                                                        |
| `token_execution_disabled` | `403`       | 环境生效的执行策略不允许令牌执行（生产环境默认关闭）                                                                                                                                                                                           |
| `project_not_found`        | `404`       | 项目不存在，或不是该令牌所属的项目                                                                                                                                                                                                             |
| `environment_not_found`    | `404`       | 环境不存在                                                                                                                                                                                                                                     |
| `rollback_not_allowed`     | `409`       | 目标版本早于环境当前版本（令牌不能回滚；`details.current` 为当前版本）                                                                                                                                                                         |
| `switch_requires_web`      | `409`       | 环境停在已作废的版本上，到目标版本要先回滚；令牌不自动回滚，需在网页端确认切换                                                                                                                                                                 |
| `version_retired`          | `409`       | 目标版本已作废，不能执行到它                                                                                                                                                                                                                   |
| `version_mismatch`         | `409`       | 目标库历史与平台版本链不一致、校验和被篡改或格式版本过新（见 `details.reason`）                                                                                                                                                                |
| `unverified`               | `409`       | 待执行迁移尚未通过影子库验证                                                                                                                                                                                                                   |
| `drift`                    | `409`       | 目标库结构与当前版本模型不一致，或首次执行时既非基线也非空库（`details.firstRun`）                                                                                                                                                             |
| `unfinished_run`           | `409`       | 上一次含非事务或隐式提交步骤的执行停在中途，需先在界面处理                                                                                                                                                                                     |
| `foreign_instance`         | `409`       | 目标库里的该项目由其他 Dowel 实例认领                                                                                                                                                                                                          |
| `rejected`                 | `409`       | 其他执行前检查未通过（如含实例级语句、schema 范围不合法，或目标库无历史且结构已等于首版本、没有后续迁移可执行时的 `mark_required`——令牌不能标记，需在界面使用「标记为已执行」，或等发布新版本后由 CI 执行时自动写入基线；见 `details.reason`） |
| `version_not_found`        | `422`       | 目标版本不在项目版本链上，或项目尚未发布任何版本                                                                                                                                                                                               |
| `execution_failed`         | `422`       | 某一步 SQL 报错、语句 / 锁等待超时或读回校验不一致；环境停在 `reached`                                                                                                                                                                         |
| `lock_timeout`             | `423`       | 等待环境锁或目标库项目锁超时（另一项执行正在进行）                                                                                                                                                                                             |
| `rate_limited`             | `429`       | 超过认证失败限速或令牌请求限速（响应头带 `Retry-After`）                                                                                                                                                                                       |
| `target_unreachable`       | `502`       | 无法连接目标库，或目标库拒绝操作（例如缺少建 schema 权限）                                                                                                                                                                                     |
| `internal`                 | `500`       | 服务器内部错误                                                                                                                                                                                                                                 |

---

## 6. OpenAPI 规范与交互式文档 {#openapi-docs}

Dowel 为上述 7 个外部 CI 接口提供 OpenAPI 3.1 规范与完全自托管的 Scalar 交互式文档：

- **`GET /api/ci/openapi.json`** — 生成自服务端路由契约的 OpenAPI `3.1.0` JSON 文档，包含全部 7 个 `/api/ci/…` 接口的路径参数、请求体、成功响应与错误响应结构（`CiErrorBody`）。
- **`GET /api/ci/docs`** — 自托管的 Scalar 交互式 API 参考页面（脚本与资源全部由同源服务提供，严格遵守 `script-src 'self'` CSP，不加载外部 CDN、外部字体或遥测服务）。

### 访问认证规则 {#openapi-docs-auth}

7 个 CI 业务接口始终**只接受 `Authorization: Bearer dwl_…` 令牌**（绝不接受会话 Cookie）。文档接口（`/api/ci/openapi.json`、`/api/ci/docs`、`/api/ci/docs/init.js`）则支持**以下任一方式**访问：

1. **已登录用户的会话 Cookie** — 在浏览器登录 Dowel 后直接打开 `${DOWEL_URL}/api/ci/docs`。处于首次强制改密期间的账号返回 `403 password_change_required`；未登录或已停用账号返回 `401 unauthorized`。
2. **有效的项目 CI 令牌（`Authorization: Bearer dwl_…`）** — 与业务接口共用同一套令牌校验、按 IP 失败限流、活跃令牌缓存与按令牌请求限速；无效、过期或已吊销的 `dwl_…` 令牌返回 `401`（`token_invalid` / `token_expired` / `token_revoked`），绝不回落到 Cookie 会话。

携带 MCP 令牌（`Bearer dwm_…`）访问会返回 `403 forbidden`。

### 使用 CI 令牌获取 OpenAPI 3.1 文档 {#openapi-curl}

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/openapi.json"
```

### 在浏览器查看交互式文档 {#openapi-browser}

在浏览器登录 Dowel 后，直接访问以下地址即可浏览接口说明并在线调试：

```text
${DOWEL_URL}/api/ci/docs
```
