// 原生 SMTP 客户端单测：真实本地 TCP/TLS mock SMTP 服务器覆盖 none / starttls / tls、
// 拒绝无 STARTTLS 降级、AUTH PLAIN / LOGIN / 无认证、多行响应、点填充、UTF-8、CRLF 注入拦截、超时与脱敏。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import {
  buildMimeMessage,
  encodeHeaderValue,
  formatSmtpData,
  sendSmtpMail,
  type SmtpConfig,
  SmtpError,
} from '../src/smtp.ts';

interface CapturedMail {
  mailFrom: string;
  rcptTo: string[];
  rawData: string;
  authMode: string | null;
  authCredentials: string[];
  ehloCount: number;
  upgradedTls: boolean;
}

interface MockSmtpOptions {
  mode: 'none' | 'starttls' | 'tls';
  advertiseStarttls?: boolean;
  authMechs?: ('PLAIN' | 'LOGIN')[];
  expectedUser?: string;
  expectedPass?: string;
  rejectAuthMessage?: string;
  multilineGreeting?: boolean;
  fragmentResponses?: boolean;
  injectTrailingOnStarttls?: boolean;
  stallAfterBanner?: boolean;
  tlsCert?: { key: Buffer; cert: Buffer };
}

const unstuffData = (raw: string) =>
  raw
    .replace(/\r\n\.\r\n$/, '')
    .split('\r\n')
    .map((line) => (line.startsWith('..') ? line.slice(1) : line))
    .join('\r\n');

const decodeMimeBodies = (raw: string) => {
  const boundaryMatch = /boundary="([^"]+)"/.exec(raw);
  if (!boundaryMatch) return { raw, text: '', html: '' };
  const boundary = boundaryMatch[1]!;
  const sections = raw.split(`--${boundary}`);
  const decodePart = (part: string) => {
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) return '';
    const b64 = part.slice(idx + 4).replace(/\r\n/g, '');
    return Buffer.from(b64, 'base64').toString('utf8');
  };
  return {
    raw,
    text: decodePart(sections[1] ?? ''),
    html: decodePart(sections[2] ?? ''),
  };
};

const startMockSmtp = async (opts: MockSmtpOptions) => {
  const captured: CapturedMail[] = [];
  const sockets = new Set<Socket | TLSSocket>();

  const handleSession = (initialSock: Socket | TLSSocket) => {
    let sock: Socket | TLSSocket = initialSock;
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));

    let buf = Buffer.alloc(0);
    let state: 'cmd' | 'auth_login_user' | 'auth_login_pass' | 'data' = 'cmd';
    let dataBuf = '';
    const session: CapturedMail = {
      mailFrom: '',
      rcptTo: [],
      rawData: '',
      authMode: null,
      authCredentials: [],
      ehloCount: 0,
      upgradedTls: opts.mode === 'tls',
    };
    let pendingUser = '';

    const write = (msg: string) => {
      if (sock.destroyed) return;
      if (opts.fragmentResponses && msg.length > 4) {
        const mid = Math.floor(msg.length / 2);
        sock.write(msg.slice(0, mid));
        setTimeout(() => {
          if (!sock.destroyed) sock.write(msg.slice(mid));
        }, 5);
        return;
      }
      sock.write(msg);
    };

    const sendGreeting = () => {
      if (opts.multilineGreeting) {
        write('220-localhost ESMTP Mock 1\r\n220 localhost ESMTP Mock 2\r\n');
      } else {
        write('220 localhost ESMTP Mock\r\n');
      }
    };

    const sendEhlo = () => {
      const caps: string[] = ['250-localhost'];
      if (opts.mode === 'starttls' && !session.upgradedTls && (opts.advertiseStarttls ?? true)) {
        caps.push('250-STARTTLS');
      }
      const mechs = opts.authMechs ?? [];
      if (mechs.length) {
        caps.push(`250-AUTH ${mechs.join(' ')}`);
      }
      caps.push('250 SIZE 10485760');
      const last = caps.pop()!;
      write(`${[...caps, last.replace(/^250-/, '250 ')].join('\r\n')}\r\n`);
    };

    const onLine = (line: string) => {
      if (opts.stallAfterBanner) return;
      if (state === 'data') {
        dataBuf += `${line}\r\n`;
        if (line === '.') {
          session.rawData = unstuffData(dataBuf);
          captured.push({
            ...session,
            rcptTo: [...session.rcptTo],
            authCredentials: [...session.authCredentials],
          });
          state = 'cmd';
          dataBuf = '';
          write('250 2.0.0 OK queued\r\n');
        }
        return;
      }

      if (state === 'auth_login_user') {
        pendingUser = Buffer.from(line.trim(), 'base64').toString('utf8');
        state = 'auth_login_pass';
        write('334 UGFzc3dvcmQ6\r\n');
        return;
      }

      if (state === 'auth_login_pass') {
        const pass = Buffer.from(line.trim(), 'base64').toString('utf8');
        session.authCredentials.push(`${pendingUser}:${pass}`);
        state = 'cmd';
        if (
          (opts.expectedUser === undefined || pendingUser === opts.expectedUser) &&
          (opts.expectedPass === undefined || pass === opts.expectedPass)
        ) {
          write('235 2.7.0 Authentication successful\r\n');
        } else {
          write(`535 ${opts.rejectAuthMessage ?? `Authentication failed for ${pass}`}\r\n`);
        }
        return;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO ') || upper.startsWith('HELO ')) {
        session.ehloCount++;
        sendEhlo();
        return;
      }
      if (upper === 'STARTTLS' && opts.mode === 'starttls') {
        if (opts.injectTrailingOnStarttls) {
          write('220 2.0.0 Ready to start TLS\r\n250 injected-plaintext-after-starttls\r\n');
          return;
        }
        write('220 2.0.0 Ready to start TLS\r\n');
        sock.off('data', onData);
        const tlsSock = new TLSSocket(sock, {
          isServer: true,
          key: opts.tlsCert!.key,
          cert: opts.tlsCert!.cert,
        });
        sockets.add(tlsSock);
        tlsSock.on('error', () => {});
        tlsSock.on('close', () => sockets.delete(tlsSock));
        tlsSock.on('data', onData);
        sock = tlsSock;
        session.upgradedTls = true;
        return;
      }
      if (upper.startsWith('AUTH PLAIN ')) {
        session.authMode = 'PLAIN';
        const b64 = line.slice('AUTH PLAIN '.length).trim();
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const parts = decoded.split('\0');
        const user = parts[1] ?? '';
        const pass = parts[2] ?? '';
        session.authCredentials.push(`${user}:${pass}`);
        if (
          (opts.expectedUser === undefined || user === opts.expectedUser) &&
          (opts.expectedPass === undefined || pass === opts.expectedPass)
        ) {
          write('235 2.7.0 Authentication successful\r\n');
        } else {
          write(`535 ${opts.rejectAuthMessage ?? `Auth rejected token ${b64} / ${pass}`}\r\n`);
        }
        return;
      }
      if (upper === 'AUTH LOGIN') {
        session.authMode = 'LOGIN';
        state = 'auth_login_user';
        write('334 VXNlcm5hbWU6\r\n');
        return;
      }
      if (upper.startsWith('MAIL FROM:')) {
        session.mailFrom = line.slice(10).trim();
        write('250 2.1.0 OK\r\n');
        return;
      }
      if (upper.startsWith('RCPT TO:')) {
        session.rcptTo.push(line.slice(8).trim());
        write('250 2.1.5 OK\r\n');
        return;
      }
      if (upper === 'DATA') {
        dataBuf = '';
        state = 'data';
        write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
        return;
      }
      if (upper === 'QUIT') {
        write('221 2.0.0 Bye\r\n');
        sock.end();
        return;
      }
      write('502 Command not implemented\r\n');
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const idx = buf.indexOf(0x0a);
        if (idx === -1) break;
        let line = buf.subarray(0, idx);
        buf = buf.subarray(idx + 1);
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
          line = line.subarray(0, line.length - 1);
        }
        onLine(line.toString('utf8'));
      }
    };

    sock.on('data', onData);
    if (!opts.stallAfterBanner) sendGreeting();
    else write('220 localhost ESMTP Stalling\r\n');
  };

  const server =
    opts.mode === 'tls'
      ? createTlsServer({ key: opts.tlsCert!.key, cert: opts.tlsCert!.cert }, handleSession)
      : createTcpServer(handleSession);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    captured,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

let certDir = '';
let tlsCert: { key: Buffer; cert: Buffer };
const closers: (() => Promise<void>)[] = [];

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'dowel-smtp-cert-'));
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  const res = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`生成测试 TLS 证书失败：${res.stderr}`);
  }
  tlsCert = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
});

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

afterAll(() => {
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

const baseConfig = (port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  username: '',
  password: null,
  fromAddress: 'noreply@example.com',
  fromName: 'Dowel 测试',
  ...overrides,
});

describe('原生 SMTP 客户端', () => {
  test('明文模式：无认证发信，支持多行/分片响应、点填充与 UTF-8 编码', async () => {
    const srv = await startMockSmtp({
      mode: 'none',
      multilineGreeting: true,
      fragmentResponses: true,
    });
    closers.push(srv.close);

    await sendSmtpMail(baseConfig(srv.port, { security: 'none' }), {
      to: 'user@example.com',
      subject: '测试中文主题 🎉 与 Emoji',
      text: '第一行\n.点开头行\n.\n结束',
      html: '<p>第一行 <b>HTML</b></p>',
    });

    expect(srv.captured).toHaveLength(1);
    const mail = srv.captured[0]!;
    expect(mail.mailFrom).toBe('<noreply@example.com>');
    expect(mail.rcptTo).toEqual(['<user@example.com>']);
    expect(mail.authMode).toBeNull();
    expect(mail.rawData).toContain('Subject: =?UTF-8?B?');
    expect(mail.rawData).toContain('From: =?UTF-8?B?');

    const decoded = decodeMimeBodies(mail.rawData);
    expect(decoded.text).toBe('第一行\r\n.点开头行\r\n.\r\n结束');
    expect(decoded.html).toBe('<p>第一行 <b>HTML</b></p>');
  });

  test('STARTTLS 模式：升级加密后才执行 AUTH PLAIN，并刷新 EHLO', async () => {
    const srv = await startMockSmtp({
      mode: 'starttls',
      advertiseStarttls: true,
      authMechs: ['PLAIN'],
      expectedUser: 'smtp-user',
      expectedPass: 'super-secret-pass',
      tlsCert,
    });
    closers.push(srv.close);

    await sendSmtpMail(
      baseConfig(srv.port, {
        host: 'localhost',
        security: 'starttls',
        username: 'smtp-user',
        password: 'super-secret-pass',
      }),
      {
        to: 'alice@example.com',
        subject: 'STARTTLS Test',
        text: 'hello',
        html: '<p>hello</p>',
      },
      { tlsCa: tlsCert.cert },
    );

    expect(srv.captured).toHaveLength(1);
    expect(srv.captured[0]!.upgradedTls).toBe(true);
    expect(srv.captured[0]!.ehloCount).toBe(2);
    expect(srv.captured[0]!.authMode).toBe('PLAIN');
    expect(srv.captured[0]!.authCredentials).toEqual(['smtp-user:super-secret-pass']);
  });

  test('STARTTLS 模式：服务端不宣告 STARTTLS 时严格拒绝且绝不降级', async () => {
    const srv = await startMockSmtp({
      mode: 'starttls',
      advertiseStarttls: false,
      authMechs: ['PLAIN'],
      tlsCert,
    });
    closers.push(srv.close);

    await expect(
      sendSmtpMail(
        baseConfig(srv.port, { security: 'starttls', username: 'u', password: 'p' }),
        { to: 'a@b.com', subject: 's', text: 't', html: '<p>t</p>' },
        { tlsCa: tlsCert.cert },
      ),
    ).rejects.toThrow(/STARTTLS/);
    expect(srv.captured).toHaveLength(0);
  });

  test('STARTTLS 模式：拒绝 220 后夹带的明文管道数据', async () => {
    const srv = await startMockSmtp({
      mode: 'starttls',
      advertiseStarttls: true,
      injectTrailingOnStarttls: true,
      tlsCert,
    });
    closers.push(srv.close);

    await expect(
      sendSmtpMail(
        baseConfig(srv.port, { security: 'starttls' }),
        { to: 'a@b.com', subject: 's', text: 't', html: '<p>t</p>' },
        { tlsCa: tlsCert.cert },
      ),
    ).rejects.toThrow(/尾随数据/);
  });

  test('隐式 SSL/TLS 模式 + AUTH LOGIN：校验证书并正常发信', async () => {
    const srv = await startMockSmtp({
      mode: 'tls',
      authMechs: ['LOGIN'],
      expectedUser: 'login-user',
      expectedPass: 'login-secret-99',
      tlsCert,
    });
    closers.push(srv.close);

    // 不传 tlsCa 时必须校验证书并拒绝自签证书
    await expect(
      sendSmtpMail(
        baseConfig(srv.port, {
          host: 'localhost',
          security: 'tls',
          username: 'login-user',
          password: 'login-secret-99',
        }),
        { to: 'bob@example.com', subject: 'TLS Fail', text: 't', html: '<p>t</p>' },
      ),
    ).rejects.toThrow(SmtpError);

    // 传入受信 CA 后正常发信
    await sendSmtpMail(
      baseConfig(srv.port, {
        host: 'localhost',
        security: 'tls',
        username: 'login-user',
        password: 'login-secret-99',
      }),
      { to: 'bob@example.com', subject: 'TLS OK', text: 'body', html: '<p>body</p>' },
      { tlsCa: tlsCert.cert },
    );

    expect(srv.captured).toHaveLength(1);
    expect(srv.captured[0]!.authMode).toBe('LOGIN');
    expect(srv.captured[0]!.authCredentials).toEqual(['login-user:login-secret-99']);
  });

  test('认证失败错误消息脱敏，绝不泄露密码与 Base64 凭据', async () => {
    const secret = 'VerySecretPass!123';
    const srv = await startMockSmtp({
      mode: 'none',
      authMechs: ['PLAIN'],
      expectedUser: 'u',
      expectedPass: 'other',
    });
    closers.push(srv.close);

    const err = await sendSmtpMail(
      baseConfig(srv.port, { security: 'none', username: 'u', password: secret }),
      { to: 'a@b.com', subject: 's', text: 't', html: '<p>t</p>' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SmtpError);
    const msg = (err as Error).message;
    const plainToken = Buffer.from(`\0u\0${secret}`, 'utf8').toString('base64');
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain(plainToken);
    expect(msg).toContain('***');
  });

  test('拦截所有 CRLF 与空字节注入尝试', async () => {
    const cases: Array<() => Promise<void>> = [
      () =>
        sendSmtpMail(baseConfig(25, { fromAddress: 'a@b.com\r\nBcc: evil@x.com' }), {
          to: 'u@b.com',
          subject: 'ok',
          text: 't',
          html: '<p>t</p>',
        }),
      () =>
        sendSmtpMail(baseConfig(25, { fromName: 'Dowel\nBcc: evil@x.com' }), {
          to: 'u@b.com',
          subject: 'ok',
          text: 't',
          html: '<p>t</p>',
        }),
      () =>
        sendSmtpMail(baseConfig(25), {
          to: 'u@b.com\r\nRcpt: x@y.com',
          subject: 'ok',
          text: 't',
          html: '<p>t</p>',
        }),
      () =>
        sendSmtpMail(baseConfig(25), {
          to: 'u@b.com',
          subject: 'ok\0\r\nBcc: x@y.com',
          text: 't',
          html: '<p>t</p>',
        }),
      () =>
        sendSmtpMail(baseConfig(25, { username: 'user\r\n' }), {
          to: 'u@b.com',
          subject: 'ok',
          text: 't',
          html: '<p>t</p>',
        }),
      () =>
        sendSmtpMail(baseConfig(25, { host: 'smtp.example.com\n' }), {
          to: 'u@b.com',
          subject: 'ok',
          text: 't',
          html: '<p>t</p>',
        }),
    ];
    for (const run of cases) {
      await expect(run()).rejects.toThrow(SmtpError);
    }
  });

  test('总超时中断挂起会话并销毁 socket，无未捕获异常', async () => {
    const srv = await startMockSmtp({ mode: 'none', stallAfterBanner: true });
    closers.push(srv.close);

    await expect(
      sendSmtpMail(
        baseConfig(srv.port),
        { to: 'u@b.com', subject: 'timeout', text: 't', html: '<p>t</p>' },
        { totalTimeoutMs: 120, connectTimeoutMs: 100 },
      ),
    ).rejects.toThrow(/超时/);
  });

  test('纯辅助函数：encodeHeaderValue、formatSmtpData、buildMimeMessage', () => {
    expect(encodeHeaderValue('Plain ASCII Subject')).toBe('Plain ASCII Subject');
    expect(encodeHeaderValue('重置密码：Dowel 平台')).toMatch(/^=\?UTF-8\?B\?/);
    expect(formatSmtpData('a\r\n.b\n..c\r\n')).toBe('a\r\n..b\r\n...c\r\n.\r\n');
    const mime = buildMimeMessage(
      baseConfig(25),
      { to: 'u@b.com', subject: 'hi', text: 't', html: '<p>t</p>' },
      'localhost',
    );
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="');
  });
});
