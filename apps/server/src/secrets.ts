// 数据库连接信息的加密（Q12：环境变量提供主密钥）。AES-256-GCM，密文格式 v1:iv:tag:data（base64url）。
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import { scrubSecrets } from '@dowel/core';

export class SecretError extends Error {}

const key = (): Buffer => {
  const raw = process.env.DOWEL_SECRET;
  if (!raw || raw.length < 16)
    throw new SecretError(
      '保存数据库连接需要设置环境变量 DOWEL_SECRET（至少 16 个字符的随机字符串），用于加密连接信息',
    );
  return createHash('sha256').update(raw).digest();
};

export const encrypt = (plain: string): string => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), data]
    .map((x) => (typeof x === 'string' ? x : x.toString('base64url')))
    .join(':');
};

/**
 * 带密钥的摘要：HMAC-SHA256，密钥由 DOWEL_SECRET 派生（再按用途 purpose 派生一次，不同用途的摘要互不相关）。
 * 用在需要“判断是不是同一个值”、又不能让人离线撞出原文的地方（例如执行申请绑定的连接串指纹：连接串里有密码）。
 */
export const keyedDigest = (purpose: string, data: string): string =>
  createHmac('sha256', createHmac('sha256', key()).update(`dowel:${purpose}`).digest())
    .update(data)
    .digest('hex');

export const decrypt = (enc: string): string => {
  const [v, iv, tag, data] = enc.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new SecretError('无法识别的密文');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  try {
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    throw new SecretError('解密失败：DOWEL_SECRET 可能被修改过');
  }
};

// scrubSecrets 的实现放在 @dowel/core（执行器写目标库历史时也要用），这里重新导出，保持全服务端只有这一个实现
export { scrubSecrets };

/**
 * 显示用：隐藏密码。能解析成 URL 的，用 URL 的 password 属性遮（空格、`%` 之类都能处理）。
 * 不再交给 scrubSecrets：password 已经遮掉，再按文本匹配只会把查询串里的 `@` 误当成 userinfo、把主机和库名吞掉。
 * 解析不了的（密码里带没编码的 `/` 之类）不原样显示，给提示。
 */
export const maskUrl = (url: string): string => {
  if (/^sqlite:\/\//i.test(url)) return url;
  // MSSQL 命名实例支持 host\instance（反斜杠在 WHATWG URL 主机中不合法），先剥离命名实例脱敏后再还原
  const mssqlScheme = /^(?:mssql|sqlserver):\/\//i.exec(url);
  if (mssqlScheme) {
    const rest = url.slice(mssqlScheme[0].length);
    const boundary = rest.search(/[/?#]/);
    const authority = boundary >= 0 ? rest.slice(0, boundary) : rest;
    const tail = boundary >= 0 ? rest.slice(boundary) : '';
    const at = authority.lastIndexOf('@');
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    if (hostPort.includes('\\')) {
      if (!hostPort.split('\\')[0]?.trim()) return '（无效的连接串）';
      if (at < 0) return url;
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(':');
      const maskedAuth = colon >= 0 ? `${userinfo.slice(0, colon)}:***` : userinfo;
      return `${mssqlScheme[0]}${maskedAuth}@${hostPort}${tail}`;
    }
  }
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '（无效的连接串）';
  }
};
