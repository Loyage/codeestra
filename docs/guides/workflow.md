# 端到端流程走查

> **适用版本** `dev@7425556` + 本格分支 `Loyage/task_auto`（2026-09-17） · **schema** v36 · **最后校对** 2026-09-17
> 版本会前进：`dev@7425556` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> §1 的创建任务与 §4.4 的修订示例由本分支按 **ADR-0065** 改写（必填 `--title`/`--name`；`--constraint`/`--kind` 已删除）。
> §3.1 的 `task run` 门禁由 FOUNDATION-091 按 ADR-0059 改写。
> §10 的依赖满足语义由 FOUNDATION-093 第三轮同步（ADR-0060 修订）；其余内容沿用 FOUNDATION-091 的校对基线。
> **本次修订（ADR-0066 / schema v36）**：§7「合入 `dev`」与 §8「稳定提升」整节删除，改为成果去向与
> 本仓库自身的人工四步；§9 去掉自动回收；§3.3 的依赖语义按「上游结果 commit 对当前基线可达」改写。

本文按真实顺序走一遍：**建任务 → 提交 → 运行 → 回答 Agent → 提交成果 → 验证 → 把成果交给你 → 资源回收**。
每一步给出可以照抄的命令和**预期输出形状**。

总流水线（[PROJECT_SPEC.md](../../PROJECT_SPEC.md) §1）：

```text
User Intent → Task / Task DAG → Dependency Analysis → Conflict Analysis
→ Scheduler → Git Worktree（基于 dev）→ Coding Agent → Task Verification
→ Dev Integration → Integration Verification → Dev
→ 用户批准固定 dev/main SHA → Main → 立即重启 Runtime
```

准备（详见 [getting-started.md](./getting-started.md)）：

```sh
cd /path/to/codeestra            # 或你自己的仓库
bun install --frozen-lockfile
export CODEESTRA_HOME=/tmp/codeestra-demo   # 想隔离就换数据目录
bun run codeestra status
bun run codeestra project trust .           # FULL 零确认；STRICT 可加 --yes
bun run codeestra project list              # 取得 project id
```

下面用 `$PROJECT` 表示 `project list` 返回的 Project ID。

---

## 1. 创建任务（DRAFT）

```sh
bun run codeestra task create $PROJECT "为 parser 增加一个 CRLF 输入用例" \
  --title "给 parser 补一个 CRLF 输入用例" --name "parser-crlf-case"
```

- 位置参数是**任务详情**（Agent 实际依据的正文）：多词原样拼接。
- `--title <显示标题>`：非空、单行、≤ 200 字符；任务列表显示的就是它。
- `--name <命名标题>`：小写英文短横线 slug（`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`，≤ 50 字符）；
  分支与 worktree 目录叫 `task/<编号>-<name>` 与 `<编号>-<name>`。
- 三个字段都必填；`--constraint` 与 `--kind` 已删除（ADR-0065），传入即用法错误（退出码 2）。

**预期形状**：打印 Task 的摘要 JSON，包含 `taskId`、`displayNumber`（人读编号，如 `#3`）、
`state: "DRAFT"`、`revisionId`（第一条 revision）、`version`。原始意图、首 revision、事实事件与幂等回执
在同一个事务里写入。

列出来看：

```sh
bun run codeestra task list $PROJECT          # 默认不含归档
bun run codeestra task list $PROJECT --all    # 含归档
```

---

## 2. 提交任务（DRAFT → READY）

```sh
bun run codeestra task submit $PROJECT <task-id> <expected-version>
```

`<expected-version>` 是乐观版本号（上面输出里的 `version`）。版本不符会以 `VERSION_CONFLICT` 类拒绝，
而不是覆盖别人的修改。

**预期形状**：在 submit 的结果之上附带两件事——

- `state` / `version` / `dependencyState`：依赖核对后的真实状态（上游未进 `dev` 时是 `BLOCKED`）；
- `schedule`：**同一次命令里就跑了一次调度 pass**。所以提交之后你不需要再推任何东西。

---

## 3. 调度与运行

### 3.1 显式启动一个 Task

```sh
bun run codeestra task run $PROJECT <task-id> <expected-version> [--adapter pi|codex|claude] [--allow-unknown] [--json]
```

`task run` 是**与自动调度同一个门禁的显式启动请求**：依赖判定 → 对**未完成且声明了功能**的 Task 的冲突判定 → 容量。
`--adapter` 默认 `pi`；**每次运行绑定一个 Agent，换 `--adapter` 是新建 Execution，而不是在同一个 Execution 里换 Agent**。

**预期形状**（`ScheduleStartOutcomeView`）：

```jsonc
{
  "projectId": "…", "taskId": "…",
  "outcome": "STARTED",            // 或 "WAIT" / "REFUSED"
  "executionId": "…", "sessionId": "…", "attemptNumber": 1,
  "taskVersion": 2, "workspaceId": "…", "workspacePath": "…",
  "baseCommit": "…",               // 从固定 dev commit 建立的基线
  "adapterId": "pi", "adapterVersion": "…", "sessionState": "…",
  "permissionMode": "FULL",        // 本次执行生效的权限模式
  "agentConfig": { /* provider/model/thinking 及来源 */ },
  "reservationId": "…",
  "wait": null,                    // outcome=WAIT 时是 { kind, code, detail }
  "assessment": { /* 依赖/冲突/容量的事实 */ },
  "clearedUnknownBy": null,
  "code": null, "detail": "…"
}
```

**退出码是三个不同的意思**（这是脚本区分「现在没轮到」与「确实不行」的方式）：

| 退出码 | 含义 | stderr |
|---|---|---|
| `0` | 已启动（`outcome: STARTED`） | 无 `[scheduler]` 行 |
| `3` | **等待**（`WAIT`）：冲突等待或容量等待，或 Runtime 正在 draining | `[scheduler] CONFLICT|CAPACITY wait: <code> — …` |
| `1` | **拒绝**（`REFUSED`）：依赖未满足、状态不可启动、revision 过期等 | `[scheduler] refused: <code> — …` |

> `BLOCKED` 只表示**依赖未满足**。冲突/容量永远是「等待」，退出码 3。

### 3.2 不做任何事也会被调度

Runtime **自己会调度**：一次相关事件（submit、合入 dev、停止、revision 投递、槽位释放、容量变化）触发一次 pass，
另有一个周期性恢复 pass 收敛崩溃遗留的状态。周期由 `CODEESTRA_SCHEDULE_TICK_MS` 控制（默认 `5000` 毫秒）。

你可以手动请求一次 pass（例如看完计划后）：

```sh
bun run codeestra task schedule status  $PROJECT [--adapter <id>] [--json]
bun run codeestra task schedule plan    $PROJECT [--adapter <id>] [--json]   # 有序 dry run，不预留、不启动
bun run codeestra task schedule explain $PROJECT <task-id> [--adapter <id>] [--json]
bun run codeestra task schedule run     $PROJECT [--adapter <id>] [--json]
```

- 排序规则：**priority 降序 → 创建时间 → ID 升序**。提高优先级只改变**下一次**顺序，**不会抢占**已经持有资源的 Task。
- `plan` 是 dry run：它**不预留、不启动**任何东西。
- `explain` 退出码：`0` = 正在跑或现在会启动；`3` = 等待（`WAIT_CONFLICT` / `WAIT_CAPACITY`）；`1` = `BLOCKED`
  或根本不可调度。
- `schedule run` 退出码 `0` 表示**这一趟 pass 跑了**，不代表有东西启动；每个候选的处置在报告与 stderr 里。

### 3.3 依赖（DAG）

```sh
bun run codeestra task depends add    $PROJECT <task-id> <expected-version> <prerequisite-task-id> [--revision <revision-id>] [--json]
bun run codeestra task depends remove $PROJECT <task-id> <expected-version> <prerequisite-task-id> [--json]
bun run codeestra task depends list   $PROJECT [task-id] [--json]
```

依赖图必须是 **DAG**；加环会以 `DEPENDENCY_CYCLE` / `DEPENDENCY_GRAPH_INVALID` 拒绝且不部分应用。
`task depends list` 的人读视图（不加 `--json`）逐条打印 `✓/✗ 依赖`、要求的 revision 编号，以及上游合入的
dev commit 前 12 位。

**关键语义**（ADR-0066）：**上游指定修订自己的结果 commit 必须对下游的 Task 基线 ref 可达**（基线就是项目文件夹建 workspace 时检出的分支；读不到就按未满足阻塞而不是拒绝命令）。仅 Task verification 成功
**不**释放依赖。

---

## 4. Agent 提问与审批

### 4.1 看当前有哪些请求

```sh
bun run codeestra attention list $PROJECT
```

返回数组，每条包含 `id`、`kind`（`PERMISSION` / `QUESTION` / `RECOVERY`）、`status`、`responseType`
（`CONFIRM` / `VALUE`）、`prompt`、`taskId`、`executionId`、`createdAt`。

### 4.2 回答

三种通道，选一个按 `kind` 用：

```sh
# 权限 / 确认类（responseType=CONFIRM）
bun run codeestra attention answer $PROJECT <attention-id> confirm yes
bun run codeestra attention answer $PROJECT <attention-id> confirm no

# 纯文本类（responseType=VALUE）
bun run codeestra attention answer $PROJECT <attention-id> value "用现有 helper，不要新增依赖"

# 结构化问卷（一行 §3.1 里的 QUESTIONNAIRE 形态）
bun run codeestra attention answer $PROJECT <attention-id> --choose 1:2 --text 2="保持向后兼容"
bun run codeestra attention answer $PROJECT <attention-id> --cancel
```

- `--choose <题>:<选项>[,<选项>]` **可以重复**，题号与选项号都是 **1-based**，与界面显示一致。
- `--text <题>=<文本>` 也**可以重复**。
- 一道题只能答一次，重复会报错。
- 越界选项号由 Runtime 拒绝并返回 `INVALID_QUESTIONNAIRE_ANSWER:*`，请求**保持 OPEN**——你的回答不会被静默丢掉。

### 4.3 散文提问等待（Agent 用正文提问并结束轮次）

这类完成会被记为 `PROSE_QUESTION_NO_TOOL_USE`，Task 进入 `WAITING_FOR_USER`，但**provider 进程已经退出**，
没有 dialog 可以写。所以：

```sh
bun run codeestra task status $PROJECT <task-id>     # 会在 stderr 打印 [waiting] … 与 Agent 的问题正文
bun run codeestra attention resolve $PROJECT <attention-id> --answer "这是我的回答" [--note …] [--json]
bun run codeestra attention resolve $PROJECT <attention-id> --dismiss [--note …] [--json]
```

- `--dismiss` 记「误报」，`--answer` 记下你的回答。**两者都必须恰好给一个**。
- 两者都**不会**恢复 provider 对话，也**不是** TaskRevision：回答是关于**这一次等待**的陈述，不是对规格的修改。
- 用 `attention answer` 去投递这类等待会被以 `PROSE_QUESTION_RESOLUTION_REQUIRED` 拒绝（因为没有 dialog）。
- 全局开关：

```sh
bun run codeestra settings prose-question-attention            # 读取当前值
bun run codeestra settings prose-question-attention auto       # 默认：记成等待
bun run codeestra settings prose-question-attention record-only# 只标注完成，不记等待
bun run codeestra settings prose-question-attention off        # 什么都不记
```

改这个开关**不需要确认**，也**不会**改写已经记录下来的等待。

### 4.4 运行中的修订

```sh
bun run codeestra task revision create $PROJECT <task-id> <expected-version> \
  [--specification <text>] [--feature <module-id>]… [--reason <text>] [--json]
bun run codeestra task revision list $PROJECT <task-id> [--json]

bun run codeestra task revision delivery list   $PROJECT <task-id> [--json]
bun run codeestra task revision delivery get    $PROJECT <delivery-id> [--json]
bun run codeestra task revision delivery resolve $PROJECT <task-id> <delivery-id> <expected-version> \
  --action stop-and-restart|retry [--adapter <id>] [--json]
```

delivery 状态包含 `PENDING / IN_FLIGHT / ACKNOWLEDGED / UNACKNOWLEDGED / CHANNEL_UNSUPPORTED / TIMED_OUT / FAILED / SUPERSEDED_BY_RESTART`。
**投递是否满足只从台账来**，不是因为 Runtime 发了什么东西。对没有确认通道的 Adapter，它会**如实保持未确认**；
`resolve --action retry` 也因此可能仍然无法确认（退出码 1），而
`stop-and-restart` 会在**那条 revision** 上记录出后继 Execution。

---

## 5. 提交成果（result commit）

### FULL（默认）：一步

```sh
bun run codeestra task result capture $PROJECT <task-id> [execution-id]
```

### STRICT：两步

```sh
bun run codeestra task result prepare $PROJECT <task-id> [execution-id]
# → 输出 authorizationId
bun run codeestra task result commit $PROJECT <task-id> <authorization-id> --confirm
```

**前提与影响**（源码核对，两条路径都适用）：

- 只会提交在**已核验归属**的 task worktree 里；
- 创建 commit 前会**固定 HEAD / ChangeSet / revision**；它们在你确认之后变了就以
  `STALE_AUTHORIZATION` / `COMMIT_MISMATCH` / `STALE_REVISION` 拒绝；
- 沿用仓库**已有** Git identity；缺失时**停止**，不代写 `git config`；
- 项目 trust 后**正常执行 hooks**；失败**保留现场**，不会 `--no-verify`；
- **没有任何改动**时以 `NOTHING_TO_COMMIT` 拒绝；
- Agent 还没静止时以 `AGENT_NOT_QUIESCENT` 拒绝；
- STRICT 下还会拒绝**敏感路径**（`SENSITIVE_PATH_BLOCKED`）；**FULL 下不做敏感路径拒绝**（ADR-0011）；
- 成果落在内部 `refs/heads/task/<task-id>`。

> 常见误解：`task status` 里出现 `RECOVERY_REQUIRED` 时不要靠重试掩盖，先看
> [troubleshooting.md](./troubleshooting.md) 里 `RECOVERY_REQUIRED` 一节。

---

## 6. 任务验证

```sh
bun run codeestra task verify $PROJECT <task-id> [execution-id] [--policy auto|targeted|project] [--background]
bun run codeestra task verification list $PROJECT <task-id>
```

- 命令来自**项目 `main` ref** 上人工维护的 `.codeestra/policies/verification.json`；
- 在**固定 commit 的 detached 副本**里运行，**不在你的工作树里**；
- 证据**不含原始命令输出**，只绑定 `revision / commit / policy digest`；
- `--policy`：
  - `auto`（默认）：该 Task 有**已记录**的定向计划、且与本次 revision/commit 匹配时用它，否则用固定项目策略；
  - `targeted`：**必须**有这样一个计划，否则拒绝；
  - `project`：用固定项目策略。
- 用了定向计划时，结果里的 `policySource` / `policyLabel` 会如实写出来。

**退出码**：不加 `--background` 时，只有 `state === "PASSED"` 才是 `0`，否则 `1`。
加 `--background` 时 `0` 表示「已受理并开始」——**不代表验证通过**：

```sh
bun run codeestra task operation list   $PROJECT <task-id> [--json]
bun run codeestra task operation get    $PROJECT <operation-id> [--json]
bun run codeestra task operation cancel $PROJECT <task-id> <operation-id> [--json]
```

### 按分支职责分层的测试证据（ADR-0038）

开发分支（`task/*`、`lane/*`、feature）在**建分支时就**写下一份小的 `.codeestra/tests.json`：

```jsonc
{
  "version": 1,
  "scope": "…",                                  // 这一批定向测试覆盖什么
  "commands": [
    { "id": "…", "argv": ["bun","test","…"], "cwd": "…", "timeoutSeconds": 300,
      "covers": "…" }
  ]
}
```

- 命令数 1–16（超过就不是「定向」了）。
- 记录它是一个**显式、可审计的追加**：

```sh
bun run codeestra task tests record $PROJECT <task-id> [--commit <full-sha>] [--expected-plan-digest <sha256>] [--json]
bun run codeestra task tests show    $PROJECT <task-id> [--json]
bun run codeestra task tests history $PROJECT <task-id> [--limit <n>] [--json]
```

- `task verify` 运行的是**已记录的计划**，**不是文件本身**；所以事后改文件不会悄悄改变判定命令。
- 属于**另一个 revision 或 commit** 的旧计划会被拒绝（`TARGETED_TEST_PLAN_REVISION_MISMATCH` /
  `TARGETED_TEST_PLAN_COMMIT_MISMATCH` / `TARGETED_TEST_PLAN_DIGEST_MISMATCH`），**不会**被静默换成项目策略。

---

## 7. 把成果交给你（合并由你完成）

**Codeestra 不合入任何东西**（ADR-0066）。任务跑完、验证通过之后，成果 commit 停在
`refs/heads/task/<task-id>`：

```sh
bun run codeestra task status $PROJECT $TASK --json     # 读 resultCommit
git -C <项目文件夹> merge --ff-only <result-commit>     # 你自己合并（ff-only 只在你确认没分叉时成立）
```

- `task integrate`、`task integration create|integrate|list|get|cancel`、`promotion *`、`promotion full-suite *`
  全部**已删除**（ADR-0066，schema v36）：IntegrationBatch、独立集成验证、`dev` 集成分支与 `dev → main` 提升
  都不存在。执行它们只会得到用法错误（退出码 2）。
- 为什么：合并是把代码放进你日常使用分支的动作，冲突与取舍是你的产品判断。Codeestra 不替你做，也就不替你记账。
- **依赖释放**跟着变：下游要等上游的 result commit 对它自己的基线 ref 可达。这个重判发生在每一趟调度
  （默认 5 秒一次），所以 `task depends list` 可能显示「边已满足、任务仍是 `BLOCKED`」，最多滞后一个 tick。
- **没有自动回收**：合并之后 worktree 仍在磁盘上，要回收就显式 `reclaim apply`（§9）。

## 8. 本仓库自身的 `dev → main`（仓库约定）

产品没有发布到 main 的命令。**如果你在用 Codeestra 开发别的项目，这一节与你无关**：成果停在 task 分支，
合并由你自己完成（§7）。

Codeestra **自身**的开发仍按仓库约定走两个 clone（`~/Documents/codeestra` 检出 `main` 跑稳定实例、
`~/Documents/codeestra-dev` 检出 `dev`），`dev → main` 是人工四步：

1. push 固定 dev 候选到 `origin/dev` 并读回核对；
2. 在 main clone `git fetch` + `git merge --ff-only origin/dev`；
3. 在 main clone `bun install --frozen-lockfile` → `bun run codeestra stop` → `status`，核对 `status: "READY"`；
4. 核对通过后才把 `main` 推回 `origin/main`（重启失败则不推回，保留现场并如实报告）。

实现细节与失败处置见 [`docs/agents/runbook.md`](../agents/runbook.md)。这不是产品能力：没有记录、没有命令、
没有稳定码，也没有任何东西替你保证它被执行过。

## 9. 资源回收

```sh
# 只读试运行：返回与 apply 完全一样的决策形状
bun run codeestra reclaim plan --project $PROJECT [--task <task-id>] [--kind TASK_WORKTREE|VERIFICATION_COPY|INTEGRATION_WORKTREE]… \
  [--include-failure-scenes] [--unregistered] [--scan-root <path-inside-home>] [--remove-unregistered <path>]… [--json]

# 真正执行
bun run codeestra reclaim apply --project $PROJECT […]

# 审计记录
bun run codeestra reclaim records --project $PROJECT [--task <task-id>] \
  [--source ALL|REGISTERED|UNREGISTERED_DIRECTORY] [--since <epoch-ms|ISO>] [--until <epoch-ms|ISO>] [--limit <n>] [--json]
```

**这是唯一具有破坏性的命令面**，务必注意：

- 每个被考虑资源都有动作：`RECLAIM / RETAIN / REFUSE / ALREADY_ABSENT / RECOVERY_REQUIRED`，并带归属证据。
- **失败现场默认保留**：没有 `--include-failure-scenes` 时，未提交改动、失败/取消的验证是 `RETAIN`。
- **未注册目录不会被删**，除非用 `--remove-unregistered <精确路径>` 指名（ADR-0037）。
- 不带 `--project`（或加 `--all-projects`）覆盖**所有**已信任项目，结果按项目分组。
- 退出码：`FAILED` → `1`；可回收数量为 0（plan）或实际回收数量为 0（apply）→ `3`（「没什么可回收」不是错误）；
  否则 `0`。

被回收的 Task worktree 之后可以用 `task retry` 从保留的 Task 分支重建（ADR-0042）。

从 ADR-0062 起，**合入 `dev` 成功之后**会对该批成员的 Task worktree 自动执行同一条决策（默认开启）：
clean + 成果已进入该 workspace 记录的 `base_ref` 的会被回收，失败现场仍保留。**没有自动回收路径**
（ADR-0066 删掉了 ADR-0062 的「集成成功后自动回收」），只有显式 `reclaim plan/apply`。

---

## 10. 观察与调试

```sh
# 事件流（只读）
bun run codeestra events list [--project $PROJECT] [--since <sequence>] [--limit <n>] [--json]
bun run codeestra events tail [--project $PROJECT] [--since <sequence>]

# Agent 执行过程（只读，读 provider 自己的会话文件）
bun run codeestra task transcript    $PROJECT <task-id> [--execution <id>] [--after <entry-id>] [--limit <n>] [--reverse] [--json]
bun run codeestra session transcript <session-id> [--after <entry-id>] [--limit <n>] [--reverse] [--json]
bun run codeestra session transcript part <session-id> <entry-id> <part-index>

# 执行/会话总览
bun run codeestra task status $PROJECT <task-id>
```

`events tail` 的游标是**排他**的：

- 不带 `--since` 表示「从当前尾部开始」——所以正确做法是**先取一次快照，再用那个 cursor 订阅**，中间不丢事件；
- 带 `--since` 但游标**大于** Runtime 日志的最新 sequence，会收到一帧
  `{"type":"error","code":"INVALID_CURSOR"}` 并**结束订阅**——这是刻意的：客户端必须重新取快照，
  而不是以为自己已经追上了。

---

## 下一步

- 每条命令的完整参数与退出码：[cli/README.md](./cli/README.md)（八篇索引）
- Web UI 暂停状态：[ui.md](./ui.md)
- 报错怎么办：[troubleshooting.md](./troubleshooting.md)
