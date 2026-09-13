# ADR-0017：底部停靠的新建任务条

Status：Accepted（用户明确选择：常驻所有标签页、单行输入 + 创建按钮的收起形态、展开后提供正文/约束/类型并补 CLI 对等参数、SELF 显式标记未实现）。落地分两步：先合并 UI 骨架，随后按用户要求补齐 CLI 对等参数并开放约束与类型字段；两步都在本 ADR 范围内，不在同类能力上再造新语义。

## Context

- 新建任务的输入框原本位于任务列表卡片内部（`apps/ui/src/App.tsx` 的 `TasksTab`）。页面滚动或用事件/待处理页时它不在视野内，创建草稿需要先滚回列表卡片。
- 用户要求：新建任务窗口始终位于页面底部，无论页面如何滚动都能快速开始编写，并且可以点击展开以详细设定新任务内容。
- `task.create` 契约本身已支持 `specification`、`constraints[]`、`kind`（`DEVELOPMENT` | `SELF`），但 CLI `task create <project-id> <specification>` 把 `constraints` 固定为 `[]`、`kind` 固定为 `DEVELOPMENT`。
- Runtime 目前对 `kind: 'SELF'` 没有任何区别处理：没有隔离的 Self worktree，没有 Candidate/Stable 数据隔离，Phase 7 Self Evolution 未实现。

## Options

- 详细设定字段：正文 + 约束列表 + 类型（并补 CLI 对等参数）／正文 + 约束列表 + `--constraint`／只把正文输入做大。
- 位置：所有标签页（已选项目时）／仅任务工作台标签页。
- 收起形态：单行输入 + 创建按钮 + 展开／只有一个按钮条／单行输入 + 展开（回车即建）。
- SELF 类型：只开放 `DEVELOPMENT` 并把 SELF 标为未实现／允许 SELF 但注明与开发任务行为相同／本轮不做类型选择。
- 落地顺序：直接在当前 dev 工作树实现全部改动／本轮只做 UI，CLI 对等参数稍后补。

## Decision

- 新增 `apps/ui/src/new-task-dock.tsx`：页面底部的停靠条，收起时为单行输入 + `＋ 创建草稿` + `展开 ⌃`（回车提交），展开时为多行规格输入，`⌘/Ctrl + Enter` 创建、`Esc` 收起。
- 位置与生命周期：已选项目时在所有标签页显示（无项目或未接入项目时不显示）；停靠条按 `projectId` 重建，切换项目不沿用上一项目的草稿文本。创建成功后清空输入、收起，切到任务工作台并选中新草稿，同时清空该列表的搜索与状态筛选，使新草稿一定可见。原有任务列表卡片内的输入框随之移除。
- 定位方式：`position: sticky; bottom: 0.75rem` 的正常流元素，不是浮层。这样滚动时它始终贴在视口底部，但不覆盖上方内容，页面也无需为它预留高度。
- 展开面板：多行规格正文 + 约束列表（逐条添加/删除，空白行在发送前丢弃，Runtime 仍会再校验）+ 任务类型字段。
- CLI 对等：`codeestra task create <project-id> <specification> [--constraint <text>]… [--kind DEVELOPMENT]`。约束 ID 由客户端生成（Runtime 要求同一 revision 内唯一非空）；未知 `--flag`、空 `--constraint`、缺失值均为 usage 错误（退出码 2）。无参数的多词规格仍按原样拼接，保持旧用法不变。
- 提交字段与 CLI 逐字段一致：`specification`、`constraints[]`、`kind`。
- 类型只提供 `DEVELOPMENT`；`SELF` 在 UI 中可见但禁用并附原因，在 CLI 中用 `TASK_KIND_UNSUPPORTED`（退出码 1）显式拒绝，不静默降级为 DEVELOPMENT：Runtime 对 SELF 无任何区别行为，接受它会声称一个不存在的能力。
- 不新增 Runtime 语义、命令、事件、确认或门禁；纯便利前端 + 既有命令面的参数暴露。

## Consequences

- 常态新增审批成本：**0 步、0 等待**；创建草稿的路径从“滚动回列表卡片”变为始终可见。
- 底部停靠条与 footer 顺序：footer 在其上方，滚动到底时停靠条位于页面最底部并保持 0.75rem 视觉间隙（`.workspace-shell` 的 `padding-bottom`）。
- 未闭合缺口（必须显式跟踪）：契约与 Runtime 仍接受 `kind: 'SELF'`（`packages/contracts` 的 enum 与数据库 CHECK 都包含它），所以绕过 CLI/UI 直接调用命令面仍可创建行为与 DEVELOPMENT 无异的 SELF 任务。本轮只在两个客户端边界拒绝，未收紧 Runtime 边界——那会改动契约与 Runtime 语义，属独立决策；Phase 7 落地前该缺口保持记录在案。
- 浏览器视觉、焦点顺序与窄屏表现不能由命令面证明，需用户人工确认；不接受“构建通过”作为排版验收。

## Verification

- `bun run check` 全程退出码 0：根 `tsc --noEmit`、UI `tsc --noEmit`、vitest 212 项、Bun tests 244 项（含本轮新增 4 项 CLI 测试）、UI Vite 构建。最终一轮在同时含 FOUNDATION-033 未提交 UI 改动的树上运行，两边改动共存且一起通过。
- `bun test apps/runtime/test/cli-task-create.test.ts`（新增 4 项）：`--constraint` 重复传入的文本与唯一非空 ID 进入 revision 且可由 `task.list` 读回；无参数的多词规格仍按原样拼接、约束为空；`--kind SELF` 退出码 1、stderr 含 `TASK_KIND_UNSUPPORTED` 且不创建任何任务；未知 flag、空白约束、缺失值退出码 2 且不创建任何任务。
- HTTP smoke（临时 `CODEESTRA_HOME`，真实构建资产由真实 Runtime 托管）：`/`、JS、CSS 均 200；bundle 含 `new-task-dock`、展开面板文案、约束编辑器与类型字段标记；构建 CSS 含 `position:sticky`、`bottom:.75rem` 与约束行样式；旧 `task-composer` 在 JS 与 CSS 中均已消失；无令牌 `POST /api/command` 401、带令牌 `project.list` ok。
- 该 smoke 同时暴露并修正了一个真实缺陷：`.new-task-dock form`（0,1,1）会压过 `.new-task-bar`（0,1,0）的 `flex-direction: row`，使收起条变成纵向排列；规则改为 `.new-task-dock .new-task-bar` 并断言构建产物含该选择器。
- 命令面回归：`bun test apps/runtime/test/http-api.test.ts`（6 项）、`apps/runtime/test/cli-attention.test.ts`（3 项，含用 UI 自身 HTTP 客户端创建草稿与读取任务）。
- 未执行：浏览器/桌面/键鼠自动化（仓库明确禁止）。因此“停靠条是否真的贴在底部、展开后键盘焦点、窄屏换行”仅由用户人工确认，本 ADR 不声称已验证。

## Related

- [ADR-0007](0007-local-web-ui-entry.md)
- [ADR-0008](0008-efficiency-first-service-form.md)
- [ADR-0015](0015-task-workbench-and-themes.md)
- [任务进度](../tasks/README.md) FOUNDATION-034
