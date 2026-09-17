# Codeestra Architecture

状态：Runtime 架构已实现到 schema v37；ADR-0068 S1–S4 的 Service / Process / Signal 内核、持久 dispatcher 与 CLI 已实现，S5–S10 仍是目标。本文同时标注“当前事实”与“目标架构”，不得把后续能力当成当前能力。

## 总体架构

```text
CLI（当前唯一客户端；可断开与重连）
        │ versioned commands / queries / events
独立本地 Runtime（宿主 OS 进程）
        └── Codeestra Service #0（持久根 Actor）
             ├── Scheduler Service（Task-first 准入与资源）
             ├── Attention Service（全局待办索引）
             └── Project Service*
                  ├── Task Service* → Development Process → Agent
                  └── Integration Process → Agent

SIG_A：明确 API → Service handler → Operation → Git / verification / filesystem
SIG_P：intention → Service → Process → Agent → typed Service APIs

SQLite：Service state + Signal inbox/outbox + Operations + Audit + Recovery
Agent Adapter：Pi / Codex / Claude Code
Knowledge：按 Execution/Process 绑定
Self Evolution：Candidate / bootstrap（后续阶段）
```

当前 v37 已落地 Service 树、通用 Signal/Process 命令与兼容投影；Project/Task/Execution 旧表仍是 core 写权威。受管 integration、原生 Process Agent 与 intention 解释尚未落地。

这是模块分层，不是微服务。Domain 不依赖具体运行时、数据库、UI 或 Agent。Git worktree 隔离工作目录，不提供 OS 权限沙箱。

服务形态：独立本地 Runtime 是软件本体；**CLI 是完备、权威、可脚本化的命令面**。ADR-0067 起 Web UI 暂停，当前只启用 CLI/Unix socket；保留的 UI/HTTP 源码不属于可用产品面。未来恢复的 UI/桌面仍只能是同一 versioned command/query/event 面的便利前端。

## 设计导航

- [AI 的操作系统愿景](../vision/ai-operating-system.md)
- **[Service / Process / Agent / Signal 内核](service-process-signal.md)**（ADR-0068 目标架构）
- [Domain Model](domain-model.md)
- [Task / Execution / AgentSession / Integration / Self 状态机](state-machines.md)
- [SQLite Schema](sqlite-schema.md)
- [内部 Event Model](event-model.md)
- [Agent Adapter API](agent-adapter-api.md)
- [Git Workspace API](git-workspace-api.md)
- [Conservative Scheduler](scheduler.md)
- [Conflict Analyzer](conflict-analyzer.md)
- [Project Knowledge](knowledge.md)
- [Repository / Module Structure](repository-structure.md)
- [MVP roadmap](../roadmap/mvp.md)
- [决策索引与剩余门禁](../decisions/README.md)

## 已确认的重要语义

- 效率至上；默认 FULL 主机级全权限且常态零确认，CLI 可无确认切换 STRICT（ADR-0011）。
- 软件本体是服务，CLI 必须完备且可脚本化；UI/桌面是便利层。
- 自动化测试与验收仅通过 CLI/命令面驱动，不获取电脑控制权。
- 活动修订先暂停，确认新规格后恢复；无法可靠暂停/确认时保留现场并重新执行。
- 内核 Service-first、调度 Task-first；Service 是 Runtime 内持久 Actor，Process 只监督 Agent（ADR-0068）。
- Signal 分 `SIG_A` / `SIG_P`，持久至少一次投递并以幂等键收敛；Service 不直接拥有 Agent。
- 目标分支模型是 Project Service 独占的 integration ref/worktree + merge queue + 独立 Integration Verification；当前 v37 的兼容 Task 路径仍按 ADR-0066 把成果留在 task branch，由用户自己合并。
- Codeestra 自身仓库的 `dev→main` 人工发布继续固定 SHA 与证据，main 更新后立即以 CLI stop/status 重启；它不是产品 integration ref。
- Runtime 独立于窗口，关闭客户端不结束任务。
- 首个真实 Adapter 用 Pi；FULL 自动允许全部已注册工具，STRICT 保留原生审批与未知工具拒绝。
- Agent 配置按 Adapter 持久化，分全局默认与每项目覆盖，逐字段 环境变量 > 项目 > 全局 > 适配器默认；仅新 Session 生效，生效值随 Execution 记录（ADR-0012）。
- Agent 实际执行过程以**只读视图**呈现：`session.transcript` 直接读 Provider 自己的会话文件，不入库、不是 domain event、不是 attach、不新增确认；文件路径不离开 Runtime，仅限 Runtime 自己的 session 目录（ADR-0013）。Claude Code 的 Session 上该命令以 `SESSION_FILE_NOT_OWNED` 明确失败，不显示执行过程。
- Agent 可加载的插件/资源按作用域持久化（`agent plugins list|select`、`agent.config.set --pluginSelection`，schema v27），只有声明 `pluginSelection: SUPPORTED` 的 Adapter 能应用；其余以稳定码拒绝而不假装写入（ADR-0044）。Web UI 与 `settings ui *` 当前按 ADR-0067 暂停。
- 用户可从 Task 入口接管真实 Agent：Pi 在安全点从 RPC 交接到原生 TUI/PTY，普通输入是 Session Guidance，规格变化仍走 TaskRevision；任意时刻只有一个 Provider writer。
- 取消协作停止，超时需人工处理；提高优先级不抢占。
- ADR-0061 已实现（schema v34，两半）：一个 Runtime 只保留一个跨项目并行上限；全局暂停先建立持久启动屏障，再可核验地冻结 Provider 主进程，不向已运行工具子进程发停止信号，重启后也不自动继续。它不替代单 Task pause。
- Stable Promotion / Self Evolution 排空活动 Process 后切换，不迁移活动 AgentSession。

## 最大风险与建议

| 风险 | 建议与门禁 |
|---|---|
| Pi 是否真的具备所需交互、暂停与 attach 能力 | Pi RPC 不能原地附着原生 TUI；按 ADR-0010 做安全点 RPC↔TUI 进程交接 spike，核对 session file、PTY、权限模式 side channel 与单 writer；能力不足回报阻塞，不用 fake 冒充验收 |
| 修订后仍交付旧代码/证据 | revision、applied revision、commit、验证全链路固定引用；暂停和 ACK 分开 |
| 依赖满足但上游代码不在下游 | 目标模型中以 Project integration ref 的祖先可达性与 merge 事实核对；仅执行成功不满足依赖 |
| 功能声明不完整造成误并行 | ADR-0059 只按同一功能声明判冲突；这是已接受的残余风险，实际越界时暂停并报告 |
| Signal 被误解为 exactly-once | 持久 inbox/outbox 只保证至少一次；handler 幂等，外部副作用继续用 Operation + 身份/ref 核对 |
| SQLite、Git 与进程非原子 | Operation + Signal receipt + 幂等键 + 外部身份核对；不能盲目重试 start/merge |
| 全局暂停误把“发过信号”当成“已冻结” | pause epoch 固定目标；按 pid + start token + incarnation 复读 stopped 事实；部分成功进入全局 `RECOVERY_REQUIRED` 并保持屏障；Provider 进程归属未经 spike 不声明 SUPPORTED |
| integration ref 影响用户 checkout | Project Service 使用独立 owned integration ref/worktree；不直接推进用户已检出 branch，推进前 expected OID CAS |
| 宿主权限、hooks、日志秘密 | worktree 不是沙箱；FULL 明确允许当前用户主机级副作用与敏感路径提交，终端输出仍不可信；需要旧门禁时显式切换 STRICT（ADR-0011） |
| 自我升级数据不可逆 | Candidate 数据隔离；迁移/备份/bootstrap 更新策略 Phase 7 前明确批准 |

## 设计成熟度

完整产品的语义不可能用一次草案全部锁死。当前成熟事实到 schema v37；ADR-0068 的 Service kernel 按 S1–S10 分阶段准入，S1–S4 已完成。纯领域、additive storage、Signal dispatcher、兼容 CLI、Process 投影与受管 integration 各自有独立退出条件，后续阶段不得被当作已经批准实现细节。

SQLite 文档第 8 节记录**已执行**的 migration；当前最新实现为 schema v37（Service/Signal/Process 内核），后继版本才可加入受管 integration，且只有实际实现格能把它写成已执行 migration。API 为 Runtime port 合约，不是供应商能力承诺；`agent-adapter-api.md` 记录 Pi、Codex 与 Claude Code 的实测能力矩阵。
