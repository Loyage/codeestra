# Claude Code 2.1.268 Adapter Spike（FOUNDATION-066）

状态：**已完成（协议层）**。本文严格区分 **已实测**（附命令与原始输出）、**协议层可支持但未在真实模型下验证**、**未验证 / 不支持**。它是 ADR-0040 中能力矩阵的唯一依据；未实测的能力不写 `SUPPORTED`。

**关键前提（决定了本文的诚实边界）**：本机 `claude` 2.1.268 **没有可用凭据**，因此**没有任何一次真实模型调用**。所有"运行"证据都在**发出真实模型请求之前**结束（`initialize` 往返、`system/init`、鉴权失败帧、会话文件）。凡需要模型产生的行为（工具调用、审批往返、结构化提问、interrupt 后的工具静止、恢复对话内容）一律标为**未验证**。

## 0. 范围、环境与方法

- Provider：`claude` 2.1.268（`/etc/profiles/per-user/loyage/bin/claude` → Nix `claude-code-2.1.268`），macOS（darwin/arm64）。
- **凭据状态（实测）**：
  ```
  $ claude auth status
  {"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty",
   "projectsDirectory": "/Users/loyage/.claude/projects", "configDirectory": "/Users/loyage/.claude"}
  ```
  `env | grep -i anthropic` 无 `ANTHROPIC_API_KEY`；`~/.claude/.credentials.json` 不存在；首次 spike 前 `~/.claude/projects` 不存在。`initialize` 响应里的 `account` 始终是 `{"tokenSource":"none","apiProvider":"firstParty"}`。
- **未修改任何 `~/.claude` 配置或凭据，未打印任何 token。** spike 期间新增的会话文件与目录在 §1 说明。
- 观测方式：自写的 Node/Bun 驱动脚本直接 spawn 真实 `claude`，用 CLI 自己的 **LF-JSONL** 输出流与 **SDK control 协议**；不使用桌面、浏览器、键鼠或窗口自动化。
- spike 脚本与原始输出（全部在 `/tmp`，不入库）：`/tmp/ce-i2-spike/{init2.mjs,init3.mjs,unauth-run.mjs,probe-resume.mjs,probe-permmode.mjs,sanitize-probe.mjs,cfgdir-probe.mjs,argv-check.mjs}` 与同名 `.jsonl`/`.stderr.txt` 产物；夹具仓库 `/private/tmp/ce-i2-spike/repo`。
- **无凭据 `--print` 尝试共 3 次**（协调者授权 3 次；每次都因 `tokenSource:"none"` 停在鉴权失败，`total_cost_usd: 0`，未发出真实模型请求）：
  1. 完整 argv + 一个 user turn → 记录鉴权失败帧形状与 transcript 文件（§3.3）；
  2. `--resume <id>` + 一个 user turn → 记录会话是否按派生路径被加载（§3.5）；
  3. `--permission-mode bypassPermissions`（**不带** `--dangerously-skip-permissions`）+ 一个 user turn → 记录 argv 是否被接受（§3.6）。
- 另有**不发送 user turn** 的本地探针（`initialize` 往返，§3.1/§3.7）：CLI 对 `initialize` 的应答在本地产生，不触达模型；用到的次数多于 3，但都没有 user turn。

## 1. 结论摘要

| 问题 | 实测结论 |
|---|---|
| 程序化接口 | `claude --print --input-format stream-json --output-format stream-json --verbose` 是**双向 LF-JSONL**：stdin 收 user turn 与 `control_response`，stdout 出 `system/init`、`assistant`、`result`、`control_request`、`control_response`、`control_cancel_request`。单向 `--output-format stream-json` 没有应答通道，无法承载 fail-closed gate。 |
| 控制协议 | CLI 二进制内自带的协议文档与它自己的 SDK 客户端代码给出完整形状：`control_request{request_id,request:{subtype,...}}` / `control_response{response:{subtype:"success"|"error",request_id,response,error}}` / `control_cancel_request{request_id}`；subtype 集合含 `initialize`、`can_use_tool`、`interrupt`、`set_permission_mode`、`stop_task`、`request_user_dialog`、`elicitation`、`mcp_message` 等。 |
| 审批/权限通道 | `can_use_tool` 请求携带 `tool_name`/`input`/`tool_use_id`/`permission_suggestions`/`blocked_path`/`decision_reason`；host 回 `{behavior:"allow"|"deny", updatedInput?, updatedPermissions?, message?, interrupt?, toolUseID?}`。**真实模型下的 fail-closed 往返未验证**（无凭据）。 |
| 权限模式 | `--permission-mode manual`（cli 帮助里的拼写）= provider 文档里的 `default`（"prompts for dangerous operations"），实测 `initialize` 回读为 `default`；`bypassPermissions` 实测回读为 `bypassPermissions`，且**不需要** `--dangerously-skip-permissions` 就已经生效（§3.6）；`dontAsk` = 不提示、未预批即拒；`auto` = 模型分类器决定。 |
| 会话持久化 | `--session-id <uuid>` 可钉死我们自己生成的会话 id；`system/init` 回读同一 id；transcript 写到 `<configDir>/projects/<sanitize(realpath(cwd))>/<session-id>.jsonl`（实测 3 例派生规则 + 1 例 hook `transcript_path`）。 |
| 恢复 | `--resume <session-id>` 实测会**加载**记录的会话：`system/init` 与 `result` 都回报同一个 session id，且不报"会话不存在"（同一 cwd、同一 argv 下与新建会话的失败形状一致，差别只在 id 被保留）。**对话内容是否被复述未验证**（需要模型回答）。 |
| 受控启动 | 默认启动会加载 ambient 用户配置：实测 `~/.claude/settings.json` 的 `SessionStart` hook 被触发、用户 agent `statusline-setup` 出现在 `initialize` 响应里。`--safe-mode` 抑制该 hook 且不再列出该 agent；`--setting-sources ''` 也抑制 hook 但用户 agent 仍在；`--restricted` 同样抑制 hook。`--bare` 会**禁用 OAuth/keychain**（只认 `ANTHROPIC_API_KEY`），会破坏本机登录，**不可用**。 |
| 中断 / 协作停止 | 控制协议有 `interrupt` subtype（CLI 自己的客户端会发它）。**interrupt 后已在运行的工具是否停止、EOF/SIGTERM 是否留下孤儿，均未实测**（需要真实工具调用）。 |
| 结构化提问 | provider 有内置 `AskUserQuestion` 工具，控制协议里既能见到 `can_use_tool` 也能见到 `request_user_dialog`（带 `dialog_kind`）。**哪条路径投递、答案如何编码、如何判定"无法渲染"都没有实测**，因此本轮**不实现**问卷通道（见 ADR-0040 D4）。 |
| TUI / 终端接管 | 本项目不做：交互 TUI 与我们的 `--print` 子进程是同一 conversation 的两个 writer；ADR-0010/0023/0026 是 Pi 专属机制，**不套用**。`nativeTerminalHandoff`/`safePointNotification` 报 `UNSUPPORTED`。 |
| pause / revision ACK | 不存在 pause 原语；没有修订确认通道。 |

## 2. 已实测：命令行面

`claude --version` → `2.1.268 (Claude Code)`（Adapter 的 `probe()` 从这里取版本）。

`--help` 中与本 Adapter 相关的选项（原文摘录，逐字）：

- `-p, --print`：非交互输出；`--print` 或 stdout 非 TTY 时跳过 workspace trust 对话框，**验证失败的 settings 文件会被静默忽略**。
- `--input-format <format>`：`text`（默认）或 `stream-json`（realtime streaming input），只配 `--print` 使用。
- `--output-format <format>`：`text` | `json` | `stream-json`，只配 `--print` 使用。
- `--permission-mode <mode>`：`acceptEdits` | `auto` | `bypassPermissions` | `manual` | `dontAsk` | `plan`。
- `--permission-prompts <target>`：`--print` 下谁回答权限提示，`host`（SDK host 或 `--permission-prompt-tool`）或 `none`（没人：任何本会提示的操作自动被拒）。默认 `host`。
- `--safe-mode`：关闭全部自定义（CLAUDE.md、skills、plugins、hooks、MCP servers、custom commands/agents、output styles、workflows、themes、keybindings 等）；**Auth、模型选择、内置工具与权限照常**；admin/policy 设置仍生效；等价 `CLAUDE_CODE_SAFE_MODE=1`。
- `--bare`：跳过 hooks/LSP/plugin sync/attribution/auto-memory/prefetches/keychain reads/CLAUDE.md 自动发现；**Anthropic auth 只认 `ANTHROPIC_API_KEY` 或 `--settings` 里的 `apiKeyHelper`（OAuth 与 keychain 永不读取）**。
- `--strict-mcp-config`：只用 `--mcp-config` 里的 MCP server，忽略其它 MCP 配置。
- `--setting-sources <sources>`：逗号分隔的 `user,project,local`。
- `--session-id <uuid>`：为会话指定一个具体 UUID；`-r, --resume [value]`：按 session id 恢复（或交互选择）；`--no-session-persistence`：不落盘、不可恢复（只配 `--print`）。
- `--model <model>`：别名（`opus`/`sonnet`/…）或完整名；`--effort <level>`：`low|medium|high|xhigh|max`。
- `--dangerously-skip-permissions`：绕过全部权限检查；`--allow-dangerously-skip-permissions`：把该能力变成"可选"而不是默认。

二进制内自带的权限模式文档（原文）：

> Permission mode for controlling how tool executions are handled. 'default' - Standard behavior, prompts for dangerous operations. 'acceptEdits' - Auto-accept file edit operations. 'bypassPermissions' - Bypass all permission checks (requires allowDangerouslySkipPermissions). 'plan' - Planning mode, no actual tool execution. 'dontAsk' - Don't prompt for permissions, deny if not pre-approved. 'auto' - Use a model classifier to approve/deny permission prompts.

**因此 `manual` 不是"每个工具都审批"**：provider 的 `default` 只对"危险操作"提示，工作区内的文件编辑不需要提示。这与 Codex 的 `workspace-write` 是同一类边界。

## 3. 已实测：传输与控制协议

### 3.1 `initialize` 往返（本地应答，不触达模型）

```text
$ bun run /tmp/ce-i2-spike/argv-check.mjs --print --input-format stream-json --output-format stream-json \
    --verbose --safe-mode --strict-mcp-config --permission-prompts host --permission-mode manual \
    --session-id 22222222-3333-4444-8555-666666666666
--> {"type":"control_request","request_id":"ce-argv-1","request":{"subtype":"initialize"}}
<-- {"type":"control_response","response":{"subtype":"success","request_id":"ce-argv-1",
      "response":{"commands":[…45 项…],"agents":[…4 项…],"output_style":"default",
                  "available_output_styles":["default","Proactive","Concise","Explanatory","Learning"],
                  "models":[{"value":"default","resolvedModel":"claude-opus-5[1m]",…},…],
                  "account":{"tokenSource":"none","apiProvider":"firstParty"},
                  "current_permission_mode":"default","session_state":"idle",…}}}
EXIT 0
```

同一 argv 换成 FULL（`--permission-mode bypassPermissions --dangerously-skip-permissions --model 'claude-opus-5[1m]' --effort high`）→ `current_permission_mode: "bypassPermissions"`，退出码 0。**这就是 Adapter 实际启动使用的两套 argv（STRICT/FULL），已对真实 CLI 验证被接受并如实回读权限模式。**

`initialize` 响应字段（实测全集）：`commands, agents, output_style, available_output_styles, user_output_styles_dir, models, account, pid, current_permission_mode, analytics_disabled, remote_control_*, ide_rc_auto_enable_gate, fast_mode_state, fast_mode_disabled_reason, session_state`。

### 3.2 `system/init`（第一次 user turn 之后）

```text
<-- {"type":"system","subtype":"init","cwd":"/private/tmp/ce-i2-spike/repo",
     "session_id":"11111111-2222-4333-8444-555555555555","tools":[…23 项…],"mcp_servers":[],
     "model":"claude-opus-5[1m]","permissionMode":"bypassPermissions",
     "slash_commands":[…],"terminal_slash_commands":[…],"apiKeySource":"none",
     "claude_code_version":"2.1.268","output_style":"default","agents":["claude","Explore","general-purpose","Plan"],
     "skills":[…],"plugins":[],"capabilities":{…},"uuid":"…","fast_mode_state":"off",…}
```

- `session_id` = 我们在 `--session-id` 里给的值（**钉死成立**）。
- `permissionMode` 回读实际生效模式（FULL=`bypassPermissions`，STRICT=`default`）。
- `apiKeySource` 如实反映凭据来源（本机 `none`）。

### 3.3 终态 `result` 帧与鉴权失败形状（**关键事实**）

一次无凭据尝试（完整 argv + 一个 user turn）：

```text
$ bun run /tmp/ce-i2-spike/unauth-run.mjs
<-- system/init …
<-- assistant message.content=[{"type":"text","text":"Not logged in · Please run /login"}] model="<synthetic>"
<-- result {"duration_api_ms":0,"stop_reason":"stop_sequence",
            "session_id":"11111111-2222-4333-8444-555555555555","total_cost_usd":0,
            "usage":{…全 0…},"permission_denials":[],"terminal_reason":"api_error",
            "is_error":true,"num_turns":1,"subtype":"success",
            "result":"Not logged in · Please run /login", …}
EXIT 1
```

**失败可以以 `subtype:"success"` 到达**，真正的判定信号是 `is_error`（并有 `terminal_reason:"api_error"`）。只看 `subtype` 会把这次失败记成 `SUCCESS`。Adapter 因此同时检查 `subtype` / `is_error` / `terminal_reason`（`claudeResultVerdict`），并有定向测试固定这一形状。

### 3.4 受控启动：ambient 配置的实测差异

同一夹具仓库、同一 argv，只换控制选项（每次只发 `initialize`，无 user turn）：

| 启动选项 | `SessionStart` hook 帧 | `initialize.response.agents` |
|---|---|---|
| （无额外选项） | **触发**（`hook_started`/`hook_progress`/`hook_response` 三帧） | `claude, Explore, general-purpose, Plan, statusline-setup` |
| `--safe-mode` | 无 | `claude, Explore, general-purpose, Plan` |
| `--setting-sources ''` | 无 | 仍含 `statusline-setup` |
| `--restricted` | 无 | 仍含 `statusline-setup` |

`SessionStart` hook 来自用户级 `~/.claude/settings.json`（该文件的 `hooks` 键含 `SessionStart`/`UserPromptSubmit`/`Stop`/`PreToolUse`/`PostToolUse`/`PermissionRequest` 等）。结论：**默认启动确实把用户配置带进 Agent 输入**；`--safe-mode` 是本机可用的最小受控启动，且按 provider 文档保留 OAuth/模型选择/内置工具/权限。`--bare` 被排除的原因是它会关掉 OAuth 与 keychain（会破坏用户自己的登录）。

### 3.5 会话文件布局与 `--resume`

hook 输入（用一个由 `--settings` 注入的自有 hook 捕获，本地、无模型调用）：

```text
$ bun run /tmp/ce-i2-spike/init3.mjs
{"session_id":"fe343ff9-296f-4c84-b91a-576e153d6ca3",
 "transcript_path":"/Users/loyage/.claude/projects/-private-tmp-ce-i2-spike-repo/fe343ff9-….jsonl",
 "cwd":"/private/tmp/ce-i2-spike/repo","hook_event_name":"SessionStart","source":"startup"}
```

派生规则（`sanitize`）实测三例 —— **每个非 `[A-Za-z0-9]` 字符替换成单个 `-`，不折叠**：

```text
/private/tmp/ce-i2-spike/repo                    -> -private-tmp-ce-i2-spike-repo
/private/tmp/ce-i2-spike/Repo.With_Dots and spaces -> -private-tmp-ce-i2-spike-Repo-With-Dots-and-spaces
/private/tmp/ce-i2-spike/a..b--c__d               -> -private-tmp-ce-i2-spike-a--b--c--d
```

`CLAUDE_CONFIG_DIR` 实测可重定位 config home：

```text
$ CLAUDE_CONFIG_DIR=/tmp/ce-i2-spike/cc-home bun run /tmp/ce-i2-spike/cfgdir-probe.mjs
user_output_styles_dir= /tmp/ce-i2-spike/cc-home/output-styles  account={"tokenSource":"none",…}
```

一次无凭据尝试实际**写出了** transcript（`transcript_path` 与派生路径一致，16 行 JSONL：`queue-operation`/`user`/`assistant`/…），说明派生路径在开始第一次 turn 后即可用于归属校验。

`--resume` 实测（同 cwd，无凭据尝试）：

```text
$ bun run /tmp/ce-i2-spike/probe-resume.mjs   # argv 含 --resume 11111111-2222-4333-8444-555555555555
INIT   session_id= 11111111-2222-4333-8444-555555555555 model= claude-opus-5[1m] apiKeySource= none
RESULT subtype= success is_error= true session_id= 11111111-2222-4333-8444-555555555555 terminal_reason= api_error
EXIT 1
```

**会话被加载**（`system/init` 与 `result` 都回报被恢复的那个 id，没有"会话不存在"错误，也没有开新 id）。**但"同一 conversation 的内容被复述"没有验证**：那需要模型回答。

### 3.6 权限模式 argv 接受性

```text
$ bun run /tmp/ce-i2-spike/probe-permmode.mjs   # --permission-mode bypassPermissions（不带 danger flag）
INIT permissionMode= bypassPermissions
RESULT subtype= success is_error= true terminal_reason= api_error
EXIT 1
```

`--permission-mode bypassPermissions` **不带** `--dangerously-skip-permissions` 也被接受且回读为 `bypassPermissions`。Adapter 仍在 FULL 下显式传 `--dangerously-skip-permissions`：provider 自己的文档说 `bypassPermissions` 需要它，而 Codeestra 的 FULL 语义就是"主机级、零确认"（ADR-0011），显式传参让审计看到意图。

### 3.7 控制协议形状（来自 CLI 自带文档 + 它自己的 SDK 客户端代码）

CLI 二进制内嵌协议文档（原文摘录）：

- `can_use_tool requests this CLI process has issued and not yet resolved, so a client joining an already-initialized session learns about in-flight prompts…`（属 `initialize` 成功响应，Claude Code v2.1.268 起必有，可能是空数组）
- `Dialog kinds (request_user_dialog dialog_kind values) this consumer's onUserDialog can actually render. The CLI treats ABSENCE as 'cannot display' and fails closed: without the kind declared here, a dialog-gated flow degrades to its no-dialog behavior`（属 `initialize` **请求**）
- `Envelope for a control-protocol request, sent by either side on the same stream as the messages…` / `Envelope for the single reply to a control_request…` / `Tells the other side that the sender no longer needs the answer to one of its own in-flight control_requests…`

CLI 内自带 SDK 客户端对 `can_use_tool` 的处理（逐字取自二进制，可读性分段）：

```js
async processControlRequest(e, r) {
  if (e.request.subtype === "can_use_tool") {
    let n = await this.canUseTool(e.request.tool_name, e.request.input, {
      suggestions: e.request.permission_suggestions, blockedPath: e.request.blocked_path,
      decisionReason: e.request.decision_reason, title: e.request.title, displayName: e.request.display_name,
      description: e.request.description, defaultToNo: e.request.default_to_no,
      suppressAlwaysAllowRule: e.request.suppress_always_allow_rule,
      toolUseID: e.request.tool_use_id, agentID: e.request.agent_id, requestId: e.request_id, …
    });
    if (n === null) return fe;              // 本 host 不实现 → 静默
    return { ...n, toolUseID: e.request.tool_use_id };
  }
  …
}
```

答案形状（同一二进制内的校验文案 + 解析代码）：

- `Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}.`
- `updatedInput is missing or empty, falling back to original tool input`
- `type:"control_response",response:{subtype:"success",request_id:…,response:…}`
- `type:"control_response",response:{subtype:"error",request_id:…,error:…}`
- `control_cancel_request` 撤回自己发出、已不需要答案的请求。

Adapter 依此实现：`allow` → `{behavior:"allow", toolUseID}`（**不**发送 `updatedInput`：Codeestra 不会背着用户改写工具输入；缺失时 provider 回退到原输入）；`deny` → `{behavior:"deny", message, toolUseID}`；`CANCEL` → `{behavior:"deny", message, interrupt:true, toolUseID}`；`initialize` **不声明任何 dialog kind**（provider 文档明确：缺失即"无法显示"，dialog 流程退化到 no-dialog 行为 = fail-closed）。

## 4. 能力结论与 Adapter 处理

| Adapter 能力 | Claude Code 2.1.268 结论 | Codeestra 处理 |
|---|---|---|
| persistentSession | `SUPPORTED`（`--session-id` 钉死 + transcript 实测写在派生路径） | 记录 provider session id 与 transcript 路径 |
| structuredAttention | `REQUIRES_VALIDATION`（`AskUserQuestion` 工具存在，控制协议有 `can_use_tool` 与 `request_user_dialog`，但投递路径与答案编码未验证） | 本轮**不实现**问卷通道：所有 `can_use_tool` 一律映射为既有 `PERMISSION`/`CONFIRM` Attention |
| nativePermissionRouting | `REQUIRES_VALIDATION`（形状取自 provider 自己的协议实现与文档；真实 prompt 往返未观测） | FULL：`bypassPermissions`（+ danger flag）；STRICT：`manual`，提示转既有 Attention |
| pauseWithQuiescence | `UNSUPPORTED` | 无 pause 原语；修订走 ADR-0001/0028 的"停止 + 新 Execution" |
| revisionAcknowledgement | `UNSUPPORTED` | 不从自然语言推断 ACK |
| cooperativeStop | `REQUIRES_VALIDATION`（`interrupt` subtype 存在，但"已在运行的工具是否停止"未实测） | 只有确认**我们自己的子进程**已退出，才声称 writer 已停；否则报 `disconnected` 并记 `unconfirmedStops` |
| attach | `UNSUPPORTED` | 不实现、不伪装 |
| nativeTerminalHandoff | `UNSUPPORTED` | ADR-0010/0023/0026 是 Pi 机制，不套用 |
| safePointNotification | `UNSUPPORTED` | 控制通道没有工具级开始/结束通知，Runtime 无法知道安全点，必须拒绝交接 |
| reconnectToLiveSession | `UNSUPPORTED` | 丢失 `--print` 子进程后不重接 |
| resumeAfterExit | `REQUIRES_VALIDATION`（`--resume` 实测加载了记录会话；内容复述未验证） | 新 Execution + `--resume <id>`，并校验 transcript 归属 |
| controlledConfiguration | `SUPPORTED`（`--safe-mode --strict-mcp-config` 实测抑制用户 hook 与用户 agent，OAuth/模型/内置工具保留） | 受控启动；`--bare` 因会禁用 OAuth 而排除 |

## 5. 对设计的影响

1. 传输只用 `--print` + stream-json 双向控制通道；不引入 Claude Agent SDK 包（见 ADR-0040 D1）。
2. session 归属：`<configDir>/projects/` 是唯一可信会话根；恢复时必须满足「direct child of `projects/`、文件名为 `<session-id>.jsonl`、普通文件（非 symlink）」。
3. 终态判定必须同时看 `subtype`/`is_error`/`terminal_reason`（§3.3）。
4. 结果帧只结束 **turn**；`--print` 会话会继续等待输入，所以 Adapter 先**关闭 stdin 并确认子进程退出**，才发 `completed`（否则报 `disconnected`，不让 Runtime 进入恢复路径时不带现场）。
5. `initialize` 的 `current_permission_mode` 回读被用作**生效值校验**：请求的模式与回读不符即 `INVALID_PROVIDER_RESPONSE`，不允许"以为跑了 bypassPermissions 其实是别的模式"。
6. ADR-0012 配置映射：`model` → `--model`；`thinkingLevel` → `--effort`（仅 `low/medium/high/xhigh/max`，`off`/`minimal` 明确拒绝）；**没有 provider 启动参数**，因此该 scope 拒收 `provider`。

## 6. 未验证 / 不支持（明确列出）

**未验证（本机无凭据，需要真实模型）**：

- `can_use_tool` 的真实往返与 fail-closed 性（提示期间工具是否确实等待、deny 后工具是否确实不执行）；
- `interrupt` subtype 之后已在运行的工具是否停止；EOF/SIGTERM/SIGKILL 是否留下孤儿（对照 Pi/Codex 的 FOUNDATION-040 测量）；
- 结构化提问（`AskUserQuestion`）的真实投递路径（`can_use_tool` 还是 `request_user_dialog`）与答案编码；用户批准 `AskUserQuestion` 后 provider 是否会在无人渲染的 dialog 上等待（风险已知，用户可取消/停止任务）；
- `--resume` 是否真的复用同一 conversation 内容（只验证了会话被加载、id 被保留）；
- 多工具批次、`--include-partial-messages`、`--include-hook-events` 的帧形状；`set_permission_mode` 运行时切换；
- Windows；Claude Code 版本升级后的协议兼容（该控制协议未见"experimental"标注，但版本升级仍可能改动）。

**不支持 / 不做**：

- pause、revision ACK、attach、live process 重连、原生终端交接、安全点通知；
- `--bare`（会禁用 OAuth/keychain）、`--permission-prompts none`（会静默拒绝而不是把提示交给 Codeestra）；
- 修改用户 `~/.claude` 配置或凭据；不打印 token。

**已知缺口（不在本格范围）**：`session.transcript`（ADR-0013）仍只认 Runtime 的 Pi 会话目录，因此 Claude Session 上会以 `SESSION_FILE_NOT_OWNED` 明确失败，而不是显示执行过程；把该视图做成 provider-agnostic 需要另立一格。
