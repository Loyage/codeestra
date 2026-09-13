# ADR-0006：Task Verification 命令来源与执行授权

Status：Accepted（用户明确选择两项）

## Context

Task verification 必须在固定 commit 的隔离副本上运行项目验证命令，并把结果绑定 revision/commit/policy。命令本身具有任意代码执行能力，因此"验证命令从哪来"和"谁授权执行"不能由实现便利性推导：若命令来自被测 commit 自身，一个 Task 就能改写判定自己的标准。

## Options

命令来源：
1. 项目内人工维护的策略文件。
2. 每次运行前用户逐次输入/确认命令。
3. 由 Agent 提议、用户确认。

执行授权：
1. 项目 trust 时列入并确认，policy 未变化则后续自动运行。
2. 每次验证都确认一次。
3. trust 即授权，不单独确认。

## Decision

- 验证命令来自项目内人工维护的策略文件 `.codeestra/policies/verification.json`，严格 schema、未知字段拒绝、`policyVersion` 与内容摘要版本化。文件缺失或非法时拒绝验证，Runtime 不猜默认命令。
- 策略**只从项目配置的 main ref 读取**，并按读到的 commit 记录证据。Task branch 上的同名文件不参与判定，因此 Agent 无法用更弱的命令判定自己。
- 策略内容是 `argv` 数组，Runtime 直接 spawn，绝不拼接到 shell；`cwd` 必须留在副本内；单个命令超时上限 1800s，整个策略超时总和上限 3600s。
- 授权在项目 trust 时一次性确认：CLI 展示策略摘要、命令、cwd 与超时，用户以 `TRUST` 显式确认，Runtime 在写入前重新读取并核对 state/digest/mainCommit，变化则拒绝。同一 digest 后续自动运行；策略内容变化必须重新 trust 确认。
- 确认与 trust 记录同样以追加方式保存（旧记录 SUPERSEDED），trust 失效时确认一并失效。
- 验证在 Runtime 数据目录下的 detached 副本中运行：`<CODEESTRA_HOME>/verifications/<project-id>/<verification-id>`，commit 固定为被验证 commit。不使用也不修改 Task worktree 与用户工作区。

## Consequences

- 每个新策略内容都需要一次人工确认；这是可接受的成本，因为策略就是"什么算通过"的定义，而不是可以被 Agent 顺手改掉的实现细节。
- 用户必须维护 `.codeestra/policies/verification.json`。没有策略文件的项目可以 trust，但 `task verify` 会 fail-closed 拒绝，不会回退到猜测命令。
- 验证命令以 Runtime 进程的环境变量运行（附加 `CI=1`），具备用户权限；这与 trust 提示中的提示一致。Phase 1 不提供网络或文件系统沙箱。
- 命令输出按不可信内容处理：只在调用方终端展示有界尾部；数据库只保存 exit code、时长、字节数、摘要与路径列表，不保存原始输出。
- 检测"验证命令是否改动了被测树"：tracked 修改或 HEAD 移动使该 run 变为 `ERROR/TREE_MUTATED`（不覆盖已判定的 `FAILED`）；新建的未被 Git 忽略文件只记录，不使验证失败，因为常见构建会生成此类文件。
- 超时记为 `ERROR/COMMAND_TIMEOUT` 而不是 `FAILED`：超时是需要人工处理的执行问题，不是被测对象被判失败。
- 验证可重复执行：每次 `task verify`（新 command ID）创建新的 VerificationRun，旧记录不被改写；重放同一 command ID 只返回已记录结果，不重复执行命令。
- 当出现针对新 commit 或新 policy digest 的验证时，旧的 `PASSED` 记录变为 `STALE` 并保留原结论与失效原因，`VerificationInvalidated` 记录审计。
- Runtime 重启时未完成的 run 记为 `ERROR/RUNTIME_RESTARTED` 并**保留副本路径**供检查，不假装已完成，也不在可能有孤儿进程组写副本时删除现场。

## Verification

- 缺失/非法策略、未确认策略、策略 digest 变化、Task branch 上的策略改动均拒绝或按 main 策略执行，并分别有测试覆盖。
- 命令以 argv 直接 spawn；策略 schema 拒绝绝对路径、`~`、`..` cwd 与越界 program；未使用 shell 拼接。
- detached 副本在固定 commit 创建，HEAD 与 tested commit 一致，副本删除后不残留 worktree 注册；用户仓库保持 clean。
- PASSED 需要全部命令 exit 0 且副本 tracked 内容未变化；命令失败 → `FAILED/COMMAND_FAILED` 且不继续后续命令；超时 → `ERROR/COMMAND_TIMEOUT`；树被改动 → `ERROR/TREE_MUTATED`。
- 证据绑定 `executionId`/`revisionId`/`testedCommit`/`testedTree`/`policyDigest`/`mainCommit`，且数据库不包含原始命令输出。
- trust 重复确认保留历史（旧 trust 与旧确认 SUPERSEDED，project 不重复创建）。
- Git/存储测试只操作临时仓库与内存数据库；未 update main、未 push、未修改用户工作区。

## Related

- `PROJECT_SPEC.md`（不变量 5、12、13）
- `docs/architecture/git-workspace-api.md`
- `docs/architecture/sqlite-schema.md`
- `docs/architecture/event-model.md`
- ADR-0001 / ADR-0003 / ADR-0004
