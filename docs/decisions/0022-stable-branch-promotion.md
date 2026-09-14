# ADR-0022：稳定提升（`dev → main`）作为产品能力——固定证据、STRICT 批准失效与重启序列

Status：Accepted（用户明确选择：后置步骤 = `bun install --frozen-lockfile` + `bun run build:ui` + `bun run codeestra stop` + `bun run codeestra status`；后置序列由 CLI 客户端执行；成功判定用 `status: READY` 并把 `uiRunning` 作为观察到的事实记录）

## Context

ADR-0009 把「固定 `main`/`dev` 双分支、`dev → main` 是唯一稳定提升路径、`main` 更新后必须立即重启 Runtime」写成 Accepted，但把它落成了**人工规程**（`AGENTS.md`「重启 main 稳定服务」一节的操作步骤）。FOUNDATION-042（本 ADR）要求把该规程变成产品能力，且满足 ADR-0008 D03 的 CLI 完备要求（`--json`、稳定退出码、可脚本化驱动）。实现前必须显式决定几件与产品行为有关的事，不能自行推断：

1. **重启后置步骤的范围。** ADR-0009 D03 列出的标准流程是 `bun install --frozen-lockfile`、`bun run build:ui`、`bun run codeestra stop`、`bun run codeestra status`；`AGENTS.md` 也强调即使本次看不出依赖或 UI 变化，也允许重复执行以免漏更 `node_modules` / `apps/ui/dist` 这些被 gitignore 的工作树本地资产。但把 `install`/`build:ui` 放进产品命令意味着提升会自己跑较重的构建步骤。
2. **这段后置序列由谁执行。** 提升是通过 Runtime 命令面发起的，而序列里的 `stop` 会终止 **正在执行该命令的 Runtime**：若 Runtime 自己在响应前跑 `stop`，调用方永远拿不到响应，除非引入后台监督进程 + 轮询记账（更复杂、且把 `Runtime 恢复响应` 变成间接推断）。
3. **「Runtime 恢复响应」的判定标准。** `AGENTS.md` 的 Agent 规程写的是「`status` 返回 `READY` 且 `uiRunning: true` 才可报告 main 稳定服务已恢复」；但 Web UI 按 ADR-0007/0008 是**按需启动的便利前端**，关闭客户端不终止服务。若把 `uiRunning` 设为提升成功的必要条件，便利前端就成了稳定提升的必要条件，且提升流程必须顺带产出带 token 的 UI 链接。
4. **本机事实：`main` 已被检出。** 本仓库把 `main` 检出在稳定工作树 `~/Documents/codeestra`。对已检出的分支用 `git update-ref` 会让 ref 前进而该工作树的 index/工作文件留在旧提交（表现为「已暂存的删除」）；ADR-0018 已经因为同一原因拒绝在 `dev` 被检出时推进 `dev`。
5. **必须在真实 `main` 之外验证。** 本格不得提升真实 `main`、不得重启稳定 Runtime，所有验证必须用临时 Git 仓库 + 临时 `CODEESTRA_HOME`。
6. **既有事实模型沿用。** IntegrationBatch / 独立集成验证（ADR-0018）已经给出「被验证的 dev commit」与其验证证据；提升必须复用它们，不能另造一套验证。

## Options

1. 后置步骤范围：(a) `install + build:ui + stop + status`；(b) 只 `stop + status`；(c) 默认 `stop + status`，`--with-assets` 才做 `install/build:ui`。
2. 后置序列执行者：(a) CLI 客户端（Runtime 只做核对与推进 ref 并记为 `RESTARTING`，客户端在 `stop` 后仍存活，再向新 Runtime 记账）；(b) Runtime 自己执行（需要额外的后台监督与轮询）。
3. 成功判定：(a) `status: READY`，`uiRunning` 只作为观察到的事实记录；(b) `READY` 且 `uiRunning: true`（照 `AGENTS.md` 字面，提升流程需同时拉起 UI 并产出 token 链接）。
4. STRICT 批准形态、`main` 未被检出时的行为、非 fast-forward 的处理、崩溃恢复语义：本轮按 ADR-0009 D02 的 CAS 语义与 ADR-0018 的既有做法细化（下 D02–D07），不新增门禁。

用户选择 1(a)、2(a)、3(a)。

## Decision

### D01：能力面（CLI 完备，UI 留后续）

- 新命令组（`packages/contracts` 新增一个 `promotion.*` group，union 末尾追加）：
  - `promotion.prepare`：固定并校验提升的三项证据，创建提升记录，**不写任何 Git 副作用**；
  - `promotion.approve`：STRICT 下批准该精确三元组（FULL 下明确拒绝，而不是记录一次无意义的确认）；
  - `promotion.promote`：核对后在被检出的 `main` 工作树内 fast-forward，并返回已记录的重启计划；
  - `promotion.restart.record`：客户端跑完后置序列后，用重启后的 Runtime 证据记账；
  - `promotion.abandon`：关闭一个无法恢复的提升记录（`--reason` 必填，保留观察到的 ref 事实）；
  - `promotion.get` / `promotion.list`：只读查询。
- CLI：`promotion prepare <project-id> <batch-id> <expected-dev-commit> <expected-main-commit>`、`promotion approve <project-id> <promotion-id>`、`promotion promote <project-id> <promotion-id> [--json]`、`promotion abandon <project-id> <promotion-id> --reason <text>`、`promotion get|list <project-id>`；`promotion promote` 只有 `SUCCEEDED` 才是退出码 0，其余（含 `FAILED`/`STALE`/`RECOVERY_REQUIRED`）退出码 1，用法错误退出码 2。
- 本轮不做 UI：UI 只能是同一命令面的投影，不得新增业务语义，也不允许出现只有 UI 能完成的能力（ADR-0008 D03）。UI 投影列入后续任务。

### D02：固定证据、唯一路径与拒绝语义

提升前必须固定三件事，三者任一与事实不符即拒绝，且**不推进任何 ref**：

| 固定项 | 来源 | 与事实不符时的拒绝码 |
| --- | --- | --- |
| 被验证的 dev commit | 调用方给出的完整 OID（40/64 hex，不接受缩写、不接受 ref 名），且必须等于 IntegrationBatch 的 `integrated_commit` 与集成验证的 `tested_commit` | `INVALID_COMMIT_ID` / `PROMOTION_EVIDENCE_MISMATCH` |
| 预期 main old OID | 调用方给出的完整 OID，必须等于当前 `refs/heads/main` | `MAIN_REF_MOVED` |
| 验证证据 | `integration_batches.state='INTEGRATED'` + 其 `integration_verification_runs.state='PASSED'`，且验证绑定同一 dev 基线与合并 commit | `BATCH_NOT_INTEGRATED` / `VERIFICATION_NOT_PASSED` / `PROMOTION_EVIDENCE_MISMATCH` |

- **唯一路径**：只有 `dev → main`，且只允许 fast-forward。候选必须是预期 main commit 的后代（`PROMOTION_NOT_FAST_FORWARD`），`main` 已等于候选时拒绝（`PROMOTION_NOTHING_TO_PROMOTE`）。提升从不写 `dev`，也不 merge commit、不 cherry-pick、不 rebase。
- **批次成员可追溯**：`prepare` 时把 IntegrationBatch 的成员（`task_id`/`revision_id`/`execution_id`/`candidate_commit`）复制进 `stable_promotion_members` 并固定在提升记录上；批次之后被追加成员不会改写已固定的提升证据。
- 所有核对（仓库身份、trust、ref、工作树、证据）都发生在**任何 Git 副作用之前**；准备阶段只读 Git。

### D03：权限——FULL 零确认，STRICT 一次批准且随事实移动失效

- **FULL**：`prepare` → `promote`，常态确认成本 0 步 0 等待（ADR-0011）。
- **STRICT**：`prepare` 后必须 `approve` 一次，批准的是**该记录的精确三元组**（dev commit / 预期 main commit / 集成验证 ID，批准值由 Runtime 从记录自身复制，调用方不能替换）。`approve` 在 FULL 下返回 `APPROVAL_NOT_REQUIRED`；STRICT 下未批准即 `promote` 返回 `PROMOTION_NOT_APPROVED`。
- **批准失效 = CAS 语义**：每次 `promote` 都重新读取 `dev` 与 `main` ref，并重新校验集成证据。`dev` 移动 → `STALE/DEV_REF_MOVED`；`main` 移动 → `STALE/MAIN_REF_MOVED`；`main` 已等于候选 → `STALE/PROMOTION_NOTHING_TO_PROMOTE`；证据不再 PASSED → `PROMOTION_EVIDENCE_MISMATCH`。`STALE` 是终态：必须在新的 dev/main 事实上重建候选并重新批准。FULL 下同一事实移动同样终态化该记录（拒绝语义一致，只是没有「批准」这层含义）。
- 权限模式按**发起时的当前模式**判定（ADR-0011 的 `FULL|STRICT` 开关），并把实际生效模式写入提升记录（`permission_mode`），符合 `PROJECT_SPEC.md` §2.14「提升记录绑定权限模式」。

### D04：`main` 已被检出时的提升方式

- 提升要求 `refs/heads/main` **被某一个工作树检出**（`git worktree list` 证据）；没有任何工作树检出时拒绝（`MAIN_WORKTREE_MISSING`）——既不 `update-ref`，也不在没有稳定工作树的地方假装完成了重启。
- 推进方式是在该工作树内 `git merge --ff-only <固定候选 OID>`：ref、index 与工作文件同时前进。
  - **禁止对已检出的 `main` 使用 `git update-ref`**（会留下 ref 前进而 index/工作树停在旧提交的不一致状态）。实现中不存在任何写 `main` 的 `update-ref` 路径。
  - 使用**固定 OID** 而不是 `dev` 分支名作为合并目标：调用方已核对过该 commit，期间移动过的 `dev` 永远不会成为落到 `main` 的东西。
- 合并前要求：工作树确实检出 `refs/heads/main`、HEAD 精确等于预期 main commit、且**没有已修改的 tracked 文件**（`MAIN_WORKTREE_DIRTY`）。未跟踪文件只作为证据报告，不阻止提升。合并后重新读取 `refs/heads/main`，必须等于固定候选；「git 说成功了」不算 ref 移动的证据（`MAIN_REF_MOVED`/`MAIN_UPDATE_FAILED`）。
- 提升记录在写 Git 之前先落 `main_worktree_path`、重启步骤计划与 `promoting_boot_id`（状态 `PROMOTING`），因此中断一定可从 ref 事实判定。

### D05：后置重启序列（ADR-0009 D03 的自动化形态）

- 固定序列，记录在提升记录里，在 main 工作树中按序执行：
  1. `bun install --frozen-lockfile`
  2. `bun run build:ui`
  3. `bun run codeestra stop`
  4. `bun run codeestra status`
- **执行者是 CLI 客户端**（用户选定）：`promotion.promote` 只做核对 + fast-forward + 记为 `RESTARTING` 并返回计划；随后由发起命令的客户端进程按记录顺序执行各步（它在 `stop` 后仍然存活），再用 `promotion.restart.record` 记账。Runtime 不在响应前自杀，命令面始终能拿到响应。
  代价：后置序列依赖客户端进程存活；客户端中途被杀时不会重跑（见 D06 的 reconcile 与 `promotion promote` 续跑）。
- 失败即停止：某一步退出码非 0 时，后续步骤记为「未运行」（`exitCode: null`）并如实提交，不当成通过。每步记录退出码、耗时与 stdout/stderr 的字节数与 SHA-256 摘要（**不记录原始输出**，避免把构建日志或任何凭据写入数据库）。
- **成功判定**：所有步骤退出码 0 **且** 记账时 Runtime 回答 `status: READY` **且** 记账时的 boot 身份与推动 `main` 的 boot 不同。三者缺一即 `FAILED`，分别对应 `RESTART_STEP_FAILED` / `RUNTIME_NOT_READY` / `RUNTIME_NOT_RESTARTED`。
- **boot 身份校验**：`runtime.ping` 返回本进程的 `bootId`；`promotion.restart.record` 要求提交的 `observedBootId` 必须等于**正在处理该请求的 Runtime** 的 boot，且不等于推动 `main` 的那个 boot。这样「Runtime 真的重启过」是 Runtime 自己核对的事实，而不是相信客户端的陈述；`stop` 没生效（同一个 boot）会被识破。
- **`uiRunning` 只作为观察到的事实记录**，不是成功条件（用户选定 3(a)）：Web UI 是按需启动的便利前端（ADR-0007/0008），把它变成必要条件会让便利前端成为稳定提升的前置条件。`AGENTS.md` 给 Agent 的人工规程（含用 `codeestra ui` 给用户链接）不变：本 ADR 只规定**产品能力自身的**判定标准。序列中不含 `codeestra ui`，因此任何 UI token 都不会出现在提升输出、记录或事件里。
- 失败时**不回滚**：`main` 已经移动就保持移动，记录写明「main 已是候选、重启未由 Codeestra 完成」，并立即报告（符合 ADR-0009「不擅自回滚」）。

### D06：失败、并发与崩溃恢复

- 任何前置失败（证据不符、ref 移动、工作树脏、非 fast-forward、无工作树）都不写入任何 ref，且不创建提升记录（`prepare`）或把记录置为终态（`promote`）。
- **并发**：同一项目同时只允许一个未终结的提升（部分唯一索引 + 表内显式检查）。第二个尝试被拒（`INVALID_STATE`），即使证据完全一致也不会产生第二次 ref 写入或第二个合并。
- **幂等/续跑**：`prepare` 以 `commandId` 记账重放；`promote` 在 `RESTARTING`/`RECOVERY_REQUIRED` 且 `main` 已等于候选时**只重新签发重启计划，不再写 ref**；`restart.record` 对已终结记录直接重放返回。
- **崩溃恢复按 ref 事实**（`reconcileInterruptedPromotions`，启动时运行；不改既有函数）：
  - `PROMOTING` 且 `main` 仍等于预期 main commit → `FAILED/MAIN_NOT_UPDATED`（明确「本次提升没有更新 main」），终态，释放该项目的提升位；
  - `PROMOTING`/`RESTARTING` 且 `main` 已等于候选 → `RECOVERY_REQUIRED/RESTART_UNPROVEN`：**不再第二次写 ref**，写明「ref 已是候选，但重启序列没有被记账」，可用 `promotion promote` 续跑记录中的后置序列；
  - 其他观测值 → `RECOVERY_REQUIRED/MAIN_REF_OBSERVED`，写明观察到的 ref 值，由人显式 `promotion abandon` 解决（**绝不自行回滚或被当成提升成功**）；
  - `RECOVERY_REQUIRED` 期间该项目的提升位保持占用，直到续跑或 abandon。
- **现场保留**：失败/中断只追加状态与证据，不删除记录、不改写历史；`main`/`dev` 的 ref 事实由 Git 保留。
- 事件：`PromotionCreated`、`PromotionApproved`、`PromotionStarted`、`PromotionMainUpdated`、`PromotionRestartRecorded`、`PromotionCompleted`、`PromotionFailed`、`PromotionStale`、`PromotionReconcileRequired`；每个提升另有 `operations.kind='PROMOTE_STABLE_BRANCH'` 的可恢复 Operation。
- **不声称覆盖**「用户在系统外手动更新 `main`」的后台监控：当前没有常驻监控能力，ADR-0009 的该表述不变。

### D07：数据模型（schema v13）

- `stable_promotions`：`dev_ref`/`main_ref`/`candidate_commit`/`expected_main_commit`/`integration_batch_id`/`verification_id`/`verification_tested_commit`/`permission_mode`/`state`/批准三元组/`promoted_commit`/`main_worktree_path`/`promoting_boot_id`/`restart_steps_json`/`restart_result_json`/`outcome_code`/`detail`/`created_at`/`completed_at`，附状态机 CHECK 与「SUCCEEDED 必须有 `promoted_commit`」CHECK；`UNIQUE(project_id) WHERE state IN (未终结集合)` 保证单提升位。
- `stable_promotion_members(promotion_id, task_id, ...)`：固定并追溯该提升包含的 revision（外键到 `task_revisions`/`executions`）。
- 状态集合：`CREATED → AWAITING_APPROVAL（仅 STRICT）→ PROMOTING → RESTARTING → SUCCEEDED`，另有终态 `STALE`/`FAILED` 与可续跑的 `RECOVERY_REQUIRED`。
  **与 `docs/architecture/state-machines.md` §4 的差异必须显式记录**：该文档的 `StableBranchPromotion` 段含 `VERIFYING`；本实现不进入 `VERIFYING`，因为提升消费的是**已经存在**的独立集成验证（ADR-0018），不重新运行验证器。该文档更新留给合并到 `dev` 的集成者（本格文件领地不含该文档）。
- schema v13 由本格独占；v11（Operation 进度）与 v12（回收账本）两段迁移保持原位、不移动。

## Consequences

- 常态确认成本：FULL **0 步 0 等待**；STRICT 仍是**一次**批准（ADR-0008 D01 的预算），批准随 ref/证据移动失效，不产生第二道确认。
- 收益：`AGENTS.md` 里的人工提升规程有了可脚本化、可审计、失败不动 ref 的产品入口；「已验证 dev commit」「预期 main OID」「证据」「重启结果」「权限模式」被同一条记录绑定（`PROJECT_SPEC.md` §2.14）；batch 成员 revision 可追溯（§2.12/Phase 4 验收）。
- 代价与限制（必须显式跟踪）：
  1. 提升要求 `main` 被某个工作树检出（本机稳定工作树满足），且工作树干净；`main` 未检出时没有提升路径（这是刻意的：没有稳定工作树就无法完成 ADR-0009 的重启）。
  2. 固定序列假定 main 工作树是**本仓库的 bun 检出**（存在 `build:ui` 与 `codeestra` 脚本）；对其他形态的项目该序列会失败并被如实记录（`RESTART_STEP_FAILED`），`main` 保持已更新。
  3. 一个提升只对应一个 IntegrationBatch；多批次合并提升、批次级 `STALE`/取消仍属后续阶段。
  4. 不 push、不触碰 `origin/main`；不做任何回滚。
  5. `RECOVERY_REQUIRED`/`FAILED` 的现场（记录、事件、ref 事实）没有自动回收策略，属既有「资源回收」范围（ADR-0021 只管 worktree/副本，不管提升记录）。
  6. 客户端进程若在 `stop` 与 `restart.record` 之间被杀，重启结果不会被写入，只能由 `promotion promote` 续跑或人工确认——不引入后台监督进程是本轮的有意取舍。
  7. Runtime 无法在记账时独立重放 `install`/`build`（只能记录退出码与摘要）；这是「信任本机客户端」的既有边界（与 hooks/验证命令同类）。

## Verification

实际运行（全部在临时 Git 仓库 + 临时 `CODEESTRA_HOME`；未提升真实 `main`、未重启稳定 Runtime、未 push）：

- `bun run check:fast` 退出码 0：根/UI typecheck + Vitest 212 项 + Bun 单测 194 项。
- `bun run check` 退出码 0：另有 `bun run test:storage` 332 项（`test:unit` 194 + `test:e2e` 138，分层之和与总数一致）与 `bun run build:ui`。
- 新增 `packages/git/test/promotion.test.ts`（6 项）：检出 `main` 的工作树定位、未检出分支返回 null、非分支 ref 拒绝；工作树检查（干净/脏 tracked/分支不符/HEAD 不符）；`merge --ff-only` 使 ref+HEAD+index+工作文件同时前进；已提升状态幂等；脏工作树拒绝且本地改动保留、ref 不动；非后代候选拒绝且 ref 不动。
- 新增 `apps/runtime/test/promotion-service.test.ts`（21 项）：v12 → v13 additive 升级 + 表存在 + 非法状态被 CHECK 拒绝；`prepare` 固定三元组与成员 revision 且不写 Git、同 `commandId` 重放；拒绝非批次集成结果、缩写 OID、main 不符/已等于候选、批次未 INTEGRATED、集成验证未 PASSED、main 工作树脏、`main` 未检出；FULL 下 `promote` fast-forward 并记录 ADR-0009 的 4 步计划（cwd = main 工作树）；只有「不同 boot + READY + 全部退出码 0」才 `SUCCEEDED`；同一 boot → `RUNTIME_NOT_RESTARTED`（且记录如实写明 `promoted_commit`）；`observedBootId` 非当前 Runtime → `RUNTIME_NOT_OBSERVED`；步骤列表被替换/截断 → `RESTART_PLAN_MISMATCH`；某步非 0 → `RESTART_STEP_FAILED` 且 main 不回滚；`STARTING` → `RUNTIME_NOT_READY`；不重复提升且单项目单提升位；STRICT 未批准拒绝、FULL 拒绝 `approve`、批准后成功；dev 移动 / main 移动使批准失效为 `STALE` 且 ref 未动；崩溃 reconcile：`PROMOTING` 未更新 → `FAILED/MAIN_NOT_UPDATED` 且释放提升位、已更新 → `RECOVERY_REQUIRED/RESTART_UNPROVEN` 且续跑不二次写 ref、外来 ref → `RECOVERY_REQUIRED/MAIN_REF_OBSERVED` + `promotion promote` 拒绝 + `abandon` 后提升位释放。
- 新增 `apps/runtime/test/cli-promotion.test.ts`（4 项，真实 CLI + 真实 Runtime + 协议 stub provider + 临时仓库）：完整 `create → submit → run → result capture → verify → integrate → promotion prepare → promotion promote`，断言 `main` 前移到成果 commit、`dev` 不变、工作树干净且文件已更新、重启计划四步真实执行且退出码全 0（含真实 `bun install --frozen-lockfile`、`bun run build:ui`、`bun run codeestra stop`、`bun run codeestra status`，Runtime 真的被停掉并由 `status` 拉起）、`restart.runtimeStatus=READY`、`uiRunning=false` 被记录、`promotion get/list` 一致；后置步骤失败（`build:ui` 退出 1）→ 退出码 1、`FAILED/RESTART_STEP_FAILED`、后续步骤记为未运行、`main` 保持已提升不回滚、Runtime 仍可响应、终态记录拒绝 `abandon`；STRICT 下 `promotion promote` 未批准退出码 1（`PROMOTION_NOT_APPROVED`）、`promotion approve` → `AWAITING_APPROVAL`、`abandon` → `FAILED/ABANDONED` 且 `main` 未动；证据不符（错误 main OID / 错误 dev commit）退出码 1 且不建记录、不动 ref。
- 因 schema v13 顺带修正的跨格断言：`apps/runtime/test/cli-reclaim.test.ts` 的迁移用例把硬编码 `12` 改为 `phase1SchemaVersion`（1 行，见交付说明；该文件不在本格领地）。
- 未执行或**无法在本格验证**（明确不声称通过）：
  1. **真实 `main` 的提升与真实稳定 Runtime 的重启**（本格绝对禁止）：因此「在 `/Users/loyage/Documents/codeestra` 执行 install/build:ui/stop/status 并返回 `READY`」这一条只有临时仓库 + 临时 `CODEESTRA_HOME` 级别的证据，没有真实稳定服务的证据。
  2. 真实 provider（非 stub）驱动的提升；提升的正确性不依赖 provider，但完整链路只有 stub 证据。
  3. 多成员批次/多任务一次提升；跨项目并发提升压力测试。
  4. `push`、`origin/main`、以及「用户在系统外手动更新 `main`」的监控（未实现，也不声称）。
  5. `apps/ui/**` 的提升投影（本轮明确留后续）。
  6. `docs/architecture/state-machines.md` §4 的 `VERIFYING` 差异尚未回写该文档（本格无该文件领地）。
  7. 运行中发现并**未修复**的既有缺陷：`codeestra stop` 之后 Runtime 进程有时不退出（socket 已关闭、`rmSync(socketPath)` 已发生、storage 已关闭，但进程仍存活并被 reparent 到 init），使多次测试/重启后累积不可达的孤儿 Runtime 进程。复现与证据见 `docs/tasks/README.md` FOUNDATION-042「剩余问题」。该缺陷位于 `apps/runtime/src/main.ts` 的 `shutdown()`/启动路径，不属于本格领地，且其他并行格（b2 工作树）出现同样的进程签名。

## Related

- `PROJECT_SPEC.md` §1.1、§2.12/§2.14、§5、§6
- `AGENTS.md`（分支与发布工作流、重启 main 稳定服务）
- ADR-0008 D01/D03（一次确认预算、CLI 完备）、ADR-0011（FULL 零确认 / STRICT opt-in）
- ADR-0009 D02/D03（本 ADR 的实现形态）、ADR-0018（被复用的 IntegrationBatch/独立集成验证事实模型与 reconcile 风格）
- ADR-0007（UI 是按需前端）、ADR-0021（回收范围，不含提升记录）
- `docs/architecture/state-machines.md` §4、`docs/roadmap/mvp.md` Phase 4
- `docs/tasks/README.md` FOUNDATION-042
