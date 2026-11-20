# Dowel CI HTTP API

本文档说明如何使用 **CI 令牌**通过 HTTP API 查询项目状态并执行数据库迁移。所有面向流水线的接口都在 `/api/ci/…` 下，返回结构化 JSON 和机器可读的错误码。

> GitHub Actions 用户可以直接使用仓库内置的 [actions/execute](../actions/execute/README.md)（纯 `bash` + `curl`，无第三方 Action 依赖）。

---

## 1. 认证与安全边界

### 请求头

所有 `/api/ci/…` 接口都使用项目 CI 令牌认证：

```http
Authorization: Bearer dwl_<43 位随机字符>
```

- **不走 Cookie 会话，不校验 `Origin`**，适合直接用 `curl` 或各类 CI 运行器调用。
- **能力范围固定为“只读 + 执行”**：令牌只能访问 `/api/ci/…` 且只能操作它所属的单个项目。携带 `Bearer dwl_…` 访问任何 `/api/ci/…` 之外的接口（包括编辑模型、发布版本、改策略、改连接串、标记为已执行、写基线、认领、接手、令牌管理本身）一律返回 `403 forbidden`，不会回落到 Cookie 会话。
- **项目归属**：令牌属于项目，创建者离职或被停用不影响令牌继续工作。
- **必须过期**：创建时必须指定有效天数（默认 90 天，最长 365 天）。过期和吊销均立即生效。
- **限速**：
  - 认证失败按来源 IP 限速（默认每 10 分钟最多 20 次失败，可用环境变量 `DOWEL_TOKEN_FAIL_LIMIT` 调整），防止爆破；成功请求不占失败额度。
  - 已认证令牌按令牌 ID 限速（默认每分钟 120 次，可用 `DOWEL_TOKEN_RATE_LIMIT` 调整）；读取目标库历史另受连接限速约束（每分钟 10 次）。

### 校验令牌是否有效

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/token"
```

返回示例（`200 OK`）：

```json
{
  "id": "01J...",
  "name": "GitHub Actions",
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

## 2. 令牌管理与“谁能创建令牌”（登录用户接口）

令牌的创建、查看、吊销以及三层创建规则配置属于管理接口，**只能由登录用户通过会话 Cookie 调用**（CI 令牌调用返回 `403 forbidden`）。

### 谁能创建令牌（三层规则）

在 **管理后台 → 执行策略**（实例层）、**组页面**（组层）、**项目设置**（项目层）三处可以分别配置规则，每一层可以勾选项目角色（项目管理员 / 项目编辑者及以上）或指定组的管理员 / 成员（例如 DBA 组、流水线组）。

- **合并规则**：已设置的各层**逐层取与（AND）**——用户必须同时满足每一个已设置的层；三层都未设置时默认为“项目管理员”。下级只能在结构上收窄上级，无法放宽。实例管理员始终允许。
- **自动只读可见性**：满足组条件而被允许创建令牌的用户，会自动获得范围内项目的只读可见权限（`viewer`），方便在项目设置里创建和管理令牌。

### 管理端点示例（Cookie 会话）

```bash
# 查看项目的令牌列表（项目管理员或被允许创建令牌的人）
curl -fsS -b cookies.txt \
  "${DOWEL_URL}/api/projects/${PROJECT_ID}/tokens"

# 创建令牌（明文 token 只在本次 201 响应里出现一次）
curl -fsS -b cookies.txt \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: ${DOWEL_URL}" \
  -d '{"name":"GitHub Actions","description":"staging 自动部署","expiresInDays":90}' \
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

## 3. CI 只读接口

路径中的 `:owner/:project` 必须是令牌所属的项目（转组或改 slug 后的旧路径同样可用）；访问别的项目或不存在的项目一律返回 `404 project_not_found`。

### 3.1 项目概要

`GET /api/ci/projects/:owner/:project`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop"
```

返回项目基本信息、最新版本 `latest` 以及每个环境的当前版本、是否允许令牌执行（`tokenExecution`）、缓存的漂移状态与前置环境信息。

### 3.2 版本链

`GET /api/ci/projects/:owner/:project/versions`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/versions"
```

按版本号升序返回项目所有已发布版本（`id`、`number`、`name`、`publishedAt`、`verified`、`checksum`）。

### 3.3 环境状态（平台缓存，不连目标库）

`GET /api/ci/projects/:owner/:project/environments/:env`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging"
```

返回环境概要、版本链中每个版本的相对状态（`applied` / `current` / `pending`）以及待执行版本号列表 `pending`。

### 3.4 目标库执行历史

`GET /api/ci/projects/:owner/:project/environments/:env/history`

```bash
curl -fsS \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/history"
```

直连目标库读取 `dowel.history`（最近 100 条，新记录在前），同时同步平台库缓存。

---

## 4. CI 执行接口

`POST /api/ci/projects/:owner/:project/environments/:env/execute`

同步等待检查与执行结束，返回结构化 JSON。

### 请求体

| 字段                 | 类型               | 必填 | 默认值  | 说明                                                           |
| -------------------- | ------------------ | ---- | ------- | -------------------------------------------------------------- |
| `to`                 | `string \| number` | 是   | —       | 目标版本，**必须显式指定**：`latest`、`v5` 或 `5`              |
| `dryRun`             | `boolean`          | 否   | `false` | `true` 时执行全部安全检查并列出将要执行的迁移，不写入目标库    |
| `lockTimeoutSeconds` | `integer`          | 否   | `30`    | 等待执行锁的最长秒数（`0`～`30`），超时返回 `423 lock_timeout` |

### 执行规则与安全检查

- **开关约束**：只看环境生效执行策略里的 **“允许令牌执行”**（四层逐层收紧；默认非生产开启、生产关闭）。**令牌执行不走审批**。
- **不允许回滚**：目标版本早于环境当前版本时返回 `409 rollback_not_allowed`；回滚需在界面操作（受审批流程约束）。
- **安全检查照常**：漂移检测、版本链与校验和完整性、目标库实例认领、迁移影子库验证、前置环境（`prerequisite`）、执行策略里的 `lock_timeout` / `statement_timeout` 全部照常生效，且在拿到环境锁后会复查令牌状态、开关与前置环境。
- **并发与申请失效**：与界面执行、执行申请共享同一套环境锁与目标库项目锁；令牌执行结束后，该环境上受影响的待处理执行申请会自动失效。
- **审计与通知**：每次非预演的执行请求都会写入审计日志（主体标明令牌名称、前缀与创建者），发送 `token.executed` 组级 Webhook 事件；对生产环境的执行（成功或失败）还会向项目管理员和该环境审批流程里的审批人发送站内收件箱通知。

### 预演示例

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"to":"latest","dryRun":true}' \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/execute"
```

### 执行示例

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${DOWEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"to":"v5","lockTimeoutSeconds":30}' \
  "${DOWEL_URL}/api/ci/projects/acme/shop/environments/staging/execute"
```

### 成功响应（`200 OK`）

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

## 5. 错误响应与错误码表

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

> `reached` 在执行中途失败时表示环境停在的最后一个成功版本；`details` 仅在存在补充上下文（如 `diff`、`prerequisite`、`timeout`、`current`、`partial`）时返回。

| 错误码 (`code`)            | HTTP 状态码 | 含义与常见原因                                                                     |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `invalid_request`          | `400`       | 请求体不是合法 JSON，或 `to` / `dryRun` / `lockTimeoutSeconds` 参数不合法          |
| `token_missing`            | `401`       | 缺少 `Authorization` 请求头                                                        |
| `token_invalid`            | `401`       | 令牌格式不对、不是 `dwl_…` 或不存在                                                |
| `token_expired`            | `401`       | 令牌已过有效期                                                                     |
| `token_revoked`            | `401`       | 令牌已被吊销                                                                       |
| `forbidden`                | `403`       | 用 CI 令牌访问了 `/api/ci/…` 之外的接口                                            |
| `token_execution_disabled` | `403`       | 环境生效的执行策略不允许令牌执行（生产环境默认关闭）                               |
| `project_not_found`        | `404`       | 项目不存在，或不是该令牌所属的项目                                                 |
| `environment_not_found`    | `404`       | 环境不存在                                                                         |
| `rollback_not_allowed`     | `409`       | 目标版本早于环境当前版本（令牌不能回滚；`details.current` 为当前版本）             |
| `version_mismatch`         | `409`       | 目标库历史与平台版本链不一致、校验和被篡改或格式版本过新（见 `details.reason`）    |
| `unverified`               | `409`       | 待执行迁移尚未通过影子库验证                                                       |
| `drift`                    | `409`       | 目标库结构与当前版本模型不一致，或首次执行时既非基线也非空库（`details.firstRun`） |
| `unfinished_run`           | `409`       | 上一次含非事务步骤的执行停在中途，需先在界面处理                                   |
| `foreign_instance`         | `409`       | 目标库里的该项目由其他 Dowel 实例认领                                              |
| `prerequisite_behind`      | `409`       | 前置环境尚未执行到目标版本（`details.prerequisite`）                               |
| `prerequisite_missing`     | `409`       | 配置的前置环境不存在                                                               |
| `rejected`                 | `409`       | 其他执行前检查未通过（如含实例级语句、schema 范围不合法等，见 `details.reason`）   |
| `version_not_found`        | `422`       | 目标版本不在项目版本链上，或项目尚未发布任何版本                                   |
| `execution_failed`         | `422`       | 某一步 SQL 报错、语句 / 锁等待超时或读回校验不一致；环境停在 `reached`             |
| `lock_timeout`             | `423`       | 等待环境锁或目标库项目锁超时（另一项执行正在进行）                                 |
| `rate_limited`             | `429`       | 超过认证失败限速或令牌请求限速（响应头带 `Retry-After`）                           |
| `target_unreachable`       | `502`       | 无法连接目标库，或目标库拒绝操作（例如缺少建 schema 权限）                         |
| `internal`                 | `500`       | 服务器内部错误                                                                     |
