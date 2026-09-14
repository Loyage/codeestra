# ADR-0034：紧凑任务信息行与主操作优先

Status：Accepted（用户选择「紧凑信息行」与「紧凑导航＋突出主操作」）。

## Context

用户希望更显眼、动态地理解任务运行状态，并减少边栏、页头和低价值信息对内容区的占用。原列表只有小状态标签，详情把大量不可用按钮同时展示；部分文案仍错误地声称不支持暂停、终止。

## Options

- 列表：紧凑信息行 / 任务卡片 / 状态看板。
- 导航与操作：紧凑文字导航并突出主操作 / 极简图标导航 / 仅增强展示、不移动操作。

## Decision

- 采用紧凑信息行：任务编号、两行规格摘要、醒目状态、待处理请求数量、规格版本、优先级、约束数、更新时间。显示字段只来自既有 `task.list` 与 `attention.list`，不为每行读取完整执行历史。
- 状态使用文字、颜色、标记组合，不只依赖颜色。进行态允许轻量动效，遵循 `prefers-reduced-motion`；断线时停止动效并提示当前为最近记录。动效表示 Runtime 任务状态，不是 provider 心跳，不生成虚假百分比，也不把 Task 更新时间称为执行耗时。`RUNNING` 可能仍在等待成果捕获，详情会话已退出时明确提示。
- 概况点击即筛选；「需要你处理」按任务去重，包含 OPEN 请求、等待用户、失败和恢复态。概况不含归档；搜索、状态、归档与排序均为本地呈现条件，不改变 Runtime 调度优先级。保留默认命令返回顺序，另可选最近更新、优先级排序。
- 缩窄文字导航与页头，搜索筛选横排；列表使用页面滚动，避免短小嵌套滚动区。窄屏信息行改为单列，深浅主题保持不变。
- 保留 FOUNDATION-036 的列表/详情分离，不恢复双栏、不增加拖拽改状态。返回列表保留搜索、筛选和排序。
- 详情突出当前可用操作，不适用主动作隐藏；终止与归档放入「更多操作」，问卷置于长命令记录之前；说明和原始结果可展开。常态不自动执行 capture/verify/integrate 等后续步骤。
- 修正暂停/终止与自动调度的过时文案；不把成果提交、验证通过、进入 dev、提升 main 混为一个成功。UI 只调用原有命令，Runtime 仍负责版本、静止、归属、证据与权限核对。

## Consequences

- 新增审批成本 **0 步、0 等待**。终止/归档作为低频动作增加一次展开点击，不是确认门禁；回答仍在任务内直接完成。
- 不修改 Domain、数据库、公共 API、调度策略或 provider 能力。不会为了列表实时感引入逐行高频轮询；SSE 订阅/重连补读现有列表和详情投影。
- 列表无完整 Session / verification 证据时不臆测具体工具、模型、失败原因或验证结论，需进入详情读取事实。

## Verification

- TypeScript、Vite 构建及 CLI/Runtime HTTP/SSE 回归。
- 通过实际 UI HTTP 客户端核对任务列表元信息、OPEN 请求关联、归档可见性与取消归档；保留会话退出不等于成果成功的断言。
- 不使用浏览器/桌面自动化。用户人工确认：深浅主题、窄屏、动效及减少动态效果设置、键盘操作、返回列表条件保留、不同任务状态的主操作与更多操作。

## 本次发布路径补充（Accepted，仅 FOUNDATION-058）

用户随后明确要求「提交并部署到 main」，并在两种方案中选择「沿用上次人工发布路径」，而非先安排 Runtime Task / dev 检出交接再建立领域 IntegrationBatch。

- 背景：本轮改动由直接开发会话产生，没有 Runtime Task/IntegrationBatch；当前产品的 `task.integrate` 拒绝向已检出的 dev 更新 ref。本机 dev 工作树正被检出。
- 选项：沿用已有人工发布规程 / 转入正式 Runtime 任务集成流程。用户明确选择前者，作为**本次发布的显式例外**，不默认为未来放宽 Task 集成规则。
- 决定：在 dev 完整运行 `bun install --frozen-lockfile` 与 `bun run check`，提交这批改动、固定候选 dev SHA 与预期 main SHA；在 main 工作树 fast-forward 该固定候选，再按顺序 install → build:ui → stop → status，必要时经 `ui --no-open` 启动 UI 并复查状态。只有 READY 且 uiRunning 才向用户报告恢复。
- 后果：本次**不生成领域 IntegrationBatch / PromotionRecord**，不以文档或手工 ref 更新冒充这些数据库记录；证据是 Git 提交、全量检查记录与实际 CLI 重启结果。不 push，不擅自回滚，失败立即报告。
- 常态额外审批成本为 0；本轮选择用于明确一次性发布路径差异，不新增产品确认层。

## Related

- [ADR-0015](0015-task-workbench-and-themes.md)
- [ADR-0008](0008-efficiency-first-service-form.md)
- [ADR-0011](0011-default-full-permission-mode.md)
- [ADR-0033](0033-scheduling-engine.md)
- [任务进度](../tasks/README.md) FOUNDATION-058
