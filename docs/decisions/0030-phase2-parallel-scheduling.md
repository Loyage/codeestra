# ADR-0030：Phase 2 并行调度的决策固化（并发容量、ImpactSnapshot、自动 tick、UNKNOWN 放行）

Status：Accepted（D01–D10 全部由用户本轮明确拍板，含 `PROJECT_SPEC.md` §2 第 6 条的逐字修订；本 ADR 逐字保留其决定与被否掉的选项。本 ADR 只固化语义，不包含实现。）

## Context

Phase 2 的第一小步（ADR-0024）已经让「依赖」成为一等公民：`task_dependencies`、纯领域 DAG 与环校验、`BLOCKED` 的唯一含义都已落地。但并行调度本身仍不存在，而且**规格与设计之间存在真空**：

1. `docs/architecture/scheduler.md` 与 `docs/architecture/conflict-analyzer.md` 是 Phase 2 设计稿，写了排序、两类锁、`wait(CONFLICT)`、验收矩阵和「UNKNOWN 有活跃任务时不启动」，但**没有**回答实现者不得不自己编造的问题：容量是多少、容量维度只有全局还是也有 adapter、谁触发 tick、UNKNOWN 到底能不能被放行、映射从哪来。
2. `PROJECT_SPEC.md` §2 第 6 条只写「只有 SAFE 允许直接并发；未知不等于无冲突」，没有给 UNKNOWN 任何**显式**出口；`AGENTS.md` 也写「Conflict UNKNOWN 不得直接并发」。若实现者自行加一个「忽略 UNKNOWN」开关，那将是未经授权的门禁变更。
3. 上一版 `conflict-analyzer.md` §4 明确写着「第一版没有『用户强制忽略 UNKNOWN 并发』的隐藏 override；若未来增加需单独授权与风险审计决策」。**这个「未来」就是现在**：用户已经就是否引入、以什么形态引入、承担什么风险作出了决定。
4. 用户特别关心三件事，必须在决定里写清而不是留给实现解释：**效率成本**（会不会变成新的常态确认）、**风险归属**（UNKNOWN 并发越界算谁的）、**审计链**（放行在什么条件下失效）。

本格是**纯文档格**：把用户已拍板的决策固化成可执行的规格与设计，**一行代码都不改、不占 schema 版本**（`phase1SchemaVersion` 仍为 v19，`migration.ts` 一行未动）。Phase 2 的任何代码都还没写，因此本 ADR 不得被读成「并行调度已实现」。

## Options

每个决定都先列出被评估的选项，再记录用户选了什么、否了什么。被否掉的选项不是「以后可能」，而是**本轮明确不选**。

1. 并发容量：(a) 全局上限，默认 2，可配置；(b) 默认串行（1）直到显式开启；(c) 按主机资源（CPU/内存）自动推导。
2. Adapter 槽位：(a) 每 adapter 单独上限，默认等于全局上限；(b) 每 adapter 固定 1；(c) 只做全局维度，不引入 adapter 维度。
3. ImpactSnapshot 来源：(a) 确定性优先 + 项目配置映射；映射缺失 → `complete=false` → UNKNOWN → 不并行；(b) LLM 辅助预测；(c) 只用文件路径 + DAG。
4. 调度触发：(a) Runtime 自动 tick（事件驱动 + 周期恢复 tick），submit 后自动进入调度，FULL 零确认；(b) 保留显式 `task run`/`tick` 作为唯一驱动；(c) 自动但默认关闭。
5. UNKNOWN 处置：(a) 新增显式单次放行 `--allow-unknown`，绑定 revision + 评估版本、写审计、默认路径 0 新增步骤；(b) 保持保守、不提供任何放行；(c) 改为「独占任务」声明。
6. 饥饿：(a) 不加 aging，只显示等待时长；(b) 简单 aging；(c) 预留并发位给最久等待者。
7. 成果入 `dev`：(a) 各自独立批次（保持现状）；(b) 多成员批次（CLI 显式组批）；(c) 自动组批。
8. 非 Git 资源（端口/数据库/dev server）：(a) 不引入，留后续；(b) 项目声明式 resource claim；(c) 只读探测。
9. 影响映射载体：(a) 仓库内跟踪文件 `.codeestra/impact.json`；(b) CLI 写库（项目级声明）；(c) 文件为源 + CLI 只读校验。
10. `PROJECT_SPEC.md` §2 不变量 6 的修订：(a) 批准（含「放行可与活跃任务并发」）；(b) 放行但仍不得与活跃任务并发；(c) 维持不变量不动。

## Decision

**1(a)**、**2(a)**、**3(a)**、**4(a)**、**5(a)**、**6(a)**、**7(a)**、**8(a)**、**9(a)**、**10(a)**。

### D01：并发容量是全局上限，默认 2，可配置

并发上限是**全局**配置，默认 **2**。改配置为 1 就退化为串行，但**默认不是串行**：用户要以可预期的吞吐开始，而不是先欠一笔「开启并行」的债。

否决的选项：

- **默认串行（1）直到显式开启**：把一个纯粹的性能选择变成一个必须先做出的决定，增加常态等待而不带来安全性（安全性由 UNKNOWN/冲突判定承担，不由容量承担）。
- **按主机资源自动推导**：容量换成不可预测、不可脚本化的隐式行为，CLI 无法稳定断言，也违背「机器可读、稳定退出码」的命令面要求。本波明确不做（`scheduler.md` §6）。

### D02：每 adapter 也有上限，默认等于全局上限

每个 adapter 有**单独的**并发上限，默认等于全局上限；只有显式配置才更低。两个维度**同时**生效（全局仍有余位不会让某 adapter 突破自己的上限）。

因此 `wait(CAPACITY)` 有两个**可区分**来源，调度器必须分别报告：`GLOBAL_CAPACITY`（全局已满）与 `ADAPTER_CAPACITY`（全局未满但该 adapter 槽位已满）。

否决的选项：

- **每 adapter 固定 1**：把一个可能的 provider 限制当成所有 adapter 的默认事实，会在只有一个 adapter 时把容量硬压回串行，与 D01 的默认 2 直接矛盾。
- **只做全局维度、不引入 adapter 维度**：观察不到「是哪一个 provider 打满了」，用户无法判断该降量还是该换 provider；而且真实 provider（如 Codex app-server、Pi 会话）的资源争用本来就是按 adapter 计的。

### D03：ImpactSnapshot 确定性优先 + 项目配置映射；映射缺失 → `complete=false` → UNKNOWN → 不并行

影响预测以**确定性规则**为主，输入是项目配置的映射（D09 的 `.codeestra/impact.json`）。映射缺失或不可靠时 `complete=false`，判定按既有规则落到 `UNKNOWN(reason: incomplete_impact)`，**默认不并行**。保守在这里是「拒绝证明」而不是「猜一个 SAFE」。

同时保留既有事实：全局资源影响不能只与同名 `globalResources` 对比，读依赖不可靠时按整个项目范围处理；文件删除/创建、配置生成、代码生成输出、测试 fixture 与包公共接口都是影响（`conflict-analyzer.md` §3）。

否决的选项：

- **LLM 辅助预测**：不可复现、不可版本化、无法作为放行审计绑定的「评估版本」，也无法给出稳定 reason codes；「模型没提到同一文件」永远不能当作 SAFE 依据（`conflict-analyzer.md` §1 已写死这一点）。本波明确不做。
- **只用文件路径 + DAG**：放弃模块/重要目录/全局资源维度，会让共享构建配置、schema migration、锁文件这类**不同文件但同一影响面**的冲突被误判为 SAFE，正是保守分析要避免的错误方向。

### D04：Runtime 自动 tick；submit 后自动进入调度；FULL 零确认

调度由 Runtime **自动 tick** 驱动：相关提交事件触发一次 tick，另有周期恢复 tick 收敛崩溃/重启后的预留与容量计数。`task.submit` 成功后候选自动进入下一次 tick，用户不需要再敲命令。

FULL 下新增确认步骤数为 **0**；STRICT 也不把调度当作需要批准的操作（调度是正确性编排，不是权限判定）。既有 `task.run` 仍在同一命令面上可用（可立即请求一次调度并得到结果），但不是启动任务的必经路径。

否决的选项：

- **保留显式 `task run`/`tick` 作为唯一驱动**：把 Runtime 的服务形态退化成「用户必须手动推进的批处理」，违背 §1.1 第 1 条效率至上与第 2 条服务形态。
- **自动但默认关闭**：等于 D02 的「默认串行」翻版——把正确的默认行为藏在一个必须被发现的开关后面，常态路径凭空多一次配置。

### D05：UNKNOWN 新增显式单次放行 `--allow-unknown`

`UNKNOWN` 默认等待（不启动、不并行）。用户可以对本条 Task 做**显式单次放行**：`--allow-unknown`。

- 放行后该 Task 正常走容量与冲突流程，**允许其与当前活跃任务并发**；不降级为独占任务，也不要求其他任务先停。
- 放行是**单次**的：绑定被评估的 `revisionId`、`baseCommit`、`analyzerVersion`、`policyVersion`，并写入审计（谁、哪个 Task、哪个 revision、哪次评估）。
- **默认路径不增加任何确认步骤**：放行是**放宽**门禁，不是新增门禁。不碰 `--allow-unknown` 时 FULL 下看不到任何新确认。
- 放行**不改变 assessment 记录本身**：该次 `conflict_assessments` 仍是 `UNKNOWN`；放行是独立事实，**不等于 SAFE**，不构成「已证明不冲突」的证据。命令形态在实现波次落地，本波只固化语义。

否决的选项：

- **保持保守、不提供放行**：用户明确要承担可自行判断的风险；不给出口等于让「UNKNOWN + 必须并行」只能靠改代码或错误报告绕过，反而制造了不可审计的旁路。
- **改为「独占任务」声明**：把「无法证明不冲突」偷换成「我保证不冲突」，既不写入审计也无法失效，还诱导用户做出比显式放行更弱的承诺。

### D06：不加 aging，只显示等待时长

排序仍是 priority desc → createdAt asc → ID asc；不加 aging。持续高优先级输入可能饿死低优先级任务，UI **只显示等待时长**（这是事实，不是补偿）。公平策略留后续独立产品决策。

否决的选项：

- **简单 aging**：在没有真实饥饿数据前引入会改变排序语义的隐式规则，使调度不再可用「优先级 + 到达顺序」解释，也让 CLI 断言变脆。
- **预留并发位给最久等待者**：以牺牲容量为代价换取公平，且与「提高优先级不抢占」的既有语义纠缠不清。

### D07：成果入 `dev` 保持各自独立批次（现状）

每个 Task 的成果继续按 ADR-0018 的既有 IntegrationBatch 规则**各自独立**合入 `dev`。多成员批次不在本波。

否决的选项：

- **多成员批次（CLI 显式组批）**：需要新的批次成员语义、批级 `STALE`、部分失败拆分与批级验证证据，是与并行调度可分离的一块；用户选择不在本波混入。
- **自动组批**：Runtime 替用户决定「哪些成果该一起进 `dev`」，把合并边界的决定从人手里拿走，且没有可审计的组批依据。

### D08：不引入非 Git 资源共享资源（端口/数据库/dev server）

不引入 resource claim 机制。不同文件不能证明这些资源可共享，因此这类冲突继续由 `complete=false → UNKNOWN` 保守承载；`globalResources` 仍覆盖 Git 可见的全局影响面。留后续。

否决的选项：

- **项目声明式 resource claim**：在没有归属校验、没有真实运行时观察的情况下，声明字段会被当成安全证明使用（「我声明了端口，所以安全」），比「无法证明」更危险。
- **只读探测**：探测是**采样**不是断言，两个 Agent 之间仍有窗口；把它当作并发依据属于把启发式当证据。而且探测本身是新的副作用面。

### D09：影响映射的载体是仓库内跟踪文件 `.codeestra/impact.json`

重要目录/模块/全局资源清单由项目在仓库内声明，文件路径 `.codeestra/impact.json`，与 `.codeestra/policies/verification.json` 同一惯例：**只从项目 main ref 读取**（先把 ref 解析到 commit，再读该 commit 的文件），Task branch 上的同名文件不参与判定；文件缺失等于没有映射 → `complete=false` → UNKNOWN。

否决的选项：

- **CLI 写库（项目级声明）**：声明离开版本控制，评审/回滚/追溯都要靠数据库，且无法作为放行审计绑定的可复现「评估版本」的一部分。
- **文件为源 + CLI 只读校验**：多一套只读校验器但没有强制的写入路径，实际会同时存在「文件是源」和「CLI 认为的源」，判定分歧时没有单一权威。

### D10：批准 `PROJECT_SPEC.md` §2 不变量 6 的修订

`PROJECT_SPEC.md` §2 第 6 条**逐字**替换为（用户已明确批准，含「可与活跃任务并发」这一语义）：

> 6. Conflict assessment 为 `SAFE_TO_PARALLELIZE | UNKNOWN | CONFLICTING`。只有 SAFE 允许直接并发；未知不等于无冲突。UNKNOWN 默认等待（不启动、不并行）；用户可用显式单次放行命令（`--allow-unknown`）在承担风险的前提下启动该 Task，**允许其与当前活跃任务并发**；放行必须绑定 revision 与评估版本、写入审计，且默认路径不增加任何确认步骤。

否决的选项：

- **放行但仍不得与活跃任务并发**：这样的「放行」几乎无用（UNKNOWN 任务在有空闲容量时本来就不会被冲突挡住），只会让用户在等待中反复确认，是伪装成安全功能的空转。
- **维持不变量不动**：会让 `AGENTS.md`（「Conflict UNKNOWN 不得直接并发」）与 `conflict-analyzer.md` §4（「没有隐藏 override」）继续成为唯一权威，而用户实际需要的放行只能以未授权旁路出现——规格、设计与实现不一致时**先明确变更**，本 ADR 就是那次明确变更。

## Consequences

- 常态新增审批成本：**0 步、0 等待**。
- 收益：Phase 2 并行调度的语义第一次完整且可执行（容量、维度、触发、UNKNOWN 出口、映射来源、明确不做的事），实现者不再需要编造默认值；`scheduler.md`/`conflict-analyzer.md` 与 `PROJECT_SPEC.md` §2.6 互相对齐；「UNKNOWN 能不能并行」有了唯一答案：默认不能，显式放行可以，且放行可审计、可失效。

### 效率成本（用户特别关心）

- **放行是放宽而不是新增门禁。** 常态路径新增步骤与等待都是 **0**：不碰 `--allow-unknown` 的用户在 FULL 下看不到任何新的确认、提示或审批层；`task.submit` 之后自动进入调度。本 ADR 没有引入任何新的权限门禁、审批层、信任流程或沙箱（这一点按 `AGENTS.md` 的要求特别声明）。
- **唯一代价**：想并行 UNKNOWN 任务的用户必须**显式**承担风险——多敲一个 flag，且这次放行进入审计。这是把「用户本来就会做的判断」从不可见的旁路搬到可追溯的命令面上，而不是增加等待。

### 风险归属（用户特别关心）

- **`UNKNOWN` 不是「无冲突」，是「无法证明」。** 第一版 analyzer 无法事先证明两个运行中的 Agent 永不越界（`scheduler.md` §4 残余风险）。放行后如果两个 Agent 越界，**责任在放行方**。
- Runtime **不因放行而增加额外隔离**：没有文件锁、没有新沙箱、没有额外暂停点（`PROJECT_SPEC.md` §2.20：Runtime 保持本机单用户、无路径沙箱/网络策略）。放行只是允许启动，不改变运行时的实际隔离水平。
- 放行**不等于 SAFE**：它不改写 `conflict_assessments` 记录的结论，也不提高后续判定的置信度。

### 审计链（用户特别关心）

- 每次放行都必须绑定**被评估的 revision** 与**评估版本**（`analyzerVersion`、`policyVersion`，以及该次评估的 `baseCommit`），并写入审计。
- 绑定使放行**在与评估不一致时自动失效**：任务被修订、基线变化、映射/分析器/策略版本变化、实际 diff 超出预测，都会让旧 assessment 与旧放行一并失效，需要重新评估、必要时重新放行。
- 保留旧记录做审计，不重写历史（本地决策只增不改，与 ADR-0018/0028 的台账风格一致）。

### 其他后果与边界

- 容量默认 2 是全局配置；每 adapter 上限默认等于全局上限。`wait(CAPACITY)` 必须区分 `GLOBAL_CAPACITY` / `ADAPTER_CAPACITY`。
- 排序、不抢占、不加 aging、两类锁（Runtime 实例锁 + SQLite 资源预留）与既有验收矩阵**不变**。
- **明确不做**（写入 `scheduler.md` §6）：非 Git 共享资源的 resource claim（D08）、多成员 IntegrationBatch 批次（D07）、aging（D06），以及按主机资源推导容量（D01）和 LLM 辅助预测（D03）。
- **本 ADR 不含任何实现**：没有 scheduler/analyzer 代码、没有 `.codeestra/impact.json` 读取器、没有 `--allow-unknown` 命令、**不占 schema 版本**（仍为 v19，`migration.ts` 未改）。`PROJECT_SPEC.md` 的「阶段进度」段落（「尚未实现 … 并行调度」）**未改**，因为 Phase 2 尚未落地；那句要等真正落地后由 Wave F 更新，现在改就是谎报已实现。

## Verification

本格（纯文档）的自查：

- `bun run typecheck` 退出码 0（只用于确认没有碰代码）。
- `git diff --stat` 只包含 `PROJECT_SPEC.md`、`docs/decisions/{0030-phase2-parallel-scheduling.md,README.md}`、`docs/architecture/{scheduler,conflict-analyzer}.md`、`docs/tasks/README.md`。
- `grep -c "allow-unknown" PROJECT_SPEC.md` ≥ 1；§2 第 6 条与 D10 引用的措辞逐字一致。
- 未 commit、未 push、未提升 `main`、未重启稳定 Runtime。

实现落地时（后续波次）必须证实的验收项（本 ADR 不声称它们已通过）：

- A/B 明确不相交且容量为 2：两者可同时 reservation/start（`scheduler.md` §5 既有项）。
- UNKNOWN：有活跃任务时不启动；带 `--allow-unknown` 时可启动并**与活跃任务并发**。
- 放行记录绑定 revision + `analyzerVersion`/`policyVersion`/`baseCommit` 且入审计；revision 修订或评估版本变化后该放行**不再有效**（重新评估、不得静默沿用）。
- 放行不改写 `conflict_assessments` 的结论（仍为 `UNKNOWN`）。
- 容量：全局默认 2 可配置；每 adapter 上限独立生效；`GLOBAL_CAPACITY` 与 `ADAPTER_CAPACITY` 可区分报告。
- 触发：`task.submit` 后无需额外命令即进入调度；FULL 下确认步骤数 0；周期恢复 tick 能收敛崩溃后遗留的预留与容量计数。
- 映射：`.codeestra/impact.json` **只从项目 main ref** 读取（Task branch 上的同名文件不生效），缺失 → `complete=false` → UNKNOWN。
- 明确不做项确有边界：不存在非 Git 资源 claim、多成员批次、aging、按主机资源推导容量或 LLM 预测。

## Related

- `PROJECT_SPEC.md` §1.1（效率至上/CLI 完备/零确认）、§2.5/§2.6/§2.10/§2.20、§6
- `AGENTS.md`（Task-first；Conflict UNKNOWN 不得直接并发；新增门禁需效率成本评估；不静默重解释规格）
- ADR-0008（三条第一原则）、ADR-0011（默认 FULL 零确认）、ADR-0018（成果合入 `dev` 的 IntegrationBatch）、ADR-0024（依赖与 `BLOCKED`）
- `docs/architecture/scheduler.md`（§1.1 容量模型、§1.2 触发模型、§4.1 UNKNOWN 放行、§6 明确不做）
- `docs/architecture/conflict-analyzer.md`（§2 映射来源、§4 失效/解释/放行）
- `docs/roadmap/mvp.md` Phase 2
- `docs/tasks/README.md` FOUNDATION-052
