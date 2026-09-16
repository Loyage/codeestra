# Codex 0.151.0 Adapter Spike（FOUNDATION-049）

状态：**已完成**（真实本机 `codex` 0.151.0 + 真实 ChatGPT 登录会话 + 真实模型 `gpt-5.5`）。
本文严格区分 **已实测**（附命令与原始输出）、**未验证**、**不支持/做不到**。它是 D2 格 Adapter 与能力矩阵的唯一依据；未实测的能力不写 `SUPPORTED`。

## 0. 范围、环境与方法

- Provider：`codex` 0.151.0（`/etc/profiles/per-user/loyage/bin/codex` → Nix `home-manager-path/bin/codex`），macOS（darwin/arm64），已登录：`codex login status` → `Logged in using ChatGPT`。**未修改任何 `~/.codex` 配置或凭据，未打印任何 token。**
- 真实模型：`gpt-5.5`（`process.argv`/`-m` 显式指定）。本机默认 `model = "gpt-6-astra"` 在当前 CLI 版本下被服务端以 400 拒绝（见 §3.2），因此所有真实调用显式指定 `gpt-5.5`；这不是 Adapter 行为，是 provider/CLI 版本组合事实。
- 网络：`HTTP(S)_PROXY=http://127.0.0.1:7897`、`ALL_PROXY=socks5://127.0.0.1:7897`（本机代理）。直连会 `request timed out`（§3.2 记录了原始错误），Adapter 不注入代理，继承 Runtime 环境。
- 观测方式：自写 Node 驱动脚本 + `codex app-server --stdio` 的 **LF-JSONL / JSON-RPC 2.0** 通道；不使用桌面、浏览器、键鼠或窗口自动化。
- spike 脚本与原始输出（全部在 `/tmp`，不入库）：
  - `/tmp/ce-d2-spike/exec1.jsonl`、`exec2.jsonl`（`codex exec --json` 原始 JSONL）
  - `/tmp/ce-d2-spike/appserver-probe.mjs`（initialize/thread/start）
  - `/tmp/ce-d2-spike/appserver-turn.mjs`（审批 decline 路径）
  - `/tmp/ce-d2-spike/appserver-run.mjs`（`success` / `accept` / `interrupt` / `sigterm` 四种模式）
  - `/tmp/ce-d2-spike/appserver-resume.mjs`（跨进程 `thread/resume`）
  - `/tmp/ce-d2-spike/appserver-question.mjs`（结构化提问）
  - `/tmp/ce-d2-spike/adapter-smoke.ts`、`adapter-resume-smoke.ts`（**真实 Codex + 真实模型**驱动 `CodexAdapter` 本体的 smoke）
  - `/tmp/ce-d2-spike/proto/schema/`（`codex app-server generate-json-schema` 的 262 个 v2 协议 schema）
- 夹具仓库：`/tmp/ce-d2-spike/repo`（`git init` 的临时仓库）。spike 期间创建的 Codex thread 在 `~/.codex/sessions/` 下，结束后用 `codex delete <id>` 清理。

## 1. 结论摘要

| 问题 | 实测结论 |
|---|---|
| 可用的程序化接口 | 两种：`codex exec --json`（单向 JSONL，无交互通道）与 `codex app-server --stdio`（**双向 JSON-RPC 2.0 over JSONL**，含审批请求、结构化提问、`turn/interrupt`、`thread/resume`）。**Adapter 选用 app-server**，因为它才有可承载 fail-closed gate 的请求/应答通道。 |
| 会话持久化 | `thread/start` 返回稳定 `thread.id`（UUID）与 rollout 文件路径 `<CODEX_HOME>/sessions/<Y>/<M>/<D>/rollout-*.jsonl`。跨进程 `thread/resume {threadId}` 恢复同一 thread id、同一路径、同一 conversation（实测复述前一轮 secret）。 |
| 审批/权限通道 | **有**：服务端→客户端请求 `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` / `item/permissions/requestApproval`，客户端回 `{decision}`。实测 **fail-closed**：命令在应答前不执行；`decline` → `item.completed … status:"declined"` 且命令未运行；`accept` → 命令运行且 `exitCode: 0`。 |
| 取消/中断 | `turn/interrupt {threadId,turnId}` 立即返回 `{}`，得到 `turn/completed status:"interrupted"`。**但已开始的 shell 工具不会被终止**：interrupt 后 `sleep 22` 仍存活并正常 `exit 0` 写入了 marker。 |
| 退出/崩溃时子进程 | 对 app-server 发 `SIGTERM` 不会终止在跑的工具；`sleep 22` 继续运行并在 ~22s 后写入 marker（与 FOUNDATION-040 对 Pi 的测量一致）。 |
| 结构化提问 | 协议有 `item/tool/requestUserInput`（含 questions/options/isOther）。**默认模式下该工具不可用**（provider 报 `request_user_input is unavailable in Default mode`）；加 `--enable default_mode_request_user_input`（under development）后实测可触发并接受结构化答案。 |
| 配置受控性 | **做不到**：`app-server` 不接受 `--ignore-user-config`（`codex exec` 有），实测 `-c mcp_servers={}` 也未阻止用户的 plugin/MCP 运行时与 `~/.codex/hooks.json` hooks 参与本轮（日志中出现 `node_repl`/`cua_repl`/`codex_apps` 启动与 `session-start`/`user-prompt-submit`/`pre-tool-use` hook）。 |
| TUI/终端接管 | **本项目不做**：Codex 的交互 TUI 走共享 app-server daemon（`codex agents`/`codex queue`/`resume`），与我们持有的 stdio 子进程不是同一 writer；把它当作 attach 会伪造能力。ADR-0010/0023/0026 的 Pi 专属交接**不套用到 Codex**。 |
| pause / revision ACK | 不存在 pause/resume 原语；没有修订确认通道。 |

## 2. 已实测：`codex exec --json`（对照面）

```text
$ codex exec --json -s read-only -m gpt-5.5 -C /tmp/ce-d2-spike/repo \
    "Reply with exactly the token PONG and nothing else. Do not use any tools."
{"type":"thread.started","thread_id":"01a09f98-6827-7c40-a76b-343e9bfa878d"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PONG"}}
{"type":"turn.completed","usage":{"input_tokens":19760,"cached_input_tokens":4480,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0}}
```

事件类型集合（实测出现）：`thread.started`、`turn.started`、`item.completed`（`agent_message` / `error`）、`turn.completed`（带 `usage`）、`turn.failed`（带 `error.message`）、`error`（如 `Reconnecting... 2/5 (request timed out)`）。

退出后恢复：

```text
$ codex exec --json -m gpt-5.5 resume 01a09f98-6827-7c40-a76b-343e9bfa878d \
    "Repeat exactly the single token I previously asked you to reply with. Do not use any tools."
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"PONG"}}
{"type":"turn.completed", ...}
```

结论：`exec --json` 是**单向**事件流，没有审批请求、没有结构化提问、没有 interrupt 命令；用户配置里 `notify` hook 等仍参与（本机 config 有 `notify = [... turn-ended]`）。它适合作为"最小可用"参照，但不足以承载 STRICT gate，因此不作为 Adapter 传输。

## 3. 已实测：`codex app-server --stdio`

### 3.1 协议自描述与握手

```text
$ codex app-server generate-json-schema --out /tmp/ce-d2-spike/proto/schema   # 退出码 0，262 个 v2 schema 文件
```

```text
--> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"ce-spike","version":"0.0.0"}}}
<-- {"id":1,"result":{"userAgent":"ce-spike/0.151.0 (Mac OS 26.6.2; arm64) ...","codexHome":"/Users/loyage/.codex","platformFamily":"unix","platformOs":"macos"}}
--> {"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"/tmp/ce-d2-spike/repo","model":"gpt-5.5","approvalPolicy":"never","sandbox":"workspace-write"}}
<-- {"id":2,"result":{"thread":{"id":"01a09f9b-...","path":"/Users/loyage/.codex/sessions/2026/09/14/rollout-...jsonl","status":{"type":"idle"},"cwd":"/tmp/ce-d2-spike/repo"},
     "model":"gpt-5.5","approvalPolicy":"never","sandbox":{"type":"workspaceWrite",...}}}
<-- {"method":"thread/started", ...}
```

- 帧是**一行一个 JSON 对象**（LF 分隔）；`initialize` 必须先于其它方法。
- `-c` 覆盖语法与 `--enable <feature>` / `--disable <feature>` 可用；`app-server` **没有** `--ignore-user-config`。
- `thread/start` 接受 `cwd` / `model` / `modelProvider` / `approvalPolicy` / `sandbox` / `config`，并把生效值回读给我们（Adapter 可以核对）。

### 3.2 真实模型失败会作为 turn 失败返回

```text
$ codex exec --json ...   # 不指定模型，走本机 config 的 gpt-6-astra
{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}
{"type":"item.completed","item":{"id":"item_2","type":"error","message":"Falling back from WebSockets to HTTPS transport. request timed out"}}
{"type":"error","message":"{\"detail\":\"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.\"}"}
{"type":"turn.failed","error":{"message":"{\"detail\":\"The 'gpt-6-astra' model requires a newer version of Codex. ...\"}"}}
```

结论：provider 的失败以 `turn.failed` / `turn/completed status:"failed"` 表达；**不得**把它记成 SUCCESS。`Reconnecting...` 期间还有 `willRetry: true` 的 `error` 通知，因此"看到 error 就判失败"是错的，必须以 turn 终态为准。

### 3.3 审批通道：fail-closed，可 allow 可 deny

`approvalPolicy:"untrusted"` + `sandbox:"workspace-write"`，prompt = 运行 `echo hello-from-codex`：

```text
<-- item/started {"item":{"type":"commandExecution","id":"call_w658...","command":"/bin/zsh -lc 'echo hello-from-codex'","status":"inProgress"} ...}
<-- REQUEST item/commandExecution/requestApproval id=0 params={"kind":"command","threadId":"01a09f9a-...","turnId":"01a09f9a-...",
      "itemId":"call_w658...","command":"/bin/zsh -lc 'echo hello-from-codex'","cwd":"/tmp/ce-d2-spike/repo",
      "availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{...}},"cancel"]}
### answering item/commandExecution/requestApproval with {"decision":"decline"}
<-- serverRequest/resolved {"requestId":0}
<-- item/completed {"item":{"type":"commandExecution","id":"call_w658...","status":"declined","aggregatedOutput":null,"exitCode":null} ...}
[stderr] codex_core::tools::router: error=exec_command failed for `/bin/zsh -lc 'echo hello-from-codex'`: CreateProcess { message: "Rejected(\"rejected by user\")" }
```

`decline` 时命令**没有执行**（`exitCode: null`、`aggregatedOutput: null`）。`accept` 时：

```text
### answering item/commandExecution/requestApproval -> {"decision":"accept"}
<-- item/completed commandExecution status=completed exit=0 id=call_UtyIVBkBKHfcCbTn8jrxnGLs
### file /tmp/ce-d2-spike/approval-accept.txt = approved-by-gate
```

结论：该通道可承载 fail-closed gate。注意 Codex 的粒度是 **exec/命令级 + 沙箱策略**，不是 Pi 的"逐工具 allowlist"：`workspace-write` 沙箱内的文件编辑不需要审批，`item/fileChange/requestApproval` 只在需要越界写时出现。

### 3.4 FULL 等价路径：真实命令执行

`approvalPolicy:"never"`（无审批请求）+ `sandbox:"workspace-write"`：

```text
<-- item/started commandExecution status=inProgress id=call_4yPCxFtFMqwlkhh8vhfbDp96
<-- item/completed commandExecution status=completed exit=0 id=call_4yPCxFtFMqwlkhh8vhfbDp96
<-- turn/completed status=completed error=null
### spike-out.txt = hello-from-codex
```

`item/completed commandExecution` 携带 `exitCode`、`aggregatedOutput`、`commandActions`；`item/agentMessage/delta` 提供增量文本；`thread/tokenUsage/updated` 提供 token 计数。

### 3.5 中断：turn 会结束，**工具不会停**

prompt = `sleep 22; echo DONE_CE_SPIKE >> /tmp/ce-d2-spike/interrupt-marker.txt`，在 `item/started commandExecution` 之后（`sleep` 已存在，pid 66178/ppid 66177）发 `turn/interrupt`：

```text
### ps before interrupt:
66178 66177 sleep 22
### turn/interrupt -> {}
<-- thread/status/changed {"status":{"type":"idle"}}
<-- turn/completed status=interrupted error=null
### +1000ms marker="(absent)" ps:
66178 66177 sleep 22
### +4000ms marker="(absent)" ps:
66178 66177 sleep 22
<-- item/completed commandExecution status=completed exit=0 id=call_ScDEFzUSAAmP2J5mzbrC5A0B
### +25000ms marker="DONE_CE_SPIKE" ps:
```

结论：`interrupt` 只结束 turn；**已开始的 shell 工具继续运行并正常完成**。因此 interrupt ≠ 静止，`cooperativeStop` 不能凭 interrupt 声明（Pi 的内置 bash abort 会杀进程组，Codex 不会）。

### 3.6 退出/崩溃：app-server `SIGTERM` 留下孤儿工具

同一 prompt，在 `sleep 22` 运行中对 app-server 发 `SIGTERM`：

```text
### ps before SIGTERM:
70445 70439 sleep 22
### sending SIGTERM to app-server
### app-server exitCode=null signal=SIGTERM
### ps after SIGTERM:
70445 70439 sleep 22
### +8000ms marker="(absent)" ps:
70445 70439 sleep 22
### +15000ms marker="DONE_CE_SPIKE" ps:
```

结论：杀 provider **不会**终止已开始的工具，孤儿会继续写工作区（与 FOUNDATION-040 在 Pi 上测得的一致）。Adapter/Runtime 必须自己持有归属证据（pid + start token + 进程树）并在需要静止时核验，不能把"provider 退出"当作"工作区静止"。

### 3.7 跨进程会话恢复

进程 1：`thread/start` + turn「记住 ZEBRA-9317」→ `turn/completed`；SIGTERM 退出。
进程 2：`initialize` + `thread/resume {threadId}` + turn「我之前让你记的词是什么？」：

```text
THREAD_ID=01a09f9f-6794-7792-8f46-0c14245dc110
THREAD_PATH=/Users/loyage/.codex/sessions/2026/09/14/rollout-2026-09-14T19-13-39-01a09f9f-...jsonl
[p1] agentMessage: OK
[p1] turn/completed status=completed error=null
--- first process exited: code=null signal=SIGTERM
RESUME result thread id=01a09f9f-6794-7792-8f46-0c14245dc110 path=/Users/loyage/.codex/sessions/.../rollout-2026-09-14T19-13-39-01a09f9f-...jsonl touches=673
[p2] agentMessage: ZEBRA-9317
RESUMED_TURN_STATUS=completed
RECALLED=true
```

结论：持久 conversation 跨进程恢复**成立**；恢复的是 conversation，不是原 OS 进程。`thread/resume` 对**非运行中** thread 的优先级是 `history > 非空 path > threadId`（协议 schema 原文），且对运行中 thread 会 rejoin（共享 daemon 语义）——Adapter 只允许恢复**自己记录且已退出**的 thread，并按 `threadId` 恢复、核对返回的 `path` 与记录一致。

### 3.8 结构化提问：协议支持，但默认模式下工具不可用

默认（`approvalPolicy:never`，无 feature flag）：

```text
<-- agentMessage: I tried to call `request_user_input`, but it's unavailable in the current mode ...
[stderr] codex_core::tools::router: error=request_user_input is unavailable in Default mode
REQUEST_USER_INPUT_SEEN=false
```

`codex app-server --stdio --enable default_mode_request_user_input`：

```text
<-- warning: {"message":"Under-development features enabled: default_mode_request_user_input. Under-development features are incomplete and may behave unpredictably. ..."}
<-- REQUEST item/tool/requestUserInput params={"threadId":"01a09fa0-...","turnId":"01a09fa0-...","itemId":"call_3OQFN...",
      "questions":[{"id":"colour","header":"Colour","question":"Which colour should I pick?","isOther":true,"isSecret":false,
      "options":[{"label":"Red (Recommended)","description":"Pick red as the colour."},{"label":"Blue","description":"Pick blue as the colour."}]}],
      "isBlocking":false,"autoResolutionMs":null}
### answering requestUserInput with {"colour":{"answers":["Red"]}}
<-- agentMessage: Done.
<-- turn/completed status=completed
REQUEST_USER_INPUT_SEEN=true
```

结论：结构化提问通道**存在且可端到端应答**，但需要显式开启一个 under-development feature flag；默认启动下 Agent 无法提问。Adapter 因此把它做成**显式选项**，并在 `capabilities` 中如实反映（关闭时 `UNSUPPORTED`）。

### 3.9 配置受控性：做不到

```text
$ codex app-server --help        # 选项里没有 --ignore-user-config / --no-hooks / --no-plugins
$ codex app-server --stdio -c mcp_servers={} -c hooks={}   # 仍然：
<-- mcpServer/startupStatus/updated {"name":"node_repl","status":"ready"}
<-- mcpServer/startupStatus/updated {"name":"cua_repl","status":"ready"}
<-- mcpServer/startupStatus/updated {"name":"codex_apps","status":"ready"}
```

并且真实 turn 中持续出现来自 `~/.codex/hooks.json` 的 `hook/started`/`hook/completed`（`sessionStart`、`userPromptSubmit`、`preToolUse`、`permissionRequest`、`stop`）。

另有一次**provider 自己写全局配置**的实测：在 `/tmp/ce-d2-spike/repo` 首次运行 `codex exec` 后，
`~/.codex/config.toml` 被 Codex 追加了

```toml
[projects."/private/tmp/ce-d2-spike/repo"]
trust_level = "trusted"
```

（spike 结束时已手工移除该 3 行并核对文件回到 spike 前的状态）。结论：受控启动不仅排除不了 ambient 配置，
provider 还会**写**自己的全局配置；这是 `controlledConfiguration: UNSUPPORTED` 之外的另一个副作用事实。

结论：Codex app-server 无法像 Pi 的 `--no-extensions --extension <Codeestra gate> --no-skills ...` 那样被完全受控启动；环境里已安装的 plugin/MCP/hook 会参与执行。这是与 Pi 的能力差异，必须在矩阵中显式标注（`controlledConfiguration: UNSUPPORTED`），而不是假装沙箱等价。

### 3.10 Adapter 本体的真实 smoke（真实 `codex` 0.151.0 + `gpt-5.5`）

`bun run /tmp/ce-d2-spike/adapter-smoke.ts`（直接 import `packages/agent-adapters/src/codex-adapter.ts`，真实可执行文件 `/etc/profiles/per-user/loyage/bin/codex`）：

```text
[FULL] probe version=0.151.0
[FULL] started thread=01a09fab-fb81-7340-99b1-7504763f8e27 rollout=/Users/loyage/.codex/sessions/2026/09/14/rollout-...jsonl
[FULL] event completed SUCCESS null evidence={"ref":"codex-app-server:turn_terminal:thread=01a09fab-...:turn=...:epoch=...:launch=a4e6ae84871d2cc3", ...}
[FULL] attentions=0 unconfirmedStops=[]
[FULL] outFile exists=false
[STRICT] probe version=0.151.0
[STRICT] started thread=01a09fac-1fc4-7dd2-bf88-aa3db4bd6e16 rollout=/Users/loyage/.codex/sessions/2026/09/14/rollout-...jsonl
[STRICT] processIdentity={"pid":97215,"executable":"/etc/profiles/per-user/loyage/bin/codex","startToken":"ps:一  9月/14 19:27:03 2026","argvHash":"a4e6ae..."}
[STRICT] event attention PERMISSION/CONFIRM {"kind":"codex.permission","version":1,"approvalKind":"command","itemId":"call_EIjvGI0vnw52uQMSTg2FV0Sq","command":"/bin/zsh -lc \"/bin/sh -lc 'echo codex-adapter-smoke > /tmp/ce-d2-spike/adapter-smoke-out.txt'\"", ...}
[STRICT] answered {"providerRequestId":"0","accepted":true}
[STRICT] event completed SUCCESS null evidence={...}
[STRICT] attentions=1 unconfirmedStops=[]
[STRICT] outFile exists=true
```

`bun run /tmp/ce-d2-spike/adapter-resume-smoke.ts`（两个**独立** `CodexAdapter` 实例 = 两个 app-server 进程）：

```text
[p1] thread=01a09fac-72f7-7190-b1bc-ae538b818eff rollout=/Users/loyage/.codex/sessions/2026/09/14/rollout-...jsonl
[p1] completed SUCCESS unconfirmed=[]
[p2] thread=01a09fac-72f7-7190-b1bc-ae538b818eff rollout=/Users/loyage/.codex/sessions/2026/09/14/rollout-...jsonl
[p2] completed SUCCESS unconfirmed=[]
[resume-check] same-thread=true same-path=true
```

同一 rollout 文件的 entry 检查（22 行，`turn_context: 2`）：

```text
USER PROMPT: Codeestra revision revision-1  Remember this token for later: CODEX-ADAPTER-RESUME-7341. ...
USER PROMPT: Codeestra: this execution was paused and has now resumed (revision revision-2). Continue ...
```

结论：`CodexAdapter` 本体的 probe/STRICT gate/FULL/完成证据/进程身份/跨进程 resume 均已在真实 provider + 真实模型下跑通。

两点附带事实：

- rollout 的 user prompt 里出现 provider 自带的 `<recommended_plugins>` 片段——**ambient 配置确实进入了模型输入**，这是 `controlledConfiguration: UNSUPPORTED` 的直接证据。
- 两次 STRICT/FULL smoke 的 `unconfirmedStops` 均为空：`observe()` 在 turn 终态后停掉自己的 app-server 子进程并确认退出（因此 `releaseSession` 返回 `null`，表示已无 live 进程）。

## 4. 能力结论与 Adapter 处理

| Adapter 能力 | Codex 0.151.0 结论 | Codeestra 处理 |
|---|---|---|
| persistentSession | `SUPPORTED`（thread id + rollout 文件，跨进程恢复实测） | 保存 thread id 与 rollout 路径；恢复时核对路径归属 |
| structuredAttention | 协议 `SUPPORTED`，但需 `--enable default_mode_request_user_input`（under development） | 显式选项；关闭（默认）时报 `UNSUPPORTED`，不假装能提问 |
| nativePermissionRouting | `SUPPORTED`（命令级审批请求，fail-closed 实测 allow/deny） | FULL：`approvalPolicy:"never"` + `danger-full-access`（零确认）；STRICT：`untrusted` + `workspace-write`，审批请求转既有 Attention |
| pauseWithQuiescence | `UNSUPPORTED` | 无 pause/resume 原语；修订走 ADR-0001 fallback（停止 + 新 Execution） |
| revisionAcknowledgement | `UNSUPPORTED` | 不从自然语言推断 ACK |
| cooperativeStop | `REQUIRES_VALIDATION` | `turn/interrupt` 不停工具、杀 app-server 留孤儿（实测）；只有确认我们自己的 app-server 子进程退出才算"我们拥有的 writer 已停" |
| attach | `UNSUPPORTED` | 交互 TUI 走共享 app-server daemon，与我们的 stdio 子进程不是同一 writer；不实现、不伪装 |
| reconnectToLiveSession | `UNSUPPORTED` | 丢失 app-server stdio 后不重新接管该 live 进程（`thread/resume` 只在进程已退出、由新 Execution 使用） |
| resumeAfterExit | `SUPPORTED`（`thread/resume`，实测复述） | 新 Execution + `thread/resume`，保留来源关系 |
| controlledConfiguration | `UNSUPPORTED` | 无 `--ignore-user-config`；环境 plugin/MCP/hook 参与执行，如实标注 |

## 5. 对设计的影响

1. Codex Adapter 用 **`codex app-server --stdio` 的 JSONL JSON-RPC**，不用 `exec --json`；只有前者能承载 STRICT 审批与结构化提问。
2. STRICT 的审批转发到既有 Attention 通道（`kind: PERMISSION`、`responseType: CONFIRM`），`accept`/`decline` 映射到 Codex 的 `{decision}`；`CANCEL` 映射到 `"cancel"`（协议里 `availableDecisions` 明确列出）。这是 ADR-0023 通道的第二个 provider 实现，不新增门禁。
3. **不实现 attach/handoff**：Codex 的 TUI 与我们的 app-server 子进程不是同一 writer；ADR-0010/0023/0026 的 Pi 专属机制不套用。需要时另立 ADR 与 spike。
4. interrupt 不停工具 ⇒ `turn/completed status:"interrupted"` 不产生 `completed` 事件（否则会写入 `toolsQuiescent: true` 的假证据），而是报 `disconnected`，让 Runtime 进入恢复路径。
5. `danger-full-access` 只在 FULL 下使用；STRICT 保持 `workspace-write` + `untrusted`。权限模式到 provider argv/policy 的映射必须写进 Execution 记录（`permissionMode` 已在 start 请求里）。
6. 恢复只允许**已退出**的、由本 Runtime 记录的 thread；按 `threadId` 恢复并核对返回 `path` 等于记录的 rollout 路径，且该路径必须位于本次启动的 `CODEX_HOME/sessions` 内。

## 5.1 真实集成证据 vs stub 证据（分级）

- **真实集成已验证**：§3.1–§3.10 的全部命令（真实 `codex` 0.151.0、真实 ChatGPT 登录、真实 `gpt-5.5`），包括 `CodexAdapter` 本体的 probe/start/observe/answer/resume 与 STRICT 审批的 allow/deny 两条路径。
- **仅 stub 验证**：`CodexAdapter` 的失败映射细节（turn failed、unexpected exit、interrupted、unsupported server request、resume 身份不匹配、cursor epoch、重复应答）由 `packages/agent-adapters/test/codex-adapter.test.ts` 的协议 stub 覆盖；CLI 命令面（`task run --adapter codex`、STRICT Attention、`agent config --adapter codex`、pause/resume、失败后换 Adapter）由 `apps/runtime/test/cli-codex-adapter.test.ts` 的 stub 覆盖。stub **不是**真实集成验收。
- **明确未做**：把上述 CLI 流程用真实 `codex` 端到端驱动（真实模型下跑 `task run --adapter codex`）；`item/fileChange/requestApproval` 与 `item/permissions/requestApproval` 的真实触发；多工具批次的 interrupt；Windows；Codex 版本升级后的协议兼容。

## 6. 未验证 / 不支持（明确列出）

- **未验证**：多工具批次下的 interrupt 行为；`item/fileChange/requestApproval` 的真实触发（本次只实测了 command 审批）；`item/permissions/requestApproval` 的粒度授权语义；`mcpServer/elicitation/request`；Windows；Codex 版本升级后的协议兼容（app-server 标注为 experimental）；`--enable default_mode_request_user_input` 在后续版本中的可用性。
- **不支持**：pause/resume、revision ACK、attach 到 live app-server 或 TUI、Runtime 重启后重接 live 进程、完全受控启动、interrupt 后工具静止保证。
- **不做**：使用 `dangerously-bypass-approvals-and-sandbox` 或 `--dangerously-bypass-hook-trust`（两者都绕过本机策略，不在 Codeestra 的控制范围内）；不修改用户 `~/.codex` 配置或凭据。

## 7. Provider 进程冻结（ADR-0061，FOUNDATION-097 补测）

状态：**部分实测，能力仍为 `REQUIRES_VALIDATION`**。ADR-0061 需要证明「哪个受控进程是模型请求发起者，
以及冻结它之后不再产生下一次模型请求」。本格只完成了**进程归属的一半**：模型那一半被账号状态挡住了。

### 7.1 已实测：受控 app-server 子进程与它的后代

探针（已入库）：`docs/spikes/global-freeze/codex-freeze-probe.ts`（发起真实 turn）与本节引用的一次结构观测
（`codex app-server --stdio` → `initialize` → `thread/start` → 12 秒后读真实进程表）。spike 的临时目录
（`/tmp/ce-glc2/…`）已在交付收尾时按要求清理；下方逐字引用关键原始输出行，探针可复跑。实测环境：本机 `codex` **0.154.0**
（不是本文件首轮的 0.151.0），`codex login status` → `Logged in using ChatGPT`，未修改 `~/.codex`。

```text
### app-server pid 90499
### descendants of the app-server child: 3
  90926 90499 90926 S  …/cua_node/bin/node …/.codex/plugins/cache/openai-bundled/unified-computer-use/…/launch.mjs
  90927 90499 90927 S  …/cua_node/bin/node_repl
  90971 90926 90926 S  …/cua_node/bin/node_repl
```

事实：

- 受控启动产生的 `codex app-server --stdio` 子进程是**唯一**由 Adapter 持有 stdio 的 provider 主进程，
  这一点与 ADR-0029 的实现一致（`CodexAdapter` 启动时记录它的 `{pid, startToken}`）。
- 该子进程会自行拉起**第三方插件/MCP 进程**作为自己的后代（上表三个 `node`/`node_repl`，各自独立 process group）。
  这既说明「工具链进程是主进程的后代」在结构上成立，也说明 Codex 上有**Codeestra 无法证明归属的外部进程**——
  ADR-0061 的保证对它们不适用，本文件 §1/§6 关于「app-server 无法排除用户配置」的结论在 0.154.0 上依然成立。

### 7.2 未能实测：冻结后的「没有下一次模型请求」

同一个探针用真实 `turn/start` 驱动了一次真实 turn（thread 与 turn id 都成功返回，`userMessage` 也落库），
但模型请求本身失败：

```text
[notify] error {"error":{"message":"Reconnecting... 5/5", … "additionalDetails":"request timed out"}}
[notify] error {"error":{"message":"You've hit your usage limit. Upgrade to Pro … try again at Sep 19th, 2026
  4:08 PM.","codexErrorInfo":"usageLimitExceeded"},"willRetry":false}
[notify] turn/completed {… "status":"failed" …}
```

本机 ChatGPT 账号在测量窗口内已用尽额度（`account/rateLimits/updated` 报 `credits.balance: "0"`），
因此**没有**任何工具被真实执行：探针的「第一次 bash 工具」从未出现，`codex app-server` 上也没有可
冻结的正在运行的工具子进程。没有这一步，就不能声称「冻结后不再产生下一次模型请求」——

**结论：`codexProviderProcessSuspension` 保持 `REQUIRES_VALIDATION`**（`packages/agent-adapters/src/codex-adapter.ts`）。
它与「本格想用」无关：进程归属的一半有证据，模型请求那一半没有。

补齐这一格所需的最少步骤（恢复额度后即可复跑）：`bun run docs/spikes/global-freeze/codex-freeze-probe.ts
/tmp/ce-glc2/codex-freeze`，期望看到与 Pi 相同的判据（第一次 bash 工具出现 → 只对 app-server 主进程
`SIGSTOP` → 工具继续、第二个 marker 不出现 → `SIGCONT` 后出现）。注意 0.154.0 要求显式 `model`
（本文件 §0 记录的默认模型被服务端拒绝问题在 0.154.0 上仍需要显式指定）。
