# 领域概念与边界

> **适用版本** `dev@7425556` + 本格分支 `Loyage/task_auto`（2026-09-17） · **schema** v35 · **最后校对** 2026-09-17
> 版本会前进：`dev@7425556` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> §「Task」与 §「Revision」由本分支按 **ADR-0065** 改写（两个 Task 级标题；约束已删除）。
> §「调度三态」由 FOUNDATION-091 按 ADR-0059 重写（声明同一功能才冲突）；
> §「调度三态」末尾新增「全局暂停」一段、§「运行边界」补充控制状态的持久性（FOUNDATION-097 / ADR-0061 D04/D08）。
> §「双分支与 Task 工作树基线」由 FOUNDATION-093 第三轮同步（ADR-0060 修订：managed 项目可跑完整 Task，只有集成与提升需要 dev 分支）；其余内容沿用 FOUNDATION-091 的校对基线。
> §「Reclaim」由 ADR-0062 补充集成后的自动回收一行。

这份文档解释 Codeestra 里的名词到底指什么、哪些东西**不是**调度主实体、以及几条会影响你日常判断的硬边界。
规格原文见 [PROJECT_SPEC.md](../../PROJECT_SPEC.md) §2「核心不变量」；这里是面向使用者的说明。

---

## Task-first

Codeestra 是 **Task-first** 的：**Task 是业务主实体**。

- **Agent、Terminal、Conversation、Worktree 都不是调度的业务主实体。**
  它们是 Task 执行过程中用到的资源与观察面：Agent 是一次执行绑定的一方，Terminal 是某个 Session 的
  终端接管面，Conversation 属于 provider 自己的会话文件，Worktree 是 Task 独占的工作目录。
  调度、冲突判定、依赖、验证、集成、提升都围绕 **Task** 组织，而不是围绕「哪个 Agent」或「哪个终端」。
- 你能在界面上看到「执行过程」「终端」「会话」这些视图，但它们**不参与**调度决策的排序与门禁。

好处是：换 Agent 不会变成一个新产品语义（只是新 Execution），关掉界面不会停止任何 Task。

---

## 核心实体

### Project（项目）

一个已接入（trust）的 Git 仓库。Runtime 按 **Git common dir** 识别 Project，而不是按某一份工作树路径——
所以同一个仓库的稳定 `main` 工作树与开发工作树属于同一个 Project，重复 `open` 是幂等的。

Project 记录包含：`main` ref、`dev` ref、对象格式（sha1/sha256）、验证策略确认、影响映射确认、trust 时间与 actor。

### Task（任务）

一次有边界的开发工作。Task 持有：**两个 Task 级标题**（显示标题 `displayTitle`：任务列表与详情渲染的
一句话摘要；命名标题 `namingTitle`：分支与 worktree 目录名，`task/<编号>-<name>`；两者创建时必填、创建后不可改，
ADR-0065）、当前 specification（任务详情）、**不可覆盖**的 revision 历史、priority、
dependencies、**声明的功能（`features`，见下）**、predicted impact、conflict state、execution 历史、
branch/worktree、验证与集成状态、归档标记。

约束（`constraints`）自 ADR-0065 起**不再是 Task 或 revision 的字段**：它过去表达的「Agent 必须遵守的具体限制」
写进任务详情即可，产品不再有单独的约束列表、`--constraint` flag 或约束界面。任务类型（`kind`）同样已删除。

功能声明属于 **revision**：`task create --feature <module-id>` 在第一条 revision 上声明，
`task revision create --feature …` 替换后续 revision 的声明（**省略即继承**）。id 必须是项目 `main` ref 上
`.codeestra/impact.json` 的 `modules[].id`，写入时校验（`UNKNOWN_FEATURE` / `IMPACT_POLICY_ABSENT` /
`INVALID_IMPACT_POLICY` / `INVALID_FEATURE`），**不要求该映射已被 `project trust` 确认**。

Task 生命周期状态（数据库 CHECK 与领域类型一致）：

```text
DRAFT → BLOCKED → READY → RUNNING ⇄ (PAUSING → PAUSED → RUNNING)
                        ↓
        WAITING_FOR_USER / RECOVERY_REQUIRED / CANCELLING / CANCELLED
                        ↓
                     EXECUTED → FAILED / SUCCEEDED
```

要点：

- `BLOCKED` **专指依赖未满足**。冲突等待与容量等待**不是** `BLOCKED`（见下文三态）。
- `CANCELLED` 是终态，不会被自动重开；`task retry` 只针对 `FAILED`。
- `WAITING_FOR_USER` **只暂停对应 Task**，其他合格任务继续跑。

### Revision（任务修订）

Task 的规格快照，append-only。第一次创建 Task 就产生第一条 revision。之后

- `task revision create`：显式修订（改任务详情，或改功能声明，二者至少其一）；
- 修订进入**正在运行的** Execution 是一个独立可观察的过程：**Revision Delivery**。
  一个 delivery 只有在台账里被确认后才算满足；对没有确认通道的 Adapter，它会**如实保持未确认**，直到
  显式的 stop-and-restart 在**那条 revision** 上记录出后继 Execution（见 [features.md](./features.md)）。

旧 revision 的验证**不能**作为新 revision 的交付证据。

**两条输入通道，不要混。** 改任务详情/功能声明/验收目标 = Revision（`task revision create`，产生不可变 revision，
并使旧验证失效）；对**正在运行的会话**说一句「怎么做」而不改验收标准 = **Session Guidance**
（`session guide`，不产生 revision、不动 `appliedRevisionId`、不使验证失效，见 §Session 与 features.md）。
CLI/UI 不会根据自然语言猜测意图：想改验收标准就必须显式提交修订。

### Execution（执行）

**一次执行尝试**，恰好绑定**一个主 Agent**。换主 Agent 要新建 Execution（而不是在同一个里换）。

Execution 状态：

```text
CREATED → PREPARING → STARTING → RUNNING ⇄ WAITING_FOR_USER
                                  ↓
             PAUSING → PAUSED / STOPPING → PAUSED
                                  ↓
   SUCCEEDED / FAILED / CANCELLED / SUPERSEDED     (终态，不复活)
```

不变量（源码核对）：

- 终态 Execution **永远** `resource_held = 0`；非终态永远 `resource_held = 1`（数据库 CHECK 强制）。
- 每个运行中 Task **独占** branch 与 worktree；不允许两个 Task 操作同一个工作目录。
- 旧 ACK 不会被应用；未确认最新 revision、或还有未关闭的 Attention 时**不会**恢复。

### Session（Agent 会话）

有身份、有生命周期、有恢复信息的运行实体，不是「一次 shell 命令」。一个 Execution 可以保留有序的
Session process **incarnation** 历史，但任意时刻最多一个 Provider writer。

Codeestra 诚实报告 Adapter 能力，不伪造 `resume` / `attach` / `interrupt`：

- **transcript**（`task transcript` / `session transcript`）是**只读**读取 provider 自己的持久会话文件，
  展示工具调用/返回、助手文本、thinking、token 与成本。它不入库、不产生业务事实、**不是 attach、不是终端接管**。
- **原生终端接管**（`session handoff *`）是另一套东西：attach / detach / release、单一 writer lease、
  安全点与准入决策。第二个 writer 申请会被以 `ATTACHMENT_BUSY` 明确拒绝，不排队。
- **Session Guidance**（`session guide` / `session guidance list|get`）是把用户的话交给**真实 provider 会话**的通道
  （ADR-0010 D02 / ADR-0057）。它**不产生 TaskRevision**、不动 Task 的 revision 与 version、**不使验证失效**；
  记录后该 Task 的每条指导会在**新建 Execution** 启动时随启动参数一并交给 provider，所以它不随进程消失。
  三个事实严格分开：**已记录**（正文耐久保存）/ **已投递**（provider 自己的通道**接受了这条消息，即入队**）/
  **模型已读**（**不存在**：三个 provider 都没有可核验通道，ADR-0051）。因此 `DELIVERED` **不等于**「模型已经照做」，
  命令面把这件事说出口（`modelAcknowledgement: 'UNSUPPORTED'`）；没有通道的 provider 记 `CHANNEL_UNSUPPORTED`，
  不降级、不静默。

### Attention（需要人回答的请求）

一条需要人介入的记录。kind 有三种：`PERMISSION`（权限）、`QUESTION`（结构化提问）、`RECOVERY`（恢复）。

- 状态：`OPEN → ANSWER_RECORDED → DELIVERED → CLOSED`，另有 `STALE`。
- 「一份问卷 = 一个 provider dialog = 一条 `QUESTION` Attention = 一次 answer Operation」。
  Runtime 在记录回答前会按**被问的那份问卷**校验；越界/重复/单选多选不符返回
  `INVALID_QUESTIONNAIRE_ANSWER:*` 并**保持请求 OPEN**，绝不降级为「用户拒绝」或静默作废已答内容。
- 与之相对的是 **散文提问等待（prose question）**：Agent 没用工具、直接在正文里提问并结束轮次。Runtime 用
  一条**确定性启发式**（一次运行里没有工具调用，且最后一段助手文本以问号结尾）把它记成一条独立的 Attention
  和 `WAITING_FOR_USER`，标注码 `PROSE_QUESTION_NO_TOOL_USE`。它是一个**关于结束形态的判断，不是对意图的断言**，
  所以有明确的退出方式：`attention resolve --dismiss`（误报）或 `--answer <text>`（记录你的回答）。
  两者都**不会**恢复对话，也**不是** TaskRevision。开关 `settings prose-question-attention`
  （`auto` 默认 / `record-only` / `off`）决定这类完成是否记成等待。

### Verification（验证）与 Task verification ≠ Integration verification

**这是最容易混淆、也最重要的一条边界。**

- **Task verification** 判定**一个 Task 的成果 commit**。命令来自项目 `main` ref 上人工维护的
  `.codeestra/policies/verification.json`（Task 分支上的同名文件**不参与**判定），在**固定 commit 的 detached 副本**
  中运行，证据**不含原始命令输出**。或者，当该分支在 `.codeestra/tests.json` 声明了定向测试计划并用
  `task tests record` 记录后，验证运行的是**已记录的计划**（而不是文件本身）——所以范围变化是一次显式、
  可审计的追加。
- **Integration verification** 判定**一个 IntegrationBatch 合并后的 dev 提交**。它是**独立实体、独立记录**。
- 两者**不能互相替代**：Task verification 通过**不**释放依赖；进入 `dev` **不**等于已提升到 `main`。
- 提升前还有第三份证据：**dev 全量测试证据**（对精确 dev 候选 SHA 在 detached 副本里运行项目固定策略），
  由 Runtime 运行并观察，客户端**不能自报**结果。

验证证据绑定 `revision / commit / policy digest`。**已完成执行 ≠ 已验证**；**已验证 ≠ 已集成到 dev**；
**已进入 dev ≠ 已获批提升到 main**；**main 已更新 ≠ Runtime 已重启完成**。

### IntegrationBatch（集成批次）

正式领域对象（ADR-0018）。它记录：包含哪些 Task 与 revision、对应的成果 commit、固定的 `dev` 基线、
dev 集成结果与集成验证证据。

- 集成在 Runtime 数据目录下的 detached integration worktree 里合并：**能 ff 就 ff，否则 `--no-ff`**。
- **先跑独立的集成验证，PASSED 之后才用 CAS 推进 `dev`**，并把 Task 推到 `SUCCEEDED`。
- 任何失败**保留现场且不推进 `dev`**；`dev` 正被某个工作树检出时拒绝集成。
- 批次状态：`CREATED / PREPARING / VERIFYING / INTEGRATING_DEV / INTEGRATED / CONFLICTED / FAILED / RECOVERY_REQUIRED / STALE / CANCELLED`
  （`STALE` = 固定证据已过期，不推进；`CANCELLED` = 记录证明没有副作用时被用户结束）。
- **一个批次可以含多个 Task**（ADR-0053）：`task integration create` 显式组成（不碰 Git），`task integration integrate` 按 task-id 顺序
  逐个合并后由**一次**独立集成验证覆盖整批，`PASSED` 才推进 `dev` 并把**每个**成员推到 `SUCCEEDED`。
  部分失败如实可读：失败的成员标 `CONFLICTED`/`FAILED`，已合并的保持 `MERGED`，未尝试的保持 `PREPARED`。

### Promotion（稳定提升）

`dev → main` 的正式记录（ADR-0009 / ADR-0022）。一次 promotion 固定三件事：

1. 已验证的 **dev commit**；
2. **预期旧 main commit**；
3. 该 commit 的**集成验证证据** + 该 SHA 的 **dev 全量测试证据**（含策略 digest 与候选锁文件 digest）。

- 状态：`CREATED → AWAITING_APPROVAL → PROMOTING → RESTARTING → SUCCEEDED`（失败/过期另有 `STALE`、`FAILED`、`RECOVERY_REQUIRED`）。
- **`prepare` 不写 Git**；真正移动 `main` 的动作在 `promote`，它必须在**检出 main 的那个工作树里**做
  fast-forward，并在那里依次执行 `bun install --frozen-lockfile` → `bun run build:ui` → `bun run codeestra stop`
  → `bun run codeestra status`。
- **重启只有在每一步都退 0、且重启后的 Runtime 回答 `READY` 时才被记录**。
- 策略在 main 上被编辑、候选里的锁文件变了、或出现更新的失败运行，都会让证据**过期**，以
  `DEV_FULL_SUITE_EVIDENCE_STALE` 拒绝（退出码 1）。

### Reclaim（资源回收）

回收 Runtime 数据目录下属于**本 Runtime** 的工作树 / 验证副本 / 集成工作树（ADR-0021 / ADR-0037 / ADR-0042）。

- 三类资源：`TASK_WORKTREE`、`VERIFICATION_COPY`、`INTEGRATION_WORKTREE`。
- `reclaim plan` 是**只读试运行**，返回与 `apply` **完全相同**的决策形状，所以「预览」永远不会和「真跑」不一致。
- 每个被考虑的资源都有明确动作：`RECLAIM / RETAIN / REFUSE / ALREADY_ABSENT / RECOVERY_REQUIRED`，
  并带上授权或拒绝它所依据的**归属证据**。
- **失败现场默认保留**：未提交改动、失败/取消的验证或集成，在没有 `--include-failure-scenes` 时是 `RETAIN`。
- **未注册目录不会被删**，除非调用方用 `--remove-unregistered <精确路径>` 指明它（ADR-0037）。
- 回收过的 Task worktree 之后可以由 `task retry` 从保留的 Task 分支**重建**（ADR-0042）。
- **集成成功后会有一次自动回收**（ADR-0062，`settings auto-reclaim` 默认 `on`）：对该批成员的 Task worktree
  执行与 `reclaim` 完全相同的决策（因此失败现场仍默认保留、branch 不动）；它失败不影响集成结果，
  细节在集成报告的 `reclamation` 汇总与账本 evidence（`automatic: true`）里。

### Project Knowledge（项目知识）

分层（ADR-0041）：

```text
项目仓库（进 Git，人工维护，只从 main ref 读取）
.codeestra/instructions/   # 人工维护 Markdown
.codeestra/skills/         # 人工维护 Markdown

Runtime 数据目录（不进 Git，机器生成）
<CODEESTRA_HOME>/knowledge/<project-id>/generated/     # 机器生成层读位置
<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md   # 某次 Execution 物化的上下文
```

- 加载顺序：`instructions` → `skills` → `generated`，先人工后机器。
- **没有覆盖语义**：能解析的人工条目**全部**进入快照，一条都不丢；重复 id 或重复路径是 **fail-closed 拒绝**，
  不是「后者胜」。人工层只要有一条被拒，就**不产生任何快照**，任何 Execution 都不许启动。
- 人工层只从**项目 `main` ref** 读取，所以 Task 分支改不了判定它自己的知识（与验证策略同一条不变量）。
- 机器生成层读写都在 Runtime 数据目录，**项目树里一个字节都不写**（否则未跟踪文件会进入 Task 的 change set，
  既造成假冲突又会被提交进成果 commit）。

---

## 权限模式：FULL / STRICT

| | `FULL`（默认） | `STRICT`（显式 opt-in） |
|---|---|---|
| 项目接入 | 不确认 | 需输入 `TRUST`（脚本 `--yes`） |
| Agent 工具调用 | 自动允许 | gate 逐次审批（Attention） |
| 成果 commit | `task result capture` 单步 | `prepare` → `commit … --confirm` 两步；保留敏感路径拒绝 |
| 验证策略变化 | 不确认 | 需确认 |
| 提升 `dev → main` | 无需批准 | 保留批准（`promotion approve`） |

不变的是：revision/ref/归属/进程身份核对、静止证据、幂等与崩溃恢复**始终有效**——这些是正确性核对，
**不是**权限审批，不会被 FULL 关掉，也不会被包装成审批。

---

## 运行边界

### Runtime 单实例与 socket

- Runtime 是**每用户单实例**：一个 `CODEESTRA_HOME` 对应一个 Runtime，靠该目录下的 `runtime.sock` 判定。
- `CODEESTRA_HOME` 目录权限 `0700`，socket 权限 `0600`。
- HTTP 界面只绑定 `127.0.0.1`，每个 Runtime 进程一次性的内存 token；token 只出现在 URL fragment 里。
- 因此：从**别的**工作树运行 `bun run codeestra …` 只会打到**正在运行的那个** Runtime，不会启动你当前的构建。
  要跑另一份代码就换 `CODEESTRA_HOME`（例如 `CODEESTRA_HOME=/tmp/codeestra-dev bun run codeestra status`）。

### 双分支与 Task 工作树基线

两种基线（**ADR-0060**：main/dev 双分支模型**只属于 Codeestra 自身**，被管理的其它项目不被要求这么搭）：

- **记了 dev clone 的项目**（含 Codeestra 自身）：长期保留 `main` 与 `dev`；所有功能 Task 从该 clone 的
  固定 `dev` commit 建立基线（`projects.dev_ref`）；成果经 `task integrate` 进入 `dev`，`dev → main` 只能经
  `promotion` 走（ADR-0009）。
- **没记 dev clone 的项目（managed）**：Task 从**项目文件夹当前检出的分支**建基线（建 workspace 时读 HEAD，
  把 ref 与 commit 一起固定进 `workspaces.base_ref`）；成果留在 `refs/heads/task/<task-id>`，**由你自己合**。
  这类项目**能完整跑 Task**：`task submit` / `task run` / `task depends list` / `task result *` / `task verify`
  都按它自己的基线（项目文件夹当前检出的分支）与归属（项目文件夹）工作；只有真正需要长期 `dev` 分支的
  集成与提升（`task integrate`、`promotion *`）会以 `DEV_REPO_REQUIRED` 拒绝。文件夹处于
  detached HEAD 时以 `TASK_BASE_REF_UNRESOLVED` 拒绝（没有分支可名）；`task run --base-ref <refs/heads/…>`
  可以显式指定一条本地分支作基线（只对新 workspace 生效）。
- owned worktree 位于 Runtime 数据目录 `worktrees/<project-id>/<task-id>/`，**不污染你的主工作区**。

### 调度三态：SAFE / UNKNOWN / CONFLICTING

冲突判定（**ADR-0059**，取代 ADR-0031 的判定语义）是**确定性、不用模型**的：它只比较**声明**——两个 Task
的当前 revision 是否声明了**同一个功能 id**（取自项目 `main` ref 上 `.codeestra/impact.json` 的 `modules[].id`）。

- `SAFE_TO_PARALLELIZE`：**默认**。没有与任何**未完成**的 Task 声明同一个功能。
  **同文件、同目录、同模块、共享构建/依赖/schema/全局资源都不再阻止并发**：它们仍是可观测事实并进入解释输出，
  但不再按它们拦人。
- `CONFLICTING`：双方声明了同一功能，且对方**未完成**（状态不是 `SUCCEEDED`/`CANCELLED`，且未归档）。
  **永远不放行**。想让两件事互斥，就给它们声明同一个功能。
- `UNKNOWN`：**当前规则没有产生它的路径**。取值、`--allow-unknown` 与 `task schedule clear-unknown` 都保留
  （历史的 assessment 行与客户端仍要能渲染），但日常不可达；`clear-unknown` 对 `CONFLICTING` 继续拒绝
  （`recorded:false`）。

启动前门禁不再兜底残余风险：两个都没声明功能的 Task 可以并发改同一个文件，冲突在成果 commit /
IntegrationBatch 阶段以 `CONFLICTED` 暴露（ADR-0059 D02 明确选择的权衡）。

> 需要看「引擎看到的每一条事实」时：`project impact validate/show/explain` 与 `task schedule explain`
> 仍然完整报告映射、快照、基线与占用者（含 `occupiers[].code`）；只是这些事实不再改变判定。

> 因此「一个 Task 现在为什么不跑」有三种互不相同的答案：**依赖未满足（BLOCKED）**、**冲突等待**、**容量等待**。
> CLI 用退出码 3 表示「等待」，退出码 1 表示「确实不会跑，需要处理」。详见 [cli/README.md](./cli/README.md) 的 §0.2。

### 全局暂停：Runtime 控制状态，不是 Task 状态

ADR-0061 的全局暂停是一层**控制面覆盖状态**（`RUNNING → PAUSING → PAUSED → RESUMING → RUNNING`，
任一事実不可核验则 `RECOVERY_REQUIRED`），它与每个 Task 自己的生命周期状态**正交**：

- 被冻结的 Task **仍然是**它冻结前的状态（通常 `RUNNING`），仍然持有它的 Execution、workspace 与全局容量槽位。
  全局 `PAUSED` **不是** `task pause`：后者是 ADR-0016 的单 Task 协作停止，会结束旧 Execution，恢复时新建 Execution。
- 暂停**先拦新启动**（新的 reservation/Execution/Session/successor 与向 Provider 的投递都延后），
  再按 `pid + OS start token + incarnación` 核验后冻结**模型请求发起者**（Provider 主进程）。
- **已经发出的模型请求不会被取消**（可能已在服务端完成并计费）；**工具子进程不会收到** Codeestra 的停止信号，
  但主进程停止读管道时大输出工具可能因 OS 管道背压阻塞。
- 「观察到 stopped」才算冻结：只看到 PID、只成功调用 `kill(SIGSTOP)`、只看到 stdout 安静都不成立。
- 暂停**跨 Runtime 重启保持**：启动会先读屏障，**不自动继续、不自动 kill** 上一代 boot 冻结的进程；
  `runtime stop` 也不清除它。
- 因此它还有第四种「不跑」：**全局暂停等待**（等待码 `SCHEDULER_GLOBALLY_PAUSED`，CLI 退 3），
  **不是** `BLOCKED`。`BLOCKED` 仍然只表示依赖未满足。

---

## 相关阅读

- 端到端流程与真实命令：[workflow.md](./workflow.md)
- 功能清单（一个能力一行）：[features.md](./features.md)
- 状态机与数据库细节：[../architecture/state-machines.md](../architecture/state-machines.md)、
  [../architecture/domain-model.md](../architecture/domain-model.md)、
  [../architecture/sqlite-schema.md](../architecture/sqlite-schema.md)
