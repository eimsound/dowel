// 脱敏：错误消息、报告、写进目标库历史的文本在发给客户端 / 存下来之前统一过一遍。纯函数。

/**
 * 把文本里的连接串密码遮掉：
 * - URL 形式：`postgres(ql)?://`、`mysql2?://`、`mssql://`、`sqlserver://` 中的 `user:密码@` → `user:***@`；
 * - conninfo 写法：`password=密码`；
 * - MSSQL ODBC / ADO 写法：`;Password=密码` / `;Pwd=密码`（以及行首 `Pwd=密码`）。
 *
 * userinfo 的匹配：从 `scheme://` 开始，在同一段不含空白、`?`、`#` 的文本里匹配到**最后一个** `@` 为止。
 * 第一个冒号前是用户名，保留；没有冒号（没有密码）的不动。用函数式替换（替换文本里不含 $ 模式）。
 */
const URL_SCHEMES = '(?:postgres(?:ql)?|mysql2?|mssql|sqlserver):\\/\\/';
const URL_RE = new RegExp(`(${URL_SCHEMES})((?:(?!${URL_SCHEMES})[^\\s?#])*)@`, 'gi');

export const scrubSecrets = (text: string): string =>
  text
    .replace(URL_RE, (m, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(':');
      return colon < 0 ? m : `${scheme}${userinfo.slice(0, colon)}:***@`;
    })
    .replace(
      /((?:^|[;\s])(?:password|pwd)\s*=\s*)('[^']*'|"[^"]*"|[^;\s]+)/gi,
      (_m, head: string) => `${head}***`,
    );
