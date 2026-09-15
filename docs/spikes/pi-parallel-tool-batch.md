# Pi 并行工具批次的安全点与原生 TUI 的权限模式（真实 Pi + 脚本化模型）

状态：**已完成**。只读 spike + 两个可复跑探针（`docs/spikes/pi-parallel-tool-batch/*.ts`）；未改任何既有 ADR 正文。
本格（M3 / FOUNDATION-083）用它把 `SessionHandoffCapabilities` 的两个残留值改成有证据的形式：
`parallelToolBatchSafePoint: UNVERIFIED → IMPLEMENTED`，以及 `crossHandoffPermissionModeMatrix` 继续 `PARTIAL`
但把**不成立的那一格**写清楚（见 §5）。

本文严格区分：**已实测**（附命令与原始输出）、**代码级佐证**（读了哪一段源码）、**未验证 / 无法在本机验证**。

## 0. 方法：什么是真的、什么是脚本化的

- 真实：`pi` 0.85.1（本机 Nix profile），Pi 自己的 agent loop 与 extension runner，
  **生产** gate extension `packages/agent-adapters/src/pi-gate-extension.ts`，
  真实工具执行（`bash` 真的起了子进程并写了文件），真实 handoff side channel（UNIX socket + 生产帧协议），
  TUI 探针还用了**生产** PTY 传输（`pi-pty.ts` + `pi-pty-host.ts`，即本格刚为 resize 扩过的代码）。
- 脚本化：**模型**。一个本机 OpenAI 兼容流式端点（`127.0.0.1:<随机端口>`，`openai-completions` API）按请求序号作答：
  第 1 个请求回**一条** assistant 消息带**两个** `tool_calls`（这就是「并行工具批次」的定义），第 2 个请求回纯文本。
  模型是唯一被替换的东西；被测的排序与门禁语义全在 Pi 与 Codeestra 的代码里。
- 不含：真实模型、真实额度、桌面/键鼠/窗口自动化、浏览器自动化。模型端点与 side channel 都在 `127.0.0.1` 与临时目录内。
- 复跑（每次约 5–10 秒，不联网、不消耗额度）：

```sh
cd <worktree>/docs/spikes/pi-parallel-tool-batch
bun rpc-fence-probe.ts                                        # 并行批次 + fence（无新工具）
bun rpc-fence-probe.ts --fence-after-start 1 --fence-delay-ms 300 --second-turn-tool
bun tui-permission-probe.ts --mode FULL                       # 原生 TUI，FULL
bun tui-permission-probe.ts --mode STRICT                     # 原生 TUI，STRICT，两个请求都 ALLOW
bun tui-permission-probe.ts --mode STRICT --deny 1            # 原生 TUI，STRICT，拒第一个
```

时间戳都是相对探针启动的毫秒偏移。`tool_start/…/agent_settled` 行来自 side channel 的**生产帧**，
`rpc …` 行来自 `pi --mode rpc` 自己的事件流（第二份独立证据）。

## 1. 并行批次的事件顺序（实测）

`bun probe.ts`（无 fence）：

```
+  1532ms tool_start #1 bash id=call_a activeTools=1
+  1533ms tool_start #2 bash id=call_b activeTools=2     ← 两个 start 都在任何 end 之前
+  2544ms tool_end bash id=call_b isError=false activeTools=1   ← 按完成顺序
+  3547ms tool_end bash id=call_a isError=false activeTools=0
+  3555ms agent_settled activeTools=0 (ms after last tool_end: 8)
```

对应 `pi --mode rpc` 的独立事件流：

```
rpc tool_execution_start toolName=bash
rpc tool_execution_start toolName=bash
rpc tool_execution_end isError=false result={"content":[{"type":"text","text":"PROBE-B-END\n"}]}
rpc tool_execution_end isError=false result={"content":[{"type":"text","text":"PROBE-A-END\n"}]}
rpc turn_end / turn_start / turn_end / agent_end / agent_settled
```

结论（实测）：**同一消息的两个工具调用会各自上报一次 `tool_start` 与一次 `tool_end`，`tool_start` 在全部 `tool_end` 之前，
`tool_end` 按完成顺序，`agent_settled` 在最后一个 `tool_end` 之后**（本机 +8ms）。
因此按 provider `toolCallId` 计数活动工具的 Runtime 在批次进行中一定看到 `activeTools > 0`，
「fence 已确认 + `settled` + `activeTools === 0`」这套安全点判定在并行批次下**不会提前成立**。

## 2. 批次进行中打开 fence（实测，关键）

`bun rpc-fence-probe.ts --fence-after-start 1 --fence-delay-ms 300 --second-turn-tool`
（第 1 个 `tool_start` 后 300ms 下发 `{"kind":"fence","active":true}`；脚本化模型的第 2 个请求**再要一次工具调用**）：

```
+  1531ms tool_start #1 bash id=call_a activeTools=1
+  1532ms tool_start #2 bash id=call_b activeTools=2
+  1832ms RUNTIME sends fence(active=true) activeTools=2
+  1832ms fence_ack active=true activeTools=2
+  2544ms tool_end bash id=call_b isError=false activeTools=1
+  3546ms tool_end bash id=call_a isError=false activeTools=0
+  3551ms tool_start #3 bash id=call_after_2 activeTools=1
+  3551ms tool_end bash id=call_after_2 isError=true activeTools=0
+  3552ms agent_settled activeTools=0 (ms after last tool_end: 1)
```

同一轮的工具结果（生产 gate 的 terminating block 原文）：

```
rpc tool_execution_end isError=false result={"content":[{"type":"text","text":"PROBE-B-END\n"}]}
rpc tool_execution_end isError=false result={"content":[{"type":"text","text":"PROBE-A-END\n"}]}
rpc tool_execution_end isError=true  result={"content":[{"type":"text","text":"CODEESTRA_HANDOFF_FENCE: no new tools after the safe point"}],"details":{},"terminate":true}
```

结论（实测）：

1. **已经开始的工具没有被 abort**：两个 `sleep` 都跑完，`isError=false`，输出是它们真正的输出（`PROBE-A-END` / `PROBE-B-END`）。
   fence 只改变 gate 之后的行为，不碰已 preflight 通过的同批兄弟调用。
2. **fence 之后新到达的工具调用被终止性 block**：`terminate: true`，未执行（没有第三个文件/输出）。
3. **安全点仍然可判定**：`fence_ack`（+1832ms）→ 最后一个 `tool_end`（+3546ms）→ `agent_settled`（+3552ms，activeTools=0）。
   Runtime 的四个条件依次成立，交接不会被并行批次卡住，也不会在批次中途被误判。

## 3. 代码级佐证（读了哪一段、证明什么）

`pi` 0.85.1 自带的源码（只读，未修改）：

- `node_modules/@earendil-works/pi-agent-core/src/agent-loop.ts` 的 `executeToolCallsParallel()`：
  对每个 tool call 依次 `emit({type:'tool_execution_start'})` → `await prepareToolCall(...)` → 把执行放进 thunk；
  之后 `Promise.all(...)` 并发执行，每个 thunk 结束时 `emitToolExecutionEnd(...)`。
  → **`tool_start` 一定先于同一调用的 `tool_call`/执行，`tool_end` 一定在执行之后**；预检是**串行**的，执行是**并发**的。
- 同一函数里 `prepareToolCall` 返回 `{kind:'immediate'}`（被 gate 拦下）的分支**也会** `emitToolExecutionEnd(...)`。
  → 被 fence 或审批拒绝的调用**不会**留下一个永不结束的 `tool_start`；Runtime 的 `activeTools` 不会泄漏。
  （这正是 `tool_start #3` 之后 1ms 内就出现 `tool_end #3` 的实测形状。）
- `shouldTerminateToolBatch()`：只有**整批**结果都是 terminating 才终止该轮。所以「A 正常完成 + B 被 fence 拦」时该轮继续，
  下一个 LLM 调用里的新工具再次被拦（探针实测到这一点：`model request #2` 之后就是被拦的 `call_after_2`），
  直到某批全部被拦才 `agent_settled`。
- `dist/core/agent-session.js` 的 `_runAgentPrompt()` → `finally { await this._emitAgentSettled(); }`：
  `agent_settled` 在整次 run（含 retry/compaction/follow-up）收尾时才发出。
  → 安全点里的 `settledAfterFence` 与「批次已结束」是同一个事实，不存在「工具还在跑但已 settled」的可达顺序。

**测不到的一格（明确标注）**：fence 恰好在同一批次**预检中间**到达（即在 `prepare(A)` 之后、`prepare(B)` 之前）。
本机无法稳定复现这个亚毫秒窗口；按上面的代码，此时 B 会在 `tool_call` 里被拦成 terminating block，
A 仍会执行，而整批不会终止（因为 A 的结果不是 terminating）。**这是代码推断，不是实测**，未写入任何能力声明。

## 4. 原生 TUI 下的权限模式（实测，真实 Pi + 生产 gate + 生产 PTY）

`bun tui-permission-probe.ts --mode FULL`（`--approve`）：

```
+    25ms TUI launched pid=30994 slave=/dev/ttys016 windowSize=APPLIED
+    41ms transport resize → {"cols":120,"rows":40,"applied":"APPLIED","detail":"stty"}
+   498ms side-channel hello mode=tui hasUI=true permissionMode=FULL
+  2588ms tool_start bash id=call_a
+  2589ms tool_start bash id=call_b
+  2601ms tool_end bash isError=false
+  2601ms tool_end bash isError=false
+  2607ms agent_settled
+  2644ms tool A artefact written: true (TUI-TOOL-A-RAN)
+  2644ms tool B artefact written: true (TUI-TOOL-B-RAN)
+  2644ms settled observed: true (permission requests: 0)
```

`bun tui-permission-probe.ts --mode STRICT`（`--no-approve --tools read,bash,edit,write,grep,find,ls,ask_user_question`）：

```
+   475ms side-channel hello mode=tui hasUI=true permissionMode=STRICT
+  2572ms tool_start bash id=call_a
+  2573ms permission_request #1 tool=bash input={"command":"echo TUI-TOOL-A-RAN > …"} piMode=tui → RUNTIME answers ALLOW
+  2575ms tool_start bash id=call_b
+  2576ms permission_request #2 tool=bash input={"command":"echo TUI-TOOL-B-RAN > …"} piMode=tui → RUNTIME answers ALLOW
+  2586ms tool_end bash isError=false
+  2587ms tool_end bash isError=false
+  2591ms agent_settled
+  2624ms tool A artefact written: true (TUI-TOOL-A-RAN)
+  2624ms tool B artefact written: true (TUI-TOOL-B-RAN)
```

`bun tui-permission-probe.ts --mode STRICT --deny 1`（拒绝第一个）：

```
+  2594ms tool_start bash id=call_a
+  2596ms permission_request #1 … → RUNTIME answers DENY
+  2599ms tool_end bash isError=true
+  2599ms tool_start bash id=call_b
+  2600ms permission_request #2 … → RUNTIME answers ALLOW
+  2606ms tool_end bash isError=false
+  2612ms agent_settled
+  2627ms tool A artefact written: false (-)          ← 被拒的调用真的没执行
+  2627ms tool B artefact written: true (TUI-TOOL-B-RAN)
+  2627ms screen contains TUI-A-END: true             ← 屏幕上却有它的「请求」
```

结论（实测）：

1. **FULL 在原生 TUI 下就是零确认**：两个工具调用、**0** 条 `permission_request`，真跑了。
2. **STRICT 在原生 TUI 下走既有 side channel**：每个 `bash` 各产生一条 `permission_request`，
   `piMode=tui`；决议从 side channel 回来（终端里没有人作答，也不需要），工具随后执行。
   生产 gate 从不调用 `ctx.ui.confirm`，因此 TUI 里没有第二个、无法绑定 incarnation 的决议通道。
3. **批准与拒绝都成立**：ALLOW → 真执行；DENY → `isError=true`、**没有产物文件**，而且 `agent_settled` 仍然到达（不挂死）。
4. **屏幕不是事实来源**：被拒的调用其命令文本仍出现在屏幕上（`screen contains TUI-A-END: true`），
   而文件系统证明它没跑。任何从终端字节推断业务状态的实现都会在这里出错。
5. **同一批次的两条审批是串行的**：`permission_request #1` → 决议 → `permission_request #2`。
   这是 Pi 预检串行的直接后果，也就是说 **Runtime「一次只有一条待决 Attention」的模型在并行批次下仍然成立**。
6. 顺带复验了本格的 resize：真实 TUI 在**生产 PTY 传输**上收到 `{"cols":120,"rows":40}` 并回 `APPLIED`（`stty`）。

## 5. 未验证 / 无法在本机验证（不得当成已成立）

1. **真实模型**：以上探针的模型是脚本化的。真实模型的工具选择、并行度、以及对 fencing/审批的反应**未验证**。
2. **fence 落在同批次预检中间**（§3 末）——代码推断，未实测。
3. **用户经 CLI/UI Attention 决定后进入原生 TUI 的完整链路**：本探针直接在 side channel 上答题（与 Runtime 的 `permission_decision` 同形状），
   Runtime 侧的 Attention 记录/投递/incarnation 原子拒绝由 `apps/runtime/test/session-handoff-service.test.ts` 用真 Runtime + stub provider 覆盖；
   **两者一起跑（真 Pi + 真 Attention + 真人决定）没有做过**——这是 `crossHandoffPermissionModeMatrix` 保持 `PARTIAL` 的那一格。
4. **工具类别覆盖**：审批路径实测只覆盖 `bash`。`edit`/`write` 与未知工具的 fail-closed 由 `classifyPiTool` 的单元测试覆盖，
   未在真实 provider 上逐类跑过。
5. **其他平台/provider**：Windows、Linux、Codex、Claude Code 均未覆盖（Codex/Claude 的交接能力按各自 spike 如实为 `UNSUPPORTED`）。
6. **TUI 原生对话框与本通道竞争**：本探针没有让终端里的人作答，因此「只接受第一份合法决议」仍未验证（沿用 FOUNDATION-040 §3.6）。

## 6. 这些事实对应的实现与测试

| 事实 | 代码位置 | 自动化测试 |
|---|---|---|
| `tool_start`/`tool_end` 按 `toolCallId` 计数、批次进行中 `activeTools > 0` | `session-handoff-service.ts#applyBusinessFrame` / `#evaluateSafePoint` | `apps/runtime/test/session-handoff-service.test.ts`「counts a parallel tool batch…」 |
| 批次未结束不得准入；Runtime 从不 abort 在跑的工具 | `#evaluateSafePoint`、`admitSuccessor` | 同上 + 「only hands over at a safe point…」（断言发出的帧里没有 abort） |
| 待决审批即使 `settled` 且 `activeTools === 0` 也不得称安全点 | `#evaluateSafePoint` 的 `getOpenSessionPermissionRequest` 分支 | 同上 |
| STRICT 审批 = 既有 Attention，决议按 incarnation 原子拒绝 | `#recordPermissionRequest` / `answerPermission` | 「carries one STRICT permission…」「…incarnation that is no longer the writer」「two answers cannot both win」 |
| 模式跨交接不变（argv + env + STRICT 工具白名单） | `terminal-service.ts` / `pi-adapter.ts` 都读同一份持久设置 | `apps/runtime/test/cli-session-attach.test.ts`「keeps the permission mode across the handoff in both directions, in both modes」 |

## 关联

- `docs/decisions/0054-pty-resize-parallel-safe-point-and-permission-matrix.md`（本格的决策与能力取值）
- `docs/decisions/0010-live-agent-terminal-takeover.md`、`0023-strict-permission-attention-and-session-writer-lease.md`、`0026-native-terminal-pty-transport.md`
- `docs/decisions/0011-default-full-permission-mode.md`（FULL 零确认 / STRICT 保留既有门禁）
- `docs/spikes/pi-session-handoff.md`（FOUNDATION-040；其 §3.2「并行批次下预检与执行的重叠未验证」由本文回答）
- `docs/architecture/agent-adapter-api.md`（能力表与 TerminalTransport 合约）
