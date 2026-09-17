# Codeestra

**目标：AI 的操作系统。** Codeestra 在宿主系统之上统一管理长期 Service、短期 Process、Agent、Signal、用户意图、Attention、调度与软件工程资源。内核 Service-first，Scheduler 仍 Task-first。

> **实现边界**：ADR-0070 S1–S4 已实现于 schema v37：通用 `service/process/signal/intent` CLI、持久 Signal 与兼容投影可用；原生 Process Agent、intention 解释、Project/Task 写路径切换与 Project Service 受管 integration 尚未实现。改造计划见 [Service Kernel Roadmap](docs/roadmap/mvp.md)。

## 第一原则（优先级最高）

1. **效率至上**：默认开启 `FULL` 主机级全权限模式；项目接入、Agent 工具、成果 commit 与验证策略变化均不确认。可用 CLI 无确认切换 `STRICT` 恢复旧门禁（ADR-0011）。
2. **软件本体是服务，CLI 是完备命令面**：独立本地 Runtime 是 0 号根 Service 与持久 Actor 内核的宿主；每个能力都能只靠 CLI 完成并可脚本化驱动。ADR-0067 起 Web UI 暂停，当前只启用 CLI/Unix socket 命令面。
3. **测试仅限 CLI/命令面**：自动化测试与验收只用 CLI 命令与 Runtime 命令面断言；不使用 computer-use / 桌面或键鼠自动化，不获取用户电脑控制权。产品内 Agent 也不新增屏幕/桌面控制工具。

完整表述见 [PROJECT_SPEC.md §1.1](PROJECT_SPEC.md)、[ADR-0008](docs/decisions/0008-efficiency-first-service-form.md)、[ADR-0011](docs/decisions/0011-default-full-permission-mode.md) 与 [ADR-0070](docs/decisions/0070-service-process-signal-kernel.md)。内核设计见 [Service / Process / Signal](docs/architecture/service-process-signal.md)。

**schema v38 提供受管 integration，但不提供发布与稳定提升**（[ADR-0074](docs/decisions/0074-managed-integration-ref-and-merge-queue.md)）：新 Task 以项目受管的 integration ref（`refs/codeestra/integration`）当时的 commit 为基线，成果经 `project integration request` / `run` 的合并、独立 Integration Verification 与 CAS 进入该 ref。**把它发布到你的 `main`/`release` 分支没有任何命令**，也不恢复旧 `promotion *`；Integration Process/Agent 仍未实现（冲突只报告、保留现场）。下面的 `main`/`dev` 流程仍只是本仓库自身约定。

## 分支与运行规则

本项目（Codeestra 自己）长期保留两个分支（**仓库约定**，产品不建模它）：

- `main`：可运行稳定实例的稳定分支（用户日常运行的就是它）。
- `dev`：新功能实验与集成分支。在 dev 工作树里建的 Task 以该任务所在项目受管的 integration ref 为基线（见 [ADR-0074](docs/decisions/0074-managed-integration-ref-and-merge-queue.md)）。“集成”在本仓库指人工把成果合回 `dev`。

`task/*`、`lane/*`、feature 与 Self Task candidate 分支在创建时按开发方向选定少量具体测试，只运行这些定向测试，不运行 `bun run check`、`just check`、`just verify` 或等价全仓检查。所有候选进入 `dev` 后，必须在准备 `dev → main` 前对精确 dev SHA 跑一次全量测试；候选变化后重跑。详见 ADR-0038。

`dev → main` 必须固定 dev 候选 SHA、预期 main SHA 与验证证据；`main` 更新后立即在 main 工作树执行 `bun run codeestra stop`，再执行 `bun run codeestra status` 重新拉起并检查 Runtime；重启成功前不得报告提升完成。完整的人工四步（含经远端 `dev` 中转）见 [`docs/agents/runbook.md`](docs/agents/runbook.md)。

### 本机工作树

这两个目录的拆分**只为 Codeestra 自身的开发（自进化）**：稳定实例跑在 main clone，Codeestra 自己的开发、集成与定向验证在 dev clone；用 Codeestra 开发别的项目不涉及这种拆分。

| 目录 | 分支 | 用途 |
|---|---|---|
| `~/Documents/codeestra` | `main` | 稳定工作树：只运行稳定实例、拉取已批准的提升 |
| `~/Documents/codeestra-dev` | `dev` | 开发工作树：Codeestra 自身的新功能实验与集成 |

两个工作树的 `node_modules` 与 `.codeestra/` 是各自的本地状态，互不共享；在 dev 工作树里首次使用要执行 `bun install --frozen-lockfile`。

**第二台及以后的机器（ADR-0075）**：只建 `dev` 工作树并检出 `dev`，只推 feature/task 分支；`dev` 的合入与 push 只在一台**稳定机**上发生，开发机不建 main 工作树、不跑稳定实例、不执行提升。开发机第一次建 workspace 前必须让本地 `dev` 与 `origin/dev` 完全一致（Task 基线会在 `project trust` 那一刻被物化且不再移动）。完整步骤与禁止项见 [`docs/agents/runbook.md`](docs/agents/runbook.md) §1。Web UI 源码虽保留，但默认流程不构建 `apps/ui/dist`。

**单实例注意**：Runtime 按 `CODEESTRA_HOME` 每用户只跑一个。在 dev 工作树运行 `bun run codeestra …` 时，如果稳定 Runtime 已在运行，命令会打到稳定 Runtime（即 `main` 代码），不会启动 dev 构建。要跑 dev 代码请换一个数据目录，例如：

```sh
CODEESTRA_HOME=/tmp/codeestra-dev bun run codeestra status
```

## 当前状态

截至 schema **v38**（ADR-0074）：架构基线、Phase 0 领域基础、SQLite storage、CLI/独立 Runtime，以及
**Task → 成果 commit → Task verification → merge queue → 独立 Integration Verification → 受管 integration ref**
的纵向流水线都已落地。产品侧的 IntegrationBatch → `dev` → `main` 提升与 dev clone **已按用户决策删除**
（ADR-0066），并未由 S8 恢复：受管集成的出口是项目私有的 `refs/codeestra/integration`，**发布到用户分支仍没有命令**。当前能力面：默认 FULL、项目接入与常态路径零确认；Task 从项目文件夹当前检出的分支建 owned worktree（ADR-0066），显式或自动调度（`task schedule *`，Runtime 全局并发上限默认 2）；长命令后台化与进度事件（`OperationProgressed`/`OperationSettled`、`task verify --background`、`task operation cancel`）；Task 暂停/取消/归档（ADR-0016）与失败后显式 `task retry`（可换 Agent，ADR-0036）；revision 投递台账与 `resolve`（ADR-0028）；三个真实 Adapter（Pi / Codex / Claude Code，ADR-0029/0040）；Project Knowledge 第一小步（ADR-0041）。**仍未实现**：Phase 7 Self Evolution。**Session Guidance 已实现**（FOUNDATION-088 / ADR-0057 / schema v31：`session guide` 与 `session guidance list|get`；记录后每个新 Execution 启动时带上它，且不产生 TaskRevision、不使验证失效；`DELIVERED` 只表示 provider 通道接收（入队），不等于模型已读）。**仍未验证**：真实 provider 的并发运行与 revision ACK、真实模型下的暂停/恢复、Claude Code 的模型层（本机无凭据）、themes 的显式路径加载。详见 [Roadmap](docs/roadmap/mvp.md) 与 [当前任务](docs/tasks/README.md) 的 `## NEXT`。

最小闭环的细节：默认 FULL——CLI 自动启动 Runtime、无确认注册项目，并按 Project ID 创建/列出/提交/运行 Task，成果 commit 可单步 capture；STRICT 保留旧的 trust 与两步 commit。Task 创建会原子保存原始 Intent、首 Revision、事实事件与幂等回执；submit 使用 expected version 将 DRAFT 转为 READY；`task run` 串起 owned worktree、Execution 预留、Adapter start 与事件 pump；`task status` 可查看 Execution/Session 投影；`task result prepare`/`task result commit --confirm` 按 ADR-0003 在核验 HEAD/ChangeSet/静止证据后创建成果 commit（FULL 下是单步 `task result capture`）。

Agent 配置（ADR-0012）已实现：`agent config get/set/clear` 持久化 provider/model/thinking level，分全局默认与每项目覆盖，按 环境变量 > 项目 > 全局 > Pi 默认 逐字段解析，只影响新 Session 并把生效值写入 Execution。

Agent 执行过程可见（ADR-0013）已实现：`task transcript` / `session transcript` / `session transcript part` 只读读取 Provider 自己的持久会话文件，展示工具调用与工具返回、助手文本、thinking 与 token/成本；默认截断展示并可按需取回完整内容。它**不是事件、不是 attach、不是终端接管**，不入库、不改动任何业务状态，也不新增确认。file 路径只在 Runtime 内部使用，客户端拿不到；只允许读取 Runtime 自己的 Pi session 目录（符号链接逃逸被拒绝）。token 级实时流仍未实现；原生 Pi TUI/PTY 接管已由 ADR-0026/FOUNDATION-046 实现（`session handoff attach/detach/release`），但 `session.transcript` 本身仍然只是只读日志视图，**不是 attach、不是终端接管**。

Agent 结构化提问（ADR-0014）已实现：受控启动额外加载 Codeestra 自己的 question 扩展，Agent 可用 `ask_user_question` 一次提 1–4 个带描述可选项的问题（可多选、可用自己的话回答）。**一份问卷 = 一个 provider dialog = 一条 `QUESTION` Attention = 一次 answer Operation**，回答以结构化 `QUESTIONNAIRE` 投递；Runtime 在记录前按被问的那份问卷校验，越界/重复/单选多选不符都返回 `INVALID_QUESTIONNAIRE_ANSWER:*` 并保持请求 OPEN，**绝不降级为“用户拒绝”或静默作废已答内容**（这正是第三方 TUI 问卷在 RPC 下的失败模式）。CLI 用 `attention answer … --choose/--text`。**“Agent 不用工具、在正文里提问并结束轮次”的形态已不再被无声记为 `SUCCESS`**：FOUNDATION-056 用稳定码 `PROSE_QUESTION_NO_TOOL_USE` 显式记录（启发式，宁可漏报），且已由 ADR-0043/FOUNDATION-069 默认升级为一等 `QUESTION` Attention + `WAITING_FOR_USER`，只由 `attention resolve --dismiss|--answer` 解除（回答**不投递**给 provider）；可用 `codeestra settings prose-question-attention record-only|off` 降级。**未验证**：真实 provider 下这一组合的行为，Codex 侧的事实层尚未实现（只漏报、不谎报）。

纵向流水线现在是：Task 从**项目受管的 integration ref** 建基线 → 成果 commit → Task verification → 入 merge queue →
独立 Integration Verification → CAS 推进该 ref（`project integration run`，ADR-0074）；**发布到你的分支仍由你决定，
产品没有命令**。本仓库自身的 `dev → main` 仍按
[`docs/agents/runbook.md`](docs/agents/runbook.md) 的人工四步执行过三次，那是仓库约定而不是产品能力。Pi 有 LF-only RPC framing、受控启动参数、fail-closed gate extension 与自有子进程的 `PiRpcAdapter`（身份采集、attention/completion/disconnect 映射、typed answer 写入），Runtime 已接入 adapter registry、`task.run` 运行循环、事件 pump 与 answer 自动投递；Codex 与 Claude Code 也已接入并如实声明能力（例如 Claude Code 模型层全部 `REQUIRES_VALIDATION`）。Task verification（ADR-0006/0011）与 ADR-0038/0039 的分支定向测试计划都已实现（「提升前全量证据」随
ADR-0066 一起删除；本仓库自身的全量测试纪律仍在 `AGENTS.md`）。`events list`/`events tail` 提供只读事件订阅长连接；`task run`/`task verify` 仍同步占用连接（可用 `--background` 与 `task operation *` 脱离），长命令进度事件已实现。

**仍未实现 / 未验收**（不得按「已有」使用）：真实 provider 的并发运行、revision ACK 与暂停/恢复复验；
Phase 7 Self Evolution。**Session Guidance 已实现**（FOUNDATION-088 / ADR-0057 / schema v31：`session guide` + `session guidance list|get`，`DELIVERED` 只表示 provider 通道接收（入队）而非模型已读，且不产生 TaskRevision），但它的**模型侧**仍未验证。Agent 的编排正确性由 stub transport、deterministic fake 与脚本 Adapter 覆盖，**不能替代真实 Agent 集成验收**。

**Web UI 已暂停**（ADR-0067）：`codeestra ui`、`codeestra open`、`runtime.ui`、`settings ui *` 与 `uiRunning` 已删除；Runtime 不启动 HTTP/SSE 前端，默认检查、构建、重启与发布也不处理 UI。`apps/ui`、HTTP 与 UI settings 实现源码仅静态保留，不代表功能可用或受支持；重新启用必须另立决策并恢复契约、测试与文档。当前所有操作请使用 CLI。

## 文档

- **[AI 的操作系统愿景](docs/vision/ai-operating-system.md)**：从 Chat/Agent 到分时 Service Kernel 的产品直觉，以及程序与 Agent 的统一边界。
- **[新开发者项目导览（HTML）](docs/project-introduction.html)**：可离线打开的中文介绍，涵盖愿景、原理、架构、进展与协作上手；基于 FOUNDATION-076 的文档快照，明确标注未实现 / 未验收边界。

- **[用户指南](docs/guides/README.md)**：面向使用者的中文指南——安装与第一次运行、领域概念、端到端流程、功能清单、完整 CLI 命令参考、常见故障与稳定码表。历史 UI 说明标记为暂停功能。

- **[真实 provider 验收 runbook](docs/notes/real-provider-acceptance-runbook.md)**：只能在真实 provider 在场时执行的功能验收操作手册（并发、暂停/恢复、修订投递、知识消费、插件与 gate、散文提问、原生终端、真实提升），附可复现脚手架 `scripts/real-provider-acceptance.sh`（默认 dry-run）。
- [PROJECT_SPEC.md](PROJECT_SPEC.md)：长期规格。
- [AGENTS.md](AGENTS.md)：协作与开发规则。
- [Architecture](docs/architecture/README.md)：领域、状态机、SQLite、事件、API、调度与模块设计；[Service Kernel](docs/architecture/service-process-signal.md) 是 ADR-0070 的目标内核说明。
- [Decisions](docs/decisions/README.md)：已接受 ADR 与分阶段待决项。
- [Roadmap](docs/roadmap/mvp.md) / [当前任务](docs/tasks/README.md)。

## 本地检查

已验证工具：Bun 1.3.13、Node 24.19.0（Vitest 测试宿主）、TypeScript 5.9.3、Vitest 5.0.0。产品 Runtime 仍采用 Bun；Node 仅为当前开发测试工具宿主。

使用 Nix 提供工具，无需全局 npm 安装：

```sh
nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just
just install
# 开发分支：运行建分支时选定的少量具体测试，例如：
bun test packages/domain/test/<相关测试>.test.ts
# 仅 dev→main 前，在 dev 的精确候选 SHA 上运行：
just verify
```

可用命令通过 `just` 或 `just --list` 查看。检查分层如下：

- 开发 branch/worktree：创建时按改动方向写下少量具体测试文件或窄命令，开发中和交付前只跑这些定向测试；范围扩大时同步扩大计划。禁止运行 `bun run check`、`just check`、`just verify` 或等价全仓检查。
- `just check-fast`：仍会聚合类型检查、Vitest 与快速 Bun 单测，不是“挑几个测试”的默认替代品；只有改动确实横跨其覆盖边界并在交付记录中说明理由时才使用。
- `just check` / `just verify`：全量 CLI/Runtime/packages 类型检查与测试（不含暂停的 Web UI）。只在长期 `dev` 上、准备 `dev → main` 前对精确候选 SHA 运行；候选、测试配置或锁文件变化后必须重跑。
- `just audit`：依赖漏洞检查需要网络且与本次代码改动无关，按需单独运行。

也可直接运行具体的 `bun test <test-file>` 等窄命令。当前 nixpkgs 没有仓库级 pin，精确可复现的 Nix devShell 是后续工程任务；项目依赖已由 `bun.lock` 固定。

首次试运行可用临时数据目录（默认数据目录是 `$XDG_STATE_HOME/codeestra` 或 `~/.local/state/codeestra`）：

```sh
export CODEESTRA_HOME=/tmp/codeestra-demo
bun run codeestra status
bun run codeestra settings permission get
bun run codeestra settings permission set strict   # 可选；默认是 full，切换无需确认
bun run codeestra agent config get                             # 当前生效的 provider/model/思考深度与来源
bun run codeestra agent config set --model <id> --thinking <level>
bun run codeestra agent config set --project <project-id> --model <id>
bun run codeestra agent config clear --project <project-id>
bun run codeestra project inspect /path/to/repo
bun run codeestra project trust /path/to/repo
bun run codeestra project list
bun run codeestra task create <project-id> "Implement one focused change" --title "Focused change" --name focused-change
bun run codeestra task list <project-id>
bun run codeestra task submit <project-id> <task-id> <expected-version>
bun run codeestra task run <project-id> <task-id> <expected-version> [--adapter pi]
bun run codeestra task status <project-id> <task-id>
bun run codeestra task transcript <project-id> <task-id> [--execution <id>] [--after <entry-id>] [--limit <n>] [--json]
bun run codeestra session transcript <session-id> [--after <entry-id>] [--limit <n>] [--json]
bun run codeestra session transcript part <session-id> <entry-id> <part-index>
bun run codeestra task result capture <project-id> <task-id> [execution-id] # FULL 单步
bun run codeestra task result prepare <project-id> <task-id> [execution-id] # STRICT
bun run codeestra task result commit <project-id> <task-id> <authorization-id> --confirm # STRICT
bun run codeestra task verify <project-id> <task-id> [execution-id]
bun run codeestra task verification list <project-id> <task-id>
bun run codeestra attention list <project-id>
bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no> | value <text> | cancel
bun run codeestra attention answer <project-id> <attention-id> [--choose <题>:<选项>[,<选项>]]… [--text <题>=<文本>]… [--cancel]
bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>]
bun run codeestra events tail [--project <project-id>] [--since <sequence>]
bun run codeestra stop
```

默认 FULL 下 `project trust` 不要求输入 `TRUST`；切到 STRICT 后恢复该确认，`--yes` 可用于严格模式的非交互确认。`task run` 默认使用 Pi，需本机 `pi` 可用（可用 `CODEESTRA_PI_EXECUTABLE`、`CODEESTRA_PI_GATE_EXTENSION`、`CODEESTRA_PI_QUESTION_EXTENSION`、`CODEESTRA_PI_SESSION_DIR` 覆盖）。该入口会真实启动 provider 进程；未通过技术准入前不要把它理解为已验收的真实 Agent 执行。

Agent 可以用 `ask_user_question` 工具一次提出 1–4 个带可选项的问题（ADR-0014）：整份问卷对应一条 `attention list` 里的 `QUESTION` 请求，用 `attention answer … --choose/--text` 回答；越界的选项号会被拒绝并保持请求 OPEN，不会被当成拒绝回答。提问只暂停自己的 Task，且不新增任何确认门禁。

## 在本仓库上开发（自举）

本仓库自己也是一个 Codeestra 项目：`.codeestra/policies/verification.json` 是人工维护的 Task 验证策略（main ref 上读取，Task 分支无法改写判它的命令）。

```sh
bun run codeestra project inspect .
bun run codeestra project trust .          # FULL 无确认；STRICT 可加 --yes
bun run codeestra project list              # 取得 project id
```

模型、Provider 与思考深度是**持久化配置**（ADR-0012），可以热切换，不需要重启 Runtime：

```sh
bun run codeestra agent config set --model deepseek-flash --thinking high   # 全局默认
bun run codeestra agent config get                                         # 查看生效值与来源
bun run codeestra agent config set --project <project-id> --model deepseek-pro   # 本项目覆盖
bun run codeestra agent config clear --project <project-id>                # 清除覆盖，回落全局
```

优先级是逐字段的 环境变量 > 项目覆盖 > 全局默认 > Pi 默认；`CODEESTRA_PI_PROVIDER` / `CODEESTRA_PI_MODEL` / `CODEESTRA_PI_THINKING` 仍可作一次性临时覆盖（只对该 Runtime 进程生效）。配置只影响此后新建的 Session，并在每次 Execution 上记录当时生效的值，可用 `task status` 查看。

然后用 CLI 创建草稿任务 → 提交 → `task run`（FULL 下工具自动允许）→ `task result capture` → `task verify`。STRICT 下恢复旧的 TRUST 与成果二次确认。

默认 FULL 下 `project trust` 与验证策略变化都不要求确认。

当前验证副本是固定 commit 的 `git worktree --detach`，且本仓库 `.codeestra/policies/verification.json` 仍固定执行 `bun install --frozen-lockfile` 与 `bun run check`。这套现有 Task verification 自动化**尚不符合 ADR-0038 的按分支定向选测要求**，因此不得把它误报为已实现新的测试分层；需要后续为 Task 记录定向测试计划/证据。

成果落在内部 `refs/heads/task/<task-id>` 上，**自动 Integration 阶段尚未实现**。如需人工回收，只能先在 `dev` 上合并并验证；不得直接合入 `main`：

```sh
git switch dev
git merge task/<task-id>     # 冲突与 dev 集成验证由你处理
```

后续 `dev → main` 在 FULL 下无需批准，STRICT 下保留批准；main 更新后仍立即用 CLI `stop` + `status` 重启并检查 Runtime。

## 当前代码

```text
apps/
├── cli/                # 当前唯一用户入口；自动连接/启动 Runtime
├── runtime/            # 本用户 Unix socket、项目接入、adapter registry 与运行循环
└── ui/                 # 已暂停的 React/Vite 源码；默认不构建、不测试、不发布
packages/
├── agent-adapters/     # 真实 Pi RPC Adapter 与 deterministic fake；fake 不代表真实集成
├── contracts/          # Zod IPC 边界与 Agent Adapter port（start/observe/answer/release）
├── domain/             # 纯 TypeScript revision / Execution 领域逻辑
├── git/                # Git 身份检查与固定基线 owned worktree prepare/reconcile
└── storage/            # Bun SQLite Phase 1 migration、事务与只读投影
```

Domain 不依赖 Bun、SQLite、Tauri 或 Agent SDK。函数只计算不可变状态，不启动/暂停进程。暂停/退出证据必须由后续应用层真实核验；传入布尔值的测试不证明真实 Agent 已停止写入。

## 下一步

当前开发集中在 CLI/Runtime 命令面；Web UI 继续暂停。下一主线已切换为 ADR-0070 的 Service Kernel 增量改造：S1 纯领域 contract → S2 additive storage → S3 Signal dispatcher → S4 内核 CLI，之后再接 Process、intention、Project/Task 写路径与受管 integration。权威依赖图、Agent 分工与验收见 [docs/roadmap/mvp.md](docs/roadmap/mvp.md)；既有真实 provider 验收缺口继续保留，但不应抢先破坏新内核 contract。
