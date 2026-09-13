# 架构决策记录

## 已接受

- [ADR-0001](0001-runtime-safety-baseline.md)：运行修订先暂停、依赖上游进入 main、每批 main 提升用户批准、独立本地 Runtime。
- [ADR-0002](0002-execution-and-promotion-policy.md)：首个 Adapter 为 Pi、保留原生审批、协作取消与不抢占、Stable 切换等待排空。（**Amended by ADR-0008**：优先级表述；原审批与不抢占要求继续有效）
- [ADR-0003](0003-task-result-commit-policy.md)：每次成果 commit 前确认固定差异；沿用仓库 identity；trust 后执行 hooks；全基线差异配合敏感路径拒绝。
- [ADR-0004](0004-minimum-usable-runtime.md)：CLI 首入口并自动启动独立 Runtime；项目显式一次信任；Pi 敏感操作逐次审批、未知工具拒绝。（**Amended by ADR-0008**：CLI 定为完备命令面；信任与审批门禁保留不删）
- [ADR-0005](0005-task-entry-and-worktree-location.md)：Task CLI 使用 Project ID，新建为 DRAFT；owned worktree 位于 Runtime 数据目录而非用户仓库。
- [ADR-0006](0006-task-verification-policy.md)：验证命令来自 main ref 上人工维护的 `.codeestra/policies/verification.json`；trust 时一次性确认策略摘要，变化需重新确认；验证在固定 commit 的 detached 副本中运行。
- [ADR-0007](0007-local-web-ui-entry.md)：新增本地 Web UI 入口 `codeestra ui`；Runtime 按需启动 `127.0.0.1` HTTP + SSE，token 只存内存、经 0600 socket 取得、URL fragment 传递；UI 与 CLI 复用同一 dispatch，不绕过任何确认。（**Amended by ADR-0008**：UI 只是便利层，CLI 必须完备且优先）
- [ADR-0008](0008-efficiency-first-service-form.md)：效率至上、现有门禁冻结且不新增权限管理；软件本体是服务，CLI 为完备命令面、UI 只是便利层；自动化测试仅限 CLI/命令面，不获取电脑控制权。

以上选择均由用户明确答复。用户给定的硬性原则见 `PROJECT_SPEC.md`，无需重复确认。

**优先级标注**：ADR-0008 只修订 ADR-0002/0004/0007 的优先级与入口定位表述，**未取消** ADR-0001 D03、ADR-0003、ADR-0006 的确认门禁；这些门禁继续按原条款生效。

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
| Phase 4 | merge 形态、失败批次拆分、main 已 checkout 的安全交接 | 不自动部分提升；不更新用户工作目录；实现前确认 |
| Phase 7 | migration/备份兼容策略、bootstrap 自身更新授权 | 禁止自动实现不可逆升级；实现前确认 |
| 任意阶段 | 新增权限门禁/沙箱/多用户与密钥托管 | 不在当前范围（ADR-0008）：已实现门禁冻结、不新增；提出时必须先给出效率成本评估 |
| 任意阶段 | 新能力的 CLI 完备性 | 先判定（ADR-0008）：CLI 必须能完整完成并可脚本化驱动，UI 不得超出 CLI 能力 |

Phase 0 不要求 Phase 7 所有发布细节已决定；Phase 1 不能以“未来会解决”绕过影响真实执行与 Git 安全的待决项。

## ADR 规则

命名 `NNNN-short-title.md`；包含 Status（Proposed/Accepted/Superseded）、Context、Options、Decision、Consequences、Verification 与关联文档。只有明确决定后才能标 Accepted。提案、技术假设和未验证能力必须分别标明。
