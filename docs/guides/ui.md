# Web UI（已暂停）

> **适用版本** `dev@6c7de03`（2026-09-17） · **schema** v36 · **最后校对** 2026-09-17
> 版本会前进：`dev@6c7de03` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。

ADR-0067 起，Codeestra 暂停 Web UI 开发并集中开发 CLI。

## 当前事实

- `codeestra ui` 与 `codeestra open` 已删除；传入会得到 CLI 用法错误（退出码 2）。
- `runtime.ui`、`settings.ui.*` 与 `runtime.ping.uiRunning` 已从 versioned Runtime 命令面删除。
- Runtime 不实例化本地 HTTP/SSE 服务，不托管前端静态资产。
- 默认检查、构建、重启和发布流程不再 typecheck、build、test 或启动 Web UI。
- `apps/ui/**`、`apps/runtime/src/http-api.ts` 和 UI settings 实现源码仍在仓库中，但只是静态保留：**不代表功能可用、兼容或受测试保障**。
- 全部用户操作使用 CLI；项目接入使用 `project inspect|policy|trust|list`。

## 为什么不保留隐藏入口

用户明确选择“移除入口”，而不是环境变量实验开关。隐藏入口仍会要求维护公共契约、安全边界、构建与测试矩阵，违背本轮集中开发 CLI 的目标。

## 未来恢复条件

重新启用 Web UI 必须另立 ADR，并至少恢复：

1. 明确的公共 CLI/Runtime 入口与稳定错误码；
2. loopback HTTP、token、Origin 与 SSE 的安全边界；
3. 与 CLI 同一命令面的契约校准；
4. 前端类型检查、构建与专用测试；
5. 用户文档与人工观感清单。

在这些条件完成前，不应尝试通过直接导入保留源码绕过当前禁用状态。

参见：[ADR-0067](../decisions/0067-pause-web-ui-and-cli-focus.md)、[CLI 参考](./cli/README.md)、[安装与第一次运行](./getting-started.md)。
