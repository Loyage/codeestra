# 终端接管、PTY 传输与跨交接权限

> 层级：L2 按需参考 · 体量 ≈ 7k 字符 · **何时读**：改原生终端接管、PTY helper 协议、resize、安全点判定或跨交接权限矩阵 · **权威来源**：`packages/agent-adapters/src/pi-pty-host.ts`（帧表与实现）、[`agent-adapter-api.md`](./agent-adapter-api.md)（端口语义）、ADR-0010/0023/0026/0054。证据：`docs/spikes/pi-parallel-tool-batch.md` 与 `docs/spikes/pi-parallel-tool-batch/*.ts`。
>
> 章节号沿用拆分前 `agent-adapter-api.md` 的 §5–§7（代码注释与 ADR 引用仍按旧号可解析）。

## 5. TerminalTransport（versioned 合约，ADR-0026 + ADR-0054）

PTY 的原始字节、input 路由与**窗口尺寸**是 Runtime 与它锁拥有的 PTY host helper 之间的传输事实，**不是** `AdapterEvent`，也永远不从终端字节推断任何业务状态（ADR-0010 D06）。合约版本号显式协商：Runtime 在 spawn plan 里带 `transport: 1`，helper 只接受它支持的那一版并在 `ready` 帧回显，版本不符即拒绝（`PTY_TRANSPORT_PROTOCOL_MISMATCH`），不猜、不降级。

帧表（v1）：

| 方向 | 帧 | 含义 |
|---|---|---|
| helper → Runtime | `ready { providerPid, slave, transport, cols, rows, windowSize }` | provider 已在真实终端上运行；`windowSize: 'APPLIED' \| 'NOT_APPLIED'` 只描述**启动时**那一次设置 |
| helper → Runtime | `output { data }` / `exit { code, signal }` / `error { code, message }` | 字节流与进程退出事实（退出码只作审计） |
| helper → Runtime | `resized { cols, rows, applied, detail }` | 一次 resize 的**结果**；`detail` 是稳定原因串（`stty` / `STTY_FAILED` / `INVALID_SIZE` / `PROVIDER_EXITED`），**永不出现「没有回答」** |
| Runtime → helper | `resize { cols, rows }` | 改变终端几何 |
| Runtime → helper | `input { data }` / `eof` / `signal` / `shutdown` | 输入与停止 |

- **机制**：`stty rows R cols C` 作用在**该终端的 slave fd** 上——与启动时设初始尺寸用的是同一个接口，也是 provider 自己读尺寸的接口（`TIOCGWINSZ`）。因此 helper 保留自己的 slave 副本到终端结束；provider 是否退出由 `waitpid` 判定（实测 master 在 provider 退出后不保证报 EOF）。`ioctl(TIOCSWINSZ)` 经 Bun FFI 在本机 darwin/arm64 会返回 0 却写入垃圾尺寸（AArch64 变参 ABI），理由写在代码注释里。
- **取值域是合约的一部分**：`1..1000` 的整数行列，Runtime / helper / Zod 三处都拒绝越界。
- **命令面**：`session handoff terminal resize`（见 `docs/guides/cli/task-revision-session.md` §7）。退出码 `0` 只有真的改了尺寸；`1` 拒绝或未生效；`2` 越界。`session.handoff.status` 的 `terminal.currentSize` 只在**本 Runtime 仍持有该终端**时非 null：启动时的 `windowSize` 不是「现在的尺寸」。
- **写入者座位拥有视口**：已有客户端持有该终端的 `WRITER` attachment 时，只有它能 resize；其他 holder 得到 `TERMINAL_RESIZE_WRITER_BUSY`（当前 holder 被报出）。这与 `attach` 的单 writer 规则是同一条，**不是新增审批**。
- **实测**：真实 PTY 上 provider 自己读到 `30 100` → `33 99` → `12 40`；真实 Pi 原生 TUI 收到 `120x40` 后回 `APPLIED`。
- **平台范围**：POSIX（Runtime 持有的 PTY）为 `IMPLEMENTED`；Windows 没有 PTY 传输，随 `ptyTransport`/`windows` 一起 `UNSUPPORTED`；Linux 走同一段代码路径但本机未实测。

## 6. 并行工具批次下的安全点（ADR-0054）

安全点规则没有改变（ADR-0010 D03）：**fence 已确认 + 活动工具计数 == 0 + fence 之后有 `agent_settled` + 无待决 Attention**。真实 Pi（脚本化模型、生产 gate、真实 side channel）实测它在同一 assistant 消息的多个 tool call 下仍可判定且不会被绕过：

- 每个 tool call 各上报一次 `tool_start`/`tool_end`（按 provider `toolCallId`）；**全部 `tool_start` 先于任何 `tool_end`**，`tool_end` 按完成顺序，`agent_settled` 在最后一个 `tool_end` 之后。Runtime 因此在整个批次中看到 `activeTools > 0`。
- 批次进行中打开 fence：**已开始的兄弟调用不被 abort**（真实输出、`isError=false`），下一个到达的工具调用被 terminating block（`CODEESTRA_HANDOFF_FENCE: no new tools after the safe point`），随后 `agent_settled`。被拦下的调用**也有** `tool_end`（Pi 的 immediate 分支），所以活动计数不会泄漏成「永不静止」。
- 待决的 STRICT Attention 即使 `settled` 且 `activeTools === 0` 也**不构成安全点**（`#evaluateSafePoint` 的 open-Attention 分支）。
- **未实测**：「fence 恰好落在同批次预检中间」的亚毫秒窗口（只有代码推断）。

## 7. 跨交接权限模式矩阵（ADR-0054）

`crossHandoffPermissionModeMatrix` 保持 **`PARTIAL`**：下面每一格都有测试或明确的「无法在本机验证」，并点名不成立的那一格。

| 阶段 | FULL | STRICT |
|---|---|---|
| 交接前（`AUTOMATED_RPC`） | 工具零确认；argv `--approve`、env `CODEESTRA_PERMISSION_MODE=FULL`（CLI e2e 逐 incarnation 从 provider 自己读回） | argv `--no-approve` + `--tools <白名单>`；工具经**既有** Attention（分类器单元测试 + Runtime Attention/原子拒绝测试） |
| 接管中（原生 TUI） | **零** `permission_request`，工具真执行（真实 Pi TUI + 生产 gate + 生产 PTY） | 每个 `bash` 一条 `permission_request`（`piMode=tui`），决议经 side channel 生效；ALLOW 真执行、DENY 不执行且不挂死（同一套真实环境） |
| 交还后（`AUTOMATED_RPC`） | argv/env 与工具白名单逐字保持（CLI e2e，两个模式各双向一遍） | 同上 |
| 交接本身是否新增确认 | **否**：`request`/`admit`/`attach`/`detach`/`release` 全零确认（命令面没有确认输入） | 同左 |
| incarnation 绑定的过期决议 | 原子拒绝 `INCARNATION_NOT_CURRENT`；两个 answer 不可能都成功 | 同左 |
| **不成立的那一格** | — | **真实 provider + 由人经记录下来的 Attention 决定 + 原生 TUI 接管的组合**：两半各自有证据（真实 Pi → side channel；Runtime Attention → 投递与原子拒绝），合起来没跑过。工具类别也只实测了 `bash`；`edit`/`write` 与未知工具的 fail-closed 由分类器单元测试覆盖 |
