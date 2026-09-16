# 端到端流程走查

> **适用版本** `dev@4667d32`（2026-09-16） · **schema** v33 · **最后校对** 2026-09-16
> 版本会前进：`dev@4667d32` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> §3.1 的 `task run` 门禁由 FOUNDATION-091 按 ADR-0059 改写。
> §10 的依赖满足语义由 FOUNDATION-093 第三轮同步（ADR-0060 修订）；其余内容沿用 FOUNDATION-091 的校对基线。

本文按真实顺序走一遍：**建任务 → 提交 → 运行 → 回答 Agent → 提交成果 → 验证 → 合入 dev → 稳定提升 → 资源回收**。
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
bun run build:ui                 # 需要 Web UI 时
export CODEESTRA_HOME=/tmp/codeestra-demo   # 想隔离就换数据目录
bun run codeestra status
bun run codeestra open . --no-open          # 注册项目并拿到带 token 的 UI 地址
```

下面用 `$PROJECT` 表示 `project list` 返回的 Project ID。

---

## 1. 创建任务（DRAFT）

```sh
bun run codeestra task create $PROJECT "为 parser 增加一个 CRLF 输入用例" \
  --constraint "不得改动公开 API"
```

- `--constraint <text>` 可以重复，用来说明约束。
- `--kind DEVELOPMENT` 是当前允许的值（默认就是它）。

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

**关键语义**：**上游必须通过集成验证并进入 `dev`，下游的 Task 基线 ref 才包含它的结果**（有 dev clone 时该基线是那个 clone 的 `dev`；managed 项目是项目文件夹当前检出的分支，读不到就按未满足阻塞而不是拒绝命令，ADR-0060 第三轮修订）。仅 Task verification 成功
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
  [--specification <text>] [--constraint <text>]… [--reason <text>] [--json]
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

## 7. 合入 `dev`（IntegrationBatch）

```sh
bun run codeestra task integrate $PROJECT <task-id> <expected-version>
bun run codeestra task integration list $PROJECT [<task-id>]

# 多成员：先组成（不碰 Git），再一次性集成（ADR-0053）
bun run codeestra task integration create $PROJECT --member <task-id>:<version> --member <task-id>:<version>
bun run codeestra task integration integrate $PROJECT <batch-id>
bun run codeestra task integration cancel $PROJECT <batch-id> --reason "<为什么不要了>"
```

过程（ADR-0018 / ADR-0053）：

1. 在 Runtime 数据目录的 **detached integration worktree** 中合并成果 commit（**能 ff 就 ff，否则 `--no-ff`**）；
   多成员批次按 task-id 顺序逐个成员合并；
2. 跑**独立的集成验证**（独立实体，见 [concepts.md](./concepts.md)）——多成员批次是**一次覆盖整批**的验证；
3. 集成验证 `PASSED` 后才用 **CAS** 推进 `dev`，并把（每个）成员 Task 推到 `SUCCEEDED`。

**退出码**：只有 `state === "INTEGRATED"` 才是 `0`；`CONFLICTED`/`FAILED`/`STALE`/`CANCELLED` 等已记录的
非集成终态是 `1`；未收口、需要人先处理的批次（`RECOVERY_REQUIRED`）是 `3`；用法错误是 `2`。
它们都**不推进 `dev`**。

**拒绝的常见前提**：Task 验证未通过（`TASK_VERIFICATION_NOT_PASSED`）、没有成果 commit（`NO_CAPTURED_RESULT`）、
`dev` 正被某个工作树检出（`DEV_REF_CHECKED_OUT`）、`dev` 分支缺失（`DEV_REF_MISSING`）、已有集成在进行
（`INTEGRATION_IN_PROGRESS`）。

集成会以 `INTEGRATION` 触发一次调度 pass，因此刚满足的下游 Task 可能立刻被重新判定。

---

## 8. 稳定提升（`dev → main`）

### 8.1 先跑 dev 全量测试证据

```sh
bun run codeestra promotion full-suite run  $PROJECT --dev-commit <full-sha> [--json]
bun run codeestra promotion full-suite list $PROJECT [--limit <n>] [--json]
```

- 对**精确那个 dev SHA**，在 detached 副本里运行项目 `main` ref 的固定策略；
- **Runtime 运行并观察**结果——客户端**不能自报**「我跑过了」；
- 证据绑定三样东西：**候选 commit**、该策略的 **digest**、**候选 commit 上的锁文件 digest**；
- `run` 退出码 `0` 仅当 `state === "PASSED"`。

### 8.2 prepare →（STRICT: approve）→ promote

```sh
bun run codeestra promotion prepare $PROJECT <batch-id> <expected-dev-commit> <expected-main-commit>
bun run codeestra promotion approve $PROJECT <promotion-id>          # 仅 STRICT
bun run codeestra promotion promote $PROJECT <promotion-id> [--json]
bun run codeestra promotion get     $PROJECT <promotion-id>
bun run codeestra promotion list    $PROJECT [--limit <n>]
bun run codeestra promotion abandon $PROJECT <promotion-id> --reason <text>
```

- `prepare` **不写 Git**（也不写远端）：它只是把「已验证的 dev commit / 预期旧 main commit / 该 commit 的集成验证 +
  dev 全量证据」三个事实固定下来，并固定推送用的 dev clone（ADR-0047 D05）。
- `promote` **一次只推进一步**，每一步都要读回事实：

  1. **push 固定候选到远端 `dev`**（源是候选 OID，不是分支名；从不 `--force`），再 `git ls-remote` **读回核对**。
  2. main 检出还没有拉取 → 报**「已推送、等待拉取」**（`state: PROMOTING`，`phase: AWAITING_PULL`，**退出码 3**），
     **不执行也不记录任何重启步骤**。**这一步是你在检出 main 的那个 clone 里做的事**：

     ```sh
     git fetch origin
     git merge --ff-only origin/dev
     ```

     它**不是** Runtime 做的 ff，也不能用别的 merge 方式代替。
  3. 拉取后**再次调用同一命令**：核对到 main 检出确实在候选上、且候选是预期旧 main 的后代后，记录重启计划，
     然后在 main 检出依次执行：

     ```text
     bun install --frozen-lockfile
     bun run build:ui
     bun run codeestra stop
     bun run codeestra status
     ```

     **重启只有在每一步都退 0、重启后的 Runtime 回答 `READY`、且应答的 boot 与发出计划的 boot 不同时才会被记录**。
  4. 重启记录成功**之后**才把候选 push 回远端 `main` 并读回核对，然后 `SUCCEEDED`。推回失败保持可续：
     再次调用**只重试推回**，不会重复停 Runtime。

  **界面上的投影**（只读，`promotion.list` / `promotion.get`）：任务详情与「项目」标签页的
  `稳定提升记录 · dev → main` 显示派生的 `phase`、读回的 `origin/dev` / `origin/main` SHA，并按阶段给出 `下一步`。
  `AWAITING_PULL` 时它**不会把任何东西显示成已提升/已完成**，而是直接列出上面第 2 步的两条命令，
  并写明「命令面在这一阶段退出码 3——那是等待，不是失败」。它不推送、不拉取、不重启。
- **权限差异**：`FULL` 下不需要 `approve`；`STRICT` 下需要针对**那一组精确三元组**的 `approve`——dev/main/证据任一移动，
  批准即失效。
- **证据过期**：main 上的策略被编辑、候选里锁文件变了、或出现更新的失败运行 → 以
  `DEV_FULL_SUITE_EVIDENCE_STALE` 拒绝（退出码 1）。
- 退出码：`0` 仅在`SUCCEEDED`；`1` 拒绝或失败；`2` 用法错误；**`3` 已推送、等待拉取**。
- 失败时**不会自动回滚**：如果 main 已被拉取到候选但重启序列失败，CLI 会明确打印「main 检出已在候选上且未回滚；
  远端 `main` 未发布」，重跑 `promotion promote` 会重跑已记录的后置步骤（推回仍只在重启记录成功后才尝试）。

### 8.3 手工 stop + status（任何 main 更新之后）

```sh
cd /path/to/main-worktree
bun run codeestra stop
bun run codeestra status
```

只有 `status: "READY"` 且 `uiRunning: true` 才算 Runtime 已恢复。**重启成功前不得报告提升完成**（ADR-0009）。

---

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
- **失败现场默认保留**：没有 `--include-failure-scenes` 时，未提交改动、失败/取消的验证或集成是 `RETAIN`。
- **未注册目录不会被删**，除非用 `--remove-unregistered <精确路径>` 指名（ADR-0037）。
- 不带 `--project`（或加 `--all-projects`）覆盖**所有**已信任项目，结果按项目分组。
- 退出码：`FAILED` → `1`；可回收数量为 0（plan）或实际回收数量为 0（apply）→ `3`（「没什么可回收」不是错误）；
  否则 `0`。

被回收的 Task worktree 之后可以用 `task retry` 从保留的 Task 分支重建（ADR-0042）。

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

- 每条命令的完整参数与退出码：[cli-reference.md](./cli-reference.md)
- 界面上的每个面板：[ui.md](./ui.md)
- 报错怎么办：[troubleshooting.md](./troubleshooting.md)
