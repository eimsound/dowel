import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

import { expect, test } from '@playwright/test';

interface CapturedEmail {
  mailFrom: string;
  rcptTo: string[];
  raw: string;
  decodedText: string;
}

function decodeMimeParts(raw: string): string {
  const parts: string[] = [raw];
  const regex = /Content-Transfer-Encoding:\s*base64\r?\n\r?\n([\s\S]*?)(?=\r?\n--|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const b64 = match[1]?.replace(/\s+/g, '') ?? '';
    if (b64.length > 0) {
      parts.push(Buffer.from(b64, 'base64').toString('utf8'));
    }
  }
  return parts.join('\n');
}

async function startMockSmtpServer(): Promise<{
  port: number;
  messages: CapturedEmail[];
  waitForCount: (count: number, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}> {
  const messages: CapturedEmail[] = [];
  const waiters: Array<() => void> = [];

  const server = net.createServer((socket) => {
    socket.write('220 mock-smtp.local ESMTP ready\r\n');
    let buf = '';
    let inData = false;
    let mailFrom = '';
    let rcptTo: string[] = [];
    let dataLines: string[] = [];

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      while (true) {
        const idx = buf.indexOf('\r\n');
        if (idx === -1) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            const raw = dataLines.map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n');
            messages.push({
              mailFrom,
              rcptTo: [...rcptTo],
              raw,
              decodedText: decodeMimeParts(raw),
            });
            dataLines = [];
            socket.write('250 2.0.0 Ok: queued\r\n');
            for (const w of waiters.splice(0)) w();
          } else {
            dataLines.push(line);
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO ') || upper.startsWith('HELO ')) {
          socket.write('250-mock-smtp.local\r\n250 SIZE 10485760\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          mailFrom = line.slice(10).trim();
          rcptTo = [];
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          rcptTo.push(line.slice(8).trim());
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          dataLines = [];
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'RSET') {
          mailFrom = '';
          rcptTo = [];
          socket.write('250 2.0.0 Ok\r\n');
        } else if (upper === 'NOOP') {
          socket.write('250 2.0.0 Ok\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('502 5.5.1 Unrecognized command\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock SMTP port');
  }

  return {
    port: addr.port,
    messages,
    waitForCount: async (count: number, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${count} SMTP messages (got ${messages.length})`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(200, deadline - Date.now()));
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('No port')));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function startDowelServer(port: number): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const baseUrl = `http://localhost:${port}`;
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['apps/server/dist/main.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DOWEL_DB: ':memory:',
      DOWEL_SECRET: 'e2e-smtp-secret-key-at-least-16-chars',
      DOWEL_PUBLIC_URL: baseUrl,
      DOWEL_ADMIN_USERNAME: 'admin',
      DOWEL_ADMIN_PASSWORD: 'e2e-admin-password',
      DOWEL_LOGIN_IP_LIMIT: '10000',
      DOWEL_DRIFT_INTERVAL_MINUTES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => {
    output += d.toString('utf8');
  });
  child.stderr?.on('data', (d) => {
    output += d.toString('utf8');
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Dowel server exited early (${child.exitCode}):\n${output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/instance`);
      if (res.ok) {
        return {
          baseUrl,
          stop: async () => {
            if (child.exitCode !== null) return;
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => {
              const t = setTimeout(() => {
                if (child.exitCode === null) child.kill('SIGKILL');
                resolve();
              }, 3000);
              child.once('exit', () => {
                clearTimeout(t);
                resolve();
              });
            });
          },
        };
      }
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Dowel server did not become ready on ${baseUrl}:\n${output}`);
}

test('admin SMTP configuration, test email, email invite, and forgot-password reset flow', async ({
  page,
  browser,
}) => {
  const smtp = await startMockSmtpServer();
  const port = await getFreePort();
  const dowel = await startDowelServer(port);
  const baseUrl = dowel.baseUrl;

  try {
    // 1. Before SMTP is enabled, Login does not show "Forgot password?"
    await page.goto(`${baseUrl}/login`);
    await expect(page.getByRole('link', { name: '忘记密码？' })).toHaveCount(0);

    // 2. Admin logs in and configures SMTP in /admin/settings
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill('e2e-admin-password');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();

    await page.goto(`${baseUrl}/admin/settings`);
    await expect(page.getByRole('heading', { name: '邮件服务（SMTP）' })).toBeVisible();

    await page.getByLabel('启用邮件服务（用于忘记密码与发送邀请邮件）').setChecked(true);
    await page.getByLabel('传输加密').selectOption('none');
    await page.getByLabel('SMTP 主机').fill('127.0.0.1');
    await page.getByLabel('端口').fill(String(smtp.port));
    await page.getByLabel('发件人邮箱').fill('noreply@dowel.test');
    await page.getByLabel('发件人名称（可选）').fill('Dowel CI');
    await page.getByRole('button', { name: '保存邮件设置' }).click();
    await expect(page.getByText('已保存邮件设置')).toBeVisible();

    // 3. Send a test email
    await page.getByLabel('收件人邮箱').fill('probe@dowel.test');
    await page.getByRole('button', { name: '发送测试邮件' }).click();
    await expect(page.getByText('测试邮件已发送至 probe@dowel.test')).toBeVisible();

    await smtp.waitForCount(1);
    expect(smtp.messages[0]?.rcptTo).toEqual(['<probe@dowel.test>']);
    expect(smtp.messages[0]?.decodedText).toContain('noreply@dowel.test');

    // 4. Create an invite and send invite email
    await page.goto(`${baseUrl}/admin/invites`);
    await page.getByLabel('受邀人邮箱（可选）').fill('Alice@Example.COM');
    await page.getByLabel('通过邮件发送邀请链接').setChecked(true);
    await page.getByRole('button', { name: '生成邀请' }).click();
    await expect(page.getByText('邀请邮件已发送至 alice@example.com')).toBeVisible();

    await smtp.waitForCount(2);
    const inviteEmail = smtp.messages[1]!;
    expect(inviteEmail.rcptTo).toEqual(['<alice@example.com>']);
    const inviteMatch = inviteEmail.decodedText.match(
      new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/invite/[A-Za-z0-9_-]+`),
    );
    expect(inviteMatch).not.toBeNull();
    const inviteUrl = inviteMatch![0];

    // 5. Recipient opens invite link in a clean context, verifies prefilled email, and accepts
    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    try {
      await userPage.goto(inviteUrl);
      await expect(userPage.getByRole('heading', { name: '接受邀请' })).toBeVisible();
      await expect(userPage.getByLabel('邮箱（可选）')).toHaveValue('alice@example.com');

      await userPage.getByLabel('用户名').fill('alice');
      await userPage.getByLabel('名字').fill('Alice');
      await userPage.getByLabel('密码').fill('AlicePass123!');
      await userPage.getByRole('button', { name: '接受邀请' }).click();
      await expect(userPage.getByRole('heading', { name: '我的项目' })).toBeVisible();

      // 6. Alice signs out, uses "Forgot password?" with mixed-case email
      await userPage.getByRole('button', { name: '账户菜单' }).click();
      await userPage.getByText('退出', { exact: true }).click();
      await expect(userPage).toHaveURL(/\/login$/);
      const forgotLink = userPage.getByRole('link', { name: '忘记密码？' });
      await expect(forgotLink).toBeVisible();
      await forgotLink.click();

      await expect(userPage).toHaveURL(/\/forgot-password$/);
      await expect(userPage.getByRole('heading', { name: '忘记密码' })).toBeVisible();
      await userPage.getByLabel('邮箱').fill('  ALICE@EXAMPLE.COM  ');
      await userPage.getByRole('button', { name: '发送重置邮件' }).click();
      await expect(
        userPage.getByText('如果该邮箱存在关联的活跃账号，重置密码邮件已发送至你的邮箱。'),
      ).toBeVisible();

      await smtp.waitForCount(3);
      const resetEmail = smtp.messages[2]!;
      expect(resetEmail.rcptTo).toEqual(['<alice@example.com>']);
      const resetMatch = resetEmail.decodedText.match(
        new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/reset/[A-Za-z0-9_-]+`),
      );
      expect(resetMatch).not.toBeNull();
      const resetUrl = resetMatch![0];

      // 7. Reset password via email link and sign in with the new password
      await userPage.goto(resetUrl);
      await expect(userPage.getByRole('heading', { name: '重置密码' })).toBeVisible();
      await userPage.getByLabel('新密码').fill('AliceNewPass456!');
      await userPage.getByRole('button', { name: '设置新密码' }).click();
      await expect(userPage.getByText('密码已更新，请用新密码登录。')).toBeVisible();
      await userPage.getByRole('button', { name: '去登录' }).click();

      await userPage.getByLabel('用户名').fill('alice');
      await userPage.getByLabel('密码').fill('AliceNewPass456!');
      await userPage.getByRole('button', { name: '登录' }).click();
      await expect(userPage.getByRole('heading', { name: '我的项目' })).toBeVisible();
    } finally {
      await userContext.close();
    }
  } finally {
    await dowel.stop();
    await smtp.close();
  }
});
