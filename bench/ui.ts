import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newId } from '@dowel/core';
import { autoSetup, openPlatformDb } from '@dowel/server';
import { chromium, type Page } from '@playwright/test';

import { type GeneratedSchema, generateLargeSchema } from './generator.ts';
import { collectHostEnv, formatBytes, formatMs, type StatsResult, summarizeSamples } from './utils.ts';

interface LongTaskReport {
  count: number;
  maxMs: number;
  totalDurationMs: number;
  tbtMs: number;
}

interface UiBenchReport {
  env: ReturnType<typeof collectHostEnv> & { chromiumVersion: string; playwrightVersion: string };
  scale100: {
    tableCount: number;
    firstPaintMs: number;
    longTasks: LongTaskReport;
  };
  scale1000: {
    tableCount: number;
    totalObjects: number;
    sectionCount: number;
    summaryFirstPaintMs: number;
    summaryLongTasks: LongTaskReport;
    focus1Hop: { tables: number; coldFirstPaintMs: number; longTasks: LongTaskReport };
    focus1To2HopSwitch: { tables: number; switchMs: number; longTasks: LongTaskReport };
    focus2Hop: { tables: number; coldFirstPaintMs: number; longTasks: LongTaskReport };
    expandSectionAndElk: {
      sectionName: string;
      tables: number;
      durationMs: number;
      longTasks: LongTaskReport;
    };
    explicitRelayoutElk: {
      tables: number;
      durationMs: number;
      longTasks: LongTaskReport;
    };
    interactions: {
      nodeSelect: { stats: StatsResult; totalLongTasks: LongTaskReport };
      nodeDrag: {
        frameDeltaStats: StatsResult;
        settleStats: StatsResult;
        totalLongTasks: LongTaskReport;
      };
      sidebarSearch: { stats: StatsResult; totalLongTasks: LongTaskReport };
      sidebarToggleToSection: { stats: StatsResult; totalLongTasks: LongTaskReport };
      sidebarToggleToSchema: { stats: StatsResult; totalLongTasks: LongTaskReport };
    };
  };
}

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'bench-admin-password';

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        s.close(() => rej(new Error('无法分配空闲端口')));
        return;
      }
      const p = addr.port;
      s.close((err) => (err ? rej(err) : res(p)));
    });
    s.on('error', rej);
  });

const waitServerReady = async (baseUrl: string, proc: ReturnType<typeof spawn>) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Dowel 服务端提前退出（exit=${proc.exitCode}）`);
    }
    try {
      const r = await fetch(`${baseUrl}/api/instance`);
      if (r.ok) return;
    } catch {
      // 等待启动
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('等待 Dowel 服务端就绪超时（30s）');
};

const seedPlatformDb = async (
  dbPath: string,
  gen100: GeneratedSchema,
  gen1000: GeneratedSchema,
): Promise<{ pid100: string; pid1000: string; pid1000Focus1: string; pid1000Focus2: string }> => {
  const db = await openPlatformDb(dbPath);
  try {
    const admin = await autoSetup(db, {
      DOWEL_ADMIN_USERNAME: ADMIN_USER,
      DOWEL_ADMIN_PASSWORD: ADMIN_PASS,
    });
    if (!admin) throw new Error('autoSetup 未创建管理员');

    const groupId = newId();
    await db.query(
      "insert into groups (id, slug, name, description, default_role, project_creation) values ($1, 'bench', 'Bench', '', 'editor', 'members')",
      [groupId],
    );
    await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')", [
      groupId,
      admin.id,
    ]);

    const seedProject = async (slug: string, name: string, gen: GeneratedSchema): Promise<string> => {
      const pid = newId();
      const branchId = newId();
      await db.transaction(async (tx) => {
        await tx.query(
          "insert into projects (id, name, dialect, created_by, group_id, slug, schemas) values ($1, $2, 'pg', $3, $4, $5, null)",
          [pid, name, admin.id, groupId, slug],
        );
        await tx.query(
          "insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id, created_by, by_instance_admin) values ($1, 'user', $2, 'admin', 'project', $3, $4, false)",
          [newId(), admin.id, pid, admin.id],
        );
        await tx.query(
          "insert into branches (id, project_id, name, sections) values ($1, $2, 'main', $3::text::jsonb)",
          [branchId, pid, JSON.stringify(gen.sections)],
        );
        await tx.query(
          'insert into room_snapshots (branch_id, seq, model, versions) values ($1, 0, $2::text::jsonb, $3::text::jsonb)',
          [branchId, JSON.stringify(gen.model), '{}'],
        );
      });
      return pid;
    };

    const pid100 = await seedProject('bench-100', 'Bench 100', gen100);
    const pid1000 = await seedProject('bench-1000', 'Bench 1000', gen1000);
    const pid1000Focus1 = await seedProject('bench-1000-focus1', 'Bench 1000 Focus 1', gen1000);
    const pid1000Focus2 = await seedProject('bench-1000-focus2', 'Bench 1000 Focus 2', gen1000);
    return { pid100, pid1000, pid1000Focus1, pid1000Focus2 };
  } finally {
    await db.close();
  }
};

interface BrowserRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface BrowserElement {
  dataset: Record<string, string | undefined>;
  textContent: string | null;
  value?: string;
  getBoundingClientRect(): BrowserRect;
  querySelector(sel: string): BrowserElement | null;
  querySelectorAll(sel: string): { length: number; [Symbol.iterator](): Iterator<BrowserElement> };
  closest?(sel: string): BrowserElement | null;
}

interface BrowserEnv {
  document: {
    querySelector(sel: string): BrowserElement | null;
    querySelectorAll(sel: string): { length: number; [Symbol.iterator](): Iterator<BrowserElement> };
    elementFromPoint(x: number, y: number): BrowserElement | null;
  };
  localStorage: {
    setItem(k: string, v: string): void;
  };
  requestAnimationFrame(cb: (now: number) => void): number;
  PerformanceObserver?: new (
    cb: (list: { getEntries(): { duration: number; startTime: number }[] }) => void,
  ) => {
    observe(opts: { type: string; buffered?: boolean }): void;
  };
  __benchLongTasks?: { duration: number; startTime: number }[];
  __resetLongTasks?: () => void;
  __readLongTasks?: () => LongTaskReport;
  __benchFrames?: number[];
  __frameRunning?: boolean;
  __startFrameProbe?: () => void;
  __stopFrameProbe?: () => number[];
}

const installPerfObservers = async (page: Page) => {
  await page.addInitScript(() => {
    const g = globalThis as unknown as BrowserEnv;
    g.__benchLongTasks = [];
    if (typeof g.PerformanceObserver === 'function') {
      try {
        const obs = new g.PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            g.__benchLongTasks!.push({ duration: e.duration, startTime: e.startTime });
          }
        });
        obs.observe({ type: 'longtask', buffered: true });
      } catch {
        // 忽略不支持 longtask 的环境
      }
    }
    g.__resetLongTasks = () => {
      g.__benchLongTasks = [];
    };
    g.__readLongTasks = () => {
      const items = g.__benchLongTasks ?? [];
      let maxMs = 0;
      let totalDurationMs = 0;
      let tbtMs = 0;
      for (const it of items) {
        if (it.duration > maxMs) maxMs = it.duration;
        totalDurationMs += it.duration;
        if (it.duration > 50) tbtMs += it.duration - 50;
      }
      return { count: items.length, maxMs, totalDurationMs, tbtMs };
    };
    g.__benchFrames = [];
    g.__frameRunning = false;
    g.__startFrameProbe = () => {
      g.__benchFrames = [];
      g.__frameRunning = true;
      let last: number | null = null;
      const tick = (now: number) => {
        if (!g.__frameRunning) return;
        if (last !== null) g.__benchFrames!.push(now - last);
        last = now;
        g.requestAnimationFrame(tick);
      };
      g.requestAnimationFrame(tick);
    };
    g.__stopFrameProbe = () => {
      g.__frameRunning = false;
      return [...(g.__benchFrames ?? [])];
    };
  });
};

const waitTwoFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((res) => {
        const g = globalThis as unknown as BrowserEnv;
        g.requestAnimationFrame(() => g.requestAnimationFrame(() => res()));
      }),
  );

const resetLongTasks = (page: Page) =>
  page.evaluate(() => {
    (globalThis as unknown as BrowserEnv).__resetLongTasks?.();
  });

const readLongTasks = async (page: Page): Promise<LongTaskReport> => {
  const r = await page.evaluate(() => (globalThis as unknown as BrowserEnv).__readLongTasks?.() ?? null);
  return r ?? { count: 0, maxMs: 0, totalDurationMs: 0, tbtMs: 0 };
};

const mergeLongTasks = (reports: LongTaskReport[]): LongTaskReport => ({
  count: reports.reduce((s, r) => s + r.count, 0),
  maxMs: reports.reduce((m, r) => Math.max(m, r.maxMs), 0),
  totalDurationMs: reports.reduce((s, r) => s + r.totalDurationMs, 0),
  tbtMs: reports.reduce((s, r) => s + r.tbtMs, 0),
});

const waitForLocatorCount = async (page: Page, selector: string, expected: number, timeoutMs = 45_000) => {
  await page.waitForFunction(
    ({ sel, n }) => (globalThis as unknown as BrowserEnv).document.querySelectorAll(sel).length === n,
    { sel: selector, n: expected },
    { timeout: timeoutMs },
  );
};

const trackWsLayouts = (page: Page) => {
  const listeners: ((positionsCount: number) => void)[] = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      try {
        const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
        if (!text.includes('"t":"layout"')) return;
        const parsed = JSON.parse(text) as { t?: string; positions?: Record<string, unknown> };
        if (parsed.t === 'layout' && parsed.positions) {
          const count = Object.keys(parsed.positions).length;
          for (const fn of [...listeners]) fn(count);
        }
      } catch {
        // 忽略非 JSON 帧
      }
    });
  });
  return {
    waitForLayout: (minPositions: number, timeoutMs = 60_000): Promise<void> =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => {
          cleanup();
          rej(new Error(`等待 >= ${minPositions} 张表的 layout WebSocket 消息超时（${timeoutMs}ms）`));
        }, timeoutMs);
        const handler = (count: number) => {
          if (count >= minPositions) {
            cleanup();
            res();
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          const idx = listeners.indexOf(handler);
          if (idx >= 0) listeners.splice(idx, 1);
        };
        listeners.push(handler);
      }),
  };
};

const main = async () => {
  const webDist = resolve(ROOT, 'apps/web/dist');
  if (!existsSync(resolve(webDist, 'index.html'))) {
    console.log('未检测到 apps/web/dist/index.html，先构建前端产物…');
    const buildRes = spawnSync('pnpm', ['--filter', '@dowel/web', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (buildRes.status !== 0) {
      throw new Error('构建前端产物失败');
    }
  }

  const gen100 = generateLargeSchema({ tableCount: 100 });
  const gen1000 = generateLargeSchema({ tableCount: 1000 });

  const dbPath = resolve(tmpdir(), `dowel-bench-ui-${process.pid}-${Date.now()}.db`);
  const { pid100, pid1000Focus1, pid1000Focus2 } = await seedPlatformDb(dbPath, gen100, gen1000);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverProc = spawn(
    process.execPath,
    ['--conditions=@dowel/source', resolve(ROOT, 'apps/server/src/main.ts')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DOWEL_DB: dbPath,
        DOWEL_SECRET: 'bench-ui-secret-0123456789',
        DOWEL_LOGIN_IP_LIMIT: '10000',
        DOWEL_DRIFT_INTERVAL_MINUTES: '0',
        DOWEL_WEB: webDist,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLogs = '';
  serverProc.stdout.on('data', (d) => {
    serverLogs += String(d);
  });
  serverProc.stderr.on('data', (d) => {
    serverLogs += String(d);
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    await waitServerReady(baseUrl, serverProc);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });

    // 登录并保留会话 Cookie
    const loginPage = await context.newPage();
    await loginPage.goto(`${baseUrl}/login`);
    await loginPage.getByLabel('用户名').fill(ADMIN_USER);
    await loginPage.getByLabel('密码').fill(ADMIN_PASS);
    await loginPage.getByRole('button', { name: '登录', exact: true }).click();
    await loginPage.getByRole('heading', { name: '我的项目' }).waitFor({ timeout: 15_000 });
    await loginPage.close();

    // 1. 100 表平铺画布首屏
    const p100 = await context.newPage();
    await installPerfObservers(p100);
    const t100Start = performance.now();
    await p100.goto(`${baseUrl}/project/bench/bench-100/model`);
    await p100.getByRole('status').filter({ hasText: '已同步' }).waitFor({ timeout: 30_000 });
    await waitForLocatorCount(p100, '.react-flow__node-table', 100);
    await waitTwoFrames(p100);
    const scale100FirstPaintMs = performance.now() - t100Start;
    const scale100LongTasks = await readLongTasks(p100);
    await p100.close();

    // 2. 1,000 表默认折叠汇总卡片首屏
    const p1000Sum = await context.newPage();
    await installPerfObservers(p1000Sum);
    const tSumStart = performance.now();
    await p1000Sum.goto(`${baseUrl}/project/bench/bench-1000/model`);
    await p1000Sum.getByRole('status').filter({ hasText: '已同步' }).waitFor({ timeout: 30_000 });
    await waitForLocatorCount(p1000Sum, '.react-flow__node-sectionSummary', 10);
    await waitForLocatorCount(p1000Sum, '.react-flow__node-table', 0);
    await waitTwoFrames(p1000Sum);
    const summaryFirstPaintMs = performance.now() - tSumStart;
    const summaryLongTasks = await readLongTasks(p1000Sum);
    await p1000Sum.close();

    // 3. 1,000 表 1 跳 / 2 跳邻域聚焦冷首屏 & 跳数切换（独立冷项目确保无残留布局缓存）
    const pFocus1 = await context.newPage();
    await installPerfObservers(pFocus1);
    await pFocus1.addInitScript(
      ({ key, tableId }) => {
        (globalThis as unknown as BrowserEnv).localStorage.setItem(
          key,
          JSON.stringify({
            sidebarGrouping: 'schema',
            viewMode: 'auto',
            expandedGroups: [],
            focus: { tableId, hops: 1 },
          }),
        );
      },
      { key: `dowel.canvasView.${pid1000Focus1}`, tableId: gen1000.focusTableId },
    );
    const tFocus1Start = performance.now();
    await pFocus1.goto(`${baseUrl}/project/bench/bench-1000-focus1/model`);
    await pFocus1.getByRole('button', { name: '退出聚焦' }).waitFor({ timeout: 30_000 });
    await waitForLocatorCount(pFocus1, '.react-flow__node-table', gen1000.focus1HopCount);
    await waitTwoFrames(pFocus1);
    const focus1ColdMs = performance.now() - tFocus1Start;
    const focus1LongTasks = await readLongTasks(pFocus1);

    // 交互切换 1 跳 -> 2 跳
    await resetLongTasks(pFocus1);
    const tSwitchStart = performance.now();
    const hop2Tab = pFocus1.getByRole('tab', { name: '2 跳' });
    await hop2Tab.click();
    await pFocus1.waitForFunction(
      (n) => {
        const doc = (globalThis as unknown as BrowserEnv).document;
        const activeTabs = [...doc.querySelectorAll('[role="tab"][aria-selected="true"]')].map((el) =>
          el.textContent?.trim(),
        );
        return activeTabs.includes('2 跳') && doc.querySelectorAll('.react-flow__node-table').length === n;
      },
      gen1000.focus2HopCount,
      { timeout: 30_000 },
    );
    await waitTwoFrames(pFocus1);
    const focus1To2SwitchMs = performance.now() - tSwitchStart;
    const focus1To2LongTasks = await readLongTasks(pFocus1);
    await pFocus1.close();

    // 冷启动 2 跳聚焦首屏
    const pFocus2 = await context.newPage();
    await installPerfObservers(pFocus2);
    await pFocus2.addInitScript(
      ({ key, tableId }) => {
        (globalThis as unknown as BrowserEnv).localStorage.setItem(
          key,
          JSON.stringify({
            sidebarGrouping: 'schema',
            viewMode: 'auto',
            expandedGroups: [],
            focus: { tableId, hops: 2 },
          }),
        );
      },
      { key: `dowel.canvasView.${pid1000Focus2}`, tableId: gen1000.focusTableId },
    );
    const tFocus2Start = performance.now();
    await pFocus2.goto(`${baseUrl}/project/bench/bench-1000-focus2/model`);
    await pFocus2.getByRole('button', { name: '退出聚焦' }).waitFor({ timeout: 30_000 });
    await waitForLocatorCount(pFocus2, '.react-flow__node-table', gen1000.focus2HopCount);
    await waitTwoFrames(pFocus2);
    const focus2ColdMs = performance.now() - tFocus2Start;
    const focus2LongTasks = await readLongTasks(pFocus2);
    await pFocus2.close();

    // 4. 展开单个板块（order，100 表）+ elkjs 自动布局 + 显式重排 + 交互延迟（冷布局状态）
    const pMain = await context.newPage();
    await installPerfObservers(pMain);
    const wsTracker = trackWsLayouts(pMain);
    await pMain.goto(`${baseUrl}/project/bench/bench-1000/model`);
    await pMain.getByRole('status').filter({ hasText: '已同步' }).waitFor({ timeout: 30_000 });
    await waitForLocatorCount(pMain, '.react-flow__node-sectionSummary', 10);
    await waitTwoFrames(pMain);

    await resetLongTasks(pMain);
    const expandDone = wsTracker.waitForLayout(100);
    const tExpandStart = performance.now();
    await pMain.getByRole('button', { name: '展开 order' }).click();
    await expandDone;
    await waitForLocatorCount(pMain, '.react-flow__node-table', 100);
    await waitTwoFrames(pMain);
    const expandDurationMs = performance.now() - tExpandStart;
    const expandLongTasks = await readLongTasks(pMain);

    // 显式触发「自动布局」按钮（全量 100 张已展开表重排）
    await resetLongTasks(pMain);
    const relayoutDone = wsTracker.waitForLayout(100);
    const tRelayoutStart = performance.now();
    await pMain.getByRole('button', { name: '自动布局' }).click();
    await relayoutDone;
    await waitTwoFrames(pMain);
    const relayoutDurationMs = performance.now() - tRelayoutStart;
    const relayoutLongTasks = await readLongTasks(pMain);

    // 固定属性面板防止选中首个表时画布宽度收缩，并朝表节点集群中心适度放大以便点击/拖拽
    await pMain.getByRole('button', { name: '固定属性面板' }).click();
    await waitTwoFrames(pMain);
    const clusterPt = await pMain.evaluate<{ x: number; y: number } | null>(() => {
      const doc = (globalThis as unknown as BrowserEnv).document;
      const nodes = [...doc.querySelectorAll('.react-flow__node-table')];
      if (nodes.length === 0) return null;
      const r = nodes[Math.floor(nodes.length / 2)]!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (clusterPt) {
      await pMain.mouse.move(clusterPt.x, clusterPt.y);
      for (let z = 0; z < 4; z++) {
        await pMain.mouse.wheel(0, -180);
        await waitTwoFrames(pMain);
      }
    }

    // 挑选两个处于可视区且通过 elementFromPoint 确认未被浮层遮挡的表节点
    const pickVisibleTargets = async () => {
      const ids = await pMain.evaluate<string[]>(() => {
        const doc = (globalThis as unknown as BrowserEnv).document;
        const nodes = [...doc.querySelectorAll('.react-flow__node-table')];
        const pane = doc.querySelector('.react-flow__pane');
        const pr = pane ? pane.getBoundingClientRect() : { left: 0, top: 0, right: 1100, bottom: 860 };
        const hits: string[] = [];
        for (const el of nodes) {
          const r = el.getBoundingClientRect();
          if (
            r.width < 16 ||
            r.height < 16 ||
            r.left < pr.left + 20 ||
            r.right > pr.right - 20 ||
            r.top < pr.top + 60 ||
            r.bottom > pr.bottom - 40
          ) {
            continue;
          }
          const cx = r.left + r.width / 2;
          const cy = r.top + Math.min(14, r.height / 2);
          const topEl = doc.elementFromPoint(cx, cy);
          const owner = topEl?.closest?.('.react-flow__node-table');
          if (owner && owner.dataset.id && owner.dataset.id === el.dataset.id) {
            hits.push(owner.dataset.id);
            if (hits.length >= 2) break;
          }
        }
        return hits;
      });
      return ids.map((id) => {
        const obj = gen1000.model.objects[id];
        if (!obj || obj.kind !== 'table') throw new Error(`找不到模型表对象 ${id}`);
        return { id, name: obj.name };
      });
    };

    let targetNodes = await pickVisibleTargets();
    if (targetNodes.length < 2) {
      await pMain.getByRole('button', { name: '适应画布' }).click();
      await new Promise((r) => setTimeout(r, 350));
      await waitTwoFrames(pMain);
      targetNodes = await pickVisibleTargets();
    }
    if (targetNodes.length < 2) {
      throw new Error(`可视区内可点击的展开表节点不足 2 个（当前 ${targetNodes.length}）`);
    }

    // 5a. 节点点击选中延迟（5 轮交替点击 2 个可见节点）
    const selectSamples: number[] = [];
    const selectLts: LongTaskReport[] = [];
    for (let i = 0; i < 5; i++) {
      const target = targetNodes[i % targetNodes.length]!;
      const box = await pMain.locator(`.react-flow__node-table[data-id="${target.id}"]`).boundingBox();
      if (!box) throw new Error(`未找到用于点击选中的表节点 ${target.id}`);
      await resetLongTasks(pMain);
      const t0 = performance.now();
      await pMain.mouse.click(box.x + box.width / 2, box.y + Math.min(14, box.height / 2));
      await pMain.waitForFunction(
        (expectedName) => {
          const input = (globalThis as unknown as BrowserEnv).document.querySelector(
            'aside[aria-label="属性"] input[aria-label="表名"]',
          );
          return input?.value === expectedName;
        },
        target.name,
        { timeout: 10_000 },
      );
      await waitTwoFrames(pMain);
      selectSamples.push(performance.now() - t0);
      selectLts.push(await readLongTasks(pMain));
    }

    // 5b. 节点拖拽延迟（5 轮：记录拖拽期间 rAF 帧间隔 + 落位耗时）
    const dragFrameDeltas: number[] = [];
    const dragSettleSamples: number[] = [];
    const dragLts: LongTaskReport[] = [];
    const dragNode = targetNodes[0]!;
    for (let i = 0; i < 5; i++) {
      const box = await pMain.locator(`.react-flow__node-table[data-id="${dragNode.id}"]`).boundingBox();
      if (!box) throw new Error('未找到用于拖拽压测的表节点');
      const cx = box.x + box.width / 2;
      const cy = box.y + Math.min(16, box.height / 2);
      const dx = i % 2 === 0 ? 60 : -60;
      const dy = i % 2 === 0 ? 30 : -30;

      await resetLongTasks(pMain);
      await pMain.evaluate(() => {
        (globalThis as unknown as BrowserEnv).__startFrameProbe?.();
      });
      await pMain.mouse.move(cx, cy);
      await pMain.mouse.down();
      await pMain.mouse.move(cx + dx, cy + dy, { steps: 10 });
      const tDrop0 = performance.now();
      await pMain.mouse.up();
      await waitTwoFrames(pMain);
      dragSettleSamples.push(performance.now() - tDrop0);
      const frames = await pMain.evaluate(
        () => (globalThis as unknown as BrowserEnv).__stopFrameProbe?.() ?? [],
      );
      dragFrameDeltas.push(...frames);
      dragLts.push(await readLongTasks(pMain));
    }

    // 5c. 侧边栏搜索过滤延迟（5 次，用真实首表名断言过滤已生效）
    const firstTableOf = (prefix: string) => {
      const sec = gen1000.sections.find((s) => s.name === prefix);
      if (!sec?.tables[0]) throw new Error(`找不到板块 ${prefix}`);
      const t = gen1000.model.objects[sec.tables[0]];
      if (!t || t.kind !== 'table') throw new Error(`找不到板块 ${prefix} 首表`);
      return t.name;
    };
    const searchCases = [
      { query: 'order_', expectText: firstTableOf('order'), expectHeader: false, minLis: 10, maxLis: 400 },
      {
        query: 'billing_',
        expectText: firstTableOf('billing'),
        expectHeader: false,
        minLis: 10,
        maxLis: 400,
      },
      {
        query: firstTableOf('auth'),
        expectText: firstTableOf('auth'),
        expectHeader: false,
        minLis: 1,
        maxLis: 400,
      },
      {
        query: 'analytics_',
        expectText: firstTableOf('analytics'),
        expectHeader: false,
        minLis: 10,
        maxLis: 400,
      },
      {
        query: '',
        expectText: firstTableOf('analytics'),
        expectHeader: true,
        minLis: 15,
        maxLis: 250,
      },
    ];
    const searchInput = pMain.getByRole('navigation', { name: '对象' }).getByLabel('搜索对象…');
    const searchSamples: number[] = [];
    const searchLts: LongTaskReport[] = [];
    for (const sc of searchCases) {
      await resetLongTasks(pMain);
      const t0 = performance.now();
      await searchInput.fill(sc.query);
      await pMain.waitForFunction(
        ({ expectText, expectHeader, minLis, maxLis }) => {
          const navEl = (globalThis as unknown as BrowserEnv).document.querySelector(
            'nav[aria-label="对象"]',
          );
          if (!navEl) return false;
          const lis = navEl.querySelectorAll('li').length;
          const text = navEl.textContent ?? '';
          return (
            lis >= minLis &&
            lis < maxLis &&
            text.includes(expectText) &&
            (!expectHeader || /表\s*1000/.test(text))
          );
        },
        sc,
        { timeout: 10_000 },
      );
      await waitTwoFrames(pMain);
      searchSamples.push(performance.now() - t0);
      searchLts.push(await readLongTasks(pMain));
    }

    // 5d. 侧边栏 按 Schema <-> 按板块 切换延迟（5 轮，使用预解析坐标 + mouse.click 对齐节点点击测量口径）
    const nav = pMain.getByRole('navigation', { name: '对象' });
    const sectionTabBox = await nav.getByRole('tab', { name: '按板块' }).boundingBox();
    const schemaTabBox = await nav.getByRole('tab', { name: '按 Schema' }).boundingBox();
    if (!sectionTabBox || !schemaTabBox) throw new Error('未找到侧边栏分组切换标签页');
    const toSectionSamples: number[] = [];
    const toSchemaSamples: number[] = [];
    const toSectionLts: LongTaskReport[] = [];
    const toSchemaLts: LongTaskReport[] = [];
    for (let i = 0; i < 5; i++) {
      await resetLongTasks(pMain);
      const t0 = performance.now();
      await pMain.mouse.click(
        sectionTabBox.x + sectionTabBox.width / 2,
        sectionTabBox.y + sectionTabBox.height / 2,
      );
      await pMain.waitForFunction(
        () => {
          const doc = (globalThis as unknown as BrowserEnv).document;
          const navEl = doc.querySelector('nav[aria-label="对象"]');
          if (!navEl) return false;
          const active = navEl.querySelector('[role="tab"][aria-selected="true"]');
          return active?.textContent?.trim() === '按板块' && (navEl.textContent ?? '').includes('前缀建议');
        },
        null,
        { timeout: 10_000 },
      );
      await waitTwoFrames(pMain);
      toSectionSamples.push(performance.now() - t0);
      toSectionLts.push(await readLongTasks(pMain));

      await resetLongTasks(pMain);
      const t1 = performance.now();
      await pMain.mouse.click(
        schemaTabBox.x + schemaTabBox.width / 2,
        schemaTabBox.y + schemaTabBox.height / 2,
      );
      await pMain.waitForFunction(
        () => {
          const doc = (globalThis as unknown as BrowserEnv).document;
          const navEl = doc.querySelector('nav[aria-label="对象"]');
          if (!navEl) return false;
          const active = navEl.querySelector('[role="tab"][aria-selected="true"]');
          return active?.textContent?.trim() === '按 Schema' && /表\s*1000/.test(navEl.textContent ?? '');
        },
        null,
        { timeout: 10_000 },
      );
      await waitTwoFrames(pMain);
      toSchemaSamples.push(performance.now() - t1);
      toSchemaLts.push(await readLongTasks(pMain));
    }

    await pMain.close();

    const pkgPlaywright = await import('@playwright/test/package.json', { with: { type: 'json' } });
    const report: UiBenchReport = {
      env: {
        ...collectHostEnv(),
        chromiumVersion: browser.version(),
        playwrightVersion: (pkgPlaywright.default as { version?: string }).version ?? 'unknown',
      },
      scale100: {
        tableCount: 100,
        firstPaintMs: scale100FirstPaintMs,
        longTasks: scale100LongTasks,
      },
      scale1000: {
        tableCount: 1000,
        totalObjects: gen1000.stats.totalObjects,
        sectionCount: gen1000.sections.length,
        summaryFirstPaintMs,
        summaryLongTasks,
        focus1Hop: {
          tables: gen1000.focus1HopCount,
          coldFirstPaintMs: focus1ColdMs,
          longTasks: focus1LongTasks,
        },
        focus1To2HopSwitch: {
          tables: gen1000.focus2HopCount,
          switchMs: focus1To2SwitchMs,
          longTasks: focus1To2LongTasks,
        },
        focus2Hop: {
          tables: gen1000.focus2HopCount,
          coldFirstPaintMs: focus2ColdMs,
          longTasks: focus2LongTasks,
        },
        expandSectionAndElk: {
          sectionName: 'order',
          tables: 100,
          durationMs: expandDurationMs,
          longTasks: expandLongTasks,
        },
        explicitRelayoutElk: {
          tables: 100,
          durationMs: relayoutDurationMs,
          longTasks: relayoutLongTasks,
        },
        interactions: {
          nodeSelect: {
            stats: summarizeSamples(selectSamples),
            totalLongTasks: mergeLongTasks(selectLts),
          },
          nodeDrag: {
            frameDeltaStats: summarizeSamples(dragFrameDeltas),
            settleStats: summarizeSamples(dragSettleSamples),
            totalLongTasks: mergeLongTasks(dragLts),
          },
          sidebarSearch: {
            stats: summarizeSamples(searchSamples),
            totalLongTasks: mergeLongTasks(searchLts),
          },
          sidebarToggleToSection: {
            stats: summarizeSamples(toSectionSamples),
            totalLongTasks: mergeLongTasks(toSectionLts),
          },
          sidebarToggleToSchema: {
            stats: summarizeSamples(toSchemaSamples),
            totalLongTasks: mergeLongTasks(toSchemaLts),
          },
        },
      },
    };

    console.log('\n=== Q17 Layer 2 Benchmark: Playwright Chromium UI (Canvas + Sidebar + elkjs) ===');
    console.log(
      `Host: ${report.env.cpuModel} (${report.env.cpuCores} cores) | RAM: ${formatBytes(report.env.totalMemoryBytes)} | Chromium ${report.env.chromiumVersion} (Playwright ${report.env.playwrightVersion}) | pid100=${pid100}`,
    );
    console.table([
      {
        scenario: '100t flat first paint + elk',
        nodes: 100,
        duration: formatMs(report.scale100.firstPaintMs),
        ltCount: report.scale100.longTasks.count,
        ltMax: formatMs(report.scale100.longTasks.maxMs),
        tbt: formatMs(report.scale100.longTasks.tbtMs),
      },
      {
        scenario: '1000t folded summary first paint',
        nodes: 10,
        duration: formatMs(report.scale1000.summaryFirstPaintMs),
        ltCount: report.scale1000.summaryLongTasks.count,
        ltMax: formatMs(report.scale1000.summaryLongTasks.maxMs),
        tbt: formatMs(report.scale1000.summaryLongTasks.tbtMs),
      },
      {
        scenario: '1000t 1-hop cold focus paint',
        nodes: report.scale1000.focus1Hop.tables,
        duration: formatMs(report.scale1000.focus1Hop.coldFirstPaintMs),
        ltCount: report.scale1000.focus1Hop.longTasks.count,
        ltMax: formatMs(report.scale1000.focus1Hop.longTasks.maxMs),
        tbt: formatMs(report.scale1000.focus1Hop.longTasks.tbtMs),
      },
      {
        scenario: '1000t 1-hop -> 2-hop switch',
        nodes: report.scale1000.focus1To2HopSwitch.tables,
        duration: formatMs(report.scale1000.focus1To2HopSwitch.switchMs),
        ltCount: report.scale1000.focus1To2HopSwitch.longTasks.count,
        ltMax: formatMs(report.scale1000.focus1To2HopSwitch.longTasks.maxMs),
        tbt: formatMs(report.scale1000.focus1To2HopSwitch.longTasks.tbtMs),
      },
      {
        scenario: '1000t 2-hop cold focus paint',
        nodes: report.scale1000.focus2Hop.tables,
        duration: formatMs(report.scale1000.focus2Hop.coldFirstPaintMs),
        ltCount: report.scale1000.focus2Hop.longTasks.count,
        ltMax: formatMs(report.scale1000.focus2Hop.longTasks.maxMs),
        tbt: formatMs(report.scale1000.focus2Hop.longTasks.tbtMs),
      },
      {
        scenario: '1000t expand order (100t) + elk',
        nodes: report.scale1000.expandSectionAndElk.tables,
        duration: formatMs(report.scale1000.expandSectionAndElk.durationMs),
        ltCount: report.scale1000.expandSectionAndElk.longTasks.count,
        ltMax: formatMs(report.scale1000.expandSectionAndElk.longTasks.maxMs),
        tbt: formatMs(report.scale1000.expandSectionAndElk.longTasks.tbtMs),
      },
      {
        scenario: '1000t explicit relayout (100t) elk',
        nodes: report.scale1000.explicitRelayoutElk.tables,
        duration: formatMs(report.scale1000.explicitRelayoutElk.durationMs),
        ltCount: report.scale1000.explicitRelayoutElk.longTasks.count,
        ltMax: formatMs(report.scale1000.explicitRelayoutElk.longTasks.maxMs),
        tbt: formatMs(report.scale1000.explicitRelayoutElk.longTasks.tbtMs),
      },
    ]);

    console.table([
      {
        interaction: 'node click/select (1000t proj)',
        n: report.scale1000.interactions.nodeSelect.stats.count,
        p50: formatMs(report.scale1000.interactions.nodeSelect.stats.p50Ms),
        p95: formatMs(report.scale1000.interactions.nodeSelect.stats.p95Ms),
        max: formatMs(report.scale1000.interactions.nodeSelect.stats.maxMs),
        ltCount: report.scale1000.interactions.nodeSelect.totalLongTasks.count,
      },
      {
        interaction: 'node drag rAF frame delta',
        n: report.scale1000.interactions.nodeDrag.frameDeltaStats.count,
        p50: formatMs(report.scale1000.interactions.nodeDrag.frameDeltaStats.p50Ms),
        p95: formatMs(report.scale1000.interactions.nodeDrag.frameDeltaStats.p95Ms),
        max: formatMs(report.scale1000.interactions.nodeDrag.frameDeltaStats.maxMs),
        ltCount: report.scale1000.interactions.nodeDrag.totalLongTasks.count,
      },
      {
        interaction: 'node drag drop settle',
        n: report.scale1000.interactions.nodeDrag.settleStats.count,
        p50: formatMs(report.scale1000.interactions.nodeDrag.settleStats.p50Ms),
        p95: formatMs(report.scale1000.interactions.nodeDrag.settleStats.p95Ms),
        max: formatMs(report.scale1000.interactions.nodeDrag.settleStats.maxMs),
        ltCount: report.scale1000.interactions.nodeDrag.totalLongTasks.count,
      },
      {
        interaction: 'sidebar search filter',
        n: report.scale1000.interactions.sidebarSearch.stats.count,
        p50: formatMs(report.scale1000.interactions.sidebarSearch.stats.p50Ms),
        p95: formatMs(report.scale1000.interactions.sidebarSearch.stats.p95Ms),
        max: formatMs(report.scale1000.interactions.sidebarSearch.stats.maxMs),
        ltCount: report.scale1000.interactions.sidebarSearch.totalLongTasks.count,
      },
      {
        interaction: 'sidebar Schema -> Section',
        n: report.scale1000.interactions.sidebarToggleToSection.stats.count,
        p50: formatMs(report.scale1000.interactions.sidebarToggleToSection.stats.p50Ms),
        p95: formatMs(report.scale1000.interactions.sidebarToggleToSection.stats.p95Ms),
        max: formatMs(report.scale1000.interactions.sidebarToggleToSection.stats.maxMs),
        ltCount: report.scale1000.interactions.sidebarToggleToSection.totalLongTasks.count,
      },
      {
        interaction: 'sidebar Section -> Schema',
        n: report.scale1000.interactions.sidebarToggleToSchema.stats.count,
        p50: formatMs(report.scale1000.interactions.sidebarToggleToSchema.stats.p50Ms),
        p95: formatMs(report.scale1000.interactions.sidebarToggleToSchema.stats.p95Ms),
        max: formatMs(report.scale1000.interactions.sidebarToggleToSchema.stats.maxMs),
        ltCount: report.scale1000.interactions.sidebarToggleToSchema.totalLongTasks.count,
      },
    ]);
    console.log('\nBENCH_UI_JSON=' + JSON.stringify(report));
  } catch (err) {
    console.error('UI 压测失败；服务端输出片段：\n' + serverLogs.slice(-2000));
    throw err;
  } finally {
    await browser?.close().catch(() => {});
    if (serverProc.exitCode === null) {
      serverProc.kill('SIGTERM');
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          serverProc.kill('SIGKILL');
          res();
        }, 5000);
        serverProc.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    }
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }
};

await main();
