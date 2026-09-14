# ADR-0026：原生终端 PTY 传输、successor 启动与 attach/detach/release

Status：Accepted（Phase 3 第二小步，实现 ADR-0010 D04/D05 的传输半边）。
**Amends ADR-0023**（把「只判定并记录」的 `session.handoff.admit` 变成真的接管；不改 ADR-0023 的安全点、
单 writer lease、incarnation 与决议路由语义）。**Amended by**：（暂无）。

## Context

FOUNDATION-043 / ADR-0023 落地了 Runtime 侧契约：incarnation 历史、单 writer lease、handoff fence 与
结构化安全点、STRICT 权限经 side channel 转既有 Attention、`admit` 的 predecessor 归属核验，以及重启
按事实 reconcile。但 `admit` 只**判定**：`successorStarted: false`、`terminalTransport: 'UNIMPLEMENTED'`、
`nativeTerminalAttach: 'UNSUPPORTED'`，用户仍然进不了原生终端，detach/reattach 与「交还 RPC」都不存在。

FOUNDATION-040 的真实 Pi 0.84.4 spike 给出了实现这条路径所需的事实：

1. **原生 TUI 需要真实 PTY**：普通 stdout pipe 不能冒充终端；`pi --session <file>`（不带 `--mode rpc`）
   在真实 PTY 中能从同一持久 conversation 恢复并继续。
2. **退出码不能判定 release**：Ctrl+D 与 SIGTERM 都是 `exit 0`（RPC 是 143）。交接成功必须由显式协议事实
   + provider session file 事实共同判定。
3. **结束 provider ≠ 工作区静止**：SIGKILL provider 不会终止已开始的工具，孤儿会被 reparent 到 PID 1
   并继续写工作区，且工具子进程可能忽略 SIGHUP / 处于其他 session。successor 启动前的归属核验必须覆盖
   「provider 已死但后代仍活」。
4. **`--session <file>` 没有排他**：单 writer 只能由 Runtime 强制（ADR-0023 已做）。

本波交付的是这条路径的**实现与命令面**，不新增任何权限门禁或审批层（ADR-0008/0011）。

## Options

### PTY 的持有者

- A. Runtime 进程直接 `forkpty`/`posix_openpt` 并持有 master。
- B. Runtime 启动一个自己拥有的极小 PTY host 进程：它 `setsid`、开 slave（成为会话控制终端）、
  spawn provider，并通过 stdout/stdin 的定长帧把 master 字节流与 Runtime 交换。
- C. 依赖第三方原生模块（`node-pty` 等）。

选择 **B**。理由：`setsid(2)` 对已是进程组组长的进程会失败，而 provider 必须运行在「以该 PTY 为控制终端
的新会话」中才有正确的终端语义（tty、raw 模式、窗口大小、终端关闭时对前台进程组的 SIGHUP）；A 需要
在 Runtime 内 fork+exec（对多线程 JS 运行时不可接受），C 引入本机原生依赖并需要为每个平台提供预编译产物。
B 让 Runtime 仍然「拥有」终端——它拥有 helper 的生命周期与控制管道——同时把终端语义交给一个职责单一的
小进程。实测（见本篇 Verification）：真实 `pi` 0.84.4 在该 helper 下拿到真实 tty，`stty size` 为 Runtime
申请的 100×30，TUI 正常渲染，Ctrl+D 退出码 0。

### successor 启动的边界

- A. 让 `session.handoff.admit` 自己启动两种 provider 进程（含 `pi --mode rpc`）。
- B. `admit` 只负责 TUI 方向；交还自动化（TUI→RPC）由 Runtime 的 Agent coordinator 启动，handoff 服务
  只记录 incarnation。

选择 **B**。RPC successor 的观察循环、事件投影与 run Operation 属于 coordinator；handoff 服务若自己
spawn RPC 进程，就会出现两个所有者（谁能停它、谁投影它的事件）。因此 handoff 服务通过注入的回调
（`startAutomationSuccessor`）请求 coordinator 启动 successor，并在拿到**真实**进程身份后才记录 incarnation。

### release 的判定

- A. 以退出码为准（`exit 0` 即成功）。
- B. 以「显式 release 命令 + provider 进程确已退出 + 归属核验 + session file 事实」共同判定；退出码只
  作为审计数据记录。

选择 **B**。A 在 FOUNDATION-040 中被直接否证（Ctrl+D 与 SIGTERM 都是 0）。

## Decision

### D01：PTY 传输由 Runtime 拥有的 helper 实现

- `packages/agent-adapters/src/pi-pty-host.ts`：一个独立的 Bun 进程。它 `setsid`、`posix_openpt` →
  `grantpt`/`unlockpt`/`ptsname`，以 slave 作为控制终端 spawn provider，然后用 LF-JSON 帧
  （`input`/`signal`/`shutdown` ↔ `ready`/`output`/`exit`/`error`）与 Runtime 交换字节流与事实。
- `pi-pty.ts` 的 `buildPiTerminalArguments` 与 `pi-adapter.ts` 的 `buildPiRpcArguments` **同源**：
  相同的权限模式、`--tools`、gate/question 扩展、`--session-dir`、`--session <file>` 与模型参数，唯一区别
  是不带 `--mode rpc`。两者都从 `apps/runtime/src/adapter-registry.ts#piControlledLaunch` 取受控启动的
  同一份路径与 platform，避免两条传输漂移。
- `PiPtyTerminal` 提供：有序字节流投影（单调 cursor，越界读返回 `truncated: true` 而不是空洞）、有界内存
  缓冲（默认 256 KiB，不落盘）、`write`（终端输入）、`waitForExit`（helper 报告的退出事实）、
  `captureTree`/`refreshTree`/`inspectOwnership`（归属证据）、`stop`（先 `shutdown`，再 helper 级信号）。
- **孤儿防护**：helper 把「控制管道被关闭」解释为「已没有 writer 拥有这个终端」，于是终止 provider 并退出。
  Runtime 崩溃或被 SIGKILL 时不会留下继续写工作区的 provider。窗口大小由 helper 在 spawn 前经 `stty`
  应用（直接 `ioctl(TIOCSWINSZ)` 在本环境写入的是垃圾值，已弃用）；**resize 仍不支持**并在能力投影中如实报告。
- 终端字节只存在于 Runtime 内存，不进入 domain event/Intent/Revision（ADR-0010 D06）。

### D02：`session.handoff.admit` 真的启动 successor

判定顺序完全沿用 ADR-0023（安全点、无未决 Attention、lease 归属、predecessor 归属必须 `STOPPED`），
另外新增一条：Execution 必须仍为 `RUNNING`，否则 `EXECUTION_NOT_ACTIVE`（ADR-0010 D03）。

- 若 predecessor 仍 `ALIVE` 且它是**本 Runtime 持有**的自动化进程，Runtime 先通过 coordinator 协作停止它
  （`releaseAutomationProcess`，即既有 `releaseExecutionProcess`），再重新核验进程表；仍存活则
  `PREDECESSOR_NOT_STOPPED`。Runtime 从不向自己未持有的进程发信号。
- `TAKEOVER`（RPC→TUI）：结束 predecessor incarnation（同时清空 `current_incarnation_id`，旧决议立即变为
  `STALE_INCARNATION`）→ 释放其 lease → 用**记录的** start plan（workspace、ownership token、revision、
  agent config）在同一 provider session file 上启动原生终端 → 记录 `HUMAN_TUI` successor incarnation
  （连带取得 `TERMINAL_ATTACHMENT` lease）→ 落 terminal 行 → `ADMITTED`。
- `RETURN`（TUI→RPC）：要求终端已 `RELEASED`/`STOPPED`（否则 `TERMINAL_STILL_RUNNING`），同上结束
  predecessor、释放 lease，再经 `startAutomationSuccessor` 启动 RPC successor，核验它重开的 session file
  与记录一致（否则停掉它并 `SESSION_FILE_CHANGED`），记录 `AUTOMATED_RPC` incarnation，最后 `ADMITTED`。
- 任一步失败都在**记录 incarnation 之前**收束并说明；已启动但未能记录 identity 的 successor 会被停掉。
- 记录 successor incarnation 使用的 `commandId` 由 handoff request 派生，因此重放不会产生第二个 successor；
  已 `ADMITTED` 的请求再次 `admit` 直接回放**已记录的** successor，不启动任何进程。

### D03：incarnation 的进程树必须持续刷新

`session_incarnations.process_tree_json` 在启动时抓取的树只能看到当时已在运行的进程，而工具子进程往往是
启动之后才出现的——正是 FOUNDATION-040 测到会存活下来的那些。因此：

- 终端方向：`TerminalService` 在终端存活期间按固定间隔抓取并**按 pid 合并**（union，只增不减）写回
  incarnation；`release` 在写 release 字节**之前**再抓一次（provider 还活着，此时血缘仍可从进程表读出）。
- RPC 方向：gate side channel 报告 `agent_settled` 时（fence 之后、无活动工具、进程即将退出）抓取并合并。
- 任何无法比较的情况（读不到进程表、缺 start token、pid 复用无法判定）都返回 `UNVERIFIABLE` 并拒绝接手。

### D04：release 是显式协议，不是退出码

`session handoff release <project> <session>`：

1. 先持久化 `RETURN` handoff 请求（无 open 请求时自建；有 TAKEOVER 请求则 `HANDOFF_KIND_MISMATCH`）。
2. 记录 release 请求（写下的字节、命令 ID）与**当时**的 session file 事实（条目数、最后一个 entry id）。
3. 写终端的 release 字节（Ctrl+D，`terminalReleaseByte`）；不发送 SIGKILL，也不 abort 正在跑的工具。
4. 等待 helper 报告的 provider 退出事实。超时即 `RELEASE_NOT_CONFIRMED`：终端仍是 writer，不启动 successor。
5. 用刷新后的并集树做归属核验：`DESCENDANTS_ALIVE` → `PREDECESSOR_DESCENDANTS_ALIVE`；
   `UNVERIFIABLE` → `PREDECESSOR_UNVERIFIED`。两者都拒绝交还。
6. 核验 session file：不得丢失条目（`SESSION_FILE_REWRITTEN`）、必须仍含 predecessor 最后写入的 entry id
   （`predecessorEntrySurvived`）、读被截断则 `SESSION_FILE_TRUNCATED_READ`。
7. 只有全部通过才记录 terminal-release 安全点并交还自动化（`resumeAutomation` 默认 `true`；
   `--no-resume` 只释放终端、不启动 RPC successor）。
8. 退出码写入审计（`session_terminals.exit_code`），**不参与任何判定**。

provider 自身的 `session_shutdown` 通知（gate 扩展上报）只作为附加证据记录
（`provider_shutdown_reported_at`）：FOUNDATION-040 实测它不可靠，任何判定都不得依赖它。

### D05：attach / detach 与单 writer 附加

- `session handoff attach <project> <session> --holder <ref> [--writer] [--since <cursor>]`：把客户端附加到
  **本 Runtime 持有的**终端，返回从 cursor 起的投影流。`WRITER` 附加每个终端至多一个，第二个 writer 稳定
  失败为 `ATTACHMENT_BUSY` 并报出当前 holder（不排队）；`OBSERVER` 可多个。同一 `commandId` 重放返回已有附加。
- `session handoff detach`：只释放客户端附加，**不停终端、不动 provider**；异常断开的客户端等同 detach。
- `session handoff terminal read --since <cursor>` / `terminal write --text <text>`：同一命令面的可脚本化
  读写（UI 只是同一投影的前端）。写入是终端输入，不是审批通道。
- 终端被释放或停止时，其附加记录一并关闭并记录原因。

### D06：重启与停止

- Runtime 关闭时 `SessionHandoffService.close()` 顺带请求停止它持有的终端（best-effort）；**保证**来自
  helper 的「控制管道关闭即终止 provider」规则，因此即使 Runtime 被 SIGKILL 也不会留下 provider。
- 启动时 `reconcileSessionTerminals` 把上一代仍为 `RUNNING` 的 terminal 收敛为 `RECOVERY_REQUIRED`、
  关闭其附加，并把记录的 helper/provider pid **报告出来**而不杀：Runtime 无法证明这些 pid 仍是它记录的进程
  （pid 可复用），也不在猜测之上做不可逆动作。
- run Operation 的投影：fence 之后到达的 settled 事实在存在 open handoff 请求时**不被投影为 Execution 完成**
  （ADR-0010 D03），该 pump 也不结算 run Operation——对话正由新 incarnation 继续，运行没有结束。

### D07：能力投影如实

`session handoff status` 的 `capabilities` 变成：

| 能力 | 值 |
|---|---|
| `runtimeContract` / `singleWriterLease` / `strictPermissionOverSideChannel` | `IMPLEMENTED` |
| `ptyTransport` / `successorProcessStart` / `nativeTerminalAttach` / `releaseBackToAutomation` | `IMPLEMENTED`（非 Windows） |
| `terminalDetach` | `IMPLEMENTED` |
| `attachToLiveRpcProcess` | `UNSUPPORTED`（Pi 没有这种原语，"附加到原生终端" 与 "附加到运行中的 RPC 进程" 是两件事） |
| `crossHandoffPermissionModeMatrix` | `PARTIAL`（每次 successor 由 Runtime 重新拼 argv 保持模式/工具集，但完整矩阵未测） |
| `parallelToolBatchSafePoint` | `UNVERIFIED` |
| `sessionCompactionDuringHandoff` / `ptyResize` / `windows` | `UNSUPPORTED` |

不支持的必须显式反馈，不静默降级。

## Consequences

- 用户一条命令（`session handoff admit`）就能从自动化进入真实 Pi 原生 TUI，再一条命令（`release`）交还；
  detach/reattach 不再影响 Agent。CLI 是完备命令面，UI 只能投影同一命令面（本轮不改 UI）。
- 代价：多了一个 Runtime 拥有的 helper 进程；终端的字节流不落盘，因此 Runtime 重启后旧终端的输出无法回溯
  （这是 ADR-0010 D06 的有意选择），重启后该终端只能被报为 `RECOVERY_REQUIRED`。
- PTY 的初始尺寸经 `stty` 应用；**resize 不支持**。终端窗口大小变化不会被传播。
- `admit` 现在有真实副作用，因此它必须是幂等的、且在失败时不留半成品状态：所有落库动作都在进程启动之后、
  启动失败即收束，并保留既有 fence/safe point 事实供重试。
- 首次接管仍需等待安全点并重启 provider 进程（延迟高于 RPC steering），这是 ADR-0010 的既定取舍。

## Verification

只用 CLI/命令面、真实 PTY 与真实进程表，不使用浏览器/桌面/键鼠自动化：

1. `packages/agent-adapters/test/pi-pty.test.ts`：真实 PTY 上的传输契约——provider 真的拿到 tty（`isatty`）、
   申请的 100×30 被 provider 读到、字节流有 cursor 且增量读只返回新字节、无人读取时 provider 继续产出、
   有界缓冲把过期 cursor 报为 `truncated`、release 字节后退出事实（含 exit code）被观察到、控制管道关闭
   即终止 provider（孤儿防护）、provider 被杀后仍活着的后代被报为 `DESCENDANTS_ALIVE` 且该孤儿确实继续写入
   工作区、session 文件事实与截断读。
2. 同一文件还驱动生产 gate 扩展在 `mode: 'tui'` 下对真实 UNIX socket 的完整契约（hello/STRICT 请求/ALLOW/
   fence 阻止新工具且不产生审批请求）。
3. `apps/runtime/test/terminal-service.test.ts`：真实 PTY + fake provider 的服务契约——终端的进程身份、
   session file 事实、投影 cursor、`ATTACHMENT_BUSY`（并报出 holder）、observer、detach 后 provider pid 不变、
   reattach、**release 在 exit code 7 下仍成功**、`RELEASE_NOT_CONFIRMED`（不杀 provider）、
   `SESSION_FILE_REWRITTEN`、后代仍活时拒绝 release、重启 reconcile 报 `RECOVERY_REQUIRED` 并报告 pid、
   incarnation 链与单 writer lease 迁移。
4. `apps/runtime/test/cli-session-attach.test.ts`：CLI 端到端（协议 stub 扮演 provider + 真实 Runtime + 真实
   PTY）——`request takeover` → 安全点 → `admit` 真启动 `HUMAN_TUI`（同一 session file、lease 移交给终端、
   Execution 仍 `RUNNING`）→ `terminal read/write` → 第二 writer `ATTACHMENT_BUSY`（exit 1）→ `detach` 后
   provider pid 不变、reattach 成功 → `release` 在 exit code 7 下成功且 successor RPC 从**同一** session file
   继续（`rpc-return-entry` 追加、provider 报告 `resumed: true`）→ 重复 `admit` 回放不新建第三个 incarnation
   → 已释放终端再次 release 为 `TERMINAL_NOT_RUNNING`（exit 1）。
5. 真实 Pi 0.84.4 headless（脚本在 `/tmp`，不入库）：`pi` 真实 TUI 在 helper 下运行（真实 tty、`stty size`
   = 申请值、渲染出启动界面、Ctrl+D → exit 0）；生产 gate 扩展在真实 TUI 中 hello（`mode: 'tui'`、真实
   provider session id/file、pid 与记录的 provider pid 一致）并接受 fence（`fence_ack`）。
6. 未验证（不得当成已成立）：真实模型在 TUI 中键入后交还 RPC 继续同一 conversation、跨交接权限模式完整
   矩阵、并行工具批次安全点、compaction、长会话/大 session file、PTY resize、Windows、其他 provider。

## Related

- `docs/spikes/pi-session-handoff.md`（FOUNDATION-040 实测事实）
- ADR-0010（接管语义、D05 单 writer、D06 模式与 side channel）、ADR-0011（默认 FULL）、
  ADR-0023（incarnation/lease/安全点/能力核验，本 ADR 修改其「只判定不启动」部分）
- ADR-0008（CLI 完备、测试边界）
- `packages/agent-adapters/src/{pi-pty,pi-pty-host,pi-session-file}.ts`、
  `apps/runtime/src/{terminal-service,session-handoff-service}.ts`
