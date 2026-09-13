# ADR-0012：Agent 配置（模型、Provider、思考深度）的作用域、生效与留痕

Status：Accepted（用户在本轮四题选择题中明确选择：全局默认 + 每项目覆盖；provider + model + thinking level；仅新 Session 生效并记录到 Execution；持久化配置 + 环境变量为高优先级覆盖）

## Context

在此之前，Codeestra 只把模型与 Provider 作为 Runtime 进程的环境变量读取（`CODEESTRA_PI_PROVIDER` / `CODEESTRA_PI_MODEL`），在 Adapter 注册时写死为启动参数。这带来三个已被记录在案的问题（`docs/tasks/README.md` FOUNDATION-022「剩余问题」）：

1. 切换模型必须重启 Runtime，CLI 侧只能写 `CODEESTRA_PI_PROVIDER=… bun run codeestra stop && … open`；
2. 不同项目共用一份进程级配置，无法让某个仓库使用不同的模型；
3. 界面不显示当前模型，历史 Execution 也不记录某次结果由哪个模型产生。

Pi 0.84.4 支持 `--provider <name>`、`--model <pattern>`、`--thinking <off|minimal|low|medium|high|xhigh|max>`，并在模型能力不足时自行钳制思考等级。

同时必须遵守既有不变量：Execution 的证据绑定 revision/commit；Agent 启动参数应稳定可复现；`packages/agent-adapters` 只依赖 Adapter 合约，不依赖数据库或具体配置来源；CLI 必须能完整完成任何能力（ADR-0008），且 FULL 下不得新增确认（ADR-0011）。

## Options

用户本轮逐项选择（括号内为未选项）：

1. 作用域：**全局默认 + 每项目覆盖**（全局单份 / 全局 + 每任务 / 全局 + 项目 + 任务三层）。
2. 可配置项：**provider + model + thinking level**（再加 `--models` 轮换 / 再加自由额外 argv）。
3. 生效与留痕：**仅新 Session 生效 + 记录到 Execution**（不写执行历史 / 快照进 TaskRevision）。
4. 配置来源：**持久化配置 + 环境变量为高优先级覆盖**（env 仅作首次默认 / 只用持久化配置）。

## Decision

### D01：作用域与优先级

- 配置按 Adapter 键控，分两种作用域：`GLOBAL`（每 Adapter 一条）与 `PROJECT`（每项目每 Adapter 一条）。持久化在数据库中，带有 `updated_at` / `updated_by`。
- 解析是**逐字段**合并，而不是整层覆盖：环境变量 > 项目覆盖 > 全局默认 > Adapter 自身默认。项目只覆盖模型时，Provider 与思考深度仍继承全局值。
- 环境变量映射只对已注册的 Adapter 定义；当前仅 Pi：`CODEESTRA_PI_PROVIDER`、`CODEESTRA_PI_MODEL`、`CODEESTRA_PI_THINKING`。变量为空或全空白视为未设置。
- 环境变量中非法的思考等级**报错**（`INVALID_AGENT_CONFIGURATION`），不静默回退：默默运行一个与请求不同的模型会让 Execution 记录的配置变成假话。

### D02：可配置字段

- 字段固定为 `provider`、`model`、`thinkingLevel`（`off|minimal|low|medium|high|xhigh|max`）。不接受自由额外 argv：它会造成参数注入与“同一 revision 启动参数不稳定”。
- 未设置的字段不传对应 flag，保留 Pi 自身默认；Codeestra 不替用户锁定一个可能随后漂移的默认值。
- 模型/Provider 的具体取值不在 Codeestra 侧校验：没有能力目录就别假装有。不存在的模型由 Pi 在启动时报错，Runtime 按既有失败路径honest 记录，不伪造成功。

### D03：生效时机

- 配置在 **Execution 预留时**解析并固定；变更只影响此后新建的 Session/Execution，运行中的 Session 保持其启动时的值。
- 修改配置不需要重启 Runtime，也不需要任何确认；这与 `permission.set` 的“影响后续操作与新 Session”语义一致。
- 不因配置变更中断或重启运行中的 Agent（Pi 无 in-place 换模型，强行重启等于丢弃工作）。

### D04：留痕与证据

- 解析后的生效值写入 `executions.agent_config_json`，随 `task.status`、CLI 与 Web UI 暴露，因此历史结果可以回答“这次是谁跑的、用什么模型、什么思考深度”。
- Adapter 启动时使用且只使用该已记录的值（`AgentStartRequest.agentConfig`），不会在启动时重新读取可变的全局状态；stop evidence 的摘要包含模型参数。
- 配置变更本身不写 domain event、不进入 outbox（与 `permission.set` 一致），但记录 `updated_at` / `updated_by`。
- 未设置任何覆盖的 Execution 记录为 `null`，使“走 Adapter 默认”与“显式配置成某值”可区分。

### D05：命令面

同一 versioned 命令面上新增（UI 与 CLI 共用，UI 不新增语义）：

- `agent.config.get`：返回全局记录、项目记录、环境变量覆盖、逐字段 `effective` 与 `sources`。解析规则只在 Runtime 实现一次，客户端不重复实现优先级。
- `agent.config.set`：按字段合并；字段缺省表示“不变”，`null` 表示“清除”；某作用域字段全部为空时删除该记录，避免它继续遮蔽更低优先级。`PROJECT` 必须给出 `projectId`，`GLOBAL` 不得给出。
- `agent.config.clear`：删除一个作用域的记录，返回是否确实存在。

CLI：`codeestra agent config get|set|clear [--project <id>] [--adapter <id>]`，`set` 支持 `--provider` / `--model` / `--thinking` 与 `--unset provider|model|thinking`。

### D06：不新增门禁

配置读写不做确认。FULL 与 STRICT 的区别只体现在既有门禁上，本能力不因权限模式改变行为；`updated_by` 在两种模式下都记为 `local-user`，因为这是用户自己发出的命令，不是 Runtime 代行的授权。

## Consequences

- 换模型不再需要重启 Runtime，且可以为单个仓库设置更强的模型；UI 能显示当前生效值与来源。
- Execution 记录变大（一个可为 NULL 的 JSON 列），历史结果可解释；旧 Execution 该列为 NULL，表示当时没有配置记录，不回溯改写。
- 模型 ID 写错不会在保存时被拒绝，而是在运行时由 Pi 报错；这是一条诚实的失败路径，不是静默降级。
- 环境变量仍能覆盖持久化配置。若用户环境中残留 `CODEESTRA_PI_*`，CLI 与 UI 会显示 `sources: ENVIRONMENT`，可解释但不阻止——需要用户自行清理。
- Task revision 不包含配置：同一 revision 在不同配置下重跑会得到不同结果的 Execution 记录。复现“完全相同的一次执行”需要同时固定 revision 与配置，这一点目前由 Execution 记录表达，而不是由 revision 强制。

## Verification

通过 CLI/命令面与临时仓库验证（不使用桌面自动化，ADR-0008）：

1. 存储：v7 → v8 迁移新增 `agent_configurations` 与 `executions.agent_config_json`，`foreign_key_check` 为空；全局/项目记录互不影响；部分更新只改指定字段；字段全清后记录被删除；非法 thinking level 被 schema 与列约束双重拒绝。
2. 解析：无覆盖时 `effective` 为空、`sources` 全为 `DEFAULT`；项目只覆盖一个字段时其余继承全局；环境变量覆盖优先级最高且 `sources` 标为 `ENVIRONMENT`；空白环境变量视为未设置；未知 Adapter 无环境映射；非法环境 thinking 抛 `INVALID_AGENT_CONFIGURATION`。
3. Adapter：给出 `agentConfig` 时 argv 含 `--provider` / `--model` / `--thinking`；未给出时三者都不出现（保留 Pi 默认）。
4. CLI 端到端（真实 CLI 子进程 + 独立 `CODEESTRA_HOME` + 临时仓库）：`agent config get` 初始为默认；`set` 全局后 `sources` 为 `GLOBAL`；`set --project` 只覆盖指定字段；`clear --project` 后回落全局；`--unset` 单字段清除；`CODEESTRA_PI_MODEL` 使 `sources` 变为 `ENVIRONMENT`；非法 thinking 与不存在的项目被拒绝。
5. 未执行：以真实模型/Provider 跑一次带显式 `agentConfig` 的 `task.run`（本轮未消耗真实额度），因此“真实 Pi 按新配置启动”只由 argv 与协议层测试证明，不等于真实执行验收。

## Related

- `PROJECT_SPEC.md` §2（不变量 8/9、13）、§6、§8
- ADR-0008（CLI 完备、测试边界）、ADR-0011（FULL 零确认）
- `docs/architecture/agent-adapter-api.md`、`docs/architecture/sqlite-schema.md`
- `docs/tasks/README.md` FOUNDATION-022 剩余问题、FOUNDATION-028
