# ADR-0051 — Project Knowledge 交给 Provider、Codex 完成事实、`applyRevision` 评估结论（FOUNDATION-079）

Status：Accepted（编码阶段的语义由本 ADR 固定；ADR 编号 0051 由协调者裁决分配——L2 占用 0050；位于 `agent-runtime-service.ts` 的两处改动亦由协调者授权，见 D04）

相关：`PROJECT_SPEC.md` §2 不变量 15、§4；ADR-0028（revision 投递确认、「消息发出去了 ≠ 已确认」）、ADR-0029（Codex 传输与能力矩阵）、ADR-0040（Claude Code 传输与能力矩阵）、ADR-0041（Project Knowledge 分层与 Execution 绑定，本 ADR 补齐其「Provider 侧消费未验证」的一半）、ADR-0043（散文提问升级）、ADR-0044（插件选择：受控启动零选择逐字节相同的先例）、ADR-0011（FULL 零确认）

## Context

三个缺口都属于「能力/载荷面已存在，但 Adapter 侧没接上」：

1. **Project Knowledge 只到 Runtime 边界。** ADR-0041 已经做到：每 Execution 物化一个 Markdown 文件到 `<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md`，把逐条 + 整体 digest、`mainRef`/`mainCommit` 与**Runtime 相对**的 `contextPath` 记进 `execution_knowledge_snapshots`，并把 `knowledgeSnapshotRefs` 交给 Adapter。但 `packages/agent-adapters/**` 对 `knowledgeSnapshotRefs` **零命中**：引用里只有 `knowledge-snapshot:<digest>` 与 `knowledge-entry:<layer>:<path>#<digest12>`，既没有内容也没有路径，所以没有任何 provider 真的收到过这份知识。ADR-0041 如实写着「Provider 侧消费未验证」，本 ADR 就是那一半。
2. **Codex 没有完成事实层。** `AgentCompletionFacts`（工具调用数、最后一段 assistant 文本、是否截断、provider 自己的 stop reason）与 `executions.session.completion.note` 的形状已经在 ADR-0043/FOUNDATION-056 定义并被 Pi 实现（`collectCompletionFacts`）；Codex 的 `observe` 只报 `SUCCESS`/`FAILURE`，于是 Codex 的运行永远拿不到 `PROSE_QUESTION_NO_TOOL_USE` 这条 note，也永远不该被判成「没做事」。这属于**漏报**（可接受），但补齐它才是「等价事实」。
3. **没有 Adapter 实现 `applyRevision`（ADR-0028 的投递端口）。** Runtime 侧 `revision-delivery-service.ts` 的能力门控与台账已经就绪：`revisionAcknowledgement != SUPPORTED` → `CHANNEL_UNSUPPORTED`，声明 `SUPPORTED` 但没有端口 → 同样 `CHANNEL_UNSUPPORTED`，只有带 evidence 的结构化 ACK 才算 `ACKNOWLEDGED`。缺的是「三个 provider 到底有没有真通道」这个事实判断。

必须遵守的既有语义：FULL 零确认、STRICT 按 ADR-0023/0011（本 ADR 不动任何门禁）；受控启动的 `--no-*` 与 gate 顺序不变；「零选择时 argv 与现状逐字节相同」（ADR-0044 的先例）；机器生成知识**永不进入 Task worktree**（ADR-0041 D05 的结构事实）；Codex 的 completion 只能在自己子进程确实退出、且能力允许时发出（ADR-0029）；「消息发出去了 ≠ 已确认」（ADR-0028）。

## Options

**知识注入的载体：**

- (A) 在 contracts 上新增一个可选载荷 `AgentKnowledgeContext { filePath, digest, bytes }`：Runtime 从**该 Execution 自己记录的绑定**回读路径与 digest，Adapter 在启动前读文件核验 digest，再按各 provider 自己的通道交给 provider。缺点：要多一个字段与一处 Runtime 解析。
- (B) 复用 `knowledgeSnapshotRefs`：把绝对路径塞进引用字符串。否掉——引用格式由 domain 的 `knowledgeSnapshotRefs` 冻结、被既有断言与 ADR-0041 的语义绑定（「一条指向一个条目的引用」），改它是规格变更，而本格不该改规格。
- (C) 把物化文件写进 Task worktree 让 provider 从 cwd 发现。否掉——ADR-0041 D05 已实测：worktree 里的文件会进 `git add --all`、会让并发 Task 被判 `SAME_FILE`；这是被明确否决过的选项。
- (D) 只把引用交给 provider，由 provider 自己去 Runtime 数据目录读。否掉——引用里没有路径，且 provider 无法也不该知道 Runtime home。

**交给 provider 的方式（是否统一）：**

- (A) 每个 provider 用它**自己真实存在**的通道：Pi `--append-system-prompt <file>`（Pi 自己的 `resolvePromptInput` 对已存在路径读文件内容）、Claude Code `--append-system-prompt-file <file>`、Codex app-server `thread/start`/`thread/resume` 的 `developerInstructions` 字符串。
- (B) 发明一个统一抽象（例如统一「知识文件路径」环境变量或统一 `--knowledge` 约定），三个 provider 都照它实现。否掉——provider 没有这个约定，任何统一层都只是我们编出来的旁路，无法用 provider 自己的证据验证，且会伪装成「三者一致」。

**Runtime 侧取 home 的方式（协调者裁决）：**

- (A)【选定】`startReservedExecution` 增加可选 `runtimeHome`，并在 `agent-runtime-service.ts` 的**两处**调用点传入（主启动 `startReservedExecution`、successor/resume 的 `adapter.start`）。
- (B) 只在 `agent-start-service.ts` 内用 `runtimeHome(Bun.env)` 推导。否掉——服务内读全局环境不利测试，且 successor/resume 路径仍拿不到。
- (C) 在 `adapter-registry.ts` 把 runtime home 传给三个 Adapter，由 Adapter 自己拼绝对路径。否掉——路径解析分散到 Adapter，且 successor/resume 仍覆盖不到。

**`applyRevision`：**

- (A)【选定】**维持 `UNSUPPORTED`**：三个 provider 都只有「把消息送进运行中的会话」的通道，没有任何 provider 侧事实能证明「新修订已在运行中的会话生效」；按 ADR-0028 不得把传输接受当确认，也不得从模型散文推断 ACK。
- (B) 用 provider 的结构化输出（Codex `turn/start.outputSchema`）让模型回一个「已接受修订 X」的 JSON，并把它当 ACK。否掉——那是**模型的自我陈述**，不是 provider 对运行中会话状态的事实；ADR-0028 的原文正是「不从自然语言推断 ACK」，给同一件事套一个 JSON schema 不改变它的性质；而且它要求 Agent 恰好空闲且配合，否则会静默变成投递失败。
- (C) 为 Pi 写一个 Codeestra 自有 extension，注册一个「确认修订」工具，把工具调用当结构化 ACK。否掉——这是**发明通道**（本格明令不做），而且工具调用仍然只证明模型说了「我读到了」，不证明运行中的会话指令已被替换。

## Decision

### D01 知识交给 provider 的载荷：可选、纯追加、零知识即不出现

- `packages/contracts/src/index.ts` 新增 `AgentKnowledgeContext { filePath: string; digest: string; bytes: number }`，并以**可选字段** `AgentStartRequest.knowledgeContext`（纯追加）承载。`filePath` 必须是绝对路径，且指向 Runtime 自己的数据目录，不是 worktree 路径。
- Runtime 侧由 `knowledgeContextStartArgument()`（`apps/runtime/src/agent-start-service.ts`）从 `storage.getExecutionKnowledgeSnapshot(executionId)` 回读，并解析成 `<runtimeHome>/knowledge/<project-id>/<contextPath>`（与 `writeRuntimeKnowledgeFile` 用同一个根），且**核验解析结果仍在该根之内**。
- **零知识 == 现状**：绑定缺失，或绑定的 `entryCount === 0`（物化文件只剩来源页眉、没有条目）时**不产生** `knowledgeContext`，受控启动的 argv/入参与本次改动之前逐字节相同。这一条由三个 Adapter 的逐项断言覆盖（Pi/Claude 的完整 argv、Codex 的 `thread/start` 参数与 `app-server --stdio` argv）。

### D02 每个 provider 用自己的通道，不伪造统一抽象

| Provider | 通道 | 交给 provider 的东西 | 实测依据 |
|---|---|---|---|
| Pi | `--append-system-prompt <绝对路径>` | 已核验的文件**路径**（Pi 自己读内容） | Pi 0.85.1 的 `resolvePromptInput`：`existsSync(value)` 为真则 `readFileSync(value)`，否则按字面文本注入 |
| Claude Code | `--append-system-prompt-file <绝对路径>` | 已核验的文件**路径** | 真实 CLI 2.1.268：未知选项会 `error: unknown option`（exit 1），该选项被接受；CLI 自身帮助把这对选项写作 `--append-system-prompt[-file]` |
| Codex | `thread/start` / `thread/resume` 的 `developerInstructions` | 已核验的文件**内容**（字符串） | `codex app-server generate-json-schema`（0.154.0）中 `ThreadStartParams`/`ThreadResumeParams` 的 `developerInstructions`；真实 app-server 接受该字段且不报错 |

- 路径 vs 内联是**按 provider 的事实**决定的：Pi 与 Claude 的选项本来就接受文件，argv 因此保持有界；Codex 只有字符串字段，所以内容内联（走 stdin 的 JSON-RPC，不受 `ARG_MAX` 限制，但受 Codex 客户端单条记录上限约束——超过即启动失败，不截断）。
- 不新增 `AdapterCapabilities` 字段：本维度没有「支持/不支持」的二值语义（三者都能收到，差别在通道形态），加一个能力位反而会变成我们自己的统一抽象。

### D03 Adapter 侧 fail-closed 核验：读不到就不启动

- 新增 `packages/agent-adapters/src/knowledge-context.ts`：`readVerifiedKnowledgeContext()` 要求路径为绝对路径、`lstat` 为普通文件（符号链接/目录一律拒绝）、**原始字节的 sha256 等于记录的 digest**、字节数等于记录的 `bytes`、且内容为合法 UTF-8；任何一条不成立都抛 `KNOWLEDGE_CONTEXT_UNAVAILABLE`。
- 三个 Adapter 在**任何进程被 spawn 之前**做这次核验，并把失败映射成各自错误类型里的同一个稳定码 `KNOWLEDGE_CONTEXT_UNAVAILABLE`（`startMayHaveOccurred: false`）。理由：静默少注入会把「这个 Execution 用了知识 K」变成假陈述，与 ADR-0041 D04 同一条不变量。
- Pi/Claude 把**同一个已核验路径**交给 provider；Codex 用**已核验的文本**。区别与理由见 D02。核验与 provider 自己读文件之间存在理论上的 TOCTOU 窗口，本 ADR 如实记录：物化文件由 Runtime 写、在 Execution 存在之前写完、且只有 Runtime 写它，但没有引入锁。

### D04 Runtime 侧取 home：绑定存在却没有 home 就是拒绝（协调者授权的两处改动）

- `startReservedExecution` 新增可选 `runtimeHome`；有绑定且 `entryCount > 0` 却没有 home → 抛 `KNOWLEDGE_CONTEXT_UNAVAILABLE` 并**拒绝启动**，绝不静默降级为「没有知识地启动」。
- `apps/runtime/src/agent-runtime-service.ts` 的改动**仅两处**（主启动的 `startReservedExecution` 调用、successor/resume 的 `adapter.start` 调用各传 `this.#runtimeHome`）。这两行超出本格任务书最初的「允许改」清单，由协调者在开工前明确授权，理由是：不覆盖 successor/resume，知识注入就只在首次启动生效，而 ADR-0028 的 pause→resume 与 ADR-0026 的 terminal handoff successor 都是同一 Execution 的合法继续。授权事实记录在此，避免下一位读者把它当成未经批准的越界。

### D05 门禁、权限与 Git 事实不变

- 不新增权限门禁、审批层、信任流程或沙箱；FULL 仍是零确认，STRICT 仍按 ADR-0023/0011；受控启动的 `--no-*` 集合与 gate/question extension 顺序不变（知识追加在既有参数之后，与 ADR-0044 的插件追加同一位置原则）。
- 机器生成层仍然只写 Runtime 数据目录：本 ADR 没有引入任何写入 Task worktree 的路径。Task worktree 内不出现 `knowledge-context.md`、不出现 `.codeestra/generated/`，由 Runtime 级测试断言。
- 人工层与机器生成层在物化文件里逐条可区分（每条带 `layer: instructions|skills|generated` 与 `digest`），并在 Runtime 级测试里断言两层同时出现且可分辨。

### D06 Codex 完成事实层与 Pi 语义对齐（无新增决策）

- `codex-protocol.ts` 新增 `newCodexFactAccumulator` / `collectCodexCompletionFacts` / `codexCompletionFacts`，`codex-adapter.ts` 的 `observe` 在**每一个**通知上收集事实，并在带 `completed` 的事件上原样附上 `facts`：
  - `toolCallCount`：只数 Codex **自己**命名为工具调用的 item 类型（`commandExecution`/`fileChange`/`mcpToolCall`/`dynamicToolCall`/`collabAgentToolCall`/`webSearch`/`imageGeneration`），按 provider 的 item id 去重（`item/started` 与 `item/completed` 只算一次）；不认识的 item 类型**永不**算作工具调用。
  - `finalAssistantText`：只取**已完成**的 `agentMessage` item 的 `text`（半截 delta 不是「Agent 最后说的话」），按 2000 字符截尾并如实置 `finalAssistantTextTruncated`。
  - `finalAssistantStopReason`：**恒为 `null`**——Codex 不报每条消息的 stop reason，turn 终态已由完成事件本身承载，拿它冒充消息级事实会是另一种编造。
- `disconnected`（崩溃、中断、未能确认停止）**不带** `facts`：「这次没有完成」与「这次没用工具」是两个不同的事实。Codex 的 completion 仍然只在子进程确实退出后才发（ADR-0029 不变）。
- Adapter 不因事实产生任何 Attention（Attention 是 Runtime 的判定），因此「不误报」。

### D07 `applyRevision`：三个 provider 一律维持 `UNSUPPORTED`（评估结论）

真实 CLI 实测（完整命令与输出见 `docs/tasks/README.md` 的 FOUNDATION-079 记录）：

- **Pi 0.85.1 `--mode rpc`**：把消息送进运行中的会话的通道**存在**（RPC `prompt`（含 `streamingBehavior`）、`steer`、`follow_up`）。实测 `{"type":"steer","id":"req_3","message":"probe"}` → `{"id":"req_3","type":"response","command":"steer","success":true}` **加上**一条 `{"type":"queue_update","steering":["probe"],"followUp":[]}`：provider 自己说的是「已入队」，不是「已生效」。不存在任何 revision/指令替换类命令（同次实测：未知命令 `{"type":"apply_revision"}` → `{"success":false,"error":"Unknown command: apply_revision"}`）。
- **Codex 0.154.0**：`codex app-server generate-json-schema --out` 列出 97 个 client 方法，其中有 `turn/steer` 与 `thread/inject_items`（投递通道），没有 revision-apply/ack 方法。真实 app-server 实测：`turn/steer` 需要当前活跃 turn（`{"error":{"code":-32600,"message":"Invalid request: missing field \`expectedTurnId\`"}}`），其响应类型 `TurnSteerResponse` 只有 `{ turnId }`；`thread/inject_items` 往模型可见历史追加条目，响应为空对象。两者都只证明「写进去了」。
- **Claude Code 2.1.268**：控制协议只有 `initialize`/`interrupt`/`can_use_tool`（本仓库 `claudeControlSubtypes` 与实测一致）。真实 CLI 实测：未知子类型 → `{"type":"control_response","response":{"subtype":"error","request_id":"probe-1","error":"Unsupported control request subtype: apply_revision"}}`；`interrupt` 成功但只回 `{"still_queued":[]}`。

结论：**三个 provider 都没有「在不停止会话的前提下把修订交给运行中的 Agent，并拿到可核验 ACK」的通道**。因此本格不实现任何 `applyRevision`，不把 `revisionAcknowledgement` 改成 `SUPPORTED`；Pi/Codex/Claude 维持 `UNSUPPORTED`，投递仍走既有「协作停止 + 新建 successor Execution」，只有停止后新建并被读回确认 `applied_revision_id` 才算确认（ADR-0028）。这是合格的交付：价值在于把「为什么不可行」用命令与输出固定下来。

## Consequences

- **本格能证明的**：受控启动确实把该 Execution 绑定的知识交给了 provider；交给 provider 的内容与该 Execution 记录的 digest/字节数一致、路径可追溯；人工层与机器生成层在物化文件里可分辨；没有知识时启动参数逐字节不变；知识文件不出现在 Task worktree；Codex 的完成事实与 Pi 同形状同语义；三个 provider 的 revision ACK 通道评估有真实 CLI 依据。
- **本格不能证明的（不得写成已验证）**：provider 是否**真的读了**这份知识、模型是否真的按它行动——那需要真实模型验收（本格全程未发任何真实模型请求）；「Pi 会读指定的文件」来自 Pi 源码的路径解析规则，「Claude 的 `--append-system-prompt-file` 语义是读这个文件」来自 CLI 自身帮助与选项被接受的事实（未经真实模型确认）；Codex 的 `developerInstructions` 被 provider 接受只证明字段合法，不证明模型看到它。
- **已知边界**：核验与 provider 读文件之间存在 TOCTOU 窗口（D03）；Codex 的内联知识受单条 JSON-RPC 记录上限约束，超限是启动失败（不截断）；物化文件在 provider 侧的可见性是「provider 自己读」，Codeestra 不复制、不缓存。
- 没有新增确认、没有新增门禁、没有 schema 迁移、没有新表/新列。

## Verification

- `bun run typecheck`：exit 0。
- `packages/agent-adapters/test/knowledge-context.test.ts`（新）：记录一致时返回原文；缺文件、digest 不符、字节数不符、相对路径、目录、符号链接、非 UTF-8 各自被拒（稳定码 `KNOWLEDGE_CONTEXT_UNAVAILABLE`）。
- `packages/agent-adapters/test/{pi,claude,codex}-adapter.test.ts`：零知识时 argv/参数与改动前逐字节相同；有知识时 Pi 追加 `--append-system-prompt <绝对路径>`、Claude 追加 `--append-system-prompt-file <绝对路径>`、Codex 在 `thread/start`/`thread/resume` 带 `developerInstructions`（内容等于文件原文、且 argv 不变）；digest 不符时拒绝启动且**没有** provider 进程被创建。
- `packages/agent-adapters/test/codex-adapter.test.ts`：完成事实的四种 stub 序列（用过工具 / 没用工具且散文提问 / 明确失败 / 断连与中断）——只记录 provider 报过的事实，不认识的 item 不算工具调用，断连不带 `facts`，事实不产生 Attention。
- `apps/runtime/test/agent-runtime-service.test.ts`：主启动把绑定记录的 `filePath`/`digest`/`bytes` 交给 Adapter，文件内容 digest 与记录一致，人工层与机器生成层同时出现且可分辨，worktree 内无物化文件；successor（`startAutomationSuccessor`）重开同一会话时携带同一份知识；零知识时 `knowledgeContext` 为 `undefined`（绑定 `entryCount: 0`）；有绑定却没有 runtime home 时拒绝。
- `apps/runtime/test/task-control-service.test.ts`：pause→resume 的 continuation Execution 仍收到它自己绑定记录的知识（与 predecessor 的 snapshot digest 相同）。
- `apps/runtime/test/cli-knowledge.test.ts`（**CLI 级端到端，真实 Runtime + 协议 stub provider**）：provider 的启动 argv 里恰有一次 `--append-system-prompt`，其值是 Runtime 数据目录里的物化文件、内容与该 Execution 记录的绑定逐字节一致、位于 Task worktree 之外，且 `--no-context-files`/`--no-extensions` 仍在。
- 真实 CLI 探针（未发任何模型请求，全部显式限时）：`pi --mode rpc --no-session` 的 `get_state`/未知命令/`steer`；`codex app-server --stdio` 的 `initialize`/`thread/start`/`turn/steer`/`thread/inject_items`/带 `developerInstructions` 的 `thread/start`；`claude --print --input-format stream-json --safe-mode --strict-mcp-config` 的未知控制子类型与 `interrupt`，以及 `--append-system-prompt-file` 与未知选项的对照。

## 关联文档

- `docs/tasks/README.md` FOUNDATION-079（命令原文、输出与逐项结果）
- `docs/architecture/agent-adapter-api.md`（能力矩阵：`revisionAcknowledgement` 仍 `UNSUPPORTED`）
- ADR-0041（D05 结构事实不变）、ADR-0028（投递确认不变量不变）、ADR-0043/FOUNDATION-056（note 形状不变）、ADR-0044（零选择逐字节相同的先例）
