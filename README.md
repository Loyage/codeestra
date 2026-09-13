# Codeestra

Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。

## 当前状态

架构基线与已确认决策已记录。已实现 Phase 0 领域基础、Phase 1 SQLite storage，以及最小 CLI/独立 Runtime：CLI 可自动启动后台 Runtime、显式信任项目，并按 Project ID 创建/列出/提交/运行 Task。Task 创建会原子保存原始 Intent、首 Revision、事实事件与幂等回执；submit 使用 expected version 将 DRAFT 转为 READY；`task run` 串起 owned worktree、Execution 预留、Adapter start 与事件 pump，`task status` 可查看 Execution/Session 投影。

这还不是完整的 AI 编排产品。尚无自动 Scheduler、Task cancel/pause、revision 投递确认、Git 自动成果 commit、Task verification、桌面 UI 或集成流水线。Pi 已有 LF-only RPC framing、受控启动参数、fail-closed gate extension 与自有子进程的 `PiRpcAdapter`（身份采集、attention/completion/disconnect 映射、typed answer 写入），Runtime 已接入 adapter registry、`task.run` 运行循环、事件 pump 与 answer 自动投递，并以 stub transport、deterministic fake 与脚本 Adapter 验证编排。真实 Pi 模型/工具执行、任务取消超时、孤儿进程 reconcile 与成果 commit 仍未实现；fake 不代表真实 Agent 集成通过。

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

首次 CLI 骨架可用临时数据目录试运行：

```sh
export CODEESTRA_HOME=/tmp/codeestra-demo
bun run codeestra status
bun run codeestra project inspect /path/to/repo
bun run codeestra project trust /path/to/repo
bun run codeestra project list
bun run codeestra task create <project-id> "Implement one focused change"
bun run codeestra task list <project-id>
bun run codeestra task submit <project-id> <task-id> <expected-version>
bun run codeestra task run <project-id> <task-id> <expected-version> [--adapter pi]
bun run codeestra task status <project-id> <task-id>
bun run codeestra attention list <project-id>
bun run codeestra stop
```

`project trust` 会展示固定仓库身份并要求输入 `TRUST`；`--yes` 仅用于明确的非交互确认。`task run` 默认使用 Pi，需本机 `pi` 可用（可用 `CODEESTRA_PI_EXECUTABLE`、`CODEESTRA_PI_GATE_EXTENSION`、`CODEESTRA_PI_SESSION_DIR` 覆盖）。该入口会真实启动 provider 进程；未通过技术准入前不要把它理解为已验收的真实 Agent 执行。

## 当前代码

```text
apps/
├── cli/                # 首个用户入口；自动连接/启动 Runtime
└── runtime/            # 本用户 Unix socket、项目接入、adapter registry 与运行循环
packages/
├── agent-adapters/     # 真实 Pi RPC Adapter 与 deterministic fake；fake 不代表真实集成
├── contracts/          # Zod IPC 边界与 Agent Adapter port（start/observe/answer/release）
├── domain/             # 纯 TypeScript revision / Execution 领域逻辑
├── git/                # Git 身份检查与固定基线 owned worktree prepare/reconcile
└── storage/            # Bun SQLite Phase 1 migration、事务与只读投影
```

Domain 不依赖 Bun、SQLite、Tauri 或 Agent SDK。函数只计算不可变状态，不启动/暂停进程。暂停/退出证据必须由后续应用层真实核验；传入布尔值的测试不证明真实 Agent 已停止写入。

## 下一步

下一纵向小步是 ADR-0003 的 ChangeSet 与一次性成果 commit 确认服务，随后是 Task verification 与 outbox 长连接。当前 IPC 单实例竞态、真实进程 identity reconcile、真实 Pi 工具执行/取消超时与完整崩溃恢复仍需补齐测试。
