# Codeestra

Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。

## 当前状态

架构基线与已确认决策已记录。已实现 Phase 0 领域基础、Phase 1 SQLite storage 第一小步，以及最小 CLI/独立 Runtime 骨架：CLI 可自动启动后台 Runtime、显式信任项目，并按 Project ID 创建、列出和提交 Task。Task 创建会原子保存原始 Intent、首 Revision、事实事件与幂等回执；submit 使用 expected version 将 DRAFT 转为 READY。

这还不是完整的 AI 编排产品。尚无自动 Scheduler、Runtime 侧真实 Pi 进程/事件 pump、pause/revision/stop control、Git 自动成果 commit、桌面 UI 或集成流水线。Runtime 已有 workspace/Execution/Agent start 协调、Adapter event 投影、typed Attention answer Operation/reconcile 与 durable outbox；Pi 已有 LF-only RPC framing、受控启动参数、fail-closed gate extension 与自有子进程的 `PiRpcAdapter`（身份采集、attention/completion/disconnect 映射、typed answer 写入），并以 stub transport + deterministic fake 验证编排。尚未实现 Runtime adapter registry/事件 pump、真实 Pi 进程恢复与成果 commit。尚未实现真实 Pi 进程生命周期，fake 不代表真实 Agent 集成通过。

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
bun run codeestra stop
```

`project trust` 会展示固定仓库身份并要求输入 `TRUST`；`--yes` 仅用于明确的非交互确认。当前不要把该入口理解为已能运行 Agent。

## 当前代码

```text
apps/
├── cli/                # 首个用户入口；自动连接/启动 Runtime
└── runtime/            # 本用户 Unix socket 与项目接入
packages/
├── agent-adapters/     # deterministic start-only fake；不代表真实集成
├── contracts/          # Zod IPC 边界与 start-only Adapter port
├── domain/             # 纯 TypeScript revision / Execution 领域逻辑
├── git/                # Git 身份检查与固定基线 owned worktree prepare
└── storage/            # Bun SQLite Phase 1 migration 与事务原语
```

Domain 不依赖 Bun、SQLite、Tauri 或 Agent SDK。函数只计算不可变状态，不启动/暂停进程。暂停/退出证据必须由后续应用层真实核验；传入布尔值的测试不证明真实 Agent 已停止写入。

## 下一步

下一纵向小步是 Pi 子进程 spawn、RPC pipe/event pump 与 provider process/session identity 持久化；随后实现成果 commit 一次性授权服务。当前 IPC 单实例竞态、真实进程 identity reconcile 与完整崩溃恢复仍需补齐测试。
