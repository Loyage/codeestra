# 当前任务与进度

## FOUNDATION-001 — 架构基线

状态：设计基线已建立；非全部最终定稿。

已完成：
- 创建并同步 `PROJECT_SPEC.md`、`AGENTS.md`、四类 docs 目录。
- 记录用户八项明确选择：ADR-0001 / ADR-0002。
- 总体架构、主要领域对象、五类状态机、SQLite 关系设计、事件模型、Adapter/Workspace port 草案。
- Conservative Scheduler、Conflict Analyzer、module structure、MVP roadmap、非目标与最大风险。
- 将影响后续实现的未决事项按 Phase 1/2/4/7 分开，不当作用户已接受默认。

设计限制：SQLite 文档不是发布 migration，部分后续阶段 CHECK/跨表约束与 Self Evolution 最终 DDL 仍需补齐；Adapter API 未经真实 Pi 验证。

## FOUNDATION-002 — Phase 0 纯领域工程

状态：第一小步完成；整个 Phase 0 尚未完成。

已实现：
- Bun workspace、TypeScript strict、Vitest 5.0.0 与锁文件。
- SpecificationHistory / TaskRevision：完整不可变快照、约束 ID 唯一、保留用户原文、乐观版本冲突拒绝。
- Execution FSM：准备/启动/运行、用户等待、修订暂停/ACK/恢复、协作取消、SUPERSEDED、成功/失败、失联保护。
- 终态不复活、控制超时不释放资源、旧 ACK 不应用、未确认最新 revision 不恢复、未关闭 Attention 不恢复。

明确未实现：Task 全聚合服务、完整 Task FSM、Zod 外部边界、SQLite storage、outbox/幂等命令服务、fake/真实 Adapter、Git 副作用、真实恢复、应用 shutdown、调度器、Terminal/UI。

实际验证：
- Nix 提供 Bun 1.3.13；当前 Node 24.19.0。
- `bun run check`：TypeScript 通过；2 个测试文件、212 项测试通过（含 Execution 状态×事件拓扑矩阵）。
- 首次 `bun audit` 发现 Vitest 3.2.4 相关 3 项漏洞；升级至 5.0.0 后重新跑 check 通过，`bun audit` 报告无已知漏洞。
- 文档 SQL：用 Node 内存 SQLite 执行 5 个 SQL block，成功建立 22 张业务表；空 schema 外键检查无违规。**这只验证语法/空结构，不是 migration 或业务数据约束验收。**
- 检查规格/架构/决策索引的 17 个本地链接均存在。

Git：目录开始时不是 Git 仓库；未初始化、未 commit、未 push，未操作其他项目 Git。

## NEXT — Phase 1 准入

1. 读取当前安装 Pi 文档和 examples，验证真实审批、会话、暂停/中断、attach、恢复能力。
2. 向用户确认成果自动 commit 的授权、身份与 hooks 策略；能力不足时明确询问而不是绕过原生审批。
3. 确定最小本地 IPC/进程托管方案；完成 Phase 1 子集 schema 的全部约束与真实 SQLite 测试。
4. 实现 command receipts/outbox/Operation 与 fake adapter 协议测试，再接真实 Pi。
5. 所有 Git 测试使用临时仓库，真实集成与 fake 测试分别验收。
