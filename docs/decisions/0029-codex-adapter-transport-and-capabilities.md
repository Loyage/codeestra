# ADR-0029：第二个真实 Adapter（Codex）的传输选择、能力矩阵与权限映射

Status：Accepted（Phase 5 第一小步：接入第二个真实 Agent Adapter）。
**Amends**：无。**Amended by**：暂无。
关联：`docs/spikes/codex-0.151.0.md`（全部实测命令与原始输出）、ADR-0008/0011（默认 FULL 零确认、CLI 完备、测试边界）、ADR-0012（Agent 配置作用域）、ADR-0014（结构化提问通道）、ADR-0023/0026（STRICT Attention 与 Pi 专属 PTY 交接，**不套用到 Codex**）。

## Context

Phase 5 要求「Pi、Codex、Claude Code 接入；能力矩阵和一致性测试；失败后新 Execution 可更换 Agent」，并且
「Core 无供应商类型依赖；不支持的交互/恢复能力明确反馈」。当前 Runtime 只有一个真实 Adapter（Pi RPC
子进程）加一个 deterministic fake。

D2 格的任务是接入本机已有的第二个真实 provider（Codex，`codex-cli 0.151.0`），并且：

1. 先用 spike 实测它到底给出什么程序化接口，再决定接什么；
2. 能力矩阵必须诚实，**不得**把 Pi 专属的 attach/PTY handoff/incarnation 硬套到 Codex；
3. 失败后换 Agent 走既有路径（新 Execution），不引入热切换。

实测结论（`docs/spikes/codex-0.151.0.md`）：Codex 有两个程序化面——单向的 `codex exec --json` 事件流，
和双向的 `codex app-server --stdio`（LF-JSONL / JSON-RPC 2.0，含审批请求、结构化提问、`turn/interrupt`、
`thread/resume`）。它**没有** pause/resume 原语、**没有**修订确认通道、**没有**把交互 TUI 附到我们持有的
stdio 子进程的机制，并且 `app-server` **没有** `--ignore-user-config`。

## Options

### D1. 传输

- A. `codex exec --json`：一次性 headless 运行，JSONL 事件。
- B. `codex app-server --stdio`：JSONL JSON-RPC 双向通道。
- C. `codex mcp-server` / `exec-server`：把 Codex 暴露成工具或远端执行服务。

选 **B**。A 是单向的：没有审批应答通道、没有结构化提问、没有 interrupt，接入它只能把
`nativePermissionRouting` 报成 `UNSUPPORTED`，等于放弃 STRICT gate；C 的语义方向相反（Codex 作为被调用方），
不是 Codeestra 主 Agent 的执行通路。B 的代价是它被标注为 experimental，且协议会随版本变化——因此 Adapter
把协议形状集中在 `codex-protocol.ts` 一处，并记录协议可用 `codex app-server generate-json-schema` 自描述。

### D2. STRICT 的权限来源

- A. 复刻 Pi 的做法：加载 Codeestra 自己的 gate 扩展。
- B. 复用 Codex 自己的审批策略：STRICT 用 `approvalPolicy: "untrusted"` + `sandbox: "workspace-write"`，
  把 provider 的审批请求映射到**既有** Attention 通道；FULL 用 `approvalPolicy: "never"` +
  `danger-full-access`（零确认）。
- C. 自己包一层沙箱/代理做二次审批。

选 **B**。A 不可能（Codex 没有 Pi 那种扩展 UI 协议）；C 会新增权限门禁与审批层，违反 ADR-0008/0011，而且
实测证明不需要：STRICT 下命令在客户端应答前**不会执行**（fail-closed），`decline` 让命令以
`status:"declined"` 结束且 `exitCode: null`，`accept` 才执行。

选择 B 的已知边界（必须诚实记录）：Codex 的审批粒度是**命令级 + 沙箱策略**，不是 Pi 的逐工具 allowlist；
`workspace-write` 沙箱内的文件编辑不需要审批，`item/fileChange/requestApproval` 仅在越界写时出现。因此
「STRICT 下每个工具都被审批」这句话对 Codex **不成立**，能力矩阵与文档按实际语义写。

### D3. interrupt / 非正常结束的完成证据

- A. `turn/completed status:"interrupted"` 也投影为 `completed`（FAILURE）。
- B. 投影为 `disconnected`（Runtime 侧进入恢复路径）。

选 **B**。实测：`turn/interrupt` 立即返回、turn 状态变 `interrupted`，但**已开始的 shell 工具继续运行并正常
`exit 0`**（marker 在 interrupt 之后才写入）。`agentStopEvidenceSchema` 把 `toolsQuiescent` /
`ownedWritersStopped` 定为字面量 `true`，此时没有任何诚实的 `completed` 可发。

同理，`turn/completed` 到达后 Adapter 会停掉自己的 app-server 子进程；**只有确认它退出**才发 `completed`，
否则发 `disconnected`（Pi 的 Adapter 在这种情况下发 `completed` 并把 pid 记进 `unconfirmedStops`；本 ADR
选择更严格的语义：不确认 writer 归属就不声称完成）。

### D4. 恢复的身份与归属

- A. 信任数据库里记录的 rollout 路径与 thread id。
- B. 路径必须是本次启动的 `CODEX_HOME/sessions` 下的**普通文件**（非 symlink），按 `threadId` 恢复，并核对
  provider 返回的 thread id 与 rollout 路径与记录一致，否则 `SESSION_IDENTITY_MISMATCH`。

选 **B**。协议 schema 明确 `thread/resume` 对非运行中 thread 的优先级是 `history > 非空 path > threadId`，
只传 id 并核对返回 path 才能把「恢复的是同一个 conversation」变成可验证事实（实测返回同 id、同 path）。

### D5. attach / 原生终端交接

- A. 把 ADR-0010/0023/0026 的 Pi 机制套到 Codex（TUI attach、incarnation、writer lease）。
- B. **不实现**，能力矩阵报 `attach: UNSUPPORTED`。

选 **B**。Codex 的交互 TUI 走共享的本地 app-server daemon（`codex agents` / `codex queue` / `resume`），
与我们持有的 `--stdio` 子进程不是同一个 writer；把它当成 attach 就是伪造能力。若将来要做，必须有独立的
spike 与 ADR，而不是复用 Pi 的实现。

### D6. 新增能力字段 `controlledConfiguration`

- A. 不建模（能力矩阵保持 9 项）。
- B. 增加一项 `controlledConfiguration`：能否在启动时排除 ambient 用户配置。

选 **B**。Pi 用 `--no-extensions --extension <gate> --no-skills ...` 完全受控，报 `SUPPORTED`；Codex
`app-server` 没有 `--ignore-user-config`，实测 ambient plugin/MCP/hook 参与执行、provider 自带
`<recommended_plugins>` 会进入模型输入。这是"同一 revision 的输入是否可复现"的实质差异，必须能表达。
新增字段是**必填**的，因此三个 Adapter（Pi/Codex/fake）与测试夹具都显式声明；README 与 CLI 不变。

## Decision

1. **传输**：`codex app-server --stdio`，LF-JSONL JSON-RPC；`codex-protocol.ts` 负责 framing、方法名、
   payload 解析与答案编码，`codex-process.ts` 负责一个子进程的 stdio 与请求/应答/服务端请求路由，
   `codex-adapter.ts` 实现既有 `AgentAnswerAdapter` + `AgentProcessRelease` port。`adapterId = "codex"`。
2. **受控启动**：`codex app-server --stdio [-c model_reasoning_effort=<level>] [--enable default_mode_request_user_input]`。
   `model` / `modelProvider` 走 `thread/start`（按 Execution 解析，ADR-0012），不在进程启动时钉死。
   结构化提问工具只在 `--enable default_mode_request_user_input` 下存在（under development），因此它是
   **显式选项**（registry 由 `CODEESTRA_CODEX_REQUEST_USER_INPUT=1` 打开），默认关闭并在能力矩阵如实反映。
3. **权限映射**：FULL = `never` + `danger-full-access`（零确认）；STRICT = `untrusted` + `workspace-write`，
   审批请求 → 既有 `PERMISSION`/`CONFIRM` Attention，`CONFIRM true/false` → `accept`/`decline`，
   `CANCEL` → `cancel`。**不**提供 `acceptForSession` 或 execpolicy amendment（那会静默扩大后续权限）。
   不新增审批层、不新增确认（ADR-0008/0011）。
4. **能力矩阵**（实测，见 spike §4）：
   `persistentSession: SUPPORTED`、`structuredAttention: SUPPORTED|UNSUPPORTED`（随开关）、
   `nativePermissionRouting: SUPPORTED`、`pauseWithQuiescence: UNSUPPORTED`、
   `revisionAcknowledgement: UNSUPPORTED`、`cooperativeStop: REQUIRES_VALIDATION`、
   `attach: UNSUPPORTED`、`reconnectToLiveSession: UNSUPPORTED`、`resumeAfterExit: SUPPORTED`、
   `controlledConfiguration: UNSUPPORTED`。
5. **Agent 配置**：`agentConfigurationEnvironmentVariables` 增加 `codex`
   （`CODEESTRA_CODEX_PROVIDER/MODEL/THINKING`），项目/全局 scope 由既有 `agent config` 命令面覆盖。
6. **CLI**：`task run --adapter codex` 无需改动（既有 `--adapter` 分支）；usage 列出可用 adapter；
   `task resume` 新增可选 `--adapter`（默认仍是 `pi`，行为不变），因为 resume 会重开 predecessor 的
   provider conversation，换 Agent 必须是显式请求。
7. **失败后换 Agent 的现状（重要）**：Adapter 层满足「每次 Execution 一个主 Agent、换 Agent 建新
   Execution」。但 Runtime 目前**没有** FAILED → READY 的路径：实测 `task run` 一个 FAILED Task 返回
   `INVALID_STATE: Workspace cannot be reserved while Task is FAILED`，`task resume` 亦拒绝。因此
   「Execution 失败后用新 Execution 换 Agent」今天只能在 **Execution 建立之前失败**（probe/start 失败，
   Task 仍 READY）或 **pause → resume** 路径上发生。补 retry/requeue 属于 domain/scheduler/storage
   （D1 领地与本格文件领地之外），本 ADR 不实现，只把它记录为 Phase 5 的未完成项。
8. **不实现**：attach、PTY/handoff、pause、revision ACK、live process reconnect、`dangerously-bypass-*`
   绕过策略的启动方式。不修改用户 `~/.codex` 配置或凭据；不打印 token。

## Consequences

- Core（`packages/domain`、`packages/storage`、runtime 服务）不出现任何 Codex 类型：Codex 只存在于
  `packages/agent-adapters/src/codex-*.ts` 与 registry 的注册行。`capabilities` 继续以 JSON 记录。
- FULL 下 Codex 与 Pi 都是 0 次确认；STRICT 下 Codex 的审批走**同一个** Attention/answer 命令面，CLI 与 UI
  不需要为第二个 provider 增加任何命令。
- 诚实代价（必须随能力矩阵一起读）：
  - `controlledConfiguration: UNSUPPORTED`：ambient `$CODEX_HOME` 的 plugin/MCP/hook 会改变 Agent 输入，
    同一 revision 的可复现性弱于 Pi。实测还发现 provider 会**写**自己的全局配置（在临时仓库首次 `codex
    exec` 后自行向 `~/.codex/config.toml` 追加了 `[projects."…"] trust_level = "trusted"`，spike 结束时已
    还原）——即 Codex 的运行会改动 Codeestra 之外的持久状态。缓解手段（把 `CODEX_HOME` 指向 Codeestra 自有目录）
    需要用户提供的凭据文件，属未决项，不在本轮实现。
  - `cooperativeStop: REQUIRES_VALIDATION`：杀 provider 不终止已开始的工具（孤儿风险，与 FOUNDATION-040
    对 Pi 的测量一致）；取消仍依赖 Runtime 的协作停止 + 归属核验，超时进入恢复。
  - `attach: UNSUPPORTED`：Phase 3 的接管能力对 Codex 用户不存在，Runtime 明说而不是降级。
  - `turn/interrupt` 语义：interrupted 不产生完成证据，会走 `RECOVERY_REQUIRED`；这是保守而非便利的选择。
  - Codex app-server 是 experimental；协议变化会让 Adapter 明确失败（`INVALID_PROVIDER_RESPONSE` /
    `COMMAND_REJECTED`），不会静默错读。
- 跨 provider 恢复 fail-closed：把 Codex 的 rollout 路径交给 Pi Adapter 会被拒绝
  （`AGENT_START_FAILED: The resumed session file is not inside the Runtime Pi session directory`），
  实测见 `apps/runtime/test/cli-codex-adapter.test.ts`。不存在「悄悄开一段新对话」的降级。

## Verification

真实集成（真实 `codex` 0.151.0 + 真实登录 + `gpt-5.5`，命令与原始输出见 `docs/spikes/codex-0.151.0.md`）：

- `CodexAdapter.probe()` 读真实版本；STRICT 真实审批请求 → `PERMISSION` Attention → `answer(accept)` →
  命令真的执行、文件真的生成；FULL 无 Attention、`approvalPolicy: never`；两个独立 Adapter 实例跨进程
  `thread/resume` 返回同 thread id 与同 rollout 路径，且 provider session file 只有**一个** conversation。

Stub 证据（`bun test packages/agent-adapters/test/codex-adapter.test.ts`，21 项）：

- 受控 argv 与 `thread/start` 策略参数（FULL/STRICT）、revision prompt、`thread/resume` 与继续 prompt、
  resume 路径越界 `RESUME_SESSION_NOT_OWNED`、恢复身份不符 `SESSION_IDENTITY_MISMATCH`；
- 审批请求 → Attention → `{decision}` 写回（accept/decline）、结构化提问 → 问卷 → `answers` 写回、
  不合约问题降级为普通 QUESTION 且单题 VALUE 可用、未实现的 server request 被显式拒绝（-32601）；
- `turn/completed failed` → `FAILURE` + provider 原因；可重试 `error` 通知与 item error 不构成 turn 失败；
  意外退出 → `disconnected`；interrupted → `disconnected`（不声称静止）；陈旧 cursor 与无 live 进程被拒绝；
  重复应答被拒绝；`releaseSession` 确认子进程退出。

CLI/命令面证据（`bun test apps/runtime/test/cli-codex-adapter.test.ts`，5 项）：

- STRICT 下 `permission set strict` → `open --yes` → `task run --adapter codex` → `attention list` 看到
  `PERMISSION`/`CONFIRM` → `attention answer … confirm no` → Session EXITED，stub 收到 `{decision:"decline"}`；
- FULL 下无任何 Attention；
- probe 失败的 run attempt 之后，Task 仍 READY，`task run --adapter pi` 建立**新的** Execution 并成功；
- `agent config set --adapter codex` 只影响 Codex 启动（`-c model_reasoning_effort=high` + `thread/start`
  的 `model`/`modelProvider`），Pi scope 不受影响；
- pause → `task resume --adapter codex` 重开同一 thread（stub 收到 `thread/resume`）；`--adapter pi`
  被 fail-closed 拒绝。

未跑的检查与原因：真实模型驱动完整 CLI 流程（`task run --adapter codex` 对真实 provider）未做——本格只把
真实 provider 用于 Adapter 本体 smoke；`item/fileChange` 与 `item/permissions` 审批、多工具批次 interrupt、
Windows 未验证（spike §6 已列）。schema 未改动（v18 不变）。

**已知文档不一致（需一次 doc-sync）**：`docs/architecture/agent-adapter-api.md` 的类型清单仍写 9 项
`AdapterCapabilities`，尚未包含新增的 `controlledConfiguration`（沿用 ADR-0019/0027 对架构文档的先例：
本格不动架构文档，在此显式记录）。

## 关联文档

- `docs/spikes/codex-0.151.0.md` — 实测命令、原始输出、能力结论与分级证据。
- `docs/tasks/README.md` 的 `## FOUNDATION-049` — 本格交付与验证记录。
- ADR-0012（配置作用域）、ADR-0014（结构化提问）、ADR-0023/0026（STRICT Attention 与 Pi PTY 交接的边界）。
