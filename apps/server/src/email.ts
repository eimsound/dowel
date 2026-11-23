// 实例 SMTP 邮件设置存储（instance_settings key='smtp'，HA 多副本共享）与邮件模板发送封装。
// SMTP 密码通过 secrets.ts 使用 DOWEL_SECRET 加密保存；未设置密码（无认证内网中继）时不依赖 DOWEL_SECRET。

import {
  emailAddressSchema,
  type EmailSettings,
  type EmailSettingsPatch,
  type SmtpSecurity,
} from '@dowel/api';
import type { Db } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';

import { decrypt, encrypt } from './secrets.ts';
import { sendSmtpMail, type SmtpConfig, type SmtpMessage } from './smtp.ts';

export const EMAIL_SETTINGS_KEY = 'smtp';

export interface StoredEmailSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  passwordEnc: string | null;
  fromAddress: string;
  fromName: string;
}

export type Mailer = (config: SmtpConfig, message: SmtpMessage) => Promise<void>;

export const defaultMailer: Mailer = (config, message) => sendSmtpMail(config, message);

const DEFAULT_STORED: StoredEmailSettings = {
  enabled: false,
  host: '',
  port: 587,
  security: 'starttls',
  username: '',
  passwordEnc: null,
  fromAddress: '',
  fromName: '',
};

const isSecurity = (v: unknown): v is SmtpSecurity => v === 'starttls' || v === 'tls' || v === 'none';

const parseStored = (raw: unknown): StoredEmailSettings => {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STORED };
  const r = raw as Record<string, unknown>;
  const port =
    typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : 587;
  return {
    enabled: r.enabled === true,
    host: typeof r.host === 'string' ? r.host : '',
    port,
    security: isSecurity(r.security) ? r.security : 'starttls',
    username: typeof r.username === 'string' ? r.username : '',
    passwordEnc: typeof r.passwordEnc === 'string' && r.passwordEnc ? r.passwordEnc : null,
    fromAddress: typeof r.fromAddress === 'string' ? r.fromAddress : '',
    fromName: typeof r.fromName === 'string' ? r.fromName : '',
  };
};

export const toPublicEmailSettings = (s: StoredEmailSettings): EmailSettings => ({
  enabled: s.enabled,
  host: s.host,
  port: s.port,
  security: s.security,
  username: s.username,
  hasPassword: Boolean(s.passwordEnc),
  fromAddress: s.fromAddress,
  fromName: s.fromName,
});

export const isEmailConfiguredAndEnabled = (
  s: Pick<EmailSettings, 'enabled' | 'host' | 'port' | 'fromAddress'>,
): boolean =>
  s.enabled && Boolean(s.host.trim()) && s.port >= 1 && s.port <= 65535 && Boolean(s.fromAddress.trim());

export const readStoredEmailSettings = async (db: Db): Promise<StoredEmailSettings> => {
  const [row] = await db.query<{ value: unknown }>('select value from instance_settings where key = $1', [
    EMAIL_SETTINGS_KEY,
  ]);
  return parseStored(row?.value);
};

export const readEmailSettings = async (db: Db): Promise<EmailSettings> =>
  toPublicEmailSettings(await readStoredEmailSettings(db));

export const isEmailEnabled = async (db: Db): Promise<boolean> =>
  isEmailConfiguredAndEnabled(await readStoredEmailSettings(db));

export interface EmailSettingsWriteResult {
  settings: EmailSettings;
  audit: {
    enabled: boolean;
    host: string;
    port: number;
    security: SmtpSecurity;
    username: string;
    fromAddress: string;
    fromName: string;
    passwordChanged: boolean;
    passwordCleared: boolean;
  };
}

export const writeEmailSettings = async (
  db: Db,
  patch: EmailSettingsPatch,
): Promise<EmailSettingsWriteResult> => {
  const cur = await readStoredEmailSettings(db);
  const host = patch.host !== undefined ? patch.host.trim() : cur.host;
  if (host && (/[\s\r\n\0]/.test(host) || host.includes('://'))) {
    throw new HTTPException(422, { message: 'SMTP 主机格式不正确，请填写域名或 IP，不要包含协议或空白字符' });
  }
  const port = patch.port ?? cur.port;
  const security = patch.security ?? cur.security;
  const username = patch.username !== undefined ? patch.username.trim() : cur.username;
  const fromAddress =
    patch.fromAddress !== undefined ? patch.fromAddress.trim().toLowerCase() : cur.fromAddress;
  const fromName = patch.fromName !== undefined ? patch.fromName.trim() : cur.fromName;
  const enabled = patch.enabled ?? cur.enabled;

  const passwordCleared = patch.password === null || patch.password === '';
  const passwordChanged = typeof patch.password === 'string' && patch.password.length > 0;
  let passwordEnc = cur.passwordEnc;
  if (passwordCleared) {
    passwordEnc = null;
  } else if (typeof patch.password === 'string') {
    passwordEnc = encrypt(patch.password);
  }

  if (enabled) {
    if (!host) throw new HTTPException(422, { message: '启用邮件服务前请先填写 SMTP 主机' });
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HTTPException(422, { message: 'SMTP 端口必须在 1–65535 之间' });
    }
    if (!emailAddressSchema.safeParse(fromAddress).success) {
      throw new HTTPException(422, { message: '启用邮件服务前请先填写合法的发件人邮箱' });
    }
  }

  const next: StoredEmailSettings = {
    enabled,
    host,
    port,
    security,
    username,
    passwordEnc,
    fromAddress,
    fromName,
  };

  await db.query(
    `insert into instance_settings (key, value) values ($1, $2::text::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [EMAIL_SETTINGS_KEY, JSON.stringify(next)],
  );

  return {
    settings: toPublicEmailSettings(next),
    audit: {
      enabled: next.enabled,
      host: next.host,
      port: next.port,
      security: next.security,
      username: next.username,
      fromAddress: next.fromAddress,
      fromName: next.fromName,
      passwordChanged,
      passwordCleared,
    },
  };
};

export const resolveSmtpConfig = (stored: StoredEmailSettings): SmtpConfig => {
  if (!stored.host.trim() || !emailAddressSchema.safeParse(stored.fromAddress).success) {
    throw new HTTPException(422, { message: '请先保存 SMTP 主机和发件人邮箱后再发送邮件' });
  }
  return {
    host: stored.host.trim(),
    port: stored.port,
    security: stored.security,
    username: stored.username,
    password: stored.passwordEnc ? decrypt(stored.passwordEnc) : null,
    fromAddress: stored.fromAddress,
    fromName: stored.fromName,
  };
};

export const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const renderEmailHtml = (
  title: string,
  paragraphs: readonly string[],
  cta?: { label: string; url: string },
) => {
  const safeTitle = escapeHtml(title);
  const bodyLines = paragraphs
    .map((p) => `<p style="margin:0 0 12px;color:#374151;">${escapeHtml(p)}</p>`)
    .join('');
  const ctaBlock = cta
    ? `<p style="margin:20px 0;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;">${escapeHtml(cta.label)}</a></p><p style="margin:0 0 12px;font-size:12px;color:#6b7280;word-break:break-all;">${escapeHtml(cta.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;"><div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;"><h2 style="margin:0 0 16px;font-size:18px;color:#111827;">${safeTitle}</h2>${bodyLines}${ctaBlock}</div></body></html>`;
};

export const testEmailTemplate = (instanceName: string): Omit<SmtpMessage, 'to'> => {
  const subject = `[${instanceName}] SMTP 邮件配置测试 / SMTP Configuration Test`;
  const text = [
    `这是一封来自 ${instanceName} 的测试邮件，说明当前 SMTP 发信配置已可用。`,
    '',
    `This is a test email from ${instanceName} confirming that your SMTP configuration works.`,
  ].join('\n');
  const html = renderEmailHtml(`${instanceName} · SMTP 测试邮件`, [
    `这是一封来自 ${instanceName} 的测试邮件，说明当前 SMTP 发信配置已可用。`,
    `This is a test email from ${instanceName} confirming that your SMTP configuration works.`,
  ]);
  return { subject, text, html };
};

export const passwordResetEmailTemplate = (input: {
  instanceName: string;
  username: string;
  resetUrl: string;
  expiresInHours: number;
}): Omit<SmtpMessage, 'to'> => {
  const subject = `[${input.instanceName}] 重置密码 / Reset your password`;
  const text = [
    `你好 ${input.username}，`,
    '',
    `我们收到了 ${input.instanceName} 的密码重置请求。请访问以下链接设置新密码（${input.expiresInHours} 小时内有效，且仅可使用一次）：`,
    input.resetUrl,
    '',
    '如果这不是你的操作，可以忽略此邮件，你的密码不会被修改。',
    '',
    `Hello ${input.username},`,
    `Use the link below to reset your ${input.instanceName} password (valid for ${input.expiresInHours} hour, single use):`,
    input.resetUrl,
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');
  const html = renderEmailHtml(
    `${input.instanceName} · 重置密码 / Reset password`,
    [
      `你好 ${input.username}：我们收到了你在 ${input.instanceName} 的密码重置请求。链接在 ${input.expiresInHours} 小时内有效，使用一次后自动失效；如果不是本人操作，请忽略此邮件。`,
      `Hello ${input.username}, use the button below to reset your ${input.instanceName} password. The link expires in ${input.expiresInHours} hour.`,
    ],
    { label: '重置密码 / Reset password', url: input.resetUrl },
  );
  return { subject, text, html };
};

export const inviteEmailTemplate = (input: {
  instanceName: string;
  inviteUrl: string;
  expiresInDays: number;
}): Omit<SmtpMessage, 'to'> => {
  const subject = `[${input.instanceName}] 邀请加入 / You are invited`;
  const text = [
    `你已受邀加入 ${input.instanceName}。`,
    '',
    `请打开以下链接创建你的账号（${input.expiresInDays} 天内有效，仅可使用一次）：`,
    input.inviteUrl,
    '',
    `You have been invited to join ${input.instanceName}.`,
    `Open the link below to create your account (valid for ${input.expiresInDays} days, single use):`,
    input.inviteUrl,
  ].join('\n');
  const html = renderEmailHtml(
    `${input.instanceName} · 邀请加入 / Invitation`,
    [
      `你已受邀加入 ${input.instanceName}。点击下方按钮完成账号注册，此邀请链接将在 ${input.expiresInDays} 天后过期且仅可使用一次。`,
      `You have been invited to join ${input.instanceName}. Use the link below to create your account (valid for ${input.expiresInDays} days, single use).`,
    ],
    { label: '接受邀请 / Accept invitation', url: input.inviteUrl },
  );
  return { subject, text, html };
};
