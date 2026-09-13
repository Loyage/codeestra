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
          ↓
  Task Verification → IntegrationBatch → Integration Verification
                                              ↓
                                    用户批准固定 candidate/main SHA
                                              ↓
                                            Main

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
- [Repository / Module Structure](repository-structure.md)
- [MVP roadmap](../roadmap/mvp.md)
- [决策索引与剩余门禁](../decisions/README.md)

## 已确认的重要语义

- 效率至上；现有门禁冻结且不新增权限管理（多用户/租户/沙箱/密钥托管不预留门禁）。
- 软件本体是服务，CLI 必须完备且可脚本化；UI/桌面是便利层。
- 自动化测试与验收仅通过 CLI/命令面驱动，不获取电脑控制权。
- 活动修订先暂停，确认新规格后恢复；无法可靠暂停/确认时保留现场并重新执行。
- 依赖结果经集成验证且进入 main 才能释放下游。
- main 每批提升需用户批准，main 变化使批准失效。
- Runtime 独立于窗口，关闭客户端不结束任务。
- 首个真实 Adapter 用 Pi；不自动绕过原生审批。
- 取消协作停止，超时需人工处理；提高优先级不抢占。
- Stable Promotion 排空活动任务后切换，不迁移活动 Session。

## 最大风险与建议

| 风险 | 建议与门禁 |
|---|---|
| Pi 是否真的具备所需审批、暂停与 attach 能力 | 先读当前版本文档并做真实 spike；能力不足回报阻塞，不用 fake 冒充验收 |
| 修订后仍交付旧代码/证据 | revision、applied revision、commit、验证全链路固定引用；暂停和 ACK 分开 |
| 依赖满足但上游代码不在下游 | main 祖先可达性检查；仅执行成功不满足依赖 |
| 预测不完整造成误并行 | UNKNOWN 不并行；实际 diff 越界撤销 SAFE，暂停并报告 |
| SQLite、Git 与进程非原子 | Operation + outbox + 幂等键 + 外部身份核对；不能盲目重试 start/promote |
| 已 checkout main 被直接 update-ref | 拒绝使用户 index/worktree 不一致的提升；具体安全交接策略 Phase 4 前确认 |
| 宿主权限、hooks、日志秘密 | worktree 不是沙箱；保留既有原生审批与命令授权，终端输出不可信。**已实现门禁不删也不再新增**（ADR-0008）；权限管理移出当前范围，若将来需要必须重开决策 |
| 自我升级数据不可逆 | Candidate 数据隔离；迁移/备份/bootstrap 更新策略 Phase 7 前明确批准 |

## 设计成熟度

完整产品的语义不可能用一次草案全部锁死。这里采用按阶段准入：Phase 0 的领域纯函数不涉及外部副作用；Phase 1 必须验证 Pi 协议并确认 Git 成果提交策略；Phase 2/4/7 的待决项只阻塞对应阶段，不被当作已批准默认值。

SQLite 文档为关系设计，含明确标注的待细化约束，不是已执行 migration。API 为 Runtime port 合约草案，不是供应商能力承诺。
