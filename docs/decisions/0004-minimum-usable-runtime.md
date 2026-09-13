# ADR-0004：最小可用 Runtime 形态

Status：Accepted（用户明确选择四项；Phase 1 工具分类与回答接口已补充确认）

## Context

Phase 1 需要从独立基础模块进入可实际使用的单任务纵向切片。必须确定首个用户入口、独立 Runtime 生命周期、首次项目信任和 Pi 工具审批方式；这些会影响 IPC、安全边界和交互流程。

## Options

1. 入口：CLI / 本地 Web / Tauri Desktop。
2. Runtime：CLI 自动启动后台 Runtime / 用户显式启动 / 仅前台运行。
3. 项目信任：显式一次信任 / 每次执行确认 / 先只读后提升。
4. 工具审批：敏感操作逐次审批 / 所有工具逐次审批 / 固定允许列表。

## Decision

- 首个可用入口为 CLI；后续 Desktop 复用 Runtime command/query/event 合约，不直接访问 SQLite。
- CLI 发现本用户 Runtime 未运行时自动启动独立后台进程。CLI 退出不停止 Runtime；Runtime 身份、IPC endpoint 与进程状态必须核对，不能只相信陈旧 PID 文件。
- 首次添加项目必须显式确认信任。信任记录绑定 canonical repository root、Git common dir、object format 与 policy version；关键身份变化使信任失效。
- 信任说明必须明确：Agent、命令、Git hooks/filters 可能执行代码并访问本机权限；信任不授权 main 更新、push、成果 commit 或绕过权限门禁。
- Pi 首版对敏感操作逐次审批。用户补充确认 Phase 1 只审批写入与 shell：Pi 内置 `read/grep/find/ls` 按工具类型直接允许，不增加路径审批；`write/edit/bash/powershell` 每次建立 Runtime Permission Attention；其他工具 fail-closed。批准绑定具体 session/request/tool input fingerprint，不是会话级永久授权。
- CLI 不在线时 Attention 保持等待；重新连接后可查询并回答。不得因没有客户端自动批准或无限静默运行。
- 用户补充确认公共回答接口采用 provider-neutral typed answer：`CONFIRM(boolean)`、`VALUE(string)`、`CANCEL`。Runtime 依据 Adapter 声明的 response type 校验，不把 Pi-shaped JSON 泄漏为公共 API。

## Consequences

首个纵向切片优先完成 project trust、单 Task、独立 worktree、Pi RPC、Attention、验证和 ADR-0003 成果 commit 确认，不先制作桌面 UI 或多 Task scheduler。后台 Runtime 增加本地 IPC、单实例、崩溃恢复和安全文件权限要求。

敏感/只读分类必须版本化且 fail-closed。Phase 1 的明确只读集合仅含 Pi 内置 `read/grep/find/ls`；新增或名称未知的工具不会因看似只读自动加入。此选择允许这些工具读取工作区外路径，依赖用户已接受的本机项目 trust，而不是额外路径沙箱。Pi 原生 extension UI 负责承载请求，Codeestra 不向 Agent 注入伪造的自然语言同意。

## Verification

- CLI 启动 Runtime 后退出，Runtime 仍可响应后续 CLI；陈旧 endpoint/PID 不导致误连或重复拥有资源。
- IPC 仅限本用户，输入经版本化 schema 校验；未知 command/schema 明确拒绝。
- 仓库 canonical identity 改变后旧 trust 不可用于启动 Agent 或执行 hooks。
- 未批准敏感操作、CLI 断开或未知工具时均不执行工具。
- 项目信任不能替代 ADR-0003 的成果 commit 单次确认，也不能触发 main/push。

## Related

- `PROJECT_SPEC.md`
- `docs/architecture/README.md`
- `docs/architecture/agent-adapter-api.md`
- `docs/architecture/git-workspace-api.md`
- ADR-0002 / ADR-0003
