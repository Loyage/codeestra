# ADR-0014 — Agent 结构化提问通道（Codeestra 自有问卷工具）

Status: Accepted

## Context

Pi 生态里有一个广泛使用的 `ask_user_question` 工具（`@juicesharp/rpiv-ask-user-question`）：模型可以一次问 1–4 个问题，每个问题带 2–4 个写了描述的可选项，并允许用户用自己的话回答。它在交互式 TUI 里体验很好。但 Codeestra 运行的 Agent **根本用不到它**：

- `buildPiRpcArguments` 是 `--no-extensions --extension <gate>` 的受控启动，只加载 Codeestra 的权限 gate。用户级 `~/.pi/agent/npm` 里的扩展不会加载，这是刻意的（同 revision + 同配置必须产生同一 argv 与同一证据哈希）。
- 真正实测把该扩展塞进受控启动后，它与 Codeestra 的 Attention 模型**粒度不匹配**：一次工具调用会变成 N 个 `select` dialog，即 N 条 Attention、N 次 `WAITING_FOR_USER` 状态抖动、N 次 CLI 往返。
- 更严重的是**静默取消**：RPC 路径下每个问题的选项被编码成 `"2. bun — ..."` 字符串，回答只要不是 `parseInt` 能识别的序号（例如手滑输入 `banana`），扩展就当成“用户按了 Esc”，整份问卷作废，模型只看到 `User declined to answer questions`；已经答好的前一题也一起丢失，而 Codeestra 侧那些 Attention 早已是 `DELIVERED`。CLI 的 `attention answer <id> value <任意文本>` 无法在任何一层发现这个错误。

因此当下的实际状态是：Codeestra 里的 Agent 需要决策时无法结构化提问，只能猜，或者把问题写进散文后结束轮次——而那种情况会被记为 `SUCCESS`，因为 Codeestra 没有任何机制把它识别为等待人工。

## Options

1. **把用户级 rpiv 扩展加进受控启动，只改善 Codeestra 端呈现。** 改动最小，但把一个路径与版本都在用户环境里的第三方包放进受控启动，破坏启动 determinism 与证据可复现性；而且保留 N 条 Attention、N 次往返与静默取消。
2. **不加工具，靠注入提示要求 Agent 用机器可读文本块提问。** 不需要扩展，但回答这类问题需要恢复一个已 `agent_settled` 的 Session（Adapter 目前不实现 resume），实现量更大，且正确性只靠提示词自律。
3. **Codeestra 自有的结构化提问通道（选定）。** 新增一个与 gate 并列、同样由受控启动显式加载的扩展，注册同名工具 `ask_user_question`，把一份问卷编码进**一个** provider dialog；Runtime 把这份问卷解码成**一条** Attention，并只接受经过校验的结构化回答。

## Decision

采用方案 3。

- **工具与形态**：新扩展 `packages/agent-adapters/src/pi-question-extension.ts` 注册 `ask_user_question`，schema 与 rpiv 对齐（1–4 题、2–4 个带 `description` 的选项、`multiSelect`、每题可选自由文本），使模型无需额外教学。参数在扩展内用契约 schema 再校验一次，非法问卷直接返回工具错误，不向用户展示。
- **一个决策 = 一条 Attention**。问卷整体放在 dialog `title`（`CODEESTRA_QUESTIONNAIRE:v1:<json>`，与 gate 用 `CODEESTRA_PERMISSION:` 承载工具指纹是同一手法），Codeestra 解码后存为带判别字段的 `prompt`（`kind: "codeestra.questionnaire"`）。这样保持“一条 Attention = 一个 provider 请求 = 一次 answer Operation”的既有不变量，同时避免 N 次状态迁移与 N 次往返。`options` 仍放人类可读的题目与选项，供原生 host 与日志降级查看。
- **回答是结构化的，不是字符串**。`AgentAnswer` 增加 `{ type: 'QUESTIONNAIRE', answer }`；CLI 用 `--choose <题>:<选项>[,<选项>]` 与 `--text <题>=<文本>` 表达，Web UI 用单选/多选与自由文本框表达。只有 Adapter 负责把它编码成 provider dialog 接受的字符串（provider 线格式属于 Adapter）。
- **非法答案必须报错，不得降级为拒绝**。契约层给出唯一的校验规则（越界、重复题号、重复选项、单选多选个数），Runtime 在记录任何东西之前按被问的那份问卷校验，失败返回稳定错误码 `INVALID_QUESTIONNAIRE_ANSWER:<PROBLEM>` 且不动状态；扩展端遇到读不懂的回答返回显式工具错误（“题目已展示，请勿当作拒绝”）。真正的拒绝只有 `CANCEL`（用户在 CLI/UI 上明确选了“拒绝回答”）。
- **部分回答允许，全部留空不允许**。未作答的问题作为 `(unanswered)` 回报给模型；“什么都不答”只能表达为 `CANCEL`。
- **受控启动不变**：仍是 `--no-extensions`，只多加载一个 Codeestra 自己的扩展；STRICT 的工具 allowlist 增加该工具，gate 把它列为无需审批（它不产生副作用，只读取用户意图）。
- **顺带修一处健壮性缺陷**：`mapPiExtensionUiRequest` 原先对未知 `extension_ui_request` method 抛 `PiRpcProtocolError`，会把 observation loop 打穿并让执行失败；现在未知 method 一律忽略，字段不匹配的 dialog 仍按可回答的问题降级上报，不会既挂住 Agent 又中断执行。

## Consequences

- Codeestra 里的 Agent 现在可以结构化提问，且提问会显式进入 `WAITING_FOR_USER`；它不能再用“结束轮次 + 散文问题”把未完成的工作伪装成 `SUCCESS`（本 ADR 只保证工具路径，散文路径的识别仍属后续工作）。
- 交互体验是 CLI/Web UI，不是 pi 的 TUI 问卷：没有 Tab 栏、Submit 复核页、逐题备注与并排 preview。这些属于 VSCode/Zed 那类宿主的原生 dialog 能力，Codeestra 的宿主是自己的命令面。
- 每个问题最多 4 个选项、整套最多 4 题；这是契约上限，也决定了 CLI `--choose` 的合法范围。
- `attention_requests.prompt_json` 现在会承载结构化问卷（题目与选项描述）。它是 Codeestra 自己生成的受控内容，不是 provider 原文，但也与 FOUNDATION-019 记录的“Attention prompt 是否摘要化”属于同一类需继续权衡的问题。
- 会话被回答后仍然沿用既有投递语义：投递失败是 `RECONCILE_REQUIRED`，不是重试即安全。

## Verification

- 契约测试（`packages/contracts/test/questionnaire.test.ts`）：上限、dialog title 编解码与外来 title/未来版本降级、回答 payload 往返、全部校验分支与 1 基错误文案。
- 扩展单测（`packages/agent-adapters/test/pi-question-extension.test.ts`）：一次 dialog 承载整份问卷、已回答/未回答逐题回报、自由文本原样保留、读不懂的回答是错误而非拒绝、无 UI 与非法问卷都不发问。
- Adapter 测试：问卷 title 被解码成单条 `QUESTION` Attention；`QUESTIONNAIRE` 回答被编码进 provider dialog；STRICT 允许该工具；未知 method 不再抛错；受控启动参数与 STRICT allowlist 断言更新。
- **命令面端到端**（`apps/runtime/test/cli-attention.test.ts`，协议 stub provider，**不是真实 Agent 集成证据**）：`task run` 阻塞等待 → `attention list` 出现一条带 `codeestra.questionnaire` 的 Attention → `--choose 1:9` 被 CLI 拒绝、`--choose 1:3` 被 Runtime 以 `INVALID_QUESTIONNAIRE_ANSWER:CHOICE_INDEX_OUT_OF_RANGE` 拒绝且 Attention 仍为 `OPEN` → `--choose 1:2 --choose 2:1,2` 被接受并投递 → stub 收到编码后的结构化回答 → `task run` 退出码 0、Session `EXITED`。另有一条对照：dialog 标题是普通文本时，结构化回答被 `NOT_A_QUESTIONNAIRE` 拒绝，而原始 `value` 路径仍可用。
- **真实 Pi 0.84.4 探针**（一次性脚本，非仓库内测试）：用 Codeestra 完全相同的 argv（`--mode rpc --approve --no-extensions --extension <gate> --extension <question>`）启动真实 `pi`，真实模型调用 `ask_user_question` 并携带两个问题——只产生**一个** `extension_ui_request`，title 为 `CODEESTRA_QUESTIONNAIRE:v1:…`；以编码回答响应后，工具返回 `The user answered 2 of 2 questions.` 并逐题列出所选与所写内容。该探针证明扩展在真实 provider 进程内可加载、可注册、可往返，但它是手工探针，不是仓库内可重复的验收。
- **未执行**：真实模型下经由 Codeestra Runtime 的完整 `task run`（会消耗真实额度）；浏览器目视确认（ADR-0008 测试边界，UI 正确性由类型检查与构建覆盖）。

## Related

- `PROJECT_SPEC.md` §2 不变量 9/10/11/18/21（Session 身份、仅暂停本 Task、revision 与接管边界、CLI 完备性）。
- ADR-0008/0011（效率至上、CLI 完备、默认 FULL 零确认）：本通道不新增任何确认；提问本身不是审批。
- ADR-0013（只读 transcript）：提问与回答可在会话文件与事件日志中观察，但该视图仍只是观察。
- `docs/architecture/agent-adapter-api.md`、`docs/architecture/event-model.md`（Attention → Answer 的既有语义）。
