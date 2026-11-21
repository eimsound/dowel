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

export type ChainProblemCode = 'number_gap' | 'parent_broken' | 'checksum_mismatch';

export interface ChainProblem {
  code: ChainProblemCode;
  /** 出问题的版本 */
  versionId: string;
  message: string;
}

/**
 * 校验版本链：number 连续、parent 指向上一个版本（第一个版本为空）、
 * 每行重新算的 checksum 与存储值一致。返回问题列表（空数组表示链是完整的）。
 */
export const verifyChain = (rows: HistoryVersionRow[]): ChainProblem[] => {
  const sorted = [...rows].sort((a, b) => a.number - b.number);
  const out: ChainProblem[] = [];
  const start = sorted[0]?.number === 1 ? 1 : 0;
  for (const [i, r] of sorted.entries()) {
    if (r.number !== start + i)
      out.push({
        code: 'number_gap',
        versionId: r.versionId,
        message: `版本 ${r.name} 的 number 是 ${r.number}，链上这个位置应该是 ${start + i}`,
      });
    const expectedParent = i === 0 ? null : sorted[i - 1]!.versionId;
    if (r.parentId !== expectedParent)
      out.push({
        code: 'parent_broken',
        versionId: r.versionId,
        message:
          i === 0
            ? `链上第一个版本 ${r.name} 不应该有 parent（现在是 ${r.parentId ?? '空'}）`
            : `版本 ${r.name} 的 parent 是 ${r.parentId ?? '空'}，应该指向上一个版本 ${expectedParent}`,
      });
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
