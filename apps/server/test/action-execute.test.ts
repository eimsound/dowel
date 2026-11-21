// actions/execute/run.sh 专项测试（不依赖 PostgreSQL）：
// - 非法 DOWEL_CONNECT_TIMEOUT / DOWEL_TIMEOUT 在发起请求前直接拒绝并报结构化错误；
// - 极短超时（DOWEL_TIMEOUT=1）访问延迟响应的本地 mock HTTP server 会在约 1 秒后超时失败，返回 network_error 且绝不自动重试；
// - 默认参数与自定义超时参数下正常调用成功，且验证传给 curl 的参数（含 --connect-timeout / --max-time、无 --retry、令牌不进命令行）。
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const ACTION_SCRIPT = resolve(import.meta.dirname, '../../../actions/execute/run.sh');
const SAMPLE_TOKEN = `dwl_${'A'.repeat(43)}`;

type MockMode = 'ok' | 'hang' | 'slow-ok';

/** 解析 GITHUB_OUTPUT（支持单行 key=value 和 heredoc key<<DELIM） */
const parseGithubOutput = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    const h = /^([^=<]+)<<(.+)$/.exec(line);
    if (h) {
      const vals: string[] = [];
      for (i++; i < lines.length && lines[i] !== h[2]; i++) vals.push(lines[i]!);
      out[h[1]!] = vals.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
};

describe('actions/execute/run.sh 超时保护与参数校验（#16）', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl = '';
  let workDir = '';
  let mode: MockMode = 'ok';
  let slowDelayMs = 1500;
  let requestCount = 0;
  let lastAuth = '';
  let lastBody = '';
  const openSockets = new Set<Socket>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  const runAction = async (env: Record<string, string | undefined> = {}) => {
    const outFile = join(workDir, `out-${Math.random().toString(36).slice(2)}`);
    const mergedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: outFile,
      DOWEL_URL: baseUrl,
      DOWEL_TOKEN: SAMPLE_TOKEN,
      DOWEL_PROJECT: 'acme/shop',
      DOWEL_ENVIRONMENT: 'staging',
      DOWEL_TO: 'latest',
    };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete mergedEnv[k];
      else mergedEnv[k] = v;
    }
    const t0 = Date.now();
    try {
      const res = await execFileAsync('bash', [ACTION_SCRIPT], { env: mergedEnv, timeout: 15_000 });
      const outputs = parseGithubOutput(readFileSync(outFile, 'utf8'));
      return { code: 0, stdout: res.stdout, stderr: res.stderr, outputs, elapsedMs: Date.now() - t0 };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      let outputs: Record<string, string> = {};
      try {
        outputs = parseGithubOutput(readFileSync(outFile, 'utf8'));
      } catch {}
      return {
        code: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        outputs,
        elapsedMs: Date.now() - t0,
      };
    }
  };

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'dowel-action-exec-'));
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestCount++;
      lastAuth = req.headers.authorization ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastBody = Buffer.concat(chunks).toString('utf8');
        const okPayload = JSON.stringify({
          ok: true,
          dryRun: false,
          project: 'acme/shop',
          environment: 'staging',
          from: { id: 'v1', number: 1, name: 'init' },
          to: { id: 'v2', number: 2, name: 'add-col' },
          reached: { id: 'v2', number: 2, name: 'add-col' },
          migrations: [{ number: 2, name: 'add-col', direction: 'up' }],
          noop: false,
          durationMs: 12,
        });
        if (mode === 'ok') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(okPayload);
          return;
        }
        if (mode === 'slow-ok') {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            if (!res.writableEnded) {
              res.writeHead(200, { 'content-type': 'application/json' }).end(okPayload);
            }
          }, slowDelayMs);
          timer.unref();
          pendingTimers.add(timer);
          return;
        }
        // mode === 'hang'：接收完请求但挂起不返回，用于验证 curl --max-time 超时保护
      });
    });
    server.on('connection', (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    mode = 'ok';
    slowDelayMs = 1500;
    requestCount = 0;
    lastAuth = '';
    lastBody = '';
  });

  afterAll(async () => {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(workDir, { recursive: true, force: true });
  });

  test('非法 DOWEL_CONNECT_TIMEOUT 在发起请求前直接拒绝并报结构化错误', async () => {
    const invalidValues = [
      '0',
      '-1',
      'abc',
      '010',
      '08',
      '3601',
      '99999999999999999999',
      '1.5',
      ' 15',
      '15 ',
      '15\n20',
      '15\n',
      '15 --retry 3',
    ];
    for (const bad of invalidValues) {
      const r = await runAction({ DOWEL_CONNECT_TIMEOUT: bad });
      expect(r.code, `connect-timeout=${JSON.stringify(bad)}`).toBe(1);
      expect(r.stderr, `connect-timeout=${JSON.stringify(bad)}`).toContain('[invalid_input]');
      expect(r.stderr).toContain('connect-timeout');
    }

    // GitHub Actions 模式下输出 ::error::[invalid_input] 且转义换行
    const gha = await runAction({
      DOWEL_CONNECT_TIMEOUT: '15\n::set-output name=pwn::1',
      GITHUB_ACTIONS: 'true',
    });
    expect(gha.code).toBe(1);
    expect(gha.stdout).toContain('::error::[invalid_input]');
    expect(gha.stdout).toContain('%0A');
    expect(gha.stdout).not.toContain('\n::set-output');
    expect(requestCount).toBe(0);
  });

  test('非法 DOWEL_TIMEOUT 在发起请求前直接拒绝并报结构化错误', async () => {
    const invalidValues = [
      '-1',
      'abc',
      '00',
      '010',
      '08',
      '86401',
      '99999999999999999999',
      '1.5',
      ' 10',
      '10 ',
      '10\n20',
      '10\n',
      '10 --retry 3',
    ];
    for (const bad of invalidValues) {
      const r = await runAction({ DOWEL_TIMEOUT: bad });
      expect(r.code, `timeout=${JSON.stringify(bad)}`).toBe(1);
      expect(r.stderr, `timeout=${JSON.stringify(bad)}`).toContain('[invalid_input]');
      expect(r.stderr).toContain('timeout');
    }

    const gha = await runAction({
      DOWEL_TIMEOUT: '010\ninject',
      GITHUB_ACTIONS: 'true',
    });
    expect(gha.code).toBe(1);
    expect(gha.stdout).toContain('::error::[invalid_input]');
    expect(gha.stdout).toContain('%0A');
    expect(requestCount).toBe(0);
  });

  test('DOWEL_TIMEOUT=1 访问挂起响应的服务会在约 1 秒后超时失败，返回 network_error 且不重试', async () => {
    mode = 'hang';
    const r = await runAction({
      DOWEL_TIMEOUT: '1',
      GITHUB_ACTIONS: 'true',
    });
    expect(r.code).toBe(1);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(800);
    expect(r.elapsedMs).toBeLessThan(5000);
    expect(r.outputs).toEqual({
      ok: 'false',
      code: 'network_error',
      reached: '',
      noop: 'false',
      response: '',
    });
    expect(r.stdout).toContain('::error::[network_error]');
    expect(r.stdout + r.stderr).not.toContain(SAMPLE_TOKEN);
    // 绝不对非幂等写接口自动重试
    expect(requestCount).toBe(1);
  });

  test('DOWEL_TIMEOUT=0 关闭整次请求总超时限制，慢响应仍能正常完成', async () => {
    mode = 'slow-ok';
    slowDelayMs = 1200;
    const r = await runAction({
      DOWEL_TIMEOUT: '0',
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.outputs).toMatchObject({ ok: 'true', code: '', reached: 'v2', noop: 'false' });
    expect(requestCount).toBe(1);
  });

  test('默认参数下正常调用成功，且验证传给 curl 的超时参数、无 --retry 与令牌隔离', async () => {
    // 1. 直接使用系统 curl 默认参数调用
    const normal = await runAction();
    expect(normal.code, normal.stderr).toBe(0);
    expect(normal.outputs).toMatchObject({ ok: 'true', code: '', reached: 'v2', noop: 'false' });
    expect(lastAuth).toBe(`Bearer ${SAMPLE_TOKEN}`);
    expect(JSON.parse(lastBody)).toEqual({ to: 'latest', dryRun: false, lockTimeoutSeconds: 30 });

    // 2. 通过包装脚本记录真实传给 curl 的 argv（随后转发给系统 curl）
    const { stdout: realCurlOut } = await execFileAsync('bash', ['-c', 'command -v curl']);
    const realCurl = realCurlOut.trim();
    const argsLog = join(workDir, 'curl-args.log');
    const shimTmp = mkdtempSync(join(tmpdir(), 'dowel-curl-shim-'));
    try {
      const curlShim = join(shimTmp, 'curl');
      writeFileSync(
        curlShim,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsLog)}\nexec ${JSON.stringify(realCurl)} "$@"\n`,
        'utf8',
      );
      chmodSync(curlShim, 0o755);
      const shimEnvPath = `${shimTmp}:${process.env.PATH ?? ''}`;

      // 默认值：--connect-timeout 15 --max-time 1800，无 --retry，令牌不出现在命令行参数
      const rDefault = await runAction({ PATH: shimEnvPath });
      expect(rDefault.code, rDefault.stderr).toBe(0);
      const defaultArgs = readFileSync(argsLog, 'utf8').trim().split('\n');
      expect(defaultArgs).toContain('--connect-timeout');
      expect(defaultArgs[defaultArgs.indexOf('--connect-timeout') + 1]).toBe('15');
      expect(defaultArgs).toContain('--max-time');
      expect(defaultArgs[defaultArgs.indexOf('--max-time') + 1]).toBe('1800');
      expect(defaultArgs.some((a) => a.startsWith('--retry'))).toBe(false);
      expect(defaultArgs.join(' ')).not.toContain(SAMPLE_TOKEN);

      // DOWEL_TIMEOUT=0：保留 --connect-timeout，不传 --max-time
      const rZero = await runAction({
        PATH: shimEnvPath,
        DOWEL_CONNECT_TIMEOUT: '7',
        DOWEL_TIMEOUT: '0',
      });
      expect(rZero.code, rZero.stderr).toBe(0);
      const zeroArgs = readFileSync(argsLog, 'utf8').trim().split('\n');
      expect(zeroArgs[zeroArgs.indexOf('--connect-timeout') + 1]).toBe('7');
      expect(zeroArgs).not.toContain('--max-time');
      expect(zeroArgs.some((a) => a.startsWith('--retry'))).toBe(false);

      // 自定义正整数超时
      const rCustom = await runAction({
        PATH: shimEnvPath,
        DOWEL_CONNECT_TIMEOUT: '25',
        DOWEL_TIMEOUT: '600',
      });
      expect(rCustom.code, rCustom.stderr).toBe(0);
      const customArgs = readFileSync(argsLog, 'utf8').trim().split('\n');
      expect(customArgs[customArgs.indexOf('--connect-timeout') + 1]).toBe('25');
      expect(customArgs[customArgs.indexOf('--max-time') + 1]).toBe('600');
    } finally {
      rmSync(shimTmp, { recursive: true, force: true });
    }
  });
});
