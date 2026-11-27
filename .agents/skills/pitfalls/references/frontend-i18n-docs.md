# 六、前端交互状态机、缓存、i18n 与文档一致性

涉及模块：`apps/web/src/pages/NewProject.tsx`、`apps/web/src/components/CanvasHistory.tsx`、`apps/web/src/components/Tabs.tsx`、`apps/web/src/pages/Environments.tsx`、`apps/web/src/components/TokenSettings.tsx`、`apps/web/src/i18n.ts`、`apps/web/src/activity.ts`、`apps/web/src/policy-cache.ts`、`docs/*`。

---

## 1. `NewProject.tsx` 接手向导缓存不失效、忽略 SSE `claim_required` 与成功后未禁回退（`#29` · High）

- **【反模式】**
  1. 切组、改环境 `url`、增删环境时不失效 `takeReads` 缓存，且用 `Object.keys(takeReads).length === 0` 决定是否自动探测；用可编辑的 `e.name` 而非稳定 `e.key` 匹配探测结果；
  2. `readSse` 忽略服务端发出的 `event.code === 'claim_required'`；提交请求体的 `claim` 只绑旧探测态 `!!takeClaim` 而非 `claimConfirmed`；
  3. 带 `warnings` 创建成功后停留在结果步，但「上一步」按钮未加 `|| created !== null` 禁用。
- **【会出什么事】**
  1. 修改 URL 或新增环境后仍沿用旧库缓存或误报缺失；同名环境草稿串台；
  2. TOCTOU 或缓存陈旧触发 SSE `claim_required` 时弹不出 `ClaimDialog`，即使确认了也不带 `claim: true`；
  3. 带告警创建成功后误点「上一步」退回，重读因项目已存在 `canNext === false`，用户彻底卡死回不到「进入项目」入口。
- **【Dowel 正确做法】**（已验证于 `NewProject.tsx` / `e2e/takeover.spec.ts`）
  1. 引入切组与按环境 `key` 的**代次保护**，在切组、改 `url`、删环境时精确失效 `takeReads` 并丢弃在途旧响应；进入第 2 步或切到接手模式时自动补读缺失 `takeReads[e.key]`；所有集合匹配统一用稳定 `e.key`；
  2. `readSse` 捕获 `event.code === 'claim_required'` 时对实例管理员自动弹出 `ClaimDialog`，请求体 `claim` 绑定 `claimConfirmed || !!takeClaim`；
  3. 「上一步」按钮禁用条件包含 `|| created !== null`。

---

## 2. `CanvasHistory.tsx` 冲突横幅吞掉后续错误 + 实时降级 `readOnly` 未关确认框（`#30` · Medium）

- **【反模式】**
  1. 用互斥三元 `conflict ? <Banner kind="warn" /> : restore.error ? <Banner kind="danger" /> : null` 渲染弹窗错误，且点击「按最新状态恢复」重试遇到 `403`/`429`/`500`/断网时未清或未独立展示新错；
  2. WS `liveRole` 实时把用户降级为只读（`readOnly = true`）时只隐藏了触发按钮，已打开的恢复确认 `<Modal>` 仍开着且确认按钮未禁用。
- **【会出什么事】**
  - 409 冲突重试失败时，旧黄色警告横幅把真正的新错误完全遮蔽，用户以为还是冲突；被降级成员在已打开的确认框里仍能反复点确认碰 `403`。
- **【Dowel 正确做法】**
  1. 保留 `conflict` 以维持最新的 `confirmWorkingSeq` / `confirmDiff`，同时**独立渲染**非 `working_changed` 409 的 `restore.error` 危险横幅，不与冲突提示互斥；
  2. `useEffect` 监听 `readOnly` 变为 `true` 时自动 `closeConfirm()`，并在确认按钮 `disabled` 中加入 `readOnly`。

---

## 3. `focusgroup` polyfill 与手写 `onTabKeyDown` 叠加导致方向键一次跳两格（`#31` · Medium）

- **【反模式】**
  - 应用已在入口全局加载 `@microsoft/focusgroup-polyfill`（不在 `HTMLElement.prototype` 挂 `focusGroup`，因此 `nativeFocusgroup` 恒为 `false`），组件却在 `<div role="tablist" focusgroup="tablist nomemory">` 上又手写 `onTabKeyDown` 且未检查 `e.defaultPrevented`。
- **【会出什么事】**
  - polyfill 的原生监听器先于 React 根节点委托执行并移动焦点 + `preventDefault()`，冒泡到 React 后 `onTabKeyDown` 读到已移动后的 `activeElement` 再步进一格，按一次方向键直接跳两格（3 个 tab 时右移变成 `0 → 2 → 1 → 0`）。
- **【Dowel 正确做法】**
  - 参照 `Tabs.tsx`，仅使用 `focusgroup="tablist nomemory"` 交由原生或全局 polyfill 统一处理，移除手写 `onTabKeyDown`；若确有特殊键盘兜底，首行必须判断 `if (e.defaultPrevented) return;`。

---

## 4. 环境变更后 React Query 缓存失效遗漏（`#32` · Low）

- **【反模式】**
  - 切换生产标记只调 `invalidatePolicyDependents(qc)`，漏失效 `['activity', pid]` 且完全指望 SSE 刷新 `requests` / `inbox-unread`；接入历史环境成功后漏失效 `['activity', pid]` 与 `['migration', pid]`。
- **【会出什么事】**
  - SSE 断连时待处理申请列表与 `staleTime: 60_000` 的未读数不更新；接入领先环境变更 `head` 后切往动态页或迁移预览弹窗首帧闪现旧数据。
- **【Dowel 正确做法】**
  - Mutation `onSuccess` 显式列出全部受影响查询键：`EnvForm` 接入成功补充失效 `['activity', pid]` 与 `['migration', pid]`；`setProduction` 补充失效 `['activity', pid]` 与 `invalidateRequests(qc)`（兜底 SSE 断连）。

---

## 5. 审计动作与历史操作名未同步登记到 `i18n.ts` / `activity.ts`（`#33` · Medium）

- **【反模式】**
  - 服务端新增了审计动作 `project.takeover`、`project.claim`（附带 `data.environment`）及历史回退操作名 `'edit'`，但前端 `i18n.ts`（`zh`/`en`）漏配 `act.project.takeover`、`act.project.claim`、`hist.op.edit`，`activity.ts` 也未提取 `d.environment`。
- **【会出什么事】**
  - 动态流回退显示笼统的“执行了一个操作”或丢掉环境名；中文历史界面直接裸露英文 `edit`。
- **【Dowel 正确做法】**
  - 服务端每新增一种审计动作（`audit.write`）或画布操作名（`op_name`），在同一 PR 内同步补齐 `apps/web/src/i18n.ts` 的 `zh`/`en` 词条，并核对 `apps/web/src/activity.ts` 提取了所有插值字段。

---

## 6. 条件列表满额时仍可点击插入重复行，与去重比较冲突致无法重置（`#35` · Low）

- **【反模式】**
  - `TokenPolicyPanel`「添加组条件」仅判 `!allGroups.length`，无可选组时回退插 `allGroups[0]`；同时 `normalizeDraft` 用 `Set` 去重比对 `dirty`。
- **【会出什么事】**
  - 所有组都已添加后仍可点出重复行，但去重后 `dirty === false`，「保存」和「重置」保持禁用，界面残留死行无法通过重置清除。
- **【Dowel 正确做法】**
  - 计算 `remainingGroups`（未出现在 `draft.groups` 中的组），`remainingGroups.length === 0` 时禁用添加按钮并移除 `?? allGroups[0]` 回退；同时在各行下拉框中禁用已被其他行选中的组。

---

## 7. 带句末标点模板后拼后缀与可空版本号拼出 `v—`（`#36` · Low）

- **【反模式】**
  - 直接拼接 `baseMsg + (claimed ? t('tk.attachedClaimed') : '')`（而 `baseMsg` 末尾自带 `。` / `.`）；当 `currentVersion === null` 时传入 `number: '—'` 经 `v{{number}}` 拼出 `v—`。
- **【会出什么事】**
  - 产出双标点病句（`当前版本 v3。，并已认领。` / `current version v3. and claimed it.`）以及难懂的 `v—`。
- **【Dowel 正确做法】**
  - 在 `i18n.ts`（中英文）为“已认领/未认领”与“无当前版本”拆分完整独立的文案键，绝不对含标点整句做字符串拼接；`currentVersion === null` 使用自然语言空态文案（如“尚未执行任何版本” / `not yet executed`）。

---

## 8. 文档“当前的限制”、事件/边界清单与源码单进程旧注释滞后（`#28` & `#34` · Medium/Low）

- **【反模式】**
  1. 新阶段（P5b/P6/P7 HA）上线后，忘记清理 `docs/getting-started.md` 底部“当前的限制”（仍声称无审批、无 CI 令牌），也未清理 `routes/context.ts`、`executions.ts`、`requests.ts` 里残留的“进程内，重启丢失”“仅单进程成立”等旧注释；
  2. 新增 Webhook 事件（`token.executed`）或收件箱通知类型（`token_execution`）未补录到 `docs/webhooks.md`、`docs/approvals.md`；`docs/api.md` 未写清预检拒绝只记审计不发通知、以及生产 `noop: true` 发 Webhook 但不发站内收件箱通知的真实边界。
- **【会出什么事】**
  - 误导用户与后续维护者（尤其 AI/新协作者读到旧注释误以为仍是单进程模型，重新引入非 HA 写法）。
- **【Dowel 正确做法】**
  - 架构或能力演进合入前，用 `rg` 搜一遍受影响模块与 `docs/` 中的“限制”“单进程”“进程内”“尚未”，同步清理旧描述；每增改一个 Webhook 事件、收件箱类型或通知触发条件，同步校验 `packages/api/src/webhooks.ts`、`requests/notice.ts`（通知与 Webhook 事件内容）、`requests/service.ts`（触发条件）、`routes/ci.ts` 与 `docs/{webhooks,approvals,api,getting-started}.md` 逐项一致。
