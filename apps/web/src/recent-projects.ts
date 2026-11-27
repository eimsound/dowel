// 最近访问的项目：保存在 localStorage（dowel.recentProjects），供全局侧边栏上下文切换器使用。
export interface RecentProject {
  owner: string;
  slug: string;
  name: string;
  groupName: string;
  pid?: string;
}

const KEY = 'dowel.recentProjects';
const MAX_RECENT = 6;

const isRecent = (x: unknown): x is RecentProject =>
  !!x &&
  typeof x === 'object' &&
  typeof (x as RecentProject).owner === 'string' &&
  typeof (x as RecentProject).slug === 'string' &&
  typeof (x as RecentProject).name === 'string' &&
  typeof (x as RecentProject).groupName === 'string';

export const getRecentProjects = (): RecentProject[] => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
};

export const recordRecentProject = (item: RecentProject): void => {
  try {
    const current = getRecentProjects();
    const next = [
      item,
      ...current.filter((p) =>
        item.pid && p.pid ? p.pid !== item.pid : !(p.owner === item.owner && p.slug === item.slug),
      ),
    ].slice(0, MAX_RECENT);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 忽略存储受限或序列化异常
  }
};
