// 当前打开的模型页里的表：命令面板要能搜到“当前项目模型里的表”。
// 模型状态在 workspace.ts 的 Workspace 实例里（只在模型页存在），这里用一个可订阅的小 store 转交给外壳，
// 避免把整个 WebSocket 状态放进 React 上下文（命令面板也用在组页、我的项目页）。
//
// 之所以要“可订阅”：命令面板在模型页之前就挂载了，新建一张表时如果只是读一次数组，
// 面板里的列表不会更新（useMemo 也不会知道该重算）。
import type { Model } from '@dowel/core';
import { useSyncExternalStore } from 'react';

export interface TableEntry {
  id: string;
  name: string;
  schema: string;
}

/** 没有表时返回同一个空数组：useSyncExternalStore 要求快照引用稳定 */
const EMPTY: TableEntry[] = [];

let current: { pid: string; tables: TableEntry[] } | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const fn of listeners) fn();
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** 模型页拿到新模型时调用；离开模型页时用 clearTables 清空 */
export const setCurrentTables = (pid: string, model: Model) => {
  const tables: TableEntry[] = [];
  for (const o of Object.values(model.objects)) {
    if (o.kind !== 'table') continue;
    const parent = model.objects[o.parent];
    tables.push({ id: o.id, name: o.name, schema: parent?.kind === 'schema' ? parent.name : '' });
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
  current = { pid, tables };
  emit();
};

export const clearTables = (pid: string) => {
  if (current?.pid !== pid) return;
  current = null;
  emit();
};

/** 只返回属于这个项目的表；不在模型页时为空（不在模型页就不搜表） */
export const tablesOf = (pid: string | undefined): TableEntry[] =>
  pid && current?.pid === pid ? current.tables : EMPTY;

/** 命令面板用：订阅当前项目的表清单，模型页里新建 / 删除表时跟着更新 */
export const useCurrentTables = (pid: string | undefined): TableEntry[] =>
  useSyncExternalStore(subscribe, () => tablesOf(pid));

/** 命令面板选中一张表：模型页监听这个事件把它选中（不新增路由参数） */
export const SELECT_TABLE_EVENT = 'dowel:select-table';

export const selectTable = (id: string) =>
  window.dispatchEvent(new CustomEvent<string>(SELECT_TABLE_EVENT, { detail: id }));
