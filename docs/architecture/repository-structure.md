# Repository / Module Structure

## 1. 目标边界

```text
apps/
  runtime/             # 独立本地进程、IPC、启动/关闭/恢复
  desktop/             # React/Vite/Tauri 客户端；关闭不影响 Runtime
packages/
  domain/              # 纯 TypeScript：值对象、revision、状态迁移、不变量
  contracts/           # Zod commands/events/ports；无供应商 SDK 类型
  storage/             # SQLite/Drizzle、migration、事务/outbox
  git/                 # Git CLI、workspace 与 integration 基础操作
  agent-adapters/      # fake / Pi，Phase 5 扩展
  verification/        # 验证执行、结果与证据
  test-support/        # 临时仓库、故障注入、fake adapter
  knowledge/           # Phase 6
  bootstrap/           # Phase 7，独立最小恢复程序
```

Scheduler、ExecutionCoordinator、IntegrationCoordinator 是 runtime 内不同模块，不拆成微服务。领域代码不导入 Bun、SQLite、Tauri、React 或具体 Agent SDK。基础设施通过 port 注入；Desktop 不直接写 SQLite 或执行 Git。

独立 Runtime 的本地 IPC 传输与认证在 Phase 1 技术验证后选型；默认不监听公网，不提前引入 HTTP 服务。用户批准的是独立 Runtime 生命周期，不是开放远程 API。

## 2. 当前实际创建范围

当前建立根 workspace、`packages/domain`、`packages/storage`、`packages/contracts`、`packages/git`、含 start-only fake 的 `packages/agent-adapters`，以及最小 `apps/cli` / `apps/runtime` 骨架。不提前创建 Desktop 或 bootstrap package，也不提供空函数冒充运行时。

根配置：`package.json`、`bun.lock`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`README.md`。工具使用 Nix 提供的 Bun；项目依赖在本地 workspace 安装，不全局安装 npm 工具。

Domain 第一批：
- immutable TaskRevision 创建及追加、版本冲突检查；
- Execution 状态迁移及终态保护；
- 类型检查、非法输入和不变量测试。

Storage 使用 Bun 原生 SQLite，包含 Phase 1 子集 migration、revision append-only trigger、活动资源/授权约束、CAS 与 command receipt。CLI/Runtime 提供版本化本用户 IPC、项目接入和 Task create/list/submit；应用服务以 Operation 包裹 owned worktree 与 Agent start，启动时保守处理未完成操作，并可原子预留 Execution。deterministic fake 已覆盖 Session 启动、Attention/completion observation、typed answer 投递/reconcile、provider event 去重、明确 pre-start/pre-delivery 失败与不确定副作用；真实 `PiRpcAdapter` 另外自有 `pi --mode rpc` 子进程、采集 provider 身份、映射 attention/completion/disconnect 与写入 typed answer；durable worker 提供按 eventId 幂等要求的至少一次 outbox 投递。Pi 子集另有 LF-only RPC framing、固定 allowlist 启动参数和 fail-closed gate；尚无自动 Scheduler、Runtime adapter registry/事件 pump、真实 Pi 进程恢复、pause/revision/stop control 或成果 commit 闭环。Drizzle 映射、完整 repository、真实进程 reconcile 和暂停证明尚未实现。Domain 纯函数接收的 evidence 是应用层提供的已验证事实，不能自证真实进程静止。

## 3. 依赖与测试边界

- domain：只使用 TypeScript 标准语言能力，无运行时第三方依赖。
- contracts：Zod 校验外部输入，再转换为 domain 的类型和值。
- storage/git/adapters：各自实现 ports，不能互相通过数据库表名或 CLI 字符串耦合。
- runtime：编排业务事务和事务外 Operation；不将 SQL 放入 domain。
- tests：domain 的纯函数用 Vitest；storage 用真实临时 SQLite；Git 用临时仓库；Adapter fake 和真实验证分别记录。

Phase 0 测试不要求真实 Agent 凭据，也不访问真实用户仓库。
