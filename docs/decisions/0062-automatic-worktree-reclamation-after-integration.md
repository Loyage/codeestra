# ADR-0062：集成成功后自动回收 Task worktree（默认开启，可关闭）

Status：Accepted（用户 2026-09-16 决策）。**已实现**（本仓库用户任务，schema 无变更、不占迁移号）。
本 ADR 落实 ADR-0021 D03 末尾保留的那一项：「若将来要把回收接入 Agent 自动路径，则需要单独 ADR 并评估效率成本」。

## Context

ADR-0021 把资源回收做成**显式用户命令**（`reclaim plan/apply/records`）：归属校验 + append-only 账本 +
失败现场默认保留。它同时留下一个明确的缺口——**没有任何自动路径**。于是：

- `task integrate` 成功后，`dev` 前进、成员 Task 变 `SUCCEEDED`，但成员的 Task worktree 仍留在
  `<CODEESTRA_HOME>/worktrees/<project>/<task>`，直到用户记得跑一次 `reclaim apply`；
- 对一个持续自进化的仓库，这意味着每集成一批就多留一个 worktree（本机实测：稳定 Runtime 下
  `worktrees/` 与 `verifications/` 已累计到约 99 MB / 89 MB）；未清理的工作树既不自动消失，也不在任何
  用户会主动查看的地方提醒。
- 与此同时，`reclaim` 的判定本身已经足够保守：只有「Task 终态 + 无 held Execution / 活跃预留 +
  worktree clean + 成果已合入 Task 基线 ref」才 `RECLAIM`；`FAILED`/`CANCELLED`/脏/未合入一律
  `RETAIN/FAILURE_SCENE`。也就是说，自动路径要复用的正是这套已经过验证的决策，而不是新发明一条删除规则。

用户本条任务的原始要求是：「优化资源管理回收，任务跑完了，合并了，就应该可以删除 worktree 了」。
用户逐项裁决（本轮 A/B/C 的实际答复，未答复项不作批准）：

1. 触发时机：**集成成功后立即回收**（`dev` 前进后，回收该批成员的 Task worktree；不做后台周期扫描）。
2. 「已合并」判据：**沿用现状**——成果 commit 是 `workspace.baseRef`（没有 dev clone 时 = 项目文件夹当时
   检出的分支）的祖先即算合并。
3. 用户可关闭：**默认开启 + 新增设置开关**（CLI 与设置页），关闭后回到手动 `reclaim`。
4. 终态但未合并的 clean worktree：**保留为失败现场**（不因自动路径而放宽）。

## Options

1. 触发时机：
   - A. 集成成功后立即回收（用户选 A）；
   - B. 集成后 + Runtime 启动/调度周期扫描（也覆盖被管理项目里用户手动合并的情形）；
   - C. 只做后台扫描。
2. 合并判据：
   - A. Task 基线 ref（沿用现有 `reclaim` 判定；用户选 A）；
   - B. 基线 ref 或项目当前 HEAD 任一祖先；
   - C. 任意本地分支包含成果 commit。
3. 开关：
   - A. 始终开启、无设置；
   - B. 默认开启 + 可关闭设置（用户选 B）；
   - C. 默认关闭、显式开启。
4. 未合并的 clean worktree：
   - A. 保留为失败现场（沿用现状；用户选 A）；
   - B. 也自动回收，只保留分支。

## Decision

### D01：触发点是「集成成功」这一次，且复用现有 reclaim 决策

- 在 `integrateComposedBatch` 里，`completeIntegrationBatch` **成功返回之后**（`dev` 已前进、成员 Task 已是
  `SUCCEEDED`），对**该批每个成员**执行一次 scoped 回收：`kinds=['TASK_WORKTREE']`、`taskId=成员`。
- 复用 `applyReclamation`（ADR-0021 D03 的同一决策、同一归属校验、同一 append-only 账本），不新增删除规则。
  只有「Task 终态 + worktree clean + 成果已是基线 ref 的祖先 + 无 held Execution / 活跃预留」才会删；
  其它一律写成 `RETAINED`/`REFUSED`/`ALREADY_ABSENT`。
- **不回收**该批以外的 Task，不回收 `VERIFICATION_COPY` / `INTEGRATION_WORKTREE`（后者的清理继续由集成路径
  自己的 `removeIntegrationWorktree` 与显式 `reclaim` 负责）。
- 不做后台周期扫描：用户选择了 A。因此在「集成成功但 Runtime 在回收前崩溃」的窗口里，worktree 会留到下一次
  显式 `reclaim`；这是本 ADR 如实记录的边界，不伪装成已自动收尾。

### D02：「已合并」沿用 Task 基线 ref，managed 项目不特殊化

自动回收与手动 `reclaim` 用同一个 `merged` 计算：`isAncestor(resultCommit, readLocalRefCommit(baseRef))`，
其中 `baseRef = workspace.baseRef ?? project.devRef`。对 managed 项目（没有 dev clone）这仍是「项目文件夹当时
检出的分支」——用户把它合到**别的**分支时不会被视为 `merged`，worktree 因而保留。这是用户明确选择的现状，
不是缺陷；需要更宽判据时由用户在手动态里显式 `reclaim --include-failure-scenes`，本 ADR 不放宽它。

### D03：全局设置 `auto-reclaim`，默认开启；关掉即回到手动

- 新设置文件 `<CODEESTRA_HOME>/auto-reclaim.json`（`{"version":1,"enabled":true}`，0600/0700），与
  `permission-mode.json` / `prose-question-attention.json` / `ui-settings.json` 同理由：Runtime 必须在任何迁移
  之前读到它，文件小且可人工编辑，不必为它建表或迁移。
- 缺文件 = 默认开启；文件不可读或非法 = 报错并使用默认值（与 prose 设置同处理：不静默改写，也不阻止 Runtime 启动）。
- 命令面：
  - `codeestra settings auto-reclaim`（读）与 `codeestra settings auto-reclaim on|off`（写），零确认；
  - Runtime 命令 `settings.autoReclaim.get` / `settings.autoReclaim.set { enabled }`；
  - Web 设置页新增一个同语义的开关，读写同一条 Runtime 命令。
- 关闭后：`task integrate` 照常集成，**不**回收任何 worktree；显式 `reclaim apply` 的行为一字不变。

### D04：自动回收是「集成成功之后的最佳努力」，永不改变集成结果

- 集成的成功/失败由 `dev` 是否前进定义，**不**由回收是否成功定义。`completeIntegrationBatch` 成功即 `INTEGRATED`。
- 每个成员的回收单独 `try/catch`：失败（例如命令 ID 冲突、上一次回收中断需要 reconcile、文件系统报错）写成
  报告里的 `reclamation` 汇总与审计账本，集成仍如实报 `INTEGRATED`；失败的 worktree 留在磁盘上，下一次显式
  `reclaim` 或下一个成员继续处理。
- 回收**不**删除 branch、不 `git clean`、不 `reset --hard`（ADR-0021 D01 原样）。被回收的 workspace 行转
  `RELEASED`，`task retry` 仍可按 ADR-0042 从保留分支重建。

### D05：自动路径在账本里可辨认，但不新增 schema

- 自动回收的 `command_id` 是确定性的 `auto-reclaim:<batchId>:<taskId>`，因此崩溃后重放同一次集成不会产生
  第二次删除（`applyReclamation` 按 command ID 幂等）。
- 每条记录的 evidence 增加 `automatic: true`、`trigger: 'INTEGRATION'`、`batchId`，与手动 `reclaim` 可区分；
  不新增 `reclamation_records.source` 取值，因此**无 schema 变更、不占迁移号**（`source` 表达的是「记录资源 vs
  未注册目录」这一正交事实，触发方式不属于它）。
- `IntegrationReport` 增加 `reclamation` 汇总（是否开启、attempted/reclaimed/alreadyAbsent/retained/refused/failed、
  detail），让 CLI/UI 无需另发 `reclaim records` 就能看到这一次自动回收的结论。

## Consequences

- 常态路径新增的等待是**一次集成内的同步本地 `git worktree remove`**（每成员一次，无网络、无模型、无确认）。
  用户已接受该成本；它把「集成后仍要记得跑 reclaim」这一步从日常里去掉。
- 没有关闭设置时，自动回收是默认行为；关闭后行为与今天完全一致，属于零成本的逃生口。
- 失败现场（脏 / 未合入 / 失败或取消的 Task）默认仍保留，自动路径不放宽这条安全边界；自动回收不会像
  `task purge --force` 那样越过活占类门禁。
- 仍然存在「集成成功但回收未发生」的诚实缺口：回收前崩溃、回收时进程表不可读、worktree 脏、项目当前 checkout
  不可核验等。它们都写在 `reclamation` 汇总与账本里，下一次显式 `reclaim` 仍能处理。

## Verification

只用 CLI / Runtime 命令面与临时 `CODEESTRA_HOME`、临时 Git 仓库验证（ADR-0008），不使用桌面/键鼠自动化：

1. `apps/runtime/test/cli-integrate.test.ts`（扩展）：集成成功后成员 Task worktree 目录消失、`workspaces.state`
   变 `RELEASED`、`refs/heads/task/<id>` 仍在、`reclaim records` 里有 `automatic: true` 的 `RECLAIMED` 行；
   `IntegrationReport.reclamation` 汇总计数正确。
2. `apps/runtime/test/cli-integrate.test.ts`（扩展）：`settings auto-reclaim off` 后同样的集成**不**删除
   worktree（目录仍在、`RELEASED` 未发生），显式 `reclaim apply` 仍可删；再 `on` 后恢复自动删除。
3. `apps/runtime/test/cli-auto-reclaim.test.ts`（新增）：`settings auto-reclaim` 读默认 `enabled:true`、
   `on/off` 写读一致、非法值用法退出码 2、设置文件不可读时读命令以稳定错误拒绝而写命令可恢复。
4. 回归：`bun test apps/runtime/test/cli-reclaim.test.ts`（手动 reclaim 语义未变）。
5. `bunx vitest run apps/ui/test`（设置页开关的纯投影断言）与 `bun run typecheck` / `bun run typecheck:ui`。
6. 未验证：多成员批次在同一命令里的回收顺序与部分失败的真实端到端；真实 provider 长跑后自动回收；Windows。

## Related

- ADR-0021（资源回收；D03 末段要求本 ADR）、ADR-0037（批量与未注册目录）、ADR-0042（从保留分支重建 worktree）
- ADR-0018 / ADR-0053 / ADR-0056 / ADR-0060（集成、基线来源、`dev` 事实来源）
- ADR-0008 / ADR-0011（效率优先、CLI 完备、FULL 零确认）、ADR-0050（文档同步）
- `apps/runtime/src/reclaim-service.ts`、`apps/runtime/src/integration-service.ts`、
  `apps/runtime/src/auto-reclaim-settings.ts`、`packages/contracts/src/index.ts`、`apps/cli/src/main.ts`、`apps/ui/src/settings.tsx`
