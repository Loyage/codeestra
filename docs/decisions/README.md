# 架构决策记录

## 已接受

- [ADR-0001](0001-runtime-safety-baseline.md)：运行修订先暂停、依赖上游进入稳定分支、独立本地 Runtime。（**Amended by ADR-0009/0011**：开发依赖进入 dev；FULL 下稳定提升不批准）
- [ADR-0002](0002-execution-and-promotion-policy.md)：首个 Adapter 为 Pi、协作取消与不抢占、Stable 切换等待排空。（**Amended by ADR-0011**：FULL 取消原生审批，STRICT 保留）
- [ADR-0003](0003-task-result-commit-policy.md)：成果 commit 固定差异、沿用 identity、执行 hooks。（**Amended by ADR-0011**：FULL 单步且不拒绝敏感路径，STRICT 保留旧门禁）
- [ADR-0004](0004-minimum-usable-runtime.md)：CLI 首入口并自动启动独立 Runtime。（**Amended by ADR-0011**：FULL 项目接入不确认、所有已注册工具自动允许；STRICT 保留旧门禁）
- [ADR-0005](0005-task-entry-and-worktree-location.md)：Task CLI 使用 Project ID，新建为 DRAFT；owned worktree 位于 Runtime 数据目录而非用户仓库。（**Amended by ADR-0009**：固定基线改为 dev）
- [ADR-0006](0006-task-verification-policy.md)：验证命令来自 main ref 人工策略并在固定 commit 副本运行。（**Amended by ADR-0011**：FULL 不确认策略，STRICT 保留）
- [ADR-0007](0007-local-web-ui-entry.md)：本地 Web UI 与 CLI 复用 Runtime 命令面。（**Amended by ADR-0008/0011**：UI 是便利层；FULL 隐藏旧确认，STRICT 保留）
- [ADR-0008](0008-efficiency-first-service-form.md)：效率至上、CLI 完备、测试仅限命令面。（**Amended by ADR-0011**：默认 FULL 零确认替代保留旧门禁）
- [ADR-0009](0009-main-dev-promotion-and-restart.md)：固定 `main`/`dev` 双分支与提升后重启。（**Amended by ADR-0011**：FULL 不批准，STRICT 保留批准）
- [ADR-0010](0010-live-agent-terminal-takeover.md)：运行中 Agent 支持原生终端完全接管；Pi 在结构化安全点做 RPC↔TUI/PTY 进程交接；会话指导与任务修订分流，单 writer lease，不新增确认门禁。（**Amended by ADR-0011**：FULL 下工具不确认）
- [ADR-0011](0011-default-full-permission-mode.md)：默认开启主机级全权限模式，现有与未来常态确认归零；保留无需确认即可切换的全局 STRICT 兼容模式。
- [ADR-0012](0012-agent-configuration-scopes.md)：Agent 配置（provider/model/thinking level）分全局默认与每项目覆盖，按 环境变量 > 项目 > 全局 > 适配器默认 逐字段解析；仅新 Session 生效，生效值写入 Execution 留痕；CLI/UI 同一命令面且不新增确认。
- [ADR-0013](0013-read-only-agent-transcript-view.md)：Agent 执行过程以只读视图呈现（`session.transcript` / `session.transcript.part`），来源是 provider 自己的会话文件；不入库、不是事件、不是 attach 也不新增门禁；长内容截断并可展开全文。
- [ADR-0014](0014-agent-structured-question-channel.md)：Agent 结构化提问通道。Codeestra 自有扩展注册 `ask_user_question`，一份问卷编码进一个 provider dialog = 一条 Attention；回答是结构化 `QUESTIONNAIRE` 而非字符串，Runtime 在记录前按被问的问卷校验，非法答案报错而不得降级为拒绝；受控启动不变，STRICT 允许该工具。

- [ADR-0015](0015-task-workbench-and-themes.md)：任务工作台重构，集中任务操作、待回答问题与执行过程；支持跟随系统/浅色/深色主题。只调整便利前端，不新增 Runtime 语义或确认步骤。

以上选择均由用户明确答复。用户给定的硬性原则见 `PROJECT_SPEC.md`，无需重复确认。

**优先级标注**：ADR-0011 是当前权限语义：默认 FULL，取消 ADR-0001/0002/0003/0004/0006/0008/0009/0010 中冲突的确认要求；STRICT 作为显式 opt-in 保留旧门禁。ADR-0009 的 `main`/`dev` 分支职责、固定 SHA/证据与提升后重启等正确性要求不变。

## 阶段准入与待决项

| 阶段 | 尚需确认/验证 | 当前处理 |
|---|---|---|
| Phase 0 纯领域工程 | 无影响该小步的未决产品语义 | 可实现 revision、Execution FSM 和测试骨架，不实现副作用 |
| Phase 1 | Pi 真实审批/交互/暂停/恢复能力与接入协议 | Pi 0.84.4 首轮 RPC spike 已完成：extension UI 可路由权限/问题，持久 conversation 可恢复；无 pause/revision ACK/live-process reconnect，见 `docs/spikes/pi-0.84.4.md`。受控 gate/framing、typed answer Operation、真实子进程 `PiRpcAdapter`、Runtime adapter registry、`task.run` 运行循环、事件 pump 与 answer 自动投递已实现；FOUNDATION-019 已在真实模型（deepseek-flash）下验收 gate 逐次审批、真实工具写入、成果 commit 与 Task verification；取消超时、禁止工具的静止性、gate 拒绝路径与孤儿进程 reconcile 仍需验证 |
| Phase 1 | Runtime 创建成果 commit 的授权、identity、hooks、staging 策略 | 已由 ADR-0003 确认，并以两步 prepare/confirm、版本化敏感路径 deny policy、ChangeSet tree 指纹与 HEAD/OID reconcile 实现；Task verification 已由 ADR-0006 实现；Integration 提升仍未实现 |
| Phase 1 | Task verification 的命令来源与执行授权 | 已由 ADR-0006 确认，并以 v6 schema、`project.verificationPolicy`/`task.verify` IPC、detached 副本、policy digest 绑定与证据记录实现；Integration verification 仍未实现 |
| Phase 1 | Task verification 隔离副本、超时与树改动语义 | 已实现副本内 argv 直接 spawn、按进程组超时停止与 tracked 改动失败；真实命令集验证与长时任务仍未实测 |
| Phase 1 | 本地 IPC、进程托管与首次项目信任入口 | 产品行为已由 ADR-0004 确认；本用户 0600/0700 socket IPC、单实例、后台进程托管与两步 trust 已实现。一次性命令与只读事件订阅同一 socket（见 `docs/architecture/event-model.md` §3.1）；订阅连接不持久化游标、无自动重连、无按 project 鉴权，客户端重连需自带 cursor |
| Phase 2 | 上游被修订时依赖锁定 revision 怎样更新 | 未明确前暂停该边调度并请求澄清，不自行跟随或固定旧需求 |
| Phase 3 | Pi 原生 TUI 接管的 PTY transport、权限模式 side channel 与 session-file 双向交接 | 产品语义已由 ADR-0010/0011 确认；实现前用真实 Pi spike 验证 RPC 安全退出→TUI resume→TUI 安全退出→RPC resume，FULL/STRICT 不因交接改变，全程不得双开 writer |
| Phase 4 | IntegrationBatch 的具体 merge commit 形态、失败批次拆分、main 已 checkout 的安全交接 | 长期目标分支已由 ADR-0009 固定：Task 先进入 dev，dev→main 需用户批准并随后重启；其余细节不自动推断 |
| Phase 7 | migration/备份兼容策略、bootstrap 自身更新授权 | 禁止自动实现不可逆升级；实现前确认 |
| 任意阶段 | 权限模式 | ADR-0011 已实现默认 FULL 与 CLI STRICT 开关；FULL 常态确认预算固定为 0，不再新增确认 |
| 任意阶段 | 新能力的 CLI 完备性 | 先判定（ADR-0008）：CLI 必须能完整完成并可脚本化驱动，UI 不得超出 CLI 能力 |
| Phase 1 | Agent 配置的适用范围、生效时机与留痕 | 已由 ADR-0012 确认并实现：全局默认 + 每项目覆盖，逐字段优先级 环境变量 > 项目 > 全局 > 适配器默认；仅新 Session 生效；生效值写入 `executions.agent_config_json`。每任务/每 Revision 固定配置未实现，也不在未确认前自行推断 |
| Phase 1 | Agent 执行过程的可见性 | 已由 ADR-0013 确认并实现：`session.transcript`/`session.transcript.part` 只读读取 provider 会话文件，不入库、不是事件也不宣称 attach；运行中由 UI 增量轮询。token 级实时（新增事件/存储）与原生终端接管（ADR-0010 Phase 3）仍未实现 |
| Phase 1 | Agent 需要决策时能否结构化提问 | 已由 ADR-0014 确认并实现：Codeestra 自有扩展注册 `ask_user_question`，一份问卷 = 一个 provider dialog = 一条 `QUESTION` Attention = 一次 answer Operation；结构化回答经 Runtime 按被问问卷校验后才记录；合法选项越界返回 `INVALID_QUESTIONNAIRE_ANSWER:*` 而非静默取消。未做：把“Agent 结束轮次并在散文里提问”识别为等待人工，以及真实模型经 Runtime 的端到端验收 |

Phase 0 不要求 Phase 7 所有发布细节已决定；Phase 1 不能以“未来会解决”绕过影响真实执行与 Git 安全的待决项。

## ADR 规则

命名 `NNNN-short-title.md`；包含 Status（Proposed/Accepted/Superseded）、Context、Options、Decision、Consequences、Verification 与关联文档。只有明确决定后才能标 Accepted。提案、技术假设和未验证能力必须分别标明。
