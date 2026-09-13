# ADR-0009：固定 main/dev 双分支、提升授权与服务重启

Status：Accepted；**Amended by ADR-0011**：FULL 下 dev→main 无需批准，STRICT 保留批准；固定分支/SHA/证据与重启要求不变。

## Context

项目此前只要求 Task branch 经 IntegrationBatch 与独立集成验证后进入 `main`，Phase 4 的 integration branch 形态仍待决定。当前仓库也只有本地 `main`。

用户现明确区分稳定运行与新功能实验：

- `main` 用于日常实际运行和开发辅助，必须保持为用户可用的稳定分支。
- `dev` 用于实验刚开发的新功能；任何完成功能都先进入 `dev`。
- `dev` 到 `main` 的合并必须由用户批准。
- `main` 更新后必须立即重启服务。

为避免继续以临时 integration branch 或直接进入 `main` 解释该流程，需要固定长期分支、Task 基线与重启语义。

## Options

1. Task/worktree 基线：(a) 从 `dev` 建立；(b) 从 `main` 建立；(c) 按任务选择。
2. `main` 更新后的重启：(a) 在 `main` 工作树执行 CLI `stop`，再以 `status` 自动拉起 Runtime 并检查响应；(b) 只规定语义，命令后定；(c) 使用外部服务管理器。
3. 当前 `dev` 初始基线：(a) 当前本地 `main`；(b) `origin/main`；(c) 只修文档，暂不创建。

## Decision

用户选择 1(a)、2(a)、3(a)。

### D01：固定双分支职责

- 本项目必须长期保留 `main` 与 `dev`，不得把二者当作可删除的临时候选分支。
- `main` 是稳定运行分支：用户日常实际运行 Codeestra，并用它辅助开发。
- `dev` 是新功能实验与集成分支。所有功能任务及其 owned task worktree 从固定的 `dev` commit 建立基线；功能完成并通过 Task verification 后，只能先经 IntegrationBatch 与独立 Integration verification 集成到 `dev`，不得直接进入 `main`。
- 开发依赖以“所需上游 revision 已验证并进入 `dev`，且其 commit 可从下游固定 `dev` 基线到达”为满足条件。进入 `dev` 不等于已发布到 `main`。
- 当前 `dev` 从当前本地 `main` 创建，因此包含本地 `main` 相对 `origin/main` 超前的 16 个提交。

### D02：`dev` 到 `main` 的唯一提升路径

- 稳定提升的候选必须是固定 `dev` SHA，目标必须是固定预期 `main` SHA；仅允许 `dev → main`。
- 每次提升都必须由用户明确批准该 candidate/main/verification 三元组。`dev`、`main` 或验证证据变化后批准立即失效，必须重建候选、重验并重新批准。
- 未获批准不得 merge、fast-forward、直接更新 `main`、push 或以其他方式让功能绕过 `dev` 进入 `main`。
- 该批准沿用 ADR-0001 D03 和 ADR-0008 的既有单次门禁，不增加第二道确认。

### D03：`main` 更新后立即重启 Runtime

- 成功更新 `main` 后，提升操作尚未完成；必须立即在 `main` 工作树执行 `bun run codeestra stop`，随后执行 `bun run codeestra status`，由 CLI 重新拉起 Runtime 并检查其可响应。
- 重启不再请求第二次确认，它是用户批准提升后的自动后置步骤。
- 只有 `main` 更新与重启/响应检查都成功，才能报告本次提升完成。重启或检查失败时保留事实并立即报告，不谎称服务已更新可用，也不擅自回滚或重写分支。
- 本要求适用于由项目工作流执行的每次 `main` 更新；当前不声称已实现对用户在系统外手动修改 `main` 的后台监控。

## Consequences

- Phase 4 的 Integration 分成两层：Task results 集成到长期 `dev`；通过用户批准后，固定 `dev` 候选提升到稳定 `main`。
- Scheduler、Workspace 与 Integration 实现必须显式记录 `dev` 基线和 `main` 提升目标，不能继续把 `main` 同时当开发基线和唯一 integration target。
- main ref 上的人工 verification policy 仍作为稳定策略来源；改变该策略来源不是本 ADR 的内容。
- `main` 工作树承担稳定运行；开发操作应在 task worktree 或 `dev` 专用工作树中进行，不在运行中的 `main` 工作树直接开发。
- Phase 7 的 CandidateVersion/bootstrap Promotion 仍负责制品和数据兼容性；本 ADR 的 Git 分支提升不替代该机制。

## Verification

- 仓库本地分支同时存在 `main` 与 `dev`，且本 ADR 建立时两者指向同一 commit。
- 新 Task workspace 的 base ref/OID 来自 `dev`，不是 `main`。
- Task 结果不能直接提升到 `main`；必须先进入 `dev` 并完成独立集成验证。
- 未携带用户对固定 dev/main SHA 与验证证据的有效批准时，`dev → main` 被拒绝；任一 ref 移动会使批准失效。
- 成功更新 `main` 的命令面测试必须断言随后执行 stop、status，并只有在 Runtime 恢复响应后报告成功。
- 所有 Git 测试使用临时仓库；不得通过测试修改本项目真实 `main`/`dev`。

## Related

- `PROJECT_SPEC.md` §2、§3、§5、§6
- `AGENTS.md`（分支与发布工作流）
- ADR-0001 D02/D03（由本 ADR 修订开发依赖和提升目标）
- ADR-0005（由本 ADR 修订 Task worktree 基线）
- ADR-0008 D01（沿用一次确认预算）
- `docs/architecture/git-workspace-api.md` §3
