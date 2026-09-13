# ADR-0011：默认全权限模式与零确认常态路径

Status：Accepted（用户明确选择：覆盖全部确认、主机级全权限、默认开启、保留 CLI 严格模式开关，并立即修改现有 Phase 1 实现与未来规范）

## Context

用户将效率置于当前安全设计之前，要求 Codeestra 提供默认开启的全权限模式：Agent 使用当前系统用户的全部主机权限，所有现有与未来确认均不再阻塞常态路径。用户同时要求保留一个无需确认即可启用的严格模式。

这项决定与 ADR-0001 D03、ADR-0002 的原生审批、ADR-0003 的成果 commit 确认、ADR-0004 的 project trust/工具审批、ADR-0006 的策略确认、ADR-0008 的“保留既有门禁”以及 ADR-0009 的 dev→main 批准直接冲突，必须显式修订，不能把“全权限”只实现成 UI 文案或局部工具 allowlist。

## Options

1. 取消范围：全部确认 / 除稳定提升外全部 / 仅 Agent 工具。
2. 主机权限：当前用户主机级全权限 / 仅 worktree / 仅已知工具。
3. 退出方式：保留全局 CLI strict/full 开关 / 固定全权限 / 按项目覆盖。
4. 实施范围：现有实现并约束未来 / 仅现有实现 / 仅设计。

用户选择全部确认、主机级全权限、保留全局 CLI 开关、现有实现并约束未来。

## Decision

### D01：默认模式

- Runtime 权限模式为 `FULL | STRICT`，缺少配置时必须解析为 `FULL`。
- `codeestra permission get` 查询当前模式；`codeestra permission set full|strict` 立即持久化到 `$CODEESTRA_HOME/permission-mode.json`（0600，原子替换）并影响后续操作与新 Agent Session，切换本身不请求确认。持久值损坏时 Runtime 明确拒绝启动而不是默默改变模式。
- 已启动 Session 沿用其启动时模式，不在工具执行中途改变 gate 语义。
- Web UI 明确显示当前模式，并与 CLI 使用同一 Runtime 命令面。

### D02：FULL 模式

FULL 的常态确认成本为 **0 步、0 等待**：

- 项目接入不要求输入 `TRUST`；仍核对 canonical repository identity 与读取策略快照，以防请求作用于错误对象，但该核对不是用户审批。
- Pi 的所有已注册工具均自动允许，包括 Codeestra 未知名称的工具；不要求 RPC UI channel，不使用工具 allowlist。工具可按当前系统用户权限访问 worktree 外路径、网络、进程与凭据。
- 成果 commit 不要求两步确认；`task result capture` 在一个命令中固定 ChangeSet 并创建 commit。FULL 不应用敏感路径 deny policy。
- verification policy 仍必须来自 main ref、通过严格 schema，并绑定 digest/commit 证据；策略新增或变化无需人工确认即可执行。
- 未来 Integration、`dev → main`、Self Promotion 及其他能力不得新增批准/确认。用户发起某项命令是操作意图，不再追加“是否确定”的审批步骤。
- 不移除 revision/commit/ref/ownership/process identity、DAG、状态机、幂等、静止证据和崩溃 reconcile 等正确性检查；这些检查防止系统把命令施加到错误对象或伪造事实，不是权限门禁。

### D03：STRICT 模式

STRICT 是显式 opt-in 的兼容模式，保留此前行为：项目 trust、Pi 写入/shell 逐次审批、未知工具拒绝、敏感路径拒绝、成果 commit 两步确认、verification policy digest 确认，以及尚未实现能力原先定义的确认。STRICT 不得变成默认值，切换到或离开 STRICT 均不要求确认。

### D04：覆盖关系

本 ADR 修订以下已接受决策中的确认要求：

- ADR-0001 D03、ADR-0009 D02：FULL 下 dev→main 不需要批准；固定 SHA、验证证据、更新后 stop/status 重启要求继续有效。
- ADR-0002：FULL 下不保留或自动路由 Pi 权限审批；取消/抢占/排空语义不变。
- ADR-0003：FULL 下成果 commit 单命令执行且不应用敏感路径拒绝；identity、hooks、快照核对、归属与 reconcile 不变。
- ADR-0004：FULL 下项目接入与工具执行不确认，未知已注册工具允许；本机 Runtime/typed answer 等其他条款不变。
- ADR-0006：FULL 下验证策略无需确认；策略来源、schema、隔离副本与证据绑定不变。
- ADR-0008 D01/D02：以本 ADR 的零确认默认值替代“既有门禁继续有效”；CLI 完备与测试边界不变。
- ADR-0010 D01/D06：未来原生终端接管在 FULL 下不得重新引入工具确认；安全点、单 writer 与进程交接仍是正确性条件。

## Consequences

- 用户常态路径不再等待 project trust、工具 permission、策略变化或成果 commit 确认，吞吐提高。
- FULL 允许 Agent、验证命令和 Git hooks 以当前用户权限读取、修改或删除任意可访问数据、联网、启动进程；误操作、恶意仓库和提示注入可直接造成主机级副作用。该风险是用户为效率明确接受的产品行为，不宣传为隔离环境。
- FULL 下敏感文件可以进入成果 commit；Codeestra 不再代用户阻止。
- STRICT 保留可逆退出方式，适合临时处理不可信项目，但不影响默认全权限语义。

## Verification

仅通过 CLI/Runtime 命令面及临时仓库验证：

1. 新 Runtime 无配置时 `permission get` 与 `runtime.ping` 均报告 `FULL`；set strict/full 持久化且无需确认。
2. FULL gate 对 write/bash/未知工具、无 UI channel 与不可序列化输入均直接允许；Pi argv 不含工具 allowlist。
3. STRICT 保留原工具分类、逐次审批、未知工具拒绝和受控 allowlist。
4. FULL 项目首次 `open` 在 stdin 不可用且无 `--yes` 时成功；STRICT 同场景拒绝。
5. FULL 可用单条 `task result capture` 创建成果 commit，并允许敏感路径；STRICT 单步命令拒绝且保留 prepare/confirm。
6. FULL 在 policy digest 变化后可直接验证；STRICT 仍拒绝未确认策略。
7. Web UI 在 FULL 下不显示 TRUST 输入或成果 commit 二次确认。
8. 不操作真实用户仓库的 ref，不使用桌面/键鼠自动化。

## Related

- `PROJECT_SPEC.md` §1.1、§2、§6
- ADR-0001/0002/0003/0004/0006/0008/0009/0010
- `docs/architecture/agent-adapter-api.md`
- `docs/tasks/README.md` FOUNDATION-025
