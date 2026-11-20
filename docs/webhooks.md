# 组级 Webhook

组管理员可以给组配置 Webhook：组里的项目有执行申请、审批结果、执行结束时，Dowel 把通知发到钉钉、飞书、企业微信、Slack 的群机器人，或者你自己的接收服务。本页说明怎么配置、各格式的报文、怎么校验签名、出站限制、重试与投递记录，以及已知限制。

## 配置

在**组首页 → Webhook**（只有组管理员和实例管理员能看到这一节）点“新建 Webhook”：

| 项           | 说明                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称         | 给自己看的名字，例如“DBA 群”                                                                                                                            |
| 格式         | 通用 JSON / 钉钉机器人 / 飞书机器人 / 企业微信机器人 / Slack                                                                                            |
| Webhook 地址 | 机器人或接收服务的地址，只能是 `http://` 或 `https://`，并且要通过[出站限制](#出站限制)                                                                 |
| 签名密钥     | 可选。通用 JSON 用它算 `X-Dowel-Signature`；钉钉填“加签”的 `SEC…` 密钥；飞书填“签名校验”的密钥。企业微信和 Slack 不签名（密钥就在地址里），不显示这一项 |
| 订阅的事件   | 至少一个，见下表                                                                                                                                        |
| 启用         | 停用后不再发送（“发送测试”仍然可以用）                                                                                                                  |

**地址和密钥保存后不再显示。** 地址里常常带着令牌（钉钉的 `access_token`、企业微信的 `key`、Slack 的整段路径），所以列表里只显示协议和主机（例如 `https://oapi.dingtalk.com/…`），密钥只显示“已设置”。编辑时地址和密钥留空表示不改；要去掉密钥，勾选“清除签名密钥”。两者在 Dowel 的平台库里用 `DOWEL_SECRET` 加密保存，接口响应、审计日志、投递记录里都不会出现。

可订阅的事件：

| 事件                  | 什么时候发                                       |
| --------------------- | ------------------------------------------------ |
| `request.created`     | 有人提交了执行申请                               |
| `request.approved`    | 申请的所有审批环节都通过了，等待执行             |
| `request.rejected`    | 申请被驳回                                       |
| `request.withdrawn`   | 申请人撤回了申请                                 |
| `request.invalidated` | 申请失效（环境状态变了、审批流程变严了……）或过期 |
| `request.executed`    | 申请执行结束（成功或失败）                       |
| `execution.finished`  | 不经申请的直接执行 / 回滚结束（成功或失败）      |
| `emergency.executed`  | 实例管理员的紧急执行（绕过审批）结束             |

消息里只有项目、环境、版本、人名、状态和原因这类信息，不含连接串、密码；发送前所有文字还会统一脱敏一次。

## 发送测试

每个 Webhook 右侧有“发送测试”：立刻发一条“Dowel Webhook 测试”消息（事件类型是 `test`，正文说明来自哪个组），**只尝试一次、不重试**，结果直接显示在这一行下面，同时记进投递记录。适合在保存后确认地址、密钥、机器人的关键词 / IP 白名单设置都对。

## 各格式的报文

所有请求都是 `POST`，`Content-Type: application/json`，`User-Agent: Dowel-Webhook`。

### 通用 JSON

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

- `id`：投递 ID。同一个事件的多次重试 `id` 相同，接收方可以用它去重。
- `text`：给人看的正文，每段一行，用了 Markdown 的 `**粗体**` 和 `` `代码` ``。
- `url`：详情页地址（实例设置了 `DOWEL_PUBLIC_URL` 时才有），否则是 `null`。
- `data`：结构化信息，字段随事件不同。

请求头：

| 头                  | 内容                                                  |
| ------------------- | ----------------------------------------------------- |
| `X-Dowel-Event`     | 事件类型（同 `type`）                                 |
| `X-Dowel-Delivery`  | 投递 ID（同 `id`）                                    |
| `X-Dowel-Timestamp` | 发送时间，Unix 秒                                     |
| `X-Dowel-Signature` | 设置了签名密钥时才有：`sha256=<十六进制 HMAC-SHA256>` |

签名的计算方式：`HMAC-SHA256(key = 签名密钥, msg = "<X-Dowel-Timestamp>.<原始请求体>")`，十六进制小写。**一定要用收到的原始字节计算**，不要先解析 JSON 再序列化。

Node.js 校验示例：

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

/** rawBody：原始请求体（Buffer 或字符串）；headers：小写的请求头 */
export const verifyDowel = (rawBody, headers, secret, maxAgeSeconds = 300) => {
  const ts = headers['x-dowel-timestamp'];
  const sig = headers['x-dowel-signature'] ?? '';
  // 拒绝过旧的请求，防重放
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > maxAgeSeconds) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
```

Python 校验示例：

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

### 钉钉自定义机器人

`{ "msgtype": "markdown", "markdown": { "title": 标题, "text": 正文 } }`。设置了签名密钥（机器人安全设置选“加签”）时，地址上追加 `timestamp`（毫秒）和 `sign`，`sign = urlencode(base64(HMAC-SHA256(key = 密钥, msg = "<timestamp>\n<密钥>")))`，和钉钉文档一致。如果机器人用的是“自定义关键词”，关键词要出现在消息里（例如设成 `Dowel`）。钉钉返回 `errcode` 不为 0 时算失败。

### 飞书自定义机器人

`{ "msg_type": "text", "content": { "text": 正文 } }`（纯文本，去掉了粗体 / 代码标记）。设置了签名密钥（开启“签名校验”）时，请求体里加 `timestamp`（秒，字符串）和 `sign = base64(HMAC-SHA256(key = "<timestamp>\n<密钥>", msg = 空))`，和飞书文档一致。返回的 `code`（旧版接口是 `StatusCode`）不为 0 时算失败。

### 企业微信群机器人

`{ "msgtype": "markdown", "markdown": { "content": 正文 } }`，不签名（地址里的 `key` 就是密钥）。返回 `errcode` 不为 0 时算失败。

### Slack

Incoming webhook：`{ "text": 正文 }`（mrkdwn，`**粗体**` 转成 `*粗体*`，`& < >` 已转义），不签名。

## 出站限制

Webhook 是服务端替你发出去的请求，为了不被用来访问内网（SSRF），**默认只允许发往公网地址**。以下地址一律拒绝：回环（127.0.0.0/8、::1）、私有地址（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16）、链路本地（169.254.0.0/16，含云服务器的元数据地址；fe80::/10）、运营商级 NAT（100.64.0.0/10）、IPv6 唯一本地地址（fc00::/7）、0.0.0.0/8 和未指定地址、组播、保留和文档示例地址，以及这些地址的 IPv4-mapped 等 IPv6 写法。

- 保存时会解析地址里的主机名并检查，不通过时返回 422 并说明原因。
- **每次发送时都会重新检查**：在真正建立连接时检查 DNS 解析出的每一个地址，所以“保存时解析到公网、发送时解析到内网”（DNS 重绑定）也会被拒绝，投递记录里写明原因。
- **不跟随重定向**：接收端返回 3xx 算失败（“不跟随重定向”），请填写最终的地址。

**内网的接收服务**由实例管理员在**管理后台 → 实例设置 → Webhook 出站允许列表**里额外放行，一行一项：

- CIDR，例如 `10.1.2.0/24`；
- IP，例如 `10.1.2.3`；
- 主机名，例如 `hooks.internal`：按名字匹配，写进来就表示信任它的解析结果。

这份列表和“允许连接的地址（connection_allowlist）”是两回事：后者限制服务端能连哪些**数据库**，空表示不限制；Webhook 出站允许列表是在“只允许公网”之外**额外放行**的地址，空表示只允许公网。

## 重试与投递记录

- 一次尝试最多 5 秒（连接、发送、读响应合计），超时算失败。
- **会重试的失败**：网络错误（连不上、连接被重置）、超时、HTTP 429、5xx。最多重试 3 次（共 4 次），分别等 2 秒、8 秒、32 秒。
- **不重试的失败**：其他 4xx（地址或令牌不对）、3xx、出站限制拒绝、钉钉 / 飞书 / 企业微信在 HTTP 200 里返回的错误码（签名不对、关键词不匹配等）——重试也一样失败。
- 每次尝试都会记一条投递记录：时间、事件、第几次、状态码、耗时、结果和失败原因。同一事件的重试共用一个投递 ID。每个 Webhook 只保留**最近 50 条**。点每行的“投递记录”图标查看；列表上显示最近一次投递的结果。
- 失败原因里不会出现地址的路径和查询参数（令牌常在里面）。

## 权限与审计

- 查看、新建、修改、删除 Webhook，查看投递记录、发送测试：组管理员和实例管理员。组成员和其他人看不到这一节，接口返回 403。
- 审计日志记录 `webhook.create`、`webhook.update`、`webhook.delete`、`webhook.test`，内容是组、名称、格式、订阅的事件、是否改了地址 / 密钥，不含地址和密钥本身。

## 限制

- **投递队列在 Dowel 服务进程的内存里。** 服务重启时，还没发出去的通知和排着的重试会丢失（站内收件箱和审计日志里的记录不受影响）。Webhook 是尽力而为的通知，不要依赖它做必须送达的流程。
- 目前按单进程部署设计；多个 Dowel 进程同时运行时，每个进程只发自己产生的事件。
- 不支持经 HTTP 代理发送。
- 修改实例的 `DOWEL_SECRET` 后，已保存的 Webhook 地址和密钥无法解密（列表里显示“无法解密”，投递失败），需要重新填写。
