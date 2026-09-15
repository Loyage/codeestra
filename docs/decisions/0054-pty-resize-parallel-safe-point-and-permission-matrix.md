# ADR-0054 — PTY resize 的传输合约、并行工具批次的安全点判定、跨交接权限模式矩阵

状态：**Accepted**（协调者在开工时裁决本格使用 ADR-0054，M1 占 0053；三条决定都是把已实测事实写成规范 + 把能力声明改成有证据的形式，
没有新增权限门禁、审批层或沙箱）。**Amends ADR-0026 的能力表三行**（`ptyResize`、`parallelToolBatchSafePoint`、
`crossHandoffPermissionModeMatrix` 的取值与理由），该正文一字未改。

关联文档：`docs/spikes/pi-parallel-tool-batch.md`（本格真实 Pi 实测证据）、
`docs/spikes/pi-session-handoff.md`（FOUNDATION-040）、
`docs/architecture/agent-adapter-api.md`（TerminalTransport 合约与能力表）、
`docs/guides/cli-reference.md` §7。

## 背景

`SessionHandoffCapabilities` 里有三个残留值，是本仓自己写的「诚实差距」：`ptyResize: UNSUPPORTED`、
`parallelToolBatchSafePoint: UNVERIFIED`、`crossHandoffPermissionModeMatrix: PARTIAL`。
ADR-0026 把 PTY 传输做起来时明确写了「resize 不在本格范围」，`pi-pty-host.ts` 里也留有当时的实测记录：
直接 `ioctl(TIOCSWINSZ)` 在本机（darwin/arm64）会把终端尺寸写成垃圾。ADR-0010/0023/0026 要求「只在安全点交接」，
但安全点判定在**并行工具批次**（同一 assistant 消息多个 tool call）下从未被验证——FOUNDATION-040 §3.2 把这一条
原样列为未验证项。跨交接的权限模式矩阵同样只有「单次转换」的证据，没有覆盖 FULL/STRICT × 三个阶段的完整格子。

## 选项

### A. resize 的实现机制

1. **`ioctl(TIOCSWINSZ)` on the PTY master（FFI）**：最「正统」，但本机实测不可用。`dlopen` 出来的 `ioctl`
   声明为定参函数，而 `ioctl(2)` 是变参函数；AArch64 的变参 ABI 把第三个参数放在栈上，于是 FFI 传的指针地址
   根本没被读——调用返回 0，终端尺寸不变，而 provider 自己 `stty size` 读到的是**每次都不一样的内存垃圾**
   （两次实验分别读到 `7448 1545` 与 `56600 2122`，而 `TIOCGWINSZ` 回读是 `0 0`）。**错尺寸比没尺寸更坏。**
2. **`stty rows R cols C` 作用在终端自己的 slave 设备上**：与启动时设置初始尺寸用的是**同一个接口**
   （`pi-pty-host.ts#applyWindowSize` 已用它设置初始尺寸），也是 provider 自己读尺寸的接口（`TIOCGWINSZ`）。
   实测在同一终端上 `stty size` 由 `25 80` 变成 `33 99`，provider 内读取同步变化。
3. 不做 resize，维持 `UNSUPPORTED`。

### B. 安全点判定规则

1. 沿用现有规则不做验证，`parallelToolBatchSafePoint` 永远停在 `UNVERIFIED`（「诚实但没用」）。
2. 用代码阅读推断「顺序批次与并行批次没有区别」，直接改成支持（**没有实测就改声明，禁止**）。
3. 用真实 Pi + 脚本化模型实测并行批次的帧序、fence 行为与 settled 时机，按实测结果改声明。

### C. 跨交接权限模式矩阵的取值

1. 有真实 TUI 权限证据就整体改成「已支持」。
2. 保持 `PARTIAL`，但把**每一格**的证据与**不成立的那一格**写清楚。

## 决定

### D01 resize 是 TerminalTransport 合约的一部分（versioned），机制是 `stty` on the terminal's slave

PTY 原始字节、input 路由与 resize **都不进 `AdapterEvent`**（ADR-0010 D06 早已写死），而是 Runtime 与它自己的
PTY host helper 之间的 **TerminalTransport** 帧协议。本格给这份协议一个显式版本号并在握手里协商：

- 探针计划里带 `transport: 1`，helper 只接受它支持的那一版，`ready` 帧**回显**该版本；Runtime 侧核对不一致即
  `PTY_TRANSPORT_PROTOCOL_MISMATCH` 拒绝（不猜、不降级）。
- 帧表新增：命令 `{t:'resize', cols, rows}`，应答 `{t:'resized', cols, rows, applied:'APPLIED'|'NOT_APPLIED', detail}`。
  `detail` 是稳定原因串（`stty` / `STTY_FAILED` / `INVALID_SIZE` / `PROVIDER_EXITED`），**永不出现「没回答」**：
  helper 一定回一帧。
- 机制固定为 `stty rows/cols` 作用在该终端的 **slave fd** 上（选项 A2）。因此 helper 现在**保留自己的 slave 副本**
  到终端生命周期结束：provider 是否退出由 `waitpid` 判定（不是靠 master EOF，实测 master 在 provider 退出后不保证报 EOF），
  而失去 resize 能力才是更坏的交易。上文 §背景 的 ioctl 失败实测写入 helper 注释，避免下一个人再试一次。
- resize 的取值域是**合约的一部分**：`1..1000` 的整数行列，Runtime（`TERMINAL_RESIZE_INVALID_SIZE`）、
  helper（`INVALID_SIZE`）与 Zod 契约（`z.number().int().min(1).max(1000)`）三处都拒绝越界。

### D02 `session.handoff.terminal.resize`：CLI 完备、零确认、退出码与稳定码

```
bun run codeestra session handoff terminal resize <project-id> <session-id> --cols <n> --rows <n>
  [--holder <ref>] [--json]
```

- 退出码：`0` 只有**真的改了尺寸**（transport 自己回的 `applied: 'APPLIED'`）；`1` 拒绝或未生效；
  `2` 越界/缺参（先于任何 Runtime 调用拒绝，并在 stderr 打稳定码 `TERMINAL_RESIZE_INVALID_SIZE`）。
- 两种拒绝，都来自 Runtime 已有的事实，**不是新门禁**：
  1. 本 Runtime 不持有该终端（别的 Runtime 代际启动的）→ `TERMINAL_NOT_HELD`；无运行中终端 → `TERMINAL_NOT_RUNNING`。
  2. 终端的 **writer 座位**拥有视口：若已有客户端持有该终端的 WRITER attachment，只有它能 resize，
     其他 holder（或不带 `--holder`）→ `TERMINAL_RESIZE_WRITER_BUSY` 并报出当前 holder。
     这是 `attach` 已经在执行的同一条单 writer 规则，不是新增审批：**常态路径 0 新增步骤、0 确认、不排队**。
- 命令面**只改终端几何**，不写、不读、不解释终端字节，也不写任何业务状态；`session.handoff.status` 新增
  `terminal.currentSize`（仅当本 Runtime 仍持有该终端时非 null），因为启动时的 `windowSize` 只是「启动时是否成功」
  这一事实，**不能**当作「现在的尺寸」。

### D03 安全点判定规则在并行批次下不变，并据此把声明改为 `IMPLEMENTED`

规则不变（ADR-0010 D03 原文）：**fence 已确认 + 活动工具计数为 0 + fence 之后有 `agent_settled` + 无待决 Attention**。
本格实测证明这条规则在并行批次下**可达且不会被绕过**（证据见 `docs/spikes/pi-parallel-tool-batch.md`）：

1. 同一消息的多个工具调用各自上报 `tool_start`/`tool_end`（按 provider `toolCallId`），
   **全部 `tool_start` 先于任何 `tool_end`**，`tool_end` 按完成顺序；
2. `agent_settled` 在最后一个 `tool_end` 之后（本机 +8ms），所以不存在「工具还在跑但已 settled」；
3. 批次进行中打开 fence：**已开始的兄弟调用不被 abort**（真实输出、`isError=false`），
   下一个到达的工具调用被 terminating block（`CODEESTRA_HANDOFF_FENCE…`），随后 1ms 内 `agent_settled`；
4. 被 fence/审批拦下的调用**也会**有 `tool_end`（Pi 的 immediate 分支），所以活动计数不会泄漏成「永远不静止」；
5. 待决的 STRICT Attention 即使 `settled` 且 `activeTools === 0` 也**不构成安全点**（`#evaluateSafePoint` 的 open-Attention 分支）。

因此 `parallelToolBatchSafePoint: UNVERIFIED → IMPLEMENTED`。**未能实测的一格**（fence 恰好落在同批次预检中间）
按代码推断而非实测，不进入声明（写进 spike §3 与 §5）。

### D04 跨交接权限模式矩阵：保持 `PARTIAL`，把不成立的那一格写死

矩阵（FULL/STRICT × 交接前 / 接管中（原生 TUI）/ 交还后）逐格证据：

| 格 | 结论 | 证据（类型） |
|---|---|---|
| FULL · 交接前（AUTOMATED_RPC） | 工具零确认；argv `--approve`、env `CODEESTRA_PERMISSION_MODE=FULL` | 真 CLI e2e：每个 incarnation 自己读回的 argv/env（stub provider） |
| FULL · 接管中（HUMAN_TUI） | 零 `permission_request`，工具真执行 | **真实 Pi** TUI + 生产 gate + 生产 PTY（脚本化模型） |
| FULL · 交还后（AUTOMATED_RPC） | 同上 argv/env；交接本身 0 新增确认 | 真 CLI e2e（两个方向各一遍） |
| STRICT · 交接前 | argv `--no-approve` + `--tools <白名单>`；工具经既有 Attention | CLI e2e（argv/env）+ `classifyPiTool` 单元测试 + Runtime Attention 测试 |
| STRICT · 接管中（HUMAN_TUI） | 每个 `bash` 一条 `permission_request`（`piMode=tui`），决议经 side channel 生效；ALLOW 真执行、DENY 不执行且不挂死 | **真实 Pi** TUI + 生产 gate + 生产 PTY（脚本化模型） |
| STRICT · 交还后 | argv/env 与工具白名单逐字保持 | 真 CLI e2e |
| 交接本身是否新增确认 | 否：`request/admit/attach/detach/release` 全部零确认（命令面根本没有确认输入） | CLI e2e 全链路 + ADR-0011 |
| incarnation 绑定的过期决议 | 原子拒绝（`INCARNATION_NOT_CURRENT`），且两个 answer 不可能都成功 | Runtime 测试（真 storage + 真 service） |
| **不成立的那一格** | **真实 provider + 由人经记录下来的 Attention 决定 + 原生 TUI 接管的组合**。两半各自有证据（真 Pi → side channel；Runtime Attention → 投递/原子拒绝），合起来没跑过 | 无 |

因此**不改** `crossHandoffPermissionModeMatrix`（仍 `PARTIAL`），但把上表写进
`docs/architecture/agent-adapter-api.md` 与代码注释，让「哪一格不成立」不再需要猜。

### D05 平台范围用「陈述」表达，不塞进取值

`ptyResize: IMPLEMENTED` 的平台范围是 **POSIX（Runtime 持有的 PTY）**，依据是本机 darwin/arm64 的真实 PTY 测试；
Windows 没有 PTY 传输（`ptyTransport`/`windows` 均为 `UNSUPPORTED`），resize 跟随它们一起 `UNSUPPORTED`。
Linux 走的是**同一段** `stty` on slave 代码路径，但**本机未实测**——这一点写在能力表与代码注释里，不用新取值掩盖。

**记录一条事实**：协调者第一次给出的取值词汇是 `AdapterCapabilities` 的 `SUPPORTED/UNSUPPORTED/REQUIRES_VALIDATION`，
本格核对代码后指出 `SessionHandoffCapabilities` 的取值集是 `IMPLEMENTED/UNSUPPORTED/PARTIAL/UNVERIFIED`
（`apps/ui/src/types.ts:545` 同集，且其中没有 `SUPPORTED`），协调者随后纠正并裁定用本表既有词汇。此纠正不改任何取值，只改正流程。

## 后果

- **更好**：终端几何可被 CLI 脚本化驱动（`--json` + 稳定退出码），能力表不再对 resize 说谎；
  并行批次的安全点从「未验证」变成有实测支撑的声明；权限矩阵的空白格被点名。
- **代价**：helper 现在多持有一个 slave fd 到终端结束（provider 退出仍由 `waitpid` 判定，实测未改变任何释放/停止行为，
  既有 `terminal-service` 7 项测试全部仍然通过）；每次 resize 起一个短命 `stty` 进程（有界 2s，与启动时同一个做法）。
- **跨格交接（如实记录）**：`apps/ui/src/terminal.tsx:580` 硬编码了「· resize 不支持（能力矩阵为 UNSUPPORTED）」，
  本格**未改** `apps/ui/**`（M2 领地）。协调者已裁决由 M2 改为**按能力值动态渲染**；在此之前 UI 会显示自相矛盾的
  「IMPLEMENTED · resize 不支持」。这是一条已知投影缺口，不是本格的主张。
- **已知陈旧引用（本格不改，交给下次 doc-sync / 属主）**：
  `packages/agent-adapters/src/pi-adapter.ts:54` 的注释、`docs/decisions/0026-*.md:159`、`docs/decisions/0035-*.md:58`
  仍写着旧取值。既有 ADR 正文按规矩不改（由本 ADR amend）；`pi-adapter.ts` 的注释属其所属 lane 的最小改动，本格未越界。
- **未验证（不得当成已成立）**：真实模型下的并行批次与权限行为；fence 落在预检中间的亚毫秒窗口（仅代码推断）；
  真人经 Attention 决定后进入原生 TUI 的完整链路；`edit`/`write` 与未知工具的 provider 级实测；Linux/Windows；
  TUI 原生对话框与本通道竞争；终端观感（resize 后的实际重排只能人工确认）。

## 验证要求

- `bun run typecheck` 退出码 0（根项目；本格未改 `apps/ui`）。
- 真实 PTY 定向测试：`packages/agent-adapters/test/pi-pty.test.ts` 的 resize 用例断言
  provider 自己读到的尺寸由 `30 100` 变 `33 99`、再变 `12 40`，且非法尺寸以 `INVALID_WINDOW_SIZE` 拒绝、
  退出后以 `TERMINAL_EXITED` 拒绝。
- `apps/runtime/test/terminal-service.test.ts`：`resize` 真的改变 provider 的终端尺寸并把
  `currentSize` 反映到投影；非法尺寸 → `TERMINAL_RESIZE_INVALID_SIZE`；第二个 holder → `TERMINAL_RESIZE_WRITER_BUSY`
  （报出 holder）；不持有终端的 Runtime 代际 → `TERMINAL_NOT_HELD`。
- `apps/runtime/test/cli-session-attach.test.ts`：CLI resize 的 0/1/2 三种退出码与稳定码，
  并断言 provider 自己看到 `STUB-TUI-SIZE:30 90`；另有 FULL 与 STRICT 两个方向各一遍的模式保持用例。
- `apps/runtime/test/session-handoff-service.test.ts`：并行批次计数、批次未结束不得准入、
  待决 Attention 即使 settled 也不构成安全点、STRICT 审批逐条成为 Attention。
- 真实 Pi 证据：`docs/spikes/pi-parallel-tool-batch.md` 的两个探针（可复跑，无需额度），以及其中逐条标注的
  「实测 / 代码级佐证 / 未验证」。
