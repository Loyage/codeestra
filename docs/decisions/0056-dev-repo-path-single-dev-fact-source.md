# ADR-0056：`dev` 事实的唯一来源是 dev clone；`dev_repo_path` 必需（**Amends ADR-0018**）

Status：Accepted（用户 2026-09-16 裁决；实现为 FOUNDATION-087）。**无 schema 变更、不占迁移号。**
**Amends ADR-0018 的 `DEV_REF_CHECKED_OUT` 字面语义与推进方式**；收口 ADR-0048 D04 留下的过渡指针，
并消掉 FOUNDATION-077 自记的两处残留（全量证据的仓库根、main 检出里的过渡 `dev` ref）。
与 ADR-0047（经 GitHub 中转的提升）、ADR-0048（两个独立 clone）、ADR-0052（提升事实分层）、
ADR-0053（批级 `STALE`）配套。

## Context

ADR-0048 D04 把 main 检出里的本地 `refs/heads/dev` 保留为**过渡的 Task 基线指针**，并写明它**不随 `origin/dev` 前进、
不得当作提升证据**；ADR-0047 D05 同时把 `projects.dev_repo_path`（第二个、独立的 clone）记为提升的 push 源。
两个 clone 分离后，事实分成两份：

- 稳定 main 检出（`projects.repo_root`）：仓库身份、`main` ref 上的判定策略与影响映射、提升后重启的序列；
- dev clone（`projects.dev_repo_path`）：长期 `dev` 分支，以及集成产生的候选对象。

只要 Runtime 仍从 main 检出的本地 `dev` ref 读基线，这个 ref 就是一个**不前进的指针**：真实对象库分离意味着
它以另一个 clone 的对象为基线时会直接读不到（实测：本机 main 检出里根本没有 dev clone 的 HEAD 提交，
`git cat-file -t` 失败），而它一旦落后就让每个新 Task 建在旧代码上。FOUNDATION-077 的实现又把候选对象的
存在位置（dev clone）与全量证据的读取仓库（main 检出）分开，于是在「候选只在 dev clone 里」的常态下那一步不成立。

本轮用户裁决（口径按原样执行，不扩大也不缩小）：

1. `dev_repo_path` 成为**必需**；`project trust` 不带 `--dev-repo` 被稳定码拒绝；已信任但路径为空的项目在
   **任何需要 dev 基线的操作**上以新稳定码拒绝并给出补救命令；拒绝发生在**任何副作用之前**，且**不改写**已有行。
   **不静默回退到过渡 ref。**
2. 过渡 ref 的删除**不在开发期执行**：代码只是**不再读它**，并让只读命令如实报告「该 clone 里是否仍有本地 `dev` ref、
   是否仍有项目依赖它」。真实删除由人工在提升与重启之后执行。
3. 同时收口 FOUNDATION-077 的残留：全量证据的**候选对象、副本根与锁文件从 dev clone 读**，
   **验证策略仍从 main ref 读**；`promotion prepare/approve/promote` 的既有事实分层一律不放宽。
4. 集成推进 `dev` 的方式必须与「保持 dev clone 自己的检出一致」相容（用户就本 ADR 的一处实测缺陷专门裁决，见 D05）。

保持不变的既有不变量：Task worktree 基线是长期 `dev` 的**固定 commit**；集成只在**未检出 `dev` 的 detached worktree**
里合并；失败保留现场；`provider`/`Git`/`SQLite` 之间不假定原子性；FULL 下常态路径步数与等待均为 0（**不新增任何确认或门禁**）。

## Decision

### D01：单一 dev 事实来源 = dev clone 的本地 `dev` ref

- **哪个 clone**：`projects.dev_repo_path` 指向的那个独立 clone（`DevRepoInspection` 已核验：是 Git work tree、
  是另一个 clone、`origin` 与 main 检出一致、HEAD 在项目 `dev` 分支上且该分支存在）。
- **哪个 ref**：它的本地 `refs/heads/dev`（ref 名仍由 `projects.dev_ref` 记录）。
- **由谁 fetch**：**Runtime 不 fetch**。运行期不联网、也不替用户 `git fetch` 远端：读到的是 dev clone 的**本地** ref，
  由用户负责让那个 clone 跟上 `origin/dev`。`origin/dev` 的一致性由提升流程（ADR-0047/0052）在 push 后**读回核对**。
- **不一致时**：本 ADR 不新增「本地 dev 与 origin/dev 不一致即拒绝」的判定（那需要联网读远端，且会把「用户还没 fetch」
  变成产品拒绝）。不一致的后果由既有事实承担：候选与远端不符时 `promotion promote` 的读回核对失败
  （`REMOTE_DEV_READBACK_MISMATCH` 可重试；远端 `dev` 移到非候选 SHA 则 `REMOTE_DEV_MOVED` → `STALE`），
  用户修法是**在 dev clone 里 fetch / 合并 `origin/dev`**，然后重跑提升。
- 因此本 ADR 让代码不再读任何其它仓库的 `dev`：没有 `dev_repo_path` 的项目不猜、不回退。

### D02：`dev_repo_path` 必需与固定失败形态

| 情形 | 稳定码 | 退出码 | 是否在任何写入之前 | 补救 |
|---|---|---|---|---|
| `project trust` 省略 `--dev-repo`，或写 `--dev-repo none` | `DEV_REPO_REQUIRED` | 1 | **是**（不登记项目、不改写已有行） | `project trust <main-checkout> --dev-repo <dev-clone>` |
| 已信任项目的 `dev_repo_path` 为空，任何需要 dev 基线的操作 | `DEV_REPO_REQUIRED` | 1 | **是** | 同上 |
| 路径存在但不是可用 dev clone | `DEV_REPO_*`（ADR-0052 既有集合） | 1 | 是 | 修好 path 后重新 trust |

- `promotion prepare/approve/promote` 保留它**原有的** `DEV_REPO_PATH_MISSING`（FOUNDATION-077）：那是另一条命令面，
  与本 ADR 的 `DEV_REPO_REQUIRED` 指向同一条补救命令。两者都在写入之前拒绝。
- 「需要 dev 基线」的**确切操作集合**：Task worktree 准备（含重建）、依赖判定视图与依赖收敛、槽位预留、
  结果 commit 的归属核验、Task 验证、集成（`task integrate` / `task.integration.*`）、回收（`reclaim plan|apply|records`）、
  调度引擎的启动前基线重检、影响分析的基线读取、`promotion full-suite run`。**只读命令也拒绝**，因为
  「所有边都 BLOCKED」会被误读成一个真实的依赖结论。
- 只读的 `project inspect` **不**拒绝：它如实报告 `devRepoPath: null` 与 `devCommit: null`，并给出补救命令。

### D03：过渡 ref 的退役

- 代码侧：Runtime 不再从任何仓库的本地 `dev` ref 读 dev 事实（Task 基线、依赖、集成、回收、提升候选全走 dev clone）。
  main 检出里那个 ref 只剩一个用途：**只读证据**。
- 只读证据：`project inspect`（以及 `open` 的 stderr 摘要）报告
  `devRefRetirement{ localDevRefPresent, localDevRefCommit, projectsWithoutDevRepo[] }` ——
  「被检查的那个检出自己还有没有这个 ref」+「还有哪些已信任项目没有 dev clone（它们的最后一份 `dev` 可能就是它）」。
- **退役条件**（人工执行、可核验）：`projectsWithoutDevRepo` 为空，且没有任何操作因为缺 dev clone 而被拒绝；
  此时该 ref 不被任何项目依赖，删除它是纯人工动作（`git -C <检出> branch -D dev`）。
  Runtime 不删、不改写它，也不因它的状态改变任何判定。本格（lane）**不碰稳定 clone**。

### D04：两处根的分工（实现表）

`repo_root`（main 检出）与 `dev_repo_path`（dev clone）各自拥有什么、哪些投影字段指向哪个仓库、
以及**逐处的同名换义**（`docs/architecture/git-workspace-api.md` §2 有同一张表）：

| 根字段 / 事实 | 代表哪个仓库 | 谁消费它 |
|---|---|---|
| `TrustedProject.repoRoot` / `gitCommonDir` / `mainRef` | main 检出 | 身份校验、验证策略、影响映射、knowledge、提升重启与 `main` 推回 |
| `TrustedProject.devRepoPath` | dev clone | 所有 dev 事实的入口 |
| `WorkspacePreparationPlan.repoRoot` | **dev clone**（同名换义：该字段的语义一直是"拥有这个 worktree 的仓库"，现在解析到 dev clone；`gitCommonDir` / `mainRef` 仍是 main 检出的事实，与该计划并列） | `prepareTaskWorkspace`、重启时 `reconcileWorkspacePreparations` |
| `VerificationCandidates.repositoryRoot` | **dev clone**（同名换义：被测 commit 所在仓） | 验证副本创建、`testedCommit` 的 tree 与定向测试计划读取 |
| `VerificationCandidates.mainRepositoryRoot`（新增） | main 检出 | 验证策略读取 |
| `DevFullSuiteCandidates.repositoryRoot` | **dev clone**（同名换义） | detached 副本、候选 tree、候选锁文件 |
| `DevFullSuiteCandidates.mainRepositoryRoot`（新增） | main 检出 | 固定全量策略 |
| `IntegrationCandidates` / `IntegrationBatchCandidates` / `IntegrationBatchPlan`.repositoryRoot | **dev clone**（同名换义） | dev ref 读取、合并 worktree、集成验证副本、ref 前移、重启收敛 |
| 两者的 `mainRepositoryRoot`（新增） | main 检出 | 集成验证策略 |
| `ReclamationProjectRef.repoRoot` | **dev clone**（同名换义） | worktree 注册与归属、Task branch、`dev` 可达性 |
| `ReclamationProjectRef.devRepoPath`（新增） | dev clone（可空） | 回收入口的 `DEV_REPO_REQUIRED` 判定 |
| `StablePromotionPlan` / `PromotionCandidates`.repositoryRoot | main 检出（**不变**） | 提升的 `main` ref、预期旧 main、重启序列 |
| 同两者的 `devRepoPath` | dev clone（**不变**） | push 源与候选对象核验 |

- 新增字段优先于复用名字；上表逐处点名的「同名换义」只有两种：**「该记录涉及的仓库」从 main 检出改解析到 dev clone**
  （语义没变，指向变了），以及 workspace 计划里 `gitCommonDir`/`mainRef` 继续是 main 检出的事实。之所以不能一律新增字段：
  `WorkspacePreparationPlan.repoRoot` 与 `IntegrationBatchPlan.repositoryRoot` 分别被**不在本格领地**的
  `recovery-service.ts` 与 `main.ts` 的 wiring 直接消费，新增字段就会让重启收敛继续在错仓库里找 worktree/ref。
- storage 侧只**追加**投影字段（上面的 `*RepositoryRoot`）与最小必要的 SQL 解析改动，不改既有方法签名、不占迁移号。
  对「本 ADR 之前就存在、当时没有 dev clone」的历史记录，投影解析用
  `COALESCE(dev_repo_path, repo_root)`：那些 worktree/batch 的 Git 副作用**确实**发生在 main 检出里，重启收敛读它们时
  fallback 是**事实正确**的；而任何**新**操作都在服务层以 `DEV_REPO_REQUIRED` 先拒绝，走不到这个 fallback。

### D05：集成如何推进 `dev`（**Amends ADR-0018**；含一处实测缺陷的裁决）

ADR-0018 原文：「读固定 `dev` 基线 OID，并要求 `dev` **未被任何工作树检出**（`DEV_REF_CHECKED_OUT`），否则拒绝」。

**修正后的语义**：

- `dev` 被**其它任何**工作树检出时仍然一律 `DEV_REF_CHECKED_OUT` 拒绝（原语义不放宽）。
- **唯一例外**：被检出的位置是 **dev clone 自己的长期 `dev` 检出**，且集成成功后就地把它前移。允许它是因为
  集成能证明并维持一致性，而不是因为它更好用。
- **三项前置**（任一不成立即拒绝、不合并、不推进、保留现场）：①该检出 HEAD 符号指向 `refs/heads/dev`（不是 detached）；
  ②`git -C <dev clone> status --porcelain` **为空**（含未跟踪文件：那正是快进会覆盖的东西）；③HEAD 与
  `refs/heads/dev` **都**等于批次记录的基线 OID。稳定码 `DEV_CHECKOUT_NOT_ON_DEV` / `DEV_CHECKOUT_DIRTY` /
  `DEV_CHECKOUT_MOVED`。前置在**组批之前**与**推进之前**各核一次：前者保证一个不可用的检出不会留下阻塞后续尝试的批次记录，
  后者把竞态窗口压到最小。
- **推进方式与成功判据**：①读 `dev` 与批次基线比对（不等即批级 `STALE` / `DEV_REF_MOVED`，ADR-0053）；
  ②过前置；③`git -C <dev clone> merge --ff-only <merged_commit>` —— 由 **Git 自己**把 ref、索引与工作区一起前移；
  ④核验 `HEAD == refs/heads/dev == merged_commit` **并且** `git status --porcelain` 为空。
- **实测事实（本 ADR 的证据，促成第 ④ 条）**：dev clone 的 `HEAD` 是 `refs/heads/dev` 的**符号引用**。
  在临时仓库实测：`git update-ref refs/heads/dev <new>` 之后，`rev-parse HEAD` 与 `rev-parse refs/heads/dev`
  **都已经**等于 `<new>`，而索引/工作区仍停在旧提交 —— `git status --porcelain` 把新提交引入的文件报成 `D`，
  紧随其后的 `git merge --ff-only <new>` 只打印 `Already up to date.` 且什么都不做。
  也就是说：`update-ref` + 「三等式」会**报告成功而把用户的检出留在旧提交**，正是本格最不能接受的那种报告。
  因此：**成功判据必须包含 `status` 为空**（代码与测试都钉住这一点，包括"新提交引入的文件确实出现在磁盘上"），
  且不引入 `read-tree` 之类的 plumbing。
- **与旧写法的差别与残余竞态**：期望值的保护从 `update-ref <ref> <new> <old>` 的**原子 CAS** 变为**读取-比对-拒绝**。
  残余窗口是「读 ref 之后、`merge --ff-only` 之前」；在那之后并发移动会让快进不可能成立（`merged_commit` 是从被核验的
  基线构建的后代），因此不会静默覆盖，最坏是可被如实记录的拒绝。
- **失败处置**：快进被拒或事后核验不成立 → 批次 `FAILED` + `DEV_CHECKOUT_FF_FAILED`，detail 如实写明
  「ref 与检出各自处于什么状态」；**不回滚**、不 `reset --hard`、不 `checkout -f`、不 `--force`、不掩盖。
  （已知残余：一旦落在这个终态，`dev` 可能已经前进而批次是终态，产品路径不再能就同一候选重做集成；
  人工修法是先按 detail 里的命令把检出对齐 ref，再从当前 `dev` 基线重新组批。）

### D06：明确不做

- 不新增确认、审批、门禁或沙箱；FULL 下常态路径的步数与等待仍然是 0（`--dev-repo` 是**接入时的一次性事实声明**，
  不是每次操作的确认）。
- 不做运行期通道推断（路径/分支/home）；`dev_repo_path` 永远是显式输入。
- 不改 `promotion-service.ts`（它本来就分别使用 `repositoryRoot`=main 与 `devRepoPath`=dev）。
- 不在开发期删除 main 检出里的过渡 `dev` ref，也不声称已经删了。

## Consequences

- **产品会推进用户自己的 dev 检出**：集成成功后 dev clone 的工作区会落到新提交上。代价是「集成期间不要在 dev clone 里
  留未提交改动」（会被拒绝，不会被覆盖），收益是 ref 与工作区不会静默分叉。dev 实例正在跑 dev 代码时，集成会让它
  运行的代码落后于 ref —— 事实如此，不在本格重启它。
- **测试夹具要真的有第二个 clone**：所有需要 dev 基线的既有 e2e 都必须为项目提供一个同 origin、检出 `dev` 的 clone，
  并把它作为 `--dev-repo` 记录下来；fixture 辅助函数同时把本地 Git 身份复制到那个 clone，测试**不允许**依赖开发者的
  全局 Git 配置。
- **UI 的投影缺口（如实记录，N3 领地）**：`apps/ui` 的「添加项目」表单不发送 `devRepoPath`，因此在本 ADR 之后
  会以 `DEV_REPO_REQUIRED` 拒绝。UI 需要增加一个 dev clone 路径输入（与 `--dev-repo` 等价）。本格不改 `apps/ui/**`。
- **dev clone 自己作为项目根的实例**：那种实例找不到合法的 `--dev-repo`（`DEV_REPO_NOT_SEPARATE` /
  `DEV_REPO_BRANCH_MISMATCH`），因此它的 dev 基线操作会被拒绝。这是「必需」的直接后果，作为已知边界记录，不在本格修。
- 删除过渡 ref 之后，任何仍以「本地 `dev`」为假设的外部脚本会失败 —— 本 ADR 只保证 Runtime 自己不再读它。

## Verification

本格必须逐条断言（命令面事实，不使用浏览器/桌面自动化；全部用临时仓库与临时裸远端）：

- `project trust <repo>` 与 `project trust <repo> --dev-repo none` → `DEV_REPO_REQUIRED`、退出码 1、`project list` 仍为空。
- 已信任但 `dev_repo_path` 为空的项目：worktree 准备 / 依赖视图 / 回收计划 / 全量证据运行都以 `DEV_REPO_REQUIRED` 拒绝，
  且分别没有留下 workspace、operation 或 evidence 行。
- `project inspect --dev-repo <clone>` 报告 dev clone 的 `devCommit`、被检查检出自己的过渡 ref 状态与
  `projectsWithoutDevRepo`；CLI stderr 给出可读结论。
- 集成：dev clone 的 `refs/heads/dev`、`HEAD` 与工作区一起前移到 `merged_commit`（含新提交引入的文件确实在磁盘上、
  `status` 为空），main 检出不动；脏检出（未跟踪文件）在组批前就被拒绝且不留批次记录。
- Task 验证与全量证据都对「只存在于 dev clone 的候选 commit」成立，且全量证据的策略仍来自 main ref。
- `packages/git` 层：`inspectDevCheckout` 的三类事实（在 dev/干净/HEAD）与 `fastForwardCheckedOutWorktree` 的
  成功判据（ref+HEAD+`status`）各有用例，包括「本地改动会被覆盖时拒绝且不改动现场」。

## Related

- 被修订：[ADR-0018](0018-task-result-integration-into-dev.md)（`DEV_REF_CHECKED_OUT` 与推进方式）
- 配套：[ADR-0009](0009-main-dev-promotion-and-restart.md)、[ADR-0038](0038-branch-targeted-tests-and-dev-full-suite.md)、
  [ADR-0039](0039-layered-verification-evidence.md)、[ADR-0047](0047-github-mediated-promotion.md)、
  [ADR-0048](0048-dev-clone-and-separate-runtime-home.md)、[ADR-0052](0052-promotion-fact-layering.md)、
  [ADR-0053](0053-multi-member-integration-batch.md)
- `docs/architecture/git-workspace-api.md`（§2 根分工表、§3 集成推进）、`docs/architecture/state-machines.md`（§4、§8）
- `docs/guides/cli-reference.md` §1/§3/§15、`manual.md` §3、`recipes.md`、`troubleshooting.md`、`getting-started.md`
- `docs/tasks/README.md` 的 FOUNDATION-087 记录
