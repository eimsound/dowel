// 首次启动管理员引导：实例尚无用户时，在平台库事务锁内幂等创建初始管理员账号。
// - 提供了 DOWEL_ADMIN_PASSWORD_FILE 或 DOWEL_ADMIN_PASSWORD 时，使用运维预设密码（mustChangePassword = false）；
// - 未提供时生成 24 位随机临时密码，以 0600 权限原子写入 initial-admin-password 文件（mustChangePassword = true，首次登录必须改密）。
import { randomBytes } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { passwordSchema, usernameSchema } from '@dowel/api';

import type { User } from './auth.ts';
import { isUniqueViolation, type PlatformDb } from './db.ts';
import { countUsers, createUser } from './users.ts';

/** PG 事务级 advisory lock 键：串行化多副本首次管理员引导 */
export const SETUP_LOCK_KEY = 'dowel:setup';
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const INITIAL_PASSWORD_FILENAME = 'initial-admin-password';

/** 生成 24 位 URL-safe 随机临时密码（18 字节 base64url） */
export const generateTempPassword = (): string => randomBytes(18).toString('base64url');

/** 解析首次启动临时密码文件的目标路径 */
export const resolveInitialPasswordFile = (
  db: Pick<PlatformDb, 'filePath'>,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const custom = env.DOWEL_INITIAL_PASSWORD_FILE?.trim();
  if (custom) return path.resolve(custom);
  if (db.filePath) return path.join(path.dirname(db.filePath), INITIAL_PASSWORD_FILENAME);
  return path.resolve('./data', INITIAL_PASSWORD_FILENAME);
};

/** 读取运维通过 DOWEL_ADMIN_PASSWORD_FILE 提供的初始密码（仅去除首尾空白/换行） */
export const readAdminPasswordFile = async (filePath: string): Promise<string> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    throw new Error(
      `无法读取 DOWEL_ADMIN_PASSWORD_FILE（${filePath}）：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`DOWEL_ADMIN_PASSWORD_FILE（${filePath}）中的密码不能为空`);
  }
  const parsed = passwordSchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new Error(
      `DOWEL_ADMIN_PASSWORD_FILE（${filePath}）中的密码不合法：${parsed.error.issues[0]?.message ?? '格式错误'}`,
    );
  }
  return parsed.data;
};

/** 以 0600 权限原子写入初始临时密码文件（同目录临时文件 + chmod 0600 + fsync + rename） */
export const writePasswordFileAtomic = async (filePath: string, password: string): Promise<void> => {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${randomBytes(8).toString('hex')}`);
  let fh: FileHandle | null = null;
  try {
    fh = await open(tmpPath, 'wx', 0o600);
    await fh.chmod(0o600);
    await fh.writeFile(`${password}\n`, 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tmpPath, filePath);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
};

/** 尽最大努力删除自动生成的初始临时密码文件（忽略 ENOENT，绝不抛出） */
export const removeInitialAdminPasswordFile = async (filePath: string | null | undefined): Promise<void> => {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'ENOENT') return;
    console.warn(`清理初始密码文件失败（${filePath}）：${e instanceof Error ? e.message : String(e)}`);
  }
};

export interface BootstrapAdminResult {
  created: User | null;
  source: 'file' | 'env' | 'generated' | null;
  bootstrapUsername: string;
  /** 仅在使用/可能使用自动生成临时密码模式时返回文件路径；运维显式提供密码时恒为 null */
  initialAdminPasswordFile: string | null;
}

/**
 * 首次启动管理员引导（跨单机与 PG 多副本冷启动幂等）：
 * - 若同时设置了 DOWEL_ADMIN_PASSWORD_FILE 与 DOWEL_ADMIN_PASSWORD，启动直接失败；
 * - 实例已有用户时不做任何写库操作（仍返回 bootstrapUsername 与 initialAdminPasswordFile 供改密后清理）；
 * - 未提供运维密码时生成临时密码写入 0600 文件并置 mustChangePassword = true。
 */
export const bootstrapAdmin = async (
  db: PlatformDb,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<BootstrapAdminResult> => {
  const env = options.env ?? process.env;
  const rawUsername = env.DOWEL_ADMIN_USERNAME?.trim() || undefined;
  const passwordFile = env.DOWEL_ADMIN_PASSWORD_FILE?.trim() || undefined;
  const envPassword =
    env.DOWEL_ADMIN_PASSWORD !== undefined && env.DOWEL_ADMIN_PASSWORD !== ''
      ? env.DOWEL_ADMIN_PASSWORD
      : undefined;

  if (passwordFile && envPassword !== undefined) {
    throw new Error('不能同时设置 DOWEL_ADMIN_PASSWORD_FILE 和 DOWEL_ADMIN_PASSWORD');
  }

  let bootstrapUsername = DEFAULT_ADMIN_USERNAME;
  if (rawUsername !== undefined) {
    const parsed = usernameSchema.safeParse(rawUsername);
    if (!parsed.success) {
      throw new Error(`DOWEL_ADMIN_USERNAME 不合法：${parsed.error.issues[0]?.message ?? '格式错误'}`);
    }
    bootstrapUsername = parsed.data;
  }

  if (envPassword !== undefined) {
    const parsed = passwordSchema.safeParse(envPassword);
    if (!parsed.success) {
      throw new Error(`DOWEL_ADMIN_PASSWORD 不合法：${parsed.error.issues[0]?.message ?? '格式错误'}`);
    }
  }

  const initialAdminPasswordFile =
    passwordFile || envPassword !== undefined ? null : resolveInitialPasswordFile(db, env);

  if ((await countUsers(db)) > 0) {
    return { created: null, source: null, bootstrapUsername, initialAdminPasswordFile };
  }

  try {
    const res = await db.transaction<{
      created: User | null;
      source: 'file' | 'env' | 'generated' | null;
    }>(async (tx) => {
      if (db.dialect === 'pg') {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [SETUP_LOCK_KEY]);
      }
      if ((await countUsers(tx)) > 0) {
        return { created: null, source: null };
      }

      if (passwordFile) {
        const password = await readAdminPasswordFile(passwordFile);
        const created = await createUser(tx, {
          username: bootstrapUsername,
          name: bootstrapUsername,
          password,
          role: 'admin',
          mustChangePassword: false,
        });
        return { created, source: 'file' };
      }

      if (envPassword !== undefined) {
        const created = await createUser(tx, {
          username: bootstrapUsername,
          name: bootstrapUsername,
          password: envPassword,
          role: 'admin',
          mustChangePassword: false,
        });
        return { created, source: 'env' };
      }

      const password = generateTempPassword();
      await writePasswordFileAtomic(initialAdminPasswordFile!, password);
      try {
        const created = await createUser(tx, {
          username: bootstrapUsername,
          name: bootstrapUsername,
          password,
          role: 'admin',
          mustChangePassword: true,
        });
        return { created, source: 'generated' };
      } catch (e) {
        await unlink(initialAdminPasswordFile!).catch(() => {});
        throw e;
      }
    });
    return { ...res, bootstrapUsername, initialAdminPasswordFile };
  } catch (e) {
    if (isUniqueViolation(e) && (await countUsers(db)) > 0) {
      return { created: null, source: null, bootstrapUsername, initialAdminPasswordFile };
    }
    throw e;
  }
};
