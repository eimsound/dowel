// 零依赖原生 SMTP 客户端（基于 node:net / node:tls）：
// 支持 STARTTLS（强制协商，绝不静默降级）、隐式 SSL/TLS 与无加密三种传输模式，
// 以及 AUTH PLAIN / AUTH LOGIN / 无认证模式；严格拦截头部换行与空字节注入，并统一脱敏密码。

import { randomBytes, randomUUID } from 'node:crypto';
import { isIP, Socket, connect as tcpConnect } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';

import type { SmtpSecurity } from '@dowel/api';

import { scrubSecrets } from './secrets.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string | null;
  fromAddress: string;
  fromName: string;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SmtpSendOptions {
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  ehloDomain?: string;
  /** 仅用于测试环境注入自签 TLS CA 证书；生产路径始终校验服务端证书链 */
  tlsCa?: string | Buffer | Array<string | Buffer>;
}

export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpError';
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;
const MAX_LINE_BYTES = 64 * 1024;

const hasUnsafeControl = (s: string) => /[\r\n\0]/.test(s);

const assertHeaderSafe = (value: string, label: string) => {
  if (hasUnsafeControl(value)) {
    throw new SmtpError(`${label}包含非法控制字符`);
  }
};

const assertAddressSafe = (address: string, label: string) => {
  assertHeaderSafe(address, label);
  if (!address || /[\s<>]/.test(address) || !address.includes('@')) {
    throw new SmtpError(`${label}格式不正确`);
  }
};

const sanitizeSmtpText = (text: string, secrets: readonly string[]): string => {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.replaceAll(s, '***');
  }
  return scrubSecrets(out);
};

/**
 * 将邮件头文本按 RFC 2047 编码：纯安全可打印 ASCII 原样返回；含非 ASCII 时按 UTF-8 码点安全分段做 Base64 编码。
 */
export const encodeHeaderValue = (value: string): string => {
  assertHeaderSafe(value, '邮件头字段');
  if (value === '') return '';
  if (/^[\x20-\x7e]*$/.test(value)) return value;

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of value) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (current && currentBytes + chBytes > 45) {
      chunks.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) {
    chunks.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
  }
  return chunks.join('\r\n ');
};

const formatAddressHeader = (name: string, address: string): string => {
  assertAddressSafe(address, '发件人邮箱');
  const trimmedName = name.trim();
  if (!trimmedName) return `<${address}>`;
  assertHeaderSafe(trimmedName, '发件人名称');
  if (/^[A-Za-z0-9 _.-]+$/.test(trimmedName)) {
    return `"${trimmedName}" <${address}>`;
  }
  return `${encodeHeaderValue(trimmedName)} <${address}>`;
};

const wrapBase64 = (text: string): string => {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  const b64 = Buffer.from(normalized, 'utf8').toString('base64');
  if (!b64) return '';
  return b64.match(/.{1,76}/g)!.join('\r\n');
};

/** 规范化 CRLF 并按 RFC 5321 对 DATA 正文执行行首点填充与终止符封装 */
export const formatSmtpData = (raw: string): string => {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const stuffed = lines.map((line) => (line.startsWith('.') ? `.${line}` : line));
  return `${stuffed.join('\r\n')}\r\n.\r\n`;
};

export const buildMimeMessage = (config: SmtpConfig, message: SmtpMessage, ehloDomain: string): string => {
  assertAddressSafe(config.fromAddress, '发件人邮箱');
  assertAddressSafe(message.to, '收件人邮箱');
  assertHeaderSafe(message.subject, '邮件主题');

  const boundary = `----=_Dowel_${randomBytes(12).toString('hex')}`;
  const domainPart = config.fromAddress.split('@')[1] || ehloDomain || 'localhost';
  const safeDomain = domainPart.replace(/[^a-zA-Z0-9.-]/g, '') || 'localhost';
  const messageId = `<${randomUUID()}@${safeDomain}>`;

  const headers = [
    `From: ${formatAddressHeader(config.fromName, config.fromAddress)}`,
    `To: <${message.to}>`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(message.html),
    `--${boundary}--`,
  ];

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
};

interface SmtpResponse {
  code: number;
  lines: string[];
}

interface LineReader {
  readResponse: () => Promise<SmtpResponse>;
  assertEmptyAndDetach: () => void;
  detach: () => void;
}

const createLineReader = (
  socket: Socket | TLSSocket,
  secrets: readonly string[],
  abortError: () => Error | null,
): LineReader => {
  let buf = Buffer.alloc(0);
  let fatal: Error | null = null;
  let closed = false;
  let pending: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;

  const failWaiter = (err: Error) => {
    if (!fatal) fatal = err;
    if (pending) {
      const w = pending;
      pending = null;
      w.reject(err);
    }
  };

  const tryDeliverLine = () => {
    if (!pending) return;
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return;
    let lineBuf = buf.subarray(0, nl);
    buf = buf.subarray(nl + 1);
    if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
      lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
    }
    const w = pending;
    pending = null;
    w.resolve(lineBuf.toString('utf8'));
  };

  const onData = (chunk: Buffer) => {
    if (fatal) return;
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_LINE_BYTES && buf.indexOf(0x0a) === -1) {
      failWaiter(new SmtpError('SMTP 服务端响应单行过长'));
      return;
    }
    tryDeliverLine();
  };

  const onError = (err: Error) => {
    failWaiter(new SmtpError(`SMTP 连接错误：${sanitizeSmtpText(err.message, secrets)}`));
  };

  const onClose = () => {
    closed = true;
    failWaiter(abortError() ?? new SmtpError('SMTP 连接被服务端提前关闭'));
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  const readLine = (): Promise<string> => {
    const aborted = abortError();
    if (aborted) return Promise.reject(aborted);
    const nl = buf.indexOf(0x0a);
    if (nl !== -1) {
      let lineBuf = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
        lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
      }
      return Promise.resolve(lineBuf.toString('utf8'));
    }
    if (fatal) return Promise.reject(fatal);
    if (closed) return Promise.reject(new SmtpError('SMTP 连接已关闭'));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  };

  const readResponse = async (): Promise<SmtpResponse> => {
    const lines: string[] = [];
    let expectedCode: number | null = null;
    for (;;) {
      const line = await readLine();
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      const codeOnly = !match && /^\d{3}$/.test(line) ? Number(line) : null;
      const code = match ? Number(match[1]) : codeOnly;
      if (code === null) {
        throw new SmtpError(`SMTP 服务端返回了无法解析的响应：${sanitizeSmtpText(line, secrets)}`);
      }
      if (expectedCode !== null && code !== expectedCode) {
        throw new SmtpError(`SMTP 服务端多行响应状态码不一致（期望 ${expectedCode}，收到 ${code}）`);
      }
      expectedCode = code;
      lines.push(match ? match[3]! : '');
      if (!match || match[2] === ' ') {
        return { code, lines };
      }
    }
  };

  const detach = () => {
    pending = null;
    socket.off('data', onData);
    socket.off('error', onError);
    socket.off('close', onClose);
  };

  const assertEmptyAndDetach = () => {
    if (buf.length > 0 || socket.readableLength > 0) {
      detach();
      throw new SmtpError('STARTTLS 握手前收到意外的明文尾随数据，已中止连接');
    }
    detach();
  };

  return { readResponse, assertEmptyAndDetach, detach };
};

const writeAll = (socket: Socket | TLSSocket, payload: string, secrets: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.write(payload, 'utf8', (err) => {
      if (err) reject(new SmtpError(`SMTP 写入失败：${sanitizeSmtpText(err.message, secrets)}`));
      else resolve();
    });
  });

const expectCode = (
  res: SmtpResponse,
  expected: number | readonly number[],
  stage: string,
  secrets: readonly string[],
) => {
  const allowed = typeof expected === 'number' ? [expected] : expected;
  if (!allowed.includes(res.code)) {
    const detail = sanitizeSmtpText(res.lines.join(' ').trim(), secrets);
    throw new SmtpError(`${stage}失败（${res.code}${detail ? `: ${detail}` : ''}）`);
  }
};

const parseEhloCapabilities = (lines: readonly string[]) => {
  let starttls = false;
  const authMechs = new Set<string>();
  for (const raw of lines.slice(1)) {
    const line = raw.trim().toUpperCase();
    if (line === 'STARTTLS') starttls = true;
    if (line.startsWith('AUTH ') || line.startsWith('AUTH=')) {
      for (const tok of line.slice(5).trim().split(/\s+/)) {
        if (tok) authMechs.add(tok);
      }
    }
  }
  return { starttls, authMechs };
};

const safeEhloDomain = (raw: string | undefined): string => {
  const domain = raw?.trim() || 'localhost';
  assertHeaderSafe(domain, 'EHLO 域名');
  return /^[\x21-\x7e]+$/.test(domain) ? domain : 'localhost';
};

/** 通过原生 SMTP 协议发送单封邮件 */
export const sendSmtpMail = async (
  config: SmtpConfig,
  message: SmtpMessage,
  options?: SmtpSendOptions,
): Promise<void> => {
  const host = config.host.trim();
  if (!host || /[\s\r\n\0]/.test(host) || host.includes('://')) {
    throw new SmtpError('SMTP 主机格式不正确');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new SmtpError('SMTP 端口必须在 1–65535 之间');
  }
  assertHeaderSafe(config.username, 'SMTP 用户名');
  if (config.password !== null) assertHeaderSafe(config.password, 'SMTP 密码');
  assertAddressSafe(config.fromAddress, '发件人邮箱');
  assertHeaderSafe(config.fromName, '发件人名称');
  assertAddressSafe(message.to, '收件人邮箱');
  assertHeaderSafe(message.subject, '邮件主题');

  const ehloDomain = safeEhloDomain(options?.ehloDomain);
  const mime = buildMimeMessage(config, message, ehloDomain);
  const dataPayload = formatSmtpData(mime);

  const hasAuth = config.username.length > 0 || (config.password !== null && config.password.length > 0);
  const password = config.password ?? '';
  const plainAuthToken = hasAuth
    ? Buffer.from(`\0${config.username}\0${password}`, 'utf8').toString('base64')
    : '';
  const loginPassToken = hasAuth && password ? Buffer.from(password, 'utf8').toString('base64') : '';
  const secrets = [password, plainAuthToken, loginPassToken].filter(Boolean);

  const connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  let activeSocket: Socket | TLSSocket | null = null;
  let plainSocket: Socket | null = null;
  let tlsSocket: TLSSocket | null = null;
  let reader: LineReader | null = null;
  let timeoutError: SmtpError | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectPendingTimeout: ((err: Error) => void) | null = null;

  const destroySockets = () => {
    reader?.detach();
    reader = null;
    if (tlsSocket && !tlsSocket.destroyed) tlsSocket.destroy();
    if (plainSocket && !plainSocket.destroyed) plainSocket.destroy();
  };

  const triggerAbort = (err: SmtpError) => {
    if (!timeoutError) timeoutError = err;
    destroySockets();
    const reject = rejectPendingTimeout;
    rejectPendingTimeout = null;
    reject?.(err);
  };

  const withRace = <T>(promise: Promise<T>): Promise<T> => {
    if (timeoutError) return Promise.reject(timeoutError);
    return new Promise<T>((resolve, reject) => {
      rejectPendingTimeout = reject;
      promise.then(
        (v) => {
          rejectPendingTimeout = null;
          resolve(v);
        },
        (err: unknown) => {
          rejectPendingTimeout = null;
          reject(timeoutError ?? err);
        },
      );
    });
  };

  totalTimer = setTimeout(() => {
    triggerAbort(new SmtpError('SMTP 发送邮件超时'));
  }, totalTimeoutMs);
  totalTimer.unref?.();

  try {
    const servername = isIP(host) ? undefined : host;
    const tlsExtra = options?.tlsCa ? { ca: options.tlsCa } : {};

    if (config.security === 'tls') {
      await withRace(
        new Promise<void>((resolve, reject) => {
          const sock = tlsConnect({
            host,
            port: config.port,
            ...(servername ? { servername } : {}),
            rejectUnauthorized: true,
            ...tlsExtra,
          });
          tlsSocket = sock;
          activeSocket = sock;
          // 始终挂 error 监听防止事件发射未捕获异常
          const onErr = (err: Error) => {
            reject(new SmtpError(`SMTP TLS 连接失败：${sanitizeSmtpText(err.message, secrets)}`));
          };
          sock.once('error', onErr);
          connectTimer = setTimeout(() => {
            triggerAbort(new SmtpError('SMTP 建连超时'));
          }, connectTimeoutMs);
          connectTimer.unref?.();
          sock.once('secureConnect', () => {
            clearTimeout(connectTimer);
            connectTimer = undefined;
            sock.off('error', onErr);
            sock.on('error', () => {});
            resolve();
          });
        }),
      );
    } else {
      await withRace(
        new Promise<void>((resolve, reject) => {
          const sock = tcpConnect({ host, port: config.port });
          plainSocket = sock;
          activeSocket = sock;
          const onErr = (err: Error) => {
            reject(new SmtpError(`SMTP 连接失败：${sanitizeSmtpText(err.message, secrets)}`));
          };
          sock.once('error', onErr);
          connectTimer = setTimeout(() => {
            triggerAbort(new SmtpError('SMTP 建连超时'));
          }, connectTimeoutMs);
          connectTimer.unref?.();
          sock.once('connect', () => {
            clearTimeout(connectTimer);
            connectTimer = undefined;
            sock.off('error', onErr);
            sock.on('error', () => {});
            resolve();
          });
        }),
      );
    }

    reader = createLineReader(activeSocket!, secrets, () => timeoutError);
    const cmd = async (line: string, expected: number | readonly number[], stage: string) => {
      await withRace(writeAll(activeSocket!, `${line}\r\n`, secrets));
      const res = await withRace(reader!.readResponse());
      expectCode(res, expected, stage, secrets);
      return res;
    };

    const greeting = await withRace(reader.readResponse());
    expectCode(greeting, 220, 'SMTP 握手', secrets);

    let ehlo = await cmd(`EHLO ${ehloDomain}`, 250, 'EHLO');
    let caps = parseEhloCapabilities(ehlo.lines);

    if (config.security === 'starttls') {
      if (!caps.starttls) {
        throw new SmtpError('SMTP 服务器不支持 STARTTLS，已拒绝降级为明文连接');
      }
      await cmd('STARTTLS', 220, 'STARTTLS');
      reader.assertEmptyAndDetach();
      reader = null;

      await withRace(
        new Promise<void>((resolve, reject) => {
          const upgraded = tlsConnect({
            socket: plainSocket!,
            ...(servername ? { servername } : {}),
            rejectUnauthorized: true,
            ...tlsExtra,
          });
          tlsSocket = upgraded;
          activeSocket = upgraded;
          const onErr = (err: Error) => {
            reject(new SmtpError(`STARTTLS 握手失败：${sanitizeSmtpText(err.message, secrets)}`));
          };
          upgraded.once('error', onErr);
          upgraded.once('secureConnect', () => {
            upgraded.off('error', onErr);
            upgraded.on('error', () => {});
            resolve();
          });
        }),
      );

      reader = createLineReader(activeSocket!, secrets, () => timeoutError);
      ehlo = await cmd(`EHLO ${ehloDomain}`, 250, 'STARTTLS 后 EHLO');
      caps = parseEhloCapabilities(ehlo.lines);
    }

    if (hasAuth) {
      if (caps.authMechs.has('PLAIN')) {
        await cmd(`AUTH PLAIN ${plainAuthToken}`, 235, 'SMTP 认证');
      } else if (caps.authMechs.has('LOGIN')) {
        await cmd('AUTH LOGIN', 334, 'SMTP 认证');
        await cmd(Buffer.from(config.username, 'utf8').toString('base64'), 334, 'SMTP 认证');
        await cmd(Buffer.from(password, 'utf8').toString('base64'), 235, 'SMTP 认证');
      } else {
        throw new SmtpError('SMTP 服务器不支持 AUTH PLAIN 或 AUTH LOGIN 认证');
      }
    }

    await cmd(`MAIL FROM:<${config.fromAddress}>`, 250, 'MAIL FROM');
    await cmd(`RCPT TO:<${message.to}>`, [250, 251], 'RCPT TO');
    await cmd('DATA', 354, 'DATA');
    await withRace(writeAll(activeSocket!, dataPayload, secrets));
    const dataDone = await withRace(reader.readResponse());
    expectCode(dataDone, 250, '邮件正文投递', secrets);

    // 尽力礼貌退出，投递已确认成功时不因 QUIT 失败报错
    try {
      await withRace(writeAll(activeSocket!, 'QUIT\r\n', secrets));
      await withRace(reader.readResponse());
    } catch {
      // ignore QUIT error after 250 OK
    }
  } catch (err) {
    if (err instanceof SmtpError) {
      throw new SmtpError(sanitizeSmtpText(err.message, secrets));
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new SmtpError(sanitizeSmtpText(msg, secrets));
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    destroySockets();
  }
};
