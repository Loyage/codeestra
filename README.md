# Codeestra

Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。

## 第一原则（优先级最高）

1. **效率至上**：用户的等待时间与操作步数是第一优化目标；安全与隔离从属于此。权限管理（多用户、租户、密钥托管、路径沙箱、网络策略）**当前不作考虑**；已实现的门禁保留但不再新增（ADR-0008）。
2. **软件本体是服务，CLI 是完备命令面**：独立本地 Runtime 是本体；每个能力都能只靠 CLI 完成并可脚本化驱动。Web UI 只是方便交互的前端，走同一 versioned command/query/event 面与同一确认门禁，不新增语义、不绕过门禁。“只有 UI 能做”的能力视为缺陷。
3. **测试仅限 CLI/命令面**：自动化测试与验收只用 CLI 命令与 Runtime 命令面（含其 HTTP/SSE 传输）断言；不使用 computer-use / 桌面或键鼠自动化，不获取用户电脑控制权。产品内 Agent 也不新增屏幕/桌面控制工具。

完整表述见 [PROJECT_SPEC.md §1.1](PROJECT_SPEC.md) 与 [ADR-0008](docs/decisions/0008-efficiency-first-service-form.md)。分支与稳定提升规则见 [ADR-0009](docs/decisions/0009-main-dev-promotion-and-restart.md)。

## 分支与运行规则

项目长期保留两个分支：

- `main`：用户日常实际运行 Codeestra、进行开发辅助工作的稳定分支。
- `dev`：刚开发功能的实验与集成分支；所有功能任务从 `dev` 建基线，完成后先进入 `dev`，不得直接进入 `main`。

`dev → main` 必须由用户批准固定 dev/main SHA 与验证证据。`main` 更新后立即在 main 工作树执行 `bun run codeestra stop`，再执行 `bun run codeestra status` 重新拉起并检查 Runtime；重启成功前不得报告提升完成。详见 ADR-0009。

## 当前状态

架构基线与已确认决策已记录。已实现 Phase 0 领域基础、Phase 1 SQLite storage，以及最小 CLI/独立 Runtime：CLI 可自动启动后台 Runtime、显式信任项目，并按 Project ID 创建/列出/提交/运行 Task，以及对成果 commit 做两步确认。Task 创建会原子保存原始 Intent、首 Revision、事实事件与幂等回执；submit 使用 expected version 将 DRAFT 转为 READY；`task run` 串起 owned worktree、Execution 预留、Adapter start 与事件 pump；`task status` 可查看 Execution/Session 投影；`task result prepare`/`task result commit --confirm` 按 ADR-0003 在核验 HEAD/ChangeSet/静止证据后创建成果 commit。

这还不是完整的 AI 编排产品。尚无自动 Scheduler、长命令后台化、Task cancel/pause、revision 投递确认、桌面 UI，亦尚未实现“Task 从 dev 建基线 → 集成到 dev → 用户批准 dev→main → 自动重启 Runtime”的完整流水线。**现有 Phase 1 `task.run` 代码仍按项目 `mainRef` 创建 worktree；在 ADR-0009 的基线改造完成前，不得声称产品已自动遵守 dev 基线。**Pi 已有 LF-only RPC framing、受控启动参数、fail-closed gate extension 与自有子进程的 `PiRpcAdapter`（身份采集、attention/completion/disconnect 映射、typed answer 写入），Runtime 已接入 adapter registry、`task.run` 运行循环、事件 pump 与 answer 自动投递，并以 stub transport、deterministic fake 与脚本 Adapter 验证编排。Task verification（ADR-0006）已实现：命令来自 main ref 上人工维护的策略、trust 时一次性确认、在固定 commit 的 detached 副本中运行且证据不含原始输出。`events list`/`events tail` 提供只读事件订阅长连接，可观察既有 domain event 并按排他游标重连；但 `task run`/`task verify` 仍同步占用连接，长命令进度事件尚未实现。

本地 Web UI（ADR-0007）已可用：`codeestra ui` 在 `127.0.0.1` 上按需启动 HTTP + SSE（token 只存 Runtime 内存、经 0600 socket 下发、URL fragment 传递），React 界面可浏览/创建/提交任务、处理 Attention、运行任务、准备并确认成果 commit、执行验证，并实时查看事件流。UI 与 CLI 共用同一命令面与同一确认门禁，不新增绕过方式；UI 只是便利层，所有能力均可由 CLI 单独完成（ADR-0008）。真实 Pi 模型/工具执行已完成首轮受控验收（FOUNDATION-019，模型可用 `CODEESTRA_PI_PROVIDER`/`CODEESTRA_PI_MODEL` 显式指定）：真实 `write` 工具调用被 fail-closed gate 拦下并在界面上逐次审批，随后成果 commit 与 Task verification PASSED，用户 main 全程未被修改。任务取消超时、gate 拒绝路径、孤儿进程 reconcile 与 Integration/main 提升仍未实现；fake 不代表真实 Agent 集成通过。

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
just verify
```

可用命令通过 `just` 或 `just --list` 查看；其中 `just check` 包含类型检查、Vitest domain 测试和 Bun 原生 SQLite 测试，`just verify` 还会执行依赖漏洞检查。也可直接使用 `bun install --frozen-lockfile`、`bun run check` 和 `bun audit`。当前 nixpkgs 没有仓库级 pin，精确可复现的 Nix devShell 是后续工程任务；项目依赖已由 `bun.lock` 固定。

首次试运行可用临时数据目录（默认数据目录是 `$XDG_STATE_HOME/codeestra` 或 `~/.local/state/codeestra`）：

```sh
export CODEESTRA_HOME=/tmp/codeestra-demo
bun run codeestra status
bun run codeestra open .        # 在 Web UI 中打开当前仓库开发（inspect → 策略 → TRUST 确认 → 启动 UI 并预选该项目）
bun run codeestra ui            # 只打开本地 Web 界面（也可用 --no-open 只打印地址）
bun run codeestra project inspect /path/to/repo
bun run codeestra project trust /path/to/repo
bun run codeestra project list
bun run codeestra task create <project-id> "Implement one focused change"
bun run codeestra task list <project-id>
bun run codeestra task submit <project-id> <task-id> <expected-version>
bun run codeestra task run <project-id> <task-id> <expected-version> [--adapter pi]
bun run codeestra task status <project-id> <task-id>
bun run codeestra task result prepare <project-id> <task-id> [execution-id]
bun run codeestra task result commit <project-id> <task-id> <authorization-id> --confirm
bun run codeestra task verify <project-id> <task-id> [execution-id]
bun run codeestra task verification list <project-id> <task-id>
bun run codeestra attention list <project-id>
bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>]
bun run codeestra events tail [--project <project-id>] [--since <sequence>]
bun run codeestra stop
```

`project trust` 会展示固定仓库身份并要求输入 `TRUST`；`--yes` 仅用于明确的非交互确认。`task run` 默认使用 Pi，需本机 `pi` 可用（可用 `CODEESTRA_PI_EXECUTABLE`、`CODEESTRA_PI_GATE_EXTENSION`、`CODEESTRA_PI_SESSION_DIR` 覆盖）。该入口会真实启动 provider 进程；未通过技术准入前不要把它理解为已验收的真实 Agent 执行。

## 在本仓库上开发（自举）

本仓库自己也是一个 Codeestra 项目：`.codeestra/policies/verification.json` 是人工维护的 Task 验证策略（main ref 上读取，Task 分支无法改写判它的命令）。

```sh
bun run codeestra open . --yes --no-open   # 注册信任并打印带 token+project 的 UI 地址
bun run codeestra open .                   # 同上，并直接打开浏览器
```

模型/Provider 是 **Runtime 进程的环境变量**（`CODEESTRA_PI_PROVIDER` / `CODEESTRA_PI_MODEL`，默认走 Codex），所以切换模型要重启 Runtime：

```sh
bun run codeestra stop
CODEESTRA_PI_PROVIDER=deepseek CODEESTRA_PI_MODEL=deepseek-flash bun run codeestra open .
```

然后在界面上：创建草稿任务 → 提交 → `Run task…`（真实 Agent，敏感工具逐次审批）→ `Prepare result commit` → `Confirm result commit` → `Verify task`。

`open` 只在项目陌生、或 `.codeestra/policies/verification.json` 真的变了时才要求输入 TRUST；日常向 main 提交代码不会再要一次确认。

验证副本是固定 commit 的 `git worktree --detach`，**不含被 gitignore 的 `node_modules`**，所以策略的第一条命令是 `bun install --frozen-lockfile`（需要网络/缓存），第二条是 `bun run check`。

成果落在内部 `refs/heads/task/<task-id>` 上，**自动 Integration 阶段尚未实现**。如需人工回收，只能先在 `dev` 上合并并验证；不得直接合入 `main`：

```sh
git switch dev
git merge task/<task-id>     # 冲突与 dev 集成验证由你处理
```

后续 `dev → main` 仍必须由用户明确批准；main 更新后立即用 CLI `stop` + `status` 重启并检查 Runtime。

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
