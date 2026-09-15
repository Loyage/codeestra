# Codeestra Agent 协作与开发规范

## 开始工作

1. 阅读 `PROJECT_SPEC.md`（尤其 §1.1 第一原则）、`docs/decisions/README.md`（含当前有效的权限/测试/提升/本机布局语义：ADR-0011、ADR-0038、ADR-0047/0048/0049）、当前任务及相关架构文档。
2. 检查工作目录、Git 状态、已有用户改动；不要覆盖或撤销不属于本任务的改动。
3. 当前仍为设计阶段。未关闭影响实现的重大待决项前，不编造默认产品语义并开始业务实现。
4. 只推进已批准阶段；不要同时实施所有 roadmap 阶段。

## 决策

- 产品行为、数据语义、公共 API、Git 安全、自我升级有重大歧义时，向用户提供 A/B/C 选择题；每轮最多 8 题，优先批量询问相关问题。
- 普通、局部、可逆的内部细节自行合理处理。
- 重要决策写 ADR，包含背景、选项、决定、后果、验证要求和状态。未答复不等于批准。
- 新增权限门禁、审批层、信任流程或沙箱属于重大决策：默认不新增；提出时必须给出效率成本评估（常态路径增加多少步/多少等待），并记录为 ADR。
- 规格、设计和实现不一致时先明确变更，不静默重新解释规格。

## 第一原则（优先级最高，见 PROJECT_SPEC §1.1 / ADR-0008/0011）

- **效率至上**：Runtime 默认 `FULL` 主机级全权限，项目接入、Agent 工具、成果 commit、验证策略变化与未来稳定提升的常态确认均为 0；CLI 可无确认切换 `STRICT` 恢复旧门禁。正确性核对不得包装成审批。
- **软件本体是服务，CLI 必须完备**：新能力先问“CLI 能否完整完成并脚本化驱动（--json、稳定退出码）”。只做 UI 不做 CLI 的能力视为缺陷。Web UI / 桌面只是同一 Runtime 命令面的便利前端，不新增业务语义、不绕过门禁。
- **测试仅限 CLI/命令面**：自动化测试与验收只用 CLI 命令与 Runtime 命令面（含其 HTTP/SSE 传输）驱动断言。

## 架构边界

- Task-first；Agent、Terminal、Conversation、Worktree 均不是调度的业务主实体。
- Domain 不导入 Bun、数据库驱动、Tauri、具体 Agent SDK。
- Scheduler、Git workspace、Agent adapter、Verification、Integration 明确分层。
- 每次 Execution 仅一个主 Agent；每个运行 Task 独占 branch/worktree。
- Conflict UNKNOWN 不得直接并发。DAG 变更必须检验环。
- Task verification 和 Integration verification 分离，证据绑定 revision/commit。
- 运行 Session 不可简化为无身份的一次 shell 命令；诚实报告 Adapter 能力，不伪造 resume/attach/interrupt。

## 数据与副作用

- 运行时边界做 Zod 校验，数据库约束保护引用完整性与唯一性。
- 规格修订、状态迁移与关键用户操作保留审计；禁止重写历史以掩盖失败。
- 外部操作与数据库写入采用可恢复步骤，不假定跨 Git/进程/SQLite 的原子性。
- 命令使用参数数组而非拼接用户文本到 shell；检查路径归属及 Git ref，不依赖显示名称生成安全路径。
- 不在日志、事件、提交或知识文件中记录密钥；终端输出按不可信内容处理。

## 分支与发布工作流（ADR-0009/0047）

- 项目必须长期保留 `main` 与 `dev` 两个分支；不得删除、重命名或用临时 integration branch 取代它们。两者在 GitHub 上都必须存在（`origin/main`、`origin/dev`）。
- `main` 是用户日常实际运行 Codeestra、进行开发辅助工作的稳定分支；不得直接在 `main` 开发新功能。
- `dev` 是新功能实验与集成分支。所有功能 Task/worktree 从固定 `dev` commit 建立基线；功能完成、Task verification 通过后，经 IntegrationBatch 与独立 Integration verification 进入 `dev`，不得直接进入 `main`。
- `dev → main` 是唯一稳定提升路径，且**必须经 GitHub 中转**（ADR-0047）：① 把固定 dev 候选 push 到 `origin/dev`，并读回核对 `origin/dev == 候选 SHA`；② 在 main clone 执行 `git fetch` + `git merge --ff-only origin/dev`；③ 在 main clone 按下面的规程重启稳定 Runtime 并核对 `status: READY`；④ 核对通过后才把 `main` 推回 `origin/main`（重启失败则不推回，保留现场并如实报告）。
- `just promote-main <SHA>` 封装上面的 ②③④（候选 SHA 必须显式给出；要求候选已是 `origin/dev` 的尖端、main 检出干净且检出 `main`）。第 ① 步（把固定候选 push 到 `origin/dev`）与提升前的全量测试证据仍需人工完成。
- 每批固定 dev SHA、预期 main SHA 与验证证据；FULL 下不批准，STRICT 下保留用户批准且 ref/证据变化使批准失效。提升前必须在精确 `dev` 候选 SHA 上跑完全量测试（在 dev clone 发起）；候选、测试配置或锁文件变化即证据失效并重跑。
- 只 push 固定候选这一个 ref；不 `--force`、不覆盖远端已有提交、不对已检出的 `main` 用 `update-ref`。断网、SSH 认证失败或远端不可达时不推进任何 ref，也不得把本地等价当作提升成功。
- **产品 `promotion prepare/approve/promote` 已实现 ADR-0047 的 GitHub 中转路径（FOUNDATION-077 / schema v29，落地细则见 ADR-0052；旧的本地 ff 实现已删除）**：但本仓库自身的提升仍不得使用它，一律走上面的人工四步，并在交付记录里如实写明实际用了哪条路径、执行到哪一步。
- `main` 成功更新后立即在 main clone 执行 `bun run codeestra stop`，再执行 `bun run codeestra status` 自动拉起并检查 Runtime。该后置步骤不增加第二次确认；Runtime 恢复响应前不得报告提升完成。失败时立即报告，不擅自回滚。
- 当前没有后台监控用户在系统外手动更新 `main` 的能力；不要声称已覆盖该场景。也不声称 GitHub 侧已配置分支保护、必经评审或 CI 门禁。

### 本机检出布局（ADR-0048）

- `~/Documents/codeestra` 检出 `main`：**稳定 clone**。只用于运行稳定服务、拉取已批准的提升、以及用 Codeestra 辅助开发；只接受 pull / `bun install --frozen-lockfile` / `bun run build:ui` / `stop` / `status`。不得在其中开发新功能、建 task/lane worktree，或把 dev 的未提交改动复制过去。
- `~/Documents/codeestra-dev` 检出 `dev`：**开发 clone**。所有开发、集成与定向验证都在这里进行。
- 两者是**独立仓库**，不是彼此的 worktree：各自 `.git` 是目录、各有 `origin`；`git worktree list` 不得出现对方。把两边用 worktree 或共享对象库连起来的做法已废弃。
- 两个 clone 的 `node_modules`、`apps/ui/dist`、Runtime 数据目录都是各自的本地状态，不共享；各自需要 `bun install --frozen-lockfile`，UI 资产各自构建。
- 过渡事实：稳定 Runtime 目前仍把 main clone 里的本地 `refs/heads/dev` 当 Task 基线（ADR-0018）。该 ref 不随 `origin/dev` 前进，只是过渡指针，**不得当作提升证据**；下一格以 `dev_repo_path` 取代后才删除。

### dev 实例（独立 home，可与稳定实例同时运行）

在 dev clone 里用独立的 `CODEESTRA_HOME` 运行 dev 代码，稳定 Runtime 不受影响：

```bash
cd /Users/loyage/Documents/codeestra-dev
VITE_CODEESTRA_CHANNEL=dev bun run build:ui   # 等价写法：bun run build:ui:dev
CODEESTRA_HOME=~/.local/state/codeestra-dev bun run codeestra status
CODEESTRA_HOME=~/.local/state/codeestra-dev bun run codeestra ui --no-open
```

- 等价入口：`just restart-dev`（`install --frozen-lockfile` → dev 通道构建 UI → `stop` → `status` → `ui --no-open`），并在构建后核对 `index.html` 真的带 `data-channel="dev"`，不带标记就停止。

- Web UI 端口由 Runtime 自己取空闲端口，两个实例不会撞端口；各自持有自己的内存 token，不要记录实际 token。
- 不写 `CODEESTRA_HOME` 时，从 dev clone 运行 CLI 连的是**稳定 Runtime**、执行的是 `main` 代码：不能用来证明 dev 代码已运行。
- dev 界面的通道标记来自构建期变量（ADR-0049）：不加 `VITE_CODEESTRA_CHANNEL=dev` 就**没有标记**，此时不要把该界面当稳定版或 dev 版汇报。
- dev 实例的数据库、任务与会话是独立的临时数据，不得据它声称稳定数据迁移或稳定服务已更新。

### 重启 main 稳定服务（给 dev Agent 的操作规程）

等价入口：`just restart-main`（只重启，不移动任何 ref、不推送）。它是下面序列的封装，并在末尾补一步 `bun run codeestra ui --no-open`：`stop` / `status` 不会把 Web UI 服务器带回来（ADR-0007：UI 是按需客户端，实测重启后 `uiRunning` 为 `false`），而下面第 5 条要求 `uiRunning: true`，所以 recipe 显式拉起。

当用户在 dev 会话中说“重启 main 的服务”“让 main 更新生效”或同义指令时，必须操作 **main clone**，不能在 dev clone 直接运行这些命令。除非用户明确要求跳过，使用以下完整流程；即使本次看似没有依赖或 UI 变化，也允许重复执行 install/build 以避免遗漏各自本地的 gitignore 资产：

```bash
cd /Users/loyage/Documents/codeestra
git fetch origin
git merge --ff-only origin/dev        # 只在本次是已批准的提升时执行；拉不到候选就停下并报告
bun install --frozen-lockfile
bun run build:ui
bun run codeestra stop
bun run codeestra status
git push origin main                  # 提升收尾：把已拉取并验证过的 main 推回 origin/main
```

执行要求：

1. 先确认 main clone 的路径与分支；不要把 dev 的未提交改动复制到 main，也不要借重启之名执行 commit、reset、clean 或 force push。
2. `git fetch` / `git merge --ff-only` 只用于把已批准的 `origin/dev` 候选快进到 `main`；ff 不成立（`main` 与候选分叉）就停止并报告，不要改用 merge commit、reset 或强推。`git push origin main` 也只允许 fast-forward；被拒就停下报告。
3. 命令必须按顺序执行并检查退出码；前一步失败就停止并报告，不继续声称已重启成功。
4. `stop` 会使运行中的 Runtime/Session 中断；这是 main 更新后的既定后置步骤，不额外请求确认。不要手工 kill 未核验归属的进程。
5. 只有 `status` 返回 `status: "READY"` 且 `uiRunning: true`，才可报告 main 稳定服务已恢复；提升只有在「候选已到 `origin/dev`、main 已 ff 到该候选、Runtime 已恢复、已推回 `origin/main`」四件事实都核对后才算完成（推回放在最后，重启未成功就不推回）。
6. Runtime 重启会更换 Web UI 内存 token，旧的带 token URL 会失效。用户需要 UI 时在 main clone 执行 `bun run codeestra ui`；只需返回链接时执行 `bun run codeestra ui --no-open`，不要在文档、日志或提交中记录实际 token。
7. 从 dev clone 运行不带独立 `CODEESTRA_HOME` 的 CLI 只是在连接 main 的稳定 Runtime；它不能证明 dev 代码已运行。重启 main 后也只能说明 main 当前代码已生效，不能把尚未提升的 dev 改动说成已部署。

## Git 与文件安全

- 未获授权不要 commit、push、强制更新 branch、reset --hard、clean、删除有改动的 worktree 或执行破坏性清理。
- 不修改用户现有工作目录来为 Agent 腾出执行空间；稳定运行的 main clone 与开发用 task/dev clone 必须分离。
- 合入 `dev` 必须经过 IntegrationBatch 与独立集成验证；`dev` 合入 `main` 遵守上节的权限模式与重启要求。
- Human-authored instructions/skills/policies 不得被机器静默覆盖；修改本规格与人工规范应明确出现在交付说明中。
- 保留失败现场；资源回收必须有归属校验与可追溯记录。

## 实现与验证

- 使用项目选择的 TypeScript/Bun 工具链；环境安装遵循 Nix 管理规范。
- **不获取用户电脑控制权**：开发/验收中不使用 computer-use、OS 级键鼠或窗口自动化、桌面应用操作与真实桌面会话（包括用 computer-use 驱动浏览器验证 UI）。UI 验证改用 headless 命令面/HTTP 断言，加上用户在场时的人工确认。仓库内不引入此类依赖或脚本。
- **产品内 Agent 工具集**：不新增屏幕读取、桌面操作、键鼠控制类工具；Agent 能力限于仓库读写、命令执行、Git 与验证编排。
- 小步改动，围绕不变量测试。优先覆盖非法状态迁移、重复命令/事件、并发修订、崩溃恢复、Git 基线变化和验证失效。
- **开发分支只跑定向测试（ADR-0038）**：创建 `task/*`、`lane/*`、feature 或 Self Task candidate branch/worktree 时，就按开发方向写下少量、具体的测试文件或窄命令及其覆盖目标；范围扩大时同步更新。交付时只报告实际执行结果。
- **开发分支禁止全量测试**：不得在上述分支运行 `bun run check`、`just check`、`just verify` 或等价全仓测试/构建；`check:fast` 也是聚合检查，不是“挑几个测试”的默认替代品。仅当改动确实横跨其覆盖范围并在交付记录中说明理由时才可使用。
- **全量测试只在 `dev` 执行**：所有候选集成完毕后，在准备 `dev → main` 前对精确 `dev` SHA 运行一次全量测试，这是稳定提升必做项；全量测试后 dev SHA、测试配置或锁文件变化都必须重跑。普通 dev 文档修改不触发立即全量测试。
- Git 测试使用临时仓库；不要以真实用户仓库做破坏性测试。
- Mock adapter 只能证明协议与编排行为，不可声称真实 Agent 集成已验收。
- 记录实际运行的检查及结果；不能运行的检查标明原因，禁止声称未执行的测试通过。
- 完成工作同步 `docs/tasks/`，简述修改、验证、剩余问题；不要把草案标为已实现。
- **功能变更必须同步用户文档（ADR-0050）**：新增或修改**命令面**（命令、子命令、flag、退出码、稳定错误码）、**UI 行为**（标签页、按钮、文案、只读/可写的分界）、**设置键**（新增/删除/取值/默认值）或**权限语义**（FULL/STRICT 差异）时，同步更新 `docs/guides/` 的对应段落：命令面→`cli-reference.md`；UI→`ui.md`；设置键→`cli-reference.md` + `manual.md`；权限语义→`concepts.md` + `manual.md` + `features.md`；用户日常做法变化→`manual.md` + `recipes.md`。**交付说明里写明改了哪一篇的哪一节；确实不需要改的，要写明为什么不需要**（「没提到」与「确认无需修改」是两件不同的事）。这是人工规范，不加机器门禁、不阻塞提交；`docs/guides/**` 每篇顶部的版本/校对头按 ADR-0050 D02 维护。

## Self Evolution

- Self Task 在独立开发 worktree 中操作，不覆盖运行 Stable。
- Candidate 测试与 Stable 数据隔离；candidate 分支遵守 ADR-0038，只跑建分支时选定的定向测试。Git 变更先进入 `dev`，并在精确 dev 候选上完成提升前全量测试；用户显式批准 `dev → main` 且完成 Runtime 重启前不能切换 Stable。
- 不绕过 bootstrap 恢复边界。涉及不可逆 migration 或 bootstrap 自身更新，先获明确决策。
