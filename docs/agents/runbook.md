# 发布与运行规程（Agent 操作手册）

面向在本仓库工作的 Agent。本文件只有**操作步骤**，不是决策依据：不变量见 `AGENTS.md`，产品与架构语义见 `PROJECT_SPEC.md`，决策见 `docs/decisions/`。

**先读本文件的触发条件**（任一成立就先读，再动手）：

- 要推进 `dev → main`、执行 `just promote-main`，或判断某次提升是否算完成；
- 用户说“重启 main 的服务”“让 main 更新生效”或同义指令；
- 要在 dev clone 跑 dev 实例（`just restart-dev`、带 `CODEESTRA_HOME` 的 CLI）；
- 要判断某个目录是稳定 clone 还是开发 clone。

## 1. 本机检出布局（ADR-0048）

- `~/Documents/codeestra` 检出 `main`：**稳定 clone**。只用于运行稳定服务与拉取已批准的提升；只接受 pull / `bun install --frozen-lockfile` / `bun run build:ui` / `stop` / `status`。不得在其中开发新功能、建 task/lane worktree，或把 dev 的未提交改动复制过去。
- `~/Documents/codeestra-dev` 检出 `dev`：**开发 clone**。所有开发、集成与定向验证都在这里进行。
- 两者是**独立仓库**，不是彼此的 worktree：各自 `.git` 是目录、各有 `origin`；`git worktree list` 不得出现对方。
- 两个 clone 的 `node_modules`、`apps/ui/dist`、Runtime 数据目录都是各自的本地状态，不共享；各自需要 `bun install --frozen-lockfile`，UI 资产各自构建。
- 过渡事实：稳定 Runtime 目前仍把 main clone 里的本地 `refs/heads/dev` 当 Task 基线（ADR-0018）。该 ref 不随 `origin/dev` 前进，只是过渡指针，**不得当作提升证据**。

## 2. dev 实例（独立 home，可与稳定实例同时运行）

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

## 3. 稳定提升（`dev → main`）：人工四步（ADR-0009/0047）

1. 把固定 dev 候选 push 到 `origin/dev`，并读回核对 `origin/dev == 候选 SHA`；
2. 在 main clone 执行 `git fetch` + `git merge --ff-only origin/dev`；
3. 在 main clone 按 §4 重启稳定 Runtime 并核对 `status: READY`；
4. 核对通过后才把 `main` 推回 `origin/main`（重启失败则不推回，保留现场并如实报告）。

- `just promote-main <SHA>` 封装上面的 ②③④（候选 SHA 必须显式给出；要求候选已是 `origin/dev` 的尖端、main 检出干净且检出 `main`）。第 ① 步与提升前的全量测试证据仍需人工完成。
- 第 1 步只 push 固定候选这一个 ref；不 `--force`、不覆盖远端已有提交。断网、SSH 认证失败或远端不可达时不推进任何 ref，也不得把本地等价当作提升成功。
- **不要用产品 `codeestra promotion prepare/approve/promote` 做本仓库的提升**：它虽然已实现同一条中转路径（FOUNDATION-077 / schema v29，细则见 ADR-0052），但本仓库自身一律走上面的人工四步，并在交付记录里如实写明实际用了哪条路径、执行到哪一步。

## 4. 重启 main 稳定服务（给 dev Agent 的操作规程）

等价入口：`just restart-main`（只重启，不移动任何 ref、不推送），它在下面序列末尾补一步 `bun run codeestra ui --no-open`（ADR-0007：UI 是按需客户端，`stop`/`status` 不会把它带回来，而第 5 条要求 `uiRunning: true`）。

用户说“重启 main 的服务”“让 main 更新生效”或同义指令时，必须操作 **main clone**。除非用户明确要求跳过，使用完整流程；即使看不出依赖或 UI 变化，也允许重复执行 install/build，以免漏更各自被 gitignore 的本地资产：

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

1. 先确认 main clone 的路径与分支；不要把 dev 的未提交改动复制到 main，也不要借重启之名 commit/reset/clean/force push。
2. `fetch` / `merge --ff-only` 只用于把已批准的 `origin/dev` 候选快进到 `main`，ff 不成立（`main` 与候选分叉）即停止并报告，不得改用 merge commit、reset 或强推；`push origin main` 也只允许 fast-forward，被拒即停下报告。
3. 命令按顺序执行并检查退出码；前一步失败即停止并报告，不声称已重启成功。
4. `stop` 中断运行中的 Runtime/Session，这是既定后置步骤，不额外确认；不要手工 kill 未核验归属的进程。
5. 只有 `status: "READY"` 且 `uiRunning: true` 才可报告恢复；提升在「候选已到 `origin/dev`、main 已 ff 到该候选、Runtime 已恢复、已推回 `origin/main`」四件事实都核对后才算完成（推回最后，重启未成功不推回）。
6. 重启更换 Web UI 内存 token，旧 URL 失效；用户需要 UI 时在 main clone 执行 `bun run codeestra ui`（只要链接加 `--no-open`），不得记录实际 token。从 dev clone 不带独立 `CODEESTRA_HOME` 运行 CLI 只是连稳定 Runtime，不能证明 dev 代码已运行，也不能把未提升的 dev 改动说成已部署。

## 5. 不要做的事

- 不用产品 `promotion` 命令面做本仓库的提升（§3）。
- 不把「已推送、等待拉取」报告成提升成功；拉取是用户显式的人工步骤。
- 不声称覆盖了用户在系统外手动更新 `main` 的场景，也不声称 GitHub 侧已配置分支保护、必经评审或 CI 门禁。
- 不在 dev clone 直接运行「重启 main」的命令；不在 main clone 开发新功能或建 task/lane worktree。
