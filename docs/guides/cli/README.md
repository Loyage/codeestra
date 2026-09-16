# CLI 命令参考

> **适用版本** `dev@de03448`（2026-09-16） · **schema** v34 · **最后校对** 2026-09-16
> 版本会前进：`dev@de03448` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一，
> **内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码**，最后校对日期因此不变。
> 唯一未搬移的一行是原文件头部的第 17 行——它与第 6 行是同一句（只有句末标点不同），只保留了一份。
> §14 新增 `scheduler control` 一节，并把 §0.2 的退出码与「等待码」表补上 `SCHEDULER_GLOBALLY_PAUSED`（FOUNDATION-097 / ADR-0061 D08/D09）；
> §0.1 的人读视图清单新增 `settings list`（§19），索引表里 §1 不再含 `permission`（ADR-0064 / 用户任务）。
> 本文件既是**这套参考的入口**（九篇索引），也是原来那篇的 §0 通用约定（连接、自动启动、退出码、环境变量）。
> 旧编号（§1–§21）到新文件的对照表在 [`../cli-reference.md`](../cli-reference.md)；各篇内部沿用拆分前的章节号。

本文覆盖 `apps/cli/src/main.ts` 中 `usage()` 列出的**每一个命令组**，以及 Runtime 的 HTTP/SSE 面。
所有事实来自源码核对；核对方法见 `docs/tasks/README.md` 的 FOUNDATION-070 一节。

调用形式统一是：

```sh
bun run codeestra <group> [<action>] [<argument>…] [--flag …]
```

（`bun run codeestra` 对应 `package.json` 的 `"codeestra": "bun run apps/cli/src/main.ts"`。）

## 九篇索引

| 文件 | 覆盖章节 |
|---|---|
| **README.md**（本文件） | §0 通用约定（连接 / 自动启动 / 退出码 / 环境变量） |
| [runtime.md](./runtime.md) | §1 Runtime 生命周期（`status`/`stop`/`ui`/`open`）、§2 `agent config`、§19 `settings`（含权限模式） |
| [project.md](./project.md) | §3 `project`（`inspect`/`policy`/`trust`/`list`、`project impact *`、`project knowledge *`） |
| [task-lifecycle.md](./task-lifecycle.md) | §4 `task` 生命周期（`create` 到 `purge`/`status`）与 `--feature` |
| [task-revision-session.md](./task-revision-session.md) | §5 `task revision` 与投递、§6 `task transcript`/`session transcript`、§6.1 `session guide`、§7 `session handoff` |
| [task-result-verify.md](./task-result-verify.md) | §8 `task result`、§9 `task verify`/`task verification`/`task tests`、§10 `task operation` |
| [integration-dag-scheduler.md](./integration-dag-scheduler.md) | §11 `task integrate`/`task integration`、§12 `task depends`、§13 `task schedule`、§14 `scheduler`、§16 `reclaim` |
| [promotion.md](./promotion.md) | §15 `promotion`（含 `full-suite`） |
| [interface.md](./interface.md) | §17 `events`、§18 `attention`、§20 HTTP/SSE 面、§21 其他只在源码里出现的东西 |

旧引用（例如其他地方写的「`cli-reference.md` §14」）在 [`../cli-reference.md`](../cli-reference.md)
的对照表里查到落点文件后，按 `§14` 在该文件内检索即可。

---

## 0. 通用约定

### 0.1 连接与自动启动

- CLI 通过 `CODEESTRA_HOME`（默认 `$XDG_STATE_HOME/codeestra` 或 `~/.local/state/codeestra`）下的
  Unix socket `runtime.sock` 与 Runtime 通信。
- 除 `stop` 外，**任何命令都会在需要时自动拉起 Runtime**（先 `runtime.ping`，超时后 spawn 并以 50ms 间隔最多探测 50 次）。
  `stop` 刻意**不**启动它要停的东西。
- 输出是 JSON（`JSON.stringify(value, null, 2)`）。人读视图只存在于少数命令的**默认**（非 `--json`）分支：
  `project impact validate/show/explain`、`project knowledge *`、`task depends list`、`task transcript`、
  `session transcript`、`task operation list/get`、`promotion promote`、`settings list`。
- 其余命令默认就是 JSON，`--json` 的作用是**让脚本声明意图**而不是改变输出。
- 错误写到 stderr，形如 `CODE: message`；带事实的拒绝（例如 `SNAPSHOT_STALE`）会先打印一段 JSON 再退 1。

### 0.2 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功。注意：某些命令的成功是「已受理」而不是「已完成」（见各命令说明） |
| `1` | 拒绝或失败（含 `RECOVERY_REQUIRED` 这类需要人处理的状态） |
| `2` | **用法错误**：参数个数/取值不合法、未知 flag、缺少必填 flag（`usage()` 与个别显式 `process.exit(2)`） |
| `3` | **等待**（调度冲突/容量等待、Runtime 全局暂停 `SCHEDULER_GLOBALLY_PAUSED`、draining、`promotion promote` 的「已推送、等待拉取」）或**没什么可做**（reclaim 计划/执行没有可回收项） |

`3` 从不表示 `BLOCKED`：`BLOCKED` 只表示**依赖未满足**，它属于「需要处理」而不是「等一等」。
`3` 也从不表示「部分冻结」：`scheduler control pause` 只有收口成完整 `PAUSED`（或已幂等处于目标状态）才退 `0`，
任何目标不可核验都退 `1` 并给出稳定码——见 §14。
`3` 也从不表示「已完成」：提升在「已推送、等待拉取」时退 `3`，该状态下没有任何重启记账。

### 0.3 环境变量

| 变量 | 作用 |
|---|---|
| `CODEESTRA_HOME` | Runtime 数据目录（决定单实例身份与 socket 位置） |
| `CODEESTRA_UI_DIST` | 覆盖 Web UI 资产目录（默认 `apps/ui/dist`） |
| `CODEESTRA_SCHEDULE_TICK_MS` | 周期调度 pass 间隔，默认 `5000` |
| `CODEESTRA_PI_EXECUTABLE` / `CODEESTRA_PI_GATE_EXTENSION` / `CODEESTRA_PI_QUESTION_EXTENSION` / `CODEESTRA_PI_SESSION_DIR` / `CODEESTRA_PI_PLATFORM` | Pi Adapter 的可执行文件、gate/question 扩展、会话目录、平台 |
| `CODEESTRA_CODEX_EXECUTABLE` / `CODEESTRA_CODEX_HOME` / `CODEESTRA_CODEX_REQUEST_USER_INPUT` | Codex Adapter |
| `CODEESTRA_CLAUDE_EXECUTABLE` | Claude Adapter |
| `CODEESTRA_PI_PROVIDER` / `CODEESTRA_PI_MODEL` / `CODEESTRA_PI_THINKING`（以及 Codex/Claude 对应变量） | Agent 配置的**逐字段最高优先级**临时覆盖（只对该 Runtime 进程生效） |

`CODEESTRA_PERMISSION_MODE` 不是用户输入：它由 Runtime 在**启动 provider / 终端时自己写入**，用来把当前权限模式传给受控 gate；用户切换模式请用 `settings permission set`。

`runtime.ping` 返回的 `adapters` 会列出已注册的 Adapter ID：当前是 `pi`、`codex`、`claude`。

---

## 相关阅读

- 端到端流程与预期输出形状：[workflow.md](../workflow.md)
- 界面：[ui.md](../ui.md)
- 稳定错误码与排障：[troubleshooting.md](../troubleshooting.md)
