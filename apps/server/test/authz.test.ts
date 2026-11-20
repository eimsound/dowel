// can() 的表驱动单测：项目动作 × 项目角色，组动作 × 组里的身份（含 default 设置），实例动作（含建组设置）。
import { describe, expect, test } from 'vitest';
import {
  ACTION_MIN_ROLE,
  type Actor,
  CI_ACTIONS,
  can,
  ENV_ACTIONS,
  GROUP_ADMIN_ACTIONS,
  type GroupAction,
  INSTANCE_ACTIONS,
  type ProjectAction,
  type Resource,
  TOKEN_ACTIONS,
  userActor,
} from '../src/authz.ts';
import type { Role } from '../src/rooms.ts';

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const ROLES: (Role | null)[] = ['viewer', 'editor', 'admin', null];
const actions = Object.keys(ACTION_MIN_ROLE) as ProjectAction[];
const user: Actor = { kind: 'user', id: 'u1', instanceAdmin: false };
const admin: Actor = { kind: 'user', id: 'admin', instanceAdmin: true };

describe('can() 项目动作 × 项目角色', () => {
  for (const action of actions) {
    test(action, () => {
      for (const role of ROLES) {
        const resource: Resource = { kind: 'project', role };
        const expected = role !== null && RANK[role] >= RANK[ACTION_MIN_ROLE[action]];
        expect(can(user, action, resource), `${action} / ${role ?? '看不见'}`).toBe(expected);
        // 实例管理员在项目里不受角色限制
        expect(can(admin, action, resource), `${action} / 实例管理员`).toBe(true);
      }
    });
  }

  test('环境资源也用项目角色判断', () => {
    expect(can(user, 'environment.read', { kind: 'environment', role: null })).toBe(false);
    expect(can(user, 'environment.pull', { kind: 'environment', role: 'viewer' })).toBe(false);
    expect(can(user, 'environment.pull', { kind: 'environment', role: 'editor' })).toBe(true);
    expect(can(user, 'environment.manage', { kind: 'environment', role: 'editor' })).toBe(false);
    expect(can(user, 'environment.manage', { kind: 'environment', role: 'admin' })).toBe(true);
  });

  test('系统身份不受限制', () => {
    expect(can({ kind: 'system', id: null }, 'project.manage_grants', { kind: 'project', role: null })).toBe(
      true,
    );
    expect(can(admin, 'environment.manage', { kind: 'project', role: null })).toBe(true);
  });
});

describe('can() 组动作', () => {
  test('组对所有人可见', () => {
    expect(can(user, 'group.read', { kind: 'group', groupRole: null })).toBe(true);
    expect(can(user, 'group.read', { kind: 'group', groupRole: 'member' })).toBe(true);
    expect(can(user, 'group.read', { kind: 'project', role: 'admin' })).toBe(false);
  });

  test('管理动作需要组管理员', () => {
    for (const action of GROUP_ADMIN_ACTIONS as GroupAction[]) {
      expect(can(user, action, { kind: 'group', groupRole: 'member' }), action).toBe(false);
      expect(can(user, action, { kind: 'group', groupRole: null }), action).toBe(false);
      expect(can(user, action, { kind: 'group', groupRole: 'admin' }), action).toBe(true);
      expect(can(admin, action, { kind: 'group', groupRole: null }), action).toBe(true);
    }
  });

  test('建项目看组的 project_creation：members 时组成员都能建，admins 时只有组管理员', () => {
    const resource = (groupRole: 'admin' | 'member' | null, projectCreation: 'members' | 'admins') => ({
      kind: 'group' as const,
      groupRole,
      projectCreation,
    });
    expect(can(user, 'group.create_project', resource('member', 'members'))).toBe(true);
    expect(can(user, 'group.create_project', resource('member', 'admins'))).toBe(false);
    expect(can(user, 'group.create_project', resource('admin', 'admins'))).toBe(true);
    expect(can(user, 'group.create_project', resource(null, 'members'))).toBe(false);
    // 实例管理员始终可以
    expect(can(admin, 'group.create_project', resource(null, 'admins'))).toBe(true);
  });
});

describe('can() 实例动作', () => {
  test('实例级动作只有实例管理员能做', () => {
    for (const action of INSTANCE_ACTIONS.filter((a) => a !== 'instance.create_group')) {
      expect(can(user, action, { kind: 'instance' }), action).toBe(false);
      expect(can(admin, action, { kind: 'instance' }), action).toBe(true);
      // 项目里的项目管理员也不行：实例管理不属于项目角色
      expect(can(user, action, { kind: 'project', role: 'admin' }), action).toBe(false);
    }
  });

  test('建组看实例设置 group_creation', () => {
    expect(can(user, 'instance.create_group', { kind: 'instance', groupCreation: 'all' })).toBe(true);
    expect(can(user, 'instance.create_group', { kind: 'instance', groupCreation: 'admin' })).toBe(false);
    // 设置只对实例资源有意义
    expect(can(user, 'instance.create_group', { kind: 'project', role: 'admin' })).toBe(false);
    expect(can(admin, 'instance.create_group', { kind: 'instance', groupCreation: 'admin' })).toBe(true);
  });

  test('userActor 从用户角色推出实例管理员', () => {
    expect(userActor({ id: 'u1', role: 'admin' }).instanceAdmin).toBe(true);
    expect(userActor({ id: 'u2', role: 'member' }).instanceAdmin).toBe(false);
    // 大小写不匹配不算管理员
    expect(userActor({ id: 'u3', role: 'Admin' }).instanceAdmin).toBe(false);
  });
});

describe('can() CI 令牌与令牌管理（P6）', () => {
  const token: Actor = { kind: 'token', id: 't1', projectId: 'p1' };

  test('令牌只能做本项目的 ci.read 和允许的 ci.execute，其余动作一律拒绝（含 mark 与令牌管理）', () => {
    expect(can(token, 'ci.read', { kind: 'project', projectId: 'p1' })).toBe(true);
    expect(can(token, 'ci.read', { kind: 'environment', projectId: 'p1' })).toBe(true);
    expect(can(token, 'ci.read', { kind: 'project', projectId: 'p2' })).toBe(false);
    expect(can(token, 'ci.execute', { kind: 'environment', projectId: 'p1', allowTokens: true })).toBe(true);
    expect(can(token, 'ci.execute', { kind: 'environment', projectId: 'p1', allowTokens: false })).toBe(
      false,
    );
    expect(can(token, 'ci.execute', { kind: 'environment', projectId: 'p2', allowTokens: true })).toBe(false);
    expect(can(token, 'ci.execute', { kind: 'project', projectId: 'p1', allowTokens: true })).toBe(false);

    for (const action of [
      ...actions,
      ...ENV_ACTIONS,
      ...GROUP_ADMIN_ACTIONS,
      ...INSTANCE_ACTIONS,
      ...TOKEN_ACTIONS,
    ])
      expect(
        can(token, action, {
          kind: 'environment',
          projectId: 'p1',
          role: 'admin',
          allowTokens: true,
          tokenCreator: true,
          tokenOwner: true,
        }),
        `令牌不应被允许 ${action}`,
      ).toBe(false);
  });

  test('登录用户（含实例管理员）不能走 ci.* 动作；令牌管理按 tokenCreator / admin / tokenOwner 判断', () => {
    for (const action of CI_ACTIONS) {
      expect(can(user, action, { kind: 'environment', projectId: 'p1', allowTokens: true })).toBe(false);
      expect(can(admin, action, { kind: 'environment', projectId: 'p1', allowTokens: true })).toBe(false);
    }
    expect(can(user, 'token.create', { kind: 'project', role: 'viewer', tokenCreator: true })).toBe(true);
    expect(can(user, 'token.create', { kind: 'project', role: 'admin', tokenCreator: false })).toBe(false);
    expect(can(admin, 'token.create', { kind: 'project', role: null, tokenCreator: false })).toBe(true);

    expect(can(user, 'token.list', { kind: 'project', role: 'admin', tokenCreator: false })).toBe(true);
    expect(can(user, 'token.list', { kind: 'project', role: 'viewer', tokenCreator: true })).toBe(true);
    expect(can(user, 'token.list', { kind: 'project', role: 'editor', tokenCreator: false })).toBe(false);

    expect(can(user, 'token.revoke', { kind: 'project', role: 'admin', tokenOwner: false })).toBe(true);
    expect(can(user, 'token.revoke', { kind: 'project', role: 'viewer', tokenOwner: true })).toBe(true);
    expect(can(user, 'token.revoke', { kind: 'project', role: null, tokenOwner: true })).toBe(false);
    expect(can(user, 'token.revoke', { kind: 'project', role: 'editor', tokenOwner: false })).toBe(false);
  });
});
