# ADR-0047：稳定提升必须经 GitHub 中转（远端 `dev` → `main` 检出 ff-only 拉取 → 推回远端 `main`）

Status：Accepted（用户 2026-09-15 决策）。**本 ADR 只落规范与本机工作流；产品命令面的实现留到下一格（见 D06），
在此之前 `promotion promote` 仍是旧的本地 `git merge --ff-only` 路径，本仓库自身不得再使用它。**
**Amends ADR-0009 D02/D03 与 ADR-0022**：提升不再由 Runtime 在 main 工作树内直接 ff 本地 `dev` ref，
而是显式 push 固定候选到远端 `dev`，由 main 检出以 fast-forward-only 拉取，再推回远端 `main`。

## Context

ADR-0009 把稳定提升定义为「固定 dev SHA + 预期 main SHA + 验证证据，只允许 fast-forward」，
ADR-0022 把该路径实现为产品能力：Runtime 在 main 工作树内执行 `git merge --ff-only <固定候选 OID>`，
随后在 main 工作树执行 `install → build:ui → stop → status` 重启并记账。
该路径已真实执行三次（最近一次 `54ff304 → c50730f`）。

用户现在要求改变本机的物理构造与信任路径：

- `main` 与 `dev` 必须是**两个分别从 GitHub clone 下来的仓库**，不再通过 worktree 相连。
- 本机 dev 的代码要更新到 main，**必须先经 GitHub 上传**，再由 main 检出自己 pull；main 的代码只有在
  pull 之后才变动。
- main 检出只用于运行稳定服务，不在其中开发。

该要求与现有实现直接冲突：本地 ff 提升完全不经过远端，`main` 的变动来源是本地 `dev` ref，而不是远端。
继续沿用会被读成「提升完成了」，而 GitHub 上的 `main` 仍是旧提交。

同轮确认的相邻决策（各自独立记录）：ADR-0048（dev 独立 clone 与独立 Runtime 实例）、
ADR-0049（dev UI 通道标记）。

## Options

1. 提升路径：(a) 保持本地 ff（现状）；(b) 经 GitHub 中转：push 固定候选到远端 `dev` → main 检出
   fast-forward-only 拉取 → 推回远端 `main`；(c) GitHub PR/分支保护流程。
2. 产品侧 `promotion` 能力：(a) 仍由 Runtime 全程自动（含在 main 检出内执行拉取）；(b) 产品只做 push 与校验，
   拉取由用户在 main 检出手动执行；(c) 产品不再参与，纯 Git 操作。
3. `main` 检出拉取后是否推回远端 `main`：(a) 推回；(b) 不推回，远端 `main` 只作历史起点。

## Decision

用户选择 1(b)、2(b)、3(a)。

### D01：唯一提升路径

- 稳定提升是且仅是：固定 `dev` 候选 SHA → 显式 push 到远端 `dev` → `main` 检出以 fast-forward-only
  拉取该候选 → 在 main 检出重启稳定 Runtime 并核对 → 推回远端 `main`。
- 推回 `origin/main` 放在重启核对之后：`origin/main` 只会前进到一个「其 main 检出已拉起 Runtime 且
  `status: READY`」的提交；重启失败时保留现场、如实报告，并且**不推回**（不发布未验证的稳定点）。
- 不得用本地 `dev` ref 直接 ff、不得对已检出的 `main` 用 `update-ref`、不得让功能绕过远端 `dev` 进入 `main`。
- 每次提升仍固定「被验证的 dev commit + 预期 main old OID + 验证证据」三元组；ADR-0038/0039 的提升前
  全量测试证据要求不变。

### D02：远端是提升的事实来源

- `origin/dev` 是候选渠道：产品 push 后必须**读回并核对** `origin/dev == 固定候选 SHA`，读不回或不等即不推进，
  不得以「push 命令退出码为 0」当作候选已就位。
- `origin/main` 是稳定事实：main 检出拉取、重启核对成功后才推回，使任何时候从 GitHub clone 都能拿到
  一个已拉起过的稳定代码。
- 除固定候选外不 push 任何 ref；不 `--force`、不覆盖远端已有提交；推回 `main` 只允许 fast-forward。

### D03：拉取是显式的人工步骤（本轮的产品语义）

- 产品 `promotion promote` 只做到「push 固定候选到远端 `dev` + 核对远端 SHA」，并如实报告「已推送、等待拉取」。
- 在 main 检出执行的拉取由用户显式完成（`git fetch` + `git merge --ff-only origin/dev`）；
  产品在后续一次调用中重新核对 main 检出事实并收口，才可报告提升 `SUCCEEDED` 并执行重启。
- 「已推送」不得被报告成「已提升」；两条事实必须在命令面与 UI 投影里可区分。

### D04：main 检出只跑稳定服务

- main 检出只做：拉取、`bun install --frozen-lockfile`、`bun run build:ui`、`stop`、`status`，以及用户日常使用。
- 不在 main 检出开发新功能、不在其中创建 task/worktree、不把 dev 的未提交改动带过去。
- 开发、集成与验证都在 dev 检出进行（布置与实例隔离见 ADR-0048）。

### D05：所需的产品改动（下一格实现）

- 新增项目事实 `projects.dev_repo_path`（可空；schema v29）：产品需要知道 dev clone 的位置才能推送，
  因为两个 clone 分离后稳定 Runtime 手中没有 dev 候选对象。`project trust` 需要能把它作为显式输入并核验。
- `promotion promote` 改为 push + 远端核对 + 等待拉取 + 收口；`promotion prepare` 仍需固定预期 main OID，
  并在 push 前核对该 OID 与 main 检出的实际值一致。
- 提升证据扩展为同时绑定本地候选 SHA 与远端 `dev` SHA（读回值），任一不符即 `STALE`，不移动任何 ref。
- 重启仍按 ADR-0009 D03 的固定序列在 main 检出执行；`stop` 会中断活动 Runtime/Session，这是已接受语义。

### D06：过渡规则（本轮）

- 本 ADR 落地前，产品 `promotion prepare/approve/promote` 仍是旧的本地 ff 路径；**本仓库自身的提升不得使用它**，
  改按 AGENTS.md 的人工路径执行，并在交付记录里如实写明这一点。
- 规格中描述实现现状的文字（`PROJECT_SPEC.md` 第 3 行状态段、§8）在下一格实现后同步；本格只修订规范句
  （§2 不变量 12），并明确标注实现待落。

### D07：不声称覆盖的场景

- 不声称已实现「后台监控用户在系统外手动更新 main」；不声称 GitHub 侧的分支保护、必经评审或 CI 门禁已配置。
- 断网、SSH 认证失败或远端不可达时，不得推进任何 ref，也不得把本地等价当作提升成功。

## Consequences

- 提升路径多出两个人工可见的远端步骤（push 与拉取），换来「远端即事实来源」与两个 clone 的彻底解耦；
  常态确认仍为 0（FULL 不批准），ADR-0011 不变。
- `promotion` 记录需要新增「已推送、等待拉取」与「拉取已核对」两类可区分事实；在实现落地前，该记录与
  本机实际提升路径不一致，必须以 AGENTS.md 为准。
- 两个 clone 分离后，稳定 Runtime 依赖的 `projects.dev_ref`（Task 基线）暂时仍读 main 检出的本地 `dev` ref；
  下一格以 `dev_repo_path` + 远端 `dev` 取代它，届时才删除 main 检出里的本地 `dev` ref。
- 全量测试证据仍然是提升的必备前提，且现在还需要绑定远端读回值。
- 远端 `main` 与远端 `dev` 成为长期存在的分支，删除或重命名它们会破坏提升路径。

## Verification

本格可验证的事实：

- 远端同时存在 `refs/heads/main` 与 `refs/heads/dev`；两者都是 fast-forward 关系，且本地候选 SHA 与
  `origin/dev` 读回值逐字符相等。
- 本机 main 检出与 dev 检出是**两个独立仓库**（各自 `.git` 为目录、无 worktree 交叉注册），
  main 检出只检出 `main`（见 ADR-0048 的验证要求）。

下一格（产品实现）必须断言的命令面事实：

- `promotion promote` 在未 push 时推送固定候选，并在 push 后读回 `origin/dev` 核对；核对失败时报告失败且不推进。
- push 成功但 main 检出尚未拉取时，命令面报告的是「已推送、等待拉取」，退出码与 `SUCCEEDED` 不同；
  不得在该状态下报告提升完成，也不得执行重启记账。
- main 检出拉取到候选后再次调用同一命令才收口为 `SUCCEEDED`，且只有此时才执行 ADR-0009 D03 的重启序列。
- 远端 `origin/dev` 被移动到非候选 SHA 时，`prepare/approve/promote` 全部拒绝并把记录标 `STALE`。
- 所有 Git 测试使用临时仓库与本地裸远端；不得对真实 GitHub 仓库做破坏性测试。

## Related

- `AGENTS.md`（分支与发布工作流、本机检出布局、重启 main 稳定服务）
- `PROJECT_SPEC.md` §2 不变量 12、§6、§7
- ADR-0009（被本 ADR 修订 D02/D03 的提升机制）
- ADR-0022（被本 ADR 修订提升的 ref 操作与证据绑定）
- ADR-0038/0039（提升前全量测试与证据绑定，继续有效）
- ADR-0048（dev 独立 clone 与独立 Runtime 实例）
- ADR-0049（dev UI 通道标记）
