// 多环境合并（接手）：每个环境的目标库里都有一份 dowel 历史，按版本 ID 合并成同一条链。
//
// 规则：
// - 每个环境自己的历史先过 verifyChain（序号连续、parent 衔接、**冻结脚本按内容重算校验和**）；
// - 同一个版本 ID 在各环境里的内容必须一致（checksum、模型、序号、parent、名字、schema 范围），否则 history_conflict；
// - 链分叉（两个环境在同一个父版本下有不同的子版本）报 history_fork，不合并；
// - 一个环境落后、另一个领先是允许的：合并后的链取最长的那条（没有分叉时就是并集），
//   每个环境各自记录当前版本。
// 纯函数，不读任何库：输入是各环境读出来的 TargetState。
import { stableJson } from '@dowel/core';
import { type HistoryVersionRow, verifyChain } from '@dowel/engines';
import { ExecutorError } from './errors.ts';
import type { TargetState } from './state.ts';

export interface MergeSource {
  /** 环境名（只用于错误说明） */
  name: string;
  state: TargetState;
}

export interface MergedHistory {
  /** 合并后的版本链，按 number 升序 */
  versions: HistoryVersionRow[];
  /** 每个来源环境：它的当前版本（目标库历史里最后完成的版本）和落后合并链头几个版本 */
  envs: { name: string; current: string | null; behind: number }[];
}

const label = (r: HistoryVersionRow) => `v${r.number}「${r.name}」`;

/** 同一个版本 ID 在两个环境里的内容比较：不一致时返回哪一项 */
const diffField = (a: HistoryVersionRow, b: HistoryVersionRow): string | null => {
  if (a.checksum !== b.checksum) return 'checksum（冻结脚本）';
  if (stableJson(a.model) !== stableJson(b.model)) return '模型';
  if (a.number !== b.number) return '序号';
  if (a.parentId !== b.parentId) return 'parent';
  if (a.name !== b.name) return '名字';
  if (stableJson(a.scope) !== stableJson(b.scope)) return 'schema 范围';
  return null;
};

export const mergeHistories = (sources: MergeSource[]): MergedHistory => {
  if (!sources.length) throw new ExecutorError('history_missing', '没有可合并的环境');
  // 1. 每个环境自己的历史：存在、完整、当前版本在它自己的链上
  for (const s of sources) {
    if (!s.state.historyExists || !s.state.versions.length)
      throw new ExecutorError('history_missing', `环境“${s.name}”的目标库里没有这个项目的迁移历史`);
    const problems = verifyChain(s.state.versions);
    if (problems.length)
      throw new ExecutorError(
        'history_broken',
        `环境“${s.name}”的目标库里的迁移历史不完整或被改动过：${problems[0]!.message}。出于安全，已拒绝接手`,
        { problems: problems.map((p) => p.message) },
      );
    if (s.state.current && !s.state.versions.some((v) => v.versionId === s.state.current))
      throw new ExecutorError(
        'history_broken',
        `环境“${s.name}”的历史里当前版本 ${s.state.current} 不在它自己的版本记录里`,
      );
  }
  // 2. 按版本 ID 合并，内容必须一致
  const byId = new Map<string, { row: HistoryVersionRow; env: string }>();
  for (const s of sources)
    for (const row of s.state.versions) {
      const seen = byId.get(row.versionId);
      if (!seen) {
        byId.set(row.versionId, { row, env: s.name });
        continue;
      }
      const field = diffField(seen.row, row);
      if (field)
        throw new ExecutorError(
          'history_conflict',
          `版本 ${label(row)} 在环境“${seen.env}”和“${s.name}”的历史里内容不一致（${field}不同），不能合并`,
        );
    }
  // 3. 分叉：同一个父版本下不能有两个不同的子版本（根也只能有一个）
  const children = new Map<string | null, HistoryVersionRow[]>();
  for (const { row } of byId.values()) {
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  for (const [parent, list] of children)
    if (list.length > 1) {
      const [a, b] = list as [HistoryVersionRow, HistoryVersionRow];
      const ea = byId.get(a.versionId)!.env;
      const eb = byId.get(b.versionId)!.env;
      throw new ExecutorError(
        'history_fork',
        parent === null
          ? `环境“${ea}”和“${eb}”的历史有不同的起点（${label(a)} 和 ${label(b)}），它们不是同一个项目的历史`
          : `链分叉了：环境“${ea}”在 ${label(byId.get(parent)!.row)} 之后是 ${label(a)}，环境“${eb}”之后是 ${label(b)}。分叉的历史不能合并`,
      );
    }
  // 4. 合并后的链必须是一条完整的线
  const versions = [...byId.values()].map((x) => x.row).sort((a, b) => a.number - b.number);
  const problems = verifyChain(versions);
  if (problems.length)
    throw new ExecutorError('history_broken', `合并后的版本链不完整：${problems[0]!.message}`, {
      problems: problems.map((p) => p.message),
    });
  const index = new Map(versions.map((v, i) => [v.versionId, i]));
  return {
    versions,
    envs: sources.map((s) => ({
      name: s.name,
      current: s.state.current,
      behind: s.state.current ? versions.length - 1 - (index.get(s.state.current) ?? -1) : versions.length,
    })),
  };
};
