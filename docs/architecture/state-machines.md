# 状态机与迁移规则

状态：Phase 0/1 基线；Integration/Self 为后续阶段合约。未列出的迁移拒绝；所有迁移需 expected aggregateVersion、actor、reason，并在事务中记录事实事件。恢复操作不绕过 guard。

## 1. Task lifecycle

状态：`DRAFT, BLOCKED, READY, RUNNING, PAUSING, PAUSED, WAITING_FOR_USER, RECOVERY_REQUIRED, EXECUTED, FAILED, CANCELLING, CANCELLED, SUCCEEDED`。

| 源 | 触发 | Guard / 目标 |
|---|---|---|
| DRAFT | submit | 规格有效；依赖未满足→BLOCKED，否则 READY |
| BLOCKED | dependencies satisfied | 上游指定结果已入 dev 且当前 dev 基线可达→READY |
| READY | dependency invalidated | →BLOCKED |
| READY | schedule | 当前 revision、依赖、冲突、容量、workspace 预留均通过→RUNNING（含 Execution 准备过程） |
| RUNNING | agent needs input | 真实 AttentionRequest 已建立→WAITING_FOR_USER |
| WAITING_FOR_USER | answer accepted / agent active | 所有当前阻塞问题关闭，无待应用 revision→RUNNING |
| RUNNING / WAITING_FOR_USER | revision added | 保存 revision、验证失效、请求停止写入→PAUSING |
| PAUSING | quiescence confirmed | 无工具/子进程继续写入的可靠证据→PAUSED |
| PAUSED | revision acknowledged / resume | 当前 revision 已应用且冲突重新核验→RUNNING |
| PAUSING / PAUSED | cannot safely resume | 旧 Execution 已终止才可→READY（新尝试）；不能确认退出→RECOVERY_REQUIRED |
| RUNNING | execution result captured | 当前 applied revision 匹配且产出 commit 固定→EXECUTED |
| RUNNING / PAUSING / PAUSED / WAITING_FOR_USER | execution failed | 明确失败且进程已静止→FAILED |
| RUNNING / PAUSING / PAUSED / WAITING_FOR_USER / CANCELLING | ownership/liveness uncertain | 保持资源隔离→RECOVERY_REQUIRED |
| FAILED | user retry | 旧执行静止、依赖重验→READY 或 BLOCKED |
| EXECUTED | revision added | 失效旧证据和未提升批次；旧执行静止→READY 或 BLOCKED |
| EXECUTED | integrated to dev | 当前 revision 的固定候选经独立集成验证成功进入 dev→SUCCEEDED |
| DRAFT / BLOCKED / READY / EXECUTED / FAILED | cancel | 没有活动写入或正在提升的竞争操作→CANCELLED |
| RUNNING / PAUSING / PAUSED / WAITING_FOR_USER | cancel | →CANCELLING，协作中断 |
| CANCELLING | confirmed stopped | →CANCELLED，保留 workspace |
| RECOVERY_REQUIRED | reconcile | 依据真实事实回到已证实状态；必须审计，不能直接释放资源 |

READY 的等待原因单独派生为 CONFLICT / CAPACITY / DRAINING / REVISION_REVIEW 等，不误用 BLOCKED。依赖未满足是 BLOCKED 唯一含义。SUCCEEDED/CANCELLED 不自动重开。

Task Verification：`NOT_RUN → QUEUED → RUNNING → PASSED | FAILED | ERROR`；revision/commit/策略失效产生 `STALE`。重验创建新 VerificationRun，旧证据不改写。

Phase 1 判定（ADR-0006）：全部命令 exit 0 且副本 tracked 内容未变→`PASSED`；命令非零退出或无法 spawn→`FAILED/COMMAND_FAILED`（不继续后续命令）；超时→`ERROR/COMMAND_TIMEOUT`；tracked 修改或 HEAD 移动→`ERROR/TREE_MUTATED`（不覆盖已判定的 `FAILED`）；副本无法创建→`ERROR/WORKTREE_FAILED`；Runtime 重启→`ERROR/RUNTIME_RESTARTED` 并保留副本路径。终态一旦写入，重放 completion 不改变结论。Task 自身状态不因验证而变成 SUCCEEDED：`PASSED` 只是当前 revision/commit 的 Task scope 证据，仍须经 IntegrationBatch 进入 `dev`。

Task Integration summary：`NOT_READY → ELIGIBLE → BATCHED → INTEGRATED`；失败/修订产生 `NEEDS_ATTENTION / STALE`。这些是查询投影，不是替代 Batch 的权威状态。

Task worktree 基线（ADR-0009/ADR-0018）：新 Task 的 workspace 从 `projects.dev_ref`（默认 `refs/heads/dev`）的当前 OID 建立；仓库没有 `dev` 时 `project.trust` 以 `DEV_REF_MISSING` 拒绝，不静默回退到其他分支。已有 workspace 不回改基线。

## 2. Execution

状态：`CREATED, PREPARING, STARTING, RUNNING, WAITING_FOR_USER, PAUSING, PAUSED, STOPPING, RECOVERY_REQUIRED, SUCCEEDED, FAILED, CANCELLED, SUPERSEDED`。

| 迁移 | 条件 |
|---|---|
| CREATED→PREPARING→STARTING | 已预留执行权；Git 资源准备并核验后才启动 Agent |
| STARTING→RUNNING | 收到可信 session started 事件并保存身份 |
| RUNNING→WAITING_FOR_USER→RUNNING | 建立问题；真实回答被接受并确认继续 |
| RUNNING/WAITING_FOR_USER→PAUSING→PAUSED | 先请求暂停，再确认 quiescence；普通输出停止不算暂停 |
| PAUSED→RUNNING | 最新 revision ACK、冲突安全、实际恢复确认 |
| 非终态→STOPPING | 用户取消或修订需重启；保存 stopReason |
| STOPPING→CANCELLED | USER_CANCEL 且所有归属进程已静止 |
| STOPPING→SUPERSEDED | REVISION_RESTART 且所有归属进程已静止 |
| RUNNING→SUCCEEDED | Agent 正常完成、工具静止、产出 commit 捕获；不代表验证通过 |
| 准备/启动/运行等→FAILED | 可证明无残留写入，保存错误；否则 RECOVERY_REQUIRED |
| 非终态→RECOVERY_REQUIRED | 失联、控制超时或身份未知；占用不释放 |

终态不可被后来迟到的 Agent 事件改回 RUNNING。新尝试新 ID；重启恢复同一已存活 session 不创建重复 execution。

成果 commit 采两步门禁：prepare 只读快照并落一次性授权（绑定 execution/revision/workspace ownership/expected HEAD/ChangeSet fingerprint/身份），confirm 重验后才 `git add`/`commit`；确认是单次能力，HEAD 或差异变化使其失效。消费后 Execution→SUCCEEDED 且 workspace IN_USE→RETAINED（保留供验证），Task 只到 EXECUTED。commit 已生成但回写失败时按 HEAD/OID 补记，不重跑 hook、不重写历史。

## 3. AgentSession / Takeover

单个 process incarnation：`CREATED → STARTING → ACTIVE`；ACTIVE↔WAITING_FOR_USER；ACTIVE/WAITING_FOR_USER→PAUSING→PAUSED→ACTIVE；活动态→STOPPING→EXITED；控制连接丢失或 Runtime 自行释放其自有 provider 进程→DISCONNECTED；身份或恢复失败→RECOVERY_REQUIRED。

DISCONNECTED→ACTIVE/WAITING_FOR_USER/PAUSED 需 reconcile 证明真实状态。Runtime 自行发起的释放不伪造成 provider event，而以 Runtime 来源记录并保留 Execution/workspace 占用。EXITED 不代表 Task 成功，需 exit reason、执行结果与验证。客户端 detach 不改变 AgentSession 状态。provider resume 创建新 OS 进程时必须建立 successor AgentSession 并关联 predecessor；即使 provider conversation ID 相同，也不伪装旧 OS 进程仍存活。

TakeoverRequest：

```text
REQUESTED
  → WAITING_FOR_ATTENTION | WAITING_FOR_SAFE_POINT
  → STOPPING_SOURCE → STARTING_TARGET → ACTIVE
  → RETURN_REQUESTED → STOPPING_SOURCE → STARTING_TARGET → COMPLETED
```

- RPC→TUI 与 TUI→RPC 都使用同一交接骨架；target mode 分别为 `HUMAN_TUI` 与 `AUTOMATED_RPC`。
- 工具或模型轮次活动时停在 `WAITING_FOR_SAFE_POINT`，不为接管 abort；Attention 正阻塞工具时显示 `WAITING_FOR_ATTENTION`。Pi 建立 handoff fence：当前 assistant turn 已开始的工具继续到结束，此后新工具调用由 gate 以 terminating result 收束，直至 `agent_settled`。
- 请求已提交且随后收到可信 `agent_settled`（无 retry/compaction retry/queued continuation）且活动工具计数为 0 时，该 settled 被消费为 handoff safe point，不同时产生 Execution completion。若 completion 事务先提交，请求以 `EXECUTION_NOT_ACTIVE` 失败。
- STOPPING_SOURCE 只有在 process identity 匹配且确认退出后才能进入 STARTING_TARGET。退出不确定→RECOVERY_REQUIRED，并禁止启动 target。
- STARTING_TARGET 复核 workspace、provider conversation/session file 与受控启动参数；失败且可证实无 target 进程→FAILED，否则 RECOVERY_REQUIRED。
- HUMAN_TUI ACTIVE 时 detach 只移除 attachment；Session 继续 ACTIVE。显式 release 才进入 RETURN_REQUESTED。
- TUI→RPC 完成后 Runtime 投递固定 continuation guidance，随后 Execution 回到自动控制；交接本身不改变 TaskRevision。

TerminalAttachment：多个 `READ_ONLY` 可并存；最多一个 `WRITER` lease。断开→DETACHED 只释放 attachment/lease，不停止 Session；竞争 writer 返回 `ATTACHMENT_BUSY`。PTY 输出和按键不驱动领域状态迁移。

原生审批回答中 reject/deny 也属于有效回答，不能把“用户已回答”等同“用户批准”。TUI gate 与 Runtime Attention 并发收到答案时只允许一份从 OPEN 变为已决，迟到答案不得再次驱动工具。

## 4. IntegrationBatch / StableBranchPromotion

实现状态（ADR-0018）：**已实现单成员合入**（`task.integrate` / `task.integration.list`，CLI + 同一命令面 + UI）。已实现的状态为 `CREATED → PREPARING → VERIFYING → INTEGRATING_DEV → INTEGRATED`，另有 `CONFLICTED / FAILED / RECOVERY_REQUIRED`；多成员批次、`STALE`、`CANCELLED` 与 `StableBranchPromotion` 段仍属后续阶段合约。

- CREATED：固定 `dev` 基线 OID、候选 result commit、revision 与 execution，并确认该 revision+commit 的 Task 验证为 `PASSED`；DEV_REF_MISSING / DEV_REF_CHECKED_OUT / TASK_VERIFICATION_NOT_PASSED 在写入任何 Git 副作用前拒绝。
- PREPARING：在 Runtime 数据目录的 detached integration worktree 中合并固定候选；能 ff 就 `--ff-only`，否则 `--no-ff`（第一父为固定基线，候选必须是其后代）；冲突→CONFLICTED，其他错误→FAILED。合并产生的提交写入 `merged_commit`，此时 `dev` 仍未被触及。
- VERIFYING：在 `merged_commit` 的 detached 副本上运行独立集成验证（独立实体 `integration_verification_runs`，绑定 candidate/merged commit/固定 dev 基线/policy digest/main commit 与 Task 验证 ID）；失败→FAILED。
- INTEGRATING_DEV：已核验集成验证 PASSED 后记录，随后以 `merged_commit` 与记录基线作 CAS 更新 `dev`。该状态存在的原因是：崩溃可能发生在 ref 写入前后，只有拿记录的 `merged_commit` 与 ref 实际值对比才能判定。
- INTEGRATED：ref 已更新才写入 `integrated_commit`，此时才 `EXECUTED → SUCCEEDED`。成功后才尝试 `git worktree remove`（不加 force）。
- 恢复：未完成集成验证→`ERROR(RUNTIME_RESTARTED)` 并保留副本；`CREATED/PREPARING/VERIFYING`→`RECOVERY_REQUIRED`（明确 dev 未被推进）；`INTEGRATING_DEV`→ref 等于 `merged_commit` 则核验后补记 INTEGRATED（不二次写 ref），否则 `RECOVERY_REQUIRED/DEV_REF_OBSERVED` 并写明观察值。`RECOVERY_REQUIRED` 阻止新尝试直到人工处理；不自动部分集成。

未实现（不得声称）：`STALE` 判定、批级 `CANCELLED`、多成员批次、任务集合级集成。

StableBranchPromotion：`CREATED → VERIFYING → AWAITING_APPROVAL → PROMOTING → RESTARTING → SUCCEEDED`。

StableBranchPromotion：`CREATED → VERIFYING → AWAITING_APPROVAL → PROMOTING → RESTARTING → SUCCEEDED`。

- 固定 expected dev SHA、expected main SHA 与独立验证证据；验证失败→FAILED。
- AWAITING_APPROVAL（仅 STRICT）：用户批准精确 dev/main/verification 三元组后→PROMOTING；dev、main 或证据变化→STALE。FULL 下固定三元组后直接进入 PROMOTING，不停留此状态。
- PROMOTING：核对批准与 Git 工作区安全后执行 dev→main；main 更新成功→RESTARTING。
- RESTARTING：在 main 工作树执行 CLI stop，再执行 status 拉起并检查 Runtime；成功响应→SUCCEEDED。失败→RECOVERY_REQUIRED 并报告，不擅自回滚。
- FULL 下无显式门禁；STRICT 下批准是唯一显式门禁。重启都是提升后的自动后置步骤，不要求第二次确认。

## 5. Self Evolution

Candidate：`REQUESTED → DEVELOPING → BUILDING → SELF_TESTING → PROMOTABLE`，开发/构建/测试失败→FAILED，来源/兼容信息变化→STALE。用户取消且资源确认静止→CANCELLED。

Promotion（独立对象）：`REQUESTED → DRAINING → CHECKING → SWITCHING → HEALTH_CHECKING → SUCCEEDED`。

- REQUESTED：用户明确批准固定 artifact hash 与旧 Stable version。
- DRAINING：禁止新执行，等待全部活动任务结束；WAITING_FOR_USER 不豁免。
- CHECKING：再次核对候选、兼容性和备份要求；未定义迁移策略则不得继续。
- SWITCHING：bootstrap 执行可恢复版本指针切换，不覆盖旧版本产物。
- HEALTH_CHECKING：新版本健康通过才 SUCCEEDED；失败→ROLLING_BACK→ROLLED_BACK。
- 无法安全恢复数据或无法启动旧版→RECOVERY_REQUIRED，不声称回滚成功。

Bootstrap 自身更新和不可逆 migration 不属于普通 Promotion 的隐式权限。其策略为 Phase 7 阻塞决策。
