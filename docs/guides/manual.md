# Codeestra 用户说明书

> **适用版本** ADR-0070 S1–S4 实现分支（2026-09-17） · **schema** v38 · **最后校对** 2026-09-17
> 版本会前进：`dev@6c7de03` 只是本目录最后一次校对的基线；当前适用版本以
> **本次修订（ADR-0066 / schema v36）**：删除 dev clone、长期 `dev` 集成分支、`task integrate` / `task integration *` / `promotion *` 与 dev 构建通道；Task 基线只有一种（项目文件夹建 workspace 时当前检出的分支），
> 成果停在 `refs/heads/task/<task-id>`，合并由你自己完成。
> **本次修订（ADR-0074 / schema v38）**：Task 基线改为项目受管的 integration ref（`refs/codeestra/integration`）；成果经 `project integration request|run` 进入该 ref，**发布到你的日常分支仍没有命令**。命令面见 [cli/managed-integration.md](cli/managed-integration.md)。
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> **本次修订（ADR-0076）**：`task` 组不再以 `<project-id>` 开头：Task id 全局唯一，它自己就是地址，**project 是 Task 的字段**（`task create` 用 `--project`，`task list` 默认为本 Runtime 全部项目、`--project` 过滤；`task schedule status|plan|run` 仍收 `<project-id>`）。旧写法不再接受。
> §4.1（创建任务）、§4.6 的任务详情描述与末尾术语表的 Task 一行由本分支按 **ADR-0065** 改写（三个必填字段；约束与任务类型已删除）。
> §10.5 的「全局暂停」由 FOUNDATION-097 新增（ADR-0061 D04–D10）；§「任务」的永久删除一条由 FOUNDATION-090 新增（ADR-0058）；§3.1、§4.2、§4.3、§4.5、§10.1、§10.3 与
> 「名词表」的冲突判定由 FOUNDATION-091 按 ADR-0059 改写（声明同一功能才冲突，默认不冲突）。
> §3.1、§3.2、§10.2 由 FOUNDATION-093 第三轮同步（ADR-0060 修订：managed 项目的常态路径不变）。
> §10.3 的 `WAIT_CAPACITY` 一行、§10.4、§11.2 与 §13.4 由 **FOUNDATION-096** 同步（ADR-0061：容量只剩一个
> Runtime 全局上限，命令去掉 project/adapter 参数，并可从 `settings concurrency` 实时调整）；
> §11 开头的「先看全」段与 §11.1 的命令拼写由 **FOUNDATION-098** 新增/改写（ADR-0064：`settings list` 总览，
> 权限模式移入 `settings permission`，顶层 `permission` 已移除）。
> §11.2.2 与 §12.3 由 ADR-0062 新增/补充（集成成功后自动回收 Task worktree，`settings auto-reclaim` 默认开启）。
> **本次修订（ADR-0066 / schema v36）**：删除 dev clone、长期 `dev` 集成分支、`task integrate` / `task integration *` / `promotion *` 与 dev 构建通道；Task 基线只有一种（项目文件夹建 workspace 时当前检出的分支），
> 成果停在 `refs/heads/task/<task-id>`，合并由你自己完成。
> §10.3 新增 `WAIT_CONTROL` 一行并由 **FOUNDATION-097** 新增 §10.5「全局暂停」。
> §「任务」永久删除一条与 §13.5 `RECOVERY_REQUIRED` 的 purge 行为由用户任务 `task/930f5325` 同步（ADR-0058 D02 修订，2026-09-16）。
> 其余内容沿用 FOUNDATION-091 的校对基线。
> **ADR-0070 S1–S4 实现修订**：§1 与 §1.1 描述 schema v37 的 Service/Process/Signal 内核命令；S5 之后能力仍不提前声称。
> §6 末尾的「Agent 运行结果卡片与最后的输出」一段与 `04-task-detail.png` 的图说由用户任务 `Loyage/simplize_task_ui`
> （2026-09-16）同步（无新命令；卡片是只读投影，截图未重拍）。

这是**写给使用者的说明书**：从头读到尾就能把 Codeestra 用起来，不需要先读架构文档或 ADR。
需要细节时，每一节末尾都有「想深入看哪篇」。

> 本文只描述**当前实现真实具备**的能力。每条命令、参数、退出码、按钮文案都从仓库源码核对得到；
> 核对方法与结果见 [docs/tasks/README.md](../tasks/README.md) 的 FOUNDATION-078 一节。
> 文档与实现不一致的地方在 [troubleshooting.md](./troubleshooting.md) §3 如实标注，不替用户裁决。

---

## 目录

1. [这是什么](#1-这是什么)
2. [装好它](#2-装好它)
3. [第一个项目](#3-第一个项目)
4. [第一个任务](#4-第一个任务)
5. [看它干活：会话、提问、指导、执行过程、终端](#5-看它干活会话提问指导执行过程终端)
6. [审阅成果](#6-审阅成果)
7. [任务验证](#7-任务验证)
8. [成果怎么交给你](#8-成果怎么交给你)
9. [本仓库自身的 `dev → main`（仓库约定）](#9-本仓库自身的-dev--main仓库约定不是产品能力)
10. [日常使用：并行、依赖、调度、容量、全局暂停](#10-日常使用并行依赖调度容量)
11. [设置与权限：FULL 与 STRICT](#11-设置与权限full-与-strict)
12. [数据在哪、怎么备份与回收](#12-数据在哪怎么备份与回收)
13. [出问题怎么办](#13-出问题怎么办)
14. [术语表](#14-术语表)

---

## 1. 这是什么

Codeestra 的长期目标是 **AI 的操作系统**：以长期 Service、短期 Process、Agent 与 Signal 统一管理 AI 工作；内核 Service-first，Scheduler 仍 Task-first。

**这本手册描述当前 schema v38**：Service / Process / Signal 内核与 `service/process/signal/intent` CLI 已可用；**受管 integration 已可用**（`project integration status|init|queue|request|run|retry|cancel` 与 `task integration show`，ADR-0074）：成果经持久 merge queue、独立 Integration Verification 与 CAS 进入项目受管的 integration ref。Project / Task / Execution / Session 仍是现有业务写路径的权威事实，并由兼容 facade 投影进新内核。**仍未实现**：Integration Process/Agent（冲突只报告不自动解决）、把 integration ref 发布到你的分支、原生 Process 控制与 intention 解释。目标架构与后续计划见 [ADR-0070](../decisions/0070-service-process-signal-kernel.md)、[ADR-0074](../decisions/0074-managed-integration-ref-and-merge-queue.md) 和 [roadmap](../roadmap/mvp.md)。

### 三条必须先知道的第一原则

1. **效率至上。** Runtime 默认运行在 `FULL` 主机级全权限模式。**项目接入、Agent 工具、成果 commit、
   验证策略变化，默认零确认、零等待。** 你随时可以用 CLI 无确认地切到 `STRICT`，恢复旧门禁
   （`bun run codeestra settings permission set strict`）。
   正确性核对（revision/ref/归属/进程身份、静止证据、幂等与崩溃恢复）**一直有效**，但那些是核对，不是审批。
2. **软件本体是服务，CLI 必须完备。** 独立本地 Runtime 是软件本体，也是目标 0 号 Service 与持久 Actor 内核的宿主。ADR-0067 起 Web UI 暂停，当前只启用 CLI/Unix socket 命令面。
   每个能力都能只靠 CLI 完成并脚本化驱动（`--json`、稳定退出码）。
3. **测试只走 CLI / 命令面。** 自动化验收不依赖桌面、键鼠或浏览器自动化。

### 一条贯穿全书的边界

Codeestra 的每一步都**只报事实，不报乐观猜测**。所以你会反复看到这几句话：

- **Task 显示「执行中」不等于 provider 此刻在跑。** 状态是 Runtime 记录的状态，不是进程心跳。
- **「已受理」不是「已完成」。** `task verify --background` 退 0 只表示验证**开始了**。
- **「已验证」不是「已合并」。** Task 验证通过不释放依赖，也不代表成果进了你的分支（合并是你自己的事）。
- **「成果已提交」不是「已合并」。** 成果停在 `refs/heads/task/<task-id>`，是否合并由你决定。
- **「main 已更新」不是「Runtime 已重启完成」。**（本仓库自身的 `dev → main` 人工流程）重启只有在
  每步退 0 且 Runtime 回答 `READY` 时才被记录。
- **提交不等于要等。** 没有声明功能的 Task `task submit` 后会在**容量允许时立即开始**（ADR-0059）；
  想让两个 Task 互斥，就给它们声明**同一个功能**（`task create --feature <module-id>`）。

> 图：`00-overview.png` — Codeestra 的总流水线：用户意图 → Task → 依赖/冲突判定 → 调度 → 独立工作树 →
> Coding Agent → Task 验证 → 成果停在 task 分支（**合并由用户自己完成**，ADR-0066）。

### 想深入看哪篇

- 名词的准确定义与硬边界：[concepts.md](./concepts.md)
- 「这软件到底有哪些功能」：[features.md](./features.md)
- 三条第一原则的规格原文：[PROJECT_SPEC.md](../../PROJECT_SPEC.md) §1.1

### 1.1 Service Kernel 的当前用法

- `service list|get|tree|state get|state set`：查看稳定 root/system/Project/Task Service；`state set` 只经 `SIG_A` 写 namespaced metadata。
- `process list|get|input|pause|resume|terminate`：既有 Execution 是只读 Development Process 投影；控制复用旧 Task/Session handler。
- `signal send|list|get|retry`：持久、可 claim/retry/dead-letter 的 Service inbox；结构化值使用 `--payload-json`。
- `intent send`：持久化 `SIG_P` 并创建 `CREATED` Intention Process；返回 `PENDING_S6`，当前不解释也不运行 Agent。

完整参数、幂等、退避与退出码见 [Service Kernel 命令参考](./cli/kernel.md)。所有命令支持 `--json`；
Signal 等待重试退 3，用法错误退 2，拒绝/dead-letter 退 1。

---

## 2. 装好它

### 2.1 依赖

Codeestra 用 Bun 运行，用 Node + Vitest 作为开发测试宿主。本机用 Nix 提供工具，不需要全局 npm 安装：

```sh
nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just
```

在仓库根安装依赖（`--frozen-lockfile` 表示严格按 `bun.lock` 安装，不改锁文件）：

```sh
bun install --frozen-lockfile
```

> Web UI 已按 ADR-0067 暂停。默认安装、检查与运行流程不构建 `apps/ui`。

### 2.2 第一次运行：`status` 会自己把 Runtime 拉起来

```sh
bun run codeestra status
```

CLI 通过 Unix socket 找到 Runtime；**没有在跑就自动启动它**，然后打印 `runtime.ping` 结果与一份
ownership 报告。关键字段：

| 字段 | 含义 |
|---|---|
| `pid` / `bootId` | 这次 Runtime 进程的身份。`bootId` 每次启动都换 |
| `status` | `READY` 才算可用；连不上也起不来是 `UNAVAILABLE`（退出码 1） |
| `permissionMode` | 当前是 `FULL` 还是 `STRICT` |
| `adapters` | 已注册的 Adapter，当前是 `pi`、`codex`、`claude` |
| `activeSessions` | 正在跑的会话 |
| `ownership` | 本 home 的锁记录、启动轨迹、socket 是否应答、`verdict` |

`status` 是**只读**的：它会启动 Runtime（若不在跑），但**不会**替换或杀掉一个「进程在、socket 不应答」的
Runtime，而是把事实报出来（`verdict: "UNREACHABLE_PROCESS"`）。

> 图：`01-first-run.png` — `codeestra status` 的输出：`pid`、`bootId`、`status: READY`、`permissionMode`、
> `adapters` 与 `ownership` 一段。

### 2.3 数据目录与单实例

Runtime 是**每用户单实例**的本地服务：**一个 `CODEESTRA_HOME` 对应一个 Runtime**，通过该目录下的
`runtime.sock` 通信。目录解析顺序：

1. 环境变量 `CODEESTRA_HOME`（若设置）
2. 否则 `$XDG_STATE_HOME/codeestra`
3. 否则 `~/.local/state/codeestra`

想试跑而不碰日常数据，换一个目录就行：

```sh
export CODEESTRA_HOME=/tmp/codeestra-demo
```

安全属性：`CODEESTRA_HOME` 目录 `0700`、socket `0600`。当前 Runtime 不启动 Web UI HTTP 服务。

> **最容易踩的一条**：CLI 只按 `CODEESTRA_HOME` 找 socket。若某个 Runtime 已经在跑，你在别的工作树执行
> `bun run codeestra …` 会打到**那个** Runtime（即那份代码），**不会**启动你当前工作树的构建。
> 要验证另一份代码，就换 `CODEESTRA_HOME`。

### 2.4 Web UI 已暂停

`codeestra ui`、`codeestra open` 与 Runtime HTTP/SSE 入口已由 ADR-0067 删除。保留的前端源码不代表可用功能；请使用 CLI。

### 2.5 两个 clone（本机构造，仓库约定）

本机把 `main` 与 `dev` 放在**两个分别 clone 的独立仓库**里，各自有 `.git` 目录与 `origin`，不是彼此的 worktree。这个拆分的**唯一理由是 Codeestra 自己要被开发（自进化）**：开发中的代码要能真的跑，而稳定实例不被它干扰。用 Codeestra 开发别的项目不涉及（也不该建立）这种 main/dev 目录拆分。

| 目录 | 检出 | 用途 |
|---|---|---|
| `~/Documents/codeestra` | `main` | **稳定 clone**：只用于运行稳定实例、拉取已批准的提升 |
| `~/Documents/codeestra-dev` | `dev` | **开发 clone**：Codeestra 自身的所有开发、集成与定向验证都在这里 |

两个 clone 的 `node_modules` 与 Runtime 数据目录**都是各自的本地状态，不共享**：各自需要 `bun install --frozen-lockfile`。

在 dev clone 里用**独立 home** 运行 dev 代码，稳定 Runtime 不受影响：

```sh
cd ~/Documents/codeestra-dev
CODEESTRA_HOME=~/.local/state/codeestra-dev bun run codeestra status
```

等价入口是 `just restart-dev`（在 dev clone 里跑）：install → `stop` → `status`。
区分「这是 dev 代码」靠的是 `CODEESTRA_HOME` 与目录。

### 2.6 停止

```sh
bun run codeestra stop                # 默认等待 10 秒
bun run codeestra stop --wait 30      # 最多等 30 秒（0–600）
```

`stop` 是两阶段且只报事实的：它先问「拥有这个 home 的 Runtime」自己是谁，再**轮询那个进程**是否真的消失。
结论只有四种：`STOPPED`（退 0）、`NOT_EXITED`（退 1，进程还在）、`NOT_RUNNING`（没有 Runtime 拥有该 home）、
`UNREACHABLE_PROCESS`（退 1，进程在但 socket 不应答，**不会被猜着杀掉**）。

它**不会**为了让 `stop` 成功而启动一个 Runtime，也不会信号化一个它无法识别的进程。

### 想深入看哪篇

- 安装的每一步与输出形状：[getting-started.md](./getting-started.md)
- 每条命令的参数与退出码：[cli/runtime.md](./cli/runtime.md)（§1、§2、§19）
- 两个 clone 与 dev 实例的完整布置：[docs/tasks/README.md](../tasks/README.md) FOUNDATION-076

---

## 3. 第一个项目

「接入项目」= 把一个 Git 仓库注册给 Runtime 并信任它。

### 3.1 先看清 Runtime 读到了什么

```sh
bun run codeestra project inspect /path/to/repo
```

关键是这几项：`repoRoot`（工作树根）、`mainRef` / `objectFormat`（主分支 ref 与对象格式）、`headCommit`。

**Task 基线只有一种**（ADR-0074）：**这个项目受管的 integration ref**（`refs/codeestra/integration`，`project trust` 用本文件夹当时检出的分支建立）。ref 与 commit 会一起
固定进这条 Task 的记录，所以你之后切分支**不会**移动已建 Task 的基线。产品不再有 dev clone、长期 `dev`
集成分支或 `dev → main` 提升——因此 `project inspect` 也不再返回 `devRef` / `devCommit` / `devRepoPath` /
`devRefRetirement`。

一个前提：**不要让它停在 detached HEAD**。那没有分支可命名，建 Task/跑 Task 时会被
`TASK_BASE_REF_UNRESOLVED` 拒绝（切到一条分支即可）。也不需要为「任务树」准备第二个 clone；如果你确实
想要一个可随时清理的沙箱，切一条分支或另建一个普通 clone 都属于你自己的 Git 选择。

### 3.2 接入（trust）

```sh
# FULL（默认）：零确认
bun run codeestra project trust /path/to/repo --yes

# STRICT：需要确认，交互输入 TRUST，或脚本传 --yes
bun run codeestra settings permission set strict
bun run codeestra project trust /path/to/repo --dev-repo /path/to/dev-clone --yes
> **本次修订（ADR-0066 / schema v36）**：删除 dev clone、长期 `dev` 集成分支、`task integrate` / `task integration *` / `promotion *` 与 dev 构建通道；Task 基线只有一种（项目文件夹建 workspace 时当前检出的分支），
> 成果停在 `refs/heads/task/<task-id>`，合并由你自己完成。
```

**没有 `--dev-repo`**：ADR-0066 之后产品不再有 dev clone，trust 记录的是仓库身份与两份已提交策略的确认。
Task 基线就是**项目受管的 integration ref**，成果先停在 task 分支，再由 `project integration run` 合进那条 ref（§8）。
把它发布到你自己的分支仍然没有命令、也仍然是你的决定。
如果这个文件夹处于 detached HEAD，建 Task 时会被 `TASK_BASE_REF_UNRESOLVED` 拒绝——切到一条分支即可。

而如果 trust 被拒，**什么都还没写**：项目不会被登记，补救命令就在错误消息里。

**影响**：一旦 trust，Agent 工具、验证命令与 Git hooks 会**以你的用户权限**运行。
STRICT 下 CLI 会明确写着：这**不**授权 commit、更新 main、push 或使用未知工具。

**防漂移**（重要）：`trust` 会把「你刚看过的身份 + 验证策略 digest + 影响映射 digest」一起提交。
若在你查看与确认之间这些文件动了，Runtime 以 `VERIFICATION_POLICY_CHANGED` 或 `IMPACT_POLICY_CHANGED` 拒绝，
而不是静默按新内容确认。仓库身份变了则以 `REPOSITORY_CHANGED` 拒绝。

同一个仓库可以有多份工作树（稳定 `main` 树与开发树）：Runtime 按 **Git common dir** 识别一个 Project，
所以再打开另一个工作树是幂等的。

### 3.3 显式 CLI 接入

`open` 已由 ADR-0067 删除。使用可脚本化的显式命令：

```sh
bun run codeestra project inspect /path/to/repo
bun run codeestra project policy /path/to/repo
bun run codeestra project impact validate /path/to/repo --json
bun run codeestra project trust /path/to/repo       # STRICT 脚本可加 --yes
bun run codeestra project list
```

### 想深入看哪篇

- 完整的接入步骤与预期输出：[getting-started.md](./getting-started.md) §4
- Project 的概念与 common dir 识别：[concepts.md](./concepts.md)
- `project *` 每条命令：[cli/project.md](./cli/project.md)

---

## 4. 第一个任务

### 4.1 创建草稿

```sh
bun run codeestra task create --project $PROJECT "为 parser 增加一个 CRLF 输入用例" \
  --title "给 parser 补一个 CRLF 输入用例" --name "parser-crlf-case"
```

- `$PROJECT` 是 `project list` 返回的 Project ID。
- **项目只在创建时点一次名**（ADR-0076）：以后每条 `task …` 命令都只收 `<task-id>`，project 是 Task 自己的一个字段
  （`task status`/`task list` 的输出里带 `projectId`）。唯一例外是 `task schedule status|plan|run`——一趟调度 pass 是每项目的。
  旧的 `task status <task-id>` 写法**不再接受**：多出来的 token 会被当成 Task id 或未知 flag，结果是用法错误（退出码 2）。
- 三个字段**都必填**（ADR-0065）：位置参数是**任务详情**（Agent 实际依据的正文）；
  `--title <显示标题>` 是一句话摘要，任务列表显示的就是它；`--name <命名标题>` 是小写英文短横线 slug
  （`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`，≤ 50 字符），分支与 worktree 目录叫 `task/<编号>-<name>` 与 `<编号>-<name>`。
- 两个标题是 **Task 级**字段：创建后没有任何命令可以修改它们（要改就新建任务）。
- `--constraint` 与 `--kind` **已删除**：约束列表与任务类型都不再存在，把它们当 flag 传会以用法错误（退出码 2）结束。
  过去写成约束的限制现在写进任务详情即可。

**创建出来的 Task 是 `DRAFT`**：它**不会**自动启动 Agent。结果里要记住两个值：`taskId` 与 `version`
（乐观版本号，后面每条改状态的命令都要传它）。

### 4.2 提交为就绪

```sh
bun run codeestra task submit <task-id> <expected-version>
```

`submit` 把 `DRAFT` 变成 `READY`，并在**同一条命令里**核对依赖 + 跑一次调度 pass。
所以提交之后你不需要再推任何东西：**未声明功能的 Task 会在容量允许时就在这条命令里被启动**
（返回的 `schedule.started` 就是它）；只有被依赖、被功能冲突、被容量或 draining 拦住时才停在
`READY`——见下一小节与 §10.1。

版本不符会以版本冲突类错误拒绝，而不是覆盖别人的修改。

### 4.3 启动 Agent

```sh
bun run codeestra task run <task-id> <expected-version> \
  [--adapter pi|codex|claude] [--allow-unknown] [--json]
```

`task run` 是**与自动调度同一道门禁的显式启动请求**：依赖判定 → 对每个**未完成且声明了功能**的 Task 的冲突判定 → 容量。

**`task run` 有三个不同的退出码**，这是脚本区分「现在没轮到」与「确实不行」的方式：

| 退出码 | 含义 | stderr |
|---|---|---|
| `0` | 已启动（`outcome: STARTED`） | 无 `[scheduler]` 行 |
| `3` | **等待**（`WAIT`）：冲突等待、容量等待，或 Runtime 正在 draining | `[scheduler] CONFLICT\|CAPACITY wait: <code> — …` |
| `1` | **拒绝**（`REFUSED`）：依赖未满足、状态不可启动、revision 过期等 | `[scheduler] refused: <code> — …` |

每次运行**绑定一个 Agent**：换 `--adapter` 是**新建一次 Execution**，不是在同一个 Execution 里换 Agent。

### 4.4 不做任何事也会被调度

Runtime **自己会调度**：一次相关事件（提交、停止、revision 投递、槽位释放、容量变化）触发一次 pass，
另有一个周期性恢复 pass 收敛崩溃遗留的状态。周期由环境变量 `CODEESTRA_SCHEDULE_TICK_MS` 控制（默认 `5000` 毫秒）。

排序规则：**priority 降序 → 创建时间 → ID 升序**。提高优先级只改变**下一次**顺序，**不会抢占**已经持有
资源的 Task。注意：目前**没有任何命令能改优先级**，新建 Task 的 priority 恒为 0，所以实际排序是后两者。

### 4.5 任务的生命周期

```text
DRAFT → BLOCKED → READY → RUNNING ⇄ (PAUSING → PAUSED → RUNNING)
                        ↓
        WAITING_FOR_USER / RECOVERY_REQUIRED / CANCELLING / CANCELLED
                        ↓
                     EXECUTED → FAILED / SUCCEEDED
```

| 状态 | 人话 |
|---|---|
| `DRAFT` 草稿 | 还没提交，不会自动启动 |
| `READY` 就绪 / 待调度 | 等待调度或手动启动；**不代表 Agent 已运行**。容量允许时，`task submit` 后会在同一个命令里就被启动（ADR-0059） |
| `BLOCKED` 等待依赖 | **专指依赖未满足**。冲突等待、容量等待都不叫 `BLOCKED` |
| `RUNNING` 执行中 | 有一次执行在进行；查看会话、实时步骤或待提交成果 |
| `WAITING_FOR_USER` 等你处理 | 有请求等你回答（只暂停这一个 Task） |
| `PAUSING` / `PAUSED` | 正在协作停止 / 现场已保留，可继续 |
| `CANCELLING` / `CANCELLED` | 正在终止 / 已终止，**不会自动重开** |
| `EXECUTED` 成果已提交 | 有成果 commit，等待验证；**合并不是产品动作** |
| `FAILED` / `RECOVERY_REQUIRED` | 失败 / 需要人工对账（**不要靠重试掩盖**） |

其他常用操作：

```sh
bun run codeestra task list [--project $PROJECT] [--all]           # 列出任务（--all 含归档）
bun run codeestra task status <task-id>       # 执行/验证投影 + 会话结束注记
bun run codeestra task pause <task-id> <expected-version>
bun run codeestra task resume <task-id> <expected-version> [--adapter <id>]
bun run codeestra task retry <task-id> <expected-version> [--adapter <id>]
bun run codeestra task cancel <task-id> <expected-version>
bun run codeestra task archive|unarchive <task-id> <expected-version>
bun run codeestra task purge <task-id> <expected-version> --yes [--force] [--reason <text>]
```

- **暂停**是协作停止：确认 provider 进程退出后才进 `PAUSED`，工作树与会话保留。
- **继续**在同一工作树新建一次执行，并**复用已暂停会话的 provider conversation**。
- **重试**只对 `FAILED` 生效，只由这条显式命令触发；重试后仍走同一道调度门禁（会排队，不会插队）。
- **终止**是终态；**归档**只隐藏任务，不删记录、不回收工作树，可随时取消归档。
- **永久删除**（`task purge --yes`）是唯一不可撤销的操作：它删掉任务的全部记录与它自己的 worktree、验证副本、`task/<id>` 分支，
  同时在事件流里留下一条 `TaskPurged`（含每个被删分支的 tip）。三点必须知道：
  1. **成果已进 `dev` 的任务删不掉**（`TASK_INTEGRATED_INTO_DEV`）——否则那个 commit 会失去「谁把它带进来」的记录；这类任务只能归档，`SUCCEEDED` 任务都属于这一类。
  2. **正在跑的任务会先被真地终止**（能确认 provider 退出才继续）；`RECOVERY_REQUIRED` 任务会先按观察对账（与 `task recover` 同一判定）：能证明 provider 已退出就继续删除（最终状态 `FAILED`、结果里 `stop.stop: "RECOVERED"`），否则什么都不删并报 `RECONCILE_REQUIRED`。
  3. **被拒绝时可以加 `--force`**（ADR-0058 D09）：它是同一条命令的更宽的声明，不是第二道确认（`--yes` 仍是唯一一次确认）。它先对任务**记录过的身份**发 `SIGTERM`→`SIGKILL` 终止 provider（记录里没有 start token 的 pid 一律不发信号），再删掉本来只由「活占用」保护的资源（ADR-0066 之后没有「成果已进入 dev/main」这一类拒绝了）。**归属不明**的目录与分支留在磁盘上并逐项列出；`forced`（以及 CLI 的 stderr）会告诉你跳过了什么、进程是否真的终止。
  3. 它会连带删掉**指向该任务的依赖边**（下游会因此重新判定）。

日常清理不再需要的任务：先 `task cancel`（如果需要），再 `task purge --yes`；被拒绝又确实不再需要它时加 `--force`。只想让列表安静下来就用 `task archive`。

> 图：`03-task-workbench.png` — 任务工作台：顶部「项目任务概况」四个计数卡（全部任务 / 执行中 /
> 需要你处理 / 成果已提交）、搜索与筛选行、任务行（状态徽标 + 提示文字 + 「查看详情 →」）。

### 想深入看哪篇

- 完整端到端流程：[workflow.md](./workflow.md)
- 状态机与不变量：[concepts.md](./concepts.md)、[../architecture/state-machines.md](../architecture/state-machines.md)
- `task` 每条命令：[cli/task-lifecycle.md](./cli/task-lifecycle.md)（§4）与 [cli/task-revision-session.md](./cli/task-revision-session.md)（§5）
- 「我想做 X」的步骤化做法：[recipes.md](./recipes.md)

---

## 5. 看它干活：会话、提问、指导、执行过程、终端

### 5.1 Agent 会停下来问你

Agent 需要你决定时会留下一条 **Attention**（需要人回答的请求）。你**不需要盯着终端**：请求会出现在
它会出现在 CLI 的 `attention list` 里，并且**只暂停对应的那个 Task**，其他合格任务继续跑。

```sh
bun run codeestra attention list $PROJECT
```

每条包含 `id`、`kind`（`PERMISSION` / `QUESTION` / `RECOVERY`）、`status`、`responseType`
（`CONFIRM` / `VALUE`）、`prompt`、`taskId`、`executionId`、`createdAt`。三种通道选一个按 `kind` 用：

```sh
# 权限 / 确认类（responseType=CONFIRM）
bun run codeestra attention answer $PROJECT <attention-id> confirm yes
bun run codeestra attention answer $PROJECT <attention-id> confirm no

# 纯文本类（responseType=VALUE）
bun run codeestra attention answer $PROJECT <attention-id> value "用现有 helper，不要新增依赖"

# 结构化问卷（Agent 用 ask_user_question 一次提 1–4 题）
bun run codeestra attention answer $PROJECT <attention-id> --choose 1:2 --text 2="保持向后兼容"
bun run codeestra attention answer $PROJECT <attention-id> --cancel
```

- `--choose <题>:<选项>` **可以重复**；题号与选项号都是 **1-based**。
- 一道题只能答一次，重复会报错。
- 越界/重复/单选多选不符由 Runtime 拒绝并返回 `INVALID_QUESTIONNAIRE_ANSWER:*`，**请求保持 OPEN**，
  你已答的内容不会被吞掉——改对再提交即可。

> 图：`05-attention.png` — 「待处理」标签页的一张问卷卡片：题号与题干、单选/多选按钮与选项说明、
> 「或用自己的话回答」输入框，底部「发送 N 个回答」与「拒绝回答」。

### 5.2 Agent 在散文里提问然后结束了轮次

有一种情况容易让人困惑：Agent **没有用工具**，直接在正文里提问并结束轮次。Runtime 用一条确定性启发式
（一次运行里没有工具调用，且最后一段助手文本以问号结尾）把它记成一条独立的 Attention 与
`WAITING_FOR_USER`，标注码 `PROSE_QUESTION_NO_TOOL_USE`。

**关键是它不是一个还在等你的对话**：provider 进程**已经退出**，没有 dialog 可以写。所以退出方式不同：

```sh
bun run codeestra task status <task-id>        # stderr 会打印 [waiting] … 与 Agent 的问题原文
bun run codeestra attention resolve $PROJECT <attention-id> --answer "这是我的回答"
bun run codeestra attention resolve $PROJECT <attention-id> --dismiss
```

- `--dismiss` 记「误报」，`--answer` 记下你的回答。**两者都必须恰好给一个**。
- 两者都**不会恢复 provider 对话**，也**不是** TaskRevision：回答是关于**这一次等待**的陈述，
  不是对规格的修改。
- 用 `attention answer` 去投递这类等待会被以 `PROSE_QUESTION_RESOLUTION_REQUIRED` 拒绝（因为没有 dialog）。

不想每次都被这样打断，可以降级（零确认，不改写已记录的等待）：

```sh
bun run codeestra settings prose-question-attention            # 读取当前值
bun run codeestra settings prose-question-attention auto        # 默认：记成等待
bun run codeestra settings prose-question-attention record-only # 只标注完成，不记等待
bun run codeestra settings prose-question-attention off         # 什么都不记
```

### 5.3 看它到底做了什么（执行过程）

```sh
bun run codeestra task transcript <task-id> [--execution <id>] [--after <entry-id>] [--limit <n>] [--reverse]
bun run codeestra session transcript <session-id> [--after <entry-id>] [--limit <n>] [--reverse]
bun run codeestra session transcript part <session-id> <entry-id> <part-index>
```

内容来自 **Provider 自己的会话文件**：工具调用与工具返回、助手文本、thinking、token 与成本。

**它的边界要记清**：这是**只读**展示——不写数据库、不改任务状态、**不是 attach、也不是终端接管**。
长内容默认截断，`part` 命令取回整块；`--reverse` 是给人看的渲染选择（与 `--json` 互斥）。

> 图：`06-transcript.png` — 「Agent 执行过程」面板：排列下拉框（正序/倒序）、单行时间线条目
> （类型标签 + 摘要 + 时间）、展开后的分段正文与「展开全文」按钮。

### 5.4 亲自接管终端

如果要在**真实 PTY** 里直接操作 Agent 的终端，用会话交接命令面：

```sh
bun run codeestra session handoff status  $PROJECT <session-id>
bun run codeestra session handoff request $PROJECT <session-id> takeover
bun run codeestra session handoff admit   $PROJECT <session-id>            # 真正启动原生终端
bun run codeestra session handoff attach  $PROJECT <session-id> --holder <ref> [--writer|--observer]
bun run codeestra session handoff detach  $PROJECT <session-id> --holder <ref>
bun run codeestra session handoff terminal read  $PROJECT <session-id> [--since <cursor>]
bun run codeestra session handoff terminal write $PROJECT <session-id> --text <text>
bun run codeestra session handoff release $PROJECT <session-id> [--no-resume]
```

必须知道的边界：

- **同一时刻只允许一个 writer**。第二个 writer 申请会被以 `ATTACHMENT_BUSY` 明确拒绝，带出当前 holder；
  **不排队、不静默降级**。
- **`detach` 只释放你这个客户端的附加**，不停终端、不动 provider 进程。
- **写入终端不是审批通道**：STRICT 的权限请求仍要在「待处理」页面回答；终端里敲的不是批准。
- **交接只在安全点发生**，安全点只由结构化事实判定（fence 已确认、无活动工具、fence 后有 settled 事实、
  无未决 Attention），**不从终端屏幕文本推断**。
- `admit` 真的会启动 successor 进程，所以它是移动 lease 的那一步；`release` 写终端自己的释放字节并核验
  provider 已退出、会话文件仍在。**退出码只作审计**（Ctrl+D 与 SIGTERM 都可能是 0），不参与判定。

> 图：`07-terminal.png` — 「原生终端与会话交接」面板：会话/incarnation/写入租约/side channel 的键值表、
> 「安全点与 fence」清单、请求接管/接管/取消/刷新按钮、原生终端投影区与输入框。

### 5.5 给运行中的会话一句话（Session Guidance）

想对**正在跑的** Agent 说一句「怎么做」（比如「先用仓库的约定文件」），而**不想改验收标准**，就用 guidance：

```sh
bun run codeestra session guide $PROJECT $TASK --message "先用仓库的约定文件，不要自创风格"
bun run codeestra session guidance list $PROJECT $TASK     # 台账：记录、尝试、每个 Execution 启动时带上它的产物
bun run codeestra session guidance get  $PROJECT <guidance-id>
```

必须知道的边界：

- **它不改变任务**：不产生 revision、不动 Task 的 revision 与 version、**不使任何验证失效**。
  改任务详情、改功能声明或改验收目标**必须**走 `task amend`（`task revision create`），旧验证仍然因此失效。这两条通道不能互相代替。
- **记录之后它不会随进程消失**：该 Task 的每条 guidance 会在**新建 Execution**（`task resume` 的 successor、`task retry`
  的新 Execution）启动时随启动参数一并交给 provider。用户不需要为了让它生效而重发一遍。
- **`0` 与 `1` 的意思不一样**：退出码 `0` = 已经交给运行中的 provider 通道（`DELIVERED`），**或**当时没有会话可交付而消息
  已记录（`RECORDED`，等下一次启动交付）；退出码 `1` = provider/会话被问过却没交付（`CHANNEL_UNSUPPORTED` / `TIMED_OUT` /
  `FAILED`），stderr 会打稳定码。用法错误是 `2`。
- **“已投递”不等于“模型已读”**：`DELIVERED` 只表示 **provider 自己的通道接受了这条消息（入队）**。三个 provider 都没有
  可核验「已生效」的通道（ADR-0051），所以命令面把这件事说出口：`--json` 里的 `modelAcknowledgement` 恒为 `UNSUPPORTED`。
- **不是每个 provider 都有活会话通道**：Pi 有（RPC `steer`）；Codex 记 `REQUIRES_VALIDATION`、Claude Code 记 `UNSUPPORTED`，
  在它们上面给**运行中**的会话发指导会得到 `CHANNEL_UNSUPPORTED` 与退出码 `1`（消息仍然被耐久记录，仍然会在下一次启动交付）。
- **零新增确认**：FULL 与 STRICT 下都是同一条命令，没有确认步骤；guidance 不是审批通道。

### 5.6 运行事件（事实流）

```sh
bun run codeestra events list [--project $PROJECT] [--since <sequence>] [--limit <n>] [--json]
bun run codeestra events tail [--project $PROJECT] [--since <sequence>]
```

**游标是排他的**：不带 `--since` 表示「从当前尾部开始」，所以正确做法是**先取一次快照，再用那个游标订阅**，
中间不丢事件。带 `--since` 但游标**大于**日志最新 sequence，会收到一帧
`{"type":"error","code":"INVALID_CURSOR"}` 并结束订阅——这是刻意的：**未知游标被告知，而不是被静默裁剪**。

长命令的步骤与输出块（`OperationProgressed` / `OperationSettled`）也走同一条流，但**进度事件永不携带判定**：
验证是否通过只由 `VerificationCompleted` 与该运行自身的状态报告。

> 图：`09-events.png` — 「运行事件」标签页：状态指示（实时/正在重连）、当前游标、停止跟随/继续跟随/清空，
> 以及每帧的 `sequence`、`eventType`、`aggregateType` 与 payload（调度类事件额外有一句人读摘要）。

### 想深入看哪篇

- Web UI 暂停状态：[ui.md](./ui.md)
- Attention、Session、handoff 的概念：[concepts.md](./concepts.md)
- `attention` / `session handoff` / `events` 命令：[cli/task-revision-session.md](./cli/task-revision-session.md)（§7）与 [cli/interface.md](./cli/interface.md)（§17–§18）
- 「Agent 停下来问我了」怎么处理：[recipes.md](./recipes.md)

---

## 6. 审阅成果

「成果提交」（result commit）把 Agent 在工作树里的改动固定成一个 commit。

### FULL（默认）：一步

```sh
bun run codeestra task result capture <task-id> [execution-id]
```

### STRICT：两步

```sh
bun run codeestra task result prepare <task-id> [execution-id]   # 拿到 authorizationId
bun run codeestra task result commit <task-id> <authorization-id> --confirm
```

### 两条路径都适用的前提与影响（这些是**核对**，不是审批）

- 只会在**已核验归属**的 task worktree 里提交。
- 创建 commit 前会**固定 HEAD / ChangeSet / revision**；它们在你确认之后变了就以 `STALE_AUTHORIZATION` /
  `COMMIT_MISMATCH` / `STALE_REVISION` 拒绝。
- 沿用仓库**已有**的 Git identity；缺失时**停止**，**不代写** `git config`（`IDENTITY_NOT_CONFIGURED`）。
- trust 之后**正常执行 hooks**；失败**保留现场**，不会 `--no-verify`。
- **没有任何改动**时以 `NOTHING_TO_COMMIT` 拒绝；Agent 还没静止时以 `AGENT_NOT_QUIESCENT` 拒绝。
- STRICT 下还会拒绝**敏感路径**（`SENSITIVE_PATH_BLOCKED`）；**FULL 下不做敏感路径拒绝**。
- 成果落在内部 `refs/heads/task/<task-id>`。

CLI 只在**可捕获**的状态接受提交（任务 `RUNNING`、该 Execution 仍在运行、持有资源、
**且它的 Session 已 `EXITED`**）。STRICT 下按钮变成「准备成果提交」，随后出现「成果提交授权」区块，
显示预期 HEAD、变更指纹、是否已静止、工作区路径，并由你按下「确认成果提交」。

Agent 一退出，任务详情顶部就出现**「Agent 运行结果」卡片**：结局（provider 记的成功/失败，或「没有记录到结局」）、
停止原因、工具调用数，以及 **Agent 最后说的话**（provider 报告的最后一段文本，Runtime 最多保留 2000 字符，
截断时写明只保留了尾部）。不必展开折叠块、也不必滚到底部去翻会话记录；卡片上的 `查看完整会话记录 ↓`
跳到下方只读的完整过程。任务列表上，这一行的行尾提示也会从「执行中」改成「Agent 已退出 · 等待提交成果」。
如果这次结束**什么都没记下来**，两边都会这么写，不会当成成功。

> 图：`04-task-detail.png` — 任务详情：「Agent 运行结果」卡片（含最后的输出）、`下一步` 提示行、
> 任务操作按钮组（提交为就绪 / 启动 Agent / 暂停 / 提交成果 / 验证任务 / 合入 dev）、
> 显示标题与命名标题、任务详情正文（ADR-0065）。
> **本次修订（ADR-0066 / schema v36）**：删除 dev clone、长期 `dev` 集成分支、`task integrate` / `task integration *` / `promotion *` 与 dev 构建通道；Task 基线只有一种（项目文件夹建 workspace 时当前检出的分支），
> 成果停在 `refs/heads/task/<task-id>`，合并由你自己完成。

### 想深入看哪篇

- 成果 commit 的安全策略与全部拒绝码：[workflow.md](./workflow.md) §5、[troubleshooting.md](./troubleshooting.md)
- `task result` 命令：[cli/task-result-verify.md](./cli/task-result-verify.md)（§8）

---

## 7. 任务验证

```sh
bun run codeestra task verify <task-id> [execution-id] [--policy auto|targeted|project] [--background]
bun run codeestra task verification list <task-id>
```

- 命令来自**项目 `main` ref** 上人工维护的 `.codeestra/policies/verification.json`。
- 在**固定 commit 的 detached 副本**里运行，**不在你的工作树里**。
- 证据**不含原始命令输出**，只绑定 `revision / commit / policy digest`。
- `--policy`：
  - `auto`（默认）：该 Task 有**已记录**的定向计划、且与本次 revision/commit 匹配时用它，否则用固定项目策略；
  - `targeted`：**必须**有这样一个计划，否则拒绝；
  - `project`：用固定项目策略。

**退出码要看清**：不加 `--background` 时，只有 `state === "PASSED"` 才是 `0`，否则 `1`。
加 `--background` 时 `0` 表示「**已受理并开始**」——**不代表验证通过**。

### 用后台长命令跟踪

```sh
bun run codeestra task operation list <task-id> [--json]
bun run codeestra task operation get <operation-id> [--json]
bun run codeestra task operation cancel <task-id> <operation-id> [--json]
```

CLI 读取的长命令进度只包含**Runtime 记录的事实步骤**，不预估百分比。取消是**协作停止**：
只有在确认进程组静止后才记录终态；无法确认时保留占用并需要人工处理（退出码 1，**不要当成已取消**）。

### 按分支职责分层的测试证据

开发分支（`task/*`、`lane/*`、feature）**在建分支时就**写下一份小的 `.codeestra/tests.json`
（一个 scope 说明 + 1–16 条带 `covers` 的 argv 命令）。它是**显式、可审计的追加**：

```sh
bun run codeestra task tests record <task-id> [--commit <full-sha>] [--expected-plan-digest <sha256>]
bun run codeestra task tests show <task-id>
bun run codeestra task tests history <task-id> [--limit <n>]
```

- `task verify` 运行的是**已记录的计划**，**不是文件本身**；所以事后改文件不会悄悄改变判定命令。
- 属于**另一个 revision 或 commit** 的旧计划会被拒绝（`TARGETED_TEST_PLAN_REVISION_MISMATCH` /
  `_COMMIT_MISMATCH` / `_DIGEST_MISMATCH`），**不会**被静默换成项目策略。

### 想深入看哪篇

- 验证的完整语义与策略文件格式：[workflow.md](./workflow.md) §6、[concepts.md](./concepts.md)
- 验证相关的全部拒绝码：[troubleshooting.md](./troubleshooting.md) §1
- `task verify` / `task tests` / `task operation`：[cli/task-result-verify.md](./cli/task-result-verify.md)（§9–§10）

---

## 8. 成果怎么交给你

**Codeestra 不合入任何东西**（ADR-0066）。任务跑完、验证通过之后，成果 commit 停在
`refs/heads/task/<task-id>`，**合并是你自己的事**：

```sh
# 先看这个任务的结果 commit
bun run codeestra task status $TASK --json

# 在你自己检出的分支上合并它（ff-only 只在你确认没有分叉时成立）
git -C <项目文件夹> merge --ff-only <result-commit>
```

- 产品**没有** `task integrate`、`task integration *`、`promotion *` 这些命令：它们随 ADR-0066 一起删除，
  连同 IntegrationBatch、独立集成验证与 `dev → main` 提升。执行它们只会得到用法错误。
- 为什么合进 integration ref 与"发布到你的分支"要分开：前者是 Codeestra 管理的私有事实（`refs/codeestra/integration`），
  后者是把代码放进你日常使用分支的动作，冲突与产品取舍属于你的判断；Codeestra 不替你做，
  也就不会替你记账。
- **回收**是分开的一件事：`reclaim plan/apply` 只删归属校验通过、且成果**已经进入该 workspace 记录的
  `base_ref`** 的 worktree；没有自动路径（见 §12.3）。
- 依赖释放跟着变：下游要等到上游的结果 commit 对**它自己的基线 ref** 可达。这个重判发生在每一趟调度
  （默认每 5 秒一次），所以下游可能比你先看到的早一点转 `READY`；`task depends list` 是只读的，
  它可能显示「边已满足、任务仍是 `BLOCKED`」，最多滞后一个 tick。

### 想深入看哪篇

- [`cli/integration-dag-scheduler.md`](./cli/integration-dag-scheduler.md) §11（删除说明）、§12、§16
- [`architecture/git-workspace-api.md`](../architecture/git-workspace-api.md) §3
- [`decisions/0066-remove-dev-clone-and-dual-baseline.md`](../decisions/0066-remove-dev-clone-and-dual-baseline.md)

## 9. 本仓库自身的 `dev → main`（仓库约定，不是产品能力）

**产品没有发布到 main 的命令**（ADR-0066）。如果你是在用 Codeestra 开发**别的**项目，这一节与你无关：
成果停在 task 分支，合并由你自己在自己的分支上完成（§8）。

Codeestra **自身的开发**仍按仓库约定走两个 clone：`~/Documents/codeestra` 检出 `main`（稳定实例）、
`~/Documents/codeestra-dev` 检出 `dev`（开发与集成）。`dev → main` 是人工四步，写在
[`docs/agents/runbook.md`](../agents/runbook.md) 与 `AGENTS.md`：

1. push 固定 dev 候选到 `origin/dev` 并读回核对；
2. 在 main clone `git fetch` + `git merge --ff-only origin/dev`；
3. 在 main clone 重启稳定 Runtime 并核对 `status: READY`；
4. 核对通过后才把 `main` 推回 `origin/main`（重启失败则不推回，保留现场）。

这不是产品能力：没有记录、没有命令、没有稳定码，也没有任何东西替你保证它被执行过。

### 想深入看哪篇

- [`architecture/git-workspace-api.md`](../architecture/git-workspace-api.md) §3
- [`agents/runbook.md`](../agents/runbook.md)（人工四步与重启规程）

## 10. 日常使用：并行、依赖、调度、容量

### 10.1 想让两件事同时做：默认就是并行的

冲突判定是**确定性、不用模型**的：它只比较**声明**——两个 Task 的当前 revision 是否声明了**同一个功能 id**
（`task create --feature <module-id>` / `task revision create --feature <module-id>`，取自项目 `main` ref 上
`.codeestra/impact.json` 的 `modules[].id`，ADR-0059）。结论只有三种：

- `SAFE_TO_PARALLELIZE`：**默认**。没有与任何**未完成**的 Task 声明同一个功能（同一文件、同目录、共享依赖
  都不再阻止并发）。
- `CONFLICTING`：双方声明了同一功能，且对方还没完成（非 `SUCCEEDED`/`CANCELLED`、未归档）。**永远不放行**。
  想让两件事互斥，就给它们声明同一个功能。
- `UNKNOWN`：**当前规则不再产生它**。取值、`--allow-unknown` 与 `task schedule clear-unknown` 都保留
  （历史 assessment 行与客户端仍要能渲染），但日常不可达；`task schedule explain` 对 `CONFLICTING`
  继续拒绝单次放行。

代价要说清楚：两个都没声明功能的 Task 可以并发改同一个文件，冲突要到成果 commit / 合入 `dev` 时以
`CONFLICTED` 暴露——这是你选定的权衡，启动前门禁不再兜底。

看一个 Task 为什么没在跑：

```sh
bun run codeestra task schedule explain <task-id> [--adapter <id>] [--json]
bun run codeestra project impact show    $PROJECT <task-id> [--json]
bun run codeestra project impact explain $PROJECT <task-id> [--json]
```

`task schedule explain` 退出码：`0` = 正在跑或现在会启动；`3` = 等待（`WAIT_CONFLICT` / `WAIT_CAPACITY`）；
`1` = `BLOCKED` 或根本不可调度。

### 10.2 依赖：上游必须真的进了 dev

```sh
bun run codeestra task depends add <task-id> <expected-version> <prerequisite-task-id> [--revision <revision-id>]
bun run codeestra task depends remove <task-id> <expected-version> <prerequisite-task-id>
bun run codeestra task depends list   [<task-id> | --project $PROJECT] [--json]
```

- 依赖图必须是 **DAG**；加环会以 `DEPENDENCY_CYCLE` / `DEPENDENCY_GRAPH_INVALID` 拒绝，**且不部分应用**。
- **关键语义**（ADR-0066）：上游**指定修订自己的结果 commit** 必须对下游的 **Task 基线 ref** 可达。
  **仅 Task 验证成功不释放依赖**——你要把上游的成果合并进自己的分支，下游才会解锁。
- 基线来源：项目受管的 integration ref `refs/codeestra/integration`（只有这一种，由 `project trust` 物化、缺失时首次需要补建）；
  读不到基线（ref 与文件夹分支都不可得）就按未满足阻塞
  （`BASE_REF_MISSING`），**不会**因此拒绝整条命令。上游没有结果 commit 是 `UPSTREAM_RESULT_MISSING`，
  结果 commit 不在基线里是 `NOT_REACHABLE_FROM_BASE`。
- **重判发生在每一趟调度**（默认 5 秒一次，或你显式 `task schedule run`）：`task depends list` 是只读的，
  它可能显示「边已满足、任务仍是 `BLOCKED`」，最多滞后一个 tick。

### 10.3 调度：三种「不跑」互不相同

```sh
bun run codeestra task schedule status  $PROJECT [--adapter <id>] [--json]
bun run codeestra task schedule plan    $PROJECT [--adapter <id>] [--json]   # 有序 dry run，不预留、不启动
bun run codeestra task schedule run     $PROJECT [--adapter <id>] [--json]
bun run codeestra task schedule clear-unknown <task-id> [--json]
```

| 现象 | 含义 | 退出码 |
|---|---|---|
| `BLOCKED` | **依赖未满足**（唯一含义） | 1 |
| `WAIT_CONFLICT` | 与某个**未完成且声明了同一功能**的 Task 冲突 | 3 |
| `WAIT_CAPACITY` | **整个 Runtime 的唯一并发上限**已满（默认 2，跨全部项目与 Adapter） | 3 |
| `WAIT_CONTROL` | **Runtime 全局暂停**（`SCHEDULER_GLOBALLY_PAUSED`），见 §10.5 | 3 |
| `SCHEDULER_DRAINING` | Runtime 正在 draining，不接受新预留 | 3 |

`UNKNOWN` 的**显式单次放行**（`task schedule clear-unknown` 或 `task run --allow-unknown`）绑定
revision、基线与分析器/策略版本，写入审计台账，被**恰好一次**启动消费，并且**不改变已记录的判定**。
ADR-0059 之后当前规则**不再产生 `UNKNOWN`**，所以这条路日常不可达；`CONFLICTING` 永远不放行。

### 10.4 容量与槽位

```sh
bun run codeestra scheduler capacity get [--json]
bun run codeestra scheduler capacity set --limit <n> [--json]
bun run codeestra scheduler capacity reset [--json]
bun run codeestra scheduler reservations list $PROJECT [--task <task-id>] [--include-released] [--limit <n>]
bun run codeestra scheduler reservations release $PROJECT <reservation-id> --reason "…"
bun run codeestra scheduler reservations reconcile $PROJECT [--json]
```

- **只有一个上限，而且是整个 Runtime 的**（ADR-0061）：同一个 `CODEESTRA_HOME` 下所有项目加起来的并发 Task 不超过它。默认 2，上限 16。
  旧版本的项目级 / 每 adapter 上限已经**删除**（不是隐藏开关）；升级时如果你以前显式设置过多个值，取其中**最小值**，没有显式值则为 2。
- 设置上限是**零确认**的：`set --limit 4` 就生效；重复设置同一个值是幂等 no-op。再敲 `reset` 就回到默认 2。
- 也可以在**设置面**调整同一个值：`bun run codeestra settings concurrency get|set --limit <n>|reset`。
  两种拼写发的是**同一条命令**（同一行、同一条审计事件），所以不存在两个值。
- **改完立刻生效，不需要重启 Runtime**：提高上限会为每个项目触发一次调度，正等着容量的任务立即有机会启动；
  **降低上限不会打断已经跑着的任务**（这是刻意的：不会因为你调小数字就杀掉谁）。
- 非法值有自己的稳定码（`CAPACITY_LIMIT_INVALID` / `CAPACITY_LIMIT_OUT_OF_RANGE`），**不会被静默夹取**。
- **释放必须显式且必须给原因**。**没有任何东西会因为心跳过期、客户端消失或用户等待而自动释放。**
  可证明仍存活的持有者会被拒绝释放（`SLOT_HOLDER_STILL_RUNNING`）。
- `reconcile` 只**读真实进程表**：已死 → 释放并记录；仍存活 → 保持占用；无法核验 → `RECOVERY_REQUIRED`。
  它**不发信号、不杀进程、不删资源、不声称静止**。
- 一个常见的误解：**Task 启动后，槽位由预留移交给该 Execution**，所以「没有活跃预留但任务在跑」是正常事实。
  用 `--include-released` 可以看到这次移交。
- **暂停全部任务（全局冻结 Provider）属于 ADR-0061 的另一半，还没有实现**：目前没有 `scheduler control *` 命令，
  `capacity get` 的 `pauseState` 只会是 `RUNNING`。单任务暂停仍用 `task pause`。

> 图：`08-schedule.png` — 「调度」标签页：调度引擎面板（adapter / 调度循环 / draining / 最近一次 tick /
> 容量一行）、活跃集合表、候选顺序卡片（含等待块与命中路径）、容量与槽位预留表。

### 10.5 全局暂停：机器负载太高，或者我要它先别动

```sh
bun run codeestra scheduler control status    [--json]
bun run codeestra scheduler control pause     [--json]
bun run codeestra scheduler control resume    [--json]
bun run codeestra scheduler control reconcile [--json]
```

这四个命令**不属于任何项目**（控制的屏障是整台机器的），FULL 与 STRICT **都不需要二次确认**。
这些命令控制整个 Runtime，与任何单个项目无关。

**它做什么**：先立屏障（新的 Execution/Session/successor 与向 Provider 的投递都停下），
再按 `pid + OS start token + 这次 incarnation` 核验，然后只对**模型请求发起进程**发 `SIGSTOP`；
工具子进程**不会**收到 Codeestra 的信号（大输出工具仍可能因管道背压阻塞）。
继续时逐目标重验，只唤醒**身份完全一致**的那些。

**它不做什么**：不改写任何 Task/Execution/Session 状态，不释放槽位、工作树或写者租约，
不清空已发出的模型请求（它可能已在服务端完成并计费），不替代 `task pause`（那是单 Task 的协作停止）。

**部分失败不会被粉饰**：只要有一个目标的身份读不出来、平台不支持、或复读没有证实它停止，
全局状态就是 `RECOVERY_REQUIRED` 且**屏障保持**，命令退 `1` 并给出稳定码
（`GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE` / `GLOBAL_PAUSE_TARGET_NOT_STOPPED` / `GLOBAL_PAUSE_UNSUPPORTED` /
`GLOBAL_RESUME_TARGET_CHANGED` / `GLOBAL_PAUSE_RECOVERY_REQUIRED`）。用 `scheduler control status` 看**逐目标**事实。

**跨重启保持**：暂停状态持久化；`runtime stop` 不清除它，重启后仍是暂停态，直到你显式 `resume`。
启动时 Runtime **不自动** `SIGCONT`、也**不自动 kill** 上一代 boot 冻结的进程——它只把事实报出来。

**暂停期间还能做什么**：所有只读查询、事件订阅、容量/控制状态查询、记录用户输入、`task cancel/recover/purge`、
`runtime stop`，以及不调用模型的 Git/验证操作。**延后**的是新启动与 answer/guidance 的实际投递
（正文可以先耐久记录，恢复后按既有有效性与幂等规则投递）。

`reconcile` 只**观察**：不发任何信号，可以把「已证明退出」的目标收口，但**不会**把不可核验的目标猜成已停止，
也**不会**把 `RECOVERY_REQUIRED` 写成 `PAUSED`。

> **当前实现的可冻结范围**：只有 **Pi** 的 `providerProcessSuspension` 是 `SUPPORTED`（真实进程实测）。
> Codex 与 Claude Code 仍是 `REQUIRES_VALIDATION`，因此它们的会话会让本次 epoch 进入 `RECOVERY_REQUIRED`
> 并保持屏障——这是诚实结果，不是「已经冻住了」。详情见
> [ADR-0061](../decisions/0061-runtime-global-load-control.md) 与 `docs/spikes/*.md` 的「Provider 进程冻结」一节。


### 想深入看哪篇

- 完整流程中的依赖与调度：[workflow.md](./workflow.md) §3
- `SAFE`/`UNKNOWN`/`CONFLICTING` 的准确含义：[concepts.md](./concepts.md)
- `task depends` / `task schedule` / `scheduler`：[cli/integration-dag-scheduler.md](./cli/integration-dag-scheduler.md)（§12–§14）
- 「两件事互相冲突怎么办」：[recipes.md](./recipes.md)

---

## 11. 设置与权限：FULL 与 STRICT

**先看全**：这条命令列出本 Runtime 的**全部三项启用设置**，逐项给出生效值、产品默认、
取值、是「本 home 显式设置」还是「产品默认」，以及值存在哪个文件：

```sh
bun run codeestra settings list            # 人读列表
bun run codeestra settings list --json     # 逐字段原文（每个条目还带「改它会影响什么」）
```

数据来自 Runtime 自己：每一项都由**它自己那条命令的同一次读取**填充，所以总览不会与
`settings permission get`、`settings prose-question-attention`、`scheduler capacity get` 读出的值不一致。它是**只读**的：不写文件、不改任何值、零确认。

### 11.1 权限模式

```sh
bun run codeestra settings permission get
bun run codeestra settings permission set strict
bun run codeestra settings permission set full      # 切回默认
```

| | `FULL`（默认） | `STRICT`（显式 opt-in） |
|---|---|---|
| 项目接入 | 不确认 | 需输入 `TRUST`（脚本 `--yes`） |
| Agent 工具调用 | 自动允许 | gate 逐次审批（Attention） |
| 成果 commit | `task result capture` 单步 | `prepare` → `commit … --confirm` 两步；保留敏感路径拒绝 |
| 验证策略变化 | 不确认 | 需确认 |
| 本仓库自身的 `dev → main` 人工四步 | 无需批准 | 保留人工确认（`AGENTS.md`；产品无此能力） |

**不变的**：revision/ref/归属/进程身份核对、静止证据、幂等与崩溃恢复**始终有效**。那些是正确性核对，
不是权限审批，不会被 FULL 关掉，也不会被包装成审批。

当前模式只通过 CLI/Runtime 命令面查看与切换。

### 11.2 Web UI 设置已暂停

ADR-0067 起 `settings ui list|get|set|reset` 已删除，也不再出现在 `settings list`。已有 `ui-settings.json` 保留但当前 Runtime 忽略。

### 11.2.1 并发上限也是一项可实时调整的设置

`settings concurrency` 是**整个 Runtime 的并发上限**（默认 2，范围 1–16）在设置面上的拼写：

```sh
bun run codeestra settings concurrency get   [--json]
bun run codeestra settings concurrency set   --limit <n> [--json]
bun run codeestra settings concurrency reset [--json]
```

它与调度面的 `scheduler capacity get|set|reset` 是**同一事实**（同一行、同一条 `SchedulerGlobalCapacityChanged` 事件），
因此两边读出的值不会不一致。改完**立刻生效**：提高上限会让正在等待容量的任务在下一次调度里就有机会启动；
降低上限**不会**暂停、释放或终止已经在跑的 Task（`get` 的 `used` 因此可能大于 `limit`）。
它是**设置、不是门禁**：零确认，FULL/STRICT 行为相同。

### 11.2.2 自动回收 worktree（已删除）

ADR-0064 把 `settings auto-reclaim` 连同集成一起删除：**没有自动回收路径**，回收只有显式
`reclaim plan/apply/records`（见 §12.3）。ADR-0062 的 `<CODEESTRA_HOME>/auto-reclaim.json` 也不再被读取。

### 11.3 Agent 配置

```sh
bun run codeestra agent config get   [--project <project-id>] [--adapter <id>]
bun run codeestra agent config set   [--project <project-id>] [--adapter <id>] \
  [--provider <name>] [--model <id>] [--thinking <off|minimal|low|medium|high|xhigh|max>] [--unset provider|model|thinking]
bun run codeestra agent config clear [--project <project-id>] [--adapter <id>]
bun run codeestra agent plugins list   [--project <project-id>] [--adapter <id>] [--json]
bun run codeestra agent plugins select [--project <project-id>] [--adapter <id>] [--extension <path>]… [--clear]
```

- 解析顺序（逐字段）：**环境变量 > 项目覆盖 > 全局默认 > 适配器默认**。
- 配置**只影响此后新建的 Session**，并把当时生效的值记录在 Execution 上（`task status` 同样能看到）。
- 环境变量那一层只属于**当前 Runtime 进程**，改它要重启 Runtime，并且会盖住这里保存的值。

> 图：`10-agent-settings.png` — 「Agent 设置」标签页：adapter 与作用域下拉框、当前生效值表（字段/值/来源）、
> 插件候选勾选列表、编辑并保存区与三个按钮（保存 / 清除选择 / 清除该范围的模型配置）。

### 想深入看哪篇

- FULL/STRICT 的完整差异与理由：[concepts.md](./concepts.md)、[ADR-0011](../decisions/0011-default-full-permission-mode.md)
- 设置键的详细语义：[ADR-0045](../decisions/0045-global-ui-settings.md)
- `permission` / `settings` / `agent` 命令：[cli/runtime.md](./cli/runtime.md)

---

## 12. 数据在哪、怎么备份与回收

### 12.1 数据分布

| 位置 | 内容 | 是否进 Git |
|---|---|---|
| `$CODEESTRA_HOME/runtime.sqlite` | 领域数据库（Task / revision / Execution / Session / Attention / 验证 / 预留 / 账本等），当前 schema **v35** | 否 |
| `$CODEESTRA_HOME/runtime.sock` | Runtime 的 Unix socket（`0600`） | 否 |
| `$CODEESTRA_HOME/*.json` 等 | 生命周期记录、锁、`ui-settings.json`、`prose-question-attention.json` | 否 |
| `$CODEESTRA_HOME/worktrees/<project-id>/<task-id>/` | Task 独占的工作树 | **否**（Task 成果在内部 `refs/heads/task/<task-id>`） |
| `$CODEESTRA_HOME/verifications/...` | 验证用的 detached 副本 | 否 |
| `$CODEESTRA_HOME/knowledge/<project-id>/generated/` | 机器生成的知识层 | 否 |
| 项目仓库 `.codeestra/instructions/`、`.codeestra/skills/` | 人工维护的知识层（只从 `main` ref 读） | **是** |
| 项目仓库 `.codeestra/policies/verification.json` | 人工维护的验证策略（只从 `main` ref 读） | **是** |
| 项目仓库 `.codeestra/impact.json` | 人工维护的影响映射（只从 `main` ref 读） | **是** |
| 项目仓库 `.codeestra/tests.json` | 分支自己的定向测试计划 | **是** |

数据库就是 `CODEESTRA_HOME/runtime.sqlite`（当前 schema **v28**）。

### 12.2 备份

最直接的方式是**停掉 Runtime 然后整目录复制**：

```sh
bun run codeestra stop
cp -a "$CODEESTRA_HOME" "$CODEESTRA_HOME.backup-$(date +%Y%m%d)"
bun run codeestra status
```

也可以在 Runtime 运行时复制（SQLite 与 JSON 都是一致写的），但**停掉再复制**是最不需要解释的做法。
要恢复就 `stop` → 换回那份目录 → `status`。

项目仓库里的 `.codeestra/**` 跟随你平时的 Git 备份走，不需要单独处理。

### 12.3 回收磁盘

```sh
# 只读试运行：返回与 apply 完全一样的决策形状
bun run codeestra reclaim plan --project $PROJECT \
  [--task <task-id>] [--kind TASK_WORKTREE|VERIFICATION_COPY|INTEGRATION_WORKTREE]… \
  [--include-failure-scenes] [--unregistered] [--scan-root <path-inside-home>] \
  [--remove-unregistered <path>]… [--json]

# 真正执行（同样的参数）
bun run codeestra reclaim apply --project $PROJECT […]

# 审计记录
bun run codeestra reclaim records --project $PROJECT [--task <task-id>] \
  [--source ALL|REGISTERED|UNREGISTERED_DIRECTORY] [--since <epoch-ms|ISO>] [--until <epoch-ms|ISO>]
```

**这是唯一具有破坏性的命令面**，务必注意：

- 每个被考虑的资源都有动作：`RECLAIM / RETAIN / REFUSE / ALREADY_ABSENT / RECOVERY_REQUIRED`，并带归属证据。
- **失败现场默认保留**：没有 `--include-failure-scenes` 时，未提交改动、失败/取消的验证是 `RETAIN`。
- **未注册目录不会被删**，除非用 `--remove-unregistered <精确路径>` 指名。
- 不带 `--project`（或加 `--all-projects`）覆盖**所有**已信任项目，结果按项目分组。
- 退出码：`FAILED` → `1`；可回收数量为 0（plan）或实际回收数量为 0（apply）→ `3`（「没什么可回收」不是错误）；
  否则 `0`。
- 被回收的 Task 工作树之后可以用 `task retry` 从保留的 Task 分支**重建**。
- **没有自动回收路径**（ADR-0066）：ADR-0062 的「集成成功后自动回收」随集成一起删除；要么显式
  `reclaim apply`，要么让 worktree 留着。

### 想深入看哪篇

- 回收的完整语义与全部拒绝码：[workflow.md](./workflow.md) §9、[troubleshooting.md](./troubleshooting.md)
- `reclaim` 每条命令：[cli/integration-dag-scheduler.md](./cli/integration-dag-scheduler.md)（§16）
- 「保住失败现场」「回收磁盘」：[recipes.md](./recipes.md)

---

## 13. 出问题怎么办

### 13.1 先做的三件事

```sh
bun run codeestra status                             # Runtime 是否可用、权限模式、ownership 结论
bun run codeestra events tail                        # 事实流：事件比文案更接近真相
bun run codeestra task status <task-id>     # 执行 / 验证 / 会话注记
```

### 13.2 记住退出码的三分法

| 码 | 含义 |
|---|---|
| `0` | 成功。**注意**：某些命令的成功是「已受理」而不是「已完成」 |
| `1` | 拒绝或失败（含 `RECOVERY_REQUIRED` 这类需要人处理的状态） |
| `2` | **用法错误**：未知命令、缺少子命令、参数个数/取值不合法、未知 flag、缺少必填 flag。stderr 只有**一行**，并提示对应层的 `help`（ADR-0068） |
| `3` | **等待**（冲突/容量等待、draining）或**没什么可做**（reclaim 没有可回收项） |

**不知道某一层有哪些命令，就问那一层**：`codeestra help`、`codeestra task help`、`codeestra task revision help`
（`codeestra task revision --help` 等价）。这份清单由命令树生成，不会与实际命令不一致，也不需要 Runtime（ADR-0068）。

**`3` 从不表示 `BLOCKED`**——`BLOCKED` 只表示依赖未满足，属于「需要处理」而不是「等一等」。
看到一个 `1` 时，**先读错误码，不要读文案**：文案可能会变，码不会。

### 13.3 Web UI 命令不可用

| 症状 | 处理 |
|---|---|
| `ui` / `open` 返回用法错误 | Web UI 已按 ADR-0067 暂停；改用 `project trust` 与其它 CLI 命令 |
| 命令打到了「另一个」Runtime | 检查 `CODEESTRA_HOME`；一个 home 只跑一个 Runtime |
| 想知道 CLI 到底有哪些命令 | `codeestra help`（或任意层的 `<命令路径> help`）；`codeestra runtime commands` 列出 Runtime 侧接受的每一条 versioned 命令 |

### 13.4 任务一直不跑

它可能是**等待**（退出码 3），不是失败。三种互不相同的答案见 §10.3。
看谁占着：`scheduler capacity get`（**整个 Runtime** 的占用者，带 project/task/adapter）与 `scheduler reservations list $PROJECT`。
**没有任何东西会自动释放**，释放必须显式并给出原因。并发上限是唯一的 Runtime 全局值：想让更多任务同时跑就 `scheduler capacity set --limit <n>`，
而不是靠多开一个项目。

### 13.5 看到 `RECOVERY_REQUIRED`

这是**多个实体都有的状态**，含义是「有事实无法被证明，需要一次带审计的对账」，
**不是**让你重试掩盖它。先看 `task status` 与 `events tail`。

Task/Execution 的 `RECOVERY_REQUIRED` 用 **`task recover <project-id> <task-id> <expected-version>`**（ADR-0055）：
只读事实（记录的 provider 身份按真实进程表核对、后代快照、workspace 是否还在磁盘），
只有能证明 provider 已消失才收口为 `FAILED`（workspace 保留、不发信号、不声称静止），
否则拒绝并保持占用（退出码 `1`，码为 `RECOVERY_PROVIDER_ALIVE` / `RECOVERY_DESCENDANTS_ALIVE` /
`RECOVERY_OWNERSHIP_UNVERIFIABLE` / `RECOVERY_PROCESS_IDENTITY_MISSING`）。收口后 `task retry` 可重排、
`task cancel` 可作废。**只想清理这个出错任务时不必先手动 `task recover`**：`task purge --yes` 会自己做同一次
观察对账，只有能证明 provider 已退出才删除（否则 `RECONCILE_REQUIRED`）；确实要强行清掉就加 `--force`——
它会先按记录的身份终止 provider，再删除（结果里 `stop.stop: "FORCED"`，`forced` 列出被跳过的拒绝与终止结果）。

### 13.6 完整的错误码表在哪

**本文不复制错误码表。** 稳定码、每条的触发条件与处理方式都在
[troubleshooting.md](./troubleshooting.md) 的 §1（按症状）与 §2（按领域速查表）里；
每条命令的参数、退出码与码位在 [cli/README.md](./cli/README.md) 索引下的十篇里（含 §23 受管 integration）。

### 想深入看哪篇

- 常见故障与稳定码表：[troubleshooting.md](./troubleshooting.md)
- 每条命令的退出码：[cli/README.md](./cli/README.md)（§0.2）
- 「我想做 X」：[recipes.md](./recipes.md)

---

## 14. 术语表

按你在本书里遇到的顺序排列。**粗体**是必须记清的那几个。

| 词 | 一句话定义 |
|---|---|
| **Runtime** | 独立本地服务，Codeestra 的软件本体。每用户单实例，一个 `CODEESTRA_HOME` 一个 Runtime，通过 Unix socket 通信 |
| **CLI** | 完备命令面。每个能力都能只靠它完成并脚本化驱动（`--json`、稳定退出码） |
| **Web UI（暂停）** | ADR-0067 起没有可用入口；实现源码静态保留，不属于当前产品面 |
| **Project** | 一个已接入（trust）的 Git 仓库。按 **Git common dir** 识别，所以同一仓库的多份工作树是同一个 Project |
| **Task** | **业务主实体**：一次有边界的开发工作。持有两个 Task 级标题（显示标题、命名标题）、任务详情（不可覆盖的 revision 历史）、依赖、执行历史、验证与集成状态 |
> **本次修订（ADR-0066 / schema v36）**：删除 dev clone、长期 `dev` 集成分支、`task integrate` / `task integration *` / `promotion *` 与 dev 构建通道；Task 基线只有一种（项目文件夹建 workspace 时当前检出的分支），
> 成果停在 `refs/heads/task/<task-id>`，合并由你自己完成。
| **TaskRevision** | Task 规格的快照，append-only。第一次创建 Task 就产生第一条 |
| **Revision Delivery** | 「修订是否真的到达了运行中的 Execution」的独立可观察过程。`revisionAcknowledgement` 不支持的 Adapter 会**如实保持未确认** |
| **Execution** | **一次执行尝试**，恰好绑定**一个**主 Agent。换 Agent 要新建 Execution |
| **Session** | 有身份、有生命周期、有恢复信息的运行实体，不是「一次 shell 命令」 |
| **Incarnation** | 同一 conversation 的进程代号。**不是同一个进程**，任意时刻最多一个 Provider writer |
| **Attention** | 一条需要人回答的请求。`kind` = `PERMISSION` / `QUESTION` / `RECOVERY` |
| **散文提问等待** | Agent 没用工具、在正文里提问并结束轮次，被记成 `PROSE_QUESTION_NO_TOOL_USE`。**provider 已退出**，用 `attention resolve` 结束 |
| **result commit（成果 commit）** | Agent 的改动被固定成的一个 commit，落在内部 `refs/heads/task/<task-id>` |
| **Task verification** | 判定**一个 Task 的成果 commit**。命令来自 `main` ref 上人工维护的策略，在固定 commit 的 detached 副本里跑 |
| **Promotion** | `dev → main` 的正式记录。固定「已验证的 dev commit + 预期旧 main commit + 证据」三元组 |
| **dev 全量测试证据** | 对**精确 dev 候选 SHA** 在 detached 副本里运行项目固定策略的结果，由 Runtime 运行并观察。客户端不能自报 |
| **ImpactSnapshot** | 一次影响分析的 append-only 记录：changed 路径集合、命中的目录/模块/全局资源、是否完整 |
| **Conflict assessment** | `SAFE_TO_PARALLELIZE`（默认）/ `UNKNOWN`（当前规则不产生）/ `CONFLICTING`。**只有「双方声明同一功能且对方未完成」是冲突** |
| **Slot reservation（槽位预留）** | 一次执行权的正式记录。归属证据 = Runtime boot + pid + OS start token。释放必须显式且有原因 |
| **Capacity** | 两个上限：项目全局与每 adapter。它是**配置**不是测量 |
| **Operation（长命令）** | `task.run` / `task.verify` 这类长命令的持久句柄，带步骤级进度，可查、可取消 |
| **Handoff / writer lease** | 原生终端接管的编排：attach / detach / release、单一 writer、安全点与准入决策 |
| **Reclaim** | Runtime 数据目录下工作树与验证副本的回收。**唯一具有破坏性的命令面**（账本里仍可能读到历史的 `INTEGRATION_WORKTREE` 取值） |
| **Project Knowledge** | 分层知识：人工层（`.codeestra/instructions`、`.codeestra/skills`，只从 `main` ref 读）+ 机器生成层（Runtime 数据目录） |
| **FULL / STRICT** | 权限模式。FULL 零确认（默认），STRICT 恢复旧门禁。两者都用同一个 CLI 无确认切换 |

### 想深入看哪篇

- 概念与边界的完整说明（含「哪些不是调度主实体」）：[concepts.md](./concepts.md)
- 领域模型与状态机：[../architecture/domain-model.md](../architecture/domain-model.md)、
  [../architecture/state-machines.md](../architecture/state-machines.md)

---

## 相关文档

- [docs/guides/README.md](./README.md)：本目录的分流索引（不确定从哪读就先看它）
- [getting-started.md](./getting-started.md)：装与第一次运行
- [concepts.md](./concepts.md)：领域概念与硬边界
- [workflow.md](./workflow.md)：端到端流程走查（含可照抄命令）
- [features.md](./features.md)：功能清单（一行一个能力）
- [ui.md](./ui.md)：Web UI 暂停状态与未来恢复条件
- [cli/](./cli/README.md)：CLI 命令参考（十篇，含 §23 受管 integration）
- [recipes.md](./recipes.md)：常见任务的做法
- [acceptance-checklist.md](./acceptance-checklist.md)：人工观感核对清单
- [troubleshooting.md](./troubleshooting.md)：常见故障与稳定码表
- [images/README.md](./images/README.md)：插图清单（图由用户提供）

仓库级文档：[PROJECT_SPEC.md](../../PROJECT_SPEC.md)（长期规格）、[AGENTS.md](../../AGENTS.md)（协作规则）、
[../decisions/README.md](../decisions/README.md)（ADR 索引）、[../tasks/README.md](../tasks/README.md)（当前任务与进度）。
