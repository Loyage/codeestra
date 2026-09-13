# Codeestra Agent 协作与开发规范

## 开始工作

1. 阅读 `PROJECT_SPEC.md`（尤其 §1.1 第一原则）、`docs/decisions/README.md`（含 ADR-0008/0009）、当前任务及相关架构文档。
2. 检查工作目录、Git 状态、已有用户改动；不要覆盖或撤销不属于本任务的改动。
3. 当前仍为设计阶段。未关闭影响实现的重大待决项前，不编造默认产品语义并开始业务实现。
4. 只推进已批准阶段；不要同时实施所有 roadmap 阶段。

## 决策

- 产品行为、数据语义、公共 API、Git 安全、自我升级有重大歧义时，向用户提供 A/B/C 选择题；每轮最多 8 题，优先批量询问相关问题。
- 普通、局部、可逆的内部细节自行合理处理。
- 重要决策写 ADR，包含背景、选项、决定、后果、验证要求和状态。未答复不等于批准。
- 新增权限门禁、审批层、信任流程或沙箱属于重大决策：默认不新增；提出时必须给出效率成本评估（常态路径增加多少步/多少等待），并记录为 ADR。
- 规格、设计和实现不一致时先明确变更，不静默重新解释规格。

## 第一原则（优先级最高，见 PROJECT_SPEC §1.1 / ADR-0008）

- **效率至上**：用户的等待时间与操作步数是第一优化目标。安全与隔离是服务效率的约束，不是独立目标。任何门禁在常态路径上最多一次显式确认；不由 Agent 新增审批层、信任流程或沙箱。
- **权限管理不在当前范围**：不为多用户、租户、密钥托管、路径沙箱、网络策略预留门禁；不把它们当作待实现项。已实现的门禁（项目 trust、Pi 敏感工具逐次审批、成果 commit 确认、验证策略确认、main 提升批准）**继续有效，不删不改**，但不再扩张。正确性问题不受效率优先影响（未知工具仍 fail-closed，取消超时仍转人工）。
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

## 分支与发布工作流（ADR-0009）

- 项目必须长期保留 `main` 与 `dev` 两个分支；不得删除、重命名或用临时 integration branch 取代它们。
- `main` 是用户日常实际运行 Codeestra、进行开发辅助工作的稳定分支；不得直接在 `main` 开发新功能。
- `dev` 是新功能实验与集成分支。所有功能 Task/worktree 从固定 `dev` commit 建立基线；功能完成、Task verification 通过后，经 IntegrationBatch 与独立 Integration verification 进入 `dev`，不得直接进入 `main`。
- `dev → main` 是唯一稳定提升路径。每批必须由用户批准固定 dev SHA、预期 main SHA 与验证证据；任一 ref 或证据变化使批准失效。不得把用户未回复视作批准。
- `main` 成功更新后立即在 main 工作树执行 `bun run codeestra stop`，再执行 `bun run codeestra status` 自动拉起并检查 Runtime。该后置步骤不增加第二次确认；Runtime 恢复响应前不得报告提升完成。失败时立即报告，不擅自回滚。
- 当前没有后台监控用户在系统外手动更新 `main` 的能力；不要声称已覆盖该场景。

## Git 与文件安全

- 未获授权不要 commit、push、强制更新 branch、reset --hard、clean、删除有改动的 worktree 或执行破坏性清理。
- 不修改用户现有工作目录来为 Agent 腾出执行空间；稳定运行的 `main` 工作树与开发用 task/`dev` 工作树应分离。
- 合入 `dev` 必须经过 IntegrationBatch 与独立集成验证；`dev` 合入 `main` 还必须遵守上节的用户批准与重启要求。
- Human-authored instructions/skills/policies 不得被机器静默覆盖；修改本规格与人工规范应明确出现在交付说明中。
- 保留失败现场；资源回收必须有归属校验与可追溯记录。

## 实现与验证

- 使用项目选择的 TypeScript/Bun 工具链；环境安装遵循 Nix 管理规范。
- **不获取用户电脑控制权**：开发/验收中不使用 computer-use、OS 级键鼠或窗口自动化、桌面应用操作与真实桌面会话（包括用 computer-use 驱动浏览器验证 UI）。UI 验证改用 headless 命令面/HTTP 断言，加上用户在场时的人工确认。仓库内不引入此类依赖或脚本。
- **产品内 Agent 工具集**：不新增屏幕读取、桌面操作、键鼠控制类工具；Agent 能力限于仓库读写、命令执行、Git 与验证编排。
- 小步改动，围绕不变量测试。优先覆盖非法状态迁移、重复命令/事件、并发修订、崩溃恢复、Git 基线变化和验证失效。
- Git 测试使用临时仓库；不要以真实用户仓库做破坏性测试。
- Mock adapter 只能证明协议与编排行为，不可声称真实 Agent 集成已验收。
- 记录实际运行的检查及结果；不能运行的检查标明原因，禁止声称未执行的测试通过。
- 完成工作同步 `docs/tasks/`，简述修改、验证、剩余问题；不要把草案标为已实现。

## Self Evolution

- Self Task 在独立开发 worktree 中操作，不覆盖运行 Stable。
- Candidate 测试与 Stable 数据隔离；Git 变更先进入 `dev`，用户显式批准 `dev → main` 且完成 Runtime 重启前不能切换 Stable。
- 不绕过 bootstrap 恢复边界。涉及不可逆 migration 或 bootstrap 自身更新，先获明确决策。
