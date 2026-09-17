# ADR-0075：多机并行开发 —— clone 布局与 `dev` 单写者

Status：Accepted（本轮用户选择题确认：`dev` 写入权取「单写者」、第二台机只建 dev clone、约定写进 ADR + runbook、`origin/dev` 暂不推送；四题均取推荐项）。**纯文档，无代码、无 schema、无命令面变化。**

**Amends** [ADR-0048](0048-dev-clone-and-separate-runtime-home.md) 的「本机两个 clone」口径：ADR-0048 描述的是一台机器上的布局，本 ADR 把它扩展为多机（一台稳定机 + N 台开发机）并冻结 `dev` 的写入权。ADR-0048 的其余部分（两个 clone 是**独立仓库**而非彼此的 worktree、dev 用独立 `CODEESTRA_HOME`）继续有效，并在每台机器上各自成立。

## Context

- 现有权威出处只覆盖**一台**机器：`AGENTS.md` 只写不变量、细节在 [`docs/agents/runbook.md`](../agents/runbook.md) §1（`~/Documents/codeestra` 检出 `main` 并跑稳定 Runtime；`~/Documents/codeestra-dev` 检出 `dev` 做开发与集成）。「第二台机器怎么接进来」没有任何 ADR 或 runbook 段落回答。
- 要并行的不止 Git 提交：`dev → main` 的证据链要求「提升前在**精确 dev 候选 SHA** 上跑一次全量测试」（ADR-0038/0039 + `AGENTS.md`），而提升的四步事实核对是**单点动作**。多台机器都推进 `dev`，候选 SHA 会反复移动，全量证据频繁作废，且「谁的 `dev` 是尖端」变成需要人工对齐的问题。
- 不可共享的状态必须如实承认：Task/Session/Execution/verification 记录在各机器自己的 `CODEESTRA_HOME` SQLite 里；Runtime owned worktree 在各机器数据目录下；[ADR-0074](0074-managed-integration-ref-and-merge-queue.md) 的 `refs/codeestra/integration` 是私有命名空间、默认 push 带不走。**「并行开发」可传输的只有 Git 提交，不是 Runtime 状态。**
- 本条只约束**本仓库自身的开发流程**，不是产品能力——与 ADR-0048/0060 同一口径：产品不提供 dev clone、不提供提升命令，也不校验这些约定。

## Options

### D01 `origin/dev` 的写入权

- **A（选中）单写者（稳定机独占）**：`dev` 的合入与 push 固定在稳定机（本机即机器1）。开发机只把 **feature/task 分支**推到 `origin`，由稳定机 `git fetch` 后**由人**合入 `dev`。`dev` 候选 SHA 的推进因此串行化：全量证据不会被另一台机器随手一次 push 作废。
- B 双写者：每台机器都能合入并 push `dev`，push 前必须 `git fetch && git merge origin/dev`，被拒即停下重跑定向测试、绝不 `--force`。并行度最高，但 `dev` SHA 搅动快、证据易失效，且依赖每台机器长期遵守纪律。
- C 经 GitHub PR：开发机推 feature 分支后开 PR 合并进 `dev`。需要仓库侧另行配置；当前没有分支保护、必经评审或 CI 门禁，本 ADR 不声称已具备，也不代为配置。

### D02 第二台机器的角色

- **A（选中）只建 dev clone**：开发机只检出 `dev`、只跑独立 `CODEESTRA_HOME` 的 dev 实例；不建 main clone、不跑稳定 Runtime、不执行提升。提升四步与「重启 main 稳定服务」仍然只在稳定机发生。
- B main + dev 都建、提升只在稳定机：开发机也有稳定实例，它的 `main` 只能从稳定机推回的 `origin/main` 用 `--ff-only` 拉取；两台 stable 版本可能不一致，且需要回答「哪台为准」。
- C 两台各自独立提升：每次提升要在两台机器各做一遍四步核对，任一台失败即保留现场；事实核对体量翻倍，稳定实例版本容易分叉。

### D03 约定是否写进仓库

- **A（选中）新增 ADR + 更新 runbook**：runbook §1 是本仓库布局的唯一权威出处（`AGENTS.md` 已把细节指向它），多机必须写在那里；「为什么这样定、不选什么」写本 ADR。
- B 只改 runbook、不新增 ADR：改动更小，但决定与理由没有留档，索引无法追溯。
- C 不写文档、只做本机配置 / 口头约定：下一个 Agent 或几个月后的维护者会按 runbook 的单机假设操作，把开发机当成稳定机。

### D04 是否新增机器门禁

- **A（选中）不加代码守卫**：稳定机专属动作在开发机上会**自然失败**——`just restart-main` 要求所在检出当前分支是 `main`，`just promote-main` 还要求工作区干净，而开发机上没有 main clone，`cd` 一步即失败并报错。新增「本机是否稳定机」的校验属于新增审批层，与 ADR-0008/0011 的效率原则相悖，收益只是把必然失败换成更早失败。
- B 在 `Justfile` 加机器身份守卫：多一份机器配置与一条新失败路径，不改变任何语义。

## Decision

1. **角色**：`dev` 集成与 push 的**单写者是稳定机**（机器1）。开发机（机器2…）只做代码工作，成果经 `origin` 上的 **feature/task 分支**交给稳定机；合入 `dev` 始终是人的 `git merge`（`AGENTS.md`：`dev` 合入是人工 Git 动作）。
2. **开发机布局**：`~/Documents/codeestra-dev` 检出 `dev`（`git switch dev`，跟踪 `origin/dev`），`CODEESTRA_HOME=~/.local/state/codeestra-dev`。**不建 main clone、不跑稳定 Runtime、不执行提升。**
3. **开发机的 `dev` 只前进、不改写**：只允许 `git fetch origin` + `git merge --ff-only origin/dev`；不 `--force`、不在 `dev` 上直接 commit、不把本地 `dev` 当集成目标。要写代码就建 feature/task 分支或 worktree（本机约定，例如 Orca workspace 或 `git worktree`）。
4. **开发机可以推、不可以推**：可推 feature 分支与 Runtime 生成的 `task/*` 成果分支——这是成果的传输方式。**不推 `dev`、不推 `main`、不推 `refs/codeestra/*`**（后者是私有命名空间，且在本仓库只服务该机器本地的集成事实）。
5. **开工前提**：开发机第一次 `project trust` / 建 workspace 之前，`origin/dev` 必须已推进到稳定机确认的 dev 候选，且开发机本地 `dev` 与之完全一致（`git rev-list --count dev..origin/dev` 与反向都为 0）。原因是 Task 基线由 `project trust` 从**当时项目文件夹检出的分支 commit** 物化（ADR-0074 D02）——检出落后会把集成基线钉在旧 commit 上，而**已存在的 `refs/codeestra/integration` 永不被移动**（ADR-0074）。趁早对齐是唯一便宜的时点。
6. **环境各自独立**：每台机器各自 `bun install --frozen-lockfile`，各自 `node_modules` 与 `CODEESTRA_HOME`；数据库、worktree、验证副本都不同步、不共享。路径与 `Justfile` 默认值不同时用 `CODEESTRA_MAIN_CLONE` / `CODEESTRA_DEV_CLONE` / `CODEESTRA_DEV_HOME` 覆盖。
7. **不作为**：不新增机器身份校验或审批层；不同步 Runtime 状态（Task/Session/Execution/verification/worktree/`refs/codeestra/*`）；不把「另一台机器的 Task 已完成 / 已集成」当作本机事实；不声称任何跨机一致性或 exactly-once。开发机若自行跑 `project integration run`，那只是**该机器本地**的集成事实，不等于成果已进 `dev`。

## Consequences

### Positive

- `dev` 候选推进串行化：提升前的全量测试证据（ADR-0038/0039）不会因为另一台机器的一次 push 而失效。
- 开发机不需要理解提升规程：它没有 main clone，稳定机专属命令必然失败，误操作面天然收窄。
- 成果的传输方式就是普通 Git（feature/task 分支），不引入第二套同步机制、不加门禁、不依赖网络常连。

### Costs and risks

- **并行度上限是「一台机器一个 feature 分支」的串联**：两台机器的成果都要回到稳定机合入 `dev`，合并在那里串行发生。
- **Runtime 状态不跨机**：在机器1 建的 Task 不能在机器2 继续；机器2 的 Task/verification/worktree 记录只在本机有意义。跨机延续任务当前**不是产品能力**。
- **`origin/dev` 的推进是人工步骤**：本 ADR 落地时 `origin/dev` 落后本机 `dev`，在稳定机推送之前，开发机拿不到 S1–S8 这批内核工作，也就不能开工（D05 的前提）。
- 开发机推 `task/*` 分支时需要自己的 GitHub 凭据；凭据缺失时只能报告「无法推送」，不得改用别的传输方式绕开 `origin`。

## Verification

本条为纯文档决策，验证方式是**事实核对**，不含代码或 schema 变更：

1. 落地时核对：本机 `origin/dev` 与 `dev` 的关系（`origin/dev..dev` = 16、`dev..origin/dev` = 0，本地 `dev` 工作区干净），据此写明「开发机开工前提」。
2. 已核对的命令面事实：`just restart-main` 要求检出当前分支为 `main`、`restart-dev` 要求 `CODEESTRA_HOME`、`promote-main` 额外要求工作区干净（`Justfile`），因此开发机上这些动作会失败而不是静默生效。
3. 索引与链接：`docs/decisions/README.md` 新增本 ADR 项并更新「本机布局与客户端」语义条目；`docs/agents/runbook.md` §1/§2/§3/§5 按本 ADR 改写；`README.md` 的「本机工作树」表补开发机一行。全部为相对链接，人工核对无断链。
4. **未做、也不得声称**：没有配置 GitHub 分支保护/评审/CI；没有跨机同步任何 Runtime 数据；没有实测两台机器同时工作的场景（第二台机器尚未接入）；`origin/dev` 在本次交付中**未被推送**。

## Related

- [ADR-0048](0048-dev-clone-and-separate-runtime-home.md)（本条扩展其单机布局口径；两个 clone 独立、dev 独立 home 继续有效）
- [ADR-0074](0074-managed-integration-ref-and-merge-queue.md)（`project trust` 物化 integration ref、已存在的 ref 永不移动 ⇒ 决定 D05 的开工前提）
- [ADR-0009](0009-main-dev-promotion-and-restart.md) / [ADR-0047](0047-github-mediated-promotion.md)（`dev → main` 人工四步与经 GitHub 中转，本 ADR 不改动）
- [ADR-0038](0038-branch-targeted-tests-and-dev-full-suite.md) / [ADR-0039](0039-layered-verification-evidence.md)（全量证据绑定精确 dev SHA ⇒ 决定 D01）
- [ADR-0008](0008-efficiency-first-service-form.md) / [ADR-0011](0011-default-full-permission-mode.md)（不加门禁、0 步 0 等待 ⇒ 决定 D04）
- [ADR-0060](0060-managed-project-task-baseline.md)（产品侧基线来源；本 ADR 只补「检出落后会污染基线」的多机后果）
- `docs/agents/runbook.md`、`README.md`、`AGENTS.md`
