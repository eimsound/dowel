// 环境执行相关用例的公共步骤：建目标库、在界面上添加环境、发布版本、进入环境详情。
import { expect, type Page } from '@playwright/test';

import { connectPg } from '../apps/server/src/targets.ts';
import { commit, gotoPage, openModel } from './helpers.ts';

const ADMIN_URL = () => process.env.DOWEL_TEST_PG!;

const dbUrl = (name: string) => {
  const u = new URL(ADMIN_URL());
  u.pathname = `/${name}`;
  return u.toString();
};

/** 新建一个空库（库名带随机后缀）；返回连接串和清理函数（同时删掉同实例影子库 {库名}_dowel） */
export const newTargetDb = async (prefix: string) => {
  const name = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = connectPg(ADMIN_URL());
  await admin.db.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = dbUrl(name);
  return {
    name,
    url,
    /** 在目标库里执行一条语句 / 查询 */
    sql: async <T = Record<string, unknown>>(q: string): Promise<T[]> => {
      const c = connectPg(url);
      try {
        return await c.db.query<T>(q);
      } finally {
        await c.close();
      }
    },
    drop: async () => {
      const a = connectPg(ADMIN_URL());
      for (const d of [name, `${name}_dowel`]) await a.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
      await a.close();
    },
  };
};

/** 侧面板里的环境链接：生产环境的链接名字带着“生产环境”标记，所以按前缀匹配 */
const envLink = (page: Page, name: string) =>
  page.getByRole('navigation', { name: '环境列表' }).getByRole('link', { name: new RegExp(`^${name}( |$)`) });

/** 在“环境”页添加环境（界面表单）；生产环境默认不能在同一实例上建影子库，这里明确允许 */
export const addEnv = async (page: Page, name: string, url: string, production: boolean) => {
  await gotoPage(page, '环境');
  await page.getByLabel('名字').fill(name);
  await page.getByLabel('连接串', { exact: true }).fill(url);
  const prod = page.getByLabel('生产环境');
  if (production) await prod.check();
  else await prod.uncheck();
  await page.getByLabel('允许在同一实例上建影子库').check();
  await page.getByRole('button', { name: '添加环境' }).click();
  await expect(envLink(page, name)).toBeVisible();
};

/** 在模型页新建一张表并发布一个版本；有环境时发布会在影子库里验证，通过后对话框关闭 */
export const publishTable = async (page: Page, table: string, version: string, n: number) => {
  await openModel(page);
  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', table);
  await expect(page.getByRole('navigation').getByRole('button', { name: table, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill(version);
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  await expect(page.getByText(`已发布 v${n} ${version}，已通过验证`)).toBeVisible({ timeout: 60_000 });
};

export const openEnv = async (page: Page, name: string) => {
  await gotoPage(page, '环境');
  await envLink(page, name).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
};

/** 执行确认对话框 */
export const execDialog = (page: Page) => page.getByRole('dialog');
