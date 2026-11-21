// 服务端目标库驱动统一接口契约（apps/server/src/targets/*）。
import type { TargetInfo } from '@dowel/api';
import type { Dialect, Model } from '@dowel/core';
import type { Db } from '@dowel/engines';

import { type Shadow, ShadowError } from '../shadow.ts';

/** 和数据库通信失败（连接失败、读取结构失败） */
export class ConnectError extends ShadowError {}

/** 影子库标记：只有带这个标记的库才会被清空，防止连接配错时误删业务库 */
export const SHADOW_MARK = 'dowel shadow database (safe to wipe)';

/** 连接检查的超时（秒）：地址可能不可达，不能一直等 */
export const CHECK_CONNECT_TIMEOUT = 5;

/** 建立连接前的检查（SSRF 白名单 / 本地目录边界）；由 createApp 按实例设置注入 */
export type ConnectionGuard = (url: string) => Promise<void>;

export interface TargetConnection {
  db: Db;
  close(): Promise<void>;
}

/** 选影子库需要的环境信息 */
export interface ShadowSource {
  name: string;
  url: string;
  production: boolean;
  allowSameInstance?: boolean;
  shadowUrl?: string | null;
}

export interface PreparedShadow {
  shadow: Shadow;
  label: string;
  url: string;
  created: { targetUrl: string; name: string } | null;
}

export interface TargetDriver {
  readonly dialect: Dialect;
  shadowDbName(dbName: string): string;
  connect(url: string, connectTimeoutSec: number, guard?: ConnectionGuard): TargetConnection;
  inspectTarget(url: string, timeoutSec: number, guard?: ConnectionGuard): Promise<TargetInfo>;
  inspectTargetOn(db: Db, url: string): Promise<TargetInfo>;
  pullSchema(url: string, schemas?: string[] | null, guard?: ConnectionGuard): Promise<Model>;
  claimShadow?(url: string, guard?: ConnectionGuard): Promise<void>;
  prepareShadow(
    env: ShadowSource | null,
    schemas: string[] | null,
    guard?: ConnectionGuard,
  ): Promise<PreparedShadow>;
  dropSameInstanceShadow?(targetUrl: string, name: string, guard?: ConnectionGuard): Promise<void>;
  classifyDriverError(err: unknown): 'connect' | 'database' | null;
}
