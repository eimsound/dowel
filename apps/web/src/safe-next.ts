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

/** 重定向回跳禁止落地的认证页面路径前缀 */
export const AUTH_NEXT_EXCLUDES = ['/login', '/change-password', '/setup'] as const;

/** 额外过滤禁止落点的站内路径前缀（如 /login、/change-password、/setup） */
export const safeNextPath = (
  next: string | undefined,
  disallow: readonly string[] = [],
  origin = FALLBACK_ORIGIN,
): string | null => {
  const safe = safeNext(next, origin);
  if (!safe) return null;
  const pathname = new URL(safe, origin).pathname;
  if (disallow.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return '/';
  return safe;
};
