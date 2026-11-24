// 多环境合并（接手，ADR 0013）：每个环境的目标库里都有一份 dowel 历史，按版本 ID 合并成同一棵版本树。
//
// 规则：
// - 每个环境自己的历史先过 verifyChain（版本号唯一、单根合法父链树、**冻结脚本按内容重算校验和**）；
// - 同一个版本 ID 在各环境里的内容必须一致（checksum、模型、序号、parent、名字、schema 范围），否则 history_conflict；
// - 同一父版本下的不同子版本允许共存（对应已作废的岔路）；仅多个根或同号不同 versionId 判 history_fork；
// - 从根到全局最大编号的唯一路径自动识别为活跃主链，其余岔路自动识别为已作废。
// 纯函数，不读任何库：输入是各环境读出来的 TargetState。
import { stableJson } from '@dowel/core';
import { activePath, type HistoryVersionRow, indexTree, routeBetween, verifyChain } from '@dowel/engines';

import { ExecutorError } from './errors.ts';
import type { TargetState } from './state.ts';

export interface MergeSource {
  /** 环境名（只用于错误说明） */
  name: string;
  state: TargetState;
}

export interface MergedHistory {
  /** 合并后的版本树，按 number 升序 */
  versions: HistoryVersionRow[];
  /** 活跃主链上的版本 ID（从根到全局最大编号，升序） */
  active: string[];
  /** 活跃主链之外的岔路版本 ID（接手后在平台库写上 retired_at） */
  retired: string[];
  /** 每个来源环境：它的当前版本、是否停在已作废岔路上、距离活跃链头还差几个升级步骤 */
  envs: { name: string; current: string | null; behind: number; onRetired: boolean }[];
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
  // 3. 分叉判定（ADR 0013）：允许同一父版本下共存不同子版本（已作废岔路），仅多个根或同号不同 versionId 判 history_fork
  const roots: { row: HistoryVersionRow; env: string }[] = [];
  const byNumber = new Map<number, { row: HistoryVersionRow; env: string }>();
  for (const entry of byId.values()) {
    if (entry.row.parentId === null) {
      roots.push(entry);
      if (roots.length > 1) {
        const [a, b] = roots as [
          { row: HistoryVersionRow; env: string },
          { row: HistoryVersionRow; env: string },
        ];
        throw new ExecutorError(
          'history_fork',
          `环境“${a.env}”和“${b.env}”的历史有不同的起点（${label(a.row)} 和 ${label(b.row)}），它们不是同一个项目的历史`,
        );
      }
    }
    const seen = byNumber.get(entry.row.number);
    if (seen && seen.row.versionId !== entry.row.versionId)
      throw new ExecutorError(
        'history_fork',
        `链分叉了：环境“${seen.env}”和“${entry.env}”在 v${entry.row.number} 处有不同的版本（${label(seen.row)} 与 ${label(entry.row)}），无法合并`,
      );
    byNumber.set(entry.row.number, entry);
  }
  // 4. 合并后的并集必须是一棵合法的版本树
  const versions = [...byId.values()].map((x) => x.row).sort((a, b) => a.number - b.number);
  const problems = verifyChain(versions);
  if (problems.length)
    throw new ExecutorError('history_broken', `合并后的版本链不完整：${problems[0]!.message}`, {
      problems: problems.map((p) => p.message),
    });
  // 5. 识别活跃主链与已作废岔路
  const nodes = versions.map((v) => ({ id: v.versionId, number: v.number, parentId: v.parentId }));
  const tree = indexTree(nodes);
  const activeNodes = activePath(nodes);
  const active = activeNodes.map((n) => n.id);
  const activeSet = new Set(active);
  const retired = versions.filter((v) => !activeSet.has(v.versionId)).map((v) => v.versionId);
  const activeHead = activeNodes.at(-1) ?? null;
  return {
    versions,
    active,
    retired,
    envs: sources.map((s) => {
      const cur = s.state.current;
      const onRetired = cur !== null && !activeSet.has(cur);
      const behind =
        cur === null
          ? active.length
          : activeHead
            ? (routeBetween(tree, cur, activeHead.id)?.up.length ?? 0)
            : 0;
      return { name: s.name, current: cur, behind, onRetired };
    }),
  };
};
