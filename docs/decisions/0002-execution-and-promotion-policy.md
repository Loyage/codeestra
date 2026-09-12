# ADR-0002：首个 Adapter、权限、取消与版本切换

Status：Accepted（用户明确选择四项 A）

## Context / Options

需确定首个真实 Agent、执行权限边界、取消/抢占策略和自我升级时活动任务处理。备选分别为 Pi/Codex/Claude Code、原生审批/预授权/OS 沙箱、协作取消/超时强杀/抢占、等待排空/主动停止/双版本并行。

## Decision

- Phase 1 首个真实 Adapter 为 Pi；fake adapter 只用于测试。Pi 实际协议须通过文档与技术验证，不假定支持任意暂停、attach 或跨进程恢复。
- 保留 Pi 原生权限审批，不由 Codeestra 自动回答、自动放行或开启 bypass。审批仅暂停对应 Task；Phase 1 必须提供最小真实交互通路，完整 UI 在 Phase 3。
- 取消先请求协作中断，保留 worktree。超时明确标记需要人工处理，不能标为已取消或自动强杀。
- 优先级只影响下一次调度，不抢占现有任务。
- Self Promotion 时停止接纳新执行，等待活动任务结束或由用户取消后再切换。WAITING_FOR_USER、修订暂停、取消未确认和失联但无法证明已退出的任务都阻止排空完成。不迁移活动 Session。

## Consequences

原生审批不等于 OS 沙箱，也不保证 Agent 默认会审批所有工具。Runtime 必须报告实际权限配置，不将 worktree 宣传为权限隔离。

不支持可靠暂停的 Pi 接入需要使用协作中断、确认静止、保留现场、建立新 Execution 的回退路径；不能在未停止写入时开始并行执行或切换 Stable。

数据库迁移兼容性、bootstrap 自身发布/更新授权在 Phase 7 前单独确认；不影响 Phase 0/1 编码，但禁止提前实现自动自我升级。

## Verification

- 假审批事件不得自动触发同意。
- 协作取消超时仍保留资源占用并显式请求人工处理。
- 改优先级不产生运行任务的中断命令。
- 排空中不启动新 Execution，存疑的存活进程阻止版本切换。
