# ADR-0061：Runtime 全局负载控制（唯一并行上限 + Provider 全局冻结）

Status：Accepted（用户 2026-09-16 明确选择：只保留一个 Runtime 全局并行上限；暂停采用可核验的 Provider 进程冻结；暂停跨 Runtime 重启持久保持；旧项目级 / Adapter 级显式上限迁移时取最小值。**本 ADR 只完成设计，代码、命令面与 schema migration 尚未实现；计划由后续独立开发分支落地。**）

## Context

现有 ADR-0030/0032 所称的“全局上限”实际上带 `project_id`：每个项目默认可并行 2 个 Task，另有每 Adapter 覆写。若同时开放多个项目，Runtime 的总并发可增长为“项目数 × 每项目上限”，不能控制整台机器的总负载。用户已经观察到机器负载跟不上，并要求：

1. 用户只设置一个**真正跨所有项目**的全局并行上限；任意时刻运行中的 Task 总数不超过该值，其余等待。
2. 用户可以全局暂停。暂停后不终止已经运行的工具/命令，但不再产生新的大模型 API 请求；行为接近冻结 Provider 进程。
3. 暂停必须有 UI 按钮，但按 `PROJECT_SPEC.md` §1.1，CLI / Runtime 命令面仍是权威且必须可脚本化。

现有 `task pause`（ADR-0016）不是这项能力：它协作停止一个 Task 的 Provider、结束旧 Execution，并在恢复时新建 Execution。新的全局暂停是 Runtime 控制面的**覆盖状态**，不改写每个 Task/Execution/Session 的生命周期状态，也不把进程冻结伪装成 Task `PAUSED`。

## Options

### 1. 容量层级

- A. 新增 Runtime 全局硬上限，同时保留项目级 / Adapter 级上限。
- B. **只保留一个 Runtime 全局上限。**（用户选择）
- C. 保留项目级上限，只增加 UI 汇总。

### 2. 全局暂停机制

- A. **先建立全局启动屏障，再可核验地冻结每个 Provider 主进程；不向正在运行的工具子进程发停止信号。**（用户选择）
- B. 等每个 Provider 自己报告安全点后软暂停。
- C. 只停止调度，不处理已经运行的 Agent。

### 3. 重启后的暂停语义

- A. **持久保持，只有显式继续才解除。**（用户选择）
- B. Runtime 重启后自动继续。
- C. 启动时再次询问用户。

### 4. 旧容量配置迁移

- A. **所有已有显式项目级 / Adapter 级上限取最小值，作为新的全局值；没有显式值则为默认 2。**（用户选择）
- B. 一律重置为 2。
- C. 检测到多个值就阻塞升级，等待用户手工选择。

## Decision

### D01：唯一容量上限属于整个 Runtime，而不是 Project 或 Adapter

- 一个 `CODEESTRA_HOME` 对应一个 Runtime 资源域，也只有一个并行上限。默认值仍为 **2**，合法范围仍为整数 **1–16**。
- 计数集合沿用槽位原语的“按 Task 去重”规则，但范围从单项目扩大到整个 Runtime：
  - 所有项目的活跃 `execution_slot_reservations`（`RESERVED` / `RECOVERY_REQUIRED`）；
  - 所有项目中 `executions.resource_held = 1` 的 Task；
  - 两者取并集，同一 Task 只计一次。
- 候选属于哪个项目、使用哪个 Adapter，都不再产生第二个容量上限。项目级与 Adapter 级容量配置被删除，不是隐藏或继续生效的兼容层。
- 降低上限不抢占、不暂停、不终止已运行 Task；`used` 可以暂时大于 `limit`，只阻止后续获取。
- `CAPACITY_GLOBAL_LIMIT_REACHED` 这个已发布稳定码保留名字，但含义修订为“整个 Runtime 的唯一全局上限已满”。`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` 在新实现中不再产生；历史事件与历史命令结果保持原样可读。
- 不按 CPU、内存、系统 load 自动推导，不做动态调参。上限是用户可读、可写、可脚本化的确定配置。

### D02：容量命令面去掉 Project 与 Adapter 参数

计划中的权威命令面：

```text
scheduler capacity get [--json]
scheduler capacity set --limit <1..16> [--json]
scheduler capacity reset [--json]
```

- `get` 返回 `{ limit, limitSource, used, available, occupiers[], pauseState }`；每个占用者必须带 `projectId`、`taskId`、`adapterId`、开始占用时间与来源（reservation / Execution）。
- `set` / `reset` 零确认；重复设置同值是幂等 no-op。`reset` 回到默认 2。
- 旧形态 `scheduler capacity get|set|clear <project-id> [--adapter ...]` 被移除；这是一项明确的公共 CLI 破坏性变更，实施时必须同步 `docs/guides/cli-reference.md`、`manual.md`、`features.md`、`recipes.md`、`ui.md` 与稳定错误码表。
- `scheduler reservations *` 仍按 Project 查询和操作，因为 reservation 仍属于某个 Task/Project；只有容量判定和容量配置变为 Runtime 全局。

### D03：迁移取旧显式值的最小值，不让升级突然增载

计划使用下一 schema migration（当前最新实现为 v33，实施分支预计占用 **v34**）：

1. 读取 `project_capacity_limits.global_limit` 与 `project_adapter_slot_limits.slot_limit` 的全部显式值。
2. 至少存在一个显式值时，新全局值取其中最小值；一个都没有时写入/派生默认值 2。
3. 在同一 migration 中建立全局配置后退役两张旧配置表；历史 `SchedulerCapacityChanged` 事件不迁移、不改名、不删除。
4. migration 必须在提交前核对：新值等于上述确定性结果、reservation/Execution 行数未变、`foreign_key_check` 为空。任一步失败整笔回滚，不能先删旧表再丢失值。
5. migration 完成后写出的新容量事实不再携带 Project 或 Adapter scope；旧事件仍按当时语义读取。

### D04：全局暂停是持久的 Runtime 控制状态，不是 Task 状态

全局控制状态：

```text
RUNNING → PAUSING → PAUSED → RESUMING → RUNNING
             └──────────────→ RECOVERY_REQUIRED
```

- `RUNNING`：允许正常调度与 Provider I/O。
- `PAUSING`：暂停屏障已经提交；立即拒绝新的槽位获取、Execution/Session/successor 启动与会触发 Provider 工作的投递，同时逐个冻结已有 Provider。
- `PAUSED`：本次 pause epoch 内所有仍存活的目标 Provider 主进程都已按 `pid + OS start token` 核验为 stopped；没有任何目标只靠“信号已发送”就被当成已暂停。
- `RESUMING`：用户已显式要求继续，Runtime 正在逐个核验并恢复本 epoch 的目标；新任务仍不启动，直到本次恢复收口。
- `RECOVERY_REQUIRED`：至少一个目标的身份、停止或恢复事实无法核验。全局启动屏障继续保持，不能把部分成功报告成 `PAUSED` 或 `RUNNING`。

该状态不改写 `Task.state`、`Execution.state`、`AgentSession.state`，也不释放 slot/workspace/writer lease。被冻结的 Task 仍是它冻结前的业务状态，并继续占用全局容量。`task pause` / `task resume` 仍保留 ADR-0016 的单 Task 协作停止语义，两者不可互相替代。

### D05：暂停屏障与 Provider 冻结的顺序

计划中的 `scheduler control pause` 必须按以下顺序执行：

1. 在与 Session 启动共享的 Runtime 控制互斥区内，把全局状态持久化为 `PAUSING`，递增 `pauseEpoch`，固定当前所有活动 Provider process incarnation 的目标清单；从这次提交开始，所有新 reservation/start/successor 与 Provider 投递路径都必须观察到屏障。
2. 对每个目标重新核验 `pid + start token + 当前 incarnation`。无法核验时不发信号，目标记为 `RECOVERY_REQUIRED`。
3. 在 POSIX 上只向**Adapter 声明并经实现验证为“模型请求发起者”的 Provider 主进程**发送 `SIGSTOP`；不向已记录的工具子进程/进程组发送停止、终止或 kill 信号。
4. 重新读取真实进程状态。只有身份仍匹配且主进程确实 stopped，目标才记为 `STOPPED`。
5. 全部目标都已 `STOPPED` 或已证明在屏障建立前退出，才把全局状态写为 `PAUSED`；否则写 `RECOVERY_REQUIRED`，已成功冻结的目标保持冻结，不为了得到整齐结果而自动恢复。

诚实边界：

- 暂停不会取消已经发出的模型请求；该请求可能在服务端完成并产生计费。保证是“屏障建立并核验冻结后，不再由受控 Provider 主进程发出下一次请求”。
- 工具子进程不会收到 Codeestra 的暂停/终止信号，因此不会被主动中断；但 Provider 主进程被冻结后若不再读取管道，大输出工具可能因 OS 管道背压而阻塞。产品不得把“不发信号”夸大成“工具在任何情况下都毫无停顿”。
- 第三方插件、MCP daemon 或 Adapter 无法证明归属的外部进程不在保证内。Adapter 必须新增并如实声明“可核验 Provider 进程冻结”能力；`UNSUPPORTED`/`REQUIRES_VALIDATION` 不能伪装成 `SUPPORTED`。Pi、Codex、Claude 在完成各自的进程归属 spike 前都只能标 `REQUIRES_VALIDATION`。
- Windows 没有本 ADR 规定的 POSIX `SIGSTOP`/`SIGCONT` 语义，必须报 `GLOBAL_PAUSE_UNSUPPORTED`，不能降级成“只暂停调度”后仍显示 `PAUSED`。

### D06：继续只恢复本次 pause epoch 中核验过的同一进程

`scheduler control resume`：

1. 仅从 `PAUSED` 或可处置的 `RECOVERY_REQUIRED` 进入 `RESUMING`；固定同一 pause epoch 的目标。
2. 每个目标先重验 pid/start token/incarnation 与 stopped 事实；只向完全匹配的 Provider 主进程发送 `SIGCONT`。
3. 已证明退出的目标不复活；其 Task/Execution 交给既有 Session/Execution reconcile 如实收口。
4. 无法核验的目标不发信号，控制状态进入 `RECOVERY_REQUIRED`；不得误把 PID 复用后的别的进程唤醒。
5. 所有目标均已恢复或已证明退出后，写 `RUNNING`，再触发一次事件型调度 pass，并投递暂停期间已耐久记录、仍然有效的 answer/guidance。

恢复期间已经被显式 `SIGCONT` 的目标可能继续模型请求；这是用户本次“继续”命令的直接结果。若恢复部分失败，Runtime 必须报告逐目标事实，不能声称仍是完整暂停，也不能启动新的 Task。

### D07：暂停跨 Runtime 重启保持，启动时绝不自动继续

- 全局控制记录与 pause targets 持久化。Runtime 启动在任何 scheduler tick、Adapter start 或 answer/guidance delivery 之前读取它；状态不是 `RUNNING` 就先建立启动屏障。
- 干净 `runtime stop` 在退出前仍按既有规则处理自有 Provider，不因全局暂停跳过进程归属核验；**全局 pause 状态本身不被 stop 清除**。下次启动仍是暂停态，直到显式 resume。
- Runtime 崩溃后失去 stdio/PTY 控制的 live Provider 仍按既有规则进入 Session/Execution `RECOVERY_REQUIRED`；全局 pause targets 只记录“该进程曾被本 epoch 冻结”，不伪造可重连能力。
- 启动时若观察到旧 boot 的 stopped Provider，Runtime不自动 `SIGCONT`、不自动 kill。`scheduler control reconcile` 只读并记录身份/存活/stopped 事实；无法按既有 Task recovery 收口前，全局状态保持 `RECOVERY_REQUIRED`。这是“重启不能意外恢复 API 请求”的代价。

### D08：暂停期间哪些动作继续

暂停只冻结 Agent 的模型驱动，不把整个 Runtime 变成不可用：

- 允许：所有只读查询、事件订阅、容量/控制状态查询、记录用户输入、Task cancel/recover/purge、Runtime stop，以及不调用模型的 Git/验证/集成操作。
- 延后：新 Task Execution/Session/successor、answer/guidance 向 Provider 的实际投递、任何可能引发下一轮模型调用的 Adapter 写入。正文/回答可先耐久记录，恢复后按既有有效性与幂等规则投递。
- 已经运行的工具/验证命令不因全局暂停收到停止信号。显式 `task cancel`、`task pause`、Operation cancel 或 `runtime stop` 仍可按它们自己的既有语义停止目标；全局暂停不屏蔽用户明确发出的控制命令。

调度等待新增稳定码 `SCHEDULER_GLOBALLY_PAUSED`，属于等待而不是 `BLOCKED`，CLI 退出码为 3。`BLOCKED` 仍只表示依赖未满足。

### D09：CLI 与 UI

计划中的控制命令：

```text
scheduler control status [--json]
scheduler control pause [--json]
scheduler control resume [--json]
scheduler control reconcile [--json]
```

- `status` 返回全局状态、epoch、请求/结算时间、actor、每个目标的 project/task/execution/session/incarnation/process identity 与观测结论，以及容量摘要。
- `pause` / `resume`：达到完整稳定状态或幂等地已经处于目标状态时退出 0；任何目标不可核验或平台不支持时退出 1 并返回稳定码；不使用退出码 3 掩盖部分冻结。Task 因全局暂停而等待启动时仍用退出码 3。
- `reconcile` 只观察，不发 `SIGSTOP`/`SIGCONT`/终止信号；它可以把“已证明退出”的 target 收口，但不能把无法核验猜成已停止。
- 稳定码至少固定为：`SCHEDULER_GLOBALLY_PAUSED`（Task 等待）、`GLOBAL_PAUSE_UNSUPPORTED`（平台/Adapter 不支持）、`GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE`、`GLOBAL_PAUSE_TARGET_NOT_STOPPED`、`GLOBAL_RESUME_TARGET_CHANGED`（含 PID 复用）、`GLOBAL_PAUSE_RECOVERY_REQUIRED`。实现可以细分更多观测码，但不能把这些合并成含糊的 `INVALID_STATE`。
- 全部命令 FULL/STRICT 都是零确认。暂停按钮本身就是显式用户命令，不再叠第二次确认。
- Web UI 的全局 shell（不依赖当前选中 Project）放置“暂停全部 / 继续全部”主控件和清晰状态；在 `PAUSING`/`RESUMING`/`RECOVERY_REQUIRED` 时展示逐目标事实，不用一个乐观布尔值。调度页的容量卡改为“Runtime 全局容量”，列出跨项目占用者；UI 只调用上述命令面。

### D10：持久模型与事件（计划 v34）

实现分支至少需要以下持久事实（最终列名可在不改变语义的前提下调整）：

- `runtime_capacity_settings`：singleton、`global_limit`、version、updatedAt/By。
- `runtime_pause_control`：singleton、state、pauseEpoch、version、requested/settled 时间、actor、detail。
- `runtime_pause_targets`：epoch + session/incarnation/process identity、project/task/execution、状态（`PENDING|STOPPED|RESUMED|EXITED|RECOVERY_REQUIRED`）、观测与时间；同一 epoch/incarnation 唯一。project/task/execution/session/incarnation ID 是冻结时的身份快照，刻意不设 FK：`task purge` 删除业务聚合后，Runtime 仍须保留这个 epoch 的进程恢复与审计事实；purge 前仍按 ADR-0058 证明 provider 已停止并收口 target。
- `runtime_command_receipts`：给无 Project 的全局命令提供 commandId 幂等与同键异文拒绝。

全局事实不能伪装成某个 Project 的事件。计划在 v34 把 `domain_events.project_id` 改为可空：`NULL` 表示 Runtime 全局事件；历史行保持原 projectId。项目过滤订阅必须同时收到该项目事件与 `project_id IS NULL` 的全局事件，因为全局容量/暂停会影响它；游标仍按同一 sequence 前进。

新增设计事件名：

- `SchedulerGlobalCapacityChanged`
- `SchedulerGlobalPauseRequested`
- `SchedulerGlobalPaused`
- `SchedulerGlobalResumeRequested`
- `SchedulerGlobalResumed`
- `SchedulerGlobalControlRecoveryRequired`

事件只写已经发生的事实；`PauseRequested` 不等于 `Paused`，`ResumeRequested` 不等于 `Resumed`。进程身份与逐目标结果放在目标表和事件 payload，敏感正文不进入事件。

## Consequences

### 收益

- 无论同时接入多少项目，整个 Runtime 最多只有 `globalLimit` 个 Task 占用执行容量，机器负载第一次有真正的总闸门。
- UI 一键暂停后，所有受控 Provider 在同一个持久屏障下停止产生下一次模型请求；工具不会被 Codeestra 主动终止。
- 暂停、重启、恢复和部分失败都有可查询事实，不用把“按钮点过了”当成“所有进程已经停住”。

### 代价与兼容性

- 删除项目级与 Adapter 级容量，是明确的破坏性命令面 / 数据语义变更。依赖旧命令的脚本必须迁移。
- 一个低吞吐 Adapter 不能再单独设为 1；用户只能降低整个 Runtime 的全局值。这是“只保留全局上限”选择的直接后果，不在实现中偷偷保留隐藏覆写。
- POSIX Provider 冻结不是 provider 原生 pause。必须完成每个 Adapter 的进程归属验证；不能证明时 fail-closed，并保持全局屏障。
- Runtime 崩溃时，暂停持久化优先保证“不意外恢复 API”，代价是旧 live Session 可能需要人工/既有 recovery 流程处理，不能自动重连或自动唤醒。

### 效率成本与权限边界

- 正常开发路径新增确认：**0**。并行上限自动生效；未触发暂停时没有额外点击或等待。
- 用户主动暂停/继续各是一条显式命令或一次按钮点击，不是审批层。
- 不新增权限模式、沙箱、信任流程或逐任务确认。FULL/STRICT 对这组负载控制命令的行为相同。

## Verification

实现分支必须只通过 CLI / Runtime 命令面与临时进程验证（ADR-0008），至少覆盖：

1. 两个项目各有多个 SAFE Task，全局 limit=2 时整个 Runtime 最多两个占用；第三个无论属于哪个项目都得到 exit 3 + `SCHEDULER_GLOBALLY_PAUSED`（暂停时）或 `CAPACITY_GLOBAL_LIMIT_REACHED`（容量满时）。
2. 降低到小于 used 不终止现有 Task；释放后在 used < limit 前不启动新 Task。
3. v33→v34 migration：有多个旧项目/Adapter 显式值时取最小值；无显式值时为 2；旧 reservation/Execution 与历史事件不变；失败注入整笔回滚。
4. pause 与并发 start 的竞态：屏障提交后不能再产生新 Provider；同时到达的 start 要么先成为固定 target 并被冻住，要么得到全局暂停等待，不能漏掉。
5. 真实 POSIX 子进程：Provider 主进程被 `SIGSTOP` 且 start token 不变；已经运行的工具子进程未收到停止/终止信号并能继续；未核验目标使全局状态进入 `RECOVERY_REQUIRED`，不能报告 `PAUSED`。
6. 暂停前已经发出的模型请求只记录为 in-flight 边界，不声称被取消；冻结后没有下一次受控 Provider 请求。
7. resume 只 `SIGCONT` 同 pid + start token 的 stopped 目标；PID 复用、进程消失、身份不可读分别有稳定结论，绝不唤醒错误进程。
8. Runtime 重启后 pause barrier 仍在，自动 tick / submit / answer delivery 都不能启动 Provider；不自动 `SIGCONT` 旧 boot 进程。
9. 暂停不改 Task/Execution/Session 状态、不释放 slot/workspace；单 Task `task pause` 仍走 ADR-0016 的协作停止路径。
10. 项目过滤的 `events.subscribe` 能收到 `project_id=null` 的全局控制事件，cursor 重连不漏不重。
11. UI 只投影同一命令面；可机器断言命令、HTTP 响应、事件与静态 DOM 状态，不用桌面自动化做验收。

## Related

- `PROJECT_SPEC.md` §1.1、§2、§6
- ADR-0008 / ADR-0011（CLI 完备、FULL 零确认）
- ADR-0016（单 Task pause/cancel/archive；与本 ADR 的全局冻结不同）
- ADR-0023 / ADR-0025 / ADR-0028（进程身份、Runtime 生命周期、重启 reconcile）
- ADR-0030 / ADR-0032 / ADR-0033（被本 ADR 修订的容量层级与调度等待）
- `docs/architecture/scheduler.md`
- `docs/architecture/agent-adapter-api.md`
- `docs/architecture/state-machines.md`
- `docs/architecture/sqlite-schema.md`
- `docs/architecture/event-model.md`
- `docs/tasks/README.md` FOUNDATION-095 / NEXT
