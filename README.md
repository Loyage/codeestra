# Codeestra

Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。

## 第一原则（优先级最高）

1. **效率至上**：默认开启 `FULL` 主机级全权限模式；项目接入、Agent 工具、成果 commit、验证策略变化及未来稳定提升均不确认。可用 CLI 无确认切换 `STRICT` 恢复旧门禁（ADR-0011）。
2. **软件本体是服务，CLI 是完备命令面**：独立本地 Runtime 是本体；每个能力都能只靠 CLI 完成并可脚本化驱动。Web UI 只是方便交互的前端，走同一 versioned command/query/event 面与同一确认门禁，不新增语义、不绕过门禁。“只有 UI 能做”的能力视为缺陷。
3. **测试仅限 CLI/命令面**：自动化测试与验收只用 CLI 命令与 Runtime 命令面（含其 HTTP/SSE 传输）断言；不使用 computer-use / 桌面或键鼠自动化，不获取用户电脑控制权。产品内 Agent 也不新增屏幕/桌面控制工具。

完整表述见 [PROJECT_SPEC.md §1.1](PROJECT_SPEC.md)、[ADR-0008](docs/decisions/0008-efficiency-first-service-form.md) 与 [ADR-0011](docs/decisions/0011-default-full-permission-mode.md)。分支与稳定提升规则见 [ADR-0009](docs/decisions/0009-main-dev-promotion-and-restart.md)，分支测试分层见 [ADR-0038](docs/decisions/0038-branch-targeted-tests-and-dev-full-suite.md)；运行中 Agent 的原生终端接管设计见 [ADR-0010](docs/decisions/0010-live-agent-terminal-takeover.md)。

## 分支与运行规则

项目长期保留两个分支：

- `main`：用户日常实际运行 Codeestra、进行开发辅助工作的稳定分支。
- `dev`：刚开发功能的实验与集成分支；所有功能任务从 `dev` 建基线，完成后先进入 `dev`，不得直接进入 `main`。

`task/*`、`lane/*`、feature 与 Self Task candidate 分支在创建时按开发方向选定少量具体测试，只运行这些定向测试，不运行 `bun run check`、`just check`、`just verify` 或等价全仓检查。所有候选进入 `dev` 后，必须在准备 `dev → main` 前对精确 dev SHA 跑一次全量测试；候选变化后重跑。详见 ADR-0038。

`dev → main` 必须固定 dev/main SHA 与验证证据；默认 FULL 无需批准，STRICT 保留批准。`main` 更新后立即在 main 工作树执行 `bun run codeestra stop`，再执行 `bun run codeestra status` 重新拉起并检查 Runtime；重启成功前不得报告提升完成。详见 ADR-0009。

### 本机工作树

| 目录 | 分支 | 用途 |
|---|---|---|
| `~/Documents/codeestra` | `main` | 稳定工作树：日常运行 Runtime、用 Codeestra 辅助开发 |
| `~/Documents/codeestra-dev` | `dev` | 开发工作树：新功能实验与集成 |

两个工作树的 `node_modules`、`apps/ui/dist`、`.codeestra/` 是 gitignore 的本地状态，互不共享；在 dev 工作树里首次使用要执行 `bun install --frozen-lockfile`（`bun run check` 会顺带构建 UI 资产）。

**单实例注意**：Runtime 按 `CODEESTRA_HOME` 每用户只跑一个。在 dev 工作树运行 `bun run codeestra …` 时，如果稳定 Runtime 已在运行，命令会打到稳定 Runtime（即 `main` 代码），不会启动 dev 构建。要跑 dev 代码请换一个数据目录，例如：

```sh
CODEESTRA_HOME=/tmp/codeestra-dev bun run codeestra status
```

## 当前状态

架构基线与已确认决策已记录。已实现 Phase 0 领域基础、Phase 1 SQLite storage，以及最小 CLI/独立 Runtime。默认 FULL：CLI 自动启动 Runtime、无确认注册项目，并按 Project ID 创建/列出/提交/运行 Task，成果 commit 可单步 capture；STRICT 保留旧的 trust 与两步 commit。Task 创建会原子保存原始 Intent、首 Revision、事实事件与幂等回执；submit 使用 expected version 将 DRAFT 转为 READY；`task run` 串起 owned worktree、Execution 预留、Adapter start 与事件 pump；`task status` 可查看 Execution/Session 投影；`task result prepare`/`task result commit --confirm` 按 ADR-0003 在核验 HEAD/ChangeSet/静止证据后创建成果 commit。

Agent 配置（ADR-0012）已实现：`agent config get/set/clear`（CLI 与 Web UI 同一命令面）持久化 provider/model/thinking level，分全局默认与每项目覆盖，按 环境变量 > 项目 > 全局 > Pi 默认 逐字段解析，只影响新 Session 并把生效值写入 Execution。

Agent 执行过程可见（ADR-0013）已实现：`task transcript` / `session transcript` / `session transcript part` 只读读取 Provider 自己的持久会话文件，展示工具调用与工具返回、助手文本、thinking 与 token/成本；默认截断展示并可按需取回完整内容，运行中的 Session 由 Web UI 自动增量轮询。它**不是事件、不是 attach、不是终端接管**，不入库、不改动任何业务状态，也不新增确认。file 路径只在 Runtime 内部使用，客户端拿不到；只允许读取 Runtime 自己的 Pi session 目录（符号链接逃逸被拒绝）。token 级实时流（需新增事件与存储）与 ADR-0010 的原生终端接管仍未实现。

Agent 结构化提问（ADR-0014）已实现：受控启动额外加载 Codeestra 自己的 question 扩展，Agent 可用 `ask_user_question` 一次提 1–4 个带描述可选项的问题（可多选、可用自己的话回答）。**一份问卷 = 一个 provider dialog = 一条 `QUESTION` Attention = 一次 answer Operation**，回答以结构化 `QUESTIONNAIRE` 投递；Runtime 在记录前按被问的那份问卷校验，越界/重复/单选多选不符都返回 `INVALID_QUESTIONNAIRE_ANSWER:*` 并保持请求 OPEN，**绝不降级为“用户拒绝”或静默作废已答内容**（这正是第三方 TUI 问卷在 RPC 下的失败模式）。CLI 用 `attention answer … --choose/--text`，Web UI 用单选/多选 + 自由文本框。未实现：识别“Agent 不用工具、在正文里提问并结束轮次”的形态（仍会被记为 `SUCCESS`）。

这还不是完整的 AI 编排产品。尚无自动 Scheduler、长命令后台化、Task cancel/pause、revision 投递确认、桌面 UI，亦尚未实现“Task 从 dev 建基线 → 集成到 dev → 用户批准 dev→main → 自动重启 Runtime”的完整流水线。**现有 Phase 1 `task.run` 代码仍按项目 `mainRef` 创建 worktree；在 ADR-0009 的基线改造完成前，不得声称产品已自动遵守 dev 基线。**Pi 已有 LF-only RPC framing、受控启动参数、fail-closed gate extension 与自有子进程的 `PiRpcAdapter`（身份采集、attention/completion/disconnect 映射、typed answer 写入），Runtime 已接入 adapter registry、`task.run` 运行循环、事件 pump 与 answer 自动投递，并以 stub transport、deterministic fake 与脚本 Adapter 验证编排。Task verification（ADR-0006/0011）已实现：命令来自 main ref 上人工维护的策略，在固定 commit 的 detached 副本中运行且证据不含原始输出；FULL 下策略变化不确认，STRICT 下仍要求确认。`events list`/`events tail` 提供只读事件订阅长连接，可观察既有 domain event 并按排他游标重连；但 `task run`/`task verify` 仍同步占用连接，长命令进度事件尚未实现。

本地 Web UI（ADR-0007）已可用：`codeestra ui` 在 `127.0.0.1` 上按需启动 HTTP + SSE，React 界面可浏览/创建/提交任务、运行 Agent、capture 成果、执行验证、查看事件流与 **Agent 执行过程面板**。任务详情里的「Agent 执行过程」按 Execution 展示 Provider 会话文件的内容（工具调用/返回、助手文本、thinking、token 与成本），长内容折叠可展开，运行中自动刷新；数据经 `/api/command` 上的 `session.transcript`（与 CLI 同一命令面）获取。UI 显示当前权限模式；FULL 不显示 TRUST 输入或成果二次确认，STRICT 投影旧门禁。UI 与 CLI 共用同一命令面。真实 Pi 模型/工具执行已完成首轮受控验收（FOUNDATION-019，模型可用 `CODEESTRA_PI_PROVIDER`/`CODEESTRA_PI_MODEL` 显式指定）：真实 `write` 工具调用被 fail-closed gate 拦下并在界面上逐次审批，随后成果 commit 与 Task verification PASSED，用户 main 全程未被修改。任务取消超时、gate 拒绝路径、孤儿进程 reconcile 与 Integration/main 提升仍未实现；ADR-0010 设计的原生 Pi TUI/PTY 接管、Session Guidance 与 RPC↔TUI 安全点进程交接也尚未实现，当前只支持结构化 Attention 交互，不能把日志查看声称为终端 attach；fake 不代表真实 Agent 集成通过。

## 文档

- [PROJECT_SPEC.md](PROJECT_SPEC.md)：长期规格。
- [AGENTS.md](AGENTS.md)：协作与开发规则。
- [Architecture](docs/architecture/README.md)：领域、状态机、SQLite、事件、API、调度、冲突与模块设计。
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
- `just check` / `just verify`：全量类型检查、测试与 UI 构建。只在长期 `dev` 上、准备 `dev → main` 前对精确候选 SHA 运行；候选、测试配置或锁文件变化后必须重跑。
- `just audit`：依赖漏洞检查需要网络且与本次代码改动无关，按需单独运行。

也可直接运行具体的 `bun test <test-file>` 等窄命令。当前 nixpkgs 没有仓库级 pin，精确可复现的 Nix devShell 是后续工程任务；项目依赖已由 `bun.lock` 固定。

首次试运行可用临时数据目录（默认数据目录是 `$XDG_STATE_HOME/codeestra` 或 `~/.local/state/codeestra`）：

```sh
export CODEESTRA_HOME=/tmp/codeestra-demo
bun run codeestra status
bun run codeestra permission get
bun run codeestra permission set strict   # 可选；默认是 full，切换无需确认
bun run codeestra agent config get                             # 当前生效的 provider/model/思考深度与来源
bun run codeestra agent config set --model <id> --thinking <level>
bun run codeestra agent config set --project <project-id> --model <id>
bun run codeestra agent config clear --project <project-id>
bun run codeestra open .        # FULL：无确认注册并在 Web UI 中打开项目
bun run codeestra ui            # 只打开本地 Web 界面（也可用 --no-open 只打印地址）
bun run codeestra project inspect /path/to/repo
bun run codeestra project trust /path/to/repo
bun run codeestra project list
bun run codeestra task create <project-id> "Implement one focused change"
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
bun run codeestra task integrate <project-id> <task-id> <expected-version>
bun run codeestra task integration list <project-id> <task-id>
bun run codeestra attention list <project-id>
bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no> | value <text> | cancel
bun run codeestra attention answer <project-id> <attention-id> [--choose <题>:<选项>[,<选项>]]… [--text <题>=<文本>]… [--cancel]
bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>]
bun run codeestra events tail [--project <project-id>] [--since <sequence>]
bun run codeestra stop
```

默认 FULL 下 `project trust/open` 不要求输入 `TRUST`；切到 STRICT 后恢复该确认，`--yes` 可用于严格模式的非交互确认。`task run` 默认使用 Pi，需本机 `pi` 可用（可用 `CODEESTRA_PI_EXECUTABLE`、`CODEESTRA_PI_GATE_EXTENSION`、`CODEESTRA_PI_QUESTION_EXTENSION`、`CODEESTRA_PI_SESSION_DIR` 覆盖）。该入口会真实启动 provider 进程；未通过技术准入前不要把它理解为已验收的真实 Agent 执行。

Agent 可以用 `ask_user_question` 工具一次提出 1–4 个带可选项的问题（ADR-0014）：整份问卷对应一条 `attention list` 里的 `QUESTION` 请求，用 `attention answer … --choose/--text` 回答；越界的选项号会被拒绝并保持请求 OPEN，不会被当成拒绝回答。提问只暂停自己的 Task，且不新增任何确认门禁。

## 在本仓库上开发（自举）

本仓库自己也是一个 Codeestra 项目：`.codeestra/policies/verification.json` 是人工维护的 Task 验证策略（main ref 上读取，Task 分支无法改写判它的命令）。

```sh
bun run codeestra open . --no-open         # FULL 无确认注册并打印带 token+project 的 UI 地址
bun run codeestra open .                   # 同上，并直接打开浏览器
```

模型、Provider 与思考深度是**持久化配置**（ADR-0012），可以热切换，不需要重启 Runtime：

```sh
bun run codeestra agent config set --model deepseek-flash --thinking high   # 全局默认
bun run codeestra agent config get                                         # 查看生效值与来源
bun run codeestra agent config set --project <project-id> --model deepseek-pro   # 本项目覆盖
bun run codeestra agent config clear --project <project-id>                # 清除覆盖，回落全局
```

优先级是逐字段的 环境变量 > 项目覆盖 > 全局默认 > Pi 默认；`CODEESTRA_PI_PROVIDER` / `CODEESTRA_PI_MODEL` / `CODEESTRA_PI_THINKING` 仍可作一次性临时覆盖（只对该 Runtime 进程生效）。配置只影响此后新建的 Session，并在每次 Execution 上记录当时生效的值（Web UI 的 **Agent 配置** 标签页与 `task status` 都可查看）。

然后在界面上：创建草稿任务 → 提交 → `运行任务`（FULL 下工具自动允许）→ `提交成果` → `验证任务`。STRICT 下才显示旧的工具审批、TRUST 输入和成果二次确认。

默认 FULL 下 `open` 与验证策略变化都不要求确认。

当前验证副本是固定 commit 的 `git worktree --detach`，且本仓库 `.codeestra/policies/verification.json` 仍固定执行 `bun install --frozen-lockfile` 与 `bun run check`。这套现有 Task verification 自动化**尚不符合 ADR-0038 的按分支定向选测要求**，因此不得把它误报为已实现新的测试分层；需要后续为 Task 记录定向测试计划/证据，并为 promotion 增加精确 dev SHA 的独立全量证据。

成果落在内部 `refs/heads/task/<task-id>` 上，**自动 Integration 阶段尚未实现**。如需人工回收，只能先在 `dev` 上合并并验证；不得直接合入 `main`：

```sh
git switch dev
git merge task/<task-id>     # 冲突与 dev 集成验证由你处理
```

后续 `dev → main` 在 FULL 下无需批准，STRICT 下保留批准；main 更新后仍立即用 CLI `stop` + `status` 重启并检查 Runtime。

## 当前代码

```text
apps/
├── cli/                # 首个用户入口；自动连接/启动 Runtime，也可启动 Web UI
├── runtime/            # 本用户 Unix socket、HTTP/SSE、项目接入、adapter registry 与运行循环
└── ui/                 # React/Vite 本地 Web 界面；构建产物由 Runtime 托管
packages/
├── agent-adapters/     # 真实 Pi RPC Adapter 与 deterministic fake；fake 不代表真实集成
├── contracts/          # Zod IPC 边界与 Agent Adapter port（start/observe/answer/release）
├── domain/             # 纯 TypeScript revision / Execution 领域逻辑
├── git/                # Git 身份检查与固定基线 owned worktree prepare/reconcile
└── storage/            # Bun SQLite Phase 1 migration、事务与只读投影
```

Domain 不依赖 Bun、SQLite、Tauri 或 Agent SDK。函数只计算不可变状态，不启动/暂停进程。暂停/退出证据必须由后续应用层真实核验；传入布尔值的测试不证明真实 Agent 已停止写入。

## 下一步

本仓库已可用 `codeestra open` 在 Web UI 中打开开发（FOUNDATION-021）。下一纵向小步是 **Task cancel**：验收中已出现“失败后无变更的 Execution 永久卡在 RUNNING、`resource_held=1`”的真实卡死形态；随后是长命令后台化与进度事件、revision 投递确认。当前 IPC 单实例竞态、真实进程 identity reconcile、真实 Pi 工具执行/取消超时与完整崩溃恢复仍需补齐测试。
