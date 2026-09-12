# ADR-0003：Task 成果 Commit 策略

Status：Accepted（用户明确选择四项）

## Context

Phase 1 必须把 Agent 成果固定到 revision/commit，供 Task Verification 使用。Runtime 若替 Agent 创建 commit，会执行 Git 写操作与 hooks，并决定 identity 和暂存范围；这些不能从实现便利性推导。

## Options

1. Commit 授权：task worktree 自动提交 / 每次提交前确认 / 禁止自动提交。
2. Identity：沿用仓库配置 / Codeestra 专用身份 / 每项目单独配置。
3. Hooks：项目信任后正常执行 / 每次运行前确认 / 禁用。
4. Staging：固定基线全部差异并拒绝敏感路径 / 仅 tracked 文件 / 每次人工选文件。

## Decision

- Runtime 每次创建成果 commit 前都必须获得用户确认。确认固定 `taskId`、`executionId`、`revisionId`、workspace ownership、expected HEAD 与 ChangeSet fingerprint；HEAD 或差异变化使确认失效，必须重新展示并确认。
- 授权只允许在 Runtime 创建且归属已核验的 task branch/worktree 创建一个成果 commit，不包含 main 更新、merge、push、force、amend 或历史重写。
- 使用该仓库可解析到的 `user.name` 与 `user.email`。任一缺失时停止并请求用户配置；Runtime 不静默写 local/global Git config，也不伪造身份。
- 项目通过 trust 后，commit 正常执行其 Git hooks。Hook 失败则本次 commit 失败并保留现场；不自动使用 `--no-verify`，也不因重试重复执行未知副作用。恢复先核对 HEAD/commit 事实。
- 暂存 owned worktree 相对固定基线的全部新增、修改、删除和 rename。Runtime 在暂存前执行敏感/运行数据路径策略；命中 `.env` 类秘密、Codeestra 数据库/日志/session、worktree 运行数据或其他 deny policy 时 fail-closed，请求用户处理，不静默忽略后提交不完整成果。
- 只有 diff 未变化、HEAD 仍等于授权值、Agent/owned writers 已证实静止、当前 applied revision 匹配时才能消费确认。成功后记录 commit/tree 和实际 identity/hook 结果证据。

## Consequences

Phase 1 不是无人值守自动交付：Agent 完成后 Task 会等待一次成果 commit 确认，其他合格任务以后仍可继续。确认是单次、绑定精确快照的能力，不是对仓库的长期写授权。

运行 hooks 具有任意代码、网络与凭据访问风险，因此首次项目 trust 必须明确展示边界。Hook 超时或 commit 成功但数据库回写失败不能盲重试；Operation 进入 reconcile，按 expected HEAD 和已生成 commit 核对。

“全部基线差异”避免漏掉 Agent 新建文件，但敏感路径识别不能宣称能检测所有秘密。验证与用户确认仍应展示机器可读 ChangeSet；原始文件内容和 secrets 不写入普通事件。

## Verification

- 未有有效确认时 `captureResult` 不调用 `git add`/`git commit`。
- 确认后的 HEAD、tree fingerprint 或 revision 变化会拒绝提交并使确认失效。
- identity 缺失、项目未 trust、敏感路径命中、hook 失败均不产生成功成果记录。
- 测试 hooks 正常执行且 `--no-verify` 未使用；hook 失败保留 staged/worktree 现场。
- commit 成功但 Runtime 崩溃可通过 HEAD/OID reconcile 补记，不重复运行 hook。
- 所有 Git 测试仅操作临时仓库；不 update main、不 push、不 force、不改用户 Git config。

## Related

- `PROJECT_SPEC.md`
- `docs/architecture/git-workspace-api.md`
- `docs/architecture/sqlite-schema.md`
- ADR-0001 / ADR-0002
