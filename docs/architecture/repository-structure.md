# Repository / Module Structure

## 1. 目标边界

```text
apps/
  runtime/             # 独立本地进程、IPC、启动/关闭/恢复
  cli/                 # 当前唯一用户入口；自动连接/启动 Runtime
  ui/                  # 暂停的 React/Vite 源码；默认不构建、不测试、不发布（ADR-0067）
  desktop/             # Tauri 客户端（尚未创建）；关闭不影响 Runtime
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

服务形态与入口分层（ADR-0008）：`apps/runtime` 是软件本体（服务）；`apps/cli` 是**完备、可脚本化**的权威命令面，必须能独立完成全部能力；`apps/ui` / 未来 `apps/desktop` 只是同一 versioned command/query/event 面的便利前端，不新增业务语义、不绕过任何确认。新增能力先问“CLI 是否完备”，UI 变化不得领先于 CLI 能力。

独立 Runtime 的本地 IPC 传输与认证在 Phase 1 技术验证后选型；默认不监听公网，不提前引入 HTTP 服务。用户批准的是独立 Runtime 生命周期，不是开放远程 API。

## 2. 当前实际创建范围

当前建立根 workspace、`packages/domain`、`packages/storage`、`packages/contracts`、`packages/git`、含 start-only fake 的 `packages/agent-adapters`，以及最小 `apps/cli` / `apps/runtime` 骨架。不提前创建 Desktop 或 bootstrap package，也不提供空函数冒充运行时。

根配置：`package.json`、`bun.lock`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`README.md`。工具使用 Nix 提供的 Bun；项目依赖在本地 workspace 安装，不全局安装 npm 工具。

Domain 第一批：
- immutable TaskRevision 创建及追加、版本冲突检查；
- Execution 状态迁移及终态保护；
- 类型检查、非法输入和不变量测试。

Storage 使用 Bun 原生 SQLite，包含 Phase 1 子集 migration、revision append-only trigger、活动资源/授权约束、CAS 与 command receipt。CLI/Runtime 提供版本化本用户 IPC、项目接入和 Task create/list/submit；应用服务以 Operation 包裹 owned worktree 与 Agent start，启动时保守处理未完成操作，并可原子预留 Execution。deterministic fake 已覆盖 Session 启动、Attention/completion observation、typed answer 投递/reconcile、provider event 去重、明确 pre-start/pre-delivery 失败与不确定副作用；真实 `PiRpcAdapter` 另外自有 `pi --mode rpc` 子进程、采集 provider 身份、映射 attention/completion/disconnect 与写入 typed answer；durable worker 提供按 eventId 幂等要求的至少一次 outbox 投递；`EventSubscriptionHub` 在同一 socket 上提供只读长连接订阅（`events.subscribe` / `events.list`），按排他 sequence 游标交付既有事件并在断开后凭 cursor 重连；同一 Hub 也以 SSE 形式供本地 Web UI 使用（`RuntimeHttpApi`，只绑 127.0.0.1、内存 token、与 CLI 共用同一 dispatch）。Pi 子集另有 LF-only RPC framing、按权限模式选择的受控启动参数（FULL 无工具 allowlist 且 `--approve`，STRICT 保留 allowlist 与 fail-closed gate）；尚无自动 Scheduler、真实 Pi 工具执行与取消超时验收、pause/revision 投递以及 Integration/main 提升。Drizzle 映射、完整 repository、真实进程 reconcile 和暂停证明尚未实现。Domain 纯函数接收的 evidence 是应用层提供的已验证事实，不能自证真实进程静止。

## 3. 依赖与测试边界

- domain：只使用 TypeScript 标准语言能力，无运行时第三方依赖。
- contracts：Zod 校验外部输入，再转换为 domain 的类型和值。
- storage/git/adapters：各自实现 ports，不能互相通过数据库表名或 CLI 字符串耦合。
- runtime：编排业务事务和事务外 Operation；不将 SQL 放入 domain。
- tests：domain 的纯函数用 Vitest；storage 用真实临时 SQLite；Git 用临时仓库；Adapter fake 和真实验证分别记录。

测试边界（ADR-0008）：自动化测试与验收只通过 CLI 命令与 Runtime 命令面（含其 HTTP/SSE 传输）驱动断言；不使用 computer-use、OS 级键鼠/窗口自动化、桌面应用操作或真实桌面会话。UI 验证用 headless 命令面/HTTP 断言加用户在场时的人工确认。代码库不得引入这类依赖或脚本。

测试分层（ADR-0038）：创建 task/lane/feature/Self candidate branch/worktree 时，按计划改动的模块与不变量选择少量具体测试；开发分支不运行 `bun run check`、`just check`、`just verify` 或等价全仓检查。全量测试只在长期 `dev` 上对精确候选 SHA 运行，并作为 `dev → main` 的必备证据；候选或测试输入变化后必须重跑。当前 Task verification 的固定项目策略与 promotion 的证据结构尚未自动表达该分层，这是明确实现缺口。

Phase 0 测试不要求真实 Agent 凭据，也不访问真实用户仓库。
