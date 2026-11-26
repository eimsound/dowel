// 申请所在的范围：项目、环境、当前生效策略（同一次读出），以及判断资格用的环节范围。
import type { ResolvedPolicy } from '@dowel/api';
import type { Db } from '@dowel/engines';

import type { EnvRow } from '../envs.ts';
import { loadPolicies, type PolicyStore, resolveEnv } from '../policy.ts';
import { type ProjectRow, projectRow } from '../roles.ts';
import type { StageScope } from './eligibility.ts';
import { execDirectionOf, type RequestRow } from './model.ts';

export interface RequestScope {
  project: ProjectRow;
  env: EnvRow;
  /** 四层配置（同一次读出，算执行者身份、超时时复用） */
  store: PolicyStore;
  resolved: ResolvedPolicy;
}

/** 申请所在的项目、环境和当前生效策略（环境 / 项目已删除时 null） */
export const scopeOf = async (
  db: Db,
  req: Pick<RequestRow, 'project_id' | 'environment_id'>,
): Promise<RequestScope | null> => {
  const project = await projectRow(db, req.project_id);
  if (!project) return null;
  const [env] = await db.query<EnvRow>('select * from environments where id = $1', [req.environment_id]);
  if (!env) return null;
  const store = await loadPolicies(db, project);
  return { project, env, store, resolved: resolveEnv(store, env) };
};

/** 判断资格用的环节范围：申请所在的项目、环境、当前生效策略和路线方向 */
export const stageScopeOf = (
  s: RequestScope,
  req: Pick<RequestRow, 'direction' | 'migrations'>,
): StageScope => ({
  project: s.project,
  env: { id: s.env.id, production: s.env.production },
  resolved: s.resolved,
  direction: execDirectionOf(req),
});
