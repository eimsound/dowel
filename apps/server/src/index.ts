export type { VerifyReport } from '@dowel/api';
export { type AppOptions, createApp } from './app.ts';
export { hashPassword, verifyPassword } from './auth.ts';
export {
  CLUSTER_EVENTS_CHANNEL,
  type ClusterEvent,
  type ClusterEventPayload,
  EventBus,
  type EventBusOptions,
} from './bus.ts';
export {
  type AdvisoryLockOptions,
  type AdvisoryLockResult,
  DEFAULT_ADVISORY_LOCK_POOL_MAX,
  DEFAULT_PG_CONNECT_TIMEOUT_SEC,
  DEFAULT_PG_KEEP_ALIVE_SEC,
  type OpenPlatformDbOptions,
  openPlatformDb,
  type PlatformDb,
} from './db.ts';
export { HaCoordinator, type HaCoordinatorOptions } from './ha.ts';
export { readSettings, writeSettings } from './settings.ts';
export { autoSetup, ensureSetupToken, needsSetup } from './setup.ts';
export { type Shadow, ShadowError } from './shadow.ts';
export {
  type ClosableServer,
  type ClosableWebSocket,
  type ClosableWebSocketServer,
  createShutdown,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  gracefulShutdown,
  type ShutdownDeps,
} from './shutdown.ts';
