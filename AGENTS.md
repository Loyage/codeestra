# Codeestra Agent 协作与开发规范

## 开始工作

1. 阅读 `PROJECT_SPEC.md`、`docs/decisions/README.md`、当前任务及相关架构文档。
2. 检查工作目录、Git 状态、已有用户改动；不要覆盖或撤销不属于本任务的改动。
3. 当前仍为设计阶段。未关闭影响实现的重大待决项前，不编造默认产品语义并开始业务实现。
4. 只推进已批准阶段；不要同时实施所有 roadmap 阶段。

## 决策

- 产品行为、数据语义、公共 API、Git 安全、自我升级有重大歧义时，向用户提供 A/B/C 选择题；每轮最多 8 题，优先批量询问相关问题。
- 普通、局部、可逆的内部细节自行合理处理。
- 重要决策写 ADR，包含背景、选项、决定、后果、验证要求和状态。未答复不等于批准。
- 规格、设计和实现不一致时先明确变更，不静默重新解释规格。

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

## Git 与文件安全

- 未获授权不要 commit、push、强制更新 branch、reset --hard、clean、删除有改动的 worktree 或执行破坏性清理。
- 不修改用户现有工作目录来为 Agent 腾出执行空间。
- 合入 main 必须经过 IntegrationBatch 与独立集成验证，并遵守待确认的授权策略。
- Human-authored instructions/skills/policies 不得被机器静默覆盖；修改本规格与人工规范应明确出现在交付说明中。
- 保留失败现场；资源回收必须有归属校验与可追溯记录。

## 实现与验证

- 使用项目选择的 TypeScript/Bun 工具链；环境安装遵循 Nix 管理规范。
- 小步改动，围绕不变量测试。优先覆盖非法状态迁移、重复命令/事件、并发修订、崩溃恢复、Git 基线变化和验证失效。
- Git 测试使用临时仓库；不要以真实用户仓库做破坏性测试。
- Mock adapter 只能证明协议与编排行为，不可声称真实 Agent 集成已验收。
- 记录实际运行的检查及结果；不能运行的检查标明原因，禁止声称未执行的测试通过。
- 完成工作同步 `docs/tasks/`，简述修改、验证、剩余问题；不要把草案标为已实现。

## Self Evolution

- Self Task 在独立开发 worktree 中操作，不覆盖运行 Stable。
- Candidate 测试与 Stable 数据隔离；用户显式 Promotion 前不能切换 Stable。
- 不绕过 bootstrap 恢复边界。涉及不可逆 migration 或 bootstrap 自身更新，先获明确决策。
