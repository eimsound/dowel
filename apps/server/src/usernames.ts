// 用户名的规则（02-consensus.md 11.1）：小写字母、数字、`-`，1～39 位，不能以 `-` 开头或结尾。
// 库里只存小写，比较前一律先 normalizeUsername()。迁移（由邮箱生成用户名）和接口共用这里。

const MAX = 39;

export const normalizeUsername = (username: string) => username.trim().toLowerCase();

/** 清洗成合法用户名：只留 [a-z0-9-]、去掉首尾的 -、截到 39 位；什么都不剩时给 fallback */
export const cleanSlug = (source: string, fallback = 'item'): string => {
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/g, '');
  return base || fallback;
};

export const cleanUsername = (source: string): string => cleanSlug(source, 'user');

/** 由一段文字生成候选 slug / 用户名，重名时加 -2、-3……（后缀也算在 39 位里） */
export const uniqueSlug = (source: string, taken: Set<string>, fallback = 'item') => {
  const base = cleanSlug(source, fallback);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) {
    const suffix = `-${n}`;
    slug = `${base.slice(0, MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
  }
  return slug;
};

/** 用户名与组 / 项目的 slug 是同一套规则 */
export const uniqueUsername = (source: string, taken: Set<string>) => uniqueSlug(source, taken, 'user');
