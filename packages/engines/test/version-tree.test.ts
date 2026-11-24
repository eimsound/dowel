// 版本树纯函数单元测试（ADR 0013）
import { describe, expect, test } from 'vitest';

import {
  activePath,
  indexTree,
  isAncestor,
  maxNumberNode,
  offPathIds,
  pathFromRoot,
  routeBetween,
  routeShape,
  type TreeNode,
} from '../src/index.ts';

const n = (id: string, number: number, parentId: string | null): TreeNode => ({ id, number, parentId });

// 树形结构示例：
// v1 -> v2 -> v3 -> v4 -> v6(active) -> v7(active)
//               \     \-> v5(retired)
//                \-> v3b(number=4? 不，使用唯一递增编号：v1(1) -> v2(2) -> v3(3) -> v4(5) -> v7(7) -> v8(8),
//                    其中 v2 -> v3b(4), v4 -> v5(6) 均已作废)
const sampleTree: TreeNode[] = [
  n('v1', 1, null),
  n('v2', 2, 'v1'),
  n('v3', 3, 'v2'),
  n('v3b', 4, 'v2'),
  n('v4', 5, 'v3'),
  n('v5', 6, 'v4'),
  n('v7', 7, 'v4'),
  n('v8', 8, 'v7'),
];

const simpleFork: TreeNode[] = [
  n('v1', 1, null),
  n('v2', 2, 'v1'),
  n('v3', 3, 'v2'),
  n('v4', 4, 'v3'),
  n('v5', 5, 'v4'),
  n('v6', 6, 'v4'),
];

describe('version-tree 纯函数', () => {
  test('indexTree：按 id 建索引，空输入返回空 Map', () => {
    expect(indexTree([]).size).toBe(0);
    const map = indexTree(simpleFork);
    expect(map.size).toBe(6);
    expect(map.get('v5')).toEqual(n('v5', 5, 'v4'));
  });

  test('maxNumberNode：空返回 null，否则返回编号最大节点（与输入顺序无关）', () => {
    expect(maxNumberNode([])).toBeNull();
    expect(maxNumberNode([n('a', 3, null), n('b', 10, 'a'), n('c', 7, 'a')])?.id).toBe('b');
    expect(maxNumberNode([...simpleFork].reverse())?.id).toBe('v6');
  });

  test('pathFromRoot：线性链、分叉树两端均可追溯到根；缺失或成环返回 null', () => {
    const byId = indexTree(simpleFork);
    expect(pathFromRoot(byId, 'v5')?.map((x) => x.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    expect(pathFromRoot(byId, 'v6')?.map((x) => x.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v6']);
    expect(pathFromRoot(byId, 'v1')?.map((x) => x.id)).toEqual(['v1']);
    expect(pathFromRoot(byId, 'missing')).toBeNull();

    const broken = indexTree([n('v1', 1, null), n('v3', 3, 'missing-parent')]);
    expect(pathFromRoot(broken, 'v3')).toBeNull();

    const selfLoop = indexTree([n('v1', 1, 'v1')]);
    expect(pathFromRoot(selfLoop, 'v1')).toBeNull();

    const cycle = indexTree([n('a', 1, 'b'), n('b', 2, 'a')]);
    expect(pathFromRoot(cycle, 'a')).toBeNull();
  });

  test('activePath 与 offPathIds：空树、单根、线性、单次分叉、多层分叉', () => {
    expect(activePath([])).toEqual([]);
    expect(offPathIds([])).toEqual(new Set());

    const single = [n('v0', 0, null)];
    expect(activePath(single).map((x) => x.id)).toEqual(['v0']);
    expect(offPathIds(single)).toEqual(new Set());

    const linear = [n('v1', 1, null), n('v2', 2, 'v1'), n('v3', 3, 'v2')];
    expect(activePath(linear).map((x) => x.id)).toEqual(['v1', 'v2', 'v3']);
    expect(offPathIds(linear)).toEqual(new Set());

    expect(activePath([...simpleFork].reverse()).map((x) => x.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v6']);
    expect(offPathIds(simpleFork)).toEqual(new Set(['v5']));

    expect(activePath(sampleTree).map((x) => x.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v7', 'v8']);
    expect(offPathIds(sampleTree)).toEqual(new Set(['v3b', 'v5']));
  });

  test('isAncestor：自反性、直接父子、跨代祖先、非祖先、岔路兄弟与缺失节点', () => {
    const byId = indexTree(simpleFork);
    expect(isAncestor(byId, 'v4', 'v4')).toBe(true);
    expect(isAncestor(byId, 'v4', 'v5')).toBe(true);
    expect(isAncestor(byId, 'v4', 'v6')).toBe(true);
    expect(isAncestor(byId, 'v1', 'v6')).toBe(true);
    expect(isAncestor(byId, 'v6', 'v4')).toBe(false);
    expect(isAncestor(byId, 'v5', 'v6')).toBe(false);
    expect(isAncestor(byId, 'v6', 'v5')).toBe(false);
    expect(isAncestor(byId, 'v1', 'missing')).toBe(false);
    expect(isAncestor(byId, 'missing', 'v1')).toBe(false);

    const broken = indexTree([n('v1', 1, null), n('v2', 2, 'ghost')]);
    expect(isAncestor(broken, 'v1', 'v2')).toBe(false);
  });

  test('routeBetween 与 routeShape：空库起跑、同节点、单向升级、单向回滚、跨岔路切换与异常树', () => {
    const byId = indexTree(sampleTree);

    // from === null：从根到目标全部 up
    const fromEmpty = routeBetween(byId, null, 'v7')!;
    expect(fromEmpty.lca).toBeNull();
    expect(fromEmpty.down).toEqual([]);
    expect(fromEmpty.up.map((x) => x.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v7']);
    expect(routeShape(fromEmpty)).toBe('up');

    // from === to：空操作
    const noop = routeBetween(byId, 'v5', 'v5')!;
    expect(noop.lca?.id).toBe('v5');
    expect(noop.down).toEqual([]);
    expect(noop.up).toEqual([]);
    expect(routeShape(noop)).toBe('none');

    // 单向升级
    const up = routeBetween(byId, 'v2', 'v8')!;
    expect(up.lca?.id).toBe('v2');
    expect(up.down).toEqual([]);
    expect(up.up.map((x) => x.id)).toEqual(['v3', 'v4', 'v7', 'v8']);
    expect(routeShape(up)).toBe('up');

    // 单向回滚（编号从大到小）
    const down = routeBetween(byId, 'v5', 'v2')!;
    expect(down.lca?.id).toBe('v2');
    expect(down.down.map((x) => x.id)).toEqual(['v5', 'v4', 'v3']);
    expect(down.up).toEqual([]);
    expect(routeShape(down)).toBe('down');

    // 简单切换：v5 -> v4(LCA) -> v6
    const forkById = indexTree(simpleFork);
    const simpleSwitch = routeBetween(forkById, 'v5', 'v6')!;
    expect(simpleSwitch.lca?.id).toBe('v4');
    expect(simpleSwitch.down.map((x) => x.id)).toEqual(['v5']);
    expect(simpleSwitch.up.map((x) => x.id)).toEqual(['v6']);
    expect(routeShape(simpleSwitch)).toBe('switch');

    // 多跳切换：v3b -> v2(LCA) -> v3 -> v4 -> v7 -> v8
    const multiSwitch = routeBetween(byId, 'v3b', 'v8')!;
    expect(multiSwitch.lca?.id).toBe('v2');
    expect(multiSwitch.down.map((x) => x.id)).toEqual(['v3b']);
    expect(multiSwitch.up.map((x) => x.id)).toEqual(['v3', 'v4', 'v7', 'v8']);
    expect(routeShape(multiSwitch)).toBe('switch');

    // 多跳双向切换：v5 -> v2(LCA) -> v3b
    const reverseMultiSwitch = routeBetween(byId, 'v5', 'v3b')!;
    expect(reverseMultiSwitch.lca?.id).toBe('v2');
    expect(reverseMultiSwitch.down.map((x) => x.id)).toEqual(['v5', 'v4', 'v3']);
    expect(reverseMultiSwitch.up.map((x) => x.id)).toEqual(['v3b']);
    expect(routeShape(reverseMultiSwitch)).toBe('switch');

    // 缺失节点或不同的根返回 null
    expect(routeBetween(byId, 'missing', 'v1')).toBeNull();
    expect(routeBetween(byId, 'v1', 'missing')).toBeNull();
    const twoRoots = indexTree([n('r1', 1, null), n('r2', 2, null)]);
    expect(routeBetween(twoRoots, 'r1', 'r2')).toBeNull();
  });
});
