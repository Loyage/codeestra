# ADR-0035：事件名对齐与交接/终端事件面

Status：Accepted（FOUNDATION-051 doc-sync 交出的四条不一致中，三条由用户裁决）。

## Context

FOUNDATION-051 把「文档与实现不一致」的清单交给用户裁决，没有静默改写规格。四条待裁决项里，三条在本格落地，一条明确不做：

1. **事件命名方向**：`docs/architecture/event-model.md` §2 的设计目录与代码实际写入的名字不一致（`TaskRevisionAppended` vs `TaskRevisionCreated`、`RevisionDelivered` vs `TaskRevisionDelivery*`、`MainPromoted` vs `PromotionMainUpdated` 等）。事件表 `domain_events` 是 append-only 审计，任何一边改名都会让同一语义长期存在两个名字。
2. **5.2 实现范围**：ADR-0023/0026 的交接与原生终端状态只写 `session_incarnations` / `session_writer_leases` / `session_handoff_requests` / `session_terminals` / `session_terminal_attachments` 行，**没有任何 domain event**：状态变了但日志里没有对应事实，订阅者与 UI 无法从事件流得知交接发生过，`TakeoverFailed` 这类拒绝完全不可见。
3. **`AdapterCapabilities`**：设计类型（`docs/architecture/agent-adapter-api.md` §1）有 `nativeTerminalHandoff` / `safePointNotification` 两个维度，实现契约（`packages/contracts/src/index.ts`）没有，读者无法从能力投影区分「能做原生终端交接的 Pi」与「不能做的 Codex」。
4. `ImpactAssessed` / `ConflictAssessed`（判定类事件）**不在本格范围**：ADR-0031 已把判定写成 `impact_assessments` 行，补事件是另一次语义变更。

## Options

**命名方向**

- A（采纳）：文档对齐实现名；**已实现的事件永不重命名**；新事件用设计名；旧名标为已废弃。
- B：重命名代码里的已实现事件名对齐设计目录。
- C：保留只读别名（两个名字同时在实现里可用）。

**5.2 实现范围**

- A（采纳）：只补交接/终端的七个事件（`TakeoverRequested`、`TakeoverSafePointReached`、`SessionHandoffStarted`、`SessionHandoffCompleted`、`TerminalWriterLeaseChanged`、`TakeoverReleased`、`TakeoverFailed`）。
- B：连带补 `ImpactAssessed` / `ConflictAssessed`。
- C：为 Execution 的暂停/取消补专名事件。
- D：顺手实现 Session Guidance 的事件（Phase 3 功能缺口）。

**`AdapterCapabilities`**

- A（采纳）：把两个维度补进实现契约，由适配器**如实声明**。
- B：从设计类型里删掉这两个维度。

## Decision

### 1. 事件命名（方向 A）

- **已实现的事件名以实现为准，永不重命名。** 事件台账是 append-only 审计：重命名会让历史行与新行共用一个语义却有两个名字，并让已发出的订阅游标、消费者幂等键和外部脚本同时失效。
- **新事件采用设计目录里的名字。** 设计目录是先行契约；本格新增的七个事件即为此例。
- **名字变更只能通过「新增事件 + 旧事件不再产生」实现**，不迁移历史行、不改写已有行、不把旧名行「升级」成新名。
- `event-model.md` §2 改为以实现实际写入的名字为准（逐条核对写入点，不照抄旧差异表），被废弃的设计名**明确标注**并说明为什么同一个东西有两个名字（§2.3）；命名规则自身写进 §2.2。

### 2. 七个交接/终端事件（范围 A）

表与状态迁移都已存在（ADR-0023/0026），缺的只是事件。硬性要求与实现：

- **同一事务**：事件与它描述的状态变更在同一个 SQLite 事务内提交。`TakeoverRequested` 与 `session_handoff_requests` 的插入同事务；两个安全点事件与 `AT_SAFE_POINT` 迁移同事务；`SessionHandoffStarted` + `TerminalWriterLeaseChanged(RELEASED)` 与「predecessor incarnation 置 EXITED + 释放 lease」在同一事务；`SessionHandoffCompleted` 与 `ADMITTED` 迁移同事务；`TerminalWriterLeaseChanged(ACQUIRED)` 与 lease 行的插入同事务；`TakeoverReleased` 与终端发布这个安全点同事务。`TakeoverFailed` 是唯一没有状态变更的拒绝事实，自己就是那条事实，单独成事务。
- **幂等**：沿用既有 command receipt / 唯一约束的做法。`TakeoverRequested` 不在重放路径上写；`TakeoverFailed` 的 event id 由 `sha256(commandId:stage:reason)` 推导，重放同一命令返回 false 且不新增行；lease 事件只在 lease 真的插入/真的释放时写（`changes === 1`）。
- **只写观测到的事实**：`TakeoverRequested` 与 `SessionHandoffStarted` 都**不是**「已交接」——前者只是意图与 fence，后者只是 predecessor 不再是 writer、successor 尚未启动；只有 `SessionHandoffCompleted` 表示 successor 进程真的启动、记录并持有单 writer lease。`TakeoverReleased` 只在发布被**证明**（provider 退出、记录的进程树无存活者、provider session file 仍保有 predecessor 的 entry）时写入，证明不了的是 `TakeoverFailed`。安全点事件携带 `missing` 与 `reachedFrom`，经终端发布达成时如实写 `fenceAcknowledged: false`，绝不假装 fence 被 ack。
- **payload 够用且严格**：七个 payload 用 Zod `strictObject` 落在 `packages/contracts/src/index.ts`，覆盖接管 id 与种类、安全点与 fence 事实、incarnation id、writer lease 变更的前后 holder 与 kind、失败原因码。存储写入前 `parse()`，因此日志里不可能出现契约描述不了的行。
- **可见**：事件写入 `domain_events` 后经既有 outbox、`events list` / `events tail` 与 UI 的 `/api/events` 订阅自然可见，UI **零改动**（UI 的事件联合是 `eventType: string`，没有类型收窄）。`events list` 现在也接受 `--json`（与 `task revision list` 一致，只是明确脚本意图）。
- **不改变语义**：不新增确认、不改 Task/Execution/Session 状态机、不为「让事件好看」而额外发请求。`markSessionIncarnationExited` + `releaseSessionWriterLeaseForSession` 两步在交接路径上合并为 `beginSessionHandoff` 一个事务——这是**更**原子，不是行为变化（两个状态写入本身不变，中间也不再有一个可被观察到的分裂窗口）。

### 3. `AdapterCapabilities` 补齐（方向 A）

- 两个维度加进实现契约，语义与设计类型一致：`nativeTerminalHandoff` 声明「能否在同一 conversation 上把 provider 交给/交回原生终端」，`safePointNotification` 声明「provider 是否上报安全点所需的结构化事实」。
- **如实声明**，所有构造点逐一改：
  - Pi：两者 `SUPPORTED`（ADR-0026 用真实 Pi 0.84.4 TUI 实测了整条链；残留边界写在 `SessionHandoffCapabilities` 里：`crossHandoffPermissionModeMatrix: PARTIAL`、`parallelToolBatchSafePoint: UNVERIFIED`）。
  - Codex：两者 `UNSUPPORTED`（`docs/spikes/codex-0.151.0.md`：app-server 无终端交接，其 TUI 是同一 thread 的第二个 writer；interrupted turn 不产生完成事实）。
  - deterministic fake 与四个 runtime 测试 stub：两者 `UNSUPPORTED`（它们不启动 provider）。
- **不改交接路径的能力门禁**：把 Pi 专属机制套到别的 provider 上本就会被拒，但改成「先查能力再决定」会改变可观察行为（新的拒绝码、新的时序），属另一次语义变更。本格只声明，不改判定。

### 4. 明确不做

`ImpactAssessed` / `ConflictAssessed`、Execution 专名事件（暂停/取消/取代）、Session Guidance 的 `SessionGuidance*` 事件都不在范围内。`TakeoverFailed` 的 reason code 直接复用既有 CLI/服务已返回的稳定码（`HANDOFF_NOT_REQUESTED`、`SAFE_POINT_NOT_REACHED`、`ATTACHMENT_BUSY`、`HANDOFF_ALREADY_REQUESTED`、`PREDECESSOR_NOT_STOPPED`、`RELEASE_NOT_CONFIRMED`…），**不新增 reason code 枚举**。

## Consequences

- **审批成本 0 步、0 等待**：没有新增确认、门禁、审批层或沙箱；事件是既有状态变更的副产物，交接路径的步骤数不变。
- 事件台账多 7 个名字与 2 个 aggregate type（`SessionHandoff`、`SessionWriterLease`）。**不占 schema 版本**（`domain_events` 已存在，仍 v21）。
- 每个会话每次启动/交接现在多 1–3 条事件行（lease 取用、交接开始、安全点、完成）。这是审计成本，不是执行成本。
- 拒绝不再静默：一次失败的入场会留下 `TakeoverFailed` + `stage` + 稳定码，脚本能分支，事后能复盘。
- `TakeoverFailed` 的 event id 由 command 推导，所以**同一命令的同一拒绝只留一条**；用不同命令重复尝试同一拒绝会留多条（每次尝试都是一条事实），这是有意选择。
- 读者的认知负担：历史里可能同时存在旧设计名与新实现名，`event-model.md` §2.3 就是为解释这件事而存在；不迁移历史行是刻意的取舍。
- **未覆盖**：真实 Pi TUI 在这些事件下的实时表现（UI 观感）未验证；「设计名 vs 实现名」是否还有本格判断不了的历史分歧（无法确认某设计名是否曾真的写入过别的数据库）如实登记为未验证。

## Verification

- 单元（`apps/runtime/test/session-handoff-service.test.ts`）：同一 command 重放只产生一条 `TakeoverRequested`；lease 事件只在 lease 真变化时写；安全点事件与其状态迁移同时出现；用一个无法描述的 successor 让 ADMITTED 回滚，验证**状态与事件一起消失**；拒绝按 command 幂等且不掩盖另一个拒绝；七个 payload 的 `strictObject` 拒绝未描述字段。
- 端到端（`apps/runtime/test/cli-session-handoff.test.ts`，真实 CLI + 真实 Runtime + 临时 `CODEESTRA_HOME` + **协议 stub provider**）：七个事件各自「命令 → `events list --json` 里的事件」；payload 逐个用契约 schema 解析；一个 takeover 的 aggregate version 严格递增；重复 `admit` 不产生第二条 `SessionHandoffCompleted`；构造一条旧设计名（`TaskRevisionAppended`）的历史行并读回，名字与 payload 原样。
- 契约：`bun run typecheck` 逐个报出 `AdapterCapabilities` 的所有构造点（生产 3 处 + 测试 6 处），逐处声明后归零。
- **未验证**：真实 provider（Pi/Codex）在交接过程中的 TUI 观感与人工目视；UI 终端的实时呈现。全部检查见 `bun run check`。

## Related

- [ADR-0004](0004-minimum-usable-runtime.md)（观察即事实）
- [ADR-0023](0023-strict-permission-attention-and-session-writer-lease.md)、[ADR-0026](0026-native-terminal-pty-transport.md)（incarnation、单 writer lease、PTY 传输）
- [ADR-0010](0010-live-agent-terminal-takeover.md)、[ADR-0028](0028-revision-delivery-and-stale-session-startup-reconcile.md)、[ADR-0029](0029-codex-adapter-transport-and-capabilities.md)
- [事件模型](../architecture/event-model.md)、[Agent Adapter API](../architecture/agent-adapter-api.md)
- [任务进度](../tasks/README.md) FOUNDATION-063
