// 服务端目标库统一门面：按方言分派到 targets/{pg,sqlite,...}.ts，保留全部既有导出向后兼容。
export {
  claimPgShadow,
  connectPg,
  dropPgSameInstanceShadow,
  ensureSameInstanceShadow,
  inspectPgTarget,
  inspectPgTargetOn,
  normalizePgVersion,
  pgShadow,
  pgTargetDriver,
  preparePgShadow,
  pullPgSchema,
  scrubUrl,
  type ShadowSetupStep,
  shadowDbName,
  shadowSetupError,
} from './targets/pg.ts';
export {
  claimShadow,
  classifyTargetDriverError,
  connectTarget,
  dropSameInstanceShadow,
  getTargetDriver,
  hasTargetDriver,
  inspectTarget,
  inspectTargetOn,
  pullSchema,
  registerTargetDriver,
} from './targets/registry.ts';
export {
  connectSqlite,
  inspectSqliteTarget,
  inspectSqliteTargetOn,
  prepareSqliteShadow,
  pullSqliteSchema,
  sqliteMemoryShadow,
  sqliteTargetDriver,
} from './targets/sqlite.ts';
export {
  CHECK_CONNECT_TIMEOUT,
  ConnectError,
  type ConnectionGuard,
  type PreparedShadow,
  SHADOW_MARK,
  type ShadowSource,
  type TargetConnection,
  type TargetDriver,
} from './targets/types.ts';
