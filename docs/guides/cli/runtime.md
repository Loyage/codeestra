# CLI 参考 · Runtime 生命周期、Agent 配置与设置

> **适用版本** `dev@de03448`（2026-09-16） · **schema** v35 · **最后校对** 2026-09-16
> 版本会前进：`dev@de03448` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一（ADR-0064 之后为八篇），
> **内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码**，最后校对日期因此不变。
> 本文件覆盖 §1–§2、§19；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。
> **本次修订（ADR-0064 / schema v35）**：删除 `settings auto-reclaim` 一节（该开关随集成一起移除）、
> 删除 `open` 的 `--dev-repo` 参数，并删除所有 dev clone / 提升相关的失败码。
> 同一事实还有一个设置面拼写：`settings concurrency get|set --limit|reset`（见 §19），它发的是同一条 Runtime 命令。

## 1. Runtime 生命周期与权限

### `status`

```sh
bun run codeestra status
```

自动启动 Runtime（若不在跑），打印 `runtime.ping` 结果 + 从本 home 生命周期记录读出的 ownership 报告
（`lock` / `traces` / `endpointAnswers` / `verdict` / `unreadableRecords`）。

- **只读**：一个「进程在但不应答」的 Runtime 会被如实报告（`status: "UNAVAILABLE"`），不会被新建的实例掩盖。
- 退出码：`0` Runtime 可用；`1` 连不上且起不来。

### `stop`

```sh
bun run codeestra stop [--wait <seconds>]
```

`--wait` 接受 `0`–`600`（默认 `10`）。两阶段、只报事实：

| 输出 `status` | 含义 | 退出码 |
|---|---|---|
| `STOPPED` | 被点名的进程确实消失了（含僵尸：socket 与文件已释放） | `0` |
| `NOT_EXITED` | 等待期限内进程还在 | `1` |
| `NOT_RUNNING` | 没有 Runtime 拥有这个 home | `0` |
| `UNREACHABLE_PROCESS` | 进程还在但 socket 不应答（**不猜着杀**） | `1` |
| `STOP_FAILED` | 请求被接受但没有可核验的身份，或 Runtime 没接受请求 | `1` |

`pidMismatch` 字段表示「stop 应答点名的进程」与「ping 应答的进程」不同——那是两个 Runtime 争同一个 home 的事实，必须被看到。
`--wait` 之外的参数是用法错误（退出码 2）。

### `permission get` / `permission set`

```sh
bun run codeestra permission get
bun run codeestra permission set <full|strict>
```

`get` 返回 `{ mode, default: "FULL" }`。`set` 接受大小写不敏感的 `full` / `strict`，**无需确认**，写入
`<CODEESTRA_HOME>/permission-mode.json`（0600，原子替换）。其他取值是用法错误。

### `ui`

```sh
bun run codeestra ui [--no-open]
```

在 `127.0.0.1` 上按需启动 HTTP + SSE 并打印地址（token 在 fragment）。`--no-open` 只打印不打开浏览器。
除 `--no-open` 外不接受任何参数。

常见失败：`UI_ASSETS_MISSING`（界面资产目录下没有 `index.html`；提示信息给出 `bun run --cwd apps/ui build`）。

### `open`

```sh
bun run codeestra open [path] [--yes] [--no-open]
```

一条命令完成：`project.inspect` → 展示验证策略与影响映射 →（必要时）确认 → `project.trust` → `runtime.ui` 并预选该项目。
`path` 默认当前目录；`--yes` 是 STRICT 下的非交互确认；`--no-open` 不打开浏览器。

ADR-0064 之后 `open` 只有 `--yes` 与 `--no-open` 两个 flag：产品不再有 dev clone 可记，所以也没有
`--dev-repo`；Task 基线就是项目文件夹当前检出的分支（建 Task 时固定 ref 与 commit）。
（打开一个**已信任**仓库的另一个工作树时 trust 会被跳过。）

已经确认过且策略 digest 未变时会跳过确认（正常路径**一次项目一次确认**；FULL 下没有这一步）。
失败：确认被拒（`Project trust was not confirmed`）、trust 后项目未出现在列表中、
`REPOSITORY_CHANGED` / `VERIFICATION_POLICY_CHANGED` / `IMPACT_POLICY_CHANGED`（你审阅过的身份或策略在这期间变了）。

---

## 2. `agent config`

```sh
bun run codeestra agent config get   [--project <project-id>] [--adapter <id>]
bun run codeestra agent config set   [--project <project-id>] [--adapter <id>]
  [--provider <name>] [--model <id>] [--thinking <off|minimal|low|medium|high|xhigh|max>]
  [--unset provider|model|thinking]
bun run codeestra agent config clear [--project <project-id>] [--adapter <id>]
```

- `--adapter` 默认 `pi`。不带 `--project` 表示**全局默认**，带 `--project` 表示**该项目覆盖**。
- 每个字段都可选，所以 `set` 是合并式写入；`--unset <field>` 清空一个字段而不动其他字段。
- 同一个字段**不能**既给值又 `--unset`（用法错误）。
- `--thinking` 的合法值就是上面那 7 个。
- `get` / `clear` 不接受 `--provider` / `--model` / `--thinking` / `--unset`（用法错误）。

解析优先级**逐字段**：`环境变量 > 项目覆盖 > 全局默认 > Adapter 默认`。
**只影响此后新建的 Session**，并把当时生效的值记录在 Execution 上（`task status` 与 UI 都能看到）。
Adapter 不支持的字段会被拒绝而不是静默忽略。稳定码：`INVALID_AGENT_CONFIGURATION`、`UNKNOWN_ADAPTER`。

---

## 19. `settings`

```sh
bun run codeestra settings prose-question-attention            # 读取
bun run codeestra settings prose-question-attention auto       # 写入
bun run codeestra settings prose-question-attention record-only
bun run codeestra settings prose-question-attention off

bun run codeestra settings concurrency get   [--json]
bun run codeestra settings concurrency set   --limit <n> [--json]
bun run codeestra settings concurrency reset [--json]
```

### `settings prose-question-attention`

- 读与写是**同一条命令**：不给值就是读，给值就是写。多给一个位置参数是用法错误。
- 取值只有三个：`auto`（默认）/ `record-only` / `off`。其他取值是用法错误。
- **不需要确认**，且**不会改写已经记录下来的等待**。
- `--json` 被接受（输出本来就是 JSON）。

### `settings concurrency`（全局并发上限）

一个 Runtime 只有一个并发上限（ADR-0061 D01）。**设置面**的 `settings concurrency` 与**调度面**的
`scheduler capacity` 是同一事实的两种拼写：它们向 Runtime 发**同一条命令**（同一个
`runtime_capacity_settings` 行、同一条 `SchedulerGlobalCapacityChanged` 事件、同一套 commandId 幂等），
所以两边不可能读出不一致的值，也不存在第二个状态源。

- `get` 的输出与 `scheduler capacity get` 完全一致（`limit`/`limitSource`/`used`/`available`/`occupiers[]`/`waitReason`）。
- `set --limit <n>`：默认 **2**，合法 **1–16**，零确认；重复设置同一个值是**幂等 no-op**（`changed: false`）。
  非整数是用法错误（退出码 2）；整数但越界由 Runtime 拒绝：`CAPACITY_LIMIT_INVALID`（0/负数）、
  `CAPACITY_LIMIT_OUT_OF_RANGE`（大于 16），退出码 1，**不夹取**。
- `reset` 删掉显式值，让文档默认 2 生效（重复 `reset` 是 no-op）。
- **实时生效，不需要重启 Runtime，也不需要重新 trust**：值在每一次获取的 immediate 事务里重读；提高（或 `reset`）
  会为**每个项目**触发一次调度 pass，所以正等着容量的候选会立即有机会启动。
- **降低上限不抢占**：已持有槽位的 Task 不被暂停、不被释放、不被终止，所以 `used` 可以大于 `limit`，
  它只阻止后续获取（ADR-0061 D01）。
- FULL 与 STRICT 行为相同（是设置，不是审批）。它不影响 `scheduler reservations *` 的按项目查询与操作。

---

