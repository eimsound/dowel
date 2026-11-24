// 方言无关的迁移历史公共工具：格式版本、校验和、版本链完整性验证。
import { canonicalSteps, type ScriptStep, stepsChecksum } from './steps.ts';
import { HistoryError, type HistoryVersionRow } from './types.ts';

export const HISTORY_FORMAT = 1;

export const EMPTY_STEPS: ScriptStep[] = [];

export const readSteps = (value: unknown): ScriptStep[] => {
  if (value === null || value === undefined) return EMPTY_STEPS;
  if (!Array.isArray(value)) throw new HistoryError('invalid_steps', '冻结脚本不是数组');
  return canonicalSteps(value as ScriptStep[]);
};

export type ChainProblemCode =
  /** 同一个编号出现了两次（不同的 version_id） */
  | 'number_duplicate'
  /** 不止一个根（parent 为空的版本），或根不是编号最小的版本 */
  | 'root_multiple'
  /** parent 指向不存在的版本、或指向编号不小于自己的版本 */
  | 'parent_broken'
  | 'checksum_mismatch';

export interface ChainProblem {
  code: ChainProblemCode;
  /** 出问题的版本 */
  versionId: string;
  message: string;
}

/**
 * 校验版本树（ADR 0013）：版本号唯一、只有一个根且根编号最小、每个非根版本的 parent 存在且编号更小
 * （即“版本号唯一递增 + 合法父链树”）、每行重新算的 checksum 与存储值一致。
 * 编号可以有空缺（作废的版本可能从没写进这个目标库），同一个 parent 下可以有多个子版本（已作废的岔路）；
 * 根到最大编号的路径即活跃主链（见 version-tree.ts）。返回问题列表（空数组表示完整）。
 */
export const verifyChain = (rows: HistoryVersionRow[]): ChainProblem[] => {
  const sorted = [...rows].sort((a, b) => a.number - b.number);
  const out: ChainProblem[] = [];
  const byId = new Map(sorted.map((r) => [r.versionId, r]));
  const byNumber = new Map<number, HistoryVersionRow>();
  let root: HistoryVersionRow | null = null;
  for (const [i, r] of sorted.entries()) {
    const dup = byNumber.get(r.number);
    if (dup && dup.versionId !== r.versionId)
      out.push({
        code: 'number_duplicate',
        versionId: r.versionId,
        message: `版本 ${r.name} 的 number ${r.number} 和版本 ${dup.name} 重复`,
      });
    else byNumber.set(r.number, r);
    if (r.parentId === null) {
      if (root || i !== 0)
        out.push({
          code: 'root_multiple',
          versionId: r.versionId,
          message: root
            ? `版本 ${r.name} 和 ${root.name} 都没有 parent：历史有不止一个起点`
            : `版本 ${r.name} 没有 parent，但它不是编号最小的版本`,
        });
      root ??= r;
    } else {
      const parent = byId.get(r.parentId);
      if (!parent || parent.number >= r.number)
        out.push({
          code: 'parent_broken',
          versionId: r.versionId,
          message: parent
            ? `版本 ${r.name} 的 parent ${parent.name} 的编号（${parent.number}）不比它小（${r.number}）`
            : i === 0
              ? `链上第一个版本 ${r.name} 不应该有 parent（现在是 ${r.parentId}）`
              : `版本 ${r.name} 的 parent ${r.parentId} 不在历史里`,
        });
    }
    const checksum = stepsChecksum(r.upSteps, r.downSteps);
    if (checksum !== r.checksum)
      out.push({
        code: 'checksum_mismatch',
        versionId: r.versionId,
        message: `版本 ${r.name} 的冻结脚本和校验和不符（存储 ${r.checksum.slice(0, 12)}…，重算 ${checksum.slice(0, 12)}…）`,
      });
  }
  return out;
};
