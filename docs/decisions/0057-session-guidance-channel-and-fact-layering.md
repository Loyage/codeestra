# ADR-0057：Session Guidance 的通道、投递事实分层与「已入队 ≠ 模型已读」（schema v31）

Status：Accepted（本轮实现：FOUNDATION-088；schema **v31**；**零新增确认、零新增审批层、零新增沙箱**）

## Context

Phase 3 的交付项里只剩 Session Guidance 没有落地：`docs/roadmap/mvp.md` 把它登记为未实现，
`docs/architecture/event-model.md` §2.3 把 `SessionGuidanceRecorded`/`SessionGuidanceDelivered` 登记为
「设计名保留、未实现」，`packages/agent-adapters` 既没有导出 `guide` 端口也没有实现它（本机
`grep -rn "guidance" apps packages --include=*.ts` 零命中）。这不是事件缺口，是功能缺口。

必须解决的三件事，在本格之前都没有答案：

1. **`task amend` 与 guidance 是两条通道**（ADR-0010 D02、`PROJECT_SPEC.md` §2.11 第 21 条）：
   规格/验收目标的改变只能经 TaskRevision，并继续使旧验证失效；会话指导改变的是「怎么做」，
   不产生 revision、不改 `tasks.current_revision_id`、不使任何验证失效。
2. **「已投递」到底指什么。** ADR-0028 对 **revision** 确立的是严格口径：只有 Adapter 的结构化 ACK
   （且带 evidence）或经核验的 successor Execution 才算满足，其余一律 `CHANNEL_UNSUPPORTED` 等未满足态。
   ADR-0051 用真实 CLI 实测（未发模型请求）证明：三个 provider 都只有**「把消息送进运行中会话」**的通道，
   **没有一个**能给出「消息已生效/模型已读」的可核验事实——Pi RPC `steer` 成功但只回 `queue_update`，
   Codex `turn/steer` 需活跃 turn 且响应只有 `{turnId}`，Claude 控制协议只有
   `initialize`/`interrupt`/`can_use_tool`。照抄 revision 的严格口径会让 guidance 永远不可用（形同没实现），
   而把「消息发出去了」说成「已生效」是本项目明令禁止的伪造事实。
3. **guidance 不能随进程消失。** 用户对一次执行说的话，在 successor/resume 或 `task retry` 建立的新
   Execution 上仍然有效；但 provider 的会话是进程级的，Runtime 重启或换进程后它不再存在。

约束（既有决策，不是本格的新选择）：§1.1 第一原则（FULL 零确认、CLI 必须完备可脚本化、测试只用命令面）；
ADR-0035（新事件用设计名、已实现名永不重命名）；ADR-0041/0051 的「每个 provider 用它自己的通道、
零知识时 argv 逐字节不变、Adapter 在 spawn 前核验、拿不到就拒绝启动」；ADR-0046 的教训（CHECK 只列
**今天能产生**的取值）。

## Options

1. guidance 与规格变更的关系：A. 复用 TaskRevision（guidance 也生成 revision）；B. **两条独立通道**
   （见 D01）；C. 只改 conversation、不记录任何台账。
2. 「已投递」的口径：A. 沿用 revision 的严格 ACK 口径（三个 provider 都是 `UNSUPPORTED`，等于不实现）；
   B. **通道接收（入队）即 `DELIVERED`**，并把「已记录 / 已投递 / 模型已读」拆成三个互不冒充的事实，
   命令面与指南明确写「已入队 ≠ 模型已读」（见 D02）；C. 用模型自然语言回复或自建 extension 工具当「已读」证据。
3. 通道抽象：A. 造一个统一的 `applyGuidance` 抽象套在三个 provider 上；B. **每个 provider 用它自己的通道，
   能力位如实声明**（见 D03）。
4. 记录后的生效范围：A. 只在当前会话有效（进程一死就消失）；B. **会话级事实**：新 Execution 启动时随启动
   参数交给 provider（见 D04）。
5. 命令面退出码：A. 一律 0（脚本无法区分是否真的送到）；B. **0 = 已交付或已记录且当时没有会话可交付 /
   1 = 有 provider 被问过但没交付 / 2 = 用法**；需要等待语义时才用 3（见 D05）。
6. 是否需要迁移号：A. 不落表，只在事件里写；B. **占 v31，三张纯追加表**（见 D07）。

## Decision

### D01：双通道不变——guidance 不是规格变更

- guidance **不产生 `task_revisions` 行**、**不动 `tasks.current_revision_id`**、**不动 `tasks.version`**、
  **不写 `VerificationInvalidated`**、**不使任何验证失效**、**不使任何未提升批次失效**。
  `task amend`（`task.revision.create`）仍然是唯一的规格变更路径，并继续使旧验证失效。
- 这条不是文档承诺：`recordSessionGuidance` 在同一事务里只写 guidance 行、attempt 行与事件，
  测试用「事件目录 + `task_revisions` 行数 + Task 版本/revision 未变」把两条通道分开钉住
  （`apps/runtime/test/session-guidance.test.ts`、`apps/runtime/test/cli-session-guidance.test.ts`）。
- 用户若实际想改验收标准，必须显式走 `task amend`；CLI/Runtime 不根据自然语言猜测意图。

### D02：「已投递」= provider 通道接收（入队）；三层事实互不冒充

三个事实被拆开，且**没有任何列或状态能表达第三个**：

| 事实 | 存哪 | 含义 |
|---|---|---|
| **已记录**（`RECORDED`） | `session_guidance` 行（含正文耐久副本） | 消息已经落在账本上，崩溃不会丢；下一次 Execution 启动时会带上它 |
| **已投递**（`DELIVERED`） | `session_guidance_deliveries` 行 + `DeliveryDetail`/`evidenceRef` | provider **自己的通道接受了这条消息**（入队），并记录当时的通道事实（如 `pi-rpc:steer:…:queue_update=OBSERVED`） |
| **模型已读/已生效** | **不存在** | 三个 provider 都没有可核验通道（ADR-0051）。契约里以 `modelAcknowledgement: 'UNSUPPORTED'` 显式说出口，而不是省略 |

**为什么这里允许弱事实，而 revision 不允许。** revision 的严格 ACK 口径服务于一个具体断言：
「这个 Execution 已经在新规格上工作」，而它后面接着暂停解除、`executions.applied_revision_id`、
验证与提升——把「消息发出去了」当成「规格已生效」，会让 Agent 继续按旧规格产出并把它一路送进
Task verification 与 `dev`，错误不可自愈。guidance 不进入这条链：它不改验收标准，最坏的错误是
「用户以为 Agent 收到了指导」，而它在**下一次 Execution 启动时会重新交付**（D04），因此是可自愈的。
即便如此，命令面必须把状态讲清楚：没通道就是 `CHANNEL_UNSUPPORTED`，没有活会话就是 `session:<state>`
或 `RECORDED`，超时就是 `TIMED_OUT`，**绝不允许把「消息发出去了」记成投递**。

**明确否掉**用模型自然语言回复、自建 extension 工具或屏幕文本当「模型已读」的判据：那是模型自我陈述
或发明通道，与 ADR-0028/0051 已经否掉的理由相同。

### D03：每个 provider 用它自己的通道，能力位如实声明

新增 `AdapterCapabilities.sessionGuidance`（ADR-0044 式的「如实声明、不是占位」）：

| provider | `sessionGuidance` | 活会话通道（依据） | 新 Execution 启动时的通道 |
|---|---|---|---|
| Pi | `SUPPORTED` | RPC `steer` 成功 + provider 自己上报的 `queue_update`（ADR-0051 实测） | `--append-system-prompt <绝对路径>`（同一 flag 可重复使用，`pi --help` 明确写 "can be used multiple times"） |
| Codex | `REQUIRES_VALIDATION` | `turn/steer` 在实际 provider 里需要 `expectedTurnId`，本 Adapter 从不持有活跃 turn id，且该通道从未对着活跃 turn 验证过（ADR-0051 实测得到的是拒绝响应） | 把两件已经核验过的产物合成 app-server 唯一接受的 `developerInstructions` 字符串；guidance 段自带标题，knowledge 文本原样透传 |
| Claude Code | `UNSUPPORTED` | `--print` 控制协议只有 `initialize`/`interrupt`/`can_use_tool`，**没有**任何接受「运行中一轮里的消息」的子类型；往子进程 stdin 写文本是发明通道 | `--append-system-prompt <已验证文本>`（knowledge 继续用 `--append-system-prompt-file <路径>`，两个不同 flag，因此不依赖任何未实测的可重复性） |

- 能力位不是「支持的证明」：Runtime 在**投递那一刻**实时读它，不是 `SUPPORTED` 就记
  `CHANNEL_UNSUPPORTED`（evidence 为 `capability:<实际值>`）；声明 `SUPPORTED` 却没有 `guide` 端口同样记
  `CHANNEL_UNSUPPORTED`（`capability:SUPPORTED:guide-missing`）——与 ADR-0028 D02 的结构判定一模一样。
  能力位**只描述运行中会话通道**；启动交付是另一件事（D04），不被它 gate。
- 不发明统一抽象：三个 provider 各自的启动 flag / 字段不同，Adapter 各自实现，contracts 里只有
  「一个纯追加、可选的能力位」与「一个纯追加、可选的启动载荷」。

### D04：guidance 是会话级事实，随后续 Execution 启动一并交给 provider

- 记录之后，**该 Task 的每一条 guidance 都会在新建 Execution 启动时交给 provider**（含 `task resume`
  的 successor、`task revise` 的 successor、`task retry` 的新 Execution）。交付事实写进
  `execution_guidance_contexts`（execution、guidance ids、artifact 路径/digest/字节数、时间），
  因此「指导没有随进程消失」是可读事实而不是断言。
- artifact 渲染成 `<CODEESTRA_HOME>/guidance/<project-id>/<task-id>/guidance-context.md`：
  **绝不写进 Task worktree**（ADR-0041 D05 的同一条结构性理由：worktree 里的未跟踪文件会进入 Task 的
  Git 变更集、让并发 Task 看起来改了同一路径，并会被 `git add --all` 带进成果 commit），也**绝不与
  Project Knowledge 共用文件**——两者说的事情不同（声明 vs 用户刚说的话）。
- **零 guidance 时 argv/入参逐字节不变**：没有 guidance 记录就返回空载荷，不写文件、不加参数
  （Pi/Claude 两种 `--append-system-prompt` 都不出现；Codex 的 `developerInstructions` 在没有 guidance 时
  与改动前完全相同——knowledge-only 启动逐字节不变，这是把 knowledge 文本原样透传而只给 guidance 段加标题的原因）。
- **Runtime 侧拒绝而不是静默少注入**：Task 有 guidance 记录却拿不到 Runtime home 时，启动以
  `GUIDANCE_CONTEXT_UNAVAILABLE` 拒绝。**Adapter 侧同样 fail-closed**：在 spawn 之前核验
  「绝对路径 + 普通文件（拒绝符号链接/目录）+ 原始字节 sha256 == digest + 字节数 == bytes + 合法 UTF-8」，
  任一不成立即以同一个稳定码拒绝启动。这与 ADR-0051 的知识交付同形状，落点是 `context-artifact.ts`
  这一份共享核验规则（两个 artifact 各自的稳定码不同）。

### D05：命令面完备、可脚本化、零新增确认

```sh
session guide <project-id> <task-id> --message <text> [--json]      # 命令名 session.guidance.record
session guidance list <project-id> <task-id> [--json]
session guidance get  <project-id> <guidance-id> [--json]
```

- **退出码**：`0` = 已经交给运行中的 provider 通道（`DELIVERED`），**或**当时没有任何会话可交付而消息已记录
  （`RECORDED`——这不是拒绝，而是等待下一次启动交付）；`1` = 有 provider/会话被问过却没有交付
  （`CHANNEL_UNSUPPORTED` / `TIMED_OUT` / `FAILED`）；`2` = 用法错误。
- **不使用退出码 3**：本命令没有「等待语义」。投递有界（deadline 到点就写 `TIMED_OUT`），任何一次调用都会
  落下一个明确结论，不存在「稍后再看可能变好」的命令状态；把 `RECORDED` 表达成等待只会让脚本多轮询一次。
- 稳定码：`CHANNEL_UNSUPPORTED`、`NO_SESSION`、`NO_SUBJECT_EXECUTION`、`TIMED_OUT`、
  `MISSING_CHANNEL_EVIDENCE`、`GUIDANCE_DELIVERY_FAILED`、`RUNTIME_RESTARTED`、`NOT_FOUND`、
  `INVALID_STATE`、`CONCURRENT_MODIFICATION`、`GUIDANCE_CONTEXT_UNAVAILABLE`。
- 正文上限 16000 字符（非空、去空白后非空）。同一 `commandId` 重放返回**同一个**消息（幂等），
  并且重放读到的是**账本当前事实**而不是首次调用的快照——否则「重放一次」会变成「再投一次并撞上已关闭的 attempt」。
- **零新增确认**：FULL 与 STRICT 下都是同一条命令、同样的 0 步 0 等待。guidance **不是审批通道**；
  STRICT 的工具审批继续走既有 Attention（ADR-0004/0011/0040）。

### D06：不新增审批层、沙箱或门禁

本格不新增任何审批层、沙箱、信任流程或权限门禁，也不改变 STRICT 的既有语义。新能力只是「把用户的话送进
一个已经存在的会话」以及「在新 Execution 启动时带上它」，两者都不改变 Agent 的工具权限。ADR-0011 的
FULL 零确认不变。

### D07：schema v31（三张纯追加表）

- `session_guidance`：一条 guidance 的耐久记录。正文在这里（ADR-0010 D02 要求投递前先耐久保存），
  **不进 domain event**（ADR-0010 D06：事件只带 hash/长度）。`source` 的 CHECK **只列今天能产生的取值**
  （`'COMMAND'`）——ADR-0046 的教训；TUI 直接输入产生的 guidance 未实现，将来实现时需自己的一次迁移。
  `state` 的 CHECK 也不含任何「已确认」取值。
- `session_guidance_deliveries`：append-only 尝试台账（形状照 ADR-0028 的 revision delivery 台账，
  但词汇更弱）。**没有任何列可以写入「模型已读」**，这是刻意的：schema 不该提供一个只能撒谎的格子。
- `execution_guidance_contexts`：每次启动交付的产物事实（`UNIQUE(execution_id, context_digest)` 让重复启动
  幂等，guidance 集合变大时追加新行而不是覆盖旧行）。
- v31 是本步自己的号：v25=ADR-0039、v26=ADR-0041、v27=ADR-0044、v28=ADR-0046、v29=ADR-0052、v30=ADR-0053，
  **v16 永久未使用**，v22 按本波惯例跳过。迁移只追加 `if (version < 31)`，不重建任何表，
  升级后仍核验 `PRAGMA foreign_key_check` 为空。
- 新增两个 domain event（沿用 ADR-0035 的设计名）：`SessionGuidanceRecorded`、`SessionGuidanceDelivered`。
  后者是「一次尝试的结论」，`state` + `delivered` 如实表达是投递还是拒绝——它不是「已经交付」的同义词；
  只有 `state='DELIVERED'` 才是。

## Consequences

- 用户可以用一条命令对运行中的会话给出指导，并且能脚本化地读到「记录 / 投递 / 通道不支持」三种不同事实；
  不会再把「消息发出去了」读成「模型已经照做」。
- guidance 与 `task amend` 的分界在命令面上是显式的：改验收标准仍然要 `task amend`，旧验证仍然因此失效。
- 代价（如实记录）：没有通道的 provider（Claude Code 的活会话、Codex 的 `REQUIRES_VALIDATION`）下，
  `session guide` 只能记录并返回退出码 1；用户要用它指导**正在运行**的会话就必须用 Pi。
- guidance 会在每个新 Execution 启动时重复交付（同样是「用户说过的话」），这是刻意的：它比「只在当时那个
  进程里有效」更接近用户的预期，而 provider 侧没有「已被读取」的事实可以让我们避免重复。
- 会话记录会随 Task 增长；本格不提供「撤销/删除 guidance」（append-only 审计，删除需要新语义）。
- 未占用 v22，未使用任何新确认、新审批层、新沙箱。

## Verification

只用 CLI/命令面与 Runtime 命令面（含 storage 层）验证，不跑全量测试（ADR-0038）：

- `bun run typecheck`；定向：`bun test packages/agent-adapters/test`（含本格新增的
  `guidance-arguments.test.ts`、`pi-guidance-channel.test.ts`）、`bun test packages/storage/test`、
  `bun test apps/runtime/test/session-guidance.test.ts apps/runtime/test/session-guidance-migration.test.ts
  apps/runtime/test/cli-session-guidance.test.ts` 以及因新增能力位而逐字更新的既有 testing 文件。
- 钉住的不变量：`task amend` 产生 revision 并使旧证据不再适用，而 guidance 不产生 revision、不动
  Task 版本/revision、不写 `VerificationInvalidated`；guidance 正文不进事件；重复 `commandId` 幂等且读到
  账本当前事实；无通道 provider 记 `CHANNEL_UNSUPPORTED` 且零伪造 `DELIVERED`；
  successor/resume **确实**把已记录的 guidance 交给 provider（断言启动 argv/入参，而不是声称）；
  零 guidance 时 argv/入参逐字节不变；v30 → v31 在真实文件库上升级成功且 `PRAGMA foreign_key_check` 为空。
- **未验证**：真实模型是否读了 guidance；真实 Pi 在忙碌轮次里是否接受 `steer`（ADR-0051 的实测是在空闲
  session 上做的）；Codex `turn/steer`（能力位因此是 `REQUIRES_VALIDATION`）；TUI 直接输入产生的 guidance；
  UI 投影（N3 领地）。

## Related

- `PROJECT_SPEC.md` §1.1、§2 第 21 条、§6、§7；`docs/roadmap/mvp.md` Phase 3
- ADR-0010（双通道、安全点、单 writer、正文耐久与事件不含正文）、ADR-0011（FULL 零确认）
- ADR-0028（revision 投递的**严格** ACK 口径，本 ADR 说明为什么 guidance 不用它）
- ADR-0035（新事件用设计名）、ADR-0041/0051（知识交付的形状与「零知识不改 argv」先例）
- ADR-0044（能力位如实声明）、ADR-0046（CHECK 只列可产生的取值）
- `docs/architecture/event-model.md` §2.1/§2.3、`state-machines.md` §3、`agent-adapter-api.md`
- FOUNDATION-088（`docs/tasks/README.md`）
