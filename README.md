# Codeestra

Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。

## 当前状态

架构基线与八项用户决策已记录。已实现 **Phase 0 第一小步**：Bun workspace、严格 TypeScript、Vitest、不可变 TaskRevision、Execution 纯状态机及不变量测试。

这不是可运行的 AI 编排产品。尚无 Runtime 进程、数据库 migration、真实 Pi Adapter、Git 自动操作、桌面 UI 或集成流水线。RECOVERY_REQUIRED 和 Runtime shutdown 的完整处理也未实现，不能声称支持真实会话恢复。

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
nix shell nixpkgs#bun nixpkgs#nodejs_24
bun install --frozen-lockfile
bun run check
bun audit
```

或在已具备上述工具的环境直接执行后三条命令。`bun run check` 包含类型检查和 Vitest 单次运行，不启动监听服务器。当前 nixpkgs 没有仓库级 pin，精确可复现的 Nix devShell 是后续工程任务；项目依赖已由 `bun.lock` 固定。

## 当前代码

```text
packages/domain/
├── src/
│   ├── errors.ts
│   ├── task-revision.ts
│   ├── execution.ts
│   └── index.ts
└── test/
    ├── task-revision.test.ts
    └── execution.test.ts
```

Domain 不依赖 Bun、SQLite、Tauri 或 Agent SDK。函数只计算不可变状态，不启动/暂停进程。暂停/退出证据必须由后续应用层真实核验；传入布尔值的测试不证明真实 Agent 已停止写入。

## 下一步

先完成 Pi 当前版本协议与原生审批能力验证，并确认任务成果自动 commit 的授权/身份/hooks 策略，再进入 Phase 1 storage 与独立 Runtime 实现。后续阶段按 roadmap 推进，不同时搭建全部模块。
