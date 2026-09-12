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

Phase 0 第一小步仅建立根 workspace 与 `packages/domain`。不提前创建没有实现的 app、Adapter 或 bootstrap package，也不提供空函数冒充运行时。

根配置：`package.json`、`bun.lock`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`README.md`。工具使用 Nix 提供的 Bun；项目依赖在本地 workspace 安装，不全局安装 npm 工具。

Domain 第一批：
- immutable TaskRevision 创建及追加、版本冲突检查；
- Execution 状态迁移及终态保护；
- 类型检查、非法输入和不变量测试。

此批不包含 Task 调度、持久化、进程控制或真实暂停证明。纯函数接收的 evidence 是应用层提供的已验证事实，不能自证真实进程静止。

## 3. 依赖与测试边界

- domain：只使用 TypeScript 标准语言能力，无运行时第三方依赖。
- contracts：Zod 校验外部输入，再转换为 domain 的类型和值。
- storage/git/adapters：各自实现 ports，不能互相通过数据库表名或 CLI 字符串耦合。
- runtime：编排业务事务和事务外 Operation；不将 SQL 放入 domain。
- tests：domain 的纯函数用 Vitest；storage 用真实临时 SQLite；Git 用临时仓库；Adapter fake 和真实验证分别记录。

Phase 0 测试不要求真实 Agent 凭据，也不访问真实用户仓库。
