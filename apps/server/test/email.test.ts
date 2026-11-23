// 邮件服务集成测试：后台 SMTP 配置/加密/脱敏审计、测试发信与限流、/api/instance emailEnabled、
// 忘记密码全链路（防枚举、大小写不敏感、旧令牌撤销、发信失败回滚、限流）以及邮件邀请全链路（直打本地 mock SMTP 服务器）。

import { createServer as createTcpServer, type Socket } from 'node:net';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import type { AppOptions } from '../src/app.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { makeUser, PASSWORD } from './support.ts';

interface CapturedMail {
  from: string;
  to: string[];
  raw: string;
  text: string;
  html: string;
}

const decodeMimeBodies = (raw: string) => {
  const boundaryMatch = /boundary="([^"]+)"/.exec(raw);
  if (!boundaryMatch) return { text: raw, html: '' };
  const sections = raw.split(`--${boundaryMatch[1]!}`);
  const decodePart = (part: string) => {
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) return '';
    return Buffer.from(part.slice(idx + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
  };
  return { text: decodePart(sections[1] ?? ''), html: decodePart(sections[2] ?? '') };
};

const startMockSmtp = async () => {
  const captured: CapturedMail[] = [];
  let failOnData: string | null = null;
  const sockets = new Set<Socket>();

  const server = createTcpServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));

    let buf = Buffer.alloc(0);
    let inData = false;
    let dataBuf = '';
    let from = '';
    let to: string[] = [];

    const write = (s: string) => {
      if (!sock.destroyed) sock.write(s);
    };

    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          if (failOnData) {
            write(`550 ${failOnData}\r\n`);
            return;
          }
          const raw = dataBuf
            .split('\r\n')
            .map((l) => (l.startsWith('..') ? l.slice(1) : l))
            .join('\r\n');
          const { text, html } = decodeMimeBodies(raw);
          captured.push({ from, to: [...to], raw, text, html });
          write('250 2.0.0 OK\r\n');
          return;
        }
        dataBuf += `${line}\r\n`;
        return;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO ')) {
        write('250-localhost\r\n250 AUTH PLAIN\r\n');
      } else if (upper.startsWith('AUTH PLAIN ')) {
        write('235 2.7.0 OK\r\n');
      } else if (upper.startsWith('MAIL FROM:')) {
        from = line.slice(10).trim();
        to = [];
        write('250 2.1.0 OK\r\n');
      } else if (upper.startsWith('RCPT TO:')) {
        to.push(line.slice(8).trim());
        write('250 2.1.5 OK\r\n');
      } else if (upper === 'DATA') {
        inData = true;
        dataBuf = '';
        write('354 End with <CRLF>.<CRLF>\r\n');
      } else if (upper === 'QUIT') {
        write('221 Bye\r\n');
        sock.end();
      } else {
        write('502 Unsupported\r\n');
      }
    };

    sock.on('data', (chunk) => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buf = Buffer.concat([buf, data]);
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        let line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        onLine(line.toString('utf8'));
      }
    });

    write('220 localhost ESMTP Mock\r\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    captured,
    setFailOnData: (msg: string | null) => {
      failOnData = msg;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('邮件服务集成（平台库：$platform）', ({ platform, skip }) => {
  const prevSecret = process.env.DOWEL_SECRET;
  let db: PlatformDb;
  let app: ReturnType<typeof createApp>['app'];
  let stop: () => Promise<void>;
  let pg: Awaited<ReturnType<typeof createTestDb>> | undefined;
  let smtp: Awaited<ReturnType<typeof startMockSmtp>>;

  const boot = async (options: AppOptions = {}) => {
    const created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      security: { publicUrl: 'https://dowel.example.com' },
      ...options,
    });
    app = created.app;
    stop = async () => {
      await created.rooms.flush();
      await created.shadows.close();
    };
  };

  const call = async (method: string, path: string, json?: unknown, cookie = '') => {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      headers: res.headers,
      data: data as Record<string, unknown> & unknown[],
      cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
    };
  };

  const setupUsers = async () => {
    await makeUser(db, 'admin', { name: '管理员', email: 'Admin@Example.com', role: 'admin' });
    await makeUser(db, 'alice', { name: 'Alice', email: 'Alice@Example.com', role: 'member' });
    const adminLogin = await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
    const aliceLogin = await call('POST', '/api/auth/login', { username: 'alice', password: PASSWORD });
    return { adminCookie: adminLogin.cookie, aliceCookie: aliceLogin.cookie };
  };

  beforeEach(async () => {
    if (skip) return;
    process.env.DOWEL_SECRET = 'email-test-secret-0123456789';
    smtp = await startMockSmtp();
    pg = platform === 'pg' ? await createTestDb('email') : undefined;
    db = await openPlatformDb(pg?.url ?? ':memory:');
    await boot();
  });

  afterEach(async () => {
    if (skip) return;
    await stop();
    await db.close();
    await pg?.close();
    pg = undefined;
    await smtp.close();
    if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
    else process.env.DOWEL_SECRET = prevSecret;
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
    else process.env.DOWEL_SECRET = prevSecret;
  });

  test.skipIf(skip)(
    'SMTP 配置：鉴权、无密码免 DOWEL_SECRET、有密码加密存储/保留/清空、启用校验与脱敏审计',
    async () => {
      const { adminCookie, aliceCookie } = await setupUsers();

      // 鉴权检查
      expect((await call('GET', '/api/admin/email')).status).toBe(401);
      expect((await call('GET', '/api/admin/email', undefined, aliceCookie)).status).toBe(403);
      expect((await call('PATCH', '/api/admin/email', {}, aliceCookie)).status).toBe(403);
      expect((await call('POST', '/api/admin/email/test', { to: 'a@b.com' }, aliceCookie)).status).toBe(403);

      // 初始状态
      const init = await call('GET', '/api/admin/email', undefined, adminCookie);
      expect(init.status).toBe(200);
      expect(init.data).toEqual({
        enabled: false,
        host: '',
        port: 587,
        security: 'starttls',
        username: '',
        hasPassword: false,
        fromAddress: '',
        fromName: '',
      });
      expect((await call('GET', '/api/instance')).data.emailEnabled).toBe(false);

      // 缺少 host / fromAddress 时不能启用
      expect((await call('PATCH', '/api/admin/email', { enabled: true }, adminCookie)).status).toBe(422);

      // 无密码配置时不要求 DOWEL_SECRET
      delete process.env.DOWEL_SECRET;
      const noPwSave = await call(
        'PATCH',
        '/api/admin/email',
        {
          enabled: true,
          host: '127.0.0.1',
          port: smtp.port,
          security: 'none',
          fromAddress: 'noreply@example.com',
          fromName: 'Dowel',
        },
        adminCookie,
      );
      expect(noPwSave.status).toBe(200);
      expect(noPwSave.data.hasPassword).toBe(false);
      expect((await call('GET', '/api/instance')).data.emailEnabled).toBe(true);

      // 设密码但缺 DOWEL_SECRET：返回 422 SecretError
      const noSecretPw = await call(
        'PATCH',
        '/api/admin/email',
        { password: 'smtp-secret-password' },
        adminCookie,
      );
      expect(noSecretPw.status).toBe(422);

      // 配回 DOWEL_SECRET 并保存密码：密文存库，接口与审计不泄露
      process.env.DOWEL_SECRET = 'email-test-secret-0123456789';
      const withPw = await call(
        'PATCH',
        '/api/admin/email',
        { username: 'mailer', password: 'smtp-secret-password' },
        adminCookie,
      );
      expect(withPw.status).toBe(200);
      expect(withPw.data).toMatchObject({ hasPassword: true, username: 'mailer' });
      expect(JSON.stringify(withPw.data)).not.toContain('smtp-secret-password');
      expect('password' in withPw.data).toBe(false);
      expect('passwordEnc' in withPw.data).toBe(false);

      const [row] = await db.query<{ value: { passwordEnc: string | null } }>(
        "select value from instance_settings where key = 'smtp'",
      );
      expect(row!.value.passwordEnc).toMatch(/^v1:/);

      // 改其他字段但不传 password：保留原密码
      const keepPw = await call('PATCH', '/api/admin/email', { fromName: 'Dowel 邮件' }, adminCookie);
      expect(keepPw.status).toBe(200);
      expect(keepPw.data.hasPassword).toBe(true);

      // 传空串清空密码
      const clearPw = await call('PATCH', '/api/admin/email', { password: '' }, adminCookie);
      expect(clearPw.status).toBe(200);
      expect(clearPw.data.hasPassword).toBe(false);

      // 审计日志绝不含明文或密文密码
      const audits = await db.query<{ data: Record<string, unknown> }>(
        "select data from audit_events where action = 'email.settings_update'",
      );
      expect(audits.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(audits)).not.toContain('smtp-secret-password');
      expect(JSON.stringify(audits)).not.toContain('v1:');
    },
  );

  test.skipIf(skip)('测试发信：启用前先保存配置即可测试、真实 SMTP 收信、失败脱敏与限流', async () => {
    await stop();
    await boot({
      emailTestLimiter: new KeyedLimiter({ limit: 2, windowMs: 60_000 }),
    });
    const { adminCookie } = await setupUsers();

    // 尚未配置 host/fromAddress
    expect((await call('POST', '/api/admin/email/test', { to: 'ops@example.com' }, adminCookie)).status).toBe(
      422,
    );

    // 保持 enabled: false 时保存配置也能测试发信
    expect(
      (
        await call(
          'PATCH',
          '/api/admin/email',
          {
            enabled: false,
            host: '127.0.0.1',
            port: smtp.port,
            security: 'none',
            username: 'mailer',
            password: 'secret-smtp-password',
            fromAddress: 'noreply@example.com',
            fromName: 'Dowel',
          },
          adminCookie,
        )
      ).status,
    ).toBe(200);

    const okTest = await call('POST', '/api/admin/email/test', { to: 'Ops@Example.com' }, adminCookie);
    expect(okTest.status).toBe(200);
    expect(smtp.captured).toHaveLength(1);
    expect(smtp.captured[0]!.to).toEqual(['<ops@example.com>']);
    expect(smtp.captured[0]!.text).toContain('Dowel');

    // SMTP 发信失败返回 502 且不泄露密码
    smtp.setFailOnData('rejected for password secret-smtp-password');
    const failedTest = await call('POST', '/api/admin/email/test', { to: 'ops@example.com' }, adminCookie);
    expect(failedTest.status).toBe(502);
    expect(String(failedTest.data.error)).not.toContain('secret-smtp-password');
    smtp.setFailOnData(null);

    // 限流（limit=2）第三次返回 429 + Retry-After
    const limited = await call('POST', '/api/admin/email/test', { to: 'ops@example.com' }, adminCookie);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  test.skipIf(skip)(
    '忘记密码：关闭密码登录 403、未启邮件 422、防枚举、旧令牌撤销、重置改密清会话、发信失败回滚、限流',
    async () => {
      const { adminCookie } = await setupUsers();
      const disabledUser = await makeUser(db, 'blocked', {
        name: 'Blocked',
        email: 'blocked@example.com',
      });
      await db.query("update users set status = 'disabled' where id = $1", [disabledUser.id]);

      // 1. 邮件未启用时 422
      expect((await call('POST', '/api/auth/forgot-password', { email: 'alice@example.com' })).status).toBe(
        422,
      );

      // 配置并启用 SMTP
      await call(
        'PATCH',
        '/api/admin/email',
        {
          enabled: true,
          host: '127.0.0.1',
          port: smtp.port,
          security: 'none',
          fromAddress: 'noreply@example.com',
          fromName: 'Dowel',
        },
        adminCookie,
      );

      // 2. 防枚举：不存在的邮箱和停用用户均返回 200 且不发信
      expect((await call('POST', '/api/auth/forgot-password', { email: 'nobody@example.com' })).status).toBe(
        200,
      );
      expect((await call('POST', '/api/auth/forgot-password', { email: 'blocked@example.com' })).status).toBe(
        200,
      );
      expect(smtp.captured).toHaveLength(0);

      // 3. 活跃用户先有个老会话和老 reset 令牌
      const aliceSession = (await call('POST', '/api/auth/login', { username: 'alice', password: PASSWORD }))
        .cookie;
      const oldLink = await call(
        'POST',
        `/api/admin/users/${(await db.query<{ id: string }>("select id from users where username = 'alice'"))[0]!.id}/reset-link`,
        {},
        adminCookie,
      );
      const oldToken = oldLink.data.token as string;

      // 大写邮箱申请重置密码
      const forgot = await call('POST', '/api/auth/forgot-password', { email: 'ALICE@EXAMPLE.COM' });
      expect(forgot.status).toBe(200);
      expect(smtp.captured).toHaveLength(1);
      const mail = smtp.captured[0]!;
      expect(mail.to).toEqual(['<alice@example.com>']);
      const urlMatch = /https:\/\/dowel\.example\.com(\/reset\/[^\s<]+)/.exec(mail.text);
      expect(urlMatch).toBeTruthy();
      const resetPath = urlMatch![1]!;

      // 旧令牌已被撤销
      expect((await call('POST', `/api/reset/${oldToken}`, { password: 'new-password-1' })).status).toBe(410);

      // 用邮件里的新链接设置新密码，旧会话失效
      const resetRes = await call('POST', `/api${resetPath}`, { password: 'new-password-2' });
      expect(resetRes.status).toBe(200);
      expect((await call('GET', '/api/auth/me', undefined, aliceSession)).status).toBe(401);
      expect(
        (await call('POST', '/api/auth/login', { username: 'alice', password: 'new-password-2' })).status,
      ).toBe(200);

      // 4. 发信失败：回滚新建令牌，对调用方仍然返回 200
      smtp.setFailOnData('smtp down');
      const failedForgot = await call('POST', '/api/auth/forgot-password', { email: 'alice@example.com' });
      expect(failedForgot.status).toBe(200);
      const activeResets = await db.query<{ id: string }>(
        `select id from invites where kind = 'reset' and used_at is null and revoked_at is null`,
      );
      expect(activeResets).toHaveLength(0);
      const [failedAudit] = await db.query<{ data: { delivered: boolean } }>(
        "select data from audit_events where action = 'auth.forgot_password_request' order by at desc limit 1",
      );
      expect(failedAudit!.data.delivered).toBe(false);
      smtp.setFailOnData(null);

      // 5. 限流测试（重启注入 limit=1）
      await stop();
      await boot({
        forgotPasswordLimiter: new LoginLimiter({ limit: 1, ipLimit: 10, windowMs: 60_000 }),
        loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
        security: { publicUrl: 'https://dowel.example.com' },
      });
      expect((await call('POST', '/api/auth/forgot-password', { email: 'alice@example.com' })).status).toBe(
        200,
      );
      const rateLimited = await call('POST', '/api/auth/forgot-password', { email: 'alice@example.com' });
      expect(rateLimited.status).toBe(429);
      expect(Number(rateLimited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

      // 6. 关闭密码登录返回 403
      await db.query(
        "insert into oidc_providers (id, slug, name, issuer, client_id, client_secret_enc, enabled, auto_provision) values ('p1', 'p1', 'P1', 'https://idp.example', 'c', 'e', true, false)",
      );
      await call('PATCH', '/api/admin/settings', { passwordLogin: false }, adminCookie);
      expect((await call('POST', '/api/auth/forgot-password', { email: 'alice@example.com' })).status).toBe(
        403,
      );
    },
  );

  test.skipIf(skip)(
    '邮件邀请：重复邮箱 409、缺邮箱 400、未启邮件 422、发信失败不留孤儿、预填邮箱与注册',
    async () => {
      const { adminCookie } = await setupUsers();

      // 已被占用邮箱：409 邮箱已被使用
      const dup = await call(
        'POST',
        '/api/admin/invites',
        { email: 'ALICE@EXAMPLE.COM', sendEmail: false },
        adminCookie,
      );
      expect(dup.status).toBe(409);
      expect(String(dup.data.error)).toContain('邮箱');

      // sendEmail: true 但未启用邮件：422
      expect(
        (await call('POST', '/api/admin/invites', { email: 'bob@example.com', sendEmail: true }, adminCookie))
          .status,
      ).toBe(422);

      // 开启 SMTP
      await call(
        'PATCH',
        '/api/admin/email',
        {
          enabled: true,
          host: '127.0.0.1',
          port: smtp.port,
          security: 'none',
          fromAddress: 'noreply@example.com',
          fromName: 'Dowel',
        },
        adminCookie,
      );

      // sendEmail: true 但没传 email：400
      expect((await call('POST', '/api/admin/invites', { sendEmail: true }, adminCookie)).status).toBe(400);

      // SMTP 发信失败：返回 502 且不留下孤儿邀请
      smtp.setFailOnData('mailbox full');
      const failed = await call(
        'POST',
        '/api/admin/invites',
        { email: 'bob@example.com', sendEmail: true },
        adminCookie,
      );
      expect(failed.status).toBe(502);
      expect((await call('GET', '/api/admin/invites', undefined, adminCookie)).data).toHaveLength(0);
      smtp.setFailOnData(null);

      // 成功发送邀请邮件
      const created = await call(
        'POST',
        '/api/admin/invites',
        { email: 'Bob@Example.com', sendEmail: true, expiresInDays: 5 },
        adminCookie,
      );
      expect(created.status).toBe(201);
      expect(created.data).toMatchObject({ email: 'bob@example.com', emailSent: true });
      expect(smtp.captured).toHaveLength(1);
      expect(smtp.captured[0]!.to).toEqual(['<bob@example.com>']);
      const inviteMatch = /https:\/\/dowel\.example\.com(\/invite\/[^\s<]+)/.exec(smtp.captured[0]!.text);
      expect(inviteMatch).toBeTruthy();

      // 审计记 emailSent，但不含 token
      const [invAudit] = await db.query<{ data: Record<string, unknown> }>(
        "select data from audit_events where action = 'user.invite' order by at desc limit 1",
      );
      expect(invAudit!.data.emailSent).toBe(true);
      expect(JSON.stringify(invAudit!.data)).not.toContain(created.data.token as string);

      // GET /api/invites/:token 返回受邀邮箱
      const token = created.data.token as string;
      expect((await call('GET', `/api/invites/${token}`)).data).toMatchObject({
        valid: true,
        state: 'ok',
        email: 'bob@example.com',
      });

      // 接受邀请时若填冲突邮箱返回 409，邀请保留可用
      const conflictAccept = await call('POST', `/api/invites/${token}/accept`, {
        username: 'bob',
        name: 'Bob',
        email: 'alice@example.com',
        password: 'password123',
      });
      expect(conflictAccept.status).toBe(409);
      expect((await call('GET', `/api/invites/${token}`)).data.state).toBe('ok');

      // 正常接受邀请并登录
      const accepted = await call('POST', `/api/invites/${token}/accept`, {
        username: 'bob',
        name: 'Bob',
        email: 'bob@example.com',
        password: 'password123',
      });
      expect(accepted.status).toBe(200);
      expect(accepted.data).toMatchObject({ username: 'bob', email: 'bob@example.com' });

      // 邀请已使用后，公开接口不再返回邮箱
      expect((await call('GET', `/api/invites/${token}`)).data).toMatchObject({
        state: 'used',
        email: null,
      });
    },
  );
});
