# ADR-0038：开发分支定向测试与 dev 提升前全量测试

Status：Accepted（用户明确要求：开发分支不跑全量测试；建分支时按开发方向选择少量相关测试；全量测试只在 `dev` 上运行，并且是 `dev → main` 前的必做项）

## Context

当前仓库同时存在两类验证习惯：开发 lane 经常在交付前运行 `bun run check`，而 `.codeestra/policies/verification.json` 也把同一全量命令用于 Task verification。随着测试数量增长，全量测试在每条开发分支重复执行，显著拉长并行开发与反馈时间。

用户要求把验证成本按分支职责分层：开发分支只验证本次改动最相关的少量测试；长期集成分支 `dev` 承担跨模块全量回归；全量回归是 `dev` 提升到稳定 `main` 前的硬性条件。

这里的“开发分支”包括 `task/*`、`lane/*`、feature 分支与 Self Task candidate 分支，不包括长期 `dev`。这里的“全量测试”包括 `bun run check`、`just check`、`just verify`，以及任何等价地遍历全仓测试并构建全部资产的命令。

## Options

1. 每条开发分支都运行全量测试，`dev` 再重复一次。
2. 开发分支运行建分支时选定的定向测试；仅在 `dev` 上运行全量测试，并把它作为 `dev → main` 的必备证据。
3. 开发分支不做测试，仅在 `dev` 上首次验证。

用户选择 2。

## Decision

### D01：建分支时确定定向测试

- 创建开发 branch/worktree 时，必须根据任务的开发方向同时写下定向测试计划，列出少量、具体的测试文件或窄命令，并说明它们覆盖的模块或不变量。
- 选择以改动边界为准：domain 改动选择对应纯函数测试；storage/migration 选择相关真实 SQLite 测试；Git 改动选择对应临时仓库测试；Runtime/CLI 改动选择相关命令面测试；UI 改动选择相关类型检查、构建或 headless HTTP/命令面断言。
- 开发范围扩大时同步更新计划；不能因为原计划过窄而把未覆盖部分静默留到 `dev`。
- 分支交付记录只声明实际运行过的命令与结果，未运行的检查明确标注。

### D02：开发分支禁止全量测试

- `task/*`、`lane/*`、feature 与 Self Task candidate 分支不得运行全量测试；默认也不运行覆盖大部分仓库的聚合命令来变相替代定向测试。
- 开发中和交付前只运行 D01 选定的定向测试；失败时先修复并重跑相关测试，不以启动全量测试作为排障默认动作。
- `bun run check`、`just check`、`just verify` 及等价全仓命令保留给 `dev`。`check:fast` 仍是聚合检查，不是建分支时“挑几个测试”的默认替代品；只有任务确实横跨其覆盖边界且交付记录说明理由时才可使用。

### D03：全量测试只在 dev，且是提升前硬门槛

- 所有待提升改动集成到 `dev` 后，在 `dev` 工作树对**精确候选 SHA**运行一次全量测试。
- 全量测试通过是 `dev → main` 的必备证据；没有该证据不得准备、批准或执行稳定提升。
- 全量测试后若 `dev` HEAD、测试配置、锁文件或候选内容变化，原证据失效，必须在新的精确 SHA 上重跑。
- 这项要求不表示每次 `dev` 上的文档编辑都立即跑全量测试；触发点是准备 `dev → main` 稳定提升。

### D04：当前自动化缺口必须如实报告

- 当前 Runtime 的 Task verification 从 main ref 读取单一 `.codeestra/policies/verification.json`，本仓库该策略仍执行 `bun run check`；稳定提升目前复用 IntegrationBatch 的验证记录，并没有单独表达“精确 dev SHA 的提升前全量回归”。
- 因此本 ADR 先确立所有开发分支立即遵守的协作规则，但**不声称产品命令面已经自动执行或强制该分层**。后续实现需要让 Task/branch 记录可绑定定向测试计划与证据，并让 promotion 消费独立的 dev 全量测试证据；在完成前不得把现有 `task verify`/Integration verification 误报为已满足本 ADR。
- 本轮不静默改写人工维护的 `.codeestra/policies/verification.json`，因为固定项目级命令无法表达“按开发方向选择测试”；用另一个固定宽测试替换全量命令同样不满足 D01。

## Consequences

- 开发 lane 的反馈更快，避免并行分支重复支付相同的全仓回归成本。
- 跨模块回归可能更晚在 `dev` 暴露；代价由提升前固定 SHA 的强制全量测试承担。
- 分支创建/交付需要一份简短的定向测试计划与实际结果，不新增用户审批步骤。
- ADR-0006 的策略来源、隔离副本和证据绑定要求继续有效，但“每个 Task 使用同一全量策略”的现有落地需要调整；ADR-0009/0022 的稳定提升证据增加“精确 dev SHA 全量测试通过”要求；ADR-0018 的独立集成验证不能替代这份提升前全量证据。

## Verification

- `AGENTS.md` 明确开发分支的禁跑命令、建分支时的定向测试计划和 `dev → main` 前的全量测试要求。
- `README.md` 与 `Justfile` 不再把全量命令描述为开发分支或普通提交前门禁。
- `PROJECT_SPEC.md` 与架构测试边界区分 branch-targeted verification 和 dev promotion full-suite verification。
- 本次仅修改文档，不运行全量测试；检查文档差异、链接与关键词即可。全量测试留到下一次固定 `dev` 候选提升前执行。

## Related

- `PROJECT_SPEC.md` §3
- `AGENTS.md`「实现与验证」
- `README.md`「本地检查」
- ADR-0006（Task Verification 命令来源与证据）
- ADR-0009（固定 main/dev 与稳定提升）
- ADR-0018（Task 成果集成到 dev）
- ADR-0022（稳定提升产品能力）
