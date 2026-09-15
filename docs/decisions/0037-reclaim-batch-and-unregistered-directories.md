# ADR-0037：`reclaim` 的跨项目批量与未注册目录的显式处置

Status：Accepted（用户已拍板形态：扩展现有 `reclaim plan/apply/records` 命令面，不加第二个命令；`apply` 仍逐条归属核验、保留失败现场）

## Context

ADR-0021 只允许回收三种**已登记**资源（Task worktree / 验证副本 / integration worktree），删除对象完全由
`workspaces` / `verification_runs` / `integration_batches` 三条记录决定。这留下了 `## NEXT` 第 5 项的两半缺口：

- **跨项目批量**：`reclaim` 只能按 `--project`（或 `--task`）一个个项目跑，多项目清理没有单命令路径，
  与「CLI 必须能完整完成并可脚本化驱动」的第一原则不符；
- **未注册目录**：Runtime 数据目录里那些**不在账本里**的目录（半途中断、历史遗留、被其它工具放进来、
  trust 被撤销后的残留）只能人工 `rm -rf`——正好绕过归属校验与留痕，是 ADR-0021 最不想看到的用法。
  ADR-0021 D04 明确写着「未记录且未注册的目录需要人工确认后处理，本轮不提供『清理一切』的开关」，
  本 ADR 就是给这件事一个**有界、有证据、默认不删**的命令面。

本 ADR 不改变 ADR-0021 的归属判定顺序与「失败现场默认保留」，只扩展作用域（多项目）与对象类别（未注册目录），
并如实记录由此产生的 schema 与退出码变化。

## Options

1. 命令形态：
   - A. 新增第二个命令（`reclaim adopt` / `reclaim prune-unregistered`）；
   - B. **扩展现有 `plan`/`apply`/`records` 的选项**（用户已拍板）；（选择）
   - C. 只在 UI 里做。
2. 批量语义：
   - A. 单个 operation 覆盖所有项目（一次失败整批 `FAILED`）；
   - B. **每个项目一个独立 operation、独立结局、独立账本行**，聚合报告如实汇总；（选择）
   - C. 批量只允许 `plan`，`apply` 仍必须逐个项目。
3. 未注册目录的删除门槛：
   - A. `apply --unregistered` 即删除所有通过校验的目录；
   - B. **默认 dry-run（`RETAIN`），只有 `--remove-unregistered <path>` 显式点名才删**；（选择）
   - C. 要求新的确认/审批步骤。
4. 归属证据：
   - A. 只看路径形态（是否在 `<home>/worktrees/<project>/<task>`）；
   - B. **路径形态 + Git 标记文件/注册 + 账本无认领 + 项目可信 + 进程表 + 工作区干净**，任一不可核验即不删；（选择）
   - C. 复用已登记资源的三重校验（symlink/注册/ref），但跳过进程检查。
5. 账本载体：
   - A. 新建一张只放未注册目录的表；
   - B. **同一本 append-only 账本**，用 `source` 区分来源；（选择）
   - C. 只写事件不写账本。
6. 无法归因到任何已知 project 的目录（项目行不存在）：
   - A. 记到任意一个可信项目名下；
   - B. **`RECOVERY_REQUIRED` 报告但不入账本**（账本是 project 作用域，凭空归因正是本能力要防的事）；（选择）
   - C. 为 home 引入一张无 project 的并行账本。
7. 退出码：
   - A. 保持 ADR-0021 D03：`plan`/`apply` 只在真失败时非 0；
   - B. **`0` = 有可回收项 / 确实回收了；`3` = 无可回收项（正常 no-op）；`1` = 失败**（Amends ADR-0021 D03）；（选择）
   - C. 只在批量模式下区分。

## Decision

### D01：作用域是显式的，缺失不等于任意一边

`reclaim plan|apply|records` 接受 `--project <id>`、`--all-projects` 二者之一；两者同时给出、或给出 `--task`
却没有 `--project`，CLI 直接 usage 退出（exit 2），Runtime 侧 `resolveReclaimScope` 也以
`PROJECT_SCOPE_CONFLICT` / `PROJECT_SCOPE_REQUIRED` 拒绝。**省略 `--project` 的含义是「全部可信项目」**，
并且这个含义由 CLI 明确翻译成 `allProjects: true` 发送，不依赖缺失字段的隐含默认。

`records` 的批量读取按项目取各自最新 `limit` 行后合并排序再截断：全局最新 `limit` 行不可能来自某个项目的
第 `limit+1` 行，所以结果与「一次全局查询」等价。

### D02：批量 = 每个项目一个独立 operation，聚合报告如实汇总

- `apply --all-projects` 对**每个** ACTIVE-trusted project 各自调用一次已有的单项目 `apply`，命令 ID 由批命令 ID
  与 project ID 确定性派生（`sha256(commandId:projectId)` 形式的 UUID），因此：
  - 每个项目有自己的 `operations` 行、自己的 receipt、自己的 `reclamation_records` 行；
  - 重复执行同一批命令按项目命中各自的 receipt，不会二次记账；
  - 一个项目的拒绝、失败、甚至**无法读取**都不影响其它项目——失败的项目进入顶层 `failures`
    并以 `projectError` 出现在自己的分组里，绝不静默消失。
- 顶层 `outcome` 只有在**没有**项目失败且没有任何 `FAILED` 记录时才是 `SUCCEEDED`。
- 批量**不是**「一句话删光」：`--include-failure-scenes`、逐条归属核验、活跃 Execution/预留保护一概不变。

### D03：未注册目录 = 有界扫描 + 默认不删 + 显式点名才删

- **扫描有界**：只在 `<CODEESTRA_HOME>/{worktrees,verifications,integrations}/<project-id>/<resource-id>`
  这两层上走，不递归、不跟随 symlink、最多 500 个候选（超出记 `truncated: true`），
  可用 `--scan-root <绝对路径>` 收窄到 home 内任意子树（home 之外的扫描根以 `SCAN_ROOT_OUTSIDE_HOME` 拒绝，
  相对路径以 `SCAN_ROOT_NOT_ABSOLUTE` 拒绝）。这回应「不要扫全盘」。
- **判定依据随结果一起返回**（不是散文）：`layout`（路径形态）、`runtimeHome`（所属 home）、
  `gitMarker`/`gitMarkerTarget`（Codeestra 标记文件）、`ledgerClaim`（账本是否已认领）、`registered`/`registeredBranch`/
  `registrationHead`（Git 注册事实）、`clean`/`trackedModifications`/`untrackedFiles`、`processCheck`/`processesInUse`、
  `explicitlySelected`。
- **判定顺序（任一不满足即不删）**：symlink → 不在 owned root 内 → 账本已认领（可信项目，直接排除出候选；
  不可信项目则 `CLAIMED_BY_UNTRUSTED_PROJECT`）→ 项目不可信/无项目行（`PROJECT_NOT_TRUSTED`）→ 无 `.git` 标记
  （`NOT_A_CODEESTRA_WORKTREE`）→ Git 注册不可读（`GIT_INSPECTION_FAILED`）→ Git 工作区状态不可读
  （`GIT_STATE_UNAVAILABLE`）→ 进程表不可读（`PROCESS_CHECK_UNAVAILABLE`）→ 有进程工作目录在里面
  （`PROCESS_IN_USE`）→ 有未提交改动（失败现场，`--include-failure-scenes` 才可越过）→ 未被点名
  （`UNREGISTERED_REQUIRES_EXPLICIT_SELECTION`，`RETAIN`）。前面那些不可核验的情况一律 `RECOVERY_REQUIRED`。
- **默认 dry-run**：`plan` 永远不删；`apply --unregistered` 不点名任何路径时也只 `RETAIN` 并记账。
  真正删除需要 `--remove-unregistered <path>`（可重复）显式点名**那一个目录**。这是「显式选择」，
  **不是**新增审批：FULL 下常态 `reclaim apply --project X` 一步未增，`--unregistered` 本身也不弹任何确认。
- **删除时重核**（不是照抄计划的结论）：每个被点名的目录在删除前重跑一遍同一套判定（同一份进程表读数），
  再加权：Git 已注册 → 走既有 `removeOwnedWorktree`（重新校验注册/branch/HEAD 后 `git worktree remove` + prune）；
  未注册 → 本服务自己的窄删除：重新校验 owned root、路径恰好是 `<root>/<uuid>/<uuid>`、`.git` 标记仍在，
  然后只 `rmSync` 那一个目录。**不删 branch**、不用 `git clean`/`reset --hard`、不用 `--force`。

### D04：账本同一本，靠 `source` 与 kind 区分来源（schema v24）

`reclamation_records` 重建为 v24，纯 additive：

- 新增 `source TEXT NOT NULL DEFAULT 'REGISTERED' CHECK(source IN ('REGISTERED','UNREGISTERED_DIRECTORY'))`；
- `kind` 的 CHECK 增加 `'UNREGISTERED_DIRECTORY'`；
- `outcome` 的 CHECK 增加 `'RECOVERY_REQUIRED'`（归属无法核验时唯一诚实的结果）；
- `task_id` 改为可空：`verifications/<project>/<id>` 这类残留有 project（路径分段就是归属证据）却没有可诚实
  归因的 Task，凭空填一个 Task 正是本能力要防的假归因；
- 既有行原样拷贝并盖上 `REGISTERED`，两个旧索引保留，新增 `reclamation_records_by_source`。

v24 是本格的号：22/23 属于并行的 H1/H3 格，16 永久未使用，`if (version < 24)` 追加在既有升序步骤之后。

### D05：进程检查是 OS 事实，不是猜测；拿不到就 fail closed

「是否仍有进程在用」通过一次性读取进程表回答：Linux 走 `/proc/<pid>/cwd`，否则走
`lsof -a -d cwd -Fpn`（macOS 实测约 2s，只在 `--unregistered` 时发生一次）。候选目录内有任何工作目录即
`PROCESS_IN_USE`；两种方式都不可用时 `PROCESS_CHECK_UNAVAILABLE`，**不删**。
边界如实记录：只比对**工作目录**；一个把 cwd 设在别处、却持有该目录内文件句柄的进程不会被发现。

### D06：活跃预留与已登记资源同等对待

已登记 Task worktree 的判定新增一条：`execution_slot_reservations` 中处于 `RESERVED`/`RECOVERY_REQUIRED`
的预留仍认领该 workspace 时，一律 `REFUSE/ACTIVE_RESERVATION`，且**不受** `--include-failure-scenes` 影响
（预留会活过它将要启动的那次 Execution，是一个独立的活跃主张）。删除前还会再读一次该预留
（`findActiveWorkspaceReservation`），`releaseWorkspaceForReclamation` 也新增了同样的拒绝，因此计划与执行之间
新发的预留不会让目录被删掉。

### D07：Amends ADR-0021 D03 的退出码

ADR-0021 D03 写的是「`apply` 有资源删除失败时退出码 1，`retained`/`refused` 是正常决策、退出码 0」。
本 ADR 把它精确化：`plan` 与 `apply` 都用

| 退出码 | 含义 |
|---|---|
| 0 | `plan`：至少有一条 `RECLAIM`（或已点名的未注册删除）；`apply`：确实 `RECLAIMED ≥ 1` |
| 3 | 正常 no-op：没有任何可回收项 / 这次什么都没回收到（全部 `RETAINED`/`REFUSED`/`ALREADY_ABSENT`/`RECOVERY_REQUIRED`） |
| 1 | 真的失败：删除失败、请求被拒（`NOT_FOUND`、范围冲突、扫描根越界等） |
| 2 | CLI 用法错误（与既有 `usage()` 一致） |

`retained`/`refused` 仍然是**正常决策**（不是失败），只是不再与「确实回收了东西」共用一个退出码。
stderr 在退出码 3 时保持为空，`--json` 是脚本唯一需要读的东西。

### D08：明确不做的两件事

1. **不为未注册目录新增审批层**。ADR-0008/0011 的零确认预算不变；「显式」由 `--remove-unregistered`
   这一选项表达，FULL 下不弹确认、不要求 `--yes`、不要求输入数量。
2. **不自动回收**。没有定时清理、没有 `reclaim all`、没有「清理一切」开关；`plan` 永远是只读的，
   任何删除都必须经过 `apply` + 显式点名。

## Consequences

- 多项目清理从「N 次命令」变成「一次命令 + 按项目分组的稳定 JSON」；`--json` 形状稳定（单项目仍是原来的
  扁平 `ReclaimPlan`/`ReclaimReport` 加 `scope`/`unregistered` 字段，批量是 `scope: ALL_PROJECTS` 加 `projects[]`
  分组 + 聚合 `counts`/`outcomeCounts` + `operations[]`/`failures[]`）。
- 目录回收不再需要人工 `rm -rf`：未注册目录有了带证据的列举、默认保留、显式点名删除与同一本账的留痕。
- **已知边界（如实记录）**：无法归因到任何 ACTIVE-trusted project 的目录（`projects` 行不存在，或 trust 已失效）
  只在 `plan`/`apply` 输出里列为 `RECOVERY_REQUIRED`（批量时在 `unregistered.unattributed`），**不入账本**——
  账本是 project 作用域且 `operations.project_id` 非空，把别人的目录记到某个项目名下正是本能力要防的假归因。
  要清理它们需要先把项目重新 trust（或另行决策一个 home 级账本）。
- **性能**：批量 `apply` 每个项目一次独立事务；`--unregistered` 会多一次全量进程表读取（macOS ~2s）和一次有界目录遍历，
  只在显式要求扫描时发生。常态路径（不带 `--unregistered`）的耗时与 ADR-0021 完全一致。
- 未被任何记录识别的**非目录**条目（文件）不进入候选，也不会被删除；`--scan-root` 之外的一切都不看。
- 退出码 3 是相对 ADR-0021 的行为变化：调用方若把非 0 一律当失败需要更新（本仓内只有本格的 CLI 测试，
  已一并更新）。

## Verification

只通过 CLI/Runtime 命令面与临时仓库验证（ADR-0008），不使用桌面或键鼠自动化：

1. `apps/runtime/test/cli-reclaim-batch.test.ts`（新，10 项）：两个真实临时仓库 + 一个真实 Runtime 的跨项目批量
   （项目 A `RECLAIMED`、项目 B 因活跃预留 `REFUSED`，一条拒绝不影响另一条，账本按项目读回、按来源过滤）；
   一个空的批量 `plan`/`apply` 退出码 3；真实 `git worktree add` 造出的未注册 worktree 被列出（证据含
   `layout`/`gitMarker`/`ledgerClaim`/`processCheck`）→ 默认 `RETAIN` 且目录仍在 → `--remove-unregistered`
   点名后删除且 **branch 保留**、重复执行不二次记账；`git clone` 造出的未注册 checkout（Git 不注册）走窄删除；
   项目行不存在的目录与无 `.git` 标记的目录在显式点名后仍 **不删**（`ls` 前后对比断言目录与内部文件仍在）、
   记 `RECOVERY_REQUIRED`（可归因的那个）；`--scan-root` 越出 home 被拒；活跃预留保护的
   `REFUSE/ACTIVE_RESERVATION`；按 `--source` 与 `--since/--until` 读账本；v21→v24 迁移保留既有行、
   `foreign_key_check` 为空、新 CHECK 拒绝非法值、`task_id` 可为空。
2. `apps/runtime/test/cli-reclaim.test.ts`（既有，更新）：无操作 / 拒绝路径的退出码从 0 改为 3。
3. 全量 `bun run check` 与端到端证据（两仓库批量 + 未注册目录 + 无法核验不删）：见
   `docs/tasks/README.md` FOUNDATION-062 的「实际验证」。
4. 未验证：跨用户/跨机器场景（`lsof` 对其它用户进程的可见性、`/proc` 与 `lsof` 之外的平台）；真实磁盘压力下的
   大批量（>500 候选被 `truncated` 截断的路径只有单元级覆盖）；UI 投影（本格不做）；陈旧注册（Git 仍注册、
   目录已不在）的未注册分支；把 `reclaim` 接入任何自动路径。

## Related

- `PROJECT_SPEC.md` §1.1（效率至上、CLI 完备、测试仅限命令面）、§2 不变量 7/12/24
- `AGENTS.md`（资源回收必须有归属校验、保留失败现场、不 `--force`）
- ADR-0008 / ADR-0011（FULL 零确认，不新增门禁）
- ADR-0016（归档是软删除、物理回收是独立高风险能力）
- ADR-0021（`reclaim` 的归属校验、账本、默认保留失败现场；本 ADR **Amends D03 的退出码**）
- ADR-0025（Runtime 生命周期与所有权：不按名字杀进程、只报告不猜测）
- ADR-0032（槽位预留：释放是显式的，活跃预留是真实占用）
- `docs/tasks/README.md` FOUNDATION-062
