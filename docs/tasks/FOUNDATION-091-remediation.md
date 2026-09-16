# FOUNDATION-091 修复交接单：冲突判定改为「声明同一功能」之后的测试与文档收尾

> **状态：已执行完毕（2026-09-16，同一分支 `lane/p1-task-purge`）。** 执行结果见
> `docs/tasks/README.md` 的 FOUNDATION-091 一节（469 项全绿、两个真实缺陷修复、文档逐篇同步清单）；
> 本文保留下来作为**当时交办要求与失败清单的原始记录**，不再代表当前待办。
>
> 这份文件是**交给 agent 执行的修复说明**，不是任务记录本身。任务记录见 `docs/tasks/README.md` 的 FOUNDATION-091 一节，
> 决策原文见 `docs/decisions/0059-feature-declaration-conflict-rule.md`（并取代 ADR-0031 的判定语义）。
> **判定语义已经由用户逐项确认，不需要重新讨论**；本文件只讲「怎么把仓库恢复成全绿」。

## 0. 环境与边界（先读，别踩）

- 本机布局（ADR-0048）：开发在 `~/Documents/codeestra-dev`（检出 `dev`）。**稳定 clone `~/Documents/codeestra` 一律不要碰**，也不要对它执行 git 命令。
- 当前工作分支：`lane/p1-task-purge`，基线 `dev@17b4dd6`（未 rebase、未合入新 dev）。
- 工作区里已有**未提交**的格 1（`task purge`，ADR-0058）与格 2（本格，ADR-0059）全部改动。**不要** `git checkout .` / `git stash` / `git reset --hard`，也不要创建新分支或 worktree。
- 测试用 `CODEESTRA_HOME` 一律指向临时目录（`apps/runtime/test/support/runtime-reclamation.ts` 会强制校验）；**绝不**用 `~/.local/state/codeestra-dev`。
- 禁止（仓库规范）：浏览器/桌面/键鼠自动化（ADR-0008）；在功能分支跑全量 `bun run check` / `just check` / `just verify`（ADR-0038，只能跑下述定向文件）。
- **未获用户授权不要 commit / push / 合入 `dev`**；完成后只报告。

## 1. 现在的状态

已实现且**已通过**的部分（不要改动它们的语义，只需在必要时跟随修复）：

| 范围 | 命令 | 结果 |
|---|---|---|
| 判定规则（新规则） | `bun x vitest run packages/domain/test/impact-analysis.test.ts` | 19 pass（已按新规则重写） |
| 存储 + 领域 | `bun test packages/storage/test packages/domain/test` | 474 pass（含三处 v26/v28/v29 升级 fixture 补 `ALTER TABLE task_revisions DROP COLUMN features_json`） |
| 调度服务 | `bun test apps/runtime/test/schedule-service.test.ts` | 10 pass（5 项已按新规则重写） |
| 调度 CLI | `bun test apps/runtime/test/cli-schedule.test.ts` | 6 pass（3 项已重写） |
| 影响面 CLI 端到端 | `bun test apps/runtime/test/cli-impact.test.ts` | 1 pass（已重写） |
| 其它已跑且绿 | `bun test apps/runtime/test/scheduler.test.ts apps/runtime/test/snapshot-generation-recheck.test.ts apps/runtime/test/cli-task-create.test.ts` | 22 pass |
| UI | `bun x vitest run`（489 项）+ `bun run typecheck` + `bun run typecheck:ui` | 全绿，0 类型错误 |

**要修的**：`bun test apps/runtime/test` → **395 pass / 74 fail**（469 项 / 66 文件，约 11 分钟），
外加 `docs/guides/` 的文档同步（§4）。

## 2. 造成这 74 项失败的行为变化（同一个根因）

ADR-0059 把默认值从「无法证明不相交 → 等待」换成「默认不冲突 → 开始」。具体规则（`packages/domain/src/impact-analysis.ts`）：

```
peer = 同项目中「未完成」（非 SUCCEEDED / CANCELLED，且未归档）且「声明了至少一个功能」的任务（排除自己）
若 candidate.features ∩ peer.features 非空 → CONFLICTING（SAME_UNFINISHED_FEATURE）
否则 → SAFE_TO_PARALLELIZE
```

**未声明任何功能的任务永远不冲突**，因此它**提交后会在容量允许时立即 `RUNNING`**（旧规则下它会被判 `UNKNOWN` 而停在 `READY`，直到显式 `--allow-unknown`）。

这正好是用户要的「快」，但大量既有 fixture 的写法是：

```ts
const task = await createAndSubmit(...);          // 期望：submit 后仍是 READY、什么都不会开始
await cli(['task','cancel', projectId, task.id, '1'])   // 用固定版本 1 做 CAS
```

现在同一个任务已经在跑，于是：固定版本 CAS 撞 `CONCURRENT_MODIFICATION`；`reclaim`/`integrate`/`pause` 看到的是「正在跑」；
attention / prose-question / knowledge / session-guidance / transcript / handoff 等用例的前提（任务还没动）不再成立。

### 修法只有四种模式

- **A（该文件确实需要「先等待」）**：让 fixture 的相关任务**显式声明功能**，用它制造真实的等待。
  - `task create <project> <spec> --feature <module-id> --feature …`（可重复）；`task revision create … --feature <id>` 设置/替换新 revision 的声明（**省略即继承**，只改声明也是合法 revision）。
  - 前提：项目必须有 `.codeestra/impact.json` 且其中 `modules[].id` 含该 id（fixture 里的 `withImpactMapping: true` 帮助函数已经能建这样的仓库；见 `apps/runtime/test/cli-schedule.test.ts` 的 `fixture()` 与 `createTask(..., flags)`）。
  - 两个任务要**先后创建**（规则是对称的：同时声明同一功能时两个都不会先跑）。
  - 想表达「对方已经做完」：`task cancel`（`CANCELLED`）或 `archiveTask`（已归档）——两者都不再拦人。
- **B（该文件只是想读/改一个任务，不关心冲突）**：**不要**为了阻止它启动而加声明；把断言改成「提交即开始」的事实：
  - 需要 `READY` 的地方改成对 `RUNNING` 断言，或用 `task status` **重新读取当前版本**再发 CAS 命令（参考 `cli-schedule.test.ts` 里 `taskRef()`、`cli-impact.test.ts` 里 `cancelWithCurrentVersion()` 的写法）。
  - 需要「不让它跑」的最省事做法是**把容量设为 1 并占住**，或直接不 submit（用 DRAFT 状态做 fixture）。
- **C（新增字段 / 语义变化的跟随修复）**：
  - `analyzerVersion` 已从 `'impact-analyzer-v1'` 变为 `'impact-analyzer-v2'`（断言里的字面量要改；历史行的 fixture 可以保留 v1）。
  - `impact explain` / `schedule explain` 的 `active[]` 条目新增 `features: string[]` 与 `unfinished: boolean`；`active[]` 现在只列**声明了功能的未完成任务**（不再是「持有资源的任务」）；`hits[]` 新增 `features: string[]`。
  - 新错误码：`UNKNOWN_FEATURE` / `IMPACT_POLICY_ABSENT` / `INVALID_IMPACT_POLICY`（`task create`/`task revision create` 带 `--feature` 时）；`INVALID_FEATURE`（空 id）。
  - `UNKNOWN` / `--allow-unknown` / `schedule clear-unknown` 仍在，但**当前规则不再产生 `UNKNOWN`**：任何假定「无映射 → UNKNOWN → 等待」的用例都必须改写为 SAFE/开始，或改为用功能介绍冲突。
- **D（schema fixture）**：`phase1SchemaVersion` 现在 **32**。凡是「先建当前 schema → 降级戳旧版本 → 重开」的 fixture，除了已处理的 storage 三处，还要补
  `ALTER TABLE task_revisions DROP COLUMN features_json`（v32 是纯 `ADD COLUMN`，重复执行会报 duplicate column）。
  断言 `user_version` 的地方**不要写死 31**，用 `phase1SchemaVersion`。

## 3. 逐文件清单（74 项，含建议模式）

模式说明见上一节。**表里的「建议模式」是按文件用途给的起点，agent 仍需逐个确认断言意图**——尤其不要用「加个声明让它永远等待」去掩盖一个本该改成「开始」的用例。

| 文件 | 失败数 | 建议模式 | 失败的测试 |
|---|---|---|---|
| `apps/runtime/test/cli-attention.test.ts` | 3 | B | `carries one structured questionnaire to the CLI and the answer back to the Agent`<br>`workbench HTTP client reads tasks and answers while a task awaits user input`<br>`refuses a structured answer for an Attention that is not a questionnaire` |
| `apps/runtime/test/cli-capacity-slots.test.ts` | 5 | B | `two Tasks reserve at capacity two, the third waits, and a retry is refused`<br>`two concurrent start requests never produce two reservations`<br>`a workspace is prepared for a reservation and bound to it`<br>`a crash leaves a reservation whose holder is provably gone, and starting up releases it`<br>`a reservation whose holder cannot be verified keeps its slot instead of letting it through` |
| `apps/runtime/test/cli-claude-adapter.test.ts` | 5 | B | `routes a STRICT permission request to the existing Attention face and back to Claude`<br>`runs without any approval in FULL mode and never asks for confirmation`<br>`replaces a failed run attempt with a new run on a different adapter`<br>`applies the per-adapter Agent configuration to the Claude launch, and refuses provider`<br>`resumes a paused Claude Task on Claude and refuses a cross-provider resume` |
| `apps/runtime/test/cli-codex-adapter.test.ts` | 5 | B | `routes a STRICT command approval to the existing Attention face and back to Codex`<br>`runs without any approval in FULL mode and never asks for confirmation`<br>`replaces a failed run attempt with a new run on a different adapter`<br>`applies the per-adapter Agent configuration to the Codex launch only`<br>`resumes a paused Codex Task on Codex and refuses a cross-provider resume` |
| `apps/runtime/test/cli-integrate.test.ts` | 2 | B | `runs the whole integration from the CLI and moves dev only after it passes`<br>`refuses to integrate without a PASSED verification and leaves dev untouched` |
| `apps/runtime/test/cli-integration-batch.test.ts` | 3 | B | `composes and integrates two members with one verification, and dev moves only then`<br>`marks the batch STALE when a member revision moved, and leaves dev untouched`<br>`marks the batch STALE when dev moved before the integration, and cancels a fresh batch` |
| `apps/runtime/test/cli-knowledge.test.ts` | 2 | C | `lays the human and machine layers out, loads them from the main ref and binds them to an Execution`<br>`two concurrent Tasks never conflict because of machine-generated knowledge` |
| `apps/runtime/test/cli-promotion.test.ts` | 6 | B | `pushes to the remote dev branch, waits for the pull, then restarts and publishes main`<br>`reports a failed post-step without publishing main and without claiming a restart`<br>`keeps the STRICT approval gate on the CLI without a second confirmation`<br>`refuses a promotion whose fixed evidence does not match Git, and a dev clone that is not one`<br>`refuses a promotion with no full-suite evidence of the fixed dev commit`<br>`records the three bindings and refuses to push when the policy on main changes` |
| `apps/runtime/test/cli-prose-question-attention.test.ts` | 4 | B | `escalates by default, refuses a provider delivery, and ends on an explicit answer`<br>`dismisses a false alarm and returns the Task to where it was`<br>`the settings command downgrades escalation with no confirmation`<br>`off records strictly less: no note, no wait` |
| `apps/runtime/test/cli-prose-question.test.ts` | 2 | B | `records and shows a note when a run used no tool and ended with a question`<br>`leaves a run that used a tool unannotated even when it ends with a question` |
| `apps/runtime/test/cli-reclaim-batch.test.ts` | 4 | B | `reclaims every trusted project in one command, grouped per project`<br>`does not mistake a ledger-claimed worktree for an unregistered directory when the home is reached through a symlink`<br>`never reclaims a workspace an active reservation still holds`<br>`reads the ledger back by source and by time` |
| `apps/runtime/test/cli-reclaim.test.ts` | 5 | B | `plans, reclaims and reports an owned Task worktree without touching the branch`<br>`retains a failure scene unless the caller explicitly includes it`<br>`refuses a recorded path that is not owned by this Runtime`<br>`refuses to reclaim a workspace whose Execution still holds it`<br>`reconciles a crashed reclamation from the actual state without deleting anything` |
| `apps/runtime/test/cli-session-attach.test.ts` | 2 | B | `takes over into a real PTY, survives detach/reattach, and hands back to automation`<br>`keeps the permission mode across the handoff in both directions, in both modes` |
| `apps/runtime/test/cli-session-guidance.test.ts` | 1 | B | `records guidance, hands it to the next Execution and never becomes a TaskRevision` |
| `apps/runtime/test/cli-session-handoff.test.ts` | 4 | B | `routes a STRICT permission to the existing attention face and reports the denial`<br>`requires a safe point, then hands the conversation to a native terminal`<br>`every fact is readable from events list, in one aggregate per takeover`<br>`replaying an admission adds no second handoff fact` |
| `apps/runtime/test/cli-snapshot-recheck.test.ts` | 4 | A | `reserves on a current generation and refuses one whose baseline moved, writing nothing`<br>`refuses a generation whose mapping changed, and accepts the regenerated one`<br>`two concurrent acquisitions of one generation produce exactly one reservation`<br>`omitting --snapshot keeps the primitive working and records no assessment` |
| `apps/runtime/test/cli-targeted-tests.test.ts` | 2 | B | `records the plan from the tested commit and runs it instead of the project policy`<br>`refuses a plan that is absent or abbreviated instead of guessing` |
| `apps/runtime/test/cli-task-control.test.ts` | 2 | A | `cancels a READY Task from the CLI with a terminal state`<br>`archives and unarchives a Task without destroying it` |
| `apps/runtime/test/cli-task-depends.test.ts` | 1 | B | `keeps a downstream Task BLOCKED until the upstream is integrated, then unblocks it` |
| `apps/runtime/test/cli-task-purge.test.ts` | 2 | B | `deletes a Task, its owned worktree and its branch, and records what it destroyed`<br>`refuses to purge without --yes and changes nothing` |
| `apps/runtime/test/cli-task-run-progress.test.ts` | 2 | B | `records task.run progress as durable steps and reports them through the CLI`<br>`runs task.verify in the background and cancels a slow policy command` |
| `apps/runtime/test/cli-transcript.test.ts` | 3 | B | `shows the Agent process step by step from the CLI and the Runtime command face`<br>`prints the newest entry first with --reverse and reads as many pages as that needs`<br>`refuses a recorded session file outside the Runtime session directory` |
| `apps/runtime/test/revision-delivery.test.ts` | 1 | B | `creates a revision, reports the unconfirmed delivery, and restarts onto it` |
| `apps/runtime/test/runtime-lifecycle.test.ts` | 1 | B | `stop ends the Runtime that holds a live provider, and the provider with it` |
| `apps/runtime/test/session-guidance-migration.test.ts` | 2 | D | `appends additively to a v30 database and leaves the schema consistent`<br>`a database already stamped 31 opens without re-running the step` |
| `apps/runtime/test/task-recovery-service.test.ts` | 1 | B | `makes the occupier visible as WORKSPACE_MISSING when its worktree is not on disk` |

### 三个必须单独说的坑

1. **`cli-task-purge.test.ts`（格 1 自己的端到端）也在这 74 项里**：它的 fixture 先 `task submit`（现在会立刻启动一个真实 stub provider 的 Execution），再手工跑 fake adapter，于是状态/版本假设全部错位。修法属于模式 B：fixture 必须**不让它自动启动**（例如不 submit 而直接建 EXECUTED fixture、或先占满容量），**不要**用声明功能去挡它（格 1 与格 2 是两件事）。
2. **增长检测**：`TaskImpactPredictionRevoked` 仍然只在「声明比较发现冲突」时写；diff 增长不再暂停任何人（`impactGrowth[].pauseRequested === false`、`conflictingTaskIds === []`）。别把旧断言改回去。
3. **`impact_assessments` 是部分覆盖**：只有「两侧都有可观测快照」的配对会写行，所以「没有行」**不等于**「没有冲突」。涉及它的断言要以 `TaskScheduleDecided` / `TaskWaitingForConflict` 事件为准。

## 4. 文档同步（ADR-0050，必须做完）

本格只同步了 `docs/guides/cli-reference.md`（新增 `--feature` 一节 + 头部校对说明）。**其余四篇还没做**，交付前必须补齐并在交付说明里写明改了哪一篇的哪一节：

| 文件 | 要改什么 |
|---|---|
| `docs/guides/ui.md` | 任务详情新增「声明的功能」一行；`SAME_UNFINISHED_FEATURE` 标签；冲突命中显示功能 id；「默认不冲突」对表单/按钮提示的影响（如果有）；头部版本/校对 |
| `docs/guides/features.md` | 「冲突判定」相关能力行改为「声明同一功能且对方未完成才冲突；文件重叠不再拦」+ 指向 ADR-0059；头部版本/校对 |
| `docs/guides/manual.md` | 用户视角：「提交后会在容量允许时开始，不再默认等待」「想让两个任务互斥就给它们声明同一功能」；头部版本/校对 |
| `docs/guides/troubleshooting.md` | 新增/改写：`UNKNOWN_FEATURE`、`IMPACT_POLICY_ABSENT`、`INVALID_IMPACT_POLICY`、以及「为什么两个任务不冲突了」；把「所有冲突判定都是 UNKNOWN，任务绝不并行」那一节的现状改写（该节现在描述的是历史行为）；头部版本/校对 |
| `docs/guides/concepts.md` | 只需**确认**是否提到「未知不等于无冲突 / 默认等待」；提到就要改，没提到要写明「确认无需修改」 |
| `docs/architecture/scheduler.md` | §1「活跃集合」需区分：**占用/容量**仍看资源持有者，**冲突**看「未完成 + 已声明功能」；§2 的判定流程与「UNKNOWN 不并行」段落要改写 |
| `docs/architecture/domain-model.md` | Task 持有 `features`（声明）这一事实 |
| `docs/tasks/README.md` | FOUNDATION-091 一节的状态从「74 项失败」更新为实际结果，并记录本次修复 |

## 5. 验证清单（Definition of Done）

按顺序跑，全部通过才算完成：

1. `bun test packages/storage/test packages/domain/test` → 全绿（474 baseline 项，可多不可少）。
2. `bun test apps/runtime/test` → **469 项全绿**（当前 395 pass / 74 fail）。**这是本次修复的主判据。**
3. `bun test apps/runtime/test/schedule-service.test.ts apps/runtime/test/cli-schedule.test.ts apps/runtime/test/cli-impact.test.ts` → 全绿（这三项是格 2 语义的守门测试，不许为了让别的用例过而弱化它们）。
4. `bun x vitest run` → 全绿（UI 489 项）+ `bun run typecheck` + `bun run typecheck:ui` → 0 错误。
5. 文档：§4 表格逐项完成或写明「确认无需修改」。
6. 报告里**如实**写出实际运行的命令、退出码与计数；不能运行的检查写明原因，禁止声称未执行的测试通过。
7. **不要** commit / push / 合入 `dev` / 跑全量 `check`（等用户授权与 `dev` 上的全量测试证据，ADR-0038）。

## 6. 明确不要改的东西（已由用户决策）

- 判定规则本身：**只有**「声明同一功能 + 对方未完成」是冲突。不要重新引入同文件/同目录/同模块/共享资源的启动前拦截，也不要给它们加「可选严格模式」（用户明确没有选 B）。
- 不要退回成「无映射 → UNKNOWN → 不并行」。
- 不要新增确认/审批/门禁；FULL 常态路径步数与等待必须保持 0（ADR-0011）。
- 不要把 `--feature` 改成需要 `project trust` 已确认（那会让界面信任的项目无法声明功能，ADR-0059 D03 已说明理由）。
- 不要为了让测试变绿而放宽 Runtime 的输入校验（`UNKNOWN_FEATURE` 等拒绝必须保留）。
