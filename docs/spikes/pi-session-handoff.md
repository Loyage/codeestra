# Pi 0.84.4 Session-file 双向交接 Spike（FOUNDATION-040）

状态：**已完成**。仅技术 spike，无生产代码修改、未 commit、未 push、未触碰 `dev`/`main` 工作树。
结论：ADR-0010 的三个前提在真实 Pi 0.84.4 + 真实模型下**均成立**，但其中两条伴随必须由 Codeestra Runtime 自己实现的守卫（见 §5）。
本文严格区分 **已实测**（附命令与原始输出）、**未验证**、**不支持/做不到**。

## 0. 范围、环境与方法

- Provider：`pi` 0.84.4（`/etc/profiles/per-user/loyage/bin/pi` → Nix `pi-coding-agent-wrapped-0.84.4`），Node 24.19.0，macOS（darwin/arm64）。
- 真实模型：`--provider deepseek --model deepseek-flash`（`deepseek-flash`，thinking 默认 `high`），每次调用均为真实 provider 请求。
- 受控启动逐字复刻 `packages/agent-adapters/src/pi-rpc.ts#buildPiRpcArguments` 的 argv：
  `--approve|--no-approve --no-extensions --extension <gate> --no-skills --no-prompt-templates --no-themes --no-context-files [--tools <allowlist>] --session-dir <dir> [--session <file>] --provider deepseek --model deepseek-flash`。
  TUI 观测使用完全相同的 argv，仅去掉 `--mode rpc`。
- TUI 观测方式：真实 PTY（`python3` `pty.openpty()` + `start_new_session=True`），PTY master 由常驻的 `pty_host.py` 持有（模拟 Runtime 持有 PTY），CLI 侧通过 UNIX socket 控制面 attach/detach/write/resize。**没有使用桌面、键鼠或窗口自动化**；TUI 的渲染结果从 PTY 字节流中提取文本后断言。
- RPC 观测方式：真实 `pi --mode rpc` 子进程 + LF-JSONL（自写驱动，不使用会被 U+2028/2029 干扰的通用 line reader）。
- spike 脚本与原始证据（全部在 `/tmp`，不入库）：
  - `/tmp/a2-spike/harness.py`（RPC/PTY/side-channel 驱动）、`pty_host.py`、`rpc_host.py`、
    `ext/a2-sidechannel.ts`（spike 专用 side channel 扩展）、`ext/a2-native-dialog.ts`（spike 专用原生对话框扩展）
  - 测试：`t1_rpc_baseline.py`、`t2_tui_resume.py`、`t3_permissions.py`、`t4_sidechannel.py`、
    `t5a_orphan_probe.py`、`t6_processes.py`、`t7_dialogs.py`、`t8_crash_steer.py`、`t9_tui_durability.py`
  - 原始输出：`/tmp/a2-spike/logs/*.jsonl`（Pi RPC 全量事件）、`/tmp/a2-spike/logs/*.log`（PTY 原始字节、
    side channel 全量帧）、`/tmp/a2-spike/logs/t*-run.log`（脚本 stdout）
  - session 文件：`/tmp/a2-spike/sessions/t*/`
- 环境变量对子进程取白名单，显式剔除嵌套 Pi 会话注入的 `PI_SESSION_FILE/PI_SESSION_ID/...`，并置 `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0`。

## 1. 三个前提的结论

| 前提 | 结论 | 依据 |
|---|---|---|
| 1. RPC 会话 → 原生 TUI/PTY → detach → 交还 RPC，仍能用**同一个** conversation/session 继续 | **成立** | §2.1（T2/T9/T8），同一 session file、同一 session ID、同一 entry tree 追加 |
| 2. PTY 与进程生命周期可控 | **成立，但有 3 个必须由 Runtime 补的守卫** | §2.2（T2/T6/T5A） |
| 3. 权限模式 side channel 与结构化安全点 | **成立**；但现 gate 扩展在 TUI 下不可用，STRICT+TUI 必须新增 side channel | §2.3（T3/T4/T7） |

## 2. 已实测

### 2.1 session-file 双向恢复（T2 / T9 / T8）

**T2 全链路**：RPC(FULL) 建会话 → SIGTERM → 真实 TUI `--session <file>` → 在 TUI 里键入真实用户消息 → 客户端 detach/reattach → Ctrl+D 退出 → RPC `--session <file>` 恢复并继续。

```
=== phase 1: RPC FULL session with real model + write tool ===
pid: 515 sessionId: 01a09c61-7413-7e52-8d41-d2a393939b8e
agent_settled: True
SIGTERM exit code: 143
rpc alive after kill: False

=== phase 2: real TUI on the same session file, inside a PTY ===
  TUI screen contains 'A2SPIKE-TOKEN-RPC-003': True
  TUI screen contains 't2-artifact.txt': True
=== client A writes a real user message in the TUI, then detaches ===
client A detached at 04:07:20
reattach status: {'ok': True, 'alive': True, 'bytes': 86053}
TUI survived detach: True
TUI answer on screen: True
=== release: Ctrl+D on an empty editor ===
TUI exit status: {'ok': True, 'alive': False, 'exit': 0}

=== phase 3: RPC resume on the same session file (return handoff) ===
resumed sessionId: 01a09c61-7413-7e52-8d41-d2a393939b8e same: True
messageCount: 7
assistant after resume: 'A2SPIKE-TOKEN-RPC-003, A2SPIKE-TOKEN-TUI-004, ORCHID-HANDOFF-7'
```

模型在交还后的 RPC 会话里同时复述了 RPC 阶段与 TUI 阶段的 token，以及 RPC 阶段埋入的 passphrase：
证明**交还后继续的是同一个 conversation，而不是"看起来像"的复制品**。

同一 session file 的 entry 链（`/tmp/a2-spike/sessions/t2/2026-09-13T20-07-07-539Z_*.jsonl`，append-only）：

```
session            id=01a09c61-... parent=None
model_change       id=38dada19    parent=None
thinking_level_change id=41eaef9f parent=38dada19
message user       id=6377a201    parent=41eaef9f   ← RPC 阶段
message assistant  id=a9a53139    parent=6377a201
message toolResult id=e52c8f8e    parent=a9a53139
message assistant  id=c55dbb50    parent=e52c8f8e
message user       id=673c1fee    parent=c55dbb50
message user       id=019bfacc    parent=673c1fee   ← TUI 阶段键入
message assistant  id=727cfbc8    parent=019bfacc
message user       id=13f11167    parent=727cfbc8   ← 交还后 RPC
message assistant  id=ea9cd778    parent=13f11167
unique ids: True
```

→ entry id 跨进程交接**稳定**、**不改写**、链式 parent 完整；`entry id` 可作为跨 incarnation 的耐久 cursor。

**T9：TUI 键入的用户消息何时耐久？** 键入后轮询 session 文件：

```
user message visible in the session file after 0.8s
entries at kill time: 5 ['session','model_change','thinking_level_change','message','message']
host killed; TUI alive: False
after hard kill, session entries: [...5 条...]
contains marker after kill: True
=== resume that file with RPC ===
resumed sessionId: 01a09c71-... messageCount: 2
assistant: 'Reply with exactly A2DURABILITY-PROBE-9 and nothing else. Think carefully first.'
```

→ TUI 键入正文在 **≤1s** 内落 provider session file，SIGKILL 后仍在（ADR-0010 D02/D06 的"只保存 entry 引用/hash/长度"可行）。

**T8：崩溃（SIGKILL 于工具执行中）后的文件健康与恢复**

```
jsonl health after SIGKILL: {"lines": 5, "parsed": 5, "unparsable": 0, "endsWithNewline": true}
resumed sessionId: a2-t8a same: True
get_entries since crashed leaf: True new entries: 0
assistant after resume: '`sleep 30 # A2CRASHPROBE`'
```

→ session file 是逐条 append 的 JSONL，SIGKILL 中断不产生半行；被打断的工具**没有** toolResult entry（悬挂 tool call 保留在会话里），恢复后同一 session ID 可继续，且模型仍记得未完成的工具调用。

### 2.2 PTY 与进程生命周期（T2 / T6 / T5A）

**detach 不停止 TUI**（T2，见上）：关闭客户端 socket 28s 后重新 attach，进程仍 `alive: True`、字节数继续增长，并可继续键入。

**释放路径的退出码**（T2/T6/T7）：

| 动作 | 结果 |
|---|---|
| TUI 空编辑器 Ctrl+D（release） | `exit 0`，并打印 `To resume this session: pi --session-dir … --session <id>` |
| 空会话（没有真实用户消息）退出 | 不产生 session file（空会话被清理，与 FOUNDATION-003 一致） |
| TUI 收 SIGTERM | `exit 0`（**注意：SIGTERM 也是 0，不能只看退出码判定正常 release**） |
| Runtime 关闭 PTY master（保留自身进程） | TUI 退出 `exit 129`（= SIGHUP） |
| Runtime 进程被 SIGKILL | TUI 随之消失（master 关闭 → SIGHUP） |
| RPC 子进程收 SIGTERM | `exit 143` |
| RPC 的 stdin 被关闭（EOF） | **Pi 自行退出，`exit 0`**（Runtime 崩溃/丢管道后不会留下孤儿 pi 进程） |
| RPC host 进程被 SIGKILL | pi 在 8s 内消失 |
| side channel 下发 `ctx.shutdown()`（idle） | `exit 0`；但**未观测到** `session_shutdown` 通知（见 §3） |

**孤儿工具子进程（T5A，关键）**：FULL 下让 Agent 执行 `sleep 45; echo done > …/orphan-sentinel.txt # A2ORPHANMARK`，在工具执行中对 pi 发 SIGKILL。

```
  55063 55057 55052 S    pi                                    ← provider
  55349 55063 55349 Ss   /bin/bash -c sleep 45; echo done > …   ← bash 工具子进程（自建 process group）
  55350 55349 55349 S    sleep 45
SIGKILL pi rpc pid 55063
--- survivors after SIGKILL ---
  55349     1 55349 Ss   /bin/bash -c sleep 45; echo done > …   ← 被 reparent 到 PID 1，继续运行
  55350 55349 55349 S    sleep 45
sentinel appeared after 41s: 'done'                              ← 孤儿随后真的写入了工作区
```

→ **杀掉 provider 进程既不会终止已开始的工具，也不会阻止它继续修改工作区**。工具子进程有独立 process group（`pgid == 自身 pid`，session leader），只有 Pi 自己发起 abort/正常结束才会收束它。
（附注：本次观测中 `pgrep -f <marker>` 没有匹配到该子进程，用 `ps -eo pid,ppid,pgid,command` 才能看到；下一波做归属核验不要只依赖 `pgrep -f`。）

**两个 writer 同时打开同一 session file（T6-E）**：`--session <file>` **没有任何排他**。

```
writer2 opened the SAME file: True messageCount: 2
writer2 settled: True writer2 alive: True
session lines writer1=5, after writer2=7 (both writers appended)
writer1 still alive: True ; writer1 second turn settled: True
entry ids unique: True count: 7 ; all parentIds resolvable: True
```

→ Pi 不会拒绝第二个 writer，也不会报错。ADR-0010 D04/D05 的"任意时刻最多一个 Provider writer"**必须由 Codeestra Runtime 自己用 lease 保证**，不能依赖 provider。

### 2.3 权限模式 side channel 与结构化安全点（T3 / T4 / T7）

**FULL 零确认**（T3-A，生产 gate extension，RPC）：

```
tool starts: ['bash']
extension_ui_request count in FULL: 0
tool end: bash isError: False [{"type":"text","text":"full-mode-ok\n"}]
```

**STRICT + RPC：批准与拒绝**（T3-B/C，生产 gate extension）：

```
B: ui_request: confirm title: CODEESTRA_PERMISSION:call_00_SJG…:bash:bb3ef266…
   tool end: bash isError: False [{"type":"text","text":"strict-bash-allowed\n"}]
C: ui_request: confirm title: CODEESTRA_PERMISSION:call_00_EDm…:bash:dcff9d26…
   tool end: bash isError: True [{"type":"text","text":"Codeestra permission denied by user"}]
   → agent_settled 仍然到达；get_last_assistant_text 无 text（该轮没有最终助手文本）
```

→ **拒绝路径已实测**：拒绝不会挂死，`terminate: true` 使该轮提前结束并产生 `agent_settled`。
→ 重要后果：**`agent_settled` 不能单独判定 SUCCESS**——被 gate 拒绝/被 fence 拦截的轮次同样会 settled。Runtime 的完成判定必须核对终止性 block 事实。

**STRICT + 原生 TUI（生产 gate extension 现状）**（T7-A）：

```
toolResult: [{"type":"text","text":"Codeestra cannot approve bash without its RPC permission channel"}]
screen shows a permission dialog: False
```

→ 现有 `pi-gate-extension.ts` 在 `ctx.mode !== 'rpc'` 时直接 fail-closed 阻断。**STRICT 下把 Agent 交接到原生 TUI 会让 bash/edit/write 全部不可用**。
这正是 ADR-0010 D06 要求"受控 gate extension 在 TUI 模式通过 Runtime side channel 报告 permission request/resolution"的原因，属于下一波**必须**改适配器的点（本 spike 按要求**没有**修改 adapter）。

**TUI 原生对话框本身可用**（T7-B/C，spike 专用扩展用 `ctx.ui.confirm`）：

```
dialog rendered on the PTY screen: True
screen excerpt: A2 NATIVE CONFIRM | Allow this bash call once? (pi mode tui) | → Yes |   No
[Enter]  toolResult: [{"type":"text","text":"native-dialog-in-tui\n"}]        ← 默认选项 Yes，工具执行
[Escape] toolResult: [{"type":"text","text":"A2 native dialog denied"}]        ← 取消 = 拒绝
```

→ TUI 中原生对话框可渲染、可用回车/取消作答；这为 D06 "原生 TUI 与其他客户端竞相回答，只接受第一份合法决议"提供了第二条通道。

**Runtime 侧 side channel 在 TUI 模式端到端可用**（T4-E1，spike 扩展 `ext/a2-sidechannel.ts` + Runtime 侧 UNIX socket server）：

```
side channel hello: {"kind":"hello","mode":"tui","permissionMode":"STRICT","pid":34539}
side-channel order: ['tool_start','permission_request','tool_end','agent_settled']
  permission_request: bash piMode: tui hasUI: True
screen contains tui-sidechannel-ok: True
```

→ 扩展可以在 **TUI 模式**（`ctx.mode==='tui'`）把 permission request 送到终端之外的 Runtime 通道并等待 typed 决议；终端不需要有人作答。

**结构化安全点 + handoff fence（T4-E2，关键）**：让 Agent 顺序执行 `bash: sleep 7; echo slept-ok`，然后在**该工具仍在执行时**通过 side channel 打开 fence（`{"cmd":"fence"}` → 扩展置 flag，之后 `tool_call` 直接 `{block:true, terminate:true}`）：

```
in-flight tool_start: {"kind":"tool_start","toolName":"bash","toolCallId":"call_00_4uty…"}
fence ack: {"kind":"fence_set","active":true}
events after the fence (seconds after fence):
  +  6.9s tool_end bash isError=False          ← 进行中的工具没有被 abort，正常跑完
  +  8.3s tool_start bash                      ← 下一个工具调用到达
  +  8.3s tool_end bash isError=True           ← 被 fence 拦截（terminate）
  +  8.3s agent_settled
session entries:
  toolResult [{"type":"text","text":"slept-ok\n"}]                        ← 前一个工具真实成功
  assistant  toolCall bash {"command":"echo after-fence"}
  toolResult [{"type":"text","text":"CODEESTRA_HANDOFF_FENCE: no new tools after the safe point"}]
```

→ fence 语义已实测：**不 abort 进行中的工具**、**阻止新工具**、被拦结果以 terminating block 收束当前 run、随后立即 `agent_settled`（不再有额外 LLM 调用）。
→ 注意：PTY 屏幕上会出现被拦截命令的**请求文本**（模型所写的 `echo after-fence`），但 session file 的 toolResult 证明它没有执行。任何"从屏幕文本推断状态"的做法都会误判，与 D06 的"结构化事实来自 side channel，不从屏幕抓取"一致。

**steer 的投递时机**（T8-B，真实模型）：

```
tool started at: 04:22:45 {"command":"sleep 8; echo tool-finished"}
steer response: {"id":"a2-t8b-3","type":"response","command":"steer","success":true}
queue_update events: ['["Ignore the previous instruction. … reply with exactly STEERED-OK …"]', '[]']
final assistant text: 'STEERED-OK'
```

→ `steer` 确实在"当前工具结束后、下一次 LLM 调用前"生效（ADR-0010 D03 的 handoff fence 通知机制可用）。

## 3. 未验证（本 spike 没有证据，不得当成已成立）

1. **完整的 takeover 编排**：`takeover request → 等待安全点 → 退出 RPC → 启动 TUI` 的端到端状态机没有实现；本 spike 只验证了每一段机制与 fence 语义（T2 是"先退出再启动"，不是在工具执行中发起并自动等待）。
2. **安全点的严格定义未形式化验证**：本次的"没有活动工具"由 spike 扩展上报的 `tool_start/tool_end` 计数人工判定；未验证在并行工具批次（同一 assistant 消息多个 tool call）下 `tool_call` 预检与执行的重叠、以及 Attention 未决时的等待。
3. **writer lease / `ATTACHMENT_BUSY`**：没有实现，因此"第二 writer 稳定失败"未验证；已验证的只是**反向事实**——没有 lease 时两个 writer 都能跑。
4. **旧进程未确认退出时不得启动 successor**：Runtime 侧的归属核验（pid + start token + 后代存活检查）未实现；只验证了"孤儿工具子进程可以在 provider 被杀后继续写工作区"这一风险事实。
5. **权限模式跨交接保持**：FULL/STRICT 在 RPC 与 TUI 两种传输下分别验证过；"一次交接后 successor 仍带同一模式/工具集"依赖 Runtime 重新拼 argv，本 spike 未做跨交接连续性测试。
6. **STRICT 下 TUI 与 Codeestra 客户端竞相回答同一请求**：D06 的"只接受第一份合法决议、用 AbortSignal 关闭另一侧 dialog"未实现、未验证。
7. **`ctx.shutdown()` 的 `session_shutdown` 通知不可靠**：T4-E3 中 `shutdown_requested` 到达、TUI `exit 0`，但没有收到 `session_shutdown` 帧（进程可能先退出）。**退出证据只能取"进程确已退出 + 归属核验"，不能取该扩展通知。**
8. **TUI 原生输入的审计通道**：扩展的 `input` 事件能否观察/规范化原生 TUI 键入（用于 D02 的 guidance 审计）未测试。
9. **Windows/PowerShell、其他 provider/模型、非 macOS**：未覆盖。
10. **长会话 / compaction / 大 session file 的交接**：未覆盖（本次会话都很短）。
11. **PTY resize 语义**：harness 提供 resize 控制面，但未做断言。
12. **Provider 侧 `get_entries --since` 在大型/分叉会话上的性能**：未测。

## 4. 不支持 / 做不到（明确写死，不得伪装）

1. **不能把原生 TUI attach 到运行中的 RPC 进程**：Pi 没有这种原语。ADR-0010 的"安全点进程交接 + 同一 session file 新进程"是唯一可行路径；"结构化客户端 attach 到 Runtime"与"原生终端接管"必须分开表述。
2. **Pi 不提供 pause/resume 原语**：只有 `abort`；沿用 FOUNDATION-003 结论。
3. **Pi 不提供 session file 排他锁**：两个进程可以并发同写一个 session file 而不报错（T6-E 实测）。单 writer 只能由 Runtime lease 实现。
4. **结束 provider 进程 ≠ 工作区静止**：SIGTERM/SIGKILL 都不会终止已开始的工具；孤儿子进程会继续写文件（T5A 实测）。
5. **退出码不能判定交接是否"正常"**：TUI 的 SIGTERM 与 Ctrl+D 都是 `exit 0`；因此 release/交还必须以显式命令 + 进程归属核验为准，不能只看退出码。
6. **不能从终端屏幕文本推断业务事实**：被 fence 拦截的命令会出现在屏幕上的"请求"里；权限对话框文本也不代表决议（T4/T7）。
7. **`ctx.ui.custom()` 在 RPC 模式不可用**（沿用既有结论），复杂问卷仍需结构化 dialog primitives。

## 5. 对下一波实现的要求（handoff Operation / Session incarnation / 单 writer lease）

以下是把本 spike 结论转为可实现契约的**结论性要求**（不是已批准的 ADR，见 §6）：

1. **handoff fence 必须走受控扩展的 side channel，而不是只靠 `steer`。**
   `steer` 只保证"消息在工具结束后投递"；真正阻止新工具的是扩展在 `tool_call` 返回 `{block:true, terminate:true}`。建议 shutdown/fence 命令经同一条 side channel 推送（本 spike 的 `{"cmd":"fence"}` 已验证可用），并**在切换 fence 前先持久化 takeover request**。
2. **安全点的可判定形式**：`fence 生效` + `活动工具计数 == 0` + `agent_settled` + writer/process identity 仍匹配 + 无未决 Attention。
   活动工具计数与 settled 都需要**结构化上报**：RPC 侧来自事件流（已有），TUI 侧必须来自扩展 side channel（本 spike 已验证 TUI 模式下可上报）。
3. **`agent_settled` ≠ SUCCESS。** 必须有"是否发生终止性 block（gate 拒绝 / fence 拦截 / 阻断性工具失败）"的事实参与完成判定，否则被拦截的轮次会被记成成功（T3-C、T4-E2 实测）。
4. **successor 启动前置条件（必须由 Runtime 执行）**：
   - 对 RPC：先 `ctx.shutdown()` 或关 stdin（两者都产生正常退出），撤回/确认 stdin 已关闭，等待退出码，再核对"没有该 incarnation 的后代进程存活"。
   - 对 TUI：关闭 master 会以 SIGHUP(129) 终止 TUI；但正常 release 是 CLI 命令驱动的 Ctrl+D（`exit 0`）。两种都要以"进程确已退出 + 归属核验"为准。
   - **在旧 incarnation 的（可能的）孤儿工具子进程归属未澄清前，不得启动 successor**；澄清方式是进程组/会话/启动 token 级核验，不能用显示名或 `pgrep -f`。
5. **单 writer lease 由 Runtime 强制**：lease 对象至少要绑定 `execution_id`、incarnation 序号、mode(`AUTOMATED_RPC|HUMAN_TUI`)、pid+start token、session file+session ID、以及"上一个 incarnation 已确认退出"的审计记录。
6. **Session incarnation 与 cursor**：同一 Execution 允许有序 incarnation；session file/id 保持不变，entry id 是稳定追加的 durability cursor（已验证）。交还后 RPC 的 continuation guidance 应以新 entry 追加，而不是重建会话。
7. **扩展必须按运行模式能力化**：`pi-gate-extension.ts` 当前对非 RPC 模式直接 fail-closed。**这是必须修改适配器才能继续验证的点**——按 spike 规则在此停下记录，不在本格改 `packages/**`（会与 A1 的 Operation 语义冲突）。
8. **TUI guidance 的耐久性与审计**：providers 侧正文（TUI 键入）在 ≤1s 内落盘且可 SIGKILL 存活；因此 domain event 可只保存 entry 引用/hash/长度（ADR-0010 D02/D06 的写法可行）。但"输入被 provider 接受"的时刻仍建议由扩展上报一次，避免只依赖文件轮询推断。
9. **权限模式的执行点**：模式经 argv（`--approve/--no-approve`、`--tools`）与 `CODEESTRA_PERMISSION_MODE` 双通道进入 provider；交接后必须由 Runtime 重新拼 argv 保持一致，不得因换进程暗中切换。

## 6. ADR-0020 占用

**未占用 ADR-0020，已释放。** 本次 spike 没有推翻或新增 ADR-0010/0011 的决策：fence、安全点、单 writer、模式不变都在 ADR-0010 中已有定义，本 spike 给出的是它们的**实现契约与风险事实**（§5），不改变产品语义。
如果用户希望把 §5 中"fence 必须走 side channel"、"settled ≠ SUCCESS"、"孤儿后代核验"固化成决策记录，可在获得明确答复后写入 ADR-0020；在此之前不新建 ADR 文件。

## 7. 证据索引

| 证据 | 位置 |
|---|---|
| RPC 事件全量（含 FULL/STRICT 批准与拒绝） | `/tmp/a2-spike/logs/t1-rpc.jsonl`、`t3-full.jsonl`、`t3-strict.jsonl` |
| TUI PTY 原始字节（含原生对话框渲染、resume hint） | `/tmp/a2-spike/logs/t2-tui.log`、`t4-tui.log`、`t7a-tui.log`、`t7b-tui.log`、`t7c-tui.log` |
| side channel 全量帧（hello/permission/tool/fence/settled） | `/tmp/a2-spike/t4.sock.log` |
| 孤儿工具子进程证据 | `/tmp/a2-spike/logs/t5a2-run.log`、`/tmp/a2-spike/ws/orphan-sentinel.txt` |
| 双 writer 证据 | `/tmp/a2-spike/logs/t6e-1.jsonl`、`t6e-2.jsonl`、`sessions/t6e/*.jsonl` |
| 崩溃后 JSONL 健康与恢复 | `/tmp/a2-spike/logs/t8-run.log`、`sessions/t8/*.jsonl` |
| TUI 键入耐久性 | `/tmp/a2-spike/logs/t9-run.log`、`sessions/t9/*.jsonl` |
| 脚本与扩展源码（spike-only） | `/tmp/a2-spike/harness.py`、`pty_host.py`、`rpc_host.py`、`ext/a2-sidechannel.ts`、`ext/a2-native-dialog.ts` |

## 关联

- `docs/decisions/0010-live-agent-terminal-takeover.md`、`0011-default-full-permission-mode.md`、`0008-efficiency-first-service-form.md`
- `docs/spikes/pi-0.84.4.md`（前序能力矩阵；本文取代其中"双向 RPC↔TUI 与 gate side channel 未做 spike"的待验证项）
- `docs/roadmap/mvp.md` Phase 3「实现顺序」第 1 步
- `packages/agent-adapters/src/pi-gate-extension.ts`、`pi-rpc.ts`（本 spike 只读；未修改）
