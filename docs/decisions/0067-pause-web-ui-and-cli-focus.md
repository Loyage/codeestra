# ADR-0067：暂停 Web UI，集中开发 CLI

Status：Accepted（用户 2026-09-17 明确决定）

## Context

Codeestra 的第一原则一直要求 CLI 是完备、可脚本化的权威命令面，Web UI 只是便利前端。当前 Web UI 已带来独立的 React/Vite 构建、HTTP/SSE 入口、界面设置、测试矩阵和发布步骤；这些成本会分散 CLI 命令面开发。

用户决定先放弃 Web UI 开发，专攻 CLI 接口；Web UI 功能源码可以保留，但默认不得启用，并删除 Web UI 相关测试代码。随后进一步确认：

1. 从 CLI 与 Runtime 移除 Web UI 入口，而不是保留可用入口或新增实验开关；
2. 删除 `apps/ui` 测试及只服务 Web UI 的 HTTP/`runtime.ui`/`open` 测试，保留共享 CLI/Runtime 测试；
3. 默认开发、检查、重启与发布流程完全不再类型检查、构建或启动 Web UI。

## Options

1. **移除入口，保留实现源码。** 默认产品只有 CLI/Unix socket 命令面；以后恢复 UI 必须重新做显式决策和验证。
2. **环境变量实验开关。** 默认关闭，但仍维护入口、契约与测试分支。
3. **只停止新增功能。** `ui`/`open`、HTTP 服务、UI 构建与测试保持现状。

选择方案 1。方案 2 仍要求维护一套隐藏产品面；方案 3 不满足“功能代码保留但不启用”。

## Decision

### D01：CLI/Runtime 入口移除

- 删除 CLI `ui` 与 `open` 命令；项目接入使用既有 `project inspect|policy|trust|list`。
- 从 versioned Runtime 请求 union 与 dispatch 删除 `runtime.ui`；Runtime 不再实例化 `RuntimeHttpApi`，不会启动 Web UI HTTP/SSE 服务。
- `runtime.ping` 删除 `uiRunning`，Runtime 恢复判据只要求 `status: READY`。
- 删除 `settings ui list|get|set|reset` 命令与 `settings.ui.*` Runtime 请求；`settings list` 只枚举当前启用的权限模式、散文问题处理与全局并发上限。
- 这是有意的公共命令面删除。旧命令按未知命令处理（CLI 退出码 2，直接 Runtime 请求不通过 schema）。不提供兼容别名，也不增加确认步骤。

### D02：源码保留但不可达

- 保留 `apps/ui/**`、`apps/runtime/src/http-api.ts`、UI settings 的实现与 contracts 源码，作为暂停前实现的静态代码。
- 默认 Runtime、CLI 和发布路径不导入、实例化或暴露这些实现。
- 保留源码不等于宣称 Web UI 可用或受支持。重新启用必须另立 ADR，恢复公开契约、威胁边界、文档和测试后才能交付。

### D03：测试删除

- 删除 `apps/ui` 全部测试。
- 删除只验证 Web UI 的 `cli-open`、`cli-ui-settings`、`http-api`、UI settings storage 测试，以及共享测试里的 Web UI HTTP client/SSE 专用段落。
- 共享 CLI/Runtime 测试不删除；原先借 `open` 完成 fixture 注册的地方改用 `project trust`。
- 自动化验收继续只使用 CLI、Unix socket Runtime 命令面及其 versioned framing；Web UI HTTP 传输不再属于启用的验收面。

### D04：默认工程与发布流程

- `bun run check`、`check:fast`、Vitest 配置与 `Justfile` 不再 typecheck/build/test Web UI。
- `restart-main`、`restart-dev`、`promote-main` 不再构建或启动 Web UI，也不再检查 `uiRunning`。
- `apps/ui` 源码仍保留在仓库，但不属于当前默认质量门或发布产物。

## Consequences

- 当前用户入口只有 CLI；所有新增能力优先完成 `--json`、稳定退出码和 Runtime 命令契约。
- Web UI 不可启动，旧 `codeestra ui`、`codeestra open` 与 `settings ui …` 脚本会以 usage error 失败。
- 不再维护暂停代码的自动化回归保证；源码未来可能随共享契约演进而漂移。重新启用时必须先完成校准，不能把“源码还在”当成“功能仍可用”。
- `project trust` 取代 `open` 的项目接入用途；它仍遵循 FULL 零确认 / STRICT 显式确认语义。
- 无 schema 变更；已有 `$CODEESTRA_HOME/ui-settings.json` 不删除、不迁移，当前 Runtime 只是忽略它。
- 不增加权限门禁、审批、等待或数据模型。

## Verification

- `bun run typecheck`：默认 TypeScript 检查只覆盖 CLI/Runtime/packages，且不引用 Web UI 启动路径。
- contract test：`runtime.ui` 与 `settings.ui.*` 不在 request union；其它 Runtime 请求继续通过。
- CLI 定向测试：项目 fixture 使用 `project trust`；Task 创建、Attention、Operation progress 与设置命令继续工作。
- 静态检查：默认 scripts、`Justfile`、Runtime dispatch 和 CLI usage 中没有 UI build/start 命令。
- 不运行 Web UI 测试或构建；这正是本决策的边界，不得据此声称保留源码可运行。

## Related

- ADR-0007（本 ADR 暂停其入口与验证要求；历史决定保留）
- ADR-0008（CLI 完备的第一原则继续有效）
- ADR-0009/0047/0048（本仓库人工提升/重启流程中的 UI 构建与启动步骤由本 ADR 删除）
- ADR-0045（UI settings 命令面由本 ADR 暂停，存储源码与已有文件保留）
- ADR-0049（dev UI 构建通道已先由 ADR-0066 删除；本 ADR 进一步移除默认 UI 构建）
- ADR-0050（用户文档同步纪律）
- ADR-0064（`settings list` 的闭合集合缩为当前启用设置）
