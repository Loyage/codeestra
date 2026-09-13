# ADR-0015：任务工作台与深浅主题

Status：Accepted（用户明确选择「任务工作台重构」与「深浅主题可切换」）。

## Context

现有 Web UI 偏调试控制台：任务、问题和执行内容分散，执行/验证表格挤占主视图，按钮缺少当前可用性提示。用户要求优化界面、UI 与操作逻辑。

## Options

- 范围：任务工作台重构 / 仅轻量美化 / 先出方案再实现。
- 外观：简洁深色 / 明亮浅色 / 深浅主题可切换。

## Decision

- 采用任务工作台重构：导航区 + 项目任务概况 + 可搜索/筛选任务列表 + 任务详情。
- 详情集中展示下一步提示、现有命令操作、当前任务待处理问题、只读 Agent 执行过程与可折叠的执行/验证证据；保留项目级待处理入口。
- 支持跟随系统、浅色、深色，默认跟随系统。主题仅为浏览器本地偏好，不属于 Runtime/Task 数据，不新增业务 API；存储不可用时仍能在本次页面中切换。
- 使用现有 `task.create/submit/run/status/result.capture|prepare|commit/verify`、`attention.list/answer`、`session.transcript` 等命令，不自动串行运行后续业务步骤。草稿不自动提交或运行；Session 退出不等于成果提交，验证通过不等于集成或发布。
- 按当前投影提示可用动作并防重复点击，Runtime 继续负责状态、revision、静止证据、权限等最终核对。回答请求不受其他任务长命令的全局忙碌状态阻塞。
- 项目接入把两个既有只读检查（仓库与验证策略）合为一个按钮，随后仍调用同一 `project.trust`；FULL 不新增确认，STRICT 保留原有 TRUST 语义。

## Consequences

- 常态新增审批成本：**0 步、0 等待**。任务内即可回答，不再必须切换待处理页；只读项目检查从两个按钮合为一个。
- 本轮仅改变便利前端与刷新/防重复交互；不实现取消、暂停、Token 级实时、自动调度、集成或发布，不冒充具备这些能力。
- 本地筛选、主题等呈现偏好无需新增 CLI 业务命令。所有会产生领域副作用的操作仍有完整 CLI 对应入口。
- 视觉确认依赖用户人工检查；构建或 HTTP 通过不能证明浏览器排版、焦点或主题视觉效果正确。

## Verification

- TypeScript 与 Vite 构建；现有 CLI/Runtime 命令面回归。
- 用 UI 自身的 HTTP 客户端在隔离 Runtime + 临时仓库中断言：任务等待回答时仍可创建另一草稿、读取正确任务、非法答案不关闭请求、合法答案可投递、Agent 退出不虚报成果或验证成功。
- HTTP 检查实际构建资产可获取、令牌边界不变；不进行浏览器、桌面或键鼠自动化。
- 用户人工确认：三种主题、窄屏布局、搜索与筛选、切换任务无串页、任务内回答、验证记录与实际状态一致。

## Related

- [ADR-0008](0008-efficiency-first-service-form.md)
- [ADR-0011](0011-default-full-permission-mode.md)
- [ADR-0013](0013-read-only-agent-transcript-view.md)
- [ADR-0014](0014-agent-structured-question-channel.md)
- [任务进度](../tasks/README.md) FOUNDATION-032
