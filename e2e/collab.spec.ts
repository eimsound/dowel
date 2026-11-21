import { expect, test } from '@playwright/test';

import { addGrant, commit, createProject, newUser } from './helpers.ts';

test('两人协作：实时同步；编辑期间被别人改过，保存被拒绝', async ({ browser }) => {
  const zhang = await newUser(browser, '张三');
  const li = await newUser(browser, '李四');
  const url = await createProject(zhang.page, '协作');

  // 张三给李四编辑者授权（项目级授权）
  await addGrant(zhang.page, li.username, '李四', 'editor');

  await li.page.goto(`${url}/model`);
  await zhang.page.goto(`${url}/model`);
  await expect(li.page.getByText('已连接')).toBeVisible();

  // 张三建表，李四实时看到
  await zhang.page.getByRole('button', { name: '新建表' }).click();
  await commit(zhang.page, '表名', 'users');
  const liTable = li.page.getByRole('navigation').getByRole('button', { name: 'users' });
  await expect(liTable).toBeVisible();

  // 李四开始改表名（打开了草稿），这时张三先把表改成了 accounts
  await liTable.click();
  const liName = li.page.getByLabel('表名', { exact: true });
  await liName.click();
  await liName.fill('members');
  await commit(zhang.page, '表名', 'accounts');
  await expect(li.page.getByRole('navigation').getByRole('button', { name: 'accounts' })).toBeVisible();
  // 李四保存：依据的版本已过期，服务器拒绝，提示是谁改的；李四看到的是最新的名字
  await liName.press('Enter');
  await expect(li.page.getByText('表 accounts 已被 张三 修改，请在最新数据上重新操作')).toBeVisible();
  await expect(li.page.getByLabel('表名', { exact: true })).toHaveValue('accounts');
  await expect(zhang.page.getByRole('navigation').getByRole('button', { name: 'accounts' })).toBeVisible();
});

test('只读成员不能编辑', async ({ browser }) => {
  const zhang = await newUser(browser, '张三');
  const wang = await newUser(browser, '王五');
  const url = await createProject(zhang.page, '只读');
  // 查看者：项目级授权
  await addGrant(zhang.page, wang.username, '王五', 'viewer');
  await zhang.page.goto(`${url}/model`);
  await zhang.page.getByRole('button', { name: '新建表' }).click();

  await wang.page.goto(`${url}/model`);
  await expect(wang.page.getByText('你是查看者')).toBeVisible();
  await expect(wang.page.getByRole('button', { name: '新建表' })).toHaveCount(0);
  await wang.page.getByRole('navigation').getByRole('button', { name: 'table_1' }).click();
  await expect(wang.page.getByLabel('表名', { exact: true })).toBeDisabled();
});

test('移出后即时降级：已连接的查看者不能再编辑', async ({ browser }) => {
  const zhang = await newUser(browser, '张三');
  const li = await newUser(browser, '李四');
  const url = await createProject(zhang.page, '即时生效');
  await addGrant(zhang.page, li.username, '李四', 'editor');

  await li.page.goto(`${url}/model`);
  await expect(li.page.getByText('已连接')).toBeVisible();
  await expect(li.page.getByRole('button', { name: '新建表' })).toBeVisible();

  // 张三把李四的角色改成查看者：李四的页面不用刷新就切到只读
  // （addGrant 已经把张三留在“成员与授权”页面）
  await zhang.page.getByLabel('李四 的项目角色', { exact: true }).selectOption('viewer');
  // 通知：角色变了（降级为查看者）
  await expect(li.page.getByText('你在这个项目里现在是查看者，编辑已关闭。')).toBeVisible({
    timeout: 10_000,
  });
  await expect(li.page.getByText('你是查看者')).toBeVisible({ timeout: 10_000 });
  await expect(li.page.getByRole('button', { name: '新建表' })).toHaveCount(0);
});
