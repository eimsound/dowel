---
version: alpha
name: Dowel
description: >-
  多人实时协作的 PostgreSQL schema 建模工具的界面设计系统（风格「精密」）。冷灰中性色 + 唯一的靛蓝强调色，
  高信息密度（13px 正文、28px 控件），细线分隔、少用阴影；所有标识符和 SQL 用等宽字体。
  亮色、暗色都支持，默认跟随系统，以暗色为设计基准。

colors:
  # 与配色无关的颜色
  danger-solid: "oklch(0.55 0.2 25)"
  on-danger-solid: "#ffffff"
  me: "oklch(0.55 0.18 275)"
  peer-1: "oklch(0.64 0.17 45)"
  peer-2: "oklch(0.6 0.12 185)"
  peer-3: "oklch(0.62 0.19 350)"
  peer-4: "oklch(0.62 0.15 145)"
  peer-5: "oklch(0.7 0.14 85)"
  peer-6: "oklch(0.6 0.13 235)"
  peer-7: "oklch(0.6 0.19 320)"
  peer-8: "oklch(0.66 0.15 120)"
  light:
    bg: "oklch(0.975 0.003 270)"
    chrome: "oklch(0.99 0.002 270)"
    panel: "oklch(0.99 0.002 270)"
    surface: "#ffffff"
    surface-2: "oklch(0.975 0.003 270)"
    surface-hover: "oklch(0.955 0.004 270)"
    surface-active: "oklch(0.92 0.005 270)"
    border: "oklch(0.92 0.005 270)"
    border-strong: "oklch(0.64 0.01 270)"
    text: "oklch(0.2 0.01 270)"
    text-2: "oklch(0.4 0.012 270)"
    text-3: "oklch(0.52 0.012 270)"
    primary: "oklch(0.52 0.2 275)"
    on-primary: "#ffffff"
    primary-hover: "oklch(0.47 0.2 275)"
    primary-text: "oklch(0.52 0.2 275)"
    primary-soft: "oklch(0.95 0.03 275)"
    primary-ring: "oklch(0.52 0.2 275 / 0.2)"
    focus: "oklch(0.52 0.2 275)"
    ok: "oklch(0.55 0.14 155)"
    ok-soft: "oklch(0.96 0.03 155)"
    warn: "oklch(0.52 0.12 70)"
    warn-soft: "oklch(0.96 0.04 85)"
    danger: "oklch(0.55 0.2 25)"
    danger-soft: "oklch(0.96 0.03 25)"
    danger-ring: "oklch(0.55 0.2 25 / 0.2)"
    pk: "oklch(0.55 0.13 70)"
    fk: "oklch(0.52 0.2 275)"
    enum: "oklch(0.52 0.15 320)"
    canvas: "oklch(0.975 0.003 270)"
    grid-dot: "oklch(0.82 0.005 270)"
    node-bg: "#ffffff"
    node-head: "oklch(0.975 0.003 270)"
    node-border: "oklch(0.92 0.005 270)"
    edge: "oklch(0.64 0.01 270)"
    code-bg: "oklch(0.975 0.003 270)"
    syn-kw: "oklch(0.5 0.18 275)"
    syn-str: "oklch(0.5 0.13 150)"
    syn-num: "oklch(0.55 0.13 50)"
    syn-ty: "oklch(0.52 0.13 220)"
    tooltip-bg: "oklch(0.2 0.01 270)"
    tooltip-fg: "#ffffff"
    backdrop: "oklch(0.2 0.01 270 / 0.3)"
  dark:
    bg: "oklch(0.155 0.005 270)"
    chrome: "oklch(0.18 0.006 270)"
    panel: "oklch(0.18 0.006 270)"
    surface: "oklch(0.205 0.007 270)"
    surface-2: "oklch(0.18 0.006 270)"
    surface-hover: "oklch(0.25 0.008 270)"
    surface-active: "oklch(0.25 0.008 270)"
    border: "oklch(0.26 0.008 270)"
    border-strong: "oklch(0.51 0.01 270)"
    text: "oklch(0.95 0.004 270)"
    text-2: "oklch(0.76 0.008 270)"
    text-3: "oklch(0.62 0.01 270)"
    primary: "oklch(0.56 0.18 275)"
    on-primary: "#ffffff"
    primary-hover: "oklch(0.51 0.18 275)"
    primary-text: "oklch(0.68 0.16 275)"
    primary-soft: "oklch(0.3 0.07 275 / 0.55)"
    primary-ring: "oklch(0.68 0.16 275 / 0.3)"
    focus: "oklch(0.68 0.16 275)"
    ok: "oklch(0.72 0.15 155)"
    ok-soft: "oklch(0.3 0.06 155 / 0.45)"
    warn: "oklch(0.8 0.14 80)"
    warn-soft: "oklch(0.32 0.06 80 / 0.5)"
    danger: "oklch(0.7 0.17 25)"
    danger-soft: "oklch(0.32 0.08 25 / 0.5)"
    danger-ring: "oklch(0.7 0.17 25 / 0.3)"
    pk: "oklch(0.8 0.13 80)"
    fk: "oklch(0.68 0.16 275)"
    enum: "oklch(0.75 0.12 320)"
    canvas: "oklch(0.155 0.005 270)"
    grid-dot: "oklch(0.32 0.008 270)"
    node-bg: "oklch(0.18 0.006 270)"
    node-head: "oklch(0.205 0.007 270)"
    node-border: "oklch(0.3 0.008 270)"
    edge: "oklch(0.51 0.01 270)"
    code-bg: "oklch(0.155 0.005 270)"
    syn-kw: "oklch(0.75 0.13 275)"
    syn-str: "oklch(0.78 0.13 150)"
    syn-num: "oklch(0.8 0.12 60)"
    syn-ty: "oklch(0.78 0.1 220)"
    tooltip-bg: "oklch(0.32 0.008 270)"
    tooltip-fg: "oklch(0.95 0.004 270)"
    backdrop: "oklch(0 0 0 / 0.55)"

typography:
  headline:
    fontFamily: Inter Variable
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  title:
    fontFamily: Inter Variable
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: Inter Variable
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  body-strong:
    fontFamily: Inter Variable
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.45
  body-sm:
    fontFamily: Inter Variable
    fontSize: 12.5px
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: Inter Variable
    fontSize: 11.5px
    fontWeight: 500
    lineHeight: 1.3
  section:
    fontFamily: Inter Variable
    fontSize: 11.5px
    fontWeight: 600
    lineHeight: 1.3
  caption:
    fontFamily: Inter Variable
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.4
  mono-md:
    fontFamily: JetBrains Mono Variable
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: '"liga" 0, "calt" 0'
  mono-title:
    fontFamily: JetBrains Mono Variable
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.45
    fontFeature: '"liga" 0, "calt" 0'
  mono-sm:
    fontFamily: JetBrains Mono Variable
    fontSize: 12.5px
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: '"liga" 0, "calt" 0'
  mono-xs:
    fontFamily: JetBrains Mono Variable
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: '"liga" 0, "calt" 0'
  mono-micro:
    fontFamily: JetBrains Mono Variable
    fontSize: 10px
    fontWeight: 600
    lineHeight: 1.6
    fontFeature: '"liga" 0, "calt" 0'

rounded:
  xs: 3px
  sm: 6px
  md: 8px
  lg: 12px
  full: 9999px

spacing:
  unit: 4px
  2xs: 2px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  2xl: 24px
  3xl: 32px
  control-height: 28px
  control-height-sm: 22px
  row-height: 28px
  topbar-height: 46px
  statusbar-height: 26px
  nav-width: 248px
  sidebar-width: 280px
  inspector-width: 280px
  node-header-height: 34px
  node-row-height: 26px
  dialog-width: 900px
  toast-width: 320px

motion:
  state-change:
    duration: 100ms
    delay: 0ms
    timingFunction: ease-out
  surface-enter:
    duration: 160ms
    delay: 0ms
    timingFunction: cubic-bezier(0.2, 0, 0, 1)
  surface-exit:
    duration: 120ms
    delay: 0ms
    timingFunction: cubic-bezier(0.3, 0, 1, 1)
  canvas-fit:
    duration: 250ms
    delay: 0ms
    timingFunction: cubic-bezier(0.2, 0, 0, 1)

# 组件 token 以亮色为准；暗色取 colors.dark 中同名的颜色
components:
  button-primary:
    backgroundColor: "{colors.light.primary}"
    textColor: "{colors.light.on-primary}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 10px
  button-primary-hover:
    backgroundColor: "{colors.light.primary-hover}"
    textColor: "{colors.light.on-primary}"
  button-secondary:
    backgroundColor: "{colors.light.surface}"
    textColor: "{colors.light.text}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 10px
  button-secondary-hover:
    backgroundColor: "{colors.light.surface-hover}"
    textColor: "{colors.light.text}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.light.text-2}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.sm}"
    height: 28px
  button-danger:
    backgroundColor: "{colors.light.surface}"
    textColor: "{colors.light.danger}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.sm}"
    height: 28px
  button-danger-solid:
    backgroundColor: "{colors.danger-solid}"
    textColor: "{colors.on-danger-solid}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.sm}"
    height: 28px
  button-icon:
    size: 28px
    rounded: "{rounded.sm}"
  input:
    backgroundColor: "{colors.light.surface}"
    textColor: "{colors.light.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 8px
  input-error:
    backgroundColor: "{colors.light.surface}"
    textColor: "{colors.light.text}"
  field-label:
    textColor: "{colors.light.text-2}"
    typography: "{typography.label}"
  field-hint:
    textColor: "{colors.light.text-3}"
    typography: "{typography.caption}"
  field-error:
    textColor: "{colors.light.danger}"
    typography: "{typography.caption}"
  tree-item:
    backgroundColor: "{colors.light.panel}"
    textColor: "{colors.light.text-2}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.sm}"
    height: 28px
  tree-item-selected:
    backgroundColor: "{colors.light.primary-soft}"
    textColor: "{colors.light.primary-text}"
  table-node:
    backgroundColor: "{colors.light.node-bg}"
    textColor: "{colors.light.text}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.md}"
  table-node-header:
    backgroundColor: "{colors.light.node-head}"
    textColor: "{colors.light.text}"
    typography: "{typography.mono-title}"
    height: 34px
    padding: 0 10px
  table-node-row:
    height: 26px
    padding: 0 10px
  key-flag-pk:
    textColor: "{colors.light.pk}"
    typography: "{typography.mono-micro}"
    rounded: "{rounded.xs}"
  key-flag-fk:
    textColor: "{colors.light.fk}"
    typography: "{typography.mono-micro}"
    rounded: "{rounded.xs}"
  risk-high:
    backgroundColor: "{colors.light.danger-soft}"
    textColor: "{colors.light.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
  risk-medium:
    backgroundColor: "{colors.light.warn-soft}"
    textColor: "{colors.light.warn}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
  risk-low:
    backgroundColor: "{colors.light.surface-active}"
    textColor: "{colors.light.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
  banner-success:
    backgroundColor: "{colors.light.ok-soft}"
    textColor: "{colors.light.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 10px 12px
  toast:
    backgroundColor: "{colors.light.surface}"
    textColor: "{colors.light.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    width: 320px
    padding: 10px 12px
  tooltip:
    backgroundColor: "{colors.light.tooltip-bg}"
    textColor: "{colors.light.tooltip-fg}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: 4px 8px
  menu:
    backgroundColor: "{colors.light.surface}"
    textColor: "{colors.light.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 4px
  menu-item-hover:
    backgroundColor: "{colors.light.surface-hover}"
    textColor: "{colors.light.text}"
  dialog:
    backgroundColor: "{colors.light.panel}"
    textColor: "{colors.light.text}"
    rounded: "{rounded.lg}"
    width: 900px
  top-bar:
    backgroundColor: "{colors.light.chrome}"
    textColor: "{colors.light.text}"
    height: 46px
  status-bar:
    backgroundColor: "{colors.light.chrome}"
    textColor: "{colors.light.text-3}"
    typography: "{typography.caption}"
    height: 26px
  code-block:
    backgroundColor: "{colors.light.code-bg}"
    textColor: "{colors.light.text}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.sm}"
    padding: 12px 14px
  avatar:
    textColor: "#ffffff"
    typography: "{typography.label}"
    size: 26px
    rounded: "{rounded.full}"
---

# Dowel 设计系统

界面的规范来源。YAML 部分是规范值；正文说明怎么用。改界面前先读这份文档，再看 `@.agents/docs/ui/mockups/index.html`（静态稿：工作区、迁移对话框、组件一览，切换栏可切换亮 / 暗配色）。格式遵循 Google Labs 的 [DESIGN.md 规范](https://github.com/google-labs-code/design.md)（alpha）。

> 本项目不做无障碍（a11y）要求：不强制 WCAG 对比度、ARIA 语义/读屏适配、高对比度模式或 axe 门禁。

设计过程、为什么选这套风格，见 `@.agents/docs/06-ui-design.md`。

## Overview

Dowel 是给后端工程师和 DBA 用的工具：在画布上多人实时编辑表结构，发布版本，在影子库里真实执行迁移来验证。界面要让人**信任它**——它会改生产数据库的结构。

- **性格**：精密、克制、可靠。像一件做工好的工具，而不是营销页面。不卖萌、不花哨。
- **信息密度高**：用户同时看几十张表、几百列。13px 正文、28px 控件、细线分隔；留白服务于分组，不为“透气”而存在。
- **内容是主角**：表名、列名、类型、SQL 用等宽字体，是界面里最显眼的东西；界面框架（顶栏、面板、按钮）退到中性灰里。
- **颜色有含义才出现**：中性色占绝大部分；靛蓝只用于主操作、选中、焦点和外键；红 / 黄 / 绿只用于状态（风险、校验结果）；协作者各有自己的颜色。
- **亮色、暗色都是一等公民**，默认跟随系统。以暗色为设计基准（开发者长时间使用），亮色保证同等的层次。
- **视觉层级自洽，默认去辅助文本**：尽量仅呈现基础视觉层（标题、主数据/标识符、分组边界、状态标识）与核心交互组件；默认省略页头功能简介、分节解释段和说明性 `field-hint`。若脱离辅助文本后视觉层级无法自洽，优先重新设计布局与信息结构，而不是靠文案打补丁。

## Colors

冷灰中性色（色相 270，几乎无彩）+ 唯一的强调色靛蓝。颜色分两层：原始色值只在主题文件里出现；组件只用下列**语义 token**（CSS 变量名与 token 名相同，如 `--surface-hover`）。

- **层次（由底到顶）**：`bg`（应用底色）→ `chrome` / `panel`（顶栏、侧栏、属性面板、对话框）→ `surface`（输入框、按钮、卡片、菜单）。`surface-2` 是面板里的凹陷区（展开的列编辑区）。`surface-hover` / `surface-active` 是悬停和按下 / 选中。
- **边框两档**：`border` 是分隔线（可以很淡）；`border-strong` 是**控件边框**（输入框、按钮、复选框），与所在背景保持清晰区分。
- **文字三档**：`text` 正文；`text-2` 次要（标签、说明）；`text-3` 辅助（类型名、计数、占位符）。
- **强调色 `primary`（靛蓝）**：每个界面唯一的主按钮、选中项（`primary-soft` 底 + `primary-text` 字）、焦点环 `focus`、外键标记 `fk`、选中的画布节点描边。**不用作大面积底色。**
- **状态色**：`ok`（验证通过）、`warn`（中风险、重连中）、`danger`（高风险、错误、删除）；各有 `-soft` 底色用于提示条和标记。实心危险按钮用 `danger-solid`（两种配色都是较深的红，保证白字可读）。
- **领域色**：`pk`（主键，琥珀）、`fk`（外键，靛蓝）、`enum`（枚举类型名，品红）；画布 `canvas`、`grid-dot`、`node-*`、`edge`；SQL 高亮 `syn-kw`（关键字）、`syn-str`、`syn-num`、`syn-ty`（类型）。
- **协作者颜色** `peer-1`…`peer-8`：按加入房间的顺序分配，避开靛蓝（自己）和红（危险）。自己固定用 `me`。
- **暗色不是亮色取反**：暗色下强调色和状态色提亮（`primary-text`、`danger`、`warn` 等更亮），带透明度的 `-soft` 底色叠在面板上；主按钮底色反而更深，保证白字可读。

## Typography

西文用 **Inter**（界面）和 **JetBrains Mono**（标识符、类型、SQL），均为自托管的可变字体（`@fontsource-variable/inter`、`@fontsource-variable/jetbrains-mono`）。中文不下载字体，用系统字体栈：`"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`，接在西文字体之后。

- **等宽字体用于一切数据库标识符**：表名、列名、类型、约束名、索引名、schema、SQL、连接串。界面文案（按钮、标签、说明）用 Inter。
- **等宽字体关闭连字**（`font-variant-ligatures: none`，即 token 里的 `fontFeature`）：否则 `<>`、`>=`、`!=` 会显示成 `≠`、`≥`，读 SQL 的人会被误导。
- **混排对齐**：正文设 `font-size-adjust: from-font`，中文、Inter、JetBrains Mono 的视觉大小一致。
- **层级**：`headline` 只用于页面标题（我的项目、组首页）；`title` 用于对话框和属性面板标题；`body` 是默认；`body-sm` 用于面板内容、列表；`label` 用于字段标签；`section` 用于面板分节标题和树分组；`caption` 用于说明、状态栏。等宽字体对应 `mono-md`（画布表头用 `mono-title`）、`mono-sm`（列名、输入框里的标识符）、`mono-xs`（类型名、约束定义）、`mono-micro`（PK / FK 标记）。
- **字重最多三种**：400、500（按钮、标签）、600（标题、表头、分节）。不用 700 以上。
- **数字**：计数、序号用等宽字体，对齐不跳动。

## Layout

全局外壳是 **GitLab Super Sidebar 风格的单层上下文导航侧边栏 + 按需出现的模型对象树面板 + 内容区**：

| 区域     | 尺寸                     | 内容                                                                                                                                                                     |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 导航栏   | 宽 `nav-width` 248px     | 顶部工具条（品牌、新建菜单、收件箱未读角标、用户菜单、收起按钮）+ 搜索或跳转（`⌘K`）+ 随当前位置切换的上下文导航（我的工作 / 组 / 项目 / 个人设置 / 管理后台）+ 页脚快捷键 |
| 侧面板   | 宽 `sidebar-w` / `inspector-w` 等宽 280px | 仅模型页出现，左侧放对象树（支持搜索与按 Schema / 板块分组），右侧放按需属性面板（`280px`，`< 1280` 时均等宽收窄为 `260px`） |
| 内容区   | 剩余空间                 | 顶栏（面包屑 + 页面操作）+ 页面内容；模型页另有画布、属性面板和状态栏                                                                                                    |

- **上下文导航栏（`SuperSidebar`）**：单层列表直接带图标和文字，不再使用无标签 48px 图标栏或组/环境/设置页面的双层侧栏。不同位置显示对应上下文：
  - **我的工作**（`/`、`/inbox`、`/new`）：我的项目、新建项目、可折叠的“我的组”（彩色首字头像 + 完整组名）。
  - **组**（`/group/$slug`）：返回“我的项目” + 组头部与上下文切换器 + 可折叠“项目”子导航（带组内新建项目入口）+ 可折叠“我的组”（当前组高亮；正在看的非成员组以虚线边框临时追加）。
  - **项目**（`/project/:owner/:project/*`）：上级组回链 + 项目标题与上下文切换器 + 概览 / 模型 / 版本 / 环境（任一环境漂移时右侧红点） / 动态 + 可折叠“管理”（成员与授权、设置）+ 环境列表子导航。
  - **个人设置 / 管理后台**（`/account/*`、`/admin/*`）：返回“我的项目” + 各自的全部分区链接（个人设置含资料 / 密码 / 登录方式 / 会话 / MCP 访问 / 偏好；管理后台入口仅实例管理员可见）。
- **上下文切换器（`ChevronsUpDown` 按钮）**：使用 `popover="auto"`（非菜单角色），弹出我的工作入口、最近访问项目（`localStorage['dowel.recentProjects']`，最多 5 个）和我的组。
- **侧面板（对象树）**：模型页在导航栏右侧渲染对象树侧面板，顶部为面板标题和收起按钮；其他页面不显示二次侧面板，内容区占满剩余空间。
- **快捷键 `Ctrl+\` / `⌘\`**：全局收起或展开导航侧边栏（状态存 `localStorage['dowel.sidebar']`）；收起后顶栏最左出现展开按钮。
- **快捷键 `[`**：在模型页切换对象树侧面板；在其他没有工作区侧面板的页面切换导航侧边栏。输入框、文本域、下拉框、对话框和弹出层内不触发。
- **快捷键 `⌘K` / `Ctrl+K`**：打开命令面板（见 Components 的“命令面板”），点击导航栏“搜索或跳转…”按钮同样打开，再按一次或 `Esc` 关闭。
- **复制粘贴 `⌘C` / `⌘V`（`Ctrl+C` / `Ctrl+V`）**：模型页画布上复制选中的表、粘贴表或列 / 约束 / 索引（ADR 0013 第 2 节）；焦点在输入框、编辑器、对话框或弹出层里，或页面上有选中文字、或在 SQL 视图时交给浏览器。`⌘` / `Ctrl` / `Shift` 点击表增减多选，按住 `Shift` 拖动框选，`⌘A` / `Ctrl+A`（焦点在画布上）选中画布上显示的全部表。
- **快捷键 `G` + 字母**：在项目内跳到项目页面，只按一次 `G` 再按一个字母，1.5 秒内有效；焦点在输入框、文本域、下拉框、对话框或弹出层里时不触发。映射：`G O` 概览、`G M` 模型、`G V` 版本、`G E` 环境、`G A` 动态、`G P` 成员与授权、`G S` 设置。
- **顶栏**：左侧按需显示“展开导航栏 / 展开侧面板”按钮与面包屑（组 / 项目 / 页面），中间是当前页的操作，右侧是状态和页面操作。模型页顶栏按用途分组：编辑（新建表、自动布局）｜ 导入与环境（导入 SQL、环境）｜ 版本与迁移（发布、**迁移**）；组之间用竖线分隔，低频操作只放图标（带悬停提示）。其他页面只有面包屑和页面操作，没有状态栏。
- **模型页**：画布占满内容区，左上角“画布 / SQL”切换，左下缩放，右下小地图；底部状态栏显示连接状态、在线人数、当前影子库、最新版本和引擎。
- **状态栏的表达式规范化（ADR 0016）**：编辑期间不自动回影子库。状态栏右侧显示 7px 圆点 + 文案——`ok` 圆点“表达式已规范化”，`warn` 圆点“N 处待规范化”（查看者也能看到，悬停提示由编辑者规范化或在发布 / 生成迁移时自动处理）。编辑者在旁边有一个紧凑的 ghost 按钮“规范化”（`control-height-sm` 22px，图标 + 文字，可见文字就是可访问名称）：随时可点，在影子库里校验并写回规范形式；没有可用影子库或修改尚未同步时用 `aria-disabled`（保留在 Tab 顺序里，`aria-describedby` 指向 `.sr-only` 原因），点击给中性提示；运行中 `disabled` + `aria-busy` + 旋转图标 +“规范化中…”。这个按钮不进顶栏，顶栏的 `.btn.primary` 仍然只有“迁移”。当前影子库按真实选影优先级显示（独立影子库 > 非生产环境 > 允许同实例的生产环境），都不可用时显示“没有可用的影子库”。
- **属性面板默认按需出现**：选中画布或对象树里的对象时出现在右侧；按 `Esc`、或点击画布空白处取消选中后消失。可以固定为常驻，固定状态存在 `localStorage`（`dowel.inspector`）；固定后没有选中对象时显示空状态。窄屏（< 1024）时属性面板改成覆盖在画布上的浮层（右侧贴边、`shadow-pop`），不挤压画布。
- **间距基于 4px**：`2xs` 2 · `xs` 4 · `sm` 6 · `md` 8 · `lg` 12 · `xl` 16 · `2xl` 24 · `3xl` 32。组内元素 4～8，组与组之间 12～16，大区块 24 以上。
- **控件高度统一** `control-height` 28px（按钮、输入框、下拉框、搜索框）；面板里的行内小按钮 22px；列表行、树节点 `row-height` 28px。
- **面板内边距** 12～14px；分节之间用一条 `border` 分隔线 + 12px 间距，不用卡片套卡片。

## Elevation & Depth

以**色阶分层 + 细线**表达层次，阴影只给“浮在上面”的东西：

- **不用阴影**：面板、侧栏、输入框、按钮（靠背景色阶和边框区分）。
- **轻阴影 `shadow-sm` / `shadow-node`**：画布上的浮动控件（视图切换、缩放、小地图）和表节点。
- **弹出阴影 `shadow-pop`**：菜单、通知、悬停提示；暗色下额外加一圈 4% 白色描边，避免阴影在深色背景上看不见。
- **对话框 `shadow-lg`** + 遮罩 `backdrop`。
- 选中、焦点不用阴影表达，用描边 + 光圈（`primary-ring`，3px）。

## Shapes

圆角小而统一：`xs` 3px（PK / FK 标记、风险标记）· `sm` 6px（按钮、输入框、列表项、提示条）· `md` 8px（画布节点、菜单、通知、组件卡片）· `lg` 12px（对话框）· `full`（头像、状态圆点）。

- 同一视图里不混用尖角和大圆角；不用胶囊形按钮（分支 chip 和角色标签除外）。
- 图标：[lucide](https://lucide.dev)，描边 1.75，尺寸 16px（按钮、树）和 14px（小按钮、行内标记）；空状态插图 28px、描边 1.5。图标颜色默认 `text-3`，激活时跟随文字颜色。

## Motion & Micro-interaction

动效快而克制，只为反馈状态变化，不为装饰：

- **状态变化** `state-change`（100ms ease-out）：按钮、列表项、菜单项的背景和颜色。
- **出现** `surface-enter`（160ms，减速）：菜单、对话框、通知淡入并轻微位移（≤4px）；**消失** `surface-exit`（120ms，加速），比出现更快。
- **画布** `canvas-fit`（250ms）：只用于“适应画布”“定位到对象”这类程序触发的视角移动；用户拖动、缩放时没有任何动画。
- **加载**：超过 300ms 才显示骨架屏（微光 1.4s 循环）；按钮内的操作中状态用旋转图标 + “验证中…”文字，按钮保持原宽度。
- **协作**：远端修改直接生效，不做闪烁高亮；协作者光标位置变化不加缓动。
- **动画属性**：只对 `opacity`、`transform`（`translate`、`scale`、`rotate`）做动画。

## Voice & Content Strategy

- **语气**：准确、平静、实用。不用感叹号、不用“哎呀”“太棒了”这类口语和营销词。
- **术语**（全产品统一，不用同义词）：

  | 用这个   | 不用                 | 含义                                     |
  | -------- | -------------------- | ---------------------------------------- |
  | 项目     | 仓库、工程           | 一组要一起管理的 schema                  |
  | 工作副本 | 草稿、head、当前版本 | 所有人实时编辑的最新状态                 |
  | 版本     | 快照、提交           | 保存下来的工作副本，迁移的起点和终点     |
  | 迁移     | 变更脚本             | 两个版本之间的升级 / 回滚 SQL            |
  | 环境     | 连接、数据源         | 项目要部署到的数据库（如 dev、prod）     |
  | 影子库   | 测试库、临时库       | 验证迁移用的库 `{原库名}_dowel`          |
  | 验证     | 测试、检查           | 在影子库里执行迁移并比对结果             |
  | 规范化   | 校验、格式化、刷新   | 在影子库里把表达式和视图等定义换成引擎的规范写法 |
  | 成员     | 用户、协作者         | 项目里的人；角色为查看者、编辑者、项目管理员 |

- **数据库标识符原样显示**，不翻译、不加引号，用等宽字体：“表 `orders` 已被 张三 修改”。
- **按钮用“动词 + 对象”**，说清结果：“新建表”“发布”“在影子库验证”“下载 .sql”“删除环境”。不用“确定”“提交”“OK”。确认对话框的按钮重复动作：“删除表 orders？” → “删除表”。
- **中英文混排**：中文与英文、数字之间加一个空格（“导入 SQL”“v3 之后 12 处修改”）；中文里用全角标点；省略号用“…”。英文界面用 sentence case。
- **报错写清三件事**：发生了什么、为什么、下一步怎么办。例：“修改被拒绝：表 accounts 已被 张三 修改，已显示最新内容。”“项目还没有配置环境。添加一个环境后才能导入 SQL、验证迁移。”数据库返回的原始错误放在后面，原样保留英文。
- **空状态**只保留简短事实标题与直接主操作按钮（如“还没有版本”→「发布」），不写概念介绍句；按钮直接复用常规操作词，不额外叠加“第一个…”等修饰。仅当缺少前置条件导致当前无法操作时，允许补一行阻塞原因（如“需先添加环境”）。
- **区分核心反馈与辅助文本**：迁移风险后果、删除/生产确认后果、漂移告警、一次性凭证提示、报错三要素与阻断/锁定原因属于核心安全与状态反馈，须常驻但保持短句、结构化；单位、格式、计数、来源等元信息用标签、后缀、占位符或紧凑徽标承载；页头/分节功能简介、概念教学与重复控件意图的解释文案默认省略。
- **时间**：一天内用相对时间（“3 分钟前”），更早用 `YYYY-MM-DD HH:mm`（本地时区）；耗时用“1.2 秒”。数字与单位之间加空格。
- **风险说明**写具体后果：“重写整表 orders；期间阻塞所有读写”，而不是“风险较高”。

## Components

组件的标准样例在静态稿的“组件”页（`@.agents/docs/ui/mockups/index.html`，`?screen=components`），每节有锚点。实现建立在原生能力上（`<dialog>`、popover、`focusgroup`、`appearance: base-select`、`interestfor`），组件代码放在仓库里（`@apps/web/src/components/ui.tsx`），不引入 Radix；颜色、字号、圆角全部取自上面的 token，不写死数值。

### 应用外壳

- **全局导航侧边栏**：宽 248px（`1024～1279` 收窄至 224px），`panel` 底 + 右分隔线。顶部工具条高 46px 与顶栏对齐；组头像为 20px / 24px 圆角方块（中文取第一个字、西文取首字母大写，背景按 slug 哈希混合 `peer-1`…`peer-8`）；导航项行高 28px，当前页用 `surface-active` 底 + 左侧 3px `primary` 竖条。
- **导航栏的收件箱与漂移警告**：收件箱图标位于顶部工具条，有未读数时右上角叠放 `primary` 胶囊数字。当前项目任一环境的漂移状态是“漂移”或“检查失败”时，“环境”入口右侧显示 7px 的 `danger` 色圆点（`sb-dot`）。
- **模型对象树侧面板**：`panel` 底 + 右分隔线；顶部 46px 与内容区顶栏对齐，标题 + 收起按钮；内容是带搜索、分组折叠的树，行高 28px。
- **面板开关**：`Ctrl+\` 切换全局导航侧边栏（`[` 在有对象树时切换对象树，否则切换导航侧边栏）。
- **页面顶栏**：高 46px，`chrome` 底 + 下分隔线；面包屑最后一段是 `h1`（当前页），前面的组和项目是链接；右侧放主操作。
- **属性面板固定开关**：模型页顶栏右侧的图标按钮，固定状态存在 `localStorage`。

### 按钮 `@.agents/docs/ui/mockups/index.html#buttons`

- **主要** `button-primary`：每个界面只有一个（工作区是“迁移”，对话框是确认动作）。
- **次要** `button-secondary`：`surface` 底 + `border-strong` 边框，默认按钮。
- **幽灵** `button-ghost`：无底无边，`text-2` 字；用于工具栏图标、对话框底部的辅助操作（复制、下载）。
- **危险** `button-danger`（红字描边）用于发起删除；`button-danger-solid` 只用于确认删除的那一下。
- **图标按钮** `button-icon` 28×28（小号 22×22），必须带悬停提示。
- **状态**：悬停换背景；键盘焦点 2px `focus` 描边、偏移 2px（只在 `:focus-visible` 时出现）；禁用 45% 不透明；进行中显示旋转图标 + “…中”文字，不可再次点击。

### 输入 `@.agents/docs/ui/mockups/index.html#inputs`

- 标签在上（`field-label`），默认不配常驻 `field-hint`；单位与格式优先通过标签、输入后缀或 `placeholder` 表达。仅在校验报错（边框与说明变 `danger`，说明前加图标）或存在单靠标签与占位符无法自明的不可逆/反直觉约束时，在下方显示一行 `field-hint`。
- 标识符、类型、表达式、连接串的输入框用等宽字体；普通文本（注释、项目名）用 Inter。
- 焦点：边框变 `primary` + 3px `primary-ring` 光圈。
- 只读成员看到的输入框是禁用状态（55% 不透明），不隐藏。
- **失焦或回车才提交**（实时协作：每次提交是一次修改）；Esc 放弃本次编辑。
- 下拉选择是原生 `<select>`：支持 `appearance: base-select` 的浏览器里画成与输入框一致的样式（弹出列表、chevron 箭头、选中标记），其他浏览器退回原生下拉框。复选框用原生 `<input type="checkbox">` + `accent-color`。

### 选择与切换 `@.agents/docs/ui/mockups/index.html#choices`

- 两三个互斥选项用分段控件（升级 / 回滚、画布 / SQL），选中项用 `surface-active` 底，不用强调色。
- 复选框支持部分选中状态。

### 标记 `@.agents/docs/ui/mockups/index.html#marks`

- **键与约束**：PK（`pk` 色）、FK（`fk` 色）、UQ、NN（`text-3`），`mono-micro`，浅色底。
- **风险**：高 / 中 / 低 = 颜色 + 文字，后面跟一行具体原因（带图标）。
- **同步状态**：已同步（绿色图标）、重新连接中（黄色旋转图标），始终带文字。

### 反馈 `@.agents/docs/ui/mockups/index.html#feedback`

- **提示条**（banner，嵌在页面里）：成功、警告、错误、信息四种，图标 + 短结论（必要时附一行后果或下一步）+ 可选操作按钮。仅用于当前生效的风险警告、阻断/锁定态、验证结果或错误，禁止用 `Banner kind="info"` 充当常驻功能说明书。
- **通知**（toast，右下角堆叠，宽 320px）：操作结果和远端事件（“已发布版本 v4”“修改被拒绝…”）。成功 4 秒自动消失；错误不自动消失，需手动关闭；“没做成但不是错误”的说明（如剪贴板里没有可粘贴的内容、查看者不能粘贴）用中性信息图标，同样 4 秒消失。用 `popover="manual"` 放在顶层。**对话框打开时不弹通知**（会被模态框遮住）：对话框里的结果和错误用提示条显示在对话框内。
- **悬停提示**：图标按钮必有。基线是 `title`；浏览器同时支持 `interestfor` 和 anchor positioning 时升级成 `popover="hint"` 的样式化提示。
- **渐进披露**（仅限复杂领域规则）：遇到跨层继承、安全边界或反直觉系统约束，且调整布局仍不足以承载时，优先用按需提示（`popover="hint"` / 折叠明细）或指向 `docs/` 的外链；禁止把普通字段说明或糟糕布局机械替换成满屏 `?` 图标。
- **空状态**：虚线框、28px 图标、简短事实标题、一个直接操作按钮（仅存在前置阻塞条件时允许加一行短原因）。
- **加载**：列表和面板用骨架屏，不用整页转圈。

### 菜单 `@.agents/docs/ui/mockups/index.html#menu`

- 右键菜单和“更多”菜单：图标 + 文字 + 快捷键（右对齐）；危险项放最后、用分隔线隔开、红色。

### 协作 `@.agents/docs/ui/mockups/index.html#collab`

- 顶栏头像叠放（自己在最前，`me` 色），超过 4 人显示“+N”。
- 协作者正在编辑的对象：节点描边 + 光圈用协作者颜色，左上角挂“李四 正在编辑”标签；侧面板的对象树里对应项后面有一个协作者颜色的圆点。
- 协作者光标：箭头 + 名字标签，协作者颜色。

### 画布 `@.agents/docs/ui/mockups/index.html#canvas-nodes`

- **背景**：`canvas` 底 + 20px 间距的 `grid-dot` 点阵。
- **表节点** `table-node`：表头（表图标 + 表名，`mono-title`，高 34px）+ 每列一行（高 26px）：键标记、列名、类型右对齐（`text-3`，枚举类型用 `enum` 色）；可空列名后加淡色 `?`。节点几何尺寸固定，连线按它计算。
- **选中**：`primary` 描边 + 3px `primary-ring`；属性面板里正在编辑的列在节点里同步高亮（`primary-soft` 底）。
- **视图等不透明对象**：虚线边框，表头带 `view` 标记，正文显示 SQL 摘要。
- **外键连线**：`edge` 色 1.5px 曲线，外键一端是“多”（鸦爪），被引用一端是“一”（短竖线），连到具体的列行；依赖关系（视图依赖表）用虚线。
- **浮动控件**：左上“画布 / SQL”、左下缩放（放大、缩小、适应、百分比）、右下小地图（选中的表用强调色）。

### 命令面板 `⌘K`

- 触发：`⌘K` / `Ctrl+K`；原生 `<dialog>` + `showModal()`，宽 600px，靠上（`margin-top` 12vh），关闭后焦点回到打开前的元素。
- 搜索范围：动作（新建项目、新建组、切换配色、个人设置、管理后台——仅实例管理员）、可见项目、组、当前项目的页面、当前模型里的表（只在模型页有；选中后回画布并选中那张表）。输入即过滤，忽略大小写；分组按“动作 / 项目 / 组 / 页面 / 表”排列，空分组不显示。
- 键盘：`↑` `↓`（还有 `Home` / `End`）移动当前项、`↵` 执行、`Esc` 关闭。
- 视觉：`panel` 底、`shadow-lg`、`rounded-lg`；输入行 44px，结果行 28px；当前项 `primary-soft` 底 + `primary-text` 字；底部一行 `caption` 说明按键。

### 属性面板

- 标题：图标 + `schema.` 淡色前缀 + 对象名（等宽）+ “更多”菜单。
- **列**是紧凑列表（列名、类型、标记）；点击一列展开编辑区（列名、类型、默认值、非空 / 主键、上移 / 下移 / 删除），同一时间只展开一列；新加的列自动展开并聚焦列名。
- **约束、索引**是“图标 + 名字 + 定义”的列表，定义用 `mono-xs`；CHECK 的表达式可以就地编辑（看起来是文字，聚焦时是输入框）；删除按钮在悬停或聚焦时出现。约束标题右侧的“+”是菜单（CHECK / 唯一约束 / 外键），选中后在面板里展开新增表单。

### 新建项目向导

- 四步：基本信息 → 关联数据库（可跳过）→ 初始内容 → 确认。**用内容区，不显示侧面板**；每一步是独立的一屏，不改地址，后退不丢表单状态。
- **步骤指示**在顶栏中间：`1 基本信息 › 2 关联数据库 › 3 初始内容 › 4 确认`。当前步用主色软底 + 数字实心圆，已完成的步用主色描边对勾，未到的步是 `text-3`。内容区标题重复一次当前步名（“第 2 步 / 共 4 步”），窄屏不依赖顶栏也能知道进度。
- **按钮位置**在内容区底部右侧：`上一步` 在左，`跳过`（仅第 2 步）与主按钮在右；主按钮是 `下一步`，最后一步换成 `创建项目`。校验不通过时主按钮禁用，不弹错误。
- 每一行数据库是一张卡片：名字、连接串、单独的影子库连接串、两个勾选项，底部是“检查连接”和删除。检查结果显示在同一张卡片里：版本、当前用户、是否超级用户、能否建库 / 建 schema，以及带表数的 schema 列表。
- **初始内容是单选卡片**（空白 / 从数据库导入 / 从 SQL 导入），不可用的选项灰显并写明“即将推出”，不用禁用态以外的暗示。
- 创建时实时显示阶段进度（连接 → 读取结构 → 规范化 → 写入 → 完成）；失败时错误显示在同一步里，可以再点一次“创建项目”。

### 执行确认对话框

环境详情页上的“执行迁移 / 回滚迁移 / 写入基线”都先打开它（`Modal`，Esc 关闭）：

- 顶部说明动作和目标（“把 dev 从 v1 执行到 v3”）；中间列出将要执行的迁移：序号 `v{n}`、名字、步数；含不能放进事务的步骤的标“非事务”；风险按升级脚本里最高的一档显示（high / medium 用 `risk` 标记，low 不显示），风险分析没有完成时如实写出原因，不能显示成“没有风险”。回滚时说明“回滚脚本没有做过锁和重写分析”。
- **生产环境必须输入环境名才能确认**：输入框提示“输入环境名确认”，输入值与环境名一致（首尾空白忽略，其余逐字符比较）之前主按钮不可提交并提示原因；非生产环境没有这个输入框。输入值原样作为请求的 `confirm`，服务端再校验一次。
- 确认后对话框里实时显示阶段进度（拿锁 → 检查 → 计划 → 逐个迁移）；不能中途取消，关闭只是不再看进度，执行继续，结束后页面数据刷新。
- 失败时用 `danger` 提示条写明原因，并按情况补充：漂移（列出差异）、目标库已被部分改动（必须先继续执行）、所有步骤做完但读回不一致（需要手工修正，继续执行解决不了）、版本未验证（去版本页重新验证）。

### 迁移对话框

- 顶部：从（版本）→ 到（版本或工作副本），右侧“升级 / 回滚”分段控件（带步数）。
- 验证结果用提示条；步骤列表：序号、风险标记、SQL（语法高亮）、风险原因。
- 底部：左侧幽灵按钮（复制、下载 .sql），右侧“关闭”和主按钮“在影子库验证”。

### SQL `@.agents/docs/ui/mockups/index.html#code`

- `code-block`：`code-bg` 底，`mono-sm`，行高 1.6；关键字、字符串、数字、类型分别着色，注释 `text-3`。SQL 编辑器（CodeMirror）用同一套颜色。

## Do's and Don'ts

- **Do** 所有数据库标识符和 SQL 用等宽字体，并关闭连字。
- **Do** 每个界面只放一个主按钮；其余用次要或幽灵按钮。
- **Do** 状态同时用颜色 + 图标 + 文字表达（风险、校验结果、同步状态）。
- **Do** 只用语义 token；需要新颜色时先加 token（亮、暗两个值）。
- **Do** 尽量仅呈现基础视觉层与核心交互组件；脱离辅助文本后若视觉层级无法自洽，优先重新设计布局。
- **Do** 改完界面用 Playwright 截图（亮 / 暗、1440 / 1024 宽）自查后再交付。
- **Don't** 用强调色做大面积背景或装饰；不加第二种强调色。
- **Don't** 用阴影分隔面板；不用卡片套卡片；不用渐变（Logo 除外）。
- **Don't** 用浏览器默认样式的控件，也不为了换样式重写原生控件：`<select>` 用 `base-select` 定样式，复选框用 `accent-color`。
- **Don't** 把错误只写成“操作失败”；不用“确定 / 提交”作按钮文字。
- **Don't** 在页头、分节顶部、空状态或普通表单字段下堆砌概念介绍与操作教学段落，也不要用满屏 `?` 图标替代清晰布局。
- **Don't** 在用户拖动、缩放画布时加动画；不让远端修改闪烁。
- **Don't** 翻译或美化数据库标识符（`order_items` 不显示成“Order Items”）。

## Responsive Behavior

桌面工具，以 1440×900 为设计基准，最小支持 1024 宽。

| 宽度       | 变化                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| ≥ 1280     | 导航侧边栏 248px、对象树侧面板与属性面板等宽 280px（模型页），显示小地图                                           |
| 1024～1279 | 导航侧边栏 224px、对象树侧面板与属性面板等宽 260px（模型页），不显示小地图                                         |
| < 1024     | 导航栏与对象树均变成覆盖在内容上的抽屉（默认收起，顶栏出现打开按钮，打开一个自动关闭另一个，Esc / 遮罩关闭）；属性面板按需时覆盖内容区，画布占满视口宽度 |
| 触屏       | 可查看和评论，不作为编辑场景优化；点击目标不小于 32px                                                                |

## Implementation

- 主题 token 写在 `apps/web/src/styles.css` 的 `:root`，用 `light-dark()` 定义（`color-scheme: light dark`；HTML 里有 `<meta name="color-scheme" content="light dark">`），并映射到 Tailwind 4 的 `@theme`。数值与本文件 YAML 一致；`@.agents/docs/ui/mockups/theme.css` 是同一套 token 的参考实现。
- 用户可在设置里覆盖配色（跟随系统 / 亮 / 暗）：设置 `<html style="color-scheme: …">`，`light-dark()` 随之切换。这依赖产物里保留原生 `light-dark()`：`apps/web/vite.config.ts` 用 `css.lightningcss.exclude: Features.LightDark` 禁止生产 CSS 压缩把它降级成只跟 `prefers-color-scheme` 走的开关（`e2e/scheme.spec.ts` 覆盖）。语言和配色存在 `localStorage`（`dowel.lang` / `dowel.scheme`），个人设置的“偏好”一节和账户菜单都能改。
- 命令面板在 `apps/web/src/components/CommandPalette.tsx`；当前模型里的表通过 `apps/web/src/current-tables.ts` 的可订阅 store（`useSyncExternalStore`）交给它（模型页挂载时登记、离开时清空，新建 / 删除表时通知面板），选中表时派发一个 `window` 事件让模型页选中，不新增路由参数。“新建项目 / 新建组”通过 `/?new=project|group` 交给“我的项目”页，页面打开对话框 / 聚焦输入框后用 `replace` 把参数清掉。
- 登录限速默认“同一 IP 10 次 / 10 分钟、同一 IP + 账号 30 次 / 10 分钟”，可用 `DOWEL_LOGIN_LIMIT`、`DOWEL_LOGIN_IP_LIMIT`、`DOWEL_LOGIN_WINDOW_MS` 调整（反向代理 / NAT 后面很多人共用一个 IP 时要调大；e2e 在一个 IP 上反复登录，配置里已调大）。
- 组件：通用组件在 `apps/web/src/components/ui.tsx`（`IconButton`、`Menu`、`Banner`、`Empty`、`Avatar`、`Sql` 高亮），组件样式在 `styles.css` 的 `@layer components`（`.btn`、`.input`、`.select`、`.seg`、`.flag`、`.risk`、`.banner`、`.menu` …），类名与静态稿一致；布局用 Tailwind 工具类。图标 `lucide-react`；字体 `@fontsource-variable/inter`、`@fontsource-variable/jetbrains-mono`。
- 截图：`node .agents/docs/ui/shoot.ts`（静态稿）；真实界面的截图对比测试是 `e2e/visual.spec.ts`（模型页、迁移对话框、概览、个人设置、后台用户页、窄屏抽屉，亮 / 暗），基准图在 `e2e/visual.spec.ts-snapshots/`，有意改动界面后用 `pnpm e2e --update-snapshots` 更新并检查差异。`SHOOT_APP=1 pnpm exec playwright test e2e/visual.spec.ts` 另外把外壳各页面的 1440 宽截图（窄屏抽屉用 900）写到 `.agents/docs/ui/shots/app-*.png`（文档配图，不参与对比）。

## Iteration Guide

1. 一次只改一个组件或一个区域，引用它在 `components:` 里的 token 名。
2. 先改静态稿（`@.agents/docs/ui/mockups/index.html`）和本文件，再改应用代码；三者保持一致。
3. 新增颜色：在 YAML 的 `light` 和 `dark` 里各加一个值，同步到 `theme.css`。
4. 改完运行 `npx @google/design.md lint DESIGN.md`。
5. 视觉层级与截图自查：亮 / 暗、1440 / 1024 宽，对照本文件的 Do's and Don'ts；并做“去辅助文本自检”——假定遮蔽所有说明性文案，页面主次、分组归属、当前状态与主操作仍应一眼可辨，否则优先调整布局而非补文案。

## Known Gaps

- 我的项目、组首页、项目内各页面、登录页、个人设置、管理后台已按本文件实现，但没有补进静态稿。
- 环境详情页的“谁能执行”只读显示或下拉修改，没有生产标记的编辑入口；漂移差异是只读的列表，没有“接受线上结构”操作（处理漂移功能后续提供）。
- 命令面板不搜索环境、版本、审计记录和用户（只有组、项目、当前项目的页面和表、常用动作）；要搜这些得等各自的列表页支持深链接。
- 命令面板的“新建项目 / 新建组”只是把意图交给“我的项目”页（聚焦项目名输入框 / 打开新建组对话框），没有独立的建项目对话框。
- 收件箱的未读数是叠在图标右上角的数字；通知没有分组、没有按项目筛选。
- 协作者的“正在编辑”标签、画布上的光标、对象树里的协作者圆点未实现：服务器还不广播每个人选中的对象。
- 对象树底部的“v3 之后 N 处修改”未实现；列不能拖动排序（用编辑区里的上移 / 下移）。
- 画布的右键菜单、拖拽连线（新建外键）的交互细节未定义（框选、多选复制粘贴与多选整体拖动已实现）。
- 英文界面只定了 sentence case，长度差异（英文通常更长）对顶栏的影响未验证。
