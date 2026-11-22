# Group webhooks

Group admins can configure webhooks on the group home page so Dowel sends HTTP notifications for execution requests, approvals, direct executions, emergency executions, and CI token runs to DingTalk, Feishu, WeCom, Slack, or custom HTTP endpoints.

## Configuration and events {#configuration}

Open Webhooks on the group home page (visible to group admins and instance admins only) and click New webhook:

| Field          | Description                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name           | Descriptive label such as "Core DBA alerts"                                                                                                                                                                    |
| Format         | Generic JSON, DingTalk bot, Feishu bot, WeCom bot, or Slack                                                                                                                                                    |
| Webhook URL    | Receiver URL using `http://` or `https://`, validated against [outbound restrictions](#outbound-restrictions) on save and before every delivery                                                                |
| Signing secret | Optional. Generates `X-Dowel-Signature` for Generic JSON, sets `SEC...` signing on DingTalk, or sets signature verification on Feishu. Hidden for WeCom and Slack because their URLs carry the embedded secret |
| Events         | At least one subscribed event from the table below                                                                                                                                                             |
| Enabled        | Disabling stops automatic deliveries while keeping manual Send test available                                                                                                                                  |

**URLs and signing secrets are write-only.** Because DingTalk `access_token`, WeCom `key`, and Slack URLs contain credentials, lists show only the scheme and host (such as `https://oapi.dingtalk.com/...`) and secrets show as set. Leave either field blank when editing to preserve the existing value, or check Clear signing secret to remove the secret. Dowel encrypts both with `DOWEL_SECRET` and omits them from API responses, audit logs, and delivery logs.

| Event                 | Trigger                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `request.created`     | A new execution request is submitted                                                                                   |
| `request.approved`    | All approval stages passed and the request awaits execution                                                            |
| `request.rejected`    | An execution request is rejected                                                                                       |
| `request.withdrawn`   | The requester withdrew the request                                                                                     |
| `request.invalidated` | The request became invalid due to environment or policy changes, or expired                                            |
| `request.executed`    | Execution triggered by an execution request finished (succeeded or failed)                                             |
| `execution.finished`  | A direct execution or rollback without approval finished (succeeded or failed)                                         |
| `emergency.executed`  | An instance admin's emergency execution finished                                                                       |
| `token.executed`      | A CI token execution finished (succeeded or failed, including `noop`; dry runs and pre-check failures emit no webhook) |

Payloads contain only project, environment, version numbers, actor names, status, and scrubbed result summaries without connection strings or passwords.

## Test delivery {#test-delivery}

Click Send test on any webhook row to send a synchronous `type: "test"` event immediately. Test deliveries **try once without entering the retry queue**, display the result directly, and log an entry so you can verify connectivity, signatures, bot keywords, and IP allowlists before enabling traffic.

## Payload formats and signature verification {#payload-formats}

Every outbound request uses HTTP `POST` with `Content-Type: application/json` and `User-Agent: Dowel-Webhook`.

### Generic JSON {#format-json}

```json
{
  "id": "0193…",
  "type": "request.created",
  "at": "2026-11-20T08:00:00.000Z",
  "title": "New execution request",
  "text": "**Alice** requested execution to v3 on `prod`\nReason: release",
  "url": "https://dowel.example.com/…",
  "data": { "project": "shop", "environment": "prod" }
}
```

- `id` is the delivery identifier, which stays identical across retries of the same event for idempotent deduplication.
- `text` is a human-readable summary.
- `url` links to the detail page when `DOWEL_PUBLIC_URL` is configured, or `null` otherwise.
- `data` provides structured metadata specific to each event type.

Custom headers sent on Generic JSON requests:

| Header              | Value                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| `X-Dowel-Event`     | Event type matching `type`                                               |
| `X-Dowel-Delivery`  | Delivery ID matching `id`                                                |
| `X-Dowel-Timestamp` | Unix timestamp in seconds when sent                                      |
| `X-Dowel-Signature` | Sent when a signing secret is set (`sha256=<lowercase hex HMAC-SHA256>`) |

Compute the HMAC over `"<X-Dowel-Timestamp>.<raw-request-body-bytes>"` using the exact raw HTTP body bytes and verify with a constant-time comparison function.

=== "Node.js verification example"

    ```js
    import { createHmac, timingSafeEqual } from 'node:crypto';

    /** rawBody: raw HTTP body (Buffer or string); headers: lowercase request headers */
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

=== "Python verification example"

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

### DingTalk bot {#format-dingtalk}

Sends `{ "msgtype": "markdown", "markdown": { "title": title, "text": text } }`. When a signing secret is configured, Dowel appends `timestamp` (milliseconds) and `sign = urlencode(base64(HMAC-SHA256(key = secret, msg = "<timestamp>\n<secret>")))` to the query string. If the bot uses custom keyword security, include the keyword in your group name or message text (such as `Dowel`). Non-zero `errcode` responses count as failures.

### Feishu bot {#format-feishu}

Sends `{ "msg_type": "text", "content": { "text": text } }`. When a signing secret is configured, the JSON body adds `timestamp` (seconds as a string) and `sign = base64(HMAC-SHA256(key = "<timestamp>\n<secret>", msg = ""))`. Non-zero `code` (or legacy `StatusCode`) responses count as failures.

### WeCom bot {#format-wecom}

Sends `{ "msgtype": "markdown", "markdown": { "content": text } }` without an extra signature because the URL `key` carries authentication. Non-zero `errcode` responses count as failures.

### Slack {#format-slack}

Sends an Incoming Webhook payload `{ "text": text }`. Dowel converts `**bold**` to Slack `*bold*`, escapes `&`, `<`, and `>`, and omits any signature.

## Outbound SSRF restrictions {#outbound-restrictions}

To prevent webhooks from probing internal networks, **Dowel permits public addresses only by default**. Blocked ranges include loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16` including cloud metadata IPs, `fe80::/10`), carrier-grade NAT (`100.64.0.0/10`), IPv6 unique local (`fc00::/7`), `0.0.0.0/8`, unspecified, multicast, reserved ranges, and IPv4-mapped IPv6 equivalents.

- **Checked on save and before connect.** Saving a webhook checks resolved host IPs and returns `422` if disallowed. Before every outbound TCP connection, a custom DNS lookup checks every resolved IP again to prevent DNS rebinding attacks.
- **No redirects.** HTTP `3xx` redirect responses count as delivery failures; enter the final destination URL.

To notify internal bots or private receivers, an instance admin can add trusted CIDR ranges, single IPs, or exact hostnames to the Webhook egress allowlist (`webhook_allowlist`) on the Instance settings page under Admin. This list applies solely to webhooks and stays separate from database [`connection_allowlist`](deployment.md#connection-allowlist).

## Retries and delivery logs {#retries-and-logs}

- Each outbound HTTP request times out after 5 seconds covering connect, write, and response read.
- **Retryable failures.** Network timeouts or errors, HTTP `429`, and HTTP `5xx` retry up to 3 times (4 total attempts) with backoff delays of 2 seconds, 8 seconds, and 32 seconds.
- **Non-retryable failures.** Other `4xx` responses, `3xx` redirects, allowlist blocks, and non-zero business error codes from DingTalk, Feishu, or WeCom do not retry.
- Each webhook keeps the latest **50** delivery records containing timestamp, event type, attempt number, HTTP status code, duration, and scrubbed failure details with URL paths and query parameters stripped.

## Permissions, auditing, and queue limits {#permissions-and-limits}

- **Permissions and audit trail.** Viewing, editing, testing, and reading delivery logs are restricted to group admins and instance admins (`403` otherwise). Create, update, delete, and test actions emit audit logs (`webhook.create`, `webhook.update`, `webhook.delete`, `webhook.test`) without storing plaintext URLs or secrets.
- **Persistent queue and limits.** Delivery jobs insert atomically into `webhook_jobs` inside the business transaction (for active-active external PostgreSQL HA details, see [Deployment and configuration](deployment.md#ha)), so restarts or replica loss drop no events. HTTP outbound proxies are not supported. Rotating `DOWEL_SECRET` renders existing URLs and secrets undecryptable until edited and saved again.
