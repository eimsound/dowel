# 五、鉴权、限流与 CI 令牌安全边界

涉及模块：`apps/server/src/routes/ci.ts`、`apps/server/src/tokens.ts`、`apps/server/src/rate-limit.ts`、`apps/server/src/authz.ts`、`apps/server/src/roles.ts`、`packages/api/src/policy.ts`、`apps/web/src/components/TokenSettings.tsx`、`actions/execute/*`。

---

## 1. CI 令牌认证失败限流认证前按单 IP 桶拦截，共享 NAT 下 20 次失败阻断全部合法流水线（`#8` · High）

- **【反模式】**
  - 在 `/api/ci/*` 认证中间件中，调用 `authenticateToken` **之前**按单一 `ip:${ip ?? 'unknown'}` 桶同步扣减 `tokenFailLimiter`（20 次 / 10 分钟），且缺头（`token_missing`）与格式非法请求也直接消耗额度不退回。
- **【会出什么事】**
  - 在共享 NAT 出口、反代未设 `DOWEL_TRUST_PROXY` 或回落到 `ip:unknown` 时，任意一个误配流水线或探针发 20 次缺头/错误令牌，就能在 10 分钟内把同 IP 下所有持有合法令牌的 CI 流水线以 `429 rate_limited` 全部阻断。
- **【Dowel 正确做法】**（已验证于 `routes/ci.ts` / `tokens.ts` / `tokens.test.ts`）
  1. `token_missing` 与不匹配 `TOKEN_PATTERN` 的请求直接在内存返回 `401`，**不查库、不消耗 `tokenFailLimiter`**；
  2. 维护进程内惰性活跃令牌哈希快照 `ActiveTokenCache`（短 TTL 复用、并发刷新去重、按 `expiresAtMs` 自然过期即刻失效，并在创建/吊销/删项目、集群 `ci_tokens.changed` 事件与 `LISTEN` 重连时联动失效）；
  3. 当来源 IP 触发 `tokenFailLimiter` 上限时，未命中活跃快照的无效/过期/吊销/随机爆破令牌直接 `429 rate_limited` 不打库；**命中活跃快照的合法令牌仍放行进入 `authenticateToken` 做数据库强校验**，既防爆破打穿 DB 又绝不误杀共享 IP 合法流水线。

---

## 2. `KeyedLimiter.refund()` 用 `arr.pop()` 退错并发或跨窗口请求记录（`#9` · Low）

- **【反模式】**
  - `KeyedLimiter.refund(key)` 直接 `arr.pop()` 删除该 key 时间戳数组的末尾条目，而非本次 `attempt(key)` 写入的那一条。
- **【会出什么事】**
  - 并发场景下：合法请求 A 在 `t1` 预占、失败请求 B 在 `t2` 预占并失败；A 成功后 `arr.pop()` 弹掉了 B 的 `t2` 留下更早的 `t1`，让失败记录提前滑出窗口；
  - 慢请求跨过 `windowMs` 后 `t1` 已被清扫，此时 `arr.pop()` 会误删新窗口里他人的失败计数。
- **【Dowel 正确做法】**（已验证于 `rate-limit.ts` / `routes/ci.ts` / `rate-limit.test.ts`）
  - 桶内记录带单调自增 ID（`{ at, id }`）；`attempt()` 允许时及 `record()` 返回精确幂等的 `refund()` 闭包，只删除本次预占写入的 ID 范围；已过期清扫或重复调用均为 no-op，桶清空时同步删 map 键。

---

## 3. “允许创建 CI 令牌”可间接获得 `allowTokens=true` 环境免审批执行权，缺乏显式警示（`#10` · Medium）

- **【反模式】**
  - 仅在代码里让 `ci.execute` 检查 `env.allowTokens === true`（非生产环境默认开启）且不受 `whoCanExecute` / 审批流程约束，但在界面、用户文档和 ADR 中只写“自动获得项目只读可见性”，隐藏了这条权限传导链。
- **【会出什么事】**
  - 管理员按组/项目规则授予某成员“允许创建 CI 令牌”时，未意识到即便该成员原本只有 `viewer` 只读权或受 `whoCanExecute = 'executor'` 与审批约束，也能通过自建令牌对范围内所有 `allowTokens=true`（含默认开启的非生产）环境直接免审批向前执行迁移。
- **【Dowel 正确做法】**（已验证于 `TokenSettings.tsx` / `i18n.ts` / `docs/api.md` / `adr/05-ci-tokens-and-api.md`）
  - 凡存在间接权限传导的安全边界，必须在**配置 UI 警示条（中英文）**、**用户文档**与 **ADR** 三处同步写清传导范围与默认开关，并用 E2E 断言确保警示文案不会在改版中丢失。

---

## 4. `actions/execute/run.sh` 缺少 `curl` 超时保护，且不可对写接口盲加自动重试（`#16` · Low）

- **【反模式】**
  1. GitHub Action 脚本调用 `curl` 执行 `POST /api/ci/.../execute` 不传 `--connect-timeout` 与 `--max-time`；
  2. 为“抗抖动”顺手给执行接口加上 `--retry` 自动重试。
- **【会出什么事】**
  1. 遇黑洞路由、丢包或服务端挂起时，CI 步骤一直卡死到 Runner 自身超时；
  2. `POST /api/ci/.../execute` 并非严格幂等（支持 `to: "latest"`、含非事务 DDL 步骤、写审计与发 Webhook），对超时/5xx/断连盲目自动重试会造成重复执行、`latest` 漂移或重复告警。
- **【Dowel 正确做法】**
  1. 在 `run.sh` 与 `action.yml` 提供 `--connect-timeout`（默认如 `15`s）与可配置的 `--max-time`（默认宽松上限如 `1800`s 防误杀大表长迁移），并对入参做正整数校验，同步更新 `actions/execute/README.md` 与 `docs/api.md`；
  2. **绝不对非幂等写接口默认开启自动重试**。
