// 登录后的站内跳转校验。规则与服务端 oidc.ts 的 safeNext 相同：
// 先用当前 origin 规范化（折叠 `..`、解码 `%2e`、把反斜杠当协议分隔符），
// 再要求 origin 不变、路径以单个 `/` 开头、第二个字符不是 `/` 或 `\`；不合规回退到 `/`。
const FALLBACK_ORIGIN = typeof location === 'undefined' ? 'http://dowel.invalid' : location.origin;

export const safeNext = (next: string | undefined, origin = FALLBACK_ORIGIN): string | null => {
  if (!next) return null;
  let u: URL;
  try {
    u = new URL(next, origin);
  } catch {
    return '/';
  }
  const normalized = `${u.pathname}${u.search}${u.hash}`;
  if (
    u.origin !== origin ||
    !normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    normalized[1] === '\\'
  )
    return '/';
  return normalized;
};
