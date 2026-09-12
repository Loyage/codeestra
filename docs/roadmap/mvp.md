# MVP Roadmap

状态：阶段草案；准入标准和具体任务随 ADR 收敛。

## Phase 0 — Architecture Foundation

交付：规格、AGENTS、ADR、模块边界、领域/状态机/SQLite/事件/API 设计；随后建立最小 Bun workspace、TypeScript 严格配置与 Vitest 测试入口。

按小步准入：Phase 0 纯领域函数与测试骨架可先开始（关键语义已确认，不涉及外部副作用）；storage/真实 Runtime 编码前关闭影响 Phase 1 产品行为、schema 与 Git 安全的待决项，并验证 Pi 的实际支持范围。不得把纯领域验收等同整个 Phase 0/1 已完成。

验收：全新环境可运行已声明检查；领域非法迁移测试、数据库约束测试和 fake adapter 合约测试通过。Fake 不替代真实集成验收。

## Phase 1 — Single Task Runtime

交付：一个项目、一个活动任务、意图/规格持久化、修订历史、独立 branch/worktree、一个真实 Adapter、执行记录、任务验证、失败/取消与重启状态核对。

验收：临时真实 Git 仓库中，从创建 Task 到获得固定 revision/commit 的验证结果；不修改 main；重复命令不产生重复执行；保留失败现场；无法恢复真实 Agent 时诚实记录而非伪造 RUNNING。

Phase 1 不提供 Phase 3 的完整 attach UI。若 Agent 需要交互，必须显式报告，不允许无期限静默挂起或假装成功。具体最小交互入口由 Adapter 决策确定。

## Phase 2 — Task DAG + Scheduler + Parallel Worktrees

交付：DAG 校验、依赖满足策略、影响分析、保守冲突分析、资源预留和多 worktree 调度。

验收：SAFE 的独立任务并行；UNKNOWN/CONFLICTING 不并行；循环依赖拒绝；下游基线含所需上游代码。若 D02 选择必须集成后满足依赖，此阶段允许下游继续 BLOCKED，不提前偷做完整 Phase 4。

## Phase 3 — Interactive Agent Sessions

交付：真实 session 接入、Attention Inbox、WAITING_FOR_USER、回答路由、断连与恢复、运行中修订的通知与确认。

验收：一个 Task 等待用户时其他 Task 可继续；回答不会路由到错误会话；修订投递状态可审计。

## Phase 4 — Integration Pipeline

交付：IntegrationBatch、集成分支、独立验证、批准/提升门禁、冲突/失败/主分支移动处理。

验收：失败候选不改变 main；提升的 commit 与被验证 commit 一致；批次成员 revision 可追溯。

## Phase 5 — Multiple Agent Adapters

交付：Pi、Codex、Claude Code 接入；能力矩阵和一致性测试；失败后新 Execution 可更换 Agent。

验收：Core 无供应商类型依赖；不支持的交互/恢复能力明确反馈。

## Phase 6 — Project Knowledge

交付：人工与机器知识分层、加载和来源、更新审计。

验收：机器生成不能覆盖人工知识；Execution 能追溯实际使用的知识版本。

## Phase 7 — Self Evolution

交付：Self Task、Candidate、自托管测试、PROMOTABLE、用户 Promotion、独立 bootstrap 和恢复演练。

验收：Stable 不被开发过程覆盖；失败 Candidate 不污染 Stable 数据；切换与回滚经过兼容性检查；bootstrap 在 Runtime 无法启动时仍可使用。

## 非目标

本轮不做完整产品 UI、全部阶段实现、云端调度、多租户、远端控制、分布式基础设施、自动无审批自我升级。产品发布版本、工期和发布承诺在首个真实 Adapter 技术验证前不预估；工程 package 的 0.0.0 仅为未发布占位。
