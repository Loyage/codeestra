# ADR-0048：dev 是独立 clone、独立 Runtime 实例；main 检出只跑稳定服务

Status：Accepted（用户 2026-09-15 决策）。无 schema 变更、不占迁移号、不改产品语义（仅本机布置与操作规程）。
与 ADR-0047（经 GitHub 中转的提升）配套：两个 clone 是那条信任路径的物理前提。

## Context

在本 ADR 之前，本机是**一个仓库 + 两个 worktree**：`~/Documents/codeestra` 是主 clone 并检出 `main`，
`~/Documents/codeestra-dev` 是它的 worktree 并检出 `dev`（`.git` 是一个指向
`codeestra/.git/worktrees/codeestra-dev` 的文件）。ADR-0009 D03 与 AGENTS.md 都建立在这个形态上。

用户要求改成：两个分支**分别从 GitHub clone 下来**，彼此不通过 worktree 相连；main 检出的代码只有在
自己 pull 之后才变动；main 检出里不进行开发（开发在 dev 检出进行，目录名必须与 main 可区分）。

同时，dev 版界面要能真的跑起来并与稳定界面区分。现状下 Runtime 是「按 `CODEESTRA_HOME` 的 socket 判定的
单实例」：在 dev 检出直接跑 CLI 只会连上正在运行的稳定 Runtime，执行的是 `main` 代码，因此 dev 代码不会被运行。

本仓库当前的物理事实：`main` 检出 = `c50730f`（比 `origin/main` 领先 26 个提交），`dev` = `0e800d7`
（`main` 的后代，领先 5 个提交），远端只有 `refs/heads/main`，没有 `dev`。

## Options

1. 形态：(a) 保持单仓库双 worktree；(b) 两个独立 clone；(c) 两个独立 clone 但共用一个 `CODEESTRA_HOME`。
2. dev 实例：(a) 独立 `CODEESTRA_HOME`（端口由 Runtime 自行取空闲端口）；(b) 共用稳定 Runtime，需要看 dev 时
   先 `stop` 稳定 Runtime；(c) 只跑 CLI，不跑 dev UI。
3. 目录名：(a) 保持 `codeestra` / `codeestra-dev`；(b) 改名 `codeestra-stable` / `codeestra-dev`。

## Decision

用户选择 1(b)、2(a)、3(a)。

### D01：两个独立 clone

- `~/Documents/codeestra`：稳定 clone，检出 `main`，用于日常运行与以 Codeestra 辅助开发。
- `~/Documents/codeestra-dev`：开发 clone，检出 `dev`，所有开发、集成与定向验证在这里进行。
- 两者是**独立仓库**（各自 `.git` 是目录、各自的 remote 是 `origin`），不存在 worktree 交叉注册；
  `git -C ~/Documents/codeestra worktree list` 不得列出 dev 目录，反之亦然。
- `node_modules`、`apps/ui/dist` 与 Runtime 数据目录都是各 clone 自己的本地状态，不共享、不互相替代。

### D02：main 检出只跑稳定服务

- main 检出只接受：`git pull`（fast-forward-only 到已提升的候选）、`bun install --frozen-lockfile`、
  `bun run build:ui`、`stop`、`status`，以及用户日常使用（含用 Codeestra 辅助开发）。
- 不在 main 检出写功能代码、不创建 task/lane worktree、不把 dev 的未提交改动复制过去。
- 稳定服务由 main 检出启动，并保持随时可用；这是「main 时刻保持运行」的落点。

### D03：dev 用独立 `CODEESTRA_HOME`，端口自动不冲突

- dev 的 Runtime 使用独立 home（本机取 `~/.local/state/codeestra-dev`），因此 socket、数据库、lock、
  Runtime 数据目录与稳定实例完全隔离；两者可同时运行、互不中断。
- Web UI 的 HTTP 端口由 Runtime 自己取空闲端口（`port ?? 0`，`apps/runtime/src/http-api.ts`），
  不需要新增端口配置；两个实例同时打开时各自持有自己的端口与内存 token。
- CLI 的子进程入口按 CLI 自身所在仓库解析（`apps/cli/src/main.ts` 的 `runtimeEntry`），
  所以在 dev 检出运行 CLI 启动的是 **dev 代码**的 Runtime；这解决了「在 dev 检出跑不出 dev 代码」的现状缺口。
- 不把 dev 实例当作稳定服务：dev 实例的数据库、任务与会话都是独立的临时数据，不得声称它验证了稳定数据迁移。

### D04：main 检出暂时保留一个本地 `dev` ref

- 稳定 Runtime 目前把 `projects.dev_ref`（`refs/heads/dev`）用作 Task worktree 基线（ADR-0018）。
  两个 clone 分离后，main 检出里的这个本地 ref 不会随 `origin/dev` 自动前进。
- 因此本格**保留** main 检出里的本地 `dev` ref，并在文档中如实标注：它只是过渡期的 Task 基线指针，
  可能滞后于 `origin/dev`；下一格按 ADR-0047 D05 引入 `dev_repo_path` 后改读 dev 检出/远端，届时才删除它。
- 不把该 ref 当作「main 已提升」的证据；提升事实以 `main` 检出与远端 `origin/main` 为准。

### D05：不做运行期通道猜测

- 不从路径、分支名或 home 目录**推断**通道；dev 界面的通道标记是构建期事实（ADR-0049）。
- Runtime 本轮不新增「我在跑哪份代码」的契约字段；当前可用的事实核对方式是 CLI 直接读进程与 home
  （`status` 报告 `bootId`/`pid`/`uiRunning`），以及命令行里显式写出的 `CODEESTRA_HOME`。

## Consequences

- 两个 clone 需要各自 `bun install --frozen-lockfile` 与 `bun run build:ui`；`bun run check` 会构建 UI，
  但按 ADR-0038 只在 `dev` 做提升前全量测试，不在 main 检出跑全仓检查。
- main 检出的 `.git` 里会保留历史遗留的本地分支（`dev` 与已合并的 `lane/*`、`task/*`）：
  本格保留 `dev`（见 D04）；已合并的功能分支不再需要，是否清理留到后续格，不在本格删除。
- 由于两个 clone 不再共享对象库，任何「本地 ref 已有该提交」的假设都不再成立；后续产品改动必须显式
  通过 `dev_repo_path` / 远端获取对象（ADR-0047 D05）。
- Orca 之类的编辑器/工作台若记录了旧 worktree 身份，需要在用户侧重新指向 dev clone；本 ADR 不修改这些外部工具的数据。
- 用户的稳定会话不再被 dev 工作打断：稳定 Runtime 可以在 dev 实例运行时保持服务。

## Verification

本格必须逐条断言（命令面事实，不使用浏览器自动化）：

- `git -C ~/Documents/codeestra rev-parse --git-dir` 与 `git -C ~/Documents/codeestra-dev rev-parse --git-dir`
  解析到**不同的** git 目录，且 dev 检出的 `.git` 是目录而不是 `gitdir:` 指针文件。
- `git -C ~/Documents/codeestra worktree list` **不包含** `codeestra-dev`，`git -C ~/Documents/codeestra-dev
  worktree list` 不包含 `codeestra`。
- dev 检出 HEAD 等于远端 `dev` 读回值，工作区 clean，且 `origin/dev` 被配置为上游。
- `CODEESTRA_HOME=~/.local/state/codeestra-dev bun run codeestra status`（在 dev 检出执行）返回
  `status: "READY"`，同时稳定实例仍在运行、其进程归属未变；两个实例的 `bootId`/`pid` 不同。
- 稳定实例在 dev 实例启动前后保持可响应（`status` 仍 `READY`），即 dev 的运行不构成对稳定服务的重启。

## Related

- `AGENTS.md`（本机检出布局、重启 main 稳定服务、dev 实例操作规程）
- ADR-0009（main/dev 职责与提升后重启，继续有效）
- ADR-0047（经 GitHub 中转的提升；D05 的 `dev_repo_path` 是本 ADR D04 的收口）
- ADR-0049（dev UI 通道标记）
- `docs/architecture/sqlite-schema.md`（Runtime 数据目录与 home 口径）
