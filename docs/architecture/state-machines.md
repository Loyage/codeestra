# 状态机与迁移规则

状态：Phase 0/1 基线；Integration/Self 为后续阶段合约。未列出的迁移拒绝；所有迁移需 expected aggregateVersion、actor、reason，并在事务中记录事实事件。恢复操作不绕过 guard。

## 1. Task lifecycle

状态：`DRAFT, BLOCKED, READY, RUNNING, PAUSING, PAUSED, WAITING_FOR_USER, RECOVERY_REQUIRED, EXECUTED, FAILED, CANCELLING, CANCELLED, SUCCEEDED`。

| 源 | 触发 | Guard / 目标 |
|---|---|---|
| DRAFT | submit | 规格有效；依赖未满足→BLOCKED，否则 READY |
| BLOCKED | dependencies satisfied | 上游指定结果已入 main 且当前基线可达→READY |
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
| EXECUTED | integration promoted | 当前 revision 的固定候选经批准成功进入 main→SUCCEEDED |
| DRAFT / BLOCKED / READY / EXECUTED / FAILED | cancel | 没有活动写入或正在提升的竞争操作→CANCELLED |
| RUNNING / PAUSING / PAUSED / WAITING_FOR_USER | cancel | →CANCELLING，协作中断 |
| CANCELLING | confirmed stopped | →CANCELLED，保留 workspace |
| RECOVERY_REQUIRED | reconcile | 依据真实事实回到已证实状态；必须审计，不能直接释放资源 |

READY 的等待原因单独派生为 CONFLICT / CAPACITY / DRAINING / REVISION_REVIEW 等，不误用 BLOCKED。依赖未满足是 BLOCKED 唯一含义。SUCCEEDED/CANCELLED 不自动重开。

Task Verification：`NOT_RUN → QUEUED → RUNNING → PASSED | FAILED | ERROR`；revision/commit/策略失效产生 `STALE`。重验创建新 VerificationRun，旧证据不改写。

Task Integration summary：`NOT_READY → ELIGIBLE → BATCHED → INTEGRATED`；失败/修订产生 `NEEDS_ATTENTION / STALE`。这些是查询投影，不是替代 Batch 的权威状态。

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

## 3. AgentSession

`CREATED → STARTING → ACTIVE`；ACTIVE↔WAITING_FOR_USER；ACTIVE/WAITING_FOR_USER→PAUSING→PAUSED→ACTIVE；活动态→STOPPING→EXITED；控制连接丢失→DISCONNECTED；身份或恢复失败→RECOVERY_REQUIRED。

DISCONNECTED→ACTIVE/WAITING_FOR_USER/PAUSED 需 reconcile 证明真实状态。EXITED 不代表 Task 成功，需 exit reason、执行结果与验证。UI detach 不改变 AgentSession 状态。provider resume 若实际创建新会话，必须建立新 session/execution 关联，不伪装旧 OS 进程仍存活。

原生审批回答中 reject/deny 也属于有效回答，不能把“用户已回答”等同“用户批准”。

## 4. IntegrationBatch

`CREATED → PREPARING → VERIFYING → AWAITING_APPROVAL → PROMOTING → INTEGRATED`。

- PREPARING：从固定 expected main 创建独立 integration worktree，合并固定 source commits；冲突→CONFLICTED，其他错误→FAILED。
- VERIFYING：在固定 candidate 上运行独立验证；失败→FAILED，成功→AWAITING_APPROVAL。
- AWAITING_APPROVAL：用户批准精确 candidate/main/verification 后→PROMOTING。
- PROMOTING：再次核验 main SHA、candidate、成员 revision、验证和活动 Git 操作；安全快进且核对成功后→INTEGRATED。
- 任意提升前状态发生基线/成员/候选变化→STALE；用户取消→CANCELLED。正在提升时取消必须串行核对最终事实，不能先标 CANCELLED 再异步写 main。
- 提升操作崩溃→RECOVERY_REQUIRED；若 main 已更新，根据固定 OID 核对补记成功，不能重复合并。
- FAILED/CONFLICTED/STALE 的重试建立新 candidate/batch，保留旧记录与审批；不自动部分提升。

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
