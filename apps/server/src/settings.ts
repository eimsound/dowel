// 实例设置：键值表 instance_settings(key, value json)，值都是 JSON。
// 项目见 02-consensus.md 11.1：实例名称、谁能建组、是否允许密码登录；
// connection_allowlist 是 P3 加的 SSRF 开关（服务端替用户连数据库时能连到哪里）；
// webhook_allowlist 是 P5b 加的 Webhook 出站额外放行列表（默认只允许公网地址，见 webhooks.ts）。
import type { GroupCreation, InstanceSettings, InstanceSettingsPatch } from '@dowel/api';
import type { Db } from '@dowel/engines';
import { countEnabledProviders } from './oidc.ts';

/** instanceId 不在默认值里：它是首次启动（迁移）时生成的，只读 */
export const SETTINGS_DEFAULTS: Omit<InstanceSettings, 'instanceId'> = {
  name: 'Dowel',
  groupCreation: 'all',
  passwordLogin: true,
  connectionAllowlist: [],
  webhookAllowlist: [],
};

/** 实例唯一标识的 key：由迁移在首次启动时写入，之后不变，不通过 writeSettings 修改 */
export const INSTANCE_ID_KEY = 'instance_id';

/** 设置项 → 表里的 key */
const KEYS = {
  name: 'name',
  groupCreation: 'group_creation',
  passwordLogin: 'password_login',
  connectionAllowlist: 'connection_allowlist',
  webhookAllowlist: 'webhook_allowlist',
} as const;

/** 可以写的设置项（instanceId 只读，不在其中） */
type Key = keyof typeof KEYS;

export const readSettings = async (db: Db): Promise<InstanceSettings> => {
  const rows = await db.query<{ key: string; value: unknown }>('select key, value from instance_settings');
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return {
    name:
      typeof stored.get(KEYS.name) === 'string' ? (stored.get(KEYS.name) as string) : SETTINGS_DEFAULTS.name,
    groupCreation:
      stored.get(KEYS.groupCreation) === 'admin' || stored.get(KEYS.groupCreation) === 'all'
        ? (stored.get(KEYS.groupCreation) as GroupCreation)
        : SETTINGS_DEFAULTS.groupCreation,
    passwordLogin:
      typeof stored.get(KEYS.passwordLogin) === 'boolean'
        ? (stored.get(KEYS.passwordLogin) as boolean)
        : SETTINGS_DEFAULTS.passwordLogin,
    connectionAllowlist: Array.isArray(stored.get(KEYS.connectionAllowlist))
      ? (stored.get(KEYS.connectionAllowlist) as unknown[]).filter((x): x is string => typeof x === 'string')
      : SETTINGS_DEFAULTS.connectionAllowlist,
    webhookAllowlist: Array.isArray(stored.get(KEYS.webhookAllowlist))
      ? (stored.get(KEYS.webhookAllowlist) as unknown[]).filter((x): x is string => typeof x === 'string')
      : SETTINGS_DEFAULTS.webhookAllowlist,
    instanceId:
      typeof stored.get(INSTANCE_ID_KEY) === 'string' ? (stored.get(INSTANCE_ID_KEY) as string) : '',
  };
};

/** 只写给出的项，返回写完之后完整的设置 */
export const writeSettings = async (db: Db, patch: InstanceSettingsPatch): Promise<InstanceSettings> => {
  for (const key of Object.keys(patch) as Key[]) {
    const value = patch[key];
    if (value === undefined) continue;
    await db.query(
      `insert into instance_settings (key, value) values ($1, $2::text::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [KEYS[key], JSON.stringify(value)],
    );
  }
  return readSettings(db);
};

/** 有没有可用的 OIDC 登录方式：至少有一个启用的提供方（A7） */
export const hasOidcProvider = async (db: Db): Promise<boolean> => (await countEnabledProviders(db)) > 0;

/** 应急入口：DOWEL_ALLOW_PASSWORD_LOGIN=1 时即使设置里关了也允许密码登录 */
export const passwordLoginForced = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const v = env.DOWEL_ALLOW_PASSWORD_LOGIN?.trim().toLowerCase();
  return v === '1' || v === 'true';
};
