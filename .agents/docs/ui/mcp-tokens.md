# MCP 令牌界面规格（M3-C，ADR 0014）

本文是 M3-C 的 UI / UX / 文案规格：个人设置里的「MCP 访问」、管理后台「用户」页的 MCP 令牌查看与吊销、实例设置的「允许 MCP 访问」开关，以及画布修改历史 / 审计日志里的 MCP 标记。遵循 `DESIGN.md`（语气、术语、组件、无障碍）。中英双语文案都在 `apps/web/src/i18n.ts`。

## 1. 个人设置 → MCP 访问（`/account/mcp`）

- **入口**：个人设置侧面板导航新增一节，位于「会话」之后、「偏好」之前。图标 `Bot`（lucide）。
  - 中文：MCP 访问；英文：MCP access。
- **页头说明**（`hint`，两句话，不超过两行）：
  - 中文：“MCP 令牌让 AI 编程助手（如 Claude Code、Cursor）以你的身份访问 Dowel：只能读取模型、在影子库验证、修改工作副本，权限不会超过你自己的。AI 不能发布版本、不能执行迁移，也不会连接环境的目标库。”
  - 英文：“MCP tokens let AI coding assistants (such as Claude Code or Cursor) act as you in Dowel. They can read models, verify in the shadow database, and edit the working copy — never more than your own permissions. AI can't publish versions or run migrations, and never connects to an environment's target database.”
- **实例关闭了 MCP 访问**：页头下方 `Banner kind="warning"`：“实例管理员已关闭 MCP 访问。已有令牌暂时不能使用，也不能新建令牌。” / “Your instance admin has turned off MCP access. Existing tokens can't be used and new tokens can't be created.” 「新建 MCP 令牌」按钮 `disabled` 且 `aria-describedby` 指向该 Banner。
- **主按钮**：「新建 MCP 令牌」/ “New MCP token”（全页唯一主按钮）。
- **空状态**：“还没有 MCP 令牌。新建一个令牌，再把它配置到 AI 编程助手里。” / “No MCP tokens yet. Create a token, then add it to your AI coding assistant.” + 主按钮。

### 1.1 新建对话框（原生 `<dialog>`，`Modal` 组件）

标题：「新建 MCP 令牌」/ “New MCP token”。字段从上到下：

1. **名称**（必填，`input`，最多 100 字）：标签「名称」/ “Name”；占位“例如：笔记本上的 Claude Code” / “e.g. Claude Code on my laptop”。
2. **权限**（`<fieldset>` + `<legend>`「权限」/ “Permissions”），三个复选框（`accent-color`）：
   - 「读取」/ “Read”——始终勾选且 `disabled`，说明：“读取项目、模型、DDL、版本和迁移预览，以及环境的缓存状态。” / “Read projects, models, DDL, versions, migration previews and cached environment status.”
   - 「在影子库验证」/ “Verify in shadow database”——说明：“在影子库里执行迁移并比对结果。不连接目标库。” / “Run migrations in the shadow database and compare the result. Never connects to the target database.”
   - 「修改工作副本」/ “Edit working copy”——说明：“和你在画布上编辑一样：走冲突检测，实时同步给其他成员，可以在修改历史里恢复。需要项目编辑者以上。” / “Same as editing on the canvas: conflict-checked, synced live to other members, and recoverable from canvas history. Requires editor or above.”
   - 每个说明用 `aria-describedby` 关联到对应复选框。
3. **项目范围**（`<fieldset>`，`<legend>`「项目范围」/ “Projects”），两个单选：
   - 「我能访问的全部项目」/ “All projects I can access”（默认）；
   - 「只允许指定项目」/ “Only selected projects”——选中后展开一个带搜索框的复选列表（最多 50 个；按 `owner/project` 显示，等宽字体），列表高度上限 240px 可滚动。未选任何项目时提交，就地报错“至少选择一个项目，或者选择“全部项目”。” / “Select at least one project, or choose “All projects”.”（`aria-invalid` + `role="alert"`）。
4. **有效期**（`select`，`base-select`）：7 天 / 30 天（默认）/ 90 天 / 180 天 / 1 年。说明：“令牌必须过期，到期后需要新建。” / “Tokens always expire; create a new one when it does.”

按钮：次要「取消」/ “Cancel”，主「新建令牌」/ “Create token”（提交时 `aria-busy`）。服务器错误用 `Banner kind="danger" role="alert"`。

### 1.2 一次性展示与客户端配置（同一个对话框切换到结果态）

- 标题改为「MCP 令牌已创建」/ “MCP token created”。焦点移到令牌输入框。
- `Banner kind="warning"`：“这个令牌只显示这一次。关闭后无法再查看，请现在复制或配置到客户端。” / “This token is shown only once. You won't be able to see it again after closing, so copy it or add it to your client now.”
- 令牌：只读 `input`（等宽，`aria-label`「MCP 令牌」/ “MCP token”）+ 图标按钮「复制令牌」/ “Copy token”。
- **客户端配置**：选项卡（`Tabs`，`focusgroup` 方向键）：
  - 「Claude Code」：`claude mcp add --transport http dowel <origin>/api/mcp --header "Authorization: Bearer <token>"`
  - 「Cursor / VS Code」：JSON 片段 `{ "mcpServers": { "dowel": { "url": "<origin>/api/mcp", "headers": { "Authorization": "Bearer <token>" } } } }`（VS Code 用 `"servers"` + `"type": "http"`，两个子标签或注释说明）。
  - 「其他客户端」/ “Other clients”：地址 `<origin>/api/mcp`、传输 “Streamable HTTP”、请求头 `Authorization: Bearer <token>`。
  - 每个片段是只读代码块（`<pre><code>`，等宽），右上角「复制配置」/ “Copy config”。
  - `<origin>` 取 `location.origin`。
- 复制成功：`role="status"` 的独立提示（“已复制” / “Copied”），不移动焦点。
- 底部唯一按钮：「完成」/ “Done”（关闭对话框，焦点回到「新建 MCP 令牌」）。

### 1.3 令牌列表

表格（`<table>`，带 `<caption class="sr-only">`），列：

| 列       | 内容                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 名称     | 名称 + 下一行前缀 `dwm_xxxxxxxx…`（等宽，弱化色）                                                                                     |
| 权限     | 标记：读取 / 验证 / 写入（Read / Verify / Write）                                                                                     |
| 项目     | “全部项目” / “All projects”，或 “3 个项目” / “3 projects”（`interestfor` 提示列出 `owner/project`；已看不到的显示“已无权访问的项目”） |
| 最后使用 | 相对时间 + IP；从未使用显示“从未使用” / “Never used”                                                                                  |
| 过期时间 | 绝对日期；7 天内到期加警示标记（圆点 + 文字“即将过期” / “Expires soon”）                                                              |
| 状态     | 有效 / 已过期 / 已吊销（圆点 + 文字）；已吊销的显示原因：本人吊销 / 管理员吊销 / 账号停用时吊销 / 重置密码时吊销                      |
| 操作     | 有效或过期的令牌：幽灵按钮「吊销」，`aria-label`“吊销 MCP 令牌 {name}”                                                                |

- 已吊销 / 已过期的行降低对比（但文字仍满足 4.5:1），排在有效令牌之后。
- 吊销确认对话框：标题“吊销 MCP 令牌 {name}？” / “Revoke MCP token {name}?”；正文“使用这个令牌的 AI 编程助手会立即失去访问权限。这个操作不能撤销。” / “AI coding assistants using this token lose access immediately. This can't be undone.”；按钮「吊销令牌」/ “Revoke token”（危险样式）+「取消」。

## 2. 管理后台 → 用户（`/admin/users`）

- 每行操作菜单新增「MCP 令牌」/ “MCP tokens”，打开对话框：标题“{name} 的 MCP 令牌” / “MCP tokens of {name}”，内容是 1.3 的只读表格（无「新建」），每行「吊销」走同样的确认（文案改成“这个用户的 AI 编程助手会立即失去访问权限。”）。空状态：“这个用户没有 MCP 令牌。” / “This user has no MCP tokens.”
- 停用用户与「重置密码」的确认对话框补一句后果：“同时会吊销这个用户的全部 MCP 令牌。” / “This also revokes all of this user's MCP tokens.”

## 3. 管理后台 → 实例设置（`/admin/settings`）

- 新增开关（复选框）「允许 MCP 访问」/ “Allow MCP access”，默认开。说明：“关闭后，所有用户都不能新建 MCP 令牌，已有令牌的请求一律被拒绝（令牌不会被删除，重新打开后恢复可用）。” / “When off, no one can create MCP tokens and requests with existing tokens are rejected. Tokens aren't deleted and work again when turned back on.”

## 4. 修改历史与审计

- 画布修改历史里来自 MCP 的修改：作者名后加标记 `MCP`（`aria-label`“通过 MCP” / “via MCP”），tooltip“由 AI 编程助手通过 MCP 令牌 {prefix} 提交” / “Submitted by an AI coding assistant with MCP token {prefix}”。
- 审计日志 / 项目动态：新动作文案——`mcp_token.create` 新建 MCP 令牌；`mcp_token.revoke` 吊销 MCP 令牌；`mcp_token.revoke_all` 吊销全部 MCP 令牌；`model.mutate` 通过 MCP 修改工作副本；`model.verify` 通过 MCP 在影子库验证。`data.via === 'mcp'` 的条目加同样的 `MCP` 标记。

## 5. 无障碍与响应式

- 对话框用原生 `<dialog>` + `showModal()`，关闭后焦点回到触发按钮；所有图标按钮有 `aria-label`，可见文字包含在可访问名字里。
- 复选框、单选组用 `<fieldset>` / `<legend>`；说明文字 `aria-describedby`；错误 `role="alert"`，复制提示 `role="status"`。
- 表格在 < 1024 宽时横向滚动容器（`overflow-x: auto`，`tabindex="0"` + `aria-label`）。
- 亮 / 暗两种配色都跑 axe（Playwright E2E）。

## 6. UX 审阅后的修订（2026-11-24）

独立 UX / 文案审阅后已落实到实现（以代码与 `i18n.ts` 为准）：

- 一次性展示态不可误关：`Modal dismissible={false}`（`closedby="none"`、不响应 Esc 与点外部、不显示右上角关闭），只能用「我已保存，关闭」关闭；令牌输入框聚焦即全选，并用 `aria-describedby` 关联警告。
- 「新建 MCP 令牌」在实例关闭或已有 20 个有效令牌时用 `aria-disabled`（仍可聚焦），原因由 `aria-describedby` 读出；页面显示“有效令牌 n / 20 个”。
- 表格合并为 5 列（名称 + 前缀 + 权限标记 / 项目 / 最后使用 / 状态 + 到期 / 操作），适配个人设置 760px 内容宽度；项目列直接列出 `owner/project`，不用 `interestfor`。
- 吊销后焦点移到本节标题（个人设置）或表格区域（管理后台），吊销确认框叠在列表对话框之上而不是关闭它。
- 客户端配置：Claude Code 加 `--scope user`；Cursor 与 VS Code 分成两个选项卡，提示写入用户级配置、不要把含令牌的文件提交到仓库；“其他客户端”的地址、传输方式、请求头分别复制。
- 文案：避免“账号”，改“用户”；“需要项目编辑者及以上角色”；页头说明按勾选的权限和项目范围、不超过当前项目角色；停用用户新增确认对话框；重置密码与重置链接说明会吊销 MCP 令牌；`model.mutate` / `model.verify` 的动态文案不重复“通过 MCP”，由 `MCP` 标记表达。
