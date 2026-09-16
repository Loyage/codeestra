# 真实 provider 端到端验收 runbook（Wave M / M4）

> **这是一份操作手册，不是验收结果。** 它把 `## NEXT` 第 1/2/3/4/6/7/8/9 条与
> [troubleshooting.md](../guides/troubleshooting.md) §4 里「只能由真实 provider 证明」的验收项，
> 整理成可以照着执行、失败可判定、现场可保留的步骤。
>
> **本格（M4）没有执行其中任何一条。** 本格零 provider 请求、零真实提升、零稳定服务操作；
> 本文里所有「预期观察」都是**预期**，不是已验证的事实。
>
> 基线 `dev@75fa7b87a4fbc515adf46a936b3666bf83a7ebaa` · 脚手架
> [`scripts/real-provider-acceptance.sh`](../../scripts/real-provider-acceptance.sh) · 2026-09-15
>
> 权限模式的命令拼写由 FOUNDATION-098 同步为 `ce settings permission get|set`（ADR-0064：顶层 `permission` 已移除）。

---

## 0. 这份文档是什么、不是什么

**是什么**：功能验收（非观感）的操作手册。每条验收项给出前置条件、确切命令、预期观察、判定标准、
失败/中止条件、证据保留与清理。

**不是什么**：

- 不是新开发者导览。那一份是 [`docs/project-introduction.html`](../project-introduction.html)，
  覆盖愿景/原理/架构/上手；本文只讲「怎么验收」，不重复它。
- 不是人工观感清单。那一份是 [`acceptance-checklist.md`](../guides/acceptance-checklist.md)，
  只覆盖布局、主题、字号、动效、焦点等**没有机器断言**的界面观感。
  两者互补：本文覆盖**功能**，那份覆盖**观感**（本文 §5 有指针）。
- 不是命令参考。每条命令的参数与退出码见 [`cli/README.md`](../guides/cli/README.md)；
  本文只在验收语境里引用它们，并且每条都对照 `apps/cli/src/main.ts` 的 `usage()` 核对过（见交付记录）。

**判定必须分两类**，下面每一项都拆开写：

| 类别 | 含义 | 谁能判 |
|---|---|---|
| **可机器断言** | 退出码、`--json` 字段、事件名、文件 digest、进程是否存在 | 脚本可判，重跑可复现 |
| **必须人眼** | 「模型是否真的读了知识」「观感」「模型是否理解了新规格」 | 只有在场的人能判，且必须在记录里写明依据 |

**一条硬规则**：本 runbook 不允许把「我们把它交给了 provider」写成「provider 真的用了它」。
ADR-0051 已经把这条边界写得很清楚；验收时同样适用。

---

## 1. 一次性前置准备

### 1.1 先确定「跑的是哪份代码」

Codeestra 的 CLI **自动启动 Runtime**，而启动的是**这个 checkout 里的** `apps/runtime/src/main.ts`
（`apps/cli/src/main.ts` 用 `import.meta.dir` 解析 `../../runtime/src/main.ts`）。因此：

```sh
CLONE=<你打算验收的那个 clone 的绝对路径>
git -C "$CLONE" rev-parse HEAD          # 记录这次验收的代码 SHA
git -C "$CLONE" status --porcelain      # 必须是空输出：未提交改动会让 SHA 不再是事实
ps -Ao pid=,command= | grep 'apps/runtime/src/main.ts' | grep -v grep
#   输出里应当出现以 "$CLONE/apps/runtime/src/main.ts" 结尾的那一行
```

> **危险**：不带 `CODEESTRA_HOME` 从任意 clone 运行 `bun run codeestra …`，命令会打到**已经运行的稳定
> Runtime**（即 main clone 的代码），而不是你当前的构建。因此本 runbook 的**每一条命令都必须在
> `CODEESTRA_HOME=<一次性目录>` 下执行**，并且**禁止**在 `~/Documents/codeestra`（main 稳定 clone）
> 与其稳定 Runtime 上做任何验收动作。

**必须导出**（本文其余部分都假定这四个变量已设置）：

```sh
export CLONE=<clone 绝对路径>
export REPO=<一次性临时 Git 仓库绝对路径>          # 见 §1.3
export CODEESTRA_HOME=<一次性临时数据目录绝对路径>  # 见 §1.3
export EVIDENCE=<证据目录绝对路径>                  # 见 §3
```

### 1.2 provider 凭据与额度（只有你能确认）

本 runbook **不写死任何凭据，也不读取或回显任何密钥**。开始前你先自己确认：

```sh
pi --version        # 或 codex --version / claude --version
```

**额度是未知量，必须你自己估**：单条验收项至少产生 1 个真实 turn，A1 是 2 个并发 turn，A3/A4/A6/A7
各至少 1–2 个 turn。本 runbook 不给额度数字，因为它取决于你自己的 provider 与模型。

强烈建议先用**便宜、快**的模型跑完机制类验收（A2/A3/A5/A6/A7），只在确有需要时用强模型：

```sh
# 持久配置（写入 Agent 配置，只影响新建 Session）
CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra agent config set --provider <provider> --model <model>
CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra agent config get
# 或临时覆盖（优先级最高，只对该 Runtime 进程生效；不要写进任何文件）
# CODEESTRA_PI_PROVIDER=<provider> CODEESTRA_PI_MODEL=<model> … bun run codeestra status
```

这两条都是仓库已有能力（ADR-0012）；环境变量层的语义见
[cli/README.md §0.3](../guides/cli/README.md)。

### 1.3 一次性临时仓库与 `CODEESTRA_HOME`

用脚手架一步到位（默认 **dry-run**，什么也不做）：

```sh
cd "$CLONE"
scripts/real-provider-acceptance.sh                       # 打印全部步骤将执行的命令
scripts/real-provider-acceptance.sh --yes --step concurrency   # 真正执行 A1（会问模型）
```

手动等价的最小准备：

```sh
TMP=$(mktemp -d "${TMPDIR:-/tmp}/ce-m4-XXXXXX") && TMP=$(cd "$TMP" && pwd -P)
export REPO="$TMP/repo" CODEESTRA_HOME="$TMP/home" EVIDENCE="$TMP/evidence"
mkdir -p "$REPO/.codeestra/policies" "$REPO/.codeestra/instructions" "$CODEESTRA_HOME" "$EVIDENCE"
git init -b main "$REPO"
git -C "$REPO" config user.name "Codeestra Acceptance"
git -C "$REPO" config user.email "acceptance@example.invalid"
# 写入 §1.4 / §1.5 的两份策略文件，再提交并建 dev：
git -C "$REPO" add --all && git -C "$REPO" commit -m "acceptance fixture"
git -C "$REPO" branch dev

cd "$CLONE"
CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra status          # READY
CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra project trust "$REPO" --yes
CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra project list    # 记下 projectId
```

### 1.4 最小 `.codeestra/policies/verification.json`

`dev` 之前的定向验收用一条无害命令即可（`argv` 是数组，不是 shell 字符串）：

```json
{
  "version": 1,
  "commands": [
    { "id": "noop", "argv": ["true"], "cwd": ".", "timeoutSeconds": 60 }
  ]
}
```

- 只从项目 **`main` ref** 读取：Task 分支改不动判定自己的命令。
- 字段与上限见 `packages/contracts/src/verification-policy.ts`；策略缺失时 `task verify` 会拒绝。
- 策略只用于 `task verify`（`promotion full-suite run` 已随 ADR-0066 删除；A8 因此没有可执行的验收步骤）。

### 1.5 最小 `.codeestra/impact.json`（A1 并发验收专用）

**空映射是合法的但无用**：`importantDirectories`/`modules`/`globalResources` 全空会命中
`EMPTY_MAPPING`，`complete=false`，所有冲突判定都是 `UNKNOWN`，因而**不会并行**。
A1 必须在**已确认的非空映射**上跑，且两个任务真的落在互不相交的目录里：

```json
{
  "version": 1,
  "importantDirectories": ["lane-a", "lane-b"],
  "modules": [],
  "globalResources": []
}
```

- 写入后必须**重新 `project trust`**：映射 digest 变了就要新的确认。
- 确认是否真的能判定为 `SAFE`（退出码 `0`）用：
  `project impact explain <project-id> <task-id> --json`。
- `globalResources` 里任何被写且 `consumers.state = "UNKNOWN"` 的资源会让整个项目变 `UNKNOWN`；
  最小 fixture 因此不声明任何全局资源。语义见
  [conflict-analyzer.md §6](../architecture/conflict-analyzer.md)。

### 1.6 人工知识层（只给 A4 用）

```sh
cat > "$REPO/.codeestra/instructions/probe-knowledge.md" <<'MD'
---
id: probe-knowledge
scope: ALL
---
# Acceptance knowledge token

当被要求复述知识 token 时，必须原样复述这一行：

CE-M4-KNOWLEDGE-TOKEN-7f3a91c2
MD
git -C "$REPO" add --all && git -C "$REPO" commit -m "acceptance knowledge"
git -C "$REPO" branch -f dev
CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra project trust "$REPO" --yes   # 重新确认
```

- 人工层（`instructions`/`skills`）**只从项目 `main` ref 读**；`generated/` 是 Runtime 数据，不在项目树里。
- front-matter 只支持顶层标量 `id` 与 `scope`，`scope ∈ ALL | DEVELOPMENT | SELF`。
  不认识的键会 fail-closed 拒绝（不是静默忽略）。见
  [knowledge.md](../architecture/knowledge.md) §2。

### 1.7 通用约定

| 约定 | 内容 |
|---|---|
| 退出码三分法 | `0` 成功；`1` 拒绝或失败（含 `RECOVERY_REQUIRED`）；`2` 用法错误；`3` **等待**（含「已推送待拉取」） |
| 看到 `1` 先读码 | 文案会变，稳定码不会（[troubleshooting.md](../guides/troubleshooting.md) §0） |
| 没有 `timeout(1)` | 本机没有该命令；需要限时就用 `( cmd & p=$!; sleep N; kill $p 2>/dev/null )` 之类的显式写法 |
| token 不入日志 | **不要执行 `codeestra ui`** 并把地址粘进记录；Runtime 每次启动换内存 token，UI URL 里的 token 一律不进证据包 |
| 不要动稳定 clone | `~/Documents/codeestra` 与它的 Runtime 不属于验收环境 |
| 不写密钥进仓库 | 临时目录里的任何东西都不提交；本文所有示例都不含凭据 |

后面 §2 的命令统一用一个薄的 shell 函数 `ce`（避免每行都重复 `cd` + `CODEESTRA_HOME`）：

```sh
ce() { ( cd "$CLONE" && CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra "$@" ); }
```

---

## 2. 验收项

每一项统一按 **前置 → 命令 → 预期观察 → 判定 → 失败/中止 → 证据 → 清理** 组织，判定拆成
**可机器断言** 与 **必须人眼**。

---

### A1 真实并发两任务（NEXT 第 6 条 / `troubleshooting.md` §4 第 1 条）

这是 Phase 2 验收矩阵里**唯一没成立**的一项：调度引擎本体已实现（ADR-0033），
但「两个 `SAFE` 任务真的同时 RUNNING」没有真实 provider 的受控验收。

**前置**

- §1.3 的环境已就绪；容量为默认 `2`（不要先改容量）。
- `impact.json` 是 §1.5 的非空映射，且两个任务落在 `lane-a` / `lane-b`。
- provider 凭据与额度已确认（§1.2）。两个 turn 会**同时**消耗额度。

**命令**

```sh
# `ce` 见 §1.7；下面每一步都请把退出码记进证据包

ce scheduler capacity get --json                     # 记下 limit=2（容量是整个 Runtime 的，不带 project）

ce task create "$PROJECT" "在 lane-a/out.txt 写入文本 lane-a，完成后结束。"
#   → 记下 id 与 version（task create 的返回里 version=0）
ce task create "$PROJECT" "在 lane-b/out.txt 写入文本 lane-b，完成后结束。"

ce task submit "$PROJECT" "$TASK_A" 0                # → version 变为 1
ce task submit "$PROJECT" "$TASK_B" 0

# 先证明判定是 SAFE（退出码 0），否则后面一次 3（WAIT）与「并发没成立」无法区分
ce project impact explain "$PROJECT" "$TASK_A" --json; echo "exit=$?"
ce project impact explain "$PROJECT" "$TASK_B" --json; echo "exit=$?"

echo '--- 以下是真实模型请求 ---'
ce task run "$PROJECT" "$TASK_A" 1 --adapter pi --json; echo "exit=$?"
ce task run "$PROJECT" "$TASK_B" 1 --adapter pi --json; echo "exit=$?"

ce scheduler capacity get --json
ce task status "$PROJECT" "$TASK_A" --json
ce task status "$PROJECT" "$TASK_B" --json
ps -Ao pid=,command= | grep -i ' pi ' | grep -v grep     # 两个 provider 进程
ce events list --project "$PROJECT" --since 0 --limit 500 --json
```

**预期观察**

- 两次 `task run` 都 **exit 0**（`outcome: STARTED`）；第二次**不**返回 `3`。
- `scheduler capacity get --json`：`used: 2`，`occupiers` 有两个不同的 `taskId`（带 `projectId`）。
- 两次 `task status --json`：`task.state` 都是 `RUNNING`，`executions[0].state` 都是 `RUNNING`、
  `resourceHeld: true`，两个 `executions[0].session.sessionId` 不同。
- `ps` 输出里有**两个** provider 进程，argv 指向**两份不同的** worktree / session file。
- `events list`：两条 `ExecutionReserved`、两条 `ExecutionSlotReserved`、两条
  `TaskStateChanged → RUNNING`。

**判定**

- **可机器断言**：上面四条 JSON/退出码/进程数同时成立。
- **必须人眼**：两次 `task transcript --json` 都显示模型**真的在同一时间窗口内在干活**（不是一条已经
  结束、另一条才开始）；最终两个 worktree 里各出现 `lane-a/out.txt` 与 `lane-b/out.txt`。

**失败/中止**

- 第二次 `task run` 返回 `3` → 读 `--json`/stderr 里的理由码（`WAIT_CONFLICT` / `WAIT_CAPACITY`）。
  **不要靠调大容量或 `--allow-unknown` 掩盖**：那会把「并发未成立」变成「被我放行过一次」。
  记录理由码后停下，并在交付记录里写「A1 未成立 + 实际理由码」。
- `project impact explain` 退出码不是 `0` → 判定不是 `SAFE`（`UNKNOWN` 或 `CONFLICTING`）。
  先修映射或改规格，再重新 `project trust`；不要继续往下跑。

**证据**：`a1-capacity-before.json`、`a1-run-a.json`、`a1-run-b.json`、`a1-capacity-running.json`、
`a1-task-a.json`、`a1-task-b.json`、`a1-events.json`、两个 `task transcript --json`、`ps` 原始输出。

**清理**：两个任务 `task cancel`（或等它们完成）。**不要**回收 worktree——先看 §4。

---

### A2 暂停 → 恢复 → 终止（NEXT 第 1 条 / ADR-0016）

**前置**：A1 留下一个 `RUNNING` 的任务；从 `task status --json` 记下
`executions[0].executionId`、`executions[0].session.sessionId`、`executions[0].session.processIdentity.pid`。
**每一条命令的 `$VERSION` 都必须用当时 `task status --json` 的 `task.version`**：`pause`/`resume`/`cancel`
各自都会移动它，沿用旧值只会得到 `VERSION_CONFLICT`。

**命令**

```sh
PID=<上一步记下的 provider pid>
ps -o pid=,command= -p "$PID"                                  # 必须还在

ce task pause "$PROJECT" "$TASK" "$VERSION"; echo "exit=$?"     # 期望 stop=RELEASED
ps -o pid=,command= -p "$PID"                                  # 期望：无输出
ce task status "$PROJECT" "$TASK" --json

ce task resume "$PROJECT" "$TASK" "$VERSION" --adapter pi; echo "exit=$?"
ce task status "$PROJECT" "$TASK" --json
ce task transcript "$PROJECT" "$TASK" --execution <successor-execution-id> --json

ce task cancel "$PROJECT" "$TASK" "$VERSION"; echo "exit=$?"
```

**预期观察**

- `pause` 返回 `stop: "RELEASED"`（exit 0），`task.state` → `PAUSED`；旧 Execution
  `state: SUPERSEDED`、`stopReason: USER_PAUSE`、`resourceHeld: false`；`ps` 里那个 pid 消失。
- `resume` exit 0；新 Execution 的 `attemptNumber` 递增，`resumeFromExecutionId` **等于**被暂停的
  Execution id，`session.providerSessionId` 与旧 Session **相同**（这就是 `--session <file>` 续接同一
  conversation 的可断言证据）。
- successor 的 `task transcript --json` 里能读到**暂停前**已经出现过的 entry。

**判定**

- **可机器断言**：`stop === "RELEASED"`、pid 消失、`resume` exit 0、
  `resumeFromExecutionId === <旧 execution id>`、`providerSessionId` 前后相同、`cancel.stop === "RELEASED"`。
- **必须人眼**：successor 的回答显示它**接着上文**（例如提到暂停前正在做的那个文件）。只证明
  `providerSessionId` 相同还不够——那只是「同一个会话文件」，不是「模型真的记得」。

**A2-extra：`RECOVERY_REQUIRED` 的诚实边界（非常重要）**

NEXT 第 1 条要求「超时进入 `RECOVERY_REQUIRED`」。事前必须知道：

- 真实 Pi 的 `stop` 路径是 `SIGTERM → grace → SIGKILL`；进程被 `SIGKILL` 后 OS 报告退出，
  `exited = true`。因此**正常情况下真实 provider 的 `task pause` 观察不到 `stop: "UNCERTAIN"`**，
  也就不会进入 `RECOVERY_REQUIRED`。`UNCERTAIN` 只在 Adapter **无法确认**退出时出现
  （`releaseExecutionProcess` 返回 `released: false`）。这是 `packages/agent-adapters/src/pi-process.ts`
  与 `apps/runtime/src/agent-runtime-service.ts` 的实现事实，不是猜测。
- 因此本项有**三条不同的真实可达观察**，不要混为一谈：

| 想观察的事实 | 真实可达路径 | 命令 |
|---|---|---|
| 停止无法确认 → `RECOVERY_REQUIRED` | **只有**在 Adapter 无法确认退出时；真实 Pi 下需要人为制造（见下） | `task pause` 得到 `stop: UNCERTAIN`（exit 1） |
| 重启后 stale 投影收敛 → `RECOVERY_REQUIRED` | 有活动 Execution 时让 Runtime **未收尾即消失**，再启动 | 见下 |
| 预留持有者仍活/无法核验 → 槽位保留 | 有活跃预留时读进程表 | `scheduler reservations reconcile` |

**可达路径 A（stale 收敛）**：让 Runtime 被 `SIGKILL`（**不是** `codeestra stop`——stop 会自己收尾，
不会留下 stale 行）：

```sh
ps -Ao pid=,command= | grep 'apps/runtime/src/main.ts' | grep -v grep    # 找到本 home 的 Runtime pid
kill -9 <runtime-pid>                                                    # 不可逆动作，留孤儿 provider 进程
ce status                                                                # 重新拉起 → 启动 reconcile
ce task status "$PROJECT" "$TASK" --json
ce events list --project "$PROJECT" --since 0 --limit 500 --json
```

预期：`executions[0].state` 与 `task.state` 都变成 `RECOVERY_REQUIRED`，`resourceHeld` 仍为 `true`，
Session `DISCONNECTED`，`events list` 里有 `RecoveryRequired`；台账（`agent_session_startup_reconciliations`）
写 `quiescenceProven: false`、`signalsSent: 0` —— **不发信号、不声称静止、不删资源**。

**可达路径 B（放行 reconcile）**：拿到一个活跃预留后：

```sh
ce scheduler reservations list "$PROJECT" --json
ce scheduler reservations reconcile "$PROJECT" --json
```

预期：持有者可证消失 → 释放并记录；仍然活着或无法核验 → `RECOVERY_REQUIRED` 且**槽位保留**。

**判定**：可达路径 A/B 的 JSON 与事件是**可机器断言**的。**「`task pause` 超时进入
`RECOVERY_REQUIRED`」在真实 provider 下无法被确定性制造**：把它写成已验证就是编造。正确做法是在记录里
分开写：`A2 暂停/恢复主力路径已验收`、`A2 的 pause-timeout→RECOVERY_REQUIRED 未在真实 provider 下观察到，
由 reachable-A/B 与既有 stub/单测覆盖`。

**失败/中止**：`pause` 返回 `stop: "UNCERTAIN"` 或 exit 1 → 这就是 `RECOVERY_REQUIRED`；
**立刻停止**，不要重试 `pause`（`RECONCILE_REQUIRED` 会拒绝），不要杀进程，按 §4 保留现场。
`resume` 返回 `3`（`CONFLICT_WAIT`）→ 说明旧任务仍被判定与活跃集合冲突；记录理由码，不要用
`--allow-unknown` 掩盖。

**清理**：`task cancel` 收尾；worktree 交给 §4 的 `reclaim plan` 决策。

---

### A3 revision 投递（NEXT 第 3 条 / ADR-0028 / ADR-0051）

ADR-0051 D07 已经用真实 CLI 实测确认：三个 provider **都没有**「在不停止会话的前提下把修订交给运行中的
Agent 并拿到可核验 ACK」的通道。所以本项要验收的不是「热投递能不能成」，而是：

1. 台账是否**如实**记 `CHANNEL_UNSUPPORTED`；
2. 唯一处置（停止并新建 Execution）是否**真的**把 `applied_revision_id` 换成新 revision；
3. 真实模型是否**理解**「这是对规格的修订」。

**前置**：一个 `RUNNING` 的任务；记下 `task.version`（修订会移动它）。

**命令**

```sh
ce task revision create "$PROJECT" "$TASK" "$VERSION" \
  --specification "修订：除 lane-a/out.txt 外，再写入 lane-a/extra.txt。" \
  --reason "acceptance A3"; echo "exit=$?"
#   → 返回 { revision, delivery, task }；记下 delivery.id 与 task.version
#     注意：create 会移动 Task version，后面的 resolve 必须用**新的** version：
ce task status "$PROJECT" "$TASK" --json     # 读回 task.version → VERSION2

ce task revision delivery list "$PROJECT" "$TASK" --json
ce task revision delivery resolve "$PROJECT" "$TASK" "$DELIVERY" "$VERSION2" --action retry --json
echo "retry exit=$?"                                        # 期望 1（UNSATISFIED）
ce task revision delivery resolve "$PROJECT" "$TASK" "$DELIVERY" "$VERSION2" \
  --action stop-and-restart --json; echo "stop-and-restart exit=$?"
ce task revision delivery get "$PROJECT" "$DELIVERY" --json
ce task status "$PROJECT" "$TASK" --json
ce task transcript "$PROJECT" "$TASK" --execution <successor-execution-id> --json
```

> 注：只有 `resolve` 一个子命令带 `--action`，它只接受两个取值：`retry` 与 `stop-and-restart`。

**预期观察**

- delivery：`state: CHANNEL_UNSUPPORTED`、`evidence` 形如 `capability:UNSUPPORTED`、`satisfied: false`。
- `resolve --action retry` → **exit 1**，投递仍是未确认（没有确认通道时重试只会再记一次同一事实）。
- `resolve --action stop-and-restart` → **exit 0**；`delivery get` 变为 `satisfied: true`、
  `state: SUPERSEDED_BY_RESTART`、`evidence` 指向 successor Execution。
- `task status`：旧 Execution `SUPERSEDED`/`stopReason: USER_PAUSE`，successor 的
  `revisionId`（即 `applied_revision_id`）**等于**新 revision id。

**判定**

- **可机器断言**：上面的状态、`satisfied`、退出码、`revisionId === 新 revision id`。
- **必须人眼**：successor 的 transcript 显示模型**理解了新规格**（提到 `lane-a/extra.txt` 或按新约束
  行动），而不是默默重做旧范围。这一条**不能**从 `applied_revision_id` 推出——那一列只证明 Runtime
  用了新 revision，不证明模型读懂了它。

**失败/中止**：`stop-and-restart` 返回 1 且带 `RECOVERY_REQUIRED` → 停止无法确认静止，保留现场（§4）。
`SUCCESSOR_REVISION_MISMATCH` → 期间又出现了更新的 revision；**不暂停、不新建**，记录并停下。

**证据**：`a3-revision-create.json`、`a3-deliveries.json`、`a3-resolve-retry.json`、
`a3-resolve-stop-and-restart.json`、`a3-delivery-get.json`、successor transcript。

---

### A4 Project Knowledge 真实消费（NEXT 第 7 条 / ADR-0051）

这是 ADR-0051 明确留下的**未验证项**：ADR-0051 已证明「我们把该 Execution 绑定的知识交给了 provider」
（argv/参数逐字节、digest 核验、fail-closed），但**没有**证明「provider 真的读了它」。

**前置**：§1.6 的知识条目已提交到 `main` 且已重新 trust。

**命令**

```sh
ce project knowledge validate "$PROJECT" --json; echo "exit=$?"        # 0 = 层完整
ce project knowledge resolve "$PROJECT" "$TASK" --json                  # entryCount>0、appliesToTask
ce project knowledge show "$PROJECT" --json                             # 记下 snapshotId 与绑定

ce task create "$PROJECT" "读取系统提示中附带的知识，把其中的 token 原样写入 knowledge-out.txt，并在回答里复述一次。"
ce task submit "$PROJECT" "$TASK" 0
ce task run "$PROJECT" "$TASK" 1 --adapter pi --json; echo "exit=$?"

# 物化文件与记录的一致性（机器断言）
ls "$CODEESTRA_HOME/knowledge/$PROJECT/$TASK/knowledge-context.md"
shasum -a 256 "$CODEESTRA_HOME/knowledge/$PROJECT/$TASK/knowledge-context.md"
grep -c 'CE-M4-KNOWLEDGE-TOKEN-7f3a91c2' "$CODEESTRA_HOME/knowledge/$PROJECT/$TASK/knowledge-context.md"

# 结果检查
grep -rl 'CE-M4-KNOWLEDGE-TOKEN-7f3a91c2' "$CODEESTRA_HOME/worktrees/$PROJECT/$TASK/" || echo "worktree 中没有该 token 的原始文件（符合预期）"
cat "$CODEESTRA_HOME/worktrees/$PROJECT/$TASK/knowledge-out.txt" 2>/dev/null
ce task transcript "$PROJECT" "$TASK" --json
```

**预期观察**

- `knowledge resolve --json`：`entryCount > 0`，条目路径是 `.codeestra/instructions/probe-knowledge.md`，
  该条目 `appliesToTask: true`。
- `knowledge show --json`：这次 Execution 绑定了一个快照，记录 `contextPath`/`contextDigest`/`contextBytes`。
- 物化文件的 sha256 等于记录的 `contextDigest`，且**位于 Runtime 数据目录**（不在 worktree 内）。
- worktree 里**没有** `knowledge-context.md`，也没有 `.codeestra/generated/`：
  ADR-0041 D05 的结构事实。token 只存在于物化文件里。
- `knowledge-out.txt` 与 transcript 里出现 token。

**判定**

- **可机器断言**：resolve 字段、物化文件 digest 与记录一致、token **不在** worktree 的原始文件里、
  `knowledge-out.txt`/transcript 里出现 token。
- **必须人眼**：`knowledge-out.txt` 与 transcript 里的 token 是模型**自己产出**的，不是被 shell 回显的。
  判定依据要写进记录：token 只出现在 provider 上下文里（物化文件），不在 worktree 里；模型复述它 ⇒
  它读到了那份上下文。
- **若模型没复述 token**：第一件事是确认它是否真的进行了工具调用（`completion.facts.toolCallCount`）
  与是否成功写完文件。若它调了工具、但没复述 token —— 这是「未证明」，**不得**写成「已验证」，
  也不得改成「已证明不读」。

**失败/中止**：`project knowledge validate` 退出 1（有条目被拒）→ 先修知识层，不启动 Execution。
`KNOWLEDGE_CONTEXT_UNAVAILABLE`（Adapter 侧 digest/路径核验失败，启动前拒绝）→ 保留现场，
**这不是模型问题**，是一次未启动的执行。

**证据**：`a4-validate.json`、`a4-resolve.json`、`a4-show.json`、物化文件 + `shasum -a 256` 输出、
`knowledge-out.txt`、transcript（含 `--json` 原文）。

---

### A5 插件与 gate 对抗（NEXT 第 8 条 / ADR-0044）

只做**受控、可回滚**的观察，不追求攻破。要观察的是两件**不同**的事，不要混：

1. gate 对「模型发起的工具调用」的判定；
2. extension 自己的直接副作用（不经过 `tool_call`）——**结构上无法被 gate 拦截**，
   这正是 ADR-0044 D03 如实记录的风险。

**前置**：一个受控 probe extension，写在**临时目录**（不入仓）。骨架（结构来自
`packages/agent-adapters/src/pi-question-extension.ts` 的真实 API 用法）：

```sh
cat > "$TMP/probe-extension.ts" <<'TS'
import { writeFileSync } from 'node:fs';

// 受控观察 A：extension 自己的直接副作用（不经过 tool_call，gate 看不到）
export default function probe(pi: any): void {
  try { writeFileSync(process.env.CODEESTRA_HOME + '/plugin-side-effect.txt', 'direct side effect\n'); }
  catch { /* 观察用，失败不影响判定 */ }

  // 受控观察 B：注册一个模型可以调用的工具（会经过 tool_call，因此会经过 gate）
  pi.registerTool({
    name: 'probe_side_effect',
    label: 'probe',
    description: 'Acceptance probe: writes probe-tool-out.txt in the workspace.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      writeFileSync('probe-tool-out.txt', 'tool side effect\n');
      return { content: [{ type: 'text', text: 'probe tool ran' }], details: {} };
    },
  });
}
TS
```

**命令**

```sh
ce agent plugins list --project "$PROJECT" --adapter pi --json; echo "exit=$?"
ce agent plugins select --project "$PROJECT" --adapter pi \
  --extension "$TMP/probe-extension.ts" --json; echo "exit=$?"
ce agent plugins list --project "$PROJECT" --adapter pi --json   # 该条目 selected: true
ce settings permission get                                                # 确认当前模式

# ---- 观察 1：FULL 模式 ----
ce settings permission set full
ce task create "$PROJECT" "调用 probe_side_effect 工具一次，然后结束。"
ce task submit "$PROJECT" "$TASK" 0
ce task run "$PROJECT" "$TASK" 1 --adapter pi --json; echo "exit=$?"
ce attention list "$PROJECT"          # 期望：没有针对 probe_side_effect 的 Attention
ls "$CODEESTRA_HOME/plugin-side-effect.txt"     # 期望：存在（直接副作用）
ls "$CODEESTRA_HOME/worktrees/$PROJECT/$TASK/probe-tool-out.txt"   # 期望：存在

# ---- 观察 2：STRICT 模式 ----
ce settings permission set strict
ce task create "$PROJECT" "调用 probe_side_effect 工具一次，然后结束。"
ce task submit "$PROJECT" "$TASK2" 0
ce task run "$PROJECT" "$TASK2" 1 --adapter pi --json; echo "exit=$?"
ce task transcript "$PROJECT" "$TASK2" --json   # 期望出现 "Codeestra rejected unknown tool: probe_side_effect"
ce events list --project "$PROJECT" --since 0 --limit 500 --json

# ---- 还原（必须做） ----
ce agent plugins select --project "$PROJECT" --adapter pi --clear; echo "exit=$?"
ce settings permission set full
```

**预期观察**

- `plugins select` exit 0，`plugins list --json` 里 probe 条目 `selected: true`；`--clear` 后回到
  `selected: false`。
- FULL：`probe_side_effect` 被 **ALLOW**，`attention list` 里**没有**对应条目。这是
  `classifyPiTool('probe_side_effect', 'FULL') === 'ALLOW'` 的设计语义，**不是漏洞**
  （ADR-0044 D03：「FULL 下用户显式加载的第三方 extension 可能影响或绕过审批」）。
- STRICT：同一个工具被 **REJECT_UNKNOWN**，transcript 里出现
  `Codeestra rejected unknown tool: probe_side_effect` 且该轮终止。
- **两种模式下**，`$CODEESTRA_HOME/plugin-side-effect.txt` 都存在：extension 的直接副作用不经过
  `tool_call`，gate 结构上看不到它。这是「gate 是审批通道，不是沙箱」的事实。

**判定**

- **可机器断言**：`plugins list` 的 `selected`、FULL 下无该工具 Attention、STRICT 下 transcript 的
  block reason、两个 side-effect 文件的存在。
- **必须人眼**：读 probe 源码并确认「直接副作用」确实没有走任何工具调用通道（这决定了这条观察的
  解释）。同时确认这是**受控、可回滚**的：`--clear` 之后选择必须为空。

**失败/中止**：probe 让 Runtime 崩溃、provider 异常退出或 ATTENTION 通道出错 → 立刻
`agent plugins select --clear`、必要时 `settings permission set full`，然后按 §4 保留现场。
**不要**继续加载其它 extension 去「再试一次」。

**证据**：`a5-plugins-list-before/after.json`、probe 源码原文（含 sha256）、两个 side-effect 文件的
路径与内容、FULL/STRICT 各自的 transcript 与 `attention list`、`events list`。

---

### A6 散文提问（NEXT 第 4 条 / ADR-0043 / FOUNDATION-069）

**前置**：`settings prose-question-attention` 为 `auto`（默认）。

**命令**

```sh
ce settings prose-question-attention                     # 期望 auto
ce task create "$PROJECT" "请不要使用任何工具。用一句普通话问我一个问题，然后结束本轮。"
ce task submit "$PROJECT" "$TASK" 0
ce task run "$PROJECT" "$TASK" 1 --adapter pi --json; echo "exit=$?"

ce task status "$PROJECT" "$TASK" --json                  # 注意 stderr 的 [note]/[waiting] 行
ce attention list "$PROJECT"
ce attention answer "$PROJECT" "$ATTENTION" value "随便答一句"; echo "answer exit=$?"   # 期望 1
ce attention resolve "$PROJECT" "$ATTENTION" --answer "这是用户的回答" --json; echo "resolve exit=$?"
ce task status "$PROJECT" "$TASK" --json
ce task transcript "$PROJECT" "$TASK" --json              # resolve 之后不应新增条目
ce events list --project "$PROJECT" --since 0 --limit 500 --json
```

**预期观察**

- `task status --json`：`task.state: WAITING_FOR_USER`；`executions[0].state: RUNNING`；
  `executions[0].session.state: EXITED`；`executions[0].session.completion.outcome: SUCCESS`；
  `executions[0].session.completion.note.code: PROSE_QUESTION_NO_TOOL_USE`。
  stderr 上有 `[note] …` 与 `[waiting] …` 两行。
- `attention list`：一条 `kind: QUESTION`、`responseType: VALUE`、`status: OPEN`，
  `prompt.kind: codeestra.prose-question`，带模型问的原文。
- `attention answer … value …` → **exit 1**，码 `PROSE_QUESTION_RESOLUTION_REQUIRED`（不写任何行）。
- `attention resolve … --answer …` → **exit 0**；Task 回到 `RUNNING`、Attention `CLOSED`。
- `events list`：`UserAttentionRequested`（payload 里有 `proseQuestion: true`）、
  `ProseQuestionAttentionResolved`（`deliveredToProvider: false`）、两条 `TaskStateChanged`。
- resolve 之后 transcript **不**新增条目、**不**新建 Execution、**不**产生 `ANSWER_AGENT` intent。

**判定**

- **可机器断言**：上面这条 `WAITING_FOR_USER + RUNNING + EXITED` 三元组与 note code，以及两个退出码、
  事件名、`deliveredToProvider: false`。
- **必须人眼**：模型问的确实是一个**等人回答**的问题（不是自问自答、不是工具问卷）。这一条是启发式
  （「无工具调用 + 最后一段 assistant 文本以问号结尾」），必然有误报；判断误报用
  `attention resolve --dismiss`，不要用 `--answer`。

**失败/中止**：Task 停在 `RUNNING` 且没有等待 → 说明启发式没命中（`completion.note` 里可能是别人）。
先用 `settings prose-question-attention record-only` 确认这是降级行为而不是缺陷，再记录。
**不要把「没命中启发式」写成「散文提问不可用」**。

**证据**：`a6-setting.json`、`a6-attention.json`、`a6-answer-refused.json`、`a6-resolve.json`、
`a6-task-after.json`、`a6-events.json`、resolve 前后两份 transcript。

---

### A7 原生终端接管 + 真实模型键入后交还（NEXT 第 2 条 / ADR-0026）

ADR-0026 的能力矩阵里 `crossHandoffPermissionModeMatrix` 是 `PARTIAL`、`parallelToolBatchSafePoint`
是 `UNVERIFIED`；本项验收的是**主路径**：真实模型下 TUI 接管、键入、`release` 回自动化、RPC 从同一
session 继续。

**前置**：一个 `RUNNING` 的 Session；记下 `executions[0].session.sessionId`。

**命令**

```sh
ce session handoff status "$PROJECT" "$SESSION" --json      # 记下 safePoint 与 capabilities
ce session handoff request "$PROJECT" "$SESSION" takeover; echo "exit=$?"

# 轮询到安全点（每个工具批次结束 + fence 被确认）
ce session handoff status "$PROJECT" "$SESSION" --json      # 直到 safePoint.reached: true

ce session handoff admit "$PROJECT" "$SESSION"; echo "exit=$?"
ce session handoff status "$PROJECT" "$SESSION" --json      # incarnation 应为 HUMAN_TUI，lease 移交

ce session handoff attach "$PROJECT" "$SESSION" --holder cli-1 --writer
ce session handoff terminal read "$PROJECT" "$SESSION" --since 0
ce session handoff terminal write "$PROJECT" "$SESSION" --text "请用一句话说明你现在的上下文。"
echo "write exit=$?"
# 第二个 writer 必须被拒（不排队、不伪装成功）：
ce session handoff attach "$PROJECT" "$SESSION" --holder cli-2 --writer; echo "second-writer exit=$?"

ce session handoff release "$PROJECT" "$SESSION"; echo "release exit=$?"
ce session handoff status "$PROJECT" "$SESSION" --json      # 新 incarnation 应为 AUTOMATED_RPC
ce task transcript "$PROJECT" "$TASK" --json                # 应包含刚键入内容产生的条目
```

**预期观察**

- `status` 的 `capabilities`：`ptyTransport` / `successorProcessStart` / `nativeTerminalAttach` /
  `releaseBackToAutomation` 为 `IMPLEMENTED`；`attachToLiveRpcProcess` / `ptyResize` / `windows` 为
  `UNSUPPORTED`（**如实显示不支持，不静默降级**）。
- `admit` exit 0：successor 真的启动，`incarnation.mode: HUMAN_TUI`，`providerSessionId` 不变，
  `sessionStorageRef` 不变，`writerLease.holderKind: TERMINAL_ATTACHMENT`；Execution 仍为 `RUNNING`。
- `terminal read` 返回 TUI 渲染的字节流（控制字符显示为可见占位，不当作控制指令解释）。
- `terminal write` 用 `--text` 把输入送进终端（base64 由 CLI 负责编码）。
- 第二个 writer：**exit 1**，码 `ATTACHMENT_BUSY`，并报出当前 holder。
- `release` exit 0：provider 确已退出、归属核验通过、session file 未丢失条目 → 交还自动化，
  出现 `AUTOMATED_RPC` successor；`session_terminals.exit_code` 只作审计。
- release 后 `task transcript --json` 里有键入内容触发的**新条目**，且它们在**同一** session file 里。

**判定**

- **可机器断言**：`admit`/`release` 的退出码、incarnation 的 `mode`、`providerSessionId`/
  `sessionStorageRef` 前后相同、`ATTACHMENT_BUSY`、capabilities 取值、`safePoint.reached`。
- **必须人眼**：模型对键入内容的回答**出现在同一段对话的上下文里**（它提到了键入的那句话）。
  另外：`terminal read` 的 TUI 投影可读（这一条与观感清单的 L 组互补，但这里判的是「有没有拿到
  真实终端字节」，不是「好不好看」）。

**失败/中止**

- `RELEASE_NOT_CONFIRMED` / `PREDECESSOR_DESCENDANTS_ALIVE` / `PREDECESSOR_UNVERIFIED` →
  **release 被拒**。停止操作，不要重发 release，不要杀进程；终端仍是 writer，按 §4 保留现场。
- `SESSION_FILE_REWRITTEN` / `SESSION_FILE_TRUNCATED_READ` → 会话文件事实不符，保留现场并报告。
- `TAKEOVER` 一直等不到安全点 → 记录 `safePoint.missing` 的内容后中止。

**证据**：`a7-status-pre.json`、`a7-request.json`、每次轮询的 `a7-status-N.json`、
`a7-admit.json`、`terminal read` 的原始输出、`terminal write` 的返回、第二个 writer 的拒绝、
`a7-release.json`、release 后的 `status` 与 transcript。

---

### A8 真实 GitHub 上的产品路径提升（**已删除**，ADR-0066）

这一项验收的是产品命令面 `promotion prepare/approve/promote` + `promotion full-suite run`。**ADR-0066
（schema v35）把它连同 IntegrationBatch、独立集成验证与 dev clone 一起从产品中删除**，所以这里没有可执行的
验收步骤。

仍然成立的只有本仓库自身的约定流程：`docs/agents/runbook.md` 的人工四步（push 固定候选到远端 `dev` 并读回
→ main 检出 ff-only 拉取 → 重启核对 → 推回远端 `main`）。它是**人工操作**，不是产品能力，本文不把它列为验收项。

## 3. 证据包

每次验收都按同一清单收集，放进 `$EVIDENCE`（一个目录，路径写进交付记录）：

| # | 证据 | 生成命令 |
|---|---|---|
| 1 | 代码身份 | `git -C "$CLONE" rev-parse HEAD`、`git -C "$CLONE" status --porcelain`（必须空） |
| 2 | 运行环境 | `CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra status` |
| 3 | 项目身份与策略 | `project list`、`project inspect`、`project policy`、`project impact validate --json` |
| 4 | 每个验收项的 `--json` 输出 | 见各 A 项「证据」小节 |
| 5 | 事件序列（**最有价值的一份**） | `events list --project "$PROJECT" --since 0 --limit 500 --json` |
| 6 | 进程事实 | `ps -Ao pid=,ppid=,command=` 的同一时刻快照 |
| 7 | 物化知识 | `$CODEESTRA_HOME/knowledge/**` 的文件 + `shasum -a 256` + 与记录的 digest 对照 |
| 8 | 会话内容 | `task transcript … --json`（每个相关 Execution 一份） |
| 9 | 终端投影 | `session handoff terminal read --since 0` 的原始输出 |
| 11 | Runtime 数据目录 | `$CODEESTRA_HOME` 的只读拷贝（`runtime.sqlite` + `-wal` + `-shm`、`worktrees/`、`knowledge/`、provider session 目录、`runtime-boots/`） |
| 12 | 本次执行过的命令 | 脚手架真实模式把每条子命令与退出码追加到 `$EVIDENCE/commands.log`；手动执行时你自己维护同样一份 |

**不要**收集：任何 provider 凭据、Web UI token、`.env`。

---

## 4. 失败时保留现场

基本原则（与 ADR-0016/0021/0028 一致）：**失败现场默认保留**，回收只能显式进行。

1. **不要删临时目录**。脚手架默认不删（只有 `--clean` 且**无失败**时才删）；失败时它会打印保留指引。
2. **不要 `reclaim apply`**。先只读地看：`reclaim plan --all-projects`，确认每个资源的归属再决定。
3. **不要杀未核验归属的进程**。`RECOVERY_REQUIRED` 的含义就是「有事实无法证明」；
   收敛只会**报告** pid，不发信号、不删资源。
4. **`RECOVERY_REQUIRED` 不要靠重试掩盖**。它是状态而不是错误码；先看
   [troubleshooting.md 的 `RECOVERY_REQUIRED` 一节](../guides/troubleshooting.md)。
5. **导出事件之前不要停 Runtime**（如果状态本身就是现场）。需要拷 SQLite 时：
   - Runtime 仍在跑：连 `runtime.sqlite-wal` 与 `runtime.sqlite-shm` 一起拷，或用 SQLite 备份 API，
     **不要**只拷主文件（WAL 里可能还有已提交数据）。
   - 需要干净的收尾记录时：`CODEESTRA_HOME="$CODEESTRA_HOME" bun run codeestra stop`（这会中断活动
     Session，是既定语义），再拷。
6. **终端/交接失败时不要重发 `release`**：终端仍是 writer，第二次 release 会被拒，而且会掩盖第一次的
   真实拒绝码。
7. **把结论写清楚**：哪些断言成立、哪些未观察、哪些被拒绝（附稳定码），以及「未验证」与「验证失败」
   的区别。**不得**把未验证写成已验证。

---

## 5. 本 runbook 明确不覆盖

- **界面观感**（布局、主题、字号、动效、焦点、窄屏/矮窗口）：见
  [acceptance-checklist.md](../guides/acceptance-checklist.md)。那份清单的 §5 已加一条指向本文的
  「功能验收（非观感）」入口。
- **浏览器/桌面自动化**：ADR-0008 与 `PROJECT_SPEC.md` §1.1 禁止 computer-use、OS 级键鼠/窗口自动化、
  桌面应用操作与真实桌面会话。本文的所有交互都走 CLI。
- **Claude Code 的模型层**：本机无凭据，其能力如实为 `REQUIRES_VALIDATION`
  （见 [troubleshooting.md §4 第 8 条](../guides/troubleshooting.md)）。
- **Codex 侧散文提问事实层、UI 投影、Self Evolution / Phase 7**：见
  [troubleshooting.md §4](../guides/troubleshooting.md) 与 `## NEXT`。
- **性能与压测**：本文不设阈值。

---

## 6. 相关阅读

- 命令参数、退出码、稳定码：[cli/README.md](../guides/cli/README.md)
- 端到端流程（日常怎么用，不是怎么验收）：[workflow.md](../guides/workflow.md)
- 领域概念（为什么 `UNKNOWN` 不是 `SAFE`、成果停在 task 分支由你合并）：[concepts.md](../guides/concepts.md)
- 出错了怎么办：[troubleshooting.md](../guides/troubleshooting.md)
- 人工观感清单：[acceptance-checklist.md](../guides/acceptance-checklist.md)
- 决策依据：ADR-0016（暂停/终止）、ADR-0026（原生终端）、ADR-0028（修订投递）、ADR-0043（散文提问）、
  ADR-0044（插件与 gate）、ADR-0051（知识交接与 ACK 评估）、ADR-0008/0011（效率、CLI 完备、FULL 零确认）、
  ADR-0066（删除 dev clone / 集成 / 稳定提升）
- 脚手架：`scripts/real-provider-acceptance.sh`（`--help` 列出全部步骤）
