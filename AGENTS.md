# Codeestra Agent 协作与开发规范

## 开始工作

1. 阅读 `PROJECT_SPEC.md`（尤其 §1.1 第一原则）、`docs/decisions/README.md`（尤其「当前有效语义」与「待决项」两节）、当前任务及相关架构文档；触及提升、重启 main 或 dev 实例时先读 `docs/agents/runbook.md`。
2. 检查工作目录、Git 状态、已有用户改动；不要覆盖或撤销不属于本任务的改动。
3. 只推进已批准阶段，不要同时实施所有 roadmap 阶段；未关闭影响实现的重大待决项前，不编造默认产品语义并开始业务实现。

## 决策

- 产品行为、数据语义、公共 API、Git 安全、自我升级有重大歧义时，向用户提供 A/B/C 选择题；每轮最多 8 题，优先批量询问相关问题。
- 普通、局部、可逆的内部细节自行合理处理。
- 重要决策写 ADR，包含背景、选项、决定、后果、验证要求和状态。未答复不等于批准。
- 新增权限门禁、审批层、信任流程或沙箱属于重大决策：默认不新增；提出时必须给出效率成本评估（常态路径增加多少步/多少等待），并记录为 ADR。
- 规格、设计和实现不一致时先明确变更，不静默重新解释规格。

## 第一原则（优先级最高，见 PROJECT_SPEC §1.1 / ADR-0008/0011）

- **效率至上**：Runtime 默认 `FULL` 主机级全权限；项目接入、Agent 工具、成果 commit、验证策略变化与未来稳定提升的常态确认为 **0 步 0 等待**；CLI 可无确认切换 `STRICT`。ref/ownership/静止证据/幂等等正确性核对继续有效，但不得包装成审批。
- **服务形态与 CLI 完备**：独立本地 Runtime 是软件本体。新能力先问“CLI 能否完整完成并脚本化驱动（`--json`、稳定退出码）”，只做 UI 不做 CLI 视为缺陷。UI/桌面是同一命令面的前端，不新增业务语义、不绕过门禁、不直接访问 SQLite。
- **测试边界**：自动化测试与验收只用 CLI 命令与 Runtime 命令面（含其 HTTP/SSE 传输）驱动断言；禁止 computer-use、OS 级键鼠/窗口自动化与真实桌面会话。

## 架构边界

- Task-first；Agent、Terminal、Conversation、Worktree 均不是调度的业务主实体。
- Domain 不导入 Bun、数据库驱动、Tauri、具体 Agent SDK。
- Scheduler、Git workspace、Agent adapter、Verification、Integration 明确分层；每次 Execution 仅一个主 Agent；每个运行 Task 独占 branch/worktree。
- Conflict `UNKNOWN` 不得直接并发（`--allow-unknown` 是显式单次放行）；DAG 变更必须检验环。
- Task verification 和 Integration verification 分离，证据绑定 revision/commit。
- 运行 Session 不可简化为无身份的一次 shell 命令；诚实报告 Adapter 能力，不伪造 resume/attach/interrupt。

## 数据与副作用

- 运行时边界做 Zod 校验，数据库约束保护引用完整性与唯一性。
- 规格修订、状态迁移与关键用户操作保留审计；禁止重写历史以掩盖失败。
- 外部操作与数据库写入采用可恢复步骤，不假定跨 Git/进程/SQLite 的原子性。
- 命令使用参数数组而非拼接用户文本到 shell；检查路径归属及 Git ref，不依赖显示名称生成安全路径。
- 不在日志、事件、提交或知识文件中记录密钥；终端输出按不可信内容处理。

## 分支与发布工作流（ADR-0009/0047）

**执行任何提升、重启 main 稳定服务或运行 dev 实例之前，先读 `docs/agents/runbook.md`**：命令序列、本机检出布局（ADR-0048）、dev 实例与「重启 main 稳定服务」规程的全文都在那里（原先写在本文件同名小节的规程已移入该文件）。本节只写不变量。

- 项目必须长期保留 `main` 与 `dev` 两个分支，不得删除、重命名或用临时 integration branch 取代；两者在 GitHub 上都必须存在（`origin/main`、`origin/dev`）。`main` 是用户日常运行的稳定实例，不得在其上开发新功能。
- 该双分支模型**只属于 Codeestra 自身**，且从 ADR-0066（schema **v36**）起它**没有任何产品支撑**：产品不再建模 dev clone、长期 `dev` 集成分支、`task integrate`、`task integration *` 或 `promotion *`（那些命令与相关表已整体删除）。本文件描述的 `main`/`dev` 布局、人工四步与重启规程全部是**本仓库自身的人工约定**，产品不提供命令、不记账、不校验。
- `dev` 是新功能实验与集成分支：功能 Task/worktree 的基线是**项目文件夹（本机即 dev clone）建 workspace 时当前检出的分支**（`workspaces.base_ref`），在本机就是 `dev`；功能完成、Task verification 通过后，由**人**把成果合回 `dev`（`git merge`），不得直接进入 `main`。产品不做合并、不自动推、不记账。
- `dev → main` 是唯一稳定提升路径，且**必须经 GitHub 中转**（沿用 ADR-0047 的口径，现在是人工步骤而非产品命令）：只 push 固定 dev 候选这一个 ref 并读回核对，main clone 以 fast-forward-only 拉取，重启核对通过后才推回 `origin/main`。不 `--force`、不覆盖远端已有提交、不对已检出的 `main` 用 `update-ref`；断网、SSH 认证失败或远端不可达时不推进任何 ref，也不得把本地等价当作提升成功。
- 每批固定 dev SHA、预期 main SHA 与验证证据；提升前必须在精确 `dev` 候选 SHA 上跑完全量测试（在 dev clone 发起），候选、测试配置或锁文件变化即证据失效并重跑。FULL 下不批准，STRICT 下保留用户批准且 ref/证据变化使批准失效。
- **产品 `promotion prepare/approve/promote` 已实现 ADR-0047 的 GitHub 中转路径（FOUNDATION-077 / schema v29，细则见 ADR-0052），但本仓库自身的提升仍不得使用它**，一律走 runbook 的人工四步，并在交付记录里如实写明实际用了哪条路径、执行到哪一步。
- `main` 成功更新后必须立即在 main clone `stop` 再 `status` 重启并检查 Runtime：该后置步骤不增加第二次确认，Runtime 恢复响应前不得报告提升完成；失败时立即报告，不擅自回滚。提升只有在「候选已到 `origin/dev`、main 已 ff 到该候选、Runtime 已恢复、已推回 `origin/main`」四件事实都核对后才算完成（推回放在最后，重启未成功就不推回）。
- 当前没有后台监控用户在系统外手动更新 `main` 的能力，不要声称已覆盖该场景；也不要声称 GitHub 侧已配置分支保护、必经评审或 CI 门禁。

## Git 与文件安全

- 未获授权不要 commit、push、强制更新 branch、reset --hard、clean、删除有改动的 worktree 或执行破坏性清理。
- 不修改用户现有工作目录来为 Agent 腾出执行空间；稳定运行的 main clone 与开发用 task/dev clone 必须分离。
- 合入 `dev` 是人工 Git 动作（ADR-0064 之后产品没有 IntegrationBatch 或 integrate 命令）：功能完成后由人把成果合回 `dev`；`dev` 合入 `main` 遵守上节的权限模式与重启要求。
- Human-authored instructions/skills/policies 不得被机器静默覆盖；修改本规格与人工规范应明确出现在交付说明中。
- 保留失败现场；资源回收必须有归属校验与可追溯记录。

## 实现与验证

- 使用项目选择的 TypeScript/Bun 工具链；环境安装遵循 Nix 管理规范。
- **不获取用户电脑控制权**：开发/验收中不使用 computer-use、OS 级键鼠或窗口自动化、桌面应用操作与真实桌面会话（包括用 computer-use 驱动浏览器验证 UI）。UI 验证改用 headless 命令面/HTTP 断言，加上用户在场时的人工确认。仓库内不引入此类依赖或脚本。
- **产品内 Agent 工具集**：不新增屏幕读取、桌面操作、键鼠控制类工具；Agent 能力限于仓库读写、命令执行、Git 与验证编排。
- 小步改动，围绕不变量测试。优先覆盖非法状态迁移、重复命令/事件、并发修订、崩溃恢复、Git 基线变化和验证失效。
- **开发分支只跑定向测试（ADR-0038）**：创建 `task/*`、`lane/*`、feature 或 Self Task candidate branch/worktree 时，按开发方向写少量具体的测试文件或窄命令及其覆盖目标；范围扩大时同步更新。
- **开发分支禁止全量测试**：不得在上述分支运行 `bun run check`、`just check`、`just verify` 或等价全仓测试/构建；`check:fast` 也是聚合检查，不是“挑几个测试”的默认替代品（仅当改动确实横跨其覆盖范围并在交付记录中说明理由时才可用）。
- **全量测试只在 `dev` 执行**：所有候选合入完毕、准备 `dev → main` 前对精确 `dev` SHA 跑一次；之后 dev SHA、测试配置或锁文件变化都必须重跑。普通 dev 文档修改不触发立即全量测试。交付时只报告实际执行结果。
- Git 测试使用临时仓库；不要以真实用户仓库做破坏性测试。
- Mock adapter 只能证明协议与编排行为，不可声称真实 Agent 集成已验收。
- 记录实际运行的检查及结果；不能运行的检查标明原因，禁止声称未执行的测试通过。
- 完成工作同步 `docs/tasks/`，简述修改、验证、剩余问题；不要把草案标为已实现。
- **功能变更必须同步用户文档（ADR-0050）**：新增或修改**命令面**（命令、子命令、flag、退出码、稳定错误码）、**UI 行为**（标签页、按钮、文案、只读/可写的分界）、**设置键**（新增/删除/取值/默认值）、**权限语义**（FULL/STRICT 差异）或用户日常做法时，按 ADR-0050 D01 的映射同步 `docs/guides/` 对应段落。**交付说明里写明改了哪一篇的哪一节；确实不需要改的，要写明为什么不需要**（「没提到」与「确认无需修改」是两件不同的事）。这是人工规范，不加机器门禁、不阻塞提交；`docs/guides/**` 每篇顶部的版本/校对头按 ADR-0050 D02 维护。

## Self Evolution

- Self Task 在独立开发 worktree 中操作，不覆盖运行 Stable。
- Candidate 测试与 Stable 数据隔离；candidate 分支遵守 ADR-0038，只跑建分支时选定的定向测试。Git 变更先合入 `dev`（人工），并在精确 dev 候选上完成提升前全量测试；用户显式批准 `dev → main` 且完成 Runtime 重启前不能切换 Stable。
- 不绕过 bootstrap 恢复边界。涉及不可逆 migration 或 bootstrap 自身更新，先获明确决策。
