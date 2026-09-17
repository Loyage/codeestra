# Codeestra Architecture

> 层级：**L0 索引** · 体量 ≈ 6k 字符 · **先读这一篇**：它只做路由，不重复任何细节。细节在其所指的 L1/L2 文档与源码里，**不要整篇读**。

状态：Runtime 已实现到 **schema v38**。ADR-0070 的 Service / Process / Signal 内核 S1–S4 已实现（纯领域、additive storage、registry/dispatcher、`service/process/signal/intent` CLI）；S5–S8 各交付一个纵向切片（ADR-0071/0072/0073/0074，含**受管 integration ref + 持久 merge queue + 独立 Integration Verification**）；**S9–S10 与 S5–S8 的其余内容仍是目标**，不得把 Integration Process/Agent、integration ref 的发布出口、原生 Process Agent 控制、自然语言意图路由当成当前能力。Project/Task/Execution 旧表仍是 core 写权威。

## 1. 读取协议（省上下文的用法）

1. **只读与当前任务相关的那一层。** 多数任务只需要本篇 + 一到两篇 L1。
2. **优先按节读**：用 `grep -n '^##' <file>` 看目录，再用 `read` 的 `offset/limit` 取你需要的节，不要整篇拉进上下文。
3. **L2 默认不读**：逐表 DDL、逐事件 payload、逐 provider 能力矩阵只在真的要改那一块时打开。
4. **权威来源永远不是文档**：DDL 看 `packages/storage/src/migration.ts`，当前 schema 看实际库（`sqlite_master`），事件名看 `packages/storage/src/database.ts` 与 `apps/runtime/src/**` 的真实写入，能力位看 `packages/contracts/src/index.ts`。文档与实现冲突时按 `AGENTS.md` 的处理流程明确变更，不静默改口径。
5. **历史不在文档里**：被取代的设计、逐版本 DDL、旧事件名对照表已删除，改用 `git log docs/architecture/`、对应 ADR 与源码追溯。

## 2. 路由表：先问自己要回答什么

| 问题 | 读 | 层级 | 体量 |
|---|---|---|---|
| 现在的架构拓扑与内核不变量是什么 | 本文 §3；[`service-process-signal.md`](./service-process-signal.md) | L0/L1 | 6k / 9k |
| 我要改的领域对象是什么、归谁管 | [`domain-model.md`](./domain-model.md) | L1 | 11k |
| 某个状态能不能迁移到另一个状态 | [`state-machines.md`](./state-machines.md)（Task/Execution/内核 FSM，9k）；Session 与接管/修订投递看 [`state-machines-sessions.md`](./state-machines-sessions.md)（8k）；Runtime 生命周期与全局控制看 [`state-machines-runtime.md`](./state-machines-runtime.md)（5k） | L1→L2 | 9k / 8k / 5k |
| 某张表/某列是什么、能不能改 | [`sqlite-schema.md`](./sqlite-schema.md) → 对应域篇 | L1→L2 | 8k + 8–19k |
| 会写什么事件、payload 是什么 | [`event-model.md`](./event-model.md)（目录）→ [`event-model-payloads.md`](./event-model-payloads.md)（细节） | L1→L2 | 11k / 10k |
| Adapter 端口、能力声明与实测边界 | [`agent-adapter-api.md`](./agent-adapter-api.md) → [`agent-adapter-providers.md`](./agent-adapter-providers.md) | L1→L2 | 6k / 8k |
| 终端接管、PTY 帧、安全点、跨交接权限 | [`terminal-and-handoff.md`](./terminal-and-handoff.md) | L2 | 4k |
| 调度顺序、容量、等待原因 | [`scheduler.md`](./scheduler.md) | L1 | 11k |
| 冲突怎么判、影响快照怎么失效 | [`conflict-analyzer.md`](./conflict-analyzer.md) | L1 | 4k |
| Git/worktree 归属、成果 commit 边界 | [`git-workspace-api.md`](./git-workspace-api.md) | L1 | 8k |
| 项目知识的层、来源与 Execution 绑定 | [`knowledge.md`](./knowledge.md) | L1 | 5k |
| 代码放在哪个 package、依赖方向 | [`repository-structure.md`](./repository-structure.md) | L1 | 4k |
| 某个决策为什么这么做、当前有效语义 | [`../decisions/README.md`](../decisions/README.md)（索引 + 有效语义） | L1 | 30k→按节 |
| 某个能力到底做完没有 | [`../tasks/README.md`](../tasks/README.md)（按 FOUNDATION-编号搜索） | L1 | 1MB→**只 grep** |
| MVP 波次与解锁条件 | [`../roadmap/mvp.md`](../roadmap/mvp.md) | L1 | 15k |

## 3. 总体架构

```text
CLI（当前唯一客户端；可断开与重连）
        │ versioned commands / queries / events（Unix socket）
独立本地 Runtime（宿主 OS 进程）
        └── Codeestra Service #0（持久根 Actor）
             ├── Scheduler Service（Task-first 准入与资源）
             ├── Attention Service（全局待办索引）
             └── Project Service*
                  ├── Task Service* → Development Process → Agent
                  └── Integration Process → Agent        # 目标；S8 只做了确定性合并，未实现

SIG_A：明确 API → Service handler → Operation → Git / verification / filesystem
SIG_P：intention → Service → Process → Agent → typed Service APIs

SQLite：Service state + Signal inbox/outbox + Operations + Audit + Recovery
Agent Adapter：Pi / Codex / Claude Code
Knowledge：按 Execution/Process 绑定
Self Evolution：Candidate / bootstrap（后续阶段）
```

这是模块分层，不是微服务：所有 Service 都在同一个 Runtime 进程内，由 registry、SQLite inbox 与事件唤醒托管，不为每个 Service 建 OS 进程或 busy-loop。Domain 不依赖 Bun、数据库、UI 或具体 Agent SDK。Git worktree 隔离工作目录，但**不是**权限沙箱。

服务形态：独立本地 Runtime 是软件本体；**CLI 是完备、权威、可脚本化的命令面**（`--json` + 稳定退出码）。ADR-0067 起 Web UI 暂停，当前只启用 CLI/Unix socket；保留的 UI/HTTP 源码不属于可用产品面。未来恢复的 UI/桌面只能是同一 versioned command/query/event 面的便利前端，不新增业务语义、不绕过门禁、不直接访问 SQLite。

## 4. 当前事实与目标的分界（一句话版）

| 领域 | 当前 v38 | 目标（ADR-0070） |
|---|---|---|
| 内核对象 | Service/Process/Signal 表与 CLI 已存在；Project/Task/Execution 旧表仍写权威 | S5–S7 把写路径与 Agent 控制迁到 Service/Process |
| 分支与集成 | **已实现（ADR-0074）**：Project Service 独占 `refs/codeestra/integration` + owned detached worktree，持久 merge queue（同项目串行、跨项目并行）、独立 Integration Verification、CAS 推进；**没有发布出口**（不推到用户 main/release，也不恢复 `promotion *`） | Integration Process/Agent（复杂合并的模型辅助）与发布出口仍未定义 |
| 调度 | `schedule-service.ts` 事件驱动 + 周期 pass，按 ADR-0059 的功能声明判冲突 | S9 依赖/冲突求值解耦为带版本证据的 `TaskEligibility` |
| 意图 | `intent` 命令与记录已存在 | S6 root/project/task intention 与全局 Attention 路由 |
| 前端 | 仅 CLI/Unix socket | 恢复的 UI/桌面只做同一命令面的前端 |

详细波次、owner 与逐波验收见 [`../roadmap/mvp.md`](../roadmap/mvp.md)。

## 5. 已确认的重要语义（指针，不展开）

- 效率至上；默认 `FULL` 主机级全权限且常态零确认，可无确认切换 `STRICT`（ADR-0011）。→ `PROJECT_SPEC.md` §1.1
- 软件本体是服务，CLI 必须完备且可脚本化；UI/桌面只是便利层（ADR-0008/0011/0067）。
- 自动化测试与验收只用 CLI/命令面驱动，不获取电脑控制权（ADR-0008）。
- 内核 Service-first、调度 Task-first；Service 只拥有 Process，Process 只监督 Agent；Signal 持久至少一次并按幂等键收敛（ADR-0070）。
- 冲突判定只看「两侧声明同一功能且对方未完成」，默认 `SAFE_TO_PARALLELIZE`；`--allow-unknown` 永不放宽 `CONFLICTING`（ADR-0059）。
- 验证分层：Task Verification 与 Integration Verification 是不同事实，证据绑定 revision/commit/policy digest（ADR-0006/0039）。
- Agent 能力按实测如实声明，不伪造 resume/attach/interrupt（ADR-0029/0040/0051/0054/0057/0061）。
- 保留失败现场：不 `--force`、不自动回收、不声称静止；`task purge` 是全产品唯一一次显式 `--yes`（ADR-0021/0037/0055/0058）。
- 本仓库自身的 `dev → main` 是人工四步（`AGENTS.md` + [`../agents/runbook.md`](../agents/runbook.md)），不是产品能力。

## 6. 最大风险与建议门禁

| 风险 | 建议与门禁 |
|---|---|
| 把目标当已实现 | 每篇文档的「当前/目标」标注 + §4 表；`docs/tasks/README.md` 才有验收状态 |
| Pi 的真实交互、暂停与 attach 能力 | 按 ADR-0010 在结构化安全点做 RPC↔TUI 进程交接；能力不足回报阻塞，不用 fake 冒充验收 |
| 修订后仍交付旧代码/证据 | revision、applied revision、commit、验证全链路固定引用；「暂停」与「已确认」分开 |
| 依赖满足但上游代码不在下游 | 以基线 ref 的祖先可达性核对；仅执行成功不满足依赖 |
| 功能声明不完整造成误并行 | ADR-0059 只按声明判冲突，这是已接受的残余风险；实际越界时暂停并报告 |
| Signal 被误解为 exactly-once | 持久 inbox/outbox 只保证至少一次；handler 幂等，外部副作用用 Operation + 身份/ref 核对 |
| SQLite、Git 与进程非原子 | Operation + Signal receipt + 幂等键 + 外部身份核对；不盲重试 start/merge |
| 全局暂停误把「发过信号」当「已冻结」 | 固定 pause epoch，按 pid + start token + incarnation 复读 stopped；部分成功进 `RECOVERY_REQUIRED` 并保持屏障 |
| 宿主权限、hooks、日志中的秘密 | worktree 不是沙箱；FULL 允许当前用户的主机级副作用；终端输出仍按不可信内容处理 |
| 自我升级数据不可逆 | Candidate 数据隔离；迁移/备份/bootstrap 更新策略在 Phase 7 前明确批准 |

## 7. 设计成熟度

产品语义不可能一次锁死：ADR-0070 的 Service kernel 按 S1–S10 分阶段准入，S1–S4 已完成并各有独立退出条件。API 是 Runtime port 合约，不是供应商能力承诺；实测能力矩阵记录在 [`agent-adapter-providers.md`](./agent-adapter-providers.md)，证据在 [`../spikes/`](../spikes/)。
