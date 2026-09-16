# ADR-0064：删除 dev clone、双基线、dev 集成与稳定提升；Task 基线只有一种

Status：Accepted（用户 2026-09-16 决策）。**已实现**（schema **v35**）。**Supersedes / Amends**
ADR-0009（双分支与提升）、ADR-0018（集成进 dev）、ADR-0022（提升为产品能力）、ADR-0038/0039
（提升前全量证据）、ADR-0047/0052（经 GitHub 中转的提升）、ADR-0048（dev clone 与独立 Runtime
home 的产品语义部分）、ADR-0049（dev 构建通道）、ADR-0053（多成员 IntegrationBatch）、
ADR-0056（dev 事实来源）、ADR-0060（两种基线）。

## Context

ADR-0060 把「被管理项目的 Task 基线取项目文件夹当前检出的分支」作为**两种基线之一**引入：
记了 dev clone 的项目取该 clone 的 `dev`，没记的取自己的文件夹。用户 2026-09-16 判定这个二分
本身没有价值：

> 有关 dev 不 dev 的部分都删了……「开发基线有两种」这个没用，不要这个功能，只有一种开发基线，
> 打开的项目是什么分支就从什么分支开始开发。

用户就实现方式作出的选择（本轮 A/B/C 选择题，逐项均为用户选定项）：

| 问题 | 用户选择 |
|---|---|
| 改动范围 | **文档 + 实现代码一起删** |
| 「只有一种开发基线」的语义 | **彻底删除 dev clone 概念**：不再有 `dev_repo_path`、dev 基线、dev 集成分支；成果留 task 分支由用户自己合；`main`/`dev` 双分支只作 Codeestra 自身仓库约定 |
| ADR-0049 的 dev 构建通道 | **也一起删** |
| schema 迁移（v35） | **直接 DROP 列和表**（不可逆） |
| `task integrate` 与 `promotion *` | **直接删除这几个命令** |
| 没有 dev 集成后 DAG 依赖按什么判定 | **上游 commit 对项目当前基线分支可达才释放** |

## Options

1. 基线条数：保留 ADR-0060 的两种基线 / **只保留一种**（项目文件夹当前检出的分支）。
2. dev clone 的去留：保留但不再作基线来源 / **彻底删除**（含集成与提升的产品面）。
3. schema：保留结构停用 / **直接 DROP**（不可逆）。
4. 命令面：保留但一律拒绝 / **直接删除**。
5. 依赖判定：上游验证通过即释放 / **上游 commit 对当前基线可达才释放**。

## Decision

### D01 只有一种开发基线

- Task worktree 一律从**项目文件夹**（`projects.repo_root`）**建 workspace 时当前检出的分支**建基线：
  符号引用（`refs/heads/<branch>`）与它的 commit 一起固定进 `workspaces.base_ref` / `base_commit`。
  之后用户在那个目录里切分支**不会**改变已建 Task 的基线。
- 不推断、不猜测：`HEAD` detached 时以稳定码 `TASK_BASE_REF_UNRESOLVED` 拒绝并说明补救方式。
- 显式覆盖 `task run --base-ref <ref>`（必须是项目文件夹里存在的本地分支）保持有效，仍是 Task 级、
  不写回项目。已有 workspace 的 Task 以 `TASK_BASE_REF_ALREADY_FIXED` 拒绝而非忽略。
- `resolveTaskBaselineRepository` 只有一个分支：不再有 `DEV_CLONE` / `PROJECT_FOLDER` 模式字段，也不再有
  `devRepoPath` / `inspection` 返回字段（`apps/runtime/src/task-baseline-service.ts` 取代
  `dev-repo-service.ts` 的基线职责）。

### D02 dev clone、集成与提升从产品中删除

- `projects.dev_repo_path`、`projects.dev_ref` 与 `stable_promotions` / `stable_promotion_members` /
  `integration_batches` / `integration_batch_items` / `integration_verification_runs` /
  `dev_full_suite_evidence` 全部删除（schema **v35**，不可逆）。
- 随之删除的服务：`dev-repo-service.ts`、`integration-service.ts`、`promotion-service.ts`、
  `promotion-evidence-service.ts`、`packages/git/src/promotion.ts`；`packages/git/src/integration.ts` 只保留
  `isAncestor` / `readLocalRefCommit` / `listCheckedOutRefs`（迁到 `refs.ts`）。
- 删除的命令：`task integrate`、`task.integration.{list,create,integrate,get,cancel}`、
  `promotion.{prepare,approve,promote,restart.record,abandon,get,list}`、
  `promotion.fullSuite.{run,list}`。旧脚本会得到未知命令的用法错误。
- `task status` 不再返回 `integrations`；`task.depends.list` 不再返回 `devRef` / `devCommit`。
- 成果 commit 停在 `refs/heads/task/<task-id>`（ADR-0005/0018 的既有事实），是否合并、何时合并由用户
  自己在自己的分支上完成。Codeestra 不自动合、不自动推、不做提升记账。本仓库自身的 `main`/`dev`
  人工流程（ADR-0047/0048、`AGENTS.md`）是**仓库约定**，不再是产品能力。

### D03 DAG 依赖按「上游结果 commit 对当前基线可达」判定

- 一条依赖边的事实是**上游修订自己的 result commit**（`executions.applied_revision_id = required_revision_id`
  的最新非空 `result_commit`），不再是「已 INTEGRATED 的批次」。
- 该 commit 对项目**当前 Task 基线 ref** 可达才释放下游；否则保持 `BLOCKED`。
- 原因码随语义改名（都是稳定码的有界枚举，旧名不再产生）：
  `UPSTREAM_RESULT_MISSING`、`BASE_REF_MISSING`、`BASE_REF_UNREADABLE`、`NOT_REACHABLE_FROM_BASE`。
- 读不到基线时按未满足阻塞而**不**拒绝命令（ADR-0024 的 fail-closed 口径不变）。依赖判定仍在
  `task submit` / `task run` / `task depends list` 的常态路径上：managed 化之后的项目从第一天就能
  submit/run，这一点 ADR-0060 第三轮修订已经确立，本 ADR 只是把「managed」变成唯一的形状。

### D04 dev 构建通道删除

- `VITE_CODEESTRA_CHANNEL`、`data-channel` 标记、`apps/ui/channel-value.ts`、`apps/ui/src/channel.tsx`、
  `ChannelBanner`、`channelBrandName`、橙色强调样式与 `build:ui:dev` / `just ui-build-dev` 一并删除。
  UI 只有一种构建产物、一个品牌名（`Codeestra`）。
- 与开发基线无关，但属于用户判定要删的「dev 不 dev」面。

### D05 保留不变的东西

- 权限模式（ADR-0011）不变：FULL 零确认，STRICT 保留旧门禁；本 ADR **不新增任何确认或审批**。
- Task verification 与它的隔离副本、`task tests record` / `task verify`、targeted test plan
  （`.codeestra/tests.json`）不变：它们服务任务级验证，与提升无关。
  `devFullSuiteLockfilePath` / `judgeDevFullSuiteEvidence` 随提升一起删除。
- 回收（ADR-0021/0037/0042）不变。`reclamation_records.kind` 的 `INTEGRATION_WORKTREE` 取值**保留**：
  账本是 append-only 审计，历史行不能被改写，删除该取值需要另一次 schema 变更；`reclaim` 不再产生新的
  `INTEGRATION_WORKTREE` 候选（Runtime 不再创建集成工作树），既有目录会落进「未注册目录」通道。
- `task purge` 删除了「成果已进入 dev/main 即拒绝」这一拒绝类（`TASK_INTEGRATED_INTO_DEV` /
  `TASK_IN_STABLE_PROMOTION` 稳定码随之消失）：没有 Runtime 管理的 ref 再承载 Task 的 commit。
  `--force` 仍然存在，越过的只剩「活占用」类拒绝。
- `project inspect` / `project trust` 的 `--dev-repo` 参数删除；`projectIdentitySchema` 收窄为仓库身份本身
  （`repositoryIdentitySchema`）。

## Consequences

- **范围**：这是产品语义的净删除——命令面变短、schema 变短、依赖判定从「集成事实」改为「Git 可达性」。
  Codeestra 自身仍然以 `main`/`dev` 两个 clone 开发（`AGENTS.md`），但那只是本仓库的人工约定，不再有
  产品命令支撑或记账。
- 影响面（实现已逐一核对）：`packages/contracts`（schema 与命令联合）、`packages/storage`（v35 迁移 +
  仓储方法）、`packages/git`（`promotion.ts`/`integration.ts`）、`packages/domain`
  （`verification-evidence.ts` 的提升证据判定）、`apps/runtime`（四个服务 + main/scheduler/workspace/
  reclaim/recovery/purge/impact/result-commit/slot-reservation/schedule）、`apps/cli`、`apps/ui` 与
  `docs/**`（`PROJECT_SPEC.md`、`docs/architecture/**`、`docs/guides/**`）。
- **不可逆**：v35 直接 DROP 列与表，集成/提升的历史记录随之消失。Task、revision、execution、
  任务级 `verification_runs`、`workspaces`、`reclamation_records` 与审计事件不受影响。
- 迁移是**一次**表重建（`projects` 去掉 `dev_ref` / `dev_repo_path`）：`workspaces.base_ref` 先由历史
  `projects.dev_ref` 回填，再重建 `projects`；重建带行数守卫（Bun 的 `exec()` 会吞掉脚本内的步骤错误，
  没有守卫就会在复制失败后照样 DROP）。

## Verification

本格必须逐条断言（CLI/命令面驱动，不用浏览器自动化）：

1. schema v35 迁移：`projects` 不再有 `dev_ref` / `dev_repo_path`，六张集成/提升表不存在，
   `workspaces.base_ref` 已由历史 `projects.dev_ref` 回填，行数不变，`PRAGMA foreign_key_check` 为空。
2. 没有 dev clone 的仓库（连 `dev` 分支都没有）能 trust → create → submit → run → verify 全流程成立。
3. Task 基线 = 项目文件夹当时检出的分支：worktree 的 `base_ref` / `base_commit` 等于该目录当时的
   `HEAD` 与分支；解析后切分支不改变已建 Task 的基线。
4. `HEAD` detached：`TASK_BASE_REF_UNRESOLVED` 拒绝，不留下 workspace 行、不建 worktree。
5. `--base-ref <ref>` 覆盖成立，不存在的 ref 以稳定码拒绝。
6. 依赖判定：上游有 result commit 且对当前基线可达 → 释放；不可达 → `NOT_REACHABLE_FROM_BASE`；
   没有 result commit → `UPSTREAM_RESULT_MISSING`；基线读不到 → `BASE_REF_MISSING`。
7. 命令面：`task integrate`、`task integration *`、`promotion *` 不存在；`--dev-repo` 不再是
   `project inspect` / `project trust` / `open` 的参数。
8. 回收：Task worktree 与验证副本仍按项目文件夹归属核验与回收；不再产生 `INTEGRATION_WORKTREE` 候选，
   历史账本行仍可读。

## Related

- `PROJECT_SPEC.md` §2、§3、§5
- `AGENTS.md`（本机检出布局与人工发布流程；本仓库自身的 `main`/`dev` 约定不受本 ADR 影响）
- ADR-0005（worktree 位置与归属）、ADR-0021/0037/0042（回收）、ADR-0024（依赖与 `BLOCKED`）
- ADR-0011（权限模式，不变）、ADR-0038/0039（开发分支定向测试的**产品**部分随提升删除；本仓库自身的
  测试纪律仍在 `AGENTS.md`）
- `docs/architecture/git-workspace-api.md`、`docs/architecture/sqlite-schema.md`（schema v35）
