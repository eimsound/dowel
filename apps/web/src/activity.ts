// 审计动作的中文描述：项目动态（ActivityList）和后台审计日志共用一份映射，
// 键是 i18n 里的 act.<action>（动作名在服务端是 `领域.动作`，见 audit-coverage.test.ts）。
// 没登记的动作显示“执行了一个操作”，不把英文动作名直接抛给用户。
import i18n from './i18n.ts';

/**
 * 审计数据里的版本号 → `v5` / `v4–v6`（作废、取消作废、应用到画布）：
 * 接受 numbers: number[]，或 versions / retired / restored: { number }[]，或单个 number
 */
const rangeOf = (d: Record<string, unknown>): string => {
  const nums: number[] = [];
  for (const k of ['numbers', 'versions', 'retired', 'restored'])
    if (Array.isArray(d[k]))
      for (const x of d[k] as unknown[]) {
        const n = typeof x === 'number' ? x : (x as { number?: unknown } | null)?.number;
        if (typeof n === 'number') nums.push(n);
      }
  if (!nums.length && typeof d.number === 'number') nums.push(d.number);
  if (!nums.length) return '';
  nums.sort((a, b) => a - b);
  return nums.length === 1 ? `v${nums[0]}` : i18n.t('vl.range', { from: nums[0], to: nums[nums.length - 1] });
};

export const actionText = (action: string, data: unknown) => {
  const d = (data ?? {}) as Record<string, unknown>;
  const key = `act.${action}`;
  if (!i18n.exists(key)) return i18n.t('act.unknown');
  const environment = typeof d.environment === 'string' ? d.environment.trim() : '';
  const name = typeof d.name === 'string' ? d.name : environment;
  return i18n.t(key, {
    name,
    environment,
    ...(environment ? { context: 'env' } : {}),
    count: typeof d.objects === 'number' ? d.objects : typeof d.opCount === 'number' ? d.opCount : 0,
    role: typeof d.role === 'string' ? i18n.t(`projects.role.${d.role}`) : '',
    username: typeof d.username === 'string' ? d.username : '',
    provider: typeof d.provider === 'string' ? d.provider : '',
    to: typeof d.to === 'string' ? d.to : '',
    range: rangeOf(d),
  });
};

/** 通过 MCP 令牌发生的操作（M3-C）：审计 data.via = 'mcp'，界面加“MCP”标记 */
export const viaMcp = (data: unknown): boolean =>
  !!data && typeof data === 'object' && (data as Record<string, unknown>).via === 'mcp';
