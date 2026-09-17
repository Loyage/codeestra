# CLI 命令参考（索引）

> **适用版本** ADR-0070 S1–S4（2026-09-17） · **schema** v37 · **最后校对** 2026-09-17
> 当前适用版本以 [docs/tasks/README.md](../tasks/README.md) 的最新记录为准。
> 权限模式的命令拼写由 FOUNDATION-098 同步为 `settings permission get|set`（ADR-0064：顶层 `permission` 已移除；§19 另新增 `settings list` 总览）。
> **本次修订（ADR-0067）**：索引标明 `ui` / `open` 已删除；正文以 [`cli/runtime.md`](./cli/runtime.md) 为准。
> **本次修订（ADR-0068）**：新增 §22 `help` 与 `runtime commands`（命令树自描述）与 §2 的 `agent plugins` 一节；
> 用法错误的输出从整份 `usage()` 清单改为一行（旧长文本完整搬进命令树，仍由 `help` 打印）。
> **本次修订（ADR-0066 / schema v36）**：`promotion` 一篇（§15）与 `task integrate`/`task integration`（§11）随集成与
> 提升一起删除，因此拆分后的篇数由九篇变为**八篇**。
> 拆分说明（ADR-0063）：原来这一篇 1322 行的参考按功能拆分；ADR-0070 S4 新增 Service Kernel 参考，现在 [`cli/`](./cli/README.md) 下共九篇。
> 正文逐行搬移、一句未改；本次**未重新核对源码**，所以最后校对日期不变，逐节的校对注随各节搬到对应文件。

本文件不再是命令参考正文，而是**唯一保留的对照表**：给出「旧 §N → 现在在哪一篇」。
历史记录里写的「`cli-reference.md` §N」（`docs/decisions/**`、`docs/tasks/README.md` 等处）都能在这里
查到落点；各篇内部**沿用拆分前的章节号**，所以查到文件后按 `§N` 检索即可。

从这里开始读：[`cli/README.md`](./cli/README.md)（九篇索引 + §0 通用约定）。

## 旧 §N → 现在在哪一篇

| 旧章节 | 现在在 |
|---|---|
| §0 通用约定（连接 / 自动启动 / 退出码 / 环境变量） | [cli/README.md](./cli/README.md) |
| §1 Runtime 生命周期（`status`/`stop`；`ui`/`open` 已由 ADR-0067 删除；权限模式已移入 §19） | [cli/runtime.md](./cli/runtime.md) |
| §2 `agent config`、`agent plugins` | [cli/runtime.md](./cli/runtime.md) |
| ADR-0070 S4 `service` / `process` / `signal` / `intent`（无旧 §N） | [cli/kernel.md](./cli/kernel.md) |
| §3 `project`（含 `project impact *`、`project knowledge *`） | [cli/project.md](./cli/project.md) |
| §4 `task`：生命周期（`create` 到 `purge`/`status`）与 `--feature` | [cli/task-lifecycle.md](./cli/task-lifecycle.md) |
| §5 `task revision` 与投递 | [cli/task-revision-session.md](./cli/task-revision-session.md) |
| §6 `task transcript` / `session transcript` | [cli/task-revision-session.md](./cli/task-revision-session.md) |
| §6.1 `session guide` / `session guidance` | [cli/task-revision-session.md](./cli/task-revision-session.md) |
| §7 `session handoff`（原生终端接管） | [cli/task-revision-session.md](./cli/task-revision-session.md) |
| §8 `task result`（成果 commit） | [cli/task-result-verify.md](./cli/task-result-verify.md) |
| §9 `task verify` / `task verification` / `task tests` | [cli/task-result-verify.md](./cli/task-result-verify.md) |
| §10 `task operation`（长命令） | [cli/task-result-verify.md](./cli/task-result-verify.md) |
| §11 `task integrate` / `task integration`（IntegrationBatch） | **ADR-0066 已删除**；说明见 [cli/integration-dag-scheduler.md](./cli/integration-dag-scheduler.md) §11 |
| §12 `task depends`（DAG） | [cli/integration-dag-scheduler.md](./cli/integration-dag-scheduler.md) |
| §13 `task schedule`（调度引擎） | [cli/integration-dag-scheduler.md](./cli/integration-dag-scheduler.md) |
| §14 `scheduler`（容量与槽位预留） | [cli/integration-dag-scheduler.md](./cli/integration-dag-scheduler.md) |
| §15 `promotion`（稳定提升） | **ADR-0066 已删除**（原 `cli/promotion.md` 一并删除） |
| §16 `reclaim`（资源回收） | [cli/integration-dag-scheduler.md](./cli/integration-dag-scheduler.md) |
| §17 `events`（订阅） | [cli/interface.md](./cli/interface.md) |
| §22 `help` / `runtime commands`（自描述，ADR-0068；拆分后新增的章节号） | [cli/runtime.md](./cli/runtime.md) |
| §18 `attention` | [cli/interface.md](./cli/interface.md) |
| §19 `settings`（含 `settings permission`、`settings list`） | [cli/runtime.md](./cli/runtime.md) |
| §20 HTTP / SSE 面（Web UI 用） | [cli/interface.md](./cli/interface.md) |
| §21 其他只在源码里出现的东西 | [cli/interface.md](./cli/interface.md) |
| 相关阅读 | [cli/README.md](./cli/README.md) |

## 为什么拆

- 原先一篇 1322 行，而章节号已经到 §21：查一条命令要在一整篇里滚动，而「`task` 生命周期」与
  「已删除的 `promotion`」之间没有任何关系。
- 拆分后每篇 92–302 行，按**你正在做的事**归类；章节号不动，所以既有的 §N 引用与各篇内部的
  `§N` 交叉引用（如 §4 提到 §7）仍然对得上。
- 结构性理由与决策记录：[ADR-0063](../decisions/0063-split-cli-reference-by-command-group.md)。
