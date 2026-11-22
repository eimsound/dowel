# 组级 Webhook

组管理员可以在组首页配置 Webhook，当组内项目出现执行申请、审批结果、直接执行、紧急执行或 CI 令牌执行事件时，由服务端向钉钉、飞书、企业微信、Slack 群机器人或自建 HTTP 接收端发送通知。

## 配置项与事件列表 {#configuration}

进入**组首页 → Webhook**（仅组管理员和实例管理员可见）点击“新建 Webhook”：

| 配置项       | 说明                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 名称         | 辨识名称，例如“核心库 DBA 通知群”                                                                                                         |
| 格式         | 通用 JSON / 钉钉机器人 / 飞书机器人 / 企业微信机器人 / Slack                                                                              |
| Webhook 地址 | 接收端 URL，仅限 `http://` 或 `https://`，保存及发送前均需通过[出站限制](#outbound-restrictions)                                          |
| 签名密钥     | 可选。通用 JSON 用于生成 `X-Dowel-Signature`；钉钉填加签 `SEC…` 密钥；飞书填“签名校验”密钥。企业微信与 Slack 密钥包含在地址中，不显示此项 |
| 订阅的事件   | 至少勾选一个事件（见下表）                                                                                                                |
| 启用         | 关闭后停止自动派发事件（仍可手动点“发送测试”）                                                                                            |

**地址与签名密钥保存后不回显**：因钉钉 `access_token`、企业微信 `key`、Slack URL 常包含敏感凭据，界面列表只显示协议与主机名（例如 `https://oapi.dingtalk.com/…`），密钥只显示“已设置”。修改记录时地址或密钥留空表示保持原值；勾选“清除签名密钥”可移除密钥。两者在平台库中以 `DOWEL_SECRET` 加密存储，不会出现在接口、审计或投递日志中。

| 事件名称              | 触发时机                                                          |
| --------------------- | ----------------------------------------------------------------- |
| `request.created`     | 提交了新的执行申请                                                |
| `request.approved`    | 申请的所有审批环节均已通过，等待触发执行                          |
| `request.rejected`    | 执行申请被驳回                                                    |
| `request.withdrawn`   | 申请人撤回了申请                                                  |
| `request.invalidated` | 申请因环境状态变更、审批流程收紧而失效，或已过期                  |
| `request.executed`    | 执行申请触发的执行结束（成功或失败）                              |
| `execution.finished`  | 不走审批的直接执行或回滚结束（成功或失败）                        |
| `emergency.executed`  | 实例管理员的紧急执行结束                                          |
| `token.executed`      | CI 令牌执行结束（成功或失败，含无变更空跑；预演和预检拒绝不发送） |

报文内容仅包含项目、环境、版本号、操作者、状态及脱敏后的结果说明，不含数据库连接串或密码。

## 发送测试 {#test-delivery}

每条 Webhook 右侧提供“发送测试”按钮，立即发送一条 `type: "test"` 的测试消息。测试投递**只尝试一次、不进入重试队列**，结果当场展示并记入投递记录，适合在启用前验证地址、签名、关键词或机器人 IP 白名单。

## 各格式报文与签名校验 {#payload-formats}

所有出站请求均采用 `POST`，请求头包含 `Content-Type: application/json` 与 `User-Agent: Dowel-Webhook`。

### 通用 JSON {#format-json}

```json
{
  "id": "0193…",
  "type": "request.created",
  "at": "2026-11-20T08:00:00.000Z",
  "title": "新的执行申请",
  "text": "**张三** 申请在 `prod` 执行到 v3\n原因：上线",
  "url": "https://dowel.example.com/…",
  "data": { "project": "shop", "environment": "prod" }
}
```

- `id`：投递 ID，同一事件的重试保持 `id` 不变，接收端可用于去重；
- `text`：可读摘要正文；
- `url`：对应详情页地址（仅当服务端配置了 `DOWEL_PUBLIC_URL` 时生成，否则为 `null`）；
- `data`：随事件类型变化的结构化上下文。

自定义 HTTP 请求头：

| 请求头              | 内容                                                      |
| ------------------- | --------------------------------------------------------- |
| `X-Dowel-Event`     | 事件类型（同 `type`）                                     |
| `X-Dowel-Delivery`  | 投递 ID（同 `id`）                                        |
| `X-Dowel-Timestamp` | 发送时间（Unix 秒时间戳）                                 |
| `X-Dowel-Signature` | 仅设置签名密钥时附带：`sha256=<十六进制小写 HMAC-SHA256>` |

签名原文为 `"<X-Dowel-Timestamp>.<原始请求体字节>"`，务必直接针对收到的原始 HTTP body 计算后再以常数时间函数比对。

=== "Node.js 校验示例"

    ```js
    import { createHmac, timingSafeEqual } from 'node:crypto';

    /** rawBody：原始请求体（Buffer 或字符串）；headers：小写的请求头 */
    export const verifyDowel = (rawBody, headers, secret, maxAgeSeconds = 300) => {
      const ts = headers['x-dowel-timestamp'];
      const sig = headers['x-dowel-signature'] ?? '';
      if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > maxAgeSeconds) return false;
      const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    ```

=== "Python 校验示例"

    ```python
    import hashlib, hmac, time

    def verify_dowel(raw_body: bytes, headers: dict, secret: str, max_age: int = 300) -> bool:
        ts = headers.get("x-dowel-timestamp", "")
        sig = headers.get("x-dowel-signature", "")
        if not ts or abs(time.time() - int(ts)) > max_age:
            return False
        mac = hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256)
        return hmac.compare_digest(sig, "sha256=" + mac.hexdigest())
    ```

### 钉钉自定义机器人 {#format-dingtalk}

发送 `{ "msgtype": "markdown", "markdown": { "title": 标题, "text": 正文 } }`。配置了签名密钥时，请求地址自动附加 `timestamp`（毫秒）与 `sign = urlencode(base64(HMAC-SHA256(key = 密钥, msg = "<timestamp>\n<密钥>")))`。若机器人启用“自定义关键词”，请把关键词写进群名或确保通知中包含对应文字（如 `Dowel`）。返回的 `errcode` 不为 `0` 时判定为失败。

### 飞书自定义机器人 {#format-feishu}

发送 `{ "msg_type": "text", "content": { "text": 正文 } }`。配置了签名密钥时，请求体附加 `timestamp`（秒字符串）与 `sign = base64(HMAC-SHA256(key = "<timestamp>\n<密钥>", msg = ""))`。返回的 `code`（旧接口 `StatusCode`）不为 `0` 时判定为失败。

### 企业微信群机器人 {#format-wecom}

发送 `{ "msgtype": "markdown", "markdown": { "content": 正文 } }`，不附带额外签名（密钥在地址 `key` 参数中）。返回 `errcode` 不为 `0` 时判定为失败。

### Slack {#format-slack}

发送 Incoming Webhook 格式 `{ "text": 正文 }`（将 `**粗体**` 转换为 Slack `*粗体*` 并转义 `& < >`），不签名。

## 出站限制（SSRF 防护） {#outbound-restrictions}

为防止 Webhook 被滥用探测服务端内网，**默认只允许访问公网地址**。以下地址范围默认一律拒绝：回环地址（`127.0.0.0/8`、`::1`）、私有地址（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、链路本地（`169.254.0.0/16` 含云主机元数据地址、`fe80::/10`）、运营商级 NAT（`100.64.0.0/10`）、IPv6 唯一本地地址（`fc00::/7`）、`0.0.0.0/8`、未指定/组播/保留地址及对应 IPv4-mapped IPv6 地址。

- **保存与发送双重校验**：保存配置时解析主机名检查，不通过返回 422；**每次真正建立连接发请求前还会重新解析并逐一检验 DNS 返回地址**，拦截 DNS 重绑定攻击；
- **不跟随重定向**：接收端返回 3xx 重定向即记为失败，请填写最终地址。

若需通知内网机器人或私有接收服务，实例管理员可在**管理后台 → 实例设置 → Webhook 出站允许列表**额外放行（支持 CIDR、单个 IP 或精确信任的主机名，每行一项）。此列表仅用于 Webhook 出站放行，与控制数据库连接目标的 [`connection_allowlist`](deployment.md#connection-allowlist) 相互独立。

## 重试与投递记录 {#retries-and-logs}

- 单次请求总超时为 5 秒（含连接、发送与读取响应）。
- **可重试失败**：连接/网络超时或异常、HTTP `429`、HTTP `5xx`。最多重试 3 次（连同首次共 4 次尝试），退避等待间隔依次为 2 秒、8 秒、32 秒。
- **不重试失败**：其他 `4xx`、`3xx`、出站白名单拦截，以及钉钉/飞书/企业微信返回非 0 业务错误码。
- 每个 Webhook 保留最近 **50 条**投递记录（记录时间、事件类型、尝试次数、HTTP 状态码、耗时及已脱敏的失败原因；URL 路径与查询参数不会写进错误信息）。

## 权限、审计与队列限制 {#permissions-and-limits}

- **权限与审计**：查看、管理 Webhook、查阅投递记录与发送测试仅限**组管理员与实例管理员**，其他角色返回 403；所有管理及测试操作均写入审计日志（`webhook.create`、`webhook.update`、`webhook.delete`、`webhook.test`），不记录明文地址与密钥。
- **持久化队列与限制**：投递任务在事务提交时原子写入平台库 `webhook_jobs` 表（外部 PG 多副本架构详见[部署与配置](deployment.md#ha)），重启或单副本离线不丢队列；不支持经由 HTTP 代理发送；更改 `DOWEL_SECRET` 后原有地址与密钥会显示“无法解密”，需重新编辑保存。
