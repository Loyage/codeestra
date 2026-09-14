# ADR-0031：ImpactSnapshot 与确定性 Conflict Analyzer（映射声明、UNKNOWN 优先、append-only 失效）

Status：Accepted（本轮实现：FOUNDATION-053；无新增权限门禁；新增一次**零步**的 trust 记录，见 D07）

## Context

`PROJECT_SPEC.md` §2.6 要求 Conflict assessment 只有三种取值：`SAFE_TO_PARALLELIZE | UNKNOWN | CONFLICTING`，并且「未知不等于无冲突」；§2.5 要求「开始执行必须同时满足依赖条件、并发安全和 Agent 资源可用」；`docs/roadmap/mvp.md` Phase 2 的第一条交付就是「影响分析、保守冲突分析」。设计来源是 `docs/architecture/conflict-analyzer.md`（输入形态、纯判断规则 §3、失效与解释 §4、测试矩阵 §5）与 `docs/architecture/scheduler.md`（活跃集合定义、UNKNOWN 不并行、实际 diff 超出预测要撤销旧 SAFE）。

到本轮为止这条链上没有任何实现：没有 `ImpactSnapshot`、没有任何冲突判定代码、没有 `.codeestra/impact.json`、没有 schema、没有命令面。`docs/tasks/README.md` Phase 2 的待决项写着「未做：并行 worktree 调度、资源预留、Conflict Analyzer、多成员批次」。

本格的硬约束（用户已确认的决策，不是本 ADR 新发明的语义）：

- **确定性优先**：ImpactSnapshot 由 `.codeestra/impact.json`（仓库内跟踪文件，从 project main ref 读，惯例照 `verification-policy.ts` + `.codeestra/policies/verification.json`：版本号 + 内容摘要 + 未确认即拒绝）声明的重要目录 / 模块 / 全局资源清单，加上 DAG 与 revision 的 Git 变更集路径算出。**不引入任何 LLM 判定**，「LLM 没提到同文件」永远不能作为 SAFE 依据。
- **映射缺失或影响不完整 → `complete=false` → UNKNOWN → 不并行。** 不允许「猜」成 SAFE。
- 非 Git 共享资源（端口 / 数据库 / dev server）本波不做；不做 aging、不抢占、不做多成员批次。
- 本格**不做调度**：`task schedule *` 属于 Wave F，容量属于 E2。
- §1.1 第一原则：效率至上（FULL 零确认、正确性核对不得包装成审批）、CLI 必须完备可脚本化、自动化验收只用 CLI/命令面。

## Options

1. 影响范围的来源：
   - A. 从代码结构自动推断（import 图、文件名、目录启发式）；
   - B. 由人工维护的 `.codeestra/impact.json` 声明，读自 project `main` ref（Task 分支无法改写判定自己的映射）；**（选择）**
   - C. 用 LLM 从 revision 文本预测受影响文件。
2. 映射缺失/不完整时的判定：
   - A. 退化为「只看文件是否同名重叠」并允许 SAFE；
   - B. `complete=false` → `UNKNOWN`，并且任一侧不完整都不能产出 SAFE；**（选择）**
   - C. 直接拒绝创建 Task。
3. 全局资源的读依赖怎么表达：
   - A. 不区分读写，只比较同名资源；
   - B. 每个资源显式声明 `consumers`：要么 `UNKNOWN`（写它就让整条判定变成 UNKNOWN），要么 `DECLARED` + 路径列表（写它 + 对方改动依赖它的文件 = 冲突）；**（选择）**
   - C. 用「谁 import 了它」静态推断（不完整，会漏）。
4. 路径大小写：
   - A. 一律按字节比较；
   - B. 实测仓库文件系统（case-flipped 路径是否解析到同一路径），无法实测时退回 `core.ignorecase`，仍无法实测则按**大小写不敏感**比较（只会找到更多重叠）；**（选择）**
   - C. 一律按大小写不敏感比较。
5. 失效与缓存：
   - A. 覆盖旧 assessment（历史消失）；
   - B. append-only：快照按 `(task, revision, baseCommit, analyzerVersion, policyVersion, changeFingerprint)` 唯一，配对 assessment 按两个快照唯一，任何事实变化写**新行**，旧行永不改写；**（选择）**
   - C. 只存最新一行 + `invalidated_at` 标记。
6. 「实际 diff 超范围」的重用规则：
   - A. 记录集合是观测集合的超集即可重用（保守上界）；
   - B. **必须精确相等**才重用：更宽的记录会在工作树已不再改动的路径上继续报冲突，更窄的记录会漏掉新增文件；**（选择）**
   - C. 永不重用，每次重算并插入新行。
7. 映射的确认方式：
   - A. 不确认，直接读 main ref 的当前内容；
   - B. 由既有 `project trust` 事件确认（FULL 零步自动记录，STRICT 复用同一次 TRUST 确认，**不新增任何一步**）；摘要不一致即 `POLICY_NOT_CONFIRMED` → `complete=false`；**（选择）**
   - C. 新增一条独立的 `project impact confirm` 确认命令（FULL 也要一次显式动作，违反 §1.1）。

## Decision

### D01：映射是声明，不是推断，且读自 project `main` ref

- 新增 `packages/contracts/src/impact-policy.ts`：`.codeestra/impact.json` 的 Zod 严格 schema、路径常量、语义版本常量（`impactPolicyVersion = 'impact-policy-v1'`）、稳定错误码（`INVALID_IMPACT_POLICY` / `IMPACT_POLICY_NOT_CONFIRMED` / `IMPACT_POLICY_UNREADABLE`）与内容摘要函数。
- 结构：`importantDirectories[]`、`modules[{id, paths[]}]`、`globalResources[{id, kind, paths[], consumers}]`。每个列表可以为空——**空清单是合法但无用的**：它让 `complete=false`，不是错误。
- 未知键、重复 id、重复路径、空 `paths`、非法 `kind` 一律拒绝；`consumers` 必须显式写作 `{state:'UNKNOWN'}` 或 `{state:'DECLARED', paths:[…]}`——**缺字段不等于「没人读它」**。
- 路径只允许仓库相对路径、`/` 分隔：拒绝绝对路径、`~`、`.`/`..` 段、空段、`\`、NUL、`.git` 内部路径、以及除末尾 `/**` 之外的任何通配符；目录比较按**路径组件**（`src/map` 不得匹配 `src/mapping`）。
- 这些声明路径**从不被文件系统打开**：映射经 `git cat-file` 读对象，变更集经 `git diff --name-status` / `git ls-files --others` 读索引与对象。因此 symlink 逃逸在结构上不可能（没有任何一次 dereference），语法上同时被拒绝——「逃出仓库的路径」描述的东西是任何变更集都不可能包含的。

### D02：纯领域判定器，规则照 `conflict-analyzer.md` §3

- 新增 `packages/domain/src/impact-analysis.ts`（纯函数，无 Bun/数据库/Git/模型依赖）：
  - `createImpactSnapshot`：把观测变更集映射到声明的 scope，并**在构造处**决定 `complete`——缺映射、映射非法、映射未确认、空映射、无法界定的全局效应、变更集超界之一都使 `complete=false`，调用方无从遗忘。
  - `assessCandidate(candidate, active, context)`：逐对判定 + 聚合判定。
  - `deriveImpactScope`、`impactPatternMatches`、`impactDirectoriesOverlap`、`normalizeObservedImpactPath`、`isSnapshotCurrent`、`explainAssessment`、`impactReasonClass`。
  - `impactAnalyzerVersion = 'impact-analyzer-v1'`（分析语义版本，进快照与失效键）。
- 稳定的 reason code：`SAME_FILE`、`IMPORTANT_DIRECTORY_OVERLAP`、`SAME_MODULE`、`GLOBAL_RESOURCE`、`GLOBAL_RESOURCE_DEPENDENCY`、`INCOMPLETE_IMPACT`、`MISSING_IMPACT_SNAPSHOT`、`STALE_BASE`、`STALE_REVISION`、`STALE_POLICY`、`STALE_ANALYZER`、`ACTUAL_DIFF_EXCEEDS_SNAPSHOT`、`SNAPSHOT_SCOPE_MISMATCH`、`INVALID_SCOPE`、`NO_CONFLICT`；按 `CONFLICT | INCOMPLETE | STALE_OR_INVALID | SAFE` 分组，`STALE_OR_INVALID` 就是规格里的 `stale_or_invalid` 分支名。每个命中都带**具体范围**（相交路径 / 重要目录 / 模块 id / 共享资源 id，以及关系 `SAME_FILE|SAME_DIRECTORY|ANCESTOR_DIRECTORY|WRITE_WRITE|READ_WRITE`），不是单纯红绿。
- 判定顺序（逐对）：先判该侧是否 stale/invalid（`revision`/`base`/`policy`/`analyzer` 不匹配、范围非法、观测变更集与本侧快照不一致）→ 该对 UNKNOWN；否则判 CONFLICTING（文件重叠 / 重要目录祖先重叠 / 模块重叠 / 全局资源写写或读写）；否则任一侧 `complete=false` → UNKNOWN；否则该对 SAFE。
- 聚合：candidate 自身 stale/invalid → UNKNOWN；存在 conflict 命中 → CONFLICTING（**冲突优先于不完整**，`§3` 的顺序）；否则存在 incomplete/stale 命中 → UNKNOWN；否则 SAFE。若 `active` 为空且 candidate 完整 → SAFE，并在 evidence 里写明「没有可比较的活跃任务」。
- `explainAssessment` 输出稳定的人类可读行（verdict → 每个命中的类别/原因/范围 → SAFE 对 → evidence），CLI 与未来的 UI 都投影同一份文本与同一份 JSON。
- 组件的命中范围以路径组件比较，`src/map` 与 `src/mapping` 互不影响；rename 由调用方展开为 old+new 两个路径，任一侧重叠都算冲突。

### D03：全局资源的读写冲突与「无法界定的效应」

- 写-写：两侧都改动同一资源 → `GLOBAL_RESOURCE`。
- 写-读：一侧写资源，另一侧改动了该资源**声明为依赖方**的文件 → `GLOBAL_RESOURCE_DEPENDENCY`（这正是「对方修改共享构建/依赖/schema 而本任务依赖它」）。
- 读-写（反向）同样命中，命中里写明 `relation`。
- 写一个 `consumers.state='UNKNOWN'` 的资源 → 该 revision 的影响**无法界定**（`UNCERTAIN_GLOBAL_EFFECT`）→ `complete=false` → 只要它是判定的一方就是 UNKNOWN。这里不允许「没人读 lockfile」这种没人做过的断言。

### D04：路径大小写按仓库实际文件系统

- Runtime 实测：把仓库根路径上某个组件的字母大小写翻转后 `realpath`，解析回同一路径即为大小写不敏感，`ENOENT` 或解析到别的路径即为敏感；记录来源（`FILESYSTEM`）。
- 无法实测时退回 `core.ignorecase`（`GIT_CONFIG`）；两者都不可得时按**大小写不敏感**比较（`CONSERVATIVE_DEFAULT`，只会找到更多重叠，不会漏）。判定用的比较键只在快照内使用，原始路径始终保留在输出里；大小写不敏感下由大小写差异造成的 `SAME_FILE` 会在 detail 里注明。

### D05：存储 append-only，失效即新版本（schema v20）

- `impact_snapshots`：唯一键 `(task_id, revision_id, base_commit, analyzer_version, policy_version, change_fingerprint)`；`complete` 与 `incomplete_reasons_json` 由 CHECK 绑成一致（**不完整必须写明原因**）；UPDATE/DELETE 由触发器拒绝。
- `impact_assessments`：一行一个**配对**判定，唯一键 `(candidate_snapshot_id, other_snapshot_id)`；同样只追加，verdict 列没有任何可改写的路径。聚合 verdict 由同一批配对判定推出（CONFLICTING > UNKNOWN > SAFE，candidate 自身 stale/invalid 直接 UNKNOWN），不另存一行。
- `project_impact_policy_confirmations`：`ABSENT | PRESENT(digest) | INVALID(contentDigest, code)`，与验证策略确认同构（每个 project 一条 ACTIVE，re-trust 时 SUPERSEDED）。`INVALID` 保留原始字节摘要，所以「坏映射」永远不等于「没有映射」。
- 失效规则：revision 变化（改修订）、基线变化、映射内容变化（digest 进 `policy_version`）、分析器版本变化、实际 diff 变化（`change_fingerprint` + 精确相等的重用判定）任一发生即写新行；旧行保留为审计，**从不覆盖**。
- 迁移只追加 `if (version < 20)`；**绝不插入 `if (version < 16)`**（v16 永久未使用，既有库可能已被标 17–19 而跳过该分支）。

### D06：活跃集合 = 持有 Execution 资源的 Task

- `listImpactActiveTasks` 取「该 project 中仍有 `executions.resource_held=1` 的 Task」，这正是 `scheduler.md` §1 的活跃集合：准备/启动、RUNNING、WAITING_FOR_USER、PAUSING/PAUSED、STOPPING/CANCELLING、RECOVERY_REQUIRED 与已预留尚未启动的执行都会持有资源，而结束的执行已释放。candidate 自身总被排除。
- 活跃 Task 若**无法**产出快照（没有 worktree、Git 不可读、快照无法再水化）→ `MISSING_IMPACT_SNAPSHOT` → UNKNOWN。**任何活跃 Task 的影响不可得，都不允许 SAFE。**
- 判定基线用 candidate 自己的 worktree base（`workspace.base_commit`）；与此基线不同的活跃 Task 逐对 UNKNOWN（`STALE_BASE`）。CLI 同时输出项目当前 `dev` commit 与是否与基线一致，让「为什么 UNKNOWN」可解释。

### D07：确认走既有 `project trust`，FULL 零步（门禁效率成本评估）

- `project.trust` 在同一个事务里记录映射确认（`ABSENT` 也记录），CLI 的 `open` / `project trust` 在同一次确认里显示映射摘要与声明数量。
- **新增确认/审批/沙箱步数：0。** FULL 下 `project trust` 本来就不询问、不等待，映射确认随之自动记录；STRICT 下不新增第二次询问，映射信息与验证策略一起在既有的那一次 `TRUST` 提示中展示。STRICT 下的 `project trust` 必须真的被确认（沿用既有语义），FULL 下没有新增 flag 依赖。
- 「未确认即拒绝」的落点是**判定**而不是权限：未确认 → `POLICY_NOT_CONFIRMED` → `complete=false` → UNKNOWN；它只会让并行变保守，绝不会让任何东西看起来更安全。
- 映射摘要变化后重新 `project trust` 即确认新摘要（FULL 零步）；`project impact validate` 的退出码就是「映射是否存在且在生效」。

### D08：命令面（CLI 完备，本格 group）

- `project impact validate [path] [--json]`：读 main ref 的 `.codeestra/impact.json`，报告 `OK | OK_UNTRUSTED | POLICY_ABSENT | POLICY_INVALID | POLICY_NOT_CONFIRMED`、digest / label / 声明数量、以及警告（空映射、`UNKNOWN` consumers）。退出码 0 仅当 `OK*`。
- `project impact show <project-id> <task-id> [--json]`：一个 Task 当前 revision 的 ImpactSnapshot（DAG 与变更集路径、匹配到的目录/模块/资源、未分类路径、完整性原因、来源证据、reuse 处置）。退出码 0 仅当快照确实产出（不完整也产出，`complete:false` 在 JSON 里可判定）。
- `project impact explain <project-id> <task-id> [--json]`：与每个活跃/已预留 Task 的判定、稳定 reason code 与命中范围，并写入配对审计行。**退出码 0 仅当 `SAFE_TO_PARALLELIZE`**；UNKNOWN 与 CONFLICTING 都是退出码 1——UNKNOWN 不是「更软的 SAFE」，而是拒绝。
- 只加这一组命令；不碰 `task schedule *`（Wave F）与容量命令（E2）。命令面不含任何 LLM、不新增工具、不写任何非本格的表。

## Consequences

- 已实现：`packages/contracts/src/impact-policy.ts`（新）；`packages/domain/src/impact-analysis.ts`（新，纯函数）；`packages/storage/src/migration.ts` 的 v20 迁移（三张表 + 唯一索引 + append-only 触发器）与 storage 的确认读写、快照/判定读写、活跃集合投影；`apps/runtime/src/impact-analysis-service.ts`（新）；runtime 的四个命令接线（validate/show/explain + trust 记录确认）；CLI 的三个 `project impact` 子命令与 `usage()`；本 ADR 与 `docs/tasks/README.md`。
- 语义边界（由测试固定）：映射缺失/非法/未确认/为空、全局效应不可界定、变更集超界都使 `complete=false`；`complete=false` 或活跃侧快照缺失/过期绝不产出 SAFE；`src/map` 与 `src/mapping` 不重叠；rename 双路径计入；读写资源冲突命中；大小写不敏感仓库里只差大小写的路径算同一文件；修订/基线/映射/分析器/实际 diff 任一变化都写新快照而不是复用或覆盖。
- 已知残余风险（本 ADR 明确不掩盖）：**映射是人写的声明**，未声明的路径不会获得目录/模块级语义，只由「同文件」与「声明资源」规则覆盖；**gitignore 的产物**（构建输出、本地环境文件）不在变更集里；非 Git 共享资源（端口/数据库/dev server）本波不做；SAFE 是「在声明的映射与观测事实下无法证明重叠」，不是「两个 Agent 永不越界」的保证（`scheduler.md` §4 的残余风险继续成立，Wave F 的容量与运行中越界处置不在本格）。
- 不新增门禁，FULL 零确认预算仍为 0；新增的都是事实记录与判定。

## Verification

只用 CLI/命令面与 Runtime 命令面（含临时 `CODEESTRA_HOME`）断言（ADR-0008），不使用浏览器/桌面/键鼠自动化：

1. `packages/domain/test/impact-analysis.test.ts`（34 项，Vitest）：`conflict-analyzer.md` §5 的矩阵——同文件（含相交路径回报）、重要目录同层与祖先关系、`src/map` vs `src/mapping` 不重叠、subtree 模式按组件匹配、rename 双路径、模块重叠/跨模块不重叠/未分类路径、共享资源写写与读写、`UNKNOWN` consumers 使写入方不完整、只读依赖不误报、缺映射/空映射/未确认/空变更集（完整性不足）都不 SAFE、活跃侧无快照/不完整都 UNKNOWN、base/policy/analyzer/revision 不匹配与 `INVALID_SCOPE`、实际 diff 超出与不再匹配都使快照失效、大小写敏感与不敏感两种文件系统行为、超界变更集记为不完整、去重与排序、以及**同样输入的确定性**（活跃集合顺序无关、逐字节一致）与「命中范围而非红绿」的解释行。
2. `packages/contracts/test/impact-policy.test.ts`（9 项，bun test）：合法映射与 label；空映射合法但 `impactPolicyIsEmpty`；digest 与声明顺序无关、与任何路径改动相关；未知键/版本/缺字段/重复 id/重复路径/空 `paths`/非法 kind/`consumers` 缺字段或多余键都被拒；绝对路径、`~`、`..`、`.`、`./`、`src/`、空段、`.git`、`\`、NUL、前后空格、通配符位置都被拒；仓库根不能作为重要目录；subtree 只能写作 `dir/**`。
3. `packages/storage/test/impact-analysis.test.ts`（12 项，bun test）：真实 SQLite 上 **v19 → v20** 与 **v16 → v20** 两种历史库 additive 升级（既有 `task_revision_deliveries`/`tasks` 行保留、三张新表存在、`PRAGMA foreign_key_check` 为空、升级不会凭空造出确认行）；快照幂等与「diff 变化写新行」；UPDATE/DELETE 被触发器拒绝；`complete` 与原因不一致被 CHECK 拒绝；配对判定幂等且不可改写；确认的 ACTIVE/SUPERSEDED 与「未声明映射即无确认」；`invalidateProjectTrust` 同时作废映射确认；活跃集合与 candidate 投影按 `resource_held` 选取。
4. `apps/runtime/test/cli-impact.test.ts`（1 项端到端，bun test）：真实 CLI + 真实 Runtime + 独立 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider。断言 `project impact validate`（PRESENT+confirmed → `OK`，退出码 0）、SAFE（`NO_CONFLICT`，退出码 0，且 fixture 声明的 `core` 目录未被匹配）、show 的 REUSED 重用、CONFLICTING（`IMPORTANT_DIRECTORY_OVERLAP` + `SAME_MODULE`，退出码 1）、同文件 `SAME_FILE` 与命中路径、修订后新快照（新 revision 与新 id，旧快照不再被重用）、无映射项目的 `UNKNOWN`（`POLICY_ABSENT`）、坏映射的 `POLICY_INVALID`（`validate` 退出码 1，`explain` 退出码 1 且 `incompleteReasons` 为 `POLICY_INVALID`）；以及指向 `/tmp` 的**真实 symlink** 只以 Git 报出的仓库相对路径 `escape-link` 进入变更集（按名字比较，内容不被读取）。
5. 本格 worktree 上 `bun run check:fast` 与 `bun run check` 的实际退出码与计数见 `docs/tasks/README.md` FOUNDATION-053；端到端证据（`/tmp/ce-e1`）同样记录在那里。

## 关联文档

- `docs/architecture/conflict-analyzer.md`（本格规格来源：输入 §2、规则 §3、失效与解释 §4、测试 §5）、`docs/architecture/scheduler.md`（活跃集合 §1、UNKNOWN 不并行 §2、实际 diff 扩大 §4）、`docs/architecture/domain-model.md`、`docs/architecture/repository-structure.md`
- `PROJECT_SPEC.md` §1.1、§2.5/§2.6/§2.10/§2.18/§2.19；`docs/roadmap/mvp.md` Phase 2
- ADR-0006（验证策略来自 main ref、FULL 零确认 / STRICT 确认、digest 绑定——映射确认完全照此惯例）、ADR-0008（效率/CLI 完备/测试边界）、ADR-0009（`dev` 基线）、ADR-0011（FULL 零确认）、ADR-0024（依赖与 BLOCKED 语义）、ADR-0030（Wave E 的 E0：Phase 2 十项决策；**本格基线 `dev@cb7078e` 中不存在该 ADR**，本格按用户已确认决策实现并在 `docs/tasks/README.md` 注明）
- `docs/tasks/README.md` FOUNDATION-024（依赖与 BLOCKED 已完成）、FOUNDATION-053（本格）
