# ADR-0043 — 散文提问升级为一等等待（真正补上 ADR-0004/0014 未做的那半截）

状态：**Accepted**（用户已就默认升级、通道形状、恢复语义、schema、范围与命令形状逐条拍板）。
任务：FOUNDATION-069。基线：`dev = fd3d99871a40e578105036bc6728213adf302c6a`。**无 schema 变更、不占迁移号。**

## 背景

FOUNDATION-056 识别了「Agent 不用工具、在散文里提问并结束轮次」的形态，并把它记录为稳定码
`PROSE_QUESTION_NO_TOOL_USE`（provider 原始事实 + `executions[].session.completion.note` +
`AgentSessionCompleted` payload）。那一格明确**只记录、不改状态机**：Completion 仍是 `SUCCESS`，
Task 仍停在 `RUNNING`，没有任何 Attention。

这留下了 ADR-0004 与 ADR-0014 语义里明确未做的一半：

- ADR-0004 要求 Runtime 不得**无期限静默挂起**，也不得假装成功。一个 provider 进程已经退出、
  什么都没做、只在散文里问了一句的 Task，停在 `RUNNING` 且没有任何等待事实，正是「静默挂起」：
  用户不主动去读 note 就永远不会知道该回答什么。
- ADR-0014 建立了结构化的 `ask_user_question` 通道（一问一 Attention），但那条通道需要 provider
  仍在等待一个 dialog；散文提问没有 dialog，因此当时被排除在外。

## 决策

### D01 默认升级；降级必须显式

命中 note 时默认（`auto`）把它升级为**一等等待事实**：`tasks.state = WAITING_FOR_USER` 加**一条**
Attention。理由是效率与诚实：用户立刻在 `task status` 与 `attention list` 里看到「有人要回答我」，
而不是一个看起来正常、实际无人推进的 Task。

同时提供**显式降级**，因为启发式必然有误报（FOUNDATION-056 已如实声明）：

- `settings prose-question-attention auto`（默认）：note + 等待。
- `settings prose-question-attention record-only`：FOUNDATION-056 的原行为——只记 note，不记等待。
- `settings prose-question-attention off`：连 note 都不记。

该开关是**设置**而非门禁：一个命令、零确认、`--json`、退出码稳定（ADR-0008/0011）。它是全局
Runtime 设置（`$CODEESTRA_HOME/prose-question-attention.json`，与 permission mode 同构），
不按项目、不占 schema；写入原子替换，读取发生在 Session 启动时，因此不重启 Runtime 即生效，且
**永不回溯修改已经记录的等待**。

### D02 复用既有 Attention 通道，零 schema 变更

散文等待写成一条普通 `attention_requests` 行：`kind='QUESTION'`、`response_type='VALUE'`、
`status='OPEN'`，用 `prompt_json.kind='codeestra.prose-question'` 承载 FOUNDATION-056 的 note
（code / heuristic / message / text / 截断标记 / 原始 facts）。

`provider_request_id` 是 `NOT NULL` 且 `UNIQUE(session_id, provider_request_id)`，而散文提问**没有**
provider 请求，因此记录一个 Runtime 自己可识别的派生值
`codeestra-prose-question:<providerEventId>`，而不是复用真实 provider id 或留空。

### D03 只暂停该 Task；不伪造活着的 provider

`Session` 保持 `EXITED`、`Execution` 保持 `RUNNING`，只有 `Task` 进入 `WAITING_FOR_USER`
（不变量 10：`WAITING_FOR_USER` 只暂停对应 Task）。进程真的退出了、Execution 真的仍持有 workspace，
所以这个三元组是**事实的**组合，不是伪装：「等待」在这里的含义是「人必须决定下一步」，而不是
「provider 在等一个应答」。因此不把 Session 改回 `WAITING_FOR_USER`，也不让 `getObservableAgentSession`
把一个已死的会话当成可观察/可投递的。

### D04 与完成同事务；按 provider event 与 command 双重幂等

升级投影发生在 `recordAgentCompleted` **同一事务**内：要么同时记下「这次完成」和「这条等待」，
要么都不记。重放同一 provider event 由既有 adapter event 去重短路为 `duplicate`，绝不产生第二条
Attention、第二个 `TaskStateChanged`。

Task 不处于 `RUNNING` 时（例如用户正在停止它），等待被**跳过**而**不是**让完成投影失败：note 照旧
记录，不写入任何等待行。让一次并发的停止把完成事实弄丢，比少记一条等待更糟。

### D05 解除是一等命令，且什么都不投递

新命令 `attention resolve <project-id> <attention-id>`，恰好二选一：

- `--dismiss [--note <text>]` → `DISMISSED_FALSE_POSITIVE`：判定是误报，记录并解除。
- `--answer <text> [--note <text>]` → `ANSWERED`：用户确实回答，文本入账。

两者都把 Task 还原为 `RUNNING`（`Execution` `RUNNING`、`Session` `EXITED`），Attention 置
`CLOSED`，并写一条 `attention_answers` 审计行（actor + resolution + text/note）。**不投递 provider、
不新建 Execution、不 resume conversation、不投递 Session Guidance**，结果里如实写
`deliveredToProvider: false`。理由：provider 进程已经退出，任何「投递成功」都会是谎报；而
「回答后回到同一 conversation 继续」需要复用 pause/resume 的 successor 接线，属于另一格的产品
语义，本格不猜。

### D06 回答不是 TaskRevision

记录回答**不**修改 specification，不创建 TaskRevision，不代表任何验证被满足；`task amend` 的
既有语义（旧 revision 的验证不能作为新 revision 的证据）一字不改。

### D07 每条拒绝都有稳定码，并且零写入

- `attention answer` 目标是散文等待时返回 `PROSE_QUESTION_RESOLUTION_REQUIRED`，指向正确命令，
  **绝不**写一个不存在的 provider 响应。
- `attention resolve` 的不匹配各有其码：`PROSE_QUESTION_ATTENTION_NOT_PROSE_QUESTION`
  （先看 prompt 形状：provider dialog 必须走回答通道）、
  `PROSE_QUESTION_ATTENTION_ALREADY_RESOLVED`、`PROSE_QUESTION_SESSION_NOT_EXITED`
  （不丢弃活的会话）、`PROSE_QUESTION_EXECUTION_NOT_RUNNING`、`PROSE_QUESTION_TASK_NOT_WAITING`
  （含一切终态：绝不复活）、`PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD`（`ANSWERED` 必须带文本、
  `DISMISSED` 不许夹带文本、长度上限）。
- 所有拒绝在写入任何行之前抛出，事务回滚，因此拒绝路径零写入（有测试断言）。

### D08 审计面

- `UserAttentionRequested`（复用既有事件名，payload 增加 `proseQuestion: true`，明确「背后没有
  provider dialog」）。
- `ProseQuestionAttentionResolved`（新事件，ADR-0035 设计名规则）：`resolution`、
  `answerText`、`note`、`actor`、`deliveredToProvider: false`。
- `TaskStateChanged`：`RUNNING → WAITING_FOR_USER`（升级）与 `WAITING_FOR_USER → RUNNING`
  （解除），reason 写明「没有 resume 任何 provider conversation」。
- `attention_answers` 行作为用户输入的落账。
- **刻意不写 `ANSWER_AGENT` intent**：没有 Agent 收到这条回答，编造那条 intent 就等于谎报投递。

### D09 非目标

Codex 侧事实层（`codex-adapter` 仍不报 facts，因此仍只漏报不谎报）、`apps/ui/**` 投影、真实模型
验收、新增任何确认/审批/门禁/隔离、schema 变更，全部明确不在本格。

## 被否掉的选项

| 选项 | 否决理由 |
|---|---|
| 新增 attention `kind` 值（如 `PROSE_QUESTION`） | 需要 v25 迁移重建 `attention_requests` 的 CHECK；v25 已分配给其它 lane，而 `prompt.kind` 已经能无歧义区分，收益不足以占号。 |
| 新建等待表/在 `tasks` 加等待列 | 同样要 schema 变更，且 `attention list` 看不到，需要另建读取面。 |
| 只记录 + 显式升级命令（不自动） | 用户已拍板默认自动：只记录仍然留下「Task 停在 RUNNING 且无人知道」的静默挂起（ADR-0004）。 |
| 分级置信（高置信自动、低置信只记录） | 需要第二套阈值，而唯一规则已经很窄；分级在这里只能是猜测，维护成本最高。 |
| 回答后自动新建 Execution 并 `--session` resume 同一 conversation | 会把「回答」变成投递语义，并牵扯 pause/resume 的 successor 接线；本格保守，留待单独决策。 |
| 让 `attention answer` 直接处理散文等待 | 投递路径会按「这个 Attention 是什么」路由到 provider answer 通道，写一个不存在的请求响应。 |
| 把 Session 改回 `WAITING_FOR_USER` 以复用既有解除路径 | 会把已退出的 provider 会话伪装成可投递的活会话。 |

## 后果

- 新增公共命令面：`attention resolve`、`settings prose-question-attention [auto|record-only|off]`；
  新领域模块 `packages/domain/src/prose-question-attention.ts`；新事件
  `ProseQuestionAttentionResolved`。**无 schema 变更、无新迁移、`migration.ts` 未被触碰。**
- 新增一个此前不存在的聚合组合：`Task WAITING_FOR_USER` + `Execution RUNNING` + `Session EXITED`。
  它只由散文等待产生，也只由 `attention resolve` 结束。任何依赖「Task 等待 ⇒ Session 也在等待」
  的代码/文档都必须按这个组合重新核对。
- 默认行为发生变化：FOUNDATION-056 时代「散文提问后 Task 停在 RUNNING」现在只在 `record-only`
  下出现。`apps/runtime/test/cli-prose-question.test.ts` 因此显式降级到 `record-only`，它继续
  钉住 FOUNDATION-056 的契约；默认路径由新 e2e 文件覆盖。
- 不新增确认、审批或门禁：升级、降级、解除各是一个命令、零等待。

## 验证要求

- `bun run typecheck` 退出码 0。
- `packages/domain/test/prose-question-attention.test.ts`：升级/降级/关闭、prompt 往返校验、
  解析参数校验、以及「只有记录的那套状态才允许解除」的完整拒绝矩阵。
- `packages/storage/test/prose-question-attention.test.ts`：状态与事件同事务、provider event 重放
  不产生第二条、command 重放幂等、拒绝路径零写入、非 RUNNING Task 跳过等待、终态不复活。
- `apps/runtime/test/agent-observation-service.test.ts`：默认 `auto` 走通（note + 等待 + 三事件）、
  `record-only` 与 `off` 的严格更少行为。
- `apps/runtime/test/cli-prose-question-attention.test.ts`：真实 CLI + 真实 Runtime + 临时 home/仓库
  + 协议 stub provider；`task status --json` / `attention list` 读到等待、`attention answer` 被稳定
  拒绝、`--answer`/`--dismiss` 收口、第二次解除被拒、用法错误 exit 2、`settings` 三个取值。
- **未验证（不得当作已成立）**：真实模型是否会频繁命中该启发式、真实 provider 的 resume 路径
  （本格未实现）、Codex 事实层、UI 投影、以及在一个真实 provider 下对「停止/暂停与散文等待同时
  发生」的复验。
