# ADR-0018：Task 成果合入 dev（IntegrationBatch 第一小步）

Status：Accepted（用户明确选择：最小可用 `task.integrate`；能 ff 就 ff，否则 `--no-ff`；仅在 dev 未被任何工作树检出时才推进 ref；合并前必须有独立集成验证 PASSED；本轮直接落正式 IntegrationBatch（成员表）；本轮一并把 worktree 基线修正为固定 dev；任何失败一律保留现场且不推进 dev）

## Context

用户要求提供“一键把 commit 合入 dev 分支”的能力。这与既有规格直接相关：

- `PROJECT_SPEC.md` §2.12：Task 验证与 Integration 验证是**不同实体/记录**，不能互相替代；功能必须先进入 `dev`。
- §2.14：IntegrationBatch 是正式领域对象，记录任务集合、对应 revision、commit、固定 dev 基线、dev 集成结果和验证证据。
- ADR-0009：Task worktree 必须从固定 `dev` commit 建立；`dev → main` 是唯一稳定提升路径。
- ADR-0008/0011：FULL 下常态操作 0 确认；STRICT 保留旧门禁。

实现前确认的现状：

1. 仓库内**完全没有 Integration 代码**（`packages/*/src`、`apps/runtime/src`、`apps/cli/src` 无相关实现），Phase 4 才规划该能力。
2. `dev` 在本机被检出在 `~/Documents/codeestra-dev`。AGENTS.md 已规定：对已被检出的分支直接 `update-ref` 会让 ref 前进而 index/工作树停留在旧提交。
3. worktree 基线当时取的是“trust 时检出的分支”（`packages/git/src/index.ts` 的 `symbolic-ref HEAD`），`refs/heads/dev` 在代码中无任何引用，与 ADR-0009 不符。
4. 本仓库有**未提交的用户改动**（Justfile、README、package.json、docs/tasks/README.md，属 FOUNDATION-037），本轮不得覆盖或撤销。

## Options

1. 本轮范围：(a) 最小可用 `task.integrate`（不含 dev→main 提升与重启）／(b) 只做 ADR 与设计／(c) 完整 Phase 4 一次做完。
2. 合并方式：(a) `--no-ff`／(b) 能 ff 就 ff，否则 `--no-ff`／(c) cherry-pick／(d) squash。
3. dev 已被检出时：(a) 仅 dev 未检出时推进 ref／(b) 允许在已检出的 dev 工作树内合并／(c) 两者都做、默认 (a)。
4. 集成验证：(a) 必须 PASSED 才合并／(b) 不验证也可合并但如实标注／(c) 先合并再在 dev 顶端验证。
5. 数据模型：(a) 直接落正式 IntegrationBatch（成员表）／(b) 轻量集成记录／(c) 只用事件。
6. dev 基线：(a) 本轮一并修正为固定 dev／(b) 本轮不改、只记缺口／(c) 修正并回改待执行任务基线。
7. 失败处理：(a) 一律保留现场且不推进 dev／(b) 失败即 abort／(c) 按类型区分。

用户选择：1(a)、2(b)、3(a)、4(a)、5(a)、6(a)、7(a)。

## Decision

### D01：能力面（CLI 完备）

- 新命令 `task.integrate <project-id> <task-id> <expected-version>`（`commandId` + Task version CAS，与其他状态变更命令一致）。
- 新查询 `task.integration.list <project-id> <task-id>` 与 `task.status` 的 `integrations` 投影。
- Web UI 只在同一命令面上增加「合入 dev」按钮与集成记录表，不新增业务语义、不绕过门禁；CLI 退出码：只有 `INTEGRATED` 才是 0。
- 本轮**不含** `dev → main` 提升、Runtime 重启、多任务批次。这些仍在 Phase 4 剩余范围内，不得声称已完成。

### D02：顺序与不变量

1. 前置：Task 为 `EXECUTED`，最新捕获成果 commit 属于当前 revision，且该 revision + 该 commit 的 Task 验证为 `PASSED`（`TASK_VERIFICATION_NOT_PASSED` 否则）。仅“验证过某个 commit”不算证据。
2. 读固定 `dev` 基线 OID（`DEV_REF_MISSING` 否则），并要求 `dev` **未被任何工作树检出**（`DEV_REF_CHECKED_OUT`），否则拒绝而不制造 ref/index 不一致。
3. 在 Runtime 数据目录的 `integrations/<project-id>/<batch-id>` 建 detached worktree，基于该基线；能 ff 就 `--ff-only`，否则 `--no-ff`（合并提交以固定基线为第一父提交，候选 commit 必须是其后代）。
4. 合并产生的提交由**独立集成验证**验证：独立实体 `integration_verification_runs`（绑 candidate、合并 commit、固定 dev 基线、policy digest、main commit 与 Task 验证 ID），在候选提交的 detached 副本中执行同一项目策略。它记录为独立记录、与 Task 验证互不替代，但机制仍是同一份项目验证策略，不是第二个验证器。
5. 状态与 `docs/architecture/state-machines.md` §4 对齐：`CREATED → PREPARING → VERIFYING → INTEGRATING_DEV → INTEGRATED`，另有 `CONFLICTED / FAILED / RECOVERY_REQUIRED`。合并产生的提交先记为 `merged_commit`（在 ref 更新前落库），独立集成验证通过后才进入 `INTEGRATING_DEV`，再用 `git update-ref <devRef> <mergedCommit> <recordedBaseline>`（CAS）推进 ref，最后 `EXECUTED → SUCCEEDED`。
6. 失败（合并冲突、验证未通过、ref 已移动、worktree 失败）**一律不推进 dev**：批记录为 `CONFLICTED`/`FAILED`，合并工作树保留作现场，Task 保持 `EXECUTED`。成功后才尝试 `git worktree remove`（不加 `--force`），失败则记录并保留。
7. 崩溃恢复以**事实**而不是猜测为准：未完成集成验证记为 `ERROR(RUNTIME_RESTARTED)`；`CREATED/PREPARING/VERIFYING` 的批记为 `RECOVERY_REQUIRED` 并明确写出“dev 未被推进”；`INTEGRATING_DEV`（即崩溃可能发生在 ref 写入前后）则读取 `dev`：等于记录的 `merged_commit` 时按该事实补记为 `INTEGRATED`（绝不第二次写 ref），否则记为 `RECOVERY_REQUIRED/DEV_REF_OBSERVED` 并写明观察到的 ref 值。`RECOVERY_REQUIRED` 阻止新的集成尝试直到人工处理。
8. 权限：FULL 下合入与 STRICT 下的策略确认分离；STRICT 仍要求已验证策略与确认的 digest 一致。合入本身不新增任何确认步骤。

### D03：数据模型

- `integration_batches`（`dev_ref`/`dev_commit`/`state`/`integrated_commit`/`merge_strategy`/`merged_commit`/`worktree_path`/`verification_id`/`outcome_code`/`detail`）与 `integration_batch_items`（主键 `(batch_id, task_id)`，字段 candidate/revision/execution/state）。本轮每个 batch 只创建 1 个成员，但结构支持多成员，符合 §2.14 而不假装已实现批次调度。
- `integration_verification_runs` 独立于 `verification_runs`；`state` 沿用 `QUEUED/RUNNING/PASSED/FAILED/ERROR/STALE`。
- 事件：`IntegrationBatchCreated`、`IntegrationVerificationCompleted`、`IntegrationCompleted`、`IntegrationFailed`、`IntegrationReconcileRequired`，成功时另有 `TaskStateChanged(EXECUTED→SUCCEEDED)`；操作 `INTEGRATE_TASK_RESULT`、`RUN_INTEGRATION_VERIFICATION` 保留可恢复步骤。

### D04：dev 基线修正

- `projects.dev_ref`（默认 `refs/heads/dev`，随 trust 记录/刷新），新 Task 的 worktree 基线改由 `inspectBaseRef` 读取该 ref；已有 workspace 不回改。
- `project.inspect` 返回 `devRef`/`devCommit`/`devRefPresent`，`project.trust.expectedIdentity` 必须原样回传（因此“确认信任”同时确认了看到的 dev 基线）；仓库没有 `dev` 时 trust 明确失败 `DEV_REF_MISSING`，不静默回退到别的分支。
- `prepareWorkspace` 参数由 `mainRef`/`expectedMainCommit` 更名为 `baseRef`/`expectedBaseCommit`，避免把开发基线与策略来源混为一个 ref。

## Consequences

- 常态新增审批成本：**0 步、0 等待**（FULL 无确认；STRICT 沿用既有策略确认，无第二次确认）。
- 收益：Task 成果有了可脚本化、可审计、失败不改变 `dev` 的入口；`dev` 只在独立集成验证通过后移动；Task 终态 `SUCCEEDED` 首次有了真实来源。
- 代价/限制（必须显式跟踪）：
  1. **dev 已被检出时无法一键合入**（本机开发工作树就是这种情况）：Runtime 会拒绝并提示在 dev 工作树自行合并。选项 3(b) 被否决，因为它会改动用户正在使用的目录。
  2. 集成验证机制与 Task 验证相同（同一项目策略），只是独立记录；更强的独立验证器（不同工具/不同环境）不在本轮。
  3. 成功时 best-effort 删除 integration worktree；失败现场与副本没有自动回收策略，属既有的“资源回收待决策”范围。
  4. 多成员批次、`INTEGRATION_DEV` 之外的 Phase 4 状态（`STALE`、用户取消批次的 `CANCELLED`）、依赖满足（`BLOCKED → READY`）与 `dev → main` 提升仍未实现。
  5. 仍存在“读到 ref 未被检出”与 `update-ref` 之间的极小竞态窗口；CAS 能保证不覆盖已移动的 ref，但不能阻止这段时间内有人检出该分支。
  6. `CREATED/PREPARING` 阶段的批尚未进入独立状态校验（例如 merge 前再次核对 dev SHA 仍由 CAS 兜底），未实现批次级 `STALE` 判定。

## Verification

- `bun run typecheck`、`bun run typecheck:ui` 退出码 0。
- `bun test apps/runtime/test/integration-service.test.ts`（新增 15 项）：ff 合入并只在通过后 `SUCCEEDED`、dev 前移时的合并提交（第一父为固定基线、第二父为候选）、无 PASSED Task 验证时拒绝且不建批、dev 被检出时拒绝、合并冲突保留现场（`MERGE_HEAD` = 候选）且 dev 不变、集成验证失败保留合并工作树且 dev 不变、策略命令在集成过程中移动 dev 时 `DEV_REF_MOVED` 且不谎报成功、同 commandId 重放不产生第二次合入、STRICT 下策略确认匹配时成功/不匹配时拒绝、`commit-msg` hook 拒绝被记为 `FAILED/MERGE_FAILED` 而不是合并冲突（冲突以未合并索引项判定，不以 `MERGE_HEAD` 判定）且现场保留、无 identity 仍可 ff；崩溃恢复：ref 写入前中断 → `RECOVERY_REQUIRED` 且阻止新尝试、写入中断但 dev 已是 `merged_commit` → 核验后补记 `INTEGRATED`（不二次写 ref）、写入中断且 dev 不是 `merged_commit` → `RECOVERY_REQUIRED/DEV_REF_OBSERVED` 并写明观察值。
- `bun test apps/runtime/test/cli-integrate.test.ts`（新增 2 项，真实 CLI + 真实 Runtime + 协议 stub provider，临时仓库）：`create → submit → run → result capture → verify → integrate` 后 dev 前进到成果 commit、`main` 不变、Task 为 `SUCCEEDED`、`task integration list` 与 `task status.integrations` 一致，且 `task integrate` 退出码 1 出现在验证未通过时并不改动 dev。
- `packages/storage/test/database.test.ts` 新增 1 项：v9 → v10 升级后既有项目获得 `dev_ref='refs/heads/dev'`、三张集成表存在、非法批次状态被 schema 拒绝。
- `packages/contracts/test/request.test.ts` 新增 1 项并更新信任用例：`task.integrate` 必须携带 `expectedVersion`、`task.integration.list` 可读、`expectedIdentity` 必须包含 dev 基线字段。
- `bun run check` 退出码 0：根/UI typecheck、Vitest 212 项、Bun 测试 264 项（`test:unit` 165 + `test:e2e` 99，分层之和与总数一致）、Vite 构建。
- 回归：`bun run test:storage` 全部 Bun 测试通过（含 workspace-service/verification-service/result-commit-service/CLI 套件）。受影响的既有用例只做了与“仓库必须存在 dev 分支”有关的最小调整：临时 fixture 增加 `git branch dev`、`project.inspect` 结果类型改 `ProjectIdentity`、`prepareWorkspace` 参数改名。
- 未执行：真实 provider（非 stub）驱动的合入、多任务批次、`dev → main` 提升与重启；未使用桌面/浏览器自动化。

## Related

- `PROJECT_SPEC.md` §2.5/§2.12/§2.14、§1.1
- ADR-0005、ADR-0006、ADR-0008、ADR-0009、ADR-0011、ADR-0016
- `docs/architecture/state-machines.md`
- `docs/architecture/git-workspace-api.md`
- `docs/tasks/README.md` FOUNDATION-038
