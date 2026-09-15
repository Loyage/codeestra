# ADR-0039：分层验证证据（定向测试计划 + 精确 dev SHA 全量测试）

状态：Accepted（实现于 FOUNDATION-065，schema v25；基线 `dev = fd3d99871a40e578105036bc6728213adf302c6a`）

## Context

ADR-0038 确立了分层验证的**规则**：`task/*`、`lane/*`、feature 或 Self Task candidate 分支在创建时就固定少量定向测试并禁止跑全量；所有改动集成进长期 `dev` 后，`dev → main` 之前必须对**精确候选 SHA** 跑一次全量测试，候选、测试配置或锁文件变化即失效。ADR-0038 的 D04 同时如实写明：**当时的命令面无法表达这层语义**——Task verification 只从项目 `main` ref 读取单一 `.codeestra/policies/verification.json`（本仓该策略是 `install` + `bun run check`），而 promotion 只消费 IntegrationBatch 的集成验证记录，没有任何「精确 dev SHA 全量测试通过」这种独立证据。ADR-0038 因此明确要求不得声称已实现。

本 ADR 关闭该缺口。它必须同时满足 PROJECT_SPEC §1.1 的三条第一原则：CLI 完备可脚本化、FULL 零新增确认、验证只用 CLI/命令面且不引入桌面控制权。

需要解决的三个具体问题：

1. **分支的测试范围现在只是文字约定。** 没有任何记录把「这条分支决定用哪几个测试」绑到具体的 Task/revision/commit 上，因此无法被 Runtime 消费，也无法在范围变化时留下审计。
2. **Task verification 只能跑固定全量策略。** 开发分支验证因此要么违反 ADR-0038（跑全量），要么必须手工跑测试而没有任何证据。
3. **提升证据缺少「全量测试」这一项。** `promotion prepare/approve/promote` 无法拒绝一个没有全量证据的候选。

未决的产品/数据语义由协调者裁决后实现（Q1–Q8 逐题答复，见「Decision」中的引用）。

## Options

### 定向测试计划（Q1）

- **A（选定）：仓库跟踪文件 + append-only 记录。** 分支把这套测试写进 `.codeestra/tests.json`（范围说明 + 1–16 条 argv 命令，每条都要说明覆盖什么），Runtime 在建/交付时把它**快照**成一条绑定 `(task, revision, commit, digest)` 的 append-only 记录；verification 只消费**已记录**的计划，绝不读取文件本身。
- B：只存 Runtime 数据库，由 `task tests set --test <file>` 写。缺点：范围不随 commit 走，Git 评审看不到，无法在 clone 别的机器上复现。
- C：放进 TaskRevision 快照。缺点：改测试范围会变成规格修订，把「测试范围」和「用户意图」混成一个审计链。

A 使文件成为分支自己声明的事实（随 commit 走、可评审），使**记录**成为 Runtime 消费的事实（可审计、可绑定）。范围变化 = 追加一条新记录，而不是静默改一条旧记录。

### dev 全量证据的生产者（Q2）

- **A（选定）：Runtime 运行并观察。** 客户端不能提交结果。
- B：CLI 客户端在 `dev` 工作树跑，Runtime 只记录自报结果。缺点：把整条流水线最强的门禁降级为「请相信我的 shell」。
- C：两者都要。缺点：两套证据强度不同，会诱导把弱的那套当等价物。

### 全量命令的定义与绑定（Q3）

- **A（选定）：命令来自项目 `main` ref 的固定策略。** 候选不能改写判定自己的命令；证据绑定 `dev` SHA + 该策略 digest + 候选 commit 处的锁文件 digest。
- B：命令来自 dev 候选自己的策略文件。缺点：候选可以同时改代码和改判定它的命令。
- C：由 CLI 显式传入 argv。缺点：没有可评审的、随项目走的「这个项目怎么判定自己」的固定来源。

### 其他（Q4–Q8）

- Q4 = A：本格**不修改**本仓 `.codeestra/policies/verification.json`（人工维护，位于 `main` ref）。该策略继续作为固定项目策略存在并可用。
- Q5 = A：UI 不在本格范围，不动 `apps/ui/**`。
- Q6 = A：占用 schema **v25**，新增两张 append-only 表（`targeted_test_plans`、`dev_full_suite_evidence`）。
- Q7 = A：新增稳定码 `DEV_FULL_SUITE_EVIDENCE_MISSING`、`DEV_FULL_SUITE_EVIDENCE_NOT_PASSED`、`DEV_FULL_SUITE_EVIDENCE_STALE`（均 exit 1）；沿用既有 STALE 与批准失效语义。
- Q8 = A：Task verification 默认 `AUTO`：有匹配的已记录计划就用它，否则用固定项目策略；响应记录 `policySource`，并提供 `--policy auto|targeted|project` 覆盖。

## Decision

### D01 定向测试计划是绑定到精确 subject 的 append-only 记录

- 声明文件 `.codeestra/tests.json`（`packages/contracts/src/targeted-test-plan.ts`）：`version: 1`、必填 `scope`（这条分支的改动方向）、1–16 条命令；每条命令沿用 verification policy 的 argv/cwd/timeout 校验（argv 数组、绝不拼接 shell、program 不得绝对路径/`~`/`..`），并**必须**写 `covers`（这条命令负责什么）。「跑这个文件」而不说为什么，正是 ADR-0038 要求分支交代的东西。
- `task tests record <project> <task> [--commit <full-sha>] [--expected-plan-digest <sha256>]` 从**被测 commit**（默认该 revision 已 capture 的 result commit）读取文件、校验、算 digest，然后追加一条 `targeted_test_plans` 记录，绑定 `(project, task, revision, tested_commit, plan_version, plan_digest, source_path, commands, scope, recorded_by, recorded_at)`。
- 记录是 append-only：迁移里的触发器直接拒绝 `UPDATE` 与 `DELETE`（与 `task_dependencies` 同一纪律）。相同 digest 记同一 subject 是幂等重放；不同 digest 追加新行、旧行保留为审计。因此**范围扩大或收窄都不是静默生效**：它是一次显式、可追溯的追加。
- `--expected-plan-digest` 是显式 CAS：调用者声明「我知道当前记录是这个 digest」，与事实不符即拒绝（即使它准备记录的 digest 恰好相同），避免在过期视图上改范围。
- 文件只在 `record` 时被读取。verification **不读文件**，只读记录——所以「改了一个 commit 里的文件」不会改变判定。

### D02 Task verification 消费记录并如实记录来源

- `verification_runs` 增加 `policy_source`（`PROJECT_POLICY | TARGETED_TEST_PLAN`）、`plan_id`、`plan_version`、`plan_digest`（`ALTER TABLE ... ADD COLUMN`，v25）。
- `policy_source` 是记录的**事实**，不是从 digest 猜出来的：同一份 digest 无法说明它来自固定策略还是分支计划，报告必须说清哪一个是本次运行的判定命令集。
- 选择规则（纯领域，`packages/domain/src/verification-evidence.ts`）：
  - 该 Task 从未记录过计划 → `PROJECT_POLICY`（保持既有行为，固定策略仍可用）。
  - 最新记录精确匹配本次 `(task, revision, commit)` → `TARGETED_TEST_PLAN`。
  - 最新记录属于别的 revision 或 commit → **拒绝**（`TARGETED_TEST_PLAN_REVISION_MISMATCH` / `..._COMMIT_MISMATCH`），不静默改用固定策略：静默替换判定命令集就是在重新解释规格。
- `--policy project` 仍可显式选择固定策略（用于与既有证据对照）；`--policy targeted` 在没有匹配记录时以 `TARGETED_TEST_PLAN_NOT_RECORDED` 拒绝。
- **STRICT 门禁不变**：STRICT 仍要求项目固定策略存在且被 trust 确认（ADR-0006 原文），定向计划改变的是**实际执行的命令集**，不是「这个项目是否被信任使用某个确认过的策略」。FULL 仍是零确认。
- 固定项目策略没有被替换或删除；两套来源同时存在，且每一次运行的来源都写进证据。

### D03 dev 全量测试证据由 Runtime 观察，promotion 强制消费

- `promotion.full-suite run <project> --dev-commit <full-sha>`：
  1. 校验 `--dev-commit` 是**完整**对象 ID，且等于当前 `dev` ref（否则 `DEV_REF_MOVED`）；
  2. 从项目 `main` ref 读固定策略作为全量命令集（不存在则 `VERIFICATION_POLICY_ABSENT`）；
  3. 读取候选 commit 处的锁文件（本项目为 `bun.lock`）并取其字节 digest；**没有锁文件也是一种被绑定的输入**：记录 `lockfile_present = 0` 与空字节 digest，因此「后来加了锁文件」是绑定变化而不是悄悄变弱；
  4. 在该**精确 SHA 的 detached 副本**里跑这套命令（复用 ADR-0006/0027 的副本与进程组机制），删除副本并记录删除结果；
  5. 写入 `dev_full_suite_evidence`：`dev_ref`、`dev_commit`、`policy_version`、`policy_digest`、`lockfile_path`、`lockfile_present`、`lockfile_digest`、`commands`、`state`、`outcome_code`、`evidence_json`、`copy_path`、`command_id`、`observed_by`、时间戳。
- 终态必须同时带 `ended_at` 与 `outcome_code`（表 CHECK），所以**未完成的全量运行永远不可能被读成通过**；同 `command_id` 重放返回已记录的那次运行，不同 payload 用同一 command 被拒（`COMMAND_CONFLICT`）。
- 每次运行一行，重跑**新增一行**而不改写旧行；判定只看该候选 commit 的**最新**一行，因此一次较新的失败不会被较旧的通过救回来。
- 启动时 `reconcileDevFullSuiteEvidence` 把上一个 Runtime 留下 `QUEUED/RUNNING` 的行收口为 `ERROR` + `RUNTIME_RESTARTED`（副本留在磁盘上，仍走既有 reclaim 路径）：没人驱动的运行不是通过。
- promotion 三处消费同一判定（`packages/domain/src/verification-evidence.ts` 的 `judgeDevFullSuiteEvidence`）：
  - `promotion prepare`：无证据 → `DEV_FULL_SUITE_EVIDENCE_MISSING`；最新非 PASSED → `..._NOT_PASSED`；三项绑定任一不符 → `..._STALE`。写入 promotion 时固定 `full_suite_evidence_id` + 三项绑定，并计入 `payloadHash`。
  - `promotion approve`（仅 STRICT）：批准必须覆盖**同一个** evidence id；`start_stable_promotion` 的 STRICT 检查也逐字段核对 evidence id，因此一份给别的证据的批准不能放行本次提升。
  - `promotion promote`：在任何 ref 被推动**之前**重新从 Git 读三项绑定并重判。任一不符即拒绝、把 promotion 标成 `STALE`（`outcomeCode` 就是该稳定码）且**不推进任何 ref**；同时要求可用证据仍是这次 promotion 固定的那一条（证据集合移动即失效并重做准备）。
- 由于候选 SHA 不可变、锁文件读自该 SHA，锁文件绑定在「同一 SHA」上不会自行漂移；它真正的价值是把证据自我描述清楚，并在证据行与 Git 事实不符时（写错、被篡改、跨工具链重记）拒绝提升。真正会在同一候选上漂移的是**策略**（位于 `main` ref）：`main` 上改一次判定命令，`policy_digest` 变化，已准备的提升在 promote 前被拒。本 ADR 如实记录这一区别，不夸大锁文件绑定的作用。
- 全量测试**不在本格新增任何确认**：FULL 下 `run`、`prepare`、`promote` 都零确认；STRICT 的既有批准语义保留并扩展到覆盖 evidence id。

### D04 schema v25

只新增（绝不插入更早号段）：`targeted_test_plans`、`dev_full_suite_evidence` 两张 STRICT 表与索引/触发器，`verification_runs` 四个新列，`stable_promotions` 六个新列（三项绑定 + evidence id + 批准 evidence id）。版本常量随之升到 25；迁移断言使用常量本身或 `>= 25`，不写死 `== 25`。v16 继续永久未使用。

## Consequences

- 开发分支的验证可以只跑建分支时选定并**记录**的少量测试，且来源与 digest 都在证据里；「这次到底跑了什么、凭什么跑这些」不再依赖人的记忆。
- 范围变化成为可审计的追加；旧记录永不改写，所以历史证据始终能对上它当初判定的计划。
- 开发分支不再需要跑全量，跨模块回归的代价被推迟到提升前的固定 SHA 全量测试，由本 ADR 的证据强制。
- `dev → main` 多了一道真实的、由 Runtime 观察的证据要求。它不增加确认步数（FULL 仍是 0），但会让「没跑过全量的候选」无法提升——这正是 ADR-0038 D03 想要的。
- 全量运行会创建一个 detached 副本并按既有规则删除；失败现场的残留目录仍由 ADR-0021/0037 的 `reclaim` 显式回收，本 ADR 不新增回收路径。
- 未做（如实声明）：没有 `promotion.full-suite run --background`/Operation 进度与取消（本格运行是同步命令，长命令期间只有 socket keepalive）；没有把定向计划投影到 UI（Q5=A）；没有 `dev` 工作树内的运行路径（一律在精确 SHA 的 detached 副本内运行，因此不依赖 `dev` 是否被检出，也不动用户的工作树）；没有把「分支创建时」这一步变成产品命令面的一部分（计划文件随分支 commit 走，`task tests record` 在交付时执行）。

## Verification

命令面（真实 CLI + 临时 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider；不使用桌面/键鼠自动化）：

- `bun test packages/domain/test/verification-evidence.test.ts` — 20 条断言覆盖计划选择（精确匹配/未记录/revision 不合/commit 不合/别的 Task）、CAS 与幂等、以及 `dev` 全量证据的三项绑定失效与「未完成不是通过」。**20 pass / 0 fail**。
- `bun test packages/storage/test/verification-layering.test.ts` — 真实 SQLite：schema 断言（`>= 25`、两张表、两表新列、v16 仍不存在）、计划 append-only（触发器拒绝 UPDATE/DELETE、幂等重放、范围变化追加且保留旧行、revision 不匹配拒绝、subject 精确）、全量证据（重放、重跑新增行、同 command 不同 payload 拒绝、RUNNING 收口为 ERROR/RUNTIME_RESTARTED、终态必须带结束时间与结果码、跨项目不可读）。**12 pass / 0 fail**。
- `bun test apps/runtime/test/cli-targeted-tests.test.ts` — 端到端：固定项目策略故意是 `false`，因此 PASSED 只能来自分支自己的记录计划；覆盖未记录时 `--policy targeted` 拒绝、`record`/`show`/`history`、幂等重放、过期 digest 拒绝、`task verify` AUTO 用计划并记录 `policySource: TARGETED_TEST_PLAN`、`--policy project` 确实失败、两次运行来源可读；以及无计划文件（`TARGETED_TEST_PLAN_ABSENT`）与短 SHA（`INVALID_COMMIT_ID`）拒绝且仓库保持干净。**2 pass / 0 fail**。
- `bun test apps/runtime/test/promotion-service.test.ts` — 30 条（新增 5 条）：缺证据拒绝、较新失败不被旧通过救回、三项绑定被固定在 promotion 上、`main` 上改策略后 promote 前 `DEV_FULL_SUITE_EVIDENCE_STALE` 且 promotion 变 STALE 且 `dev` 未动、STRICT 批准只覆盖它被给出时的那条证据。**26 pass / 0 fail**（含既有用例）。
- `bun test apps/runtime/test/cli-promotion.test.ts` — CLI 端到端：既有 4 条提升流程（现在都要先 `promotion full-suite run`）、无全量证据时 `promotion prepare` 以 `DEV_FULL_SUITE_EVIDENCE_MISSING` 拒绝、证据三项绑定可读、`main` 上改策略后 `promotion promote` 以 `DEV_FULL_SUITE_EVIDENCE_STALE` 拒绝且无 ref 推进。**6 pass / 0 fail**。
- 既有 flake 修复（每处连续 5 次，全部通过）：
  - `apps/runtime/test/cli-impact.test.ts` 的 `task cancel` 改为读取真实 version 并做有界重读（5 次运行各 `1 pass / 0 fail`）。
  - `apps/runtime/test/terminal-service.test.ts` 的 release 断言改为等待「provider 已进入 raw mode」与「已记录进程树」两个事实（5 次运行各 `7 pass / 0 fail`）。
  - `apps/runtime/test/runtime-lifecycle.test.ts` 的 `raw 0` 改为有界断言（`< 1000ms`，5 次运行各 `10 pass / 0 fail`）。
- `bun run typecheck` 通过。

## Related

- `PROJECT_SPEC.md` §1.1、§2.12、§3
- ADR-0006（Task Verification 的命令来源、隔离副本与证据绑定）
- ADR-0009（固定 `main`/`dev` 与稳定提升）
- ADR-0011（默认 FULL 零确认）
- ADR-0018（Task 成果集成到 `dev`；其集成验证不能替代本 ADR 的全量证据）
- ADR-0021 / ADR-0037（验证副本与失败现场的回收）
- ADR-0022（稳定提升；本 ADR 补上它缺失的全量证据项）
- ADR-0027（verification run 的终态与进度事件）
- ADR-0038（本 ADR 实现其 D01–D03，并关闭 D04 记录的自动化缺口）
- `apps/runtime/test/support/runtime-reclamation.ts`（e2e 测试的资源回收）
