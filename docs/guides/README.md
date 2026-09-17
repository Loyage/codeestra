# Codeestra 用户指南

> **适用版本** ADR-0068 S1–S4 实现分支（2026-09-17） · **schema** v37 · **最后校对** 2026-09-17
> 版本会前进：`dev@036cf68` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 权限模式的命令拼写由 FOUNDATION-098 同步为 `settings permission get|set`（ADR-0064：顶层 `permission` 已移除；§19 另新增 `settings list` 总览）。
> **ADR-0068 S1–S4 实现修订**：新增 Service Kernel 命令参考；其余分篇保留各自最后校对基线。

本目录是**面向使用者**的中文指南：怎么装、怎么用、软件具备哪些能力、每条命令怎么敲、出错了怎么办。

Codeestra 的长期目标是 **AI 的操作系统**：内核 Service-first、Scheduler Task-first，以 Service / Process / Agent / Signal 管理 AI 工作。软件本体是独立本地 Runtime；ADR-0067 起当前只启用 CLI/Unix socket 命令面，Web UI 已暂停。

> **当前实现边界**：本目录只描述 schema v37 **真实具备**的能力。ADR-0068 S1–S4 的 `service/process/signal/intent` 通用命令已写入 [Service Kernel 命令参考](./cli/kernel.md)；原生 Process Agent、intention 解释与受管 integration 尚未实现，不会提前写成可用能力。目标设计见 [Service Kernel 架构](../architecture/service-process-signal.md)。每条现有命令、参数、退出码与错误码都从仓库源码核对得到
> （核对方法与结果见 `docs/tasks/README.md` 的 FOUNDATION-070 一节）。文档与实现不一致的地方在本目录
> 各文中如实标注，不替用户裁决。

## 按你的目的选路径

| 我想…… | 从这里开始 |
|---|---|
| **不知道该从哪读、想要一份从头读到尾的说明书** | **[manual.md](./manual.md)** |
| 第一次把 Codeestra 跑起来 | [getting-started.md](./getting-started.md) |
| 先搞懂 Project / Task / Execution 这些词是什么意思 | [concepts.md](./concepts.md) |
| 走一遍当前「建任务 → 执行 → 验证 → 自己合并」流程 | [workflow.md](./workflow.md) |
| 查「这软件到底有哪些功能」 | [features.md](./features.md) |
| 查「这条命令怎么用、参数是什么、退出码是什么」 | [cli/README.md](./cli/README.md)（八篇索引 + §0 通用约定） |
| 查看 Web UI 为什么不可用、未来怎样恢复 | [ui.md](./ui.md)（暂停说明） |
| 想做某件具体的事（改 bug / 并行 / 换 Agent / **暂停全部** / 发布…） | [recipes.md](./recipes.md) |
| 查看 UI 人工验收状态 | [acceptance-checklist.md](./acceptance-checklist.md)（当前暂停） |
| 图放哪、缺哪张图 | [images/README.md](./images/README.md) |
| 遇到了报错 / 想查稳定错误码 | [troubleshooting.md](./troubleshooting.md) |

## 三条必须先知道的第一原则

1. **效率至上**：Runtime 默认运行在 `FULL` 主机级全权限模式。项目接入、Agent 工具、成果 commit、验证策略
   变化默认**零确认**。你随时可以用 CLI 无确认切到 `STRICT` 恢复旧门禁（`bun run codeestra settings permission set strict`）。
2. **软件本体是服务，CLI 必须完备**：每个能力都必须能只靠 CLI 完成并可脚本化驱动；当前 Web UI 已暂停。
3. **测试只驱动 CLI / 命令面**：自动化验收不依赖桌面或键鼠自动化。

完整表述见 [PROJECT_SPEC.md §1.1](../../PROJECT_SPEC.md)、
[ADR-0008](../decisions/0008-efficiency-first-service-form.md)、
[ADR-0011](../decisions/0011-default-full-permission-mode.md)。

## 相关文档（不是用户指南）

- [AI 的操作系统愿景](../vision/ai-operating-system.md)：长期产品直觉与历史类比。
- [PROJECT_SPEC.md](../../PROJECT_SPEC.md)：长期规格（人类维护，只读）。
- [Architecture](../architecture/README.md)：领域、状态机、SQLite、事件、调度、冲突分析、模块设计。
- [Decisions](../decisions/README.md)：已接受的 ADR 与待决项。
- [Roadmap](../roadmap/mvp.md) / [当前任务与进度](../tasks/README.md)。
- [AGENTS.md](../../AGENTS.md)：协作与开发规则（给在本仓库上开发的人看，不是使用者文档）。
