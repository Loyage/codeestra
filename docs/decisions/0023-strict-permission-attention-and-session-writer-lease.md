# ADR-0023：STRICT 权限转 Attention，Session incarnation 与单 writer lease

Status：Accepted（用户在 FOUNDATION-043 中明确答复：STRICT 下的工具审批转成 Attention，经现有
`attention list` / `attention answer` 命令面回答）。**Amends ADR-0010 D05/D06 的实现契约**（不改其
产品语义：单 writer、安全点、模式不因交接改变、不新增门禁）。

## Context

FOUNDATION-040 的真实 Pi 0.84.4 spike 给出了三条必须由 Runtime 自己实现的约束：

1. **`--session <file>` 没有排他**：两个 writer 可并发写同一 session file 且都不报错（T6-E）。单
   writer 只能由 Runtime 强制。
2. **结束 provider 进程 ≠ 工作区静止**：SIGKILL provider 不会终止已开始的工具，孤儿 bash 被 reparent
   到 PID 1 后继续写工作区（T5A）。successor 启动前必须核验归属，否则可能双写。
3. **生产 gate 在非 RPC 模式 fail-closed**（`ctx.mode !== 'rpc'` 直接阻断），因此 STRICT 下把 Agent
   交给原生 TUI 会让 bash/edit/write 全部不可用（T7-A）。

同时 ADR-0010 D06 要求：受控 gate extension 在 TUI 模式通过 Runtime side channel 报告 permission
request/resolution，决议走既有 Attention，不新增第二套回答通道；`agent_settled` ≠ SUCCESS（被 gate
拒绝或被 fence 拦截的轮次同样 settled，T3-C/T4-E2 实测）。

## Options

### STRICT 权限决议通道

- A. 继续用 `ctx.ui.confirm`：RPC 模式经 provider dialog 映射成 Attention，TUI 模式由原生对话框回答。
- B. gate extension 通过 Runtime side channel 发结构化请求，Runtime 建成 Attention，决议从同一条
  side channel 回投；`ctx.ui.confirm` 不再参与权限判定。
- C. STRICT 下不允许原生终端接管（保持 fail-closed 阻断）。

选择 **B**。A 在 TUI 模式下不可用（spike 实测直接阻断），且原生对话框与 Codeestra 客户端会成为两条
无法统一绑定的决议通道；C 会把"接管后工具全不可用"固化。B 让 RPC 与 TUI 走完全相同的路径。

### 单 writer 的强制者

- A. 依赖 provider 提供排他（不存在）。
- B. Runtime 侧 lease + incarnation 状态机，在数据库约束里拒绝第二个 writer。

选择 **B**。

## Decision

### D01：STRICT 权限一律走 Runtime side channel，转成既有 Attention

- **FULL（默认）**：gate 直接放行全部已注册工具，**0 次确认**、不产生 Attention、不新增任何门禁或
  步骤（与 ADR-0011 一致）。
- **STRICT**：gate 不再调用 `ctx.ui.confirm`。它把需要审批的工具调用发到 Runtime side channel 的结构化
  请求上：`{toolName, toolCallId, inputJson, inputFingerprint(sha256), mode}`。Runtime 把它写成一条
  `attention_requests`（`kind=PERMISSION`、`responseType=CONFIRM`，
  `prompt_json` = `codeestra.permission` 结构化形状：工具名、原样输入、输入指纹、incarnation 身份），
  用户用**现有**命令面回答：
  `codeestra attention list` / `codeestra attention answer … confirm yes|no|cancel`。
- 决议经同一条 side channel 回投给 extension（`permission_decision`：ALLOW / DENY / CANCEL）。ALLOW
  放行该次调用；DENY/CANCEL 返回 terminating block（`Codeestra permission denied by user`），当前 run
  被收束但**不会挂死**（spike 已实测 deny 后仍到达 `agent_settled`）。`agent_settled` 不参与"是否批准"的
  判定，也不单独作为成功依据。
- side channel 不可达（Runtime 不在、socket 未建立、连接在等待中被关闭）时 **fail-closed**：不放行，
  给出稳定理由 `Codeestra cannot approve <tool> without its Runtime permission channel`。extension 会在
  有界窗口内重试连接（默认 10s，可用 `CODEESTRA_HANDOFF_CONNECT_MS` 收窄），覆盖 Runtime 正在启动/
  重启的情况；窗口内不放行任何工具。
- 未知工具仍然直接拒绝（ADR-0004 fail-closed），不询问 Runtime。`ask_user_question` 与只读工具不进入
  审批路径。

### D02：决议绑定 incarnation，过期决议不得应用

`session_permission_requests` 把每条权限 Attention 绑定到发起它的 **incarnation**（provider 进程代）。
回答时先执行一次**原子条件更新**（claim）：

```sql
UPDATE session_permission_requests SET decision='DECIDING'
WHERE attention_id=? AND decision='OPEN'
  AND incarnation_id = (SELECT current_incarnation_id FROM agent_sessions WHERE id=session_id)
```

- 只有仍为当前 writer 的 incarnation 能赢得这次 claim；两个客户端同时回答时只有一个能赢，另一个得到
  `ALREADY_DECIDING`。
- 旧 incarnation（已 `RECOVERY_REQUIRED`/`EXITED`，或已被 successor 取代）的决议被拒绝为
  `STALE_INCARNATION`：**不写入 provider，不驱动任何工具**。已记录的 answer Operation 记为 `FAILED`
  （不是可重试的 `PLANNED`），对应 Attention 记为 `STALE`。
- 只有 claim 成功后才把决议写到 side channel；写失败且可证明未送达时释放 claim，允许重试。
- 因此"回答不会路由到错误会话"由 `attention_requests.session_id` + incarnation 绑定 + 原子 claim 三层
  保证，而不是靠调用方参数正确。

### D03：Session incarnation 与单 writer lease

- 每次 provider 进程代（automation RPC / human TUI）是 `session_incarnations` 中的一条有序记录：同一
  conversation（同一 session file / session ID）跨进程延续，但 OS 进程不伪装成同一个。记录里保存
  `mode`、`state`、provider pid、Adapter 记录的进程身份（pid + start token + argv hash）、以及**在
  provider 仍存活时抓取的进程树**（自身 + 后代 pid 与 start token）。
- `agent_sessions.current_incarnation_id` 是"决议还能到达哪个进程"的唯一答案。
- `session_writer_leases` 每个 Session 最多一条未释放租约（partial unique index 强制）。默认由
  automation 的 incarnation 持有；第二个 attach/接管请求**稳定失败**为 `ATTACHMENT_BUSY` 并报出当前
  holder，不排队、不静默等待。
- 记录 successor incarnation 时，Runtime 要求：(a) 没有任何 incarnation 仍 `ACTIVE`/`FENCED`；
  (b) 没有未释放租约；(c) 若已有 predecessor，其 provider session file 与 successor 相同（
  `SESSION_FILE_CHANGED` 拒绝）。重复的 commandId 幂等返回既有 incarnation，不新建。

### D04：只在安全点交接，且 successor 启动前必须核验归属

- 接管请求先持久化（`session_handoff_requests`），再经 side channel 装 fence。fence 只阻止**新**工具
  调用（`CODEESTRA_HANDOFF_FENCE`，terminating block），**不 abort 进行中的工具**。
- 安全点 = fence 已被 provider 确认 + 活动工具计数为 0 + fence 之后出现 settled 事实 + 无未决 Attention。
  这些事实全部来自结构化上报（RPC 事件流或扩展 side channel），不从终端屏幕文本推断。
- `session.handoff.admit` 只做**判定**：它要求安全点事实齐全，并按记录的进程树核验 predecessor 归属：
  `STOPPED` 才继续；`ALIVE` → `PREDECESSOR_NOT_STOPPED`；`DESCENDANTS_ALIVE` →
  `PREDECESSOR_DESCENDANTS_ALIVE`；任何无法比较（读取进程表失败、start token 缺失、pid 复用无法判定）
  → `PREDECESSOR_UNVERIFIED`。核验不通过一律拒绝接手（宁可拒绝，不要双写）。
- 本 ADR 只落地 Runtime 侧契约与状态：**PTY transport 与 successor 进程启动没有实现**，
  `admit` 返回 `successorStarted: false` / `terminalTransport: 'UNIMPLEMENTED'`，也不移动租约。
  能力矩阵在 `session handoff status` 的 `capabilities` 里如实报告。
- 放弃的接管请求用 `session handoff cancel` 释放 fence，Agent 可继续使用工具。

### D05：重启按事实 reconcile，不凭空乐观恢复

Runtime 重启后它已不再持有任何 provider 进程或 PTY 控制连接，因此
`reconcileSessionHandoffs` 直接按这一事实收敛自己的状态：所有 live incarnation →
`RECOVERY_REQUIRED`（并清空 `current_incarnation_id`）、所有未释放租约以 `RUNTIME_RESTARTED` 释放、
所有未决 handoff 请求 → `RECOVERY_REQUIRED`、所有未决权限请求与其 Attention → `STALE`。它**不**改写
`agent_sessions`/`executions`/`tasks`（那是另一条仍未关闭的 reconcile 议题，猜一个状态会掩盖缺失证据）。

## Consequences

- STRICT 的权限决议只有一条通道，RPC 与原生 TUI 行为一致；回答面仍是既有
  `attention list` / `attention answer`，没有第二套通道，也没有新增门禁。常态路径（FULL）依然 0 确认。
- RPC 模式下权限 Attention 不再来自 `extension_ui_request`，因此 `mapPiExtensionUiRequest` 的
  `CODEESTRA_PERMISSION:` 分支对新 gate 不再被走到（问题通道与遗留 dialog 仍在使用它）；
  `pi-gate-extension.ts` 不再需要 `CODEESTRA_PERMISSION` 标题编码。
- 引入新的持久状态（schema v14）：4 张表 + `agent_sessions.current_incarnation_id`。这些状态是
  故障恢复与审计的事实来源，不是缓存。
- 单 writer 的代价是：successor 必须等 predecessor 被证明静止；无法核验时交接被拒绝而不是"试试看"。
  这正是 ADR-0010 D04 的要求。
- 未实现的 PTY 传输意味着用户还不能真正进入原生 TUI；本 ADR 只把契约与守卫做对，交付边界在
  `docs/tasks/README.md` 的 FOUNDATION-043 中明确列出。

## Verification

只用 CLI/Runtime 命令面与真实 socket 驱动（不使用浏览器/桌面/键鼠自动化）：

1. `packages/agent-adapters/test/handoff-gate.test.ts`：真实 UNIX socket 上的 gate 契约——FULL 零确认、
   STRICT 结构化请求与 ALLOW/DENY/CANCEL 决议、通道关闭时 fail-closed、fence 阻止新工具且不发送审批
   请求、工具生命周期与 settled 上报。
2. 同一文件的 `provider process ownership evidence`：真实子进程与真实 `ps` 下的孤儿探测——SIGKILL
   provider 后仍记录到存活的后代（`DESCENDANTS_ALIVE`），后代消失后才报 `STOPPED`；进程表不可读时
   报 `UNVERIFIABLE`；pid 被复用时不误判为存活。
3. `apps/runtime/test/session-handoff-service.test.ts`：租约竞争 `ATTACHMENT_BUSY`、重复 commandId 幂等、
   STRICT 权限→Attention→DENY 送达且不记为成功、旧 incarnation 决议 `STALE_INCARNATION` 且不写 provider、
   claim 原子性、安全点与 `PREDECESSOR_*` 拒绝、`UNVERIFIABLE` 拒绝、fence 释放、重启 reconcile 幂等。
4. `apps/runtime/test/cli-session-handoff.test.ts`：CLI 端到端（协议 stub 扮演 provider）——权限 Attention
   经 `attention answer confirm no` 送达并记为 DENY、`session handoff writer acquire` exit 1 +
   `ATTACHMENT_BUSY`、fence/安全点 `AT_SAFE_POINT`、`admit` 因 predecessor 存活 exit 1。
5. 真实 Pi 0.84.4 + 真实模型（deepseek-flash）headless 复验（RPC 模式，脚本在 `/tmp`，不入库）：
   hello 携带真实 provider session id/file 与 pid；bash 工具调用产生结构化 permission request；DENY →
   toolResult `Codeestra permission denied by user` + `agent_settled`；ALLOW → 工具真实执行；fence 后新
   工具以 `CODEESTRA_HANDOFF_FENCE` 被拦下并 settled。
6. 未验证项（不得当成已成立）：PTY/TUI 实际转交与 detach/reattach、跨交接模式保持、并行工具批次下的
   安全点、compaction、非 macOS/Windows、其他 provider、`ctx.shutdown()` 的 `session_shutdown` 通知。

## Related

- `docs/spikes/pi-session-handoff.md`（FOUNDATION-040 实测事实与实现契约）
- ADR-0010（接管语义、D05 单 writer、D06 模式与 side channel）、ADR-0011（默认 FULL）
- ADR-0004（STRICT fail-closed 与逐次审批）、ADR-0014（结构化提问通道，同一 Attention 命令面）
- ADR-0008（CLI 完备、效率优先、测试边界）
- `packages/agent-adapters/src/pi-gate-extension.ts`、`pi-process.ts`、
  `apps/runtime/src/session-handoff-service.ts`、`agent-answer-service.ts`
