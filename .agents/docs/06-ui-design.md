# 界面设计：过程与决策

**规范本身在仓库根目录的 [DESIGN.md](../../DESIGN.md)**（token、组件、文案、动效等，以它为准）。这里只记录过程和决策，避免两处重复。

相关文件（`.agents/docs/ui/`）：

| 文件                              | 用途                                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mockups/index.html`              | 静态稿：工作区、迁移对话框、组件一览，假数据。上方浮动栏切换页面和配色；参数 `?screen=workspace\|migration\|components&scheme=auto\|light\|dark`，`&bare` 隐藏浮动栏                                                                                                   |
| `mockups/shell.html`、`shell.css` | 静态稿：全局侧边栏四种方案（a 模型页收起成图标栏 + 悬停浮层 / b 始终展开 / c 模型页合并左栏 / d 图标栏 + 上下文面板）× 模型页 / 环境页，属性面板可切换“按需”。参数 `?shell=a\|b\|c\|d&page=model\|environments&scheme=…&inspector=auto&unselected&peek&collapsed&bare` |
| `mockups/theme.css`               | token 的参考实现（与 DESIGN.md 的 YAML 一致）                                                                                                                                                                                                                          |
| `mockups/base.css`                | 静态稿的结构和组件样式                                                                                                                                                                                                                                                 |
| `mockups/fonts/`                  | Inter、JetBrains Mono（取自 fontsource，OFL）                                                                                                                                                                                                                          |
| `shoot.ts`                        | 截图：`node .agents/docs/ui/shoot.ts`，亮 / 暗两种配色输出到 `shots/`                                                                                                                                                                                                  |
| `shoot-shell.ts`                  | 侧边栏方案截图：`node .agents/docs/ui/shoot-shell.ts`，4 方案 × 2 页面 × 亮 / 暗 × 1440 / 1024，另有属性面板隐藏、d 悬停提示等，输出 `shots/shell-*.png` 并打印画布宽度                                                                                                |
| `contrast.ts`                     | 对比度检查：`node .agents/docs/ui/contrast.ts`，亮 / 暗各 23 组                                                                                                                                                                                                        |
| `shots/before-*.png`              | 改版前的界面（2026-11-18），作对照                                                                                                                                                                                                                                     |

本地查看静态稿：在 `mockups/` 下运行 `python3 -m http.server 4610`，打开 <http://localhost:4610/>。

## 1. 为什么改版（2026-11-18）

M1 的界面能用但难看。原因不在“哪里没调好”，而在两件事：**没有设计系统**（原生下拉框和复选框、字号字重没有层级、没有图标、手写 Tailwind，共识里定的 shadcn/ui 和 lucide 没用上），**没有视觉目标**（agent 只按功能做，没有参照、不看截图）。

## 2. 做法

1. **定方向**：同一份结构和假数据做三套风格不同的静态稿，只换视觉语言，让用户比较。✅
2. **定规范**：选中的风格写成 DESIGN.md（Google Labs 的开放格式，YAML token + 文字说明；参考了 VoltAgent/awesome-design-md 里 Linear、Supabase 的写法），并在静态稿里补“组件”一览页（所有组件和状态）。✅
3. **建设计系统**：token 落到 `apps/web/src/styles.css`，通用组件在 `components/ui.tsx`。✅
4. **逐个界面重做**，每一轮截图自查（亮 / 暗、1440 / 1024 宽）；定稿后加截图对比测试（`e2e/visual.spec.ts`）。✅

## 3. 风格方向与决定

| 方向       | 视觉语言                                                                        | 结果                    |
| ---------- | ------------------------------------------------------------------------------- | ----------------------- |
| **A 精密** | 深色优先、高密度、冷灰 + 单一靛蓝强调色、细线、8px 圆角；Inter + JetBrains Mono | **2026-11-18 用户选定** |
| B 工坊     | 从名字出发（dowel = 木销）：暖纸色、图纸式画布、胡桃木强调色、硬投影；IBM Plex  | 未选，静态稿已删除      |
| C 清爽     | 亮色优先、留白多、浮起的圆角卡片、青蓝强调色；Geist                             | 未选，静态稿已删除      |

## 4. 定规范时的调整

- **对比度**：照搬 Linear 式的极淡灰时，控件边框和画布连线只有 2.3～2.5:1，不满足 3:1；中风险文字、PK 标记略低于 4.5:1；暗色主按钮悬停时白字不够。已调整（`border-strong`、`edge`、`warn`、`pk`、暗色 `primary` / `primary-hover`），由 `contrast.ts` 固定检查。
- **等宽字体关闭连字**：JetBrains Mono 默认把 `<>`、`>=` 连成 `≠`、`≥`，SQL 工具里会误导，已关闭。
- **CSS 变量名与 token 名一致**（`--primary`、`--surface-hover`…），实现时直接对应，不需要翻译表。
- `npx @google/design.md lint` 在当前环境被权限规则拦截，未运行；改用本地脚本检查了 YAML 能解析、组件里的 token 引用都存在、`@` 引用的文件和锚点都存在、章节顺序符合规范。

## 5. 实现（第 3、4 步，2026-11-18）

- **不用 Radix**：共识 5.3 原写“shadcn/ui（Radix）”。按 modern-web-guidance 的现行做法，下拉选择、悬停提示、菜单、通知、对话框、选项卡都用原生能力（`appearance: base-select`、`interestfor` + `popover="hint"`、`popover` + `focusgroup="menu"`、`popover="manual"`、`<dialog>`、`focusgroup`），按需加载 polyfill；只借用 shadcn“组件代码放在自己仓库里”的做法。与项目已有的原生 `<dialog>`、popover 通知一致。
- **样式组织**：token 在 `styles.css` 的 `:root`（与 DESIGN.md、静态稿 `theme.css` 同值），映射到 Tailwind 4 `@theme inline`；组件类（`.btn`、`.input`、`.select`、`.seg`、`.flag`、`.risk`、`.banner`、`.menu`…）与静态稿同名；布局用 Tailwind 工具类。Tailwind 4 的 preflight 已把所有元素的 margin 清零，不要再写 `m-0`（会覆盖 `space-y-*` 的间距）。
- **重做的界面**：工作区（顶栏分组、同步状态、在线成员、设置菜单；对象树带搜索和折叠；画布节点、按列连线的鸦爪外键、缩放控件、小地图；属性面板的紧凑列列表 / 约束 / 索引；状态栏）、5 个对话框（迁移改成步骤列表 + 风险说明）、登录页、项目列表；配色可在设置菜单里固定为亮 / 暗。
- **测试**：e2e 按新界面更新（“名字”→“表名”、CHECK 从“添加约束”菜单加、版本对话框按钮“保存版本”、升级脚本是步骤列表）；新增 `e2e/visual.spec.ts` 截图对比（工作区、迁移对话框 × 亮 / 暗），CI 安装 `fonts-noto-cjk` 与本地一致。

改版过程中发现并修正的问题（都是原有的缺陷，界面把它们暴露了出来）：

1. **风险分析把前面步骤的全表扫描算到每一步**：`pg_stat_xact_user_tables` 在 PG 15+ 是本连接尚未刷新的累计值，不只是当前事务。迁移对话框开始显示风险原因后，每一步都显示“全表扫描 orders, customers”，改名也被标成高风险。改为每步前后各读一次取增量（`packages/verifier/test/analyze.test.ts`）。
2. **表达式规范化在并发编辑时卡住**：添加环境后的第一次规范化要从零建库，耗时较长；期间用户的修改会让写回被版本检查拒绝，而之后基线被设成了“最新模型”，于是没写回的原文被当成已规范化，再也不会重试。改为基线 = 本次规范化的那份模型 + 规范形式，写回被拒绝时自动重试（最多 3 次，`apps/server/test/derive.test.ts`）。新界面操作更快，e2e 稳定复现了这个问题。

## 6. 应用外壳实现（P2，2026-11-19）

采用共识 11.6 的方案 d：图标栏 + 随页面变化的侧面板。规范写在 DESIGN.md 的 `## Layout`。

**路由**（`apps/web/src/routes.tsx`，TanStack Router 的嵌套布局）：

```
根（beforeLoad：拉当前用户和实例信息；未登录 → /login?next=…；需要初始化 → /setup）
├─ /login、/setup、/invite/:token、/reset/:token、/oidc/confirm   登录前页面
├─ /                                                              我的项目
├─ /group/:slug                                                   组首页
├─ /project/:owner/:project  （项目布局：resolve → 项目信息 → 项目上下文 + 外壳）
│   ├─ /                                                          概览
│   ├─ /model                                                     模型（原工作区）
│   ├─ /versions、/versions/:vid                                  版本列表 / 详情
│   ├─ /environments、/environments/:eid                          环境列表 / 详情
│   ├─ /activity                                                  动态
│   ├─ /members                                                   成员与授权
│   └─ /settings                                                  项目设置
├─ /p/:pid                                                        旧地址，跳到项目概览
├─ /account、/account/password|identities|sessions|preferences      个人设置（分区在侧面板）
```

旧路径跳转仍然有效：`/p/:pid` 和 `resolve` 返回的 `redirected` 都替换到 `/project/:owner/:project`。

**组件位置**：

- `apps/web/src/components/Shell.tsx`：`AppShell`（图标栏 + 侧面板 + 内容区）、`PageHeader`（面包屑 + 操作）、`useShellPanel`（页面把侧面板内容交给外壳）、账户菜单。图标栏是 `nav[aria-label="实例与项目"]`，侧面板内容由各页面提供自己的 `nav`。
- `apps/web/src/components/ProjectPage.tsx`：项目内页面的统一框架（面包屑、内容宽度、分节、列表行）。
- `apps/web/src/project.tsx`：项目上下文（`pid`、`ProjectInfo`、当前用户）。
- `apps/web/src/pages/`：`Projects`（我的项目）、`Group`、`Workspace`（模型页）、`Overview`、`Versions`、`Environments`、`Activity`、`Members`、`ProjectSettings`、`AccountSettings`（个人设置）、`Admin`（管理后台）。
- 原来的“成员与授权”“环境”对话框内容搬到了 `/members`、`/environments`，对话框组件已删掉；`ImportDialog`、`VersionDialog`（发布）、`MigrationDialog`、`GroupDialog`（新建组）保留。

**状态放在哪里**：

- 当前用户、实例信息、项目、版本、环境、动态都在 TanStack Query 的缓存里（`session.ts` 里的 `queryClient`）；路由 `beforeLoad` 用 `ensureQueryData` 读同一份缓存。
- 模型页的实时模型、在线成员、同步状态在 `workspace.ts` 的 `Workspace` 里（WebSocket）；其它页面不连接房间。
- 侧面板的收起状态是外壳的组件状态（`[` 切换，不持久化）；当前页面由路径决定。
- 模型页属性面板的固定状态存在 `localStorage` 的 `dowel.inspector`（`pinned` / `auto`，默认按需）；取消选中来自画布空白处点击或 `Esc`。
- 语言和配色沿用 `dowel.lang` / `dowel.scheme`，入口从工作区顶栏移到了图标栏底部的账户菜单。

**测试**：`e2e/navigation.spec.ts` 覆盖图标栏、`aria-current`、组页往返和 `[`；`e2e/visual.spec.ts` 在亮 / 暗两种配色下对比模型页和迁移对话框，`SHOOT_APP=1` 时另外输出 `.agents/docs/ui/shots/app-*.png` 的文档截图。

### 6.1 个人设置与管理后台（P2，2026-11-19）

两者用**同一套导航方式**：侧面板里是分区导航，每节是独立的嵌套路由。理由是它们和项目页面一样“内容区在右侧、上下文在左侧”，再用页内 tab 会多一层控件，而且侧面板可以随窄屏一起变成抽屉（S7），不用为设置页单独再写一套响应式逻辑。

```
/account                 资料            /admin                   用户
/account/password        密码            /admin/invites           邀请
/account/identities      登录方式        /admin/sign-in           登录方式
/account/sessions        会话            /admin/settings          实例设置
/account/preferences     偏好            /admin/grants            授权
                                          /admin/audit             审计日志
```

- **地址和用户菜单对应**：P1c 的 OIDC 关联回调固定落在 `/account`（服务端默认 `next` 也是它），所以个人设置就用 `/account` 这个名字，不另起 `/settings`，避免一个功能两个地址。回调里带了 `next` 时按 `next` 回去（关联入口传 `/account/identities`）。
- **管理后台不暴露存在**：`AdminLayout` 里判断 `me.role !== 'admin'` 时渲染普通的 404 页（“页面不存在。”），不是 403 / “需要实例管理员”；账户菜单里的入口也只对实例管理员渲染。服务端仍然是 403，界面这一层只是不主动暴露。
- **侧面板标题**用“个人设置导航”“管理后台导航”，和页面 h1（“个人设置”“管理后台”）区分开，免得同一页出现两个同名标题；分区标题用 h2。
- **一次性链接**（重置密码、邀请）在页面里用提示条 + 等宽 `code` + 复制按钮显示，关闭后不再显示；接口本来也只返回一次。
- **密码**：`/api/me` 多了 `hasPassword`（只说明有没有，不返回哈希）。已经有密码时改密码必须带旧密码；纯 OIDC 用户第一次“设置密码”不需要旧密码，但**只允许最近 10 分钟内新建的会话**（以 `sessions.created_at` 为准），否则返回 403，前端显示服务端的说明并给“用 XX 重新登录”的入口（走 OIDC，回到 `/account/password`）。写入用 `update … where password_hash is null`，并发时只有一个能成功，另一个 409。改密码后保留当前会话、吊销其他会话；**首次设置不吊销其他会话**（否则只是帮攻击者把主人踢下线）。
- **最后一种登录方式**：界面上把“密码（且实例允许密码登录）”和已关联的、仍启用的提供方都算作登录方式；只剩一种时“解除关联”按钮禁用并说明原因。服务端仍然有同样的 422 检查，界面只是在提交前就告诉用户。
- **会话**：UA 简化成“浏览器 · 操作系统”，显示 IP、登录时间、最后活动时间；当前会话标“当前”。“退出其他所有会话”是逐条吊销（客户端循环调 `DELETE /api/me/sessions/:id`），没有新增接口。
- **偏好**：语言、配色只写 `localStorage`（`dowel.lang` / `dowel.scheme`），不存服务端，也不跨设备同步——账户菜单里的入口保留，和这一节等价。
- **删除项目**：`DELETE /api/projects/:pid` 要求请求体带 `confirm: <slug>`；界面必须原样输入项目标识才能点删除（按钮默认禁用）。删除在一个事务里清掉分支、快照、操作日志、拒绝记录、版本、环境、授权和旧地址跳转记录，审计记录保留（审计是留档，不跟着业务数据删）；在线连接用 4403 断开（和“没有权限了”同一个约定），前端收到后不再重连。

### 6.2 命令面板与快捷键（S6）

- **⌘K / Ctrl+K** 打开，再按一次或 `Esc` 关闭。搜索范围刻意保守：组、可见项目、当前项目的页面、当前模型里的表、常用动作。环境和版本暂不搜——它们还没有“直接打开某一个”的界面路径，搜到了也只能落到列表页。
- **表只在模型页可搜**：模型数据是模型页 WebSocket 的状态（`Workspace`），别的页面不连房间，所以表清单通过 `current-tables.ts` 的可订阅 store（`useSyncExternalStore`）交给外壳（模型页挂载时登记、离开时清空；新建 / 删除表时通知面板）。选中表时派发 `window` 事件让模型页选中，不新增路由参数（否则刷新页面时参数和实时状态会打架）。
- **动作用路由参数落到已有表单**：新建项目 / 新建组在“我的项目”页已有表单和对话框，命令面板跳到 `/?new=project|group`，页面看到参数后打开对话框 / 聚焦项目名输入框，并用 `replace` 把参数清掉。这样已经在 `/` 时也能生效，地址可以收藏 / 刷新，不需要模块级的“意图”变量。没有为此再造一个建项目对话框。
- **无障碍模式**：combobox + listbox（焦点留在输入框，`aria-activedescendant` 指向当前项），不用 roving tabindex——命令面板的常见做法，键盘和读屏都只跟一个焦点走。
- **`G` + 字母**：在项目内跳页面，1.5 秒内按第二个键有效；输入框、文本域、下拉框、`contenteditable`、对话框和弹出层里不触发。快捷键清单写进了 DESIGN.md 的 Layout。

### 6.3 窄屏抽屉（S7）

- 断点是 1024（`matchMedia('(max-width: 1023px)')`），和 DESIGN.md 的 Responsive Behavior 一致；图标栏保持 48px。
- 窄屏下侧面板是 `position: fixed`、宽 260px 的抽屉，默认收起；顶栏左侧出现“打开侧面板”按钮。打开时内容上盖一层遮罩（`--backdrop`，从图标栏右边开始，图标栏仍然可用）。
- **焦点管理**：打开时焦点移到抽屉里第一个可聚焦元素（关闭按钮）；`Esc`、点遮罩、点抽屉里的关闭按钮都会关闭，关闭后的 effect 里把焦点还给“打开侧面板”——那个按钮只在收起时渲染，所以不能在关闭的那一刻同步聚焦。
- 掩体对辅助技术隐藏（`aria-hidden`），键盘的等价操作是 `Esc` 和关闭按钮。
- **属性面板**在窄屏也改成覆盖式：`position: fixed` 贴右侧，`shadow-pop`，不挤压画布；`Esc` 取消选中后消失的规则不变。
- 宽屏的 `[` 收起逻辑保留；窄屏下 `[` 打开 / 关闭抽屉。

**实现与测试**（这一轮）：`apps/web/src/pages/AccountSettings.tsx`、`pages/Admin.tsx`、`components/CommandPalette.tsx`、`components/SettingsNav.tsx`、`current-tables.ts`；`e2e/account.spec.ts`、`admin.spec.ts`、`cmdk.spec.ts`、`narrow.spec.ts`、`project-delete.spec.ts`；`e2e/a11y.spec.ts` 用 `@axe-core/playwright` 在亮 / 暗下扫描主要页面（不允许 serious / critical），`e2e/visual.spec.ts` 增加了个人设置、后台用户页和窄屏抽屉的截图对比。审计日志里每个动作的中文描述和项目动态共用 `activity.ts` 的 `actionText()`，补全了 auth / 用户 / 组 / 邀请 / 登录方式等动作。
