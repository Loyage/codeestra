# Codeestra Architecture

状态：架构设计基线已建立；已确认决策见 ADR-0001/0002。Phase 0 纯领域工程可开始；Phase 1 真实 Runtime 仍有技术/授权准入门禁，不代表全部架构已最终冻结。

## 总体架构

```text
Desktop / 最小本地客户端（可断开与重连）
                 │ commands / queries / events
独立本地 Runtime │
  Intent Intake → Task Service → DAG / Impact / Conflict
                                      ↓
                                  Scheduler
                                      ↓
  Execution Coordinator → Git Workspace Port → Git CLI
          ↓
  Agent Adapter Port → Pi（首个）/ Codex / Claude Code
          ↕ Session Guidance / 原生 TUI-PTY 接管（安全点进程交接）
  Task Verification → IntegrationBatch → Integration Verification → Dev
                                                                  ↓
                                          固定 dev/main SHA（仅 STRICT 批准）
                                                                  ↓
                                       Main → CLI stop/status → Runtime 重启

SQLite + Outbox + Operations + Audit + Recovery（基础设施）
Knowledge Service（Phase 6）
Self Task → Candidate → 自托管测试 → 用户 Promotion → 排空 → Stable（Phase 7）
独立 codeestra-bootstrap：版本选择、健康检查、回滚与恢复
```

这是模块分层，不是微服务。Domain 不依赖具体运行时、数据库、UI 或 Agent。Git worktree 隔离工作目录，不提供 OS 权限沙箱。

服务形态：独立本地 Runtime 是软件本体；**CLI 是完备、权威、可脚本化的命令面**，Web UI 与未来桌面只是同一 versioned command/query/event 面的便利前端（不新增业务语义、不绕过门禁、不直接访问 SQLite）。“只有 UI 能做、CLI 不能做”的能力视为缺陷。

## 设计导航

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
- 固定 `main`/`dev` 双分支：main 运行稳定服务，功能 Task 从 dev 建基线并先集成回 dev。
- 依赖结果经集成验证且进入下游可达的 dev 基线才能释放下游。
- dev→main 固定 SHA 与证据；FULL 无需批准，STRICT 保留批准；main 更新后立即以 CLI stop/status 重启并检查 Runtime。
- Runtime 独立于窗口，关闭客户端不结束任务。
- 首个真实 Adapter 用 Pi；FULL 自动允许全部已注册工具，STRICT 保留原生审批与未知工具拒绝。
- Agent 配置按 Adapter 持久化，分全局默认与每项目覆盖，逐字段 环境变量 > 项目 > 全局 > 适配器默认；仅新 Session 生效，生效值随 Execution 记录（ADR-0012）。
- Agent 实际执行过程以**只读视图**呈现：`session.transcript` 直接读 Provider 自己的会话文件，不入库、不是 domain event、不是 attach、不新增确认；文件路径不离开 Runtime，仅限 Runtime 自己的 session 目录（ADR-0013）。Claude Code 的 Session 上该命令以 `SESSION_FILE_NOT_OWNED` 明确失败，不显示执行过程。
- Agent 可加载的插件/资源按作用域持久化（`agent plugins list|select`、`agent.config.set --pluginSelection`，schema v27），只有声明 `pluginSelection: SUPPORTED` 的 Adapter 能应用；其余以稳定码拒绝而不假装写入（ADR-0044）。界面效果设置（`settings ui *`）是设置不是门禁，不驱动任何领域状态迁移（ADR-0045）。
- 用户可从 Task 入口接管真实 Agent：Pi 在安全点从 RPC 交接到原生 TUI/PTY，普通输入是 Session Guidance，规格变化仍走 TaskRevision；任意时刻只有一个 Provider writer。
- 取消协作停止，超时需人工处理；提高优先级不抢占。
- Stable Promotion 排空活动任务后切换，不迁移活动 Session。

## 最大风险与建议

| 风险 | 建议与门禁 |
|---|---|
| Pi 是否真的具备所需交互、暂停与 attach 能力 | Pi RPC 不能原地附着原生 TUI；按 ADR-0010 做安全点 RPC↔TUI 进程交接 spike，核对 session file、PTY、权限模式 side channel 与单 writer；能力不足回报阻塞，不用 fake 冒充验收 |
| 修订后仍交付旧代码/证据 | revision、applied revision、commit、验证全链路固定引用；暂停和 ACK 分开 |
| 依赖满足但上游代码不在下游 | dev 基线祖先可达性检查；仅执行成功不满足依赖 |
| 预测不完整造成误并行 | UNKNOWN 不并行；实际 diff 越界撤销 SAFE，暂停并报告 |
| SQLite、Git 与进程非原子 | Operation + outbox + 幂等键 + 外部身份核对；不能盲目重试 start/promote |
| 已 checkout main 被直接 update-ref | dev→main 提升时拒绝使用户 index/worktree 不一致的更新；具体安全交接策略 Phase 4 前确认；成功更新后必须重启 Runtime |
| 宿主权限、hooks、日志秘密 | worktree 不是沙箱；FULL 明确允许当前用户主机级副作用与敏感路径提交，终端输出仍不可信；需要旧门禁时显式切换 STRICT（ADR-0011） |
| 自我升级数据不可逆 | Candidate 数据隔离；迁移/备份/bootstrap 更新策略 Phase 7 前明确批准 |

## 设计成熟度

完整产品的语义不可能用一次草案全部锁死。这里采用按阶段准入：Phase 0 的领域纯函数不涉及外部副作用；Phase 1 必须验证 Pi 协议并确认 Git 成果提交策略；Phase 2/4/7 的待决项只阻塞对应阶段，不被当作已批准默认值。

SQLite 文档第 2–6 节为关系设计（含明确标注的待细化约束），第 8 节逐版本记录**已执行**的 migration（当前 `phase1SchemaVersion = 27`；v16 永久未使用、v22 未占用）。API 为 Runtime port 合约草案，不是供应商能力承诺；`agent-adapter-api.md` 已记录 Pi、Codex 与 Claude Code 的实测能力矩阵。
