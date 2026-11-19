// 脱敏：错误消息、报告、写进目标库历史的文本在发给客户端 / 存下来之前统一过一遍。纯函数。

/**
 * 把文本里的连接串密码遮掉：`postgres://user:密码@host/db` → `postgres://user:***@host/db`，
 * 以及 conninfo 写法的 `password=密码`。驱动 / PG 的错误消息里可能带着连接串，发给客户端或存下来之前统一过一遍。
 * 这是全服务端**唯一**的遮密码实现（maskUrl、targets.ts 的 scrubUrl 都调用它，输出格式一致）。
 *
 * userinfo 的匹配：从 `scheme://` 开始，在同一段不含空白、`?`、`#` 的文本里匹配到**最后一个** `@` 为止。
 * - 密码里没转义的 `/`、`@`（base64 密码常带 `/`）能遮住：`postgres://u:ab/cd@h/db`、`postgres://u:p@ss@h/db`。
 * - 不吞掉后面的内容：查询串里的 `@`（`?application_name=a@b`）、错误正文里的 `"a@b"` 都不会被当成 userinfo，
 *   主机、库名和 PG 的真正失败原因保持可读。
 * - 不覆盖：密码里有没转义的空白、`?`、`#`。这类连接串 maskUrl 用 URL 解析遮；
 *   已知连接串的场景（targets.ts 的 scrubUrl）还会把单独出现的密码原文替换掉。
 * 第一个冒号前是用户名，保留；没有冒号（没有密码）的不动。用函数式替换（替换文本里不含 $ 模式）。
 */
export const scrubSecrets = (text: string): string =>
  text
    .replace(
      /(postgres(?:ql)?:\/\/)((?:(?!postgres(?:ql)?:\/\/)[^\s?#])*)@/gi,
      (m, scheme: string, userinfo: string) => {
        const colon = userinfo.indexOf(':');
        return colon < 0 ? m : `${scheme}${userinfo.slice(0, colon)}:***@`;
      },
    )
    .replace(/(password\s*=\s*)('[^']*'|\S+)/gi, (_m, head: string) => `${head}***`);
