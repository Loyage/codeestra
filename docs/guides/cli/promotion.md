# CLI 参考 · promotion（稳定提升）

> **适用版本** `dev@de03448`（2026-09-16） · **schema** v34 · **最后校对** 2026-09-16
> 版本会前进：`dev@de03448` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一，
> **内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码**，最后校对日期因此不变。
> 本文件覆盖 §15；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。

## 15. `promotion`（稳定提升）

```sh
bun run codeestra promotion full-suite run  <project-id> --dev-commit <full-sha> [--json]
bun run codeestra promotion full-suite list <project-id> [--limit <n>] [--json]

bun run codeestra promotion prepare <project-id> <batch-id> <expected-dev-commit> <expected-main-commit>
bun run codeestra promotion approve <project-id> <promotion-id>
bun run codeestra promotion promote <project-id> <promotion-id> [--json]
bun run codeestra promotion abandon <project-id> <promotion-id> --reason <text>
bun run codeestra promotion get  <project-id> <promotion-id>
bun run codeestra promotion list <project-id> [--limit <n>]
```

### `full-suite`（dev 全量证据，ADR-0038 D03 / ADR-0039）

- `run` 对**精确那个 dev SHA** 在 detached 副本中运行项目 `main` ref 的固定策略。
  **Runtime 运行并观察**结果：客户端**不能提交**一个自报的结果。
- 证据绑定：**候选 commit**、该策略的 **digest**、**候选 commit 上的锁文件 digest**。
- 缺 `--dev-commit` → 退出码 **2**（stderr 说明它必须指名一个精确 dev SHA）。
- `run` 退出码 `0` 仅当 `state === "PASSED"`。
- `list` 的 `--limit` 默认 20（上限 200）。

### `prepare / approve / promote / abandon`（ADR-0047：唯一提升路径经 GitHub 中转）

- `prepare` 固定「已验证的 dev commit / 预期旧 main commit / 该 commit 的集成验证与 dev 全量证据」，并固定**推送用的 dev
  clone**（`projects.dev_repo_path`；未记录或无法核验时以 `DEV_REPO_PATH_MISSING` / `DEV_REPO_*` 拒绝）。
  该路径的这条拒绝沿用它原有的 `DEV_REPO_PATH_MISSING`（FOUNDATION-077），与「开发基线操作」用的 `DEV_REPO_REQUIRED`
  （ADR-0056）是**两条不同的命令面**，都指向同一条补救命令 `project trust <repo> --dev-repo <dev-clone>`。
  全量证据的**副本与锁文件从 dev clone 读**，**策略仍从 main ref 读**（ADR-0039 + ADR-0056）。
  **不写任何 Git，也不写远端**。远端 `dev` 已经移到非候选 SHA 时拒绝（`REMOTE_DEV_MOVED`，`STALE`）。
- 集成证据是**批次级**的（ADR-0053）：`<batch-id>` 可以是一个多成员批次，`prepare` 会把该批次的
  **全部成员**（`taskId`/`revisionId`/`candidateCommit`）固定进提升记录（输出里的 `members[]`），
  并要求该批次的独立集成验证 `PASSED` 且绑定到它的 merge commit 与固定 `dev` 基线。
  批次未 `INTEGRATED`、`integratedCommit` 不等于传入的 dev SHA、或成员清单与批次记录不符时以
  `BATCH_NOT_INTEGRATED` / `PROMOTION_EVIDENCE_MISMATCH` 拒绝；**多成员不改变任何提升门禁**。
- `approve` **仅 STRICT 需要**；它针对**那一组精确三元组**，dev/main/证据/远端 `dev` 任一移动即失效。
- `promote` 一次只推进**一步**，且每一步都要读回事实：

  1. **push 固定候选到远端 `dev`**（源是候选 OID，不是分支名；从不 `--force`），然后 `git ls-remote` **读回核对**。
     push 退 0 但读回不等 → `REMOTE_DEV_READBACK_MISMATCH`，**不记**已推送；push 被拒或远端不可达 → `DEV_PUSH_REFUSED`
     / `REMOTE_DEV_UNREACHABLE`，记录保持可重试（**不**标 `STALE`），因为记录本身仍然正确。
  2. main 检出尚未拉取 → 报**「已推送、等待拉取」**（`state: PROMOTING`，`phase: AWAITING_PULL`），**退出码 3**，
     **不执行也不记录任何重启步骤**。CLI 在 stderr 打印用户在 main 检出要执行的两条命令：
     `git fetch origin && git merge --ff-only origin/dev`。
     **Web UI 投影同一组只读事实**（`promotion.list` / `promotion.get`，不发任何命令）：`phase`、读回的
     `origin/dev` / `origin/main` SHA，并在这一阶段直接列出上面那两条命令；它**不把该状态显示成已提升或已完成**。
  3. 用户拉取后再次调用同一命令：核对 main 检出确实在候选上、且该候选是 expected main 的后代（fast-forward 而非
     merge/reset），记录重启计划，然后在 main 检出依次执行：

     ```text
     bun install --frozen-lockfile
     bun run build:ui
     bun run codeestra stop
     bun run codeestra status
     ```

     每个后置步骤的输出会打到 stderr（stdout 保持为机器可读记录），证据只记录**摘要与字节数**，不记录文本。
     **重启只在每一步退 0、重启后的 Runtime 回答 `READY`、且应答的 boot 与发出计划的 boot 不同时才被记录。**
  4. 重启记录成功**之后**才把候选 push 回远端 `main` 并读回核对，然后 `SUCCEEDED`。推回失败 → `MAIN_PUSH_REFUSED`
     /`REMOTE_MAIN_READBACK_MISMATCH`，记录保持 `RESTARTING`（`phase: MAIN_PUSH_PENDING`），再次调用**只重试推回**，
     不会重复停 Runtime。
- `promote` 的退出码：`0` 仅当 `SUCCEEDED`；`1` 拒绝或失败；`2` 用法错误；**`3` 已推送、等待拉取**（与 `SUCCEEDED` 不同，
  且该状态下没有任何重启记账）。后置步骤失败时退 `1`，CLI 明确打印「main 检出已在候选上且未回滚；远端 `main` 未发布」，
  重跑 `promotion promote` 会重跑已记录的后置步骤（推回仍只在重启记录成功后才尝试）。
- `--json` 给出可区分的事实：`phase`（`READY_TO_PUSH` / `AWAITING_PULL` / `RESTART_PENDING` /
  `MAIN_PUSH_PENDING` / `COMPLETE` / `REFUSED`）、`devRepoPath`、`remoteDevCommit`、`remoteMainCommit`、
  `pushedAt`、`mainPushedAt`（读回值，不是输入）。
- `abandon` **必须**给 `--reason`（否则报错）：放弃的 promotion 保留记录与观察到的 ref 状态以便审计（包括已读回的远端
  `dev` SHA）。
- `--limit` 范围 1–200；`promotion list` 默认 20。
- 任何一次调用都**不**用 `update-ref`、**不** ff 已检出的 `main`、**不**推除固定候选之外的 ref、**不**覆盖远端已有提交；
  断网/认证失败/远端不可达一律不推进任何 ref。

稳定码：`DEV_REPO_PATH_MISSING`、`DEV_REPO_PATH_CHANGED`、`DEV_REPO_NOT_A_REPOSITORY`、`DEV_REPO_NOT_SEPARATE`、
`DEV_REPO_ORIGIN_UNKNOWN`、`DEV_REPO_ORIGIN_MISMATCH`、`DEV_REPO_BRANCH_MISMATCH`、`DEV_REPO_DEV_REF_MISSING`、
`DEV_REPO_CANDIDATE_MISSING`、`DEV_REPO_BASE_MISSING`、`DEV_PUSH_REFUSED`、`REMOTE_DEV_UNREACHABLE`、
`REMOTE_DEV_MOVED`、`REMOTE_DEV_READBACK_MISMATCH`、`MAIN_PUSH_REFUSED`、`REMOTE_MAIN_READBACK_MISMATCH`、
`DEV_FULL_SUITE_EVIDENCE_MISSING`、`DEV_FULL_SUITE_EVIDENCE_NOT_PASSED`、
`DEV_FULL_SUITE_EVIDENCE_STALE`、`PROMOTION_EVIDENCE_MISMATCH`、`PROMOTION_NOT_APPROVED`、
`PROMOTION_NOT_FAST_FORWARD`、`PROMOTION_NOTHING_TO_PROMOTE`、`PROMOTION_STALE`、`PROMOTION_STATE_INVALID`、
`PROMOTION_IN_PROGRESS`、`PROMOTION_FINISHED`、`APPROVAL_NOT_REQUIRED`、`BATCH_NOT_INTEGRATED`、
`MAIN_REF_MOVED`、`MAIN_WORKTREE_MISSING`、`MAIN_WORKTREE_DIRTY`、`DEV_REF_MISSING`、
`DEV_REF_MOVED`、`VERIFICATION_NOT_PASSED`、`RESTART_PLAN_MISMATCH`、`RUNTIME_NOT_OBSERVED`、
`RUNTIME_NOT_RESTARTED`、`RUNTIME_NOT_READY`、`RESTART_STEP_FAILED`、`RESTART_UNPROVEN`、
`INVALID_COMMIT_ID`、`REPOSITORY_CHANGED`、`(UNBORN_MAIN)`。

事件名：`PromotionCreated`、`PromotionApproved`、`PromotionDevPushed`、`PromotionPushRefused`、
`PromotionMainUpdated`、`PromotionRestartRecorded`、`PromotionMainPushRefused`、`PromotionCompleted`、
`PromotionFailed`、`PromotionStale`、`PromotionReconcileRequired`（旧的 `PromotionStarted` 随本机 ff 路径一起删除）。

> `promotion.restart.record` 是 CLI 在重启后调用的命令面成员：它把「刚刚应答 `runtime.ping` 的那个 boot」
  连同各步骤结果一起记录，Runtime 会核对**正在应答这次记录调用的 boot 与它相同**——所以一个**从未被停止过**
  的 Runtime 不可能被报告成「已重启」。

---

