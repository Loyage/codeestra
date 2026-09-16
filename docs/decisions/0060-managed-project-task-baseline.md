# ADR-0060：被管理项目的 Task 基线是「指定的项目文件夹」；dev clone 变为可选

Status：Accepted（用户 2026-09-16 决策）。**已实现**（FOUNDATION-093，schema **v33**），包括 D01 里的显式 `--base-ref` 覆盖（`task run --base-ref`，已有 workspace 的 Task 以 `TASK_BASE_REF_ALREADY_FIXED` 拒绝而非忽略）、D02（managed 的集成/提升仍以 `DEV_REPO_REQUIRED` 拒绝，`reclaim` 不再要求 dev clone）与 D04 的退役判据重定义（`publishedOnRemote`）。

**修订 2026-09-16（第三轮，用户报缺陷）**：D05 曾把「依赖判定」列入需要长期 `dev` 分支的操作，而依赖判定位于 `task submit` / `task run` / `task depends list` 的**常态路径**上——于是 managed 项目实际**无法 submit/run**，与 D01/D02「managed 的 trust → task → run → verify 常态路径不变」直接矛盾。用户裁决「一般项目根本不需要 dev，取消这个限制」。修订：Task 基线解析、依赖判定、槽位预留、调度启动前重检、影响分析基线、结果 commit 归属、任务级验证与回收一律按本 ADR 的基线/归属规则解析；`DEV_REPO_REQUIRED` 只剩 `task integrate`、`promotion *` 与 `promotion full-suite run`。

**未做的部分与已知边界**逐条列在 `docs/tasks/README.md` 的 FOUNDATION-093「仍未做」一节（UI 无 base-ref 输入、retry/resume 不接受该 flag、未跑全量），不得当作已完成。
**Amends ADR-0056 的必需性**（`dev_repo_path` 由必需改为可选）与 **ADR-0018/0056 的基线来源**（无 dev clone
的项目从项目文件夹取基线）。**不放宽任何其它不变量**（不新增确认、不新增门禁、FULL 常态路径仍是 0 步）。

## Context

ADR-0048/0056 把本机 Codeestra 自己的两个 clone（`main` 稳定 / `dev` 开发）当成了**每个被信任项目**的模型：
`projects.dev_ref = refs/heads/dev`、`projects.dev_repo_path` **必需**，Task worktree 从 dev clone 的本地 `dev`
ref 建基线，集成与提升也都写回那个 clone。用户 2026-09-16 更正了这个范围：

- 两个 clone 的拆分**只为 Codeestra 自身的开发（自进化）**，与「用 Codeestra 开发别的项目」无关；
- main/dev 双分支（双检出）模型**只属于 Codeestra 自身**，被 Codeestra 管理的其它项目**不应被要求**有
  `dev` 分支或 dev→main 提升路径。

用户就替代形态作出的选择（本轮 A/B/C 选择题，逐项均选推荐项）：

| 问题 | 用户选择 |
|---|---|
| 被管理项目的 Task 从哪个 ref 建基线 | **项目文件夹当前检出的分支**（建任务时读 HEAD 并固定 OID），另给显式覆盖 |
| 被管理项目的成果 commit 集成到哪里 | **成果留 task 分支，用户自己合**（不自动集成、不提升） |
| self 与 managed 怎么区分 | **不新增模式字段**：`dev_repo_path` 变回可选；记了 dev clone 才有 dev 基线与提升 |

## Options

1. 基线：本项目文件夹当前检出分支 / 仓库主分支 / 必须显式指定（用户选 1）。
2. 成果去向：留 task 分支由用户合 / 自动合回基线 ref / 默认不合 + 显式合并命令（用户选 1）。
3. self/managed 区分：`dev_repo_path` 变可选 / 新增 `--mode self|managed` / 彻底改为能力可选（用户选 1）。

## Decision

### D01 两种基线，按「有没有 dev clone」分派

- `projects.dev_repo_path` **不再必需**。记了 dev clone 的项目：基线仍是 dev clone 的本地
  `refs/heads/dev`（ADR-0048/0056 的语义一字不变，用于 Codeestra 自身与任何确实要 dev 分支的项目）。
- 没记 dev clone 的项目（**managed**）：Task worktree 从**项目文件夹**（`projects.repo_root`）的**当前检出
  分支**建基线——建 workspace 时读 `HEAD`，把**符号引用**（`refs/heads/<branch>`）与它的 commit 一起固定下来，
  写在这次操作与 workspace 记录里。之后用户在那个目录里切分支**不会**改变已建 Task 的基线。
- 不推断、不猜测：`HEAD` 是 detached 时以稳定码 `TASK_BASE_REF_UNRESOLVED` 拒绝并说明补救方式
  （切到一条分支，或用下面的显式覆盖），绝不静默用别的 ref 代替。
- 显式覆盖：`task run` 新增可选 `--base-ref <ref>`（必须是该项目文件夹里存在的 ref），用于「我就要从这条分支/
  远端分支建基线」的场合；它是**Task 级**的，不写回项目、不改其它 Task。

### D02 集成与提升只对「有 dev clone」的项目成立

- `task integrate`、`promotion *`、`promotion full-suite run` 需要长期 `dev` 分支，因此**只在记了 dev clone
  的项目上成立**；没有记的项目继续以既有的 `DEV_REPO_REQUIRED` 拒绝（**不是新增门禁**：这些能力本来就不存在，
  现在拒绝的是「没有那条分支」，不是「新的审批」）。
- managed 项目的成果 commit 停在 `refs/heads/task/<task-id>`（ADR-0005/0018 的既有事实），合并由用户自己做。
  Codeestra 不自动合、不自动推、不做提升记账。
- 不新增任何确认、不新增任何拒绝路径的「审批」语义：managed 路径的常态操作（trust → task → run → verify）
  步数与等待与今天相同。

### D03 不加模式字段，事实是「路径有没有」

- 不新增 `mode` 列、不在命令面新增 `--mode`：`projects.dev_repo_path IS NULL` 就是 managed。这样既有数据
  （已记 dev clone 的项目）语义不变，也不需要回填。
- `project inspect` 如实报告两侧：`devRepoPath: null` 且 `devRepoInspection: null` 表示 managed；有值时与今天一致
  （含 `DEV_REPO_*` 稳定码）。「managed」不是错误状态，不打印补救命令。

### D04 单一事实仍然是「记录下来的东西」，不是路径猜测

- 基线提交固定进 workspace 记录（新增 `workspaces.base_ref`，schema **v33**；`base_commit` 已有）。
  读回时用 `COALESCE(workspaces.base_ref, projects.dev_ref)`，因此历史记录（写过 dev ref 的）仍然如实。
- worktree 的属主仓库（`repoRoot`）继续用 `COALESCE(projects.dev_repo_path, projects.repo_root)`：managed 项目
  的 worktree 属于项目文件夹自己，回收/核对按同一个根走。
- 不做运行期「按路径/分支名猜通道」（ADR-0048 D05 不变）。

### D05 新增/重定义的稳定码（用户可见）

- `TASK_BASE_REF_UNRESOLVED`：managed 项目的文件夹处于 detached HEAD，没有分支可作基线（切到一条分支，或用 `--base-ref`）。
- `TASK_BASE_REF_MISSING`：显式给出的 ref 在该仓库里不存在。
- `TASK_BASE_REF_NOT_A_BRANCH`：显式给出的 ref 不是本地分支（`refs/heads/…`）。
- `TASK_BASE_REF_ALREADY_FIXED`：Task 已有记录的 workspace，基线已固定；该 flag 只对新 workspace 生效，**拒绝而不是忽略**。
- `DEV_REPO_REQUIRED` 保留，但**不再是 trust 的拒绝码**：它只出现在需要长期 `dev` 分支的操作上（`task integrate`、`promotion *`、提升前全量证据）。
  **修订（见 Status）**：「依赖判定」已从这份清单里移除——它位于 `task submit`/`task run` 的常态路径上，
  把它当作 dev-only 会让 managed 项目完全无法启动任何 Task。依赖判定改读「该项目记录的 Task 基线 ref」
  （有 dev clone = 该 clone 的 `dev`；managed = 项目文件夹当前检出的分支），读不到就按未满足阻塞
  （`DEV_BASELINE_MISSING`，ADR-0024 的 fail-closed），**不因此拒绝命令**；需要精确拒绝码的启动路径仍由
  `slot-reservation`/workspace 准备以 `TASK_BASE_REF_*` 拒绝。原因码本身（`DEV_*`）未改名：它们是 ADR-0024
  记录的有界枚举，改名需要另一次 ADR 修订。

## Consequences

- **范围**：Codeestra 自身的两个 clone 与人工提升流程（ADR-0047/0048/0056）**不变**，`AGENTS.md` 的人工四步不变；
  变的只是「其它项目也被强制要求同样形态」这一条。
- managed 项目的 Task worktree 直接注册进用户自己的仓库（`git worktree list` 会出现一个 Runtime 数据目录下的
  worktree）。这是 ADR-0005 的既有形态，不是新增副作用；回收仍走 ADR-0021/0037 的归属校验。
- 影响面（实现必须逐一核对，不得只改一两个入口）：`project trust`/`open`/`inspect` 的 `--dev-repo` 必需性、
  Task 基线解析、workspace 准备与重启对账、结果 commit 归属、验证副本根、回收、impact 分析基线、集成与提升的
  拒绝码、UI 的项目接入与项目页投影、`docs/guides/**` 与 `sqlite-schema.md`。
- 已 Accepted 的 ADR-0056 的「`dev_repo_path` 必需」被本 ADR 收窄为「需要 dev 事实的操作仍然必需」；
  ADR-0018 的「Task 基线固定为 dev」被收窄为「有 dev clone 的项目固定为 dev clone 的 dev」。
  **两份 ADR 的正文不改**，口径以本 ADR 为准。

## Verification

本格必须逐条断言（CLI/命令面驱动，不用浏览器自动化）：

1. 没有 dev clone 的项目可以被 trust（`--dev-repo` 省略即 managed），trust 后 `project inspect` 报告
   `devRepoPath: null`，且不出现 `DEV_REPO_REQUIRED`。
2. managed 项目建 Task、准备 workspace：worktree 的属主仓库是项目文件夹，`base_commit` 等于该目录当时 `HEAD`
   的 commit，记录的 `base_ref` 是当时检出的分支；用户在解析之后切换分支，已建 Task 的基线**不变**。
3. `HEAD` detached：`TASK_BASE_REF_UNRESOLVED` 拒绝，且不留下 workspace 行、不建 worktree。
4. `--base-ref <ref>` 覆盖成立：基线 ref/commit 等于给定 ref 的读回值；给了不存在的 ref 时以稳定码拒绝。
5. 记了 dev clone 的项目（含 Codeestra 自身）行为与今天逐条相同：基线仍来自 dev clone 的 `dev`，
   `task integrate`/`promotion *` 仍可用；managed 项目调用**它们**仍以 `DEV_REPO_REQUIRED` 拒绝，且拒绝发生在
   任何写入之前。
6. 既有全量证据/验证/回收/impact 的仓库根解析对两类项目都成立（managed 落到项目文件夹）。
7. 第三轮修订（Status）：managed 项目的 `task submit` → 自动启动、`task run`、`task depends list`、
   `task result capture`、`task verify` 全部成立（CLI 命令面驱动，`apps/runtime/test/cli-managed-project.test.ts`
   在一个**连 `dev` 分支都没有**的仓库上跑通 trust → task → run → verify）；`--base-ref` 真正到达 Git
   （workspace 的 HEAD 等于所给 ref 的 commit），detached HEAD 以 `TASK_BASE_REF_UNRESOLVED` 拒绝且不留槽位/workspace 行。

## Related

- `PROJECT_SPEC.md` §2.12、§3、§5
- `AGENTS.md`（本机检出布局、分支与发布工作流）
- ADR-0005（worktree 位置与归属）、ADR-0018（Task 基线）、ADR-0021/0037（回收）、ADR-0038/0039（验证分层）
- ADR-0047/0048/0049（Codeestra 自己的两个 clone 与提升路径，范围不变）
- ADR-0056（本 ADR 收窄其「必需」）、ADR-0059（impact/冲突判定的映射来源）
- `docs/architecture/sqlite-schema.md`（schema v33）
