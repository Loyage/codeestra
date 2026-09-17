# Repository / Module Structure

> 层级：L1 · 体量 ≈ 4k 字符 · **何时读**：不确定代码放哪、依赖能不能这么引、测试该用什么形态 · 权威来源：仓库实际目录与 `package.json`；本文只解释边界。

## 1. 目标边界

```text
apps/
  runtime/             # 独立本地进程、IPC、启动/关闭/恢复
  cli/                 # 当前唯一用户入口；自动连接/启动 Runtime
  ui/                  # 暂停的 React/Vite 源码；默认不构建、不测试、不发布（ADR-0067）
  desktop/             # Tauri 客户端（尚未创建）；关闭不影响 Runtime
packages/
  domain/              # 纯 TypeScript：Service/Signal/Process、Task revision、状态迁移、不变量
  contracts/           # Zod commands/events/Service contracts/ports；无供应商 SDK 类型
  storage/             # SQLite/Drizzle、migration、Service state、Signal inbox/outbox、事务
  git/                 # Git CLI、workspace 与 integration 基础操作
  agent-adapters/      # fake / Pi，Phase 5 扩展
  verification/        # 验证执行、结果与证据
  test-support/        # 临时仓库、故障注入、fake adapter
  knowledge/           # Phase 6
  bootstrap/           # Phase 7，独立最小恢复程序
```

ServiceRegistry、SignalDispatcher、Scheduler、ProcessCoordinator 与 IntegrationCoordinator 都是同一 Runtime 内的模块，不拆成微服务，也不让每个 Service 启一个 OS 进程。领域代码不导入 Bun、SQLite、Tauri、React 或具体 Agent SDK。基础设施通过 port 注入；客户端不直接写 SQLite 或执行 Git。

服务形态与入口分层（ADR-0008/0070）：`apps/runtime` 是 0 号 Service 与持久 Actor 内核的宿主；`apps/cli` 是**完备、可脚本化**的权威命令面。目标新增 `service/process/signal/intent` 内核 facade，同时保留现有业务命令。`apps/ui` / 未来 `apps/desktop` 只能是同一 versioned command/query/event 面的便利前端，不新增业务语义。

独立 Runtime 的本地 IPC 传输与认证在 Phase 1 技术验证后选型；默认不监听公网，不提前引入 HTTP 服务。用户批准的是独立 Runtime 生命周期，不是开放远程 API。

## 2. 当前实际创建范围

```text
apps/runtime/src/     # 40+ 个服务模块：schedule/capacity/runtime-control/slot-reservation、
                      # agent-{start,answer,observation,config,plugin-detection,runtime}、
                      # session-{guidance,handoff,transcript}、terminal、workspace、task-{baseline,control,purge,recovery}、
                      # verification、revision-delivery、impact-analysis、knowledge、reclaim、result-commit、
                      # service-kernel、event-{delivery,subscription}、operation、lifecycle、main
apps/cli/src/         # 命令面（含 usage）
apps/ui/              # 暂停的 React/Vite 源码（ADR-0067）；默认不构建、不测试、不发布
packages/domain/      # 纯领域：TaskRevision 追加与版本冲突校验、状态迁移与终态保护、DAG 环校验、影响分析纯函数
packages/contracts/   # Zod commands/events/Service contracts/ports + Adapter 端口与能力位
packages/storage/     # Bun 原生 SQLite、migration.ts（v1–v37）、append-only 触发器、CAS、command receipt、Service/Signal store
packages/git/         # Git CLI 封装：worktree prepare/inspect/capture/reconcile/release、ref 读取、回收与 purge
packages/agent-adapters/ # deterministic fake、PiRpcAdapter、CodexAdapter、ClaudeAdapter、PTY host helper
```

根配置：`package.json`、`bun.lock`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`README.md`、`Justfile`、`docs/`。工具链用 Nix 提供的 Bun；依赖装在工作区本地，不装全局 npm 工具。

**已实现并接入 Runtime**：workspace prepare/reconcile、Agent start 与 observation、typed answer 与持久投递、真实 Pi/Codex/Claude adapter、成果 commit（FULL 单步 / STRICT prepare+confirm）、任务级验证与隔离副本、事件长连接订阅（`events.list` / `events.subscribe`）、自动调度（事件驱动 + 周期恢复 pass）、槽位预留与 reconcile、Runtime 全局容量与全局暂停/恢复屏障、Task 暂停/取消/归档/重试/恢复/purge、revision 投递、Session guidance、终端接管与 PTY、知识快照与绑定、项目知识/影响/验证策略读取、Service kernel 与 Signal dispatcher。

**仍未实现或未验收**：原生 Agent-supervising Process 控制面（S5）、intention/Attention 路由（S6）、Project/Task Service 单一写路径（S7）、受管 integration / merge queue（S8）、eligibility 解耦（S9）；Self Evolution 与 bootstrap；真实 provider 的并发运行与取消超时、跨交接权限矩阵、Windows。Drizzle 映射与完整 repository 层尚未实现（当前是手写 SQL + Zod 边界校验）。

**没有的入口**：HTTP/SSE 与本地 Web UI 入口（ADR-0067，源码保留但 Runtime 不实例化 `RuntimeHttpApi`）；桌面客户端尚未创建。

## 3. 依赖与测试边界

- domain：只使用 TypeScript 标准语言能力，无运行时第三方依赖。
- contracts：Zod 校验外部输入，再转换为 domain 的类型和值。
- storage/git/adapters：各自实现 ports，不能互相通过数据库表名或 CLI 字符串耦合。
- runtime：编排业务事务和事务外 Operation；不将 SQL 放入 domain。
- tests：domain 的纯函数用 Vitest；storage 用真实临时 SQLite；Git 用临时仓库；Adapter fake 和真实验证分别记录。

测试边界（ADR-0008）：自动化测试与验收**只**通过 CLI 命令与 Runtime 命令面驱动断言，不用 computer-use、OS 级键鼠/窗口自动化、桌面应用操作或真实桌面会话；UI 验证改用 headless 命令面断言加用户在场时的人工确认。代码库不得引入这类依赖或脚本。测试使用临时仓库与临时 SQLite，**不用真实用户仓库做破坏性测试**；Domain 纯函数接收的 evidence 是应用层提供的已验证事实，不能自证真实进程静止。

测试分层（ADR-0038）：创建 task/lane/feature/Self candidate branch/worktree 时，按计划改动的模块与不变量选择少量具体测试；开发分支**不**运行 `bun run check`、`just check`、`just verify` 或等价全仓检查。全量测试只在长期 `dev` 上对精确候选 SHA 运行，并作为 `dev → main` 的必备证据；候选或测试输入变化后必须重跑。

Phase 0 测试不要求真实 Agent 凭据，也不访问真实用户仓库。
