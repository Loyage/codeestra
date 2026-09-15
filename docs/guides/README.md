# Codeestra 用户指南

本目录是**面向使用者**的中文指南：怎么装、怎么用、软件具备哪些能力、每条命令怎么敲、出错了怎么办。

Codeestra 是 Task-first、local-first 的 AI Development Runtime：你管理产品意图，Codeestra 管理软件工程
（分支、工作树、执行、验证、集成、提升）。软件本体是一个**独立本地 Runtime**；CLI 与本地 Web UI 是
**同一个命令面**的前端，UI 不新增业务语义、不绕过门禁。

> 本文档只描述**当前实现真实具备**的能力。每条命令、参数、退出码与错误码都从仓库源码核对得到
> （核对方法与结果见 `docs/tasks/README.md` 的 FOUNDATION-070 一节）。文档与实现不一致的地方在本目录
> 各文中如实标注，不替用户裁决。

## 按你的目的选路径

| 我想…… | 从这里开始 |
|---|---|
| 第一次把 Codeestra 跑起来 | [getting-started.md](./getting-started.md) |
| 先搞懂 Project / Task / Execution 这些词是什么意思 | [concepts.md](./concepts.md) |
| 走一遍「从建任务到合入 dev 再到稳定提升」的完整流程 | [workflow.md](./workflow.md) |
| 查「这软件到底有哪些功能」 | [features.md](./features.md) |
| 查「这条命令怎么用、参数是什么、退出码是什么」 | [cli-reference.md](./cli-reference.md) |
| 认一下界面上的每个面板 | [ui.md](./ui.md) |
| 遇到了报错 / 想查稳定错误码 | [troubleshooting.md](./troubleshooting.md) |

## 三条必须先知道的第一原则

1. **效率至上**：Runtime 默认运行在 `FULL` 主机级全权限模式。项目接入、Agent 工具、成果 commit、验证策略
   变化默认**零确认**。你随时可以用 CLI 无确认切到 `STRICT` 恢复旧门禁（`bun run codeestra permission set strict`）。
2. **软件本体是服务，CLI 必须完备**：每个能力都必须能只靠 CLI 完成并可脚本化驱动。只有 UI 能做的事视为缺陷。
3. **测试只驱动 CLI / 命令面**：自动化验收不依赖桌面或键鼠自动化。

完整表述见 [PROJECT_SPEC.md §1.1](../../PROJECT_SPEC.md)、
[ADR-0008](../decisions/0008-efficiency-first-service-form.md)、
[ADR-0011](../decisions/0011-default-full-permission-mode.md)。

## 相关文档（不是用户指南）

- [PROJECT_SPEC.md](../../PROJECT_SPEC.md)：长期规格（人类维护，只读）。
- [Architecture](../architecture/README.md)：领域、状态机、SQLite、事件、调度、冲突分析、模块设计。
- [Decisions](../decisions/README.md)：已接受的 ADR 与待决项。
- [Roadmap](../roadmap/mvp.md) / [当前任务与进度](../tasks/README.md)。
- [AGENTS.md](../../AGENTS.md)：协作与开发规则（给在本仓库上开发的人看，不是使用者文档）。
