# Codeestra 用户说明书

> **适用版本** `dev@de03448` + 本格分支 `Loyage/glc-pause-ui`（2026-09-16） · **schema** v34（本格暂停半边） · **最后校对** 2026-09-16
> 版本会前进：`dev@4667d32` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> §10.5 的「全局暂停」由 FOUNDATION-097 新增（ADR-0061 D04–D10）；§「任务」的永久删除一条由 FOUNDATION-090 新增（ADR-0058）；§3.1、§4.2、§4.3、§4.5、§10.1、§10.3 与
> 「名词表」的冲突判定由 FOUNDATION-091 按 ADR-0059 改写（声明同一功能才冲突，默认不冲突）。
> §3.1、§3.2、§10.2 由 FOUNDATION-093 第三轮同步（ADR-0060 修订：managed 项目的常态路径不变）；其余内容沿用 FOUNDATION-091 的校对基线。

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
8. [合入 dev](#8-合入-dev)
9. [发布到 main](#9-发布到-main)
10. [日常使用：并行、依赖、调度、容量、全局暂停](#10-日常使用并行依赖调度容量)
11. [设置与权限：FULL 与 STRICT](#11-设置与权限full-与-strict)
12. [数据在哪、怎么备份与回收](#12-数据在哪怎么备份与回收)
13. [出问题怎么办](#13-出问题怎么办)
14. [术语表](#14-术语表)

---

## 1. 这是什么

Codeestra 是 **Task-first、local-first 的 AI Development Runtime**：**你管理产品意图，Codeestra 管理软件工程**
（分支、工作树、执行、验证、集成、提升）。

它不是聊天助手，也不是多 Agent UI。你描述「要完成的一项改动」，Codeestra 负责：给它一个独立的工作目录与
分支、让一个 Coding Agent 去干、把成果固定成一个 commit、独立验证、合入开发分支，最后在你要发布时提升到
稳定分支并重启服务。

### 三条必须先知道的第一原则

1. **效率至上。** Runtime 默认运行在 `FULL` 主机级全权限模式。**项目接入、Agent 工具、成果 commit、
   验证策略变化，默认零确认、零等待。** 你随时可以用 CLI 无确认地切到 `STRICT`，恢复旧门禁
   （`bun run codeestra permission set strict`）。
   正确性核对（revision/ref/归属/进程身份、静止证据、幂等与崩溃恢复）**一直有效**，但那些是核对，不是审批。
2. **软件本体是服务，CLI 必须完备。** 独立本地 Runtime 是软件本体，Web UI 只是它的便利前端。
   每个能力都能只靠 CLI 完成并脚本化驱动（`--json`、稳定退出码）。「只有 UI 能做、CLI 不能做」视为缺陷。
3. **测试只走 CLI / 命令面。** 自动化验收不依赖桌面、键鼠或浏览器自动化；UI 观感由你在场目视确认
   （见 [acceptance-checklist.md](./acceptance-checklist.md)）。

### 一条贯穿全书的边界

Codeestra 的每一步都**只报事实，不报乐观猜测**。所以你会反复看到这几句话：

- **Task 显示「执行中」不等于 provider 此刻在跑。** 状态是 Runtime 记录的状态，不是进程心跳。
- **「已受理」不是「已完成」。** `task verify --background` 退 0 只表示验证**开始了**。
- **「已验证」不是「已集成」。** Task 验证通过不释放依赖，也不代表进了 `dev`。
- **「已合入 dev」不是「已发布」。** `dev` 与 `main` 是两条不同的线。
- **「main 已更新」不是「Runtime 已重启完成」。** 重启只有在每步退 0 且 Runtime 回答 `READY` 时才被记录。
- **提交不等于要等。** 没有声明功能的 Task `task submit` 后会在**容量允许时立即开始**（ADR-0059）；
  想让两个 Task 互斥，就给它们声明**同一个功能**（`task create --feature <module-id>`）。

> 图：`00-overview.png` — Codeestra 的总流水线：用户意图 → Task → 依赖/冲突判定 → 调度 → 独立工作树 →
> Coding Agent → Task 验证 → 合入 dev → 集成验证 → 稳定提升 → 重启 Runtime。

### 想深入看哪篇

- 名词的准确定义与硬边界：[concepts.md](./concepts.md)
- 「这软件到底有哪些功能」：[features.md](./features.md)
- 三条第一原则的规格原文：[PROJECT_SPEC.md](../../PROJECT_SPEC.md) §1.1

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

要用 Web UI 还要**构建前端资产**（`apps/ui/dist` 是 gitignore 的本地状态，**每个工作树各自构建**）：

```sh
bun run build:ui
```

> 没构建就去请求界面，Runtime 会以稳定码 `UI_ASSETS_MISSING` 拒绝，并告诉你跑上面这条命令。

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
| `uiRunning` | 是否已经在提供 Web UI |
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

安全属性：`CODEESTRA_HOME` 目录 `0700`、socket `0600`；HTTP 界面只绑定 `127.0.0.1`，并且每个 Runtime 进程
启动时生成一次性**内存 token**。

> **最容易踩的一条**：CLI 只按 `CODEESTRA_HOME` 找 socket。若某个 Runtime 已经在跑，你在别的工作树执行
> `bun run codeestra …` 会打到**那个** Runtime（即那份代码），**不会**启动你当前工作树的构建。
> 要验证另一份代码，就换 `CODEESTRA_HOME`。

### 2.4 打开 Web UI

```sh
bun run codeestra ui            # 启动 HTTP/SSE 并按需打开浏览器
bun run codeestra ui --no-open  # 只打印地址
```

地址形如 `http://127.0.0.1:<port>/#token=<32字节hex>`。token 放在 **fragment** 里——fragment 不会发给服务器，
所以它不会进入任何服务端日志；浏览器把它存进 sessionStorage。

- **Runtime 重启会更换内存 token**：旧的带 token 链接会立刻失效，重新执行 `codeestra ui` 即可。
- **关掉页面不会停止 Runtime 或任何 Task。** 页面顶部会写明这一点。

### 2.5 两个 clone 与 dev 通道标记（本机构造）

本机把 `main` 与 `dev` 放在**两个分别 clone 的独立仓库**里，各自有 `.git` 目录与 `origin`，不是彼此的 worktree。这个拆分的**唯一理由是 Codeestra 自己要被开发（自进化）**：开发中的代码要能真的跑，而稳定实例不被它干扰。用 Codeestra 开发别的项目不涉及（也不该建立）这种 main/dev 目录拆分。

| 目录 | 检出 | 用途 |
|---|---|---|
| `~/Documents/codeestra` | `main` | **稳定 clone**：只用于运行稳定实例、拉取已批准的提升 |
| `~/Documents/codeestra-dev` | `dev` | **开发 clone**：Codeestra 自身的所有开发、集成与定向验证都在这里 |

两个 clone 的 `node_modules`、`apps/ui/dist`、Runtime 数据目录**都是各自的本地状态，不共享**：
各自需要 `bun install --frozen-lockfile`，UI 资产各自构建。

在 dev clone 里用**独立 home** 运行 dev 代码，稳定 Runtime 不受影响：

```sh
cd ~/Documents/codeestra-dev
bun run build:ui:dev                                   # 等价：VITE_CODEESTRA_CHANNEL=dev bun run build:ui
CODEESTRA_HOME=~/.local/state/codeestra-dev bun run codeestra status
CODEESTRA_HOME=~/.local/state/codeestra-dev bun run codeestra ui --no-open
```

上面四步的等价入口是 `just restart-dev`（在 dev clone 里跑）：它按顺序执行 install → dev 通道构建 UI →
`stop` → `status` → `ui --no-open`，并在构建后核对 `index.html` 真的带 dev 标记，不带就停止。

**dev 界面的通道标记来自构建期变量**：只有构建时设了 `VITE_CODEESTRA_CHANNEL=dev`（即用
`bun run build:ui:dev`），界面才会带橙色的「Codeestra DEV」横幅与 `Codeestra DEV` 品牌名。
**不加这个变量就没有标记**——在 dev clone 里跑 `bun run build:ui` 得到的是一个**没有标记**的界面，
此时不要把该界面当稳定版或 dev 版汇报。

> 图：`14-dev-banner.png` — dev 构建的顶部横幅：「开发版 DEV / 非稳定代码：这是 dev clone 的运行结果，
> 不要当作稳定版」。强调色为橙色。

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
- 每条命令的参数与退出码：[cli-reference.md](./cli-reference.md) §1
- 两个 clone 与 dev 实例的完整布置：[docs/tasks/README.md](../tasks/README.md) FOUNDATION-076

---

## 3. 第一个项目

「接入项目」= 把一个 Git 仓库注册给 Runtime 并信任它。

### 3.1 先看清 Runtime 读到了什么

```sh
bun run codeestra project inspect /path/to/repo --dev-repo /path/to/dev-clone
```

关键是这几项：`repoRoot`（工作树根）、`mainRef` / `objectFormat`（主分支 ref 与对象格式）、`headCommit`、
`devRef` / `devCommit`（**dev clone 上的** `dev` 分支是否存在及 commit），以及 `devRepoPath`（那个 dev clone 的核验结果）。

**Codeestra 要求项目长期保留 `main` 与 `dev` 两个分支**，并且所有功能 Task 从固定的 `dev` commit 建基线。
`main` 分支与判定策略由你的**主检出**提供；`dev` 分支（以及所有 Task 的 worktree、集成、提升候选）由第二个 clone
提供 —— 这就是下面的 **dev clone**。

### 3.1.1 准备一个 dev clone

dev clone 是**同一 origin 的另一个独立 clone**，并且它检出 `dev`：

```sh
git clone <你的 origin URL> /path/to/dev-clone
git -C /path/to/dev-clone checkout dev
```

要求（`project trust` 逐条核验，任一不成立就用稳定码拒绝）：是一个 Git work tree；**不是**主检出、也不是主检出的
worktree（Git common dir 不同）；`origin` 与主检出一致；HEAD 在项目的 `dev` 分支上，且该分支在本地存在。

它是**长期 `dev` 分支的全部事实来源**：集成 worktree 与 ref 推进、提升候选对象、全量证据的副本与锁文件。
ADR-0060（第三轮修订）之后，需要它的**只剩**集成与提升两条命令面（`task integrate`、`promotion *`、
`promotion full-suite run`），它们会以 `DEV_REPO_REQUIRED` 拒绝并直接给出补救命令；Task 基线、依赖判定、
槽位、调度启动前重检、结果 commit 归属、任务级验证与回收对**没有 dev clone 的项目**同样成立
（基线取项目文件夹当前检出的分支，归属取项目文件夹）。

再看**谁将来判定你的成果**：

```sh
bun run codeestra project policy /path/to/repo
```

它读取**项目 `main` ref 上**的 `.codeestra/policies/verification.json` 并打印策略状态与 digest。
这个文件是**人工维护**的：Task 分支改不动判定它自己的命令（这是安全不变量，不是配置细节）。
策略不存在时 `task verify` 会拒绝，直到该 ref 上有这个文件。

最后看**功能声明用的影响映射**：

```sh
bun run codeestra project impact validate /path/to/repo --json
```

它读 `main` ref 上的 `.codeestra/impact.json`。这张映射现在只被两件事用到：`--feature` 的写入校验（功能 id 必须是它的 `modules[].id`）和影响快照的证据。**没有映射不再让判定变成 `UNKNOWN`**：没有声明同一个功能就是 `SAFE`，提交后就会开始。退出码 `0` 仅当映射存在**且**是已确认的那一份。

### 3.2 接入（trust）

```sh
# FULL（默认）：零确认
bun run codeestra project trust /path/to/repo --dev-repo /path/to/dev-clone

# STRICT：需要确认，交互输入 TRUST，或脚本传 --yes
bun run codeestra permission set strict
bun run codeestra project trust /path/to/repo --dev-repo /path/to/dev-clone --yes
```

`--dev-repo` 是**可选**的（ADR-0060）。给了它，项目就有长期 `dev` 基线（集成目标、提升候选、提升前全量证据）；
省略它则 Task 基线取**项目文件夹当前检出的分支**，成果留在 task 分支由你自己合。没有 dev clone 的项目照常
`task submit` / `task run` / `task result capture` / `task verify`、`task depends list` 也按它自己的基线判定，
只有 `task integrate` / `promotion prepare` 会在需要长期 `dev` 分支时以 `DEV_REPO_REQUIRED` 拒绝（拒绝的是那条分支，
不是新的审批）。`--dev-repo none` 明确表示「这个项目没有 dev clone」。**Codeestra 自身自进化时仍用 dev clone**
（见 ADR-0048 的本机布局）。

若给了 dev clone，它会被逐项核验（另一个 clone、同 origin、HEAD 在 `dev` 上、该分支存在），不成立就以 `DEV_REPO_*` 拒绝，
不写入任何东西。
而且**什么都还没写**：项目不会被登记，补救命令就在错误消息里。

**dev clone 会被推进**：集成成功时 Runtime 用 Git 自己的快进（`git merge --ff-only`）把 dev clone 里的 `refs/heads/dev`
**和它自己的工作树**一起前移，因此那个 clone 的工作区会落到新提交上。集成前会先核验它干净、在 `dev` 上、且就在
批次固定的基线上；不成立就以 `DEV_CHECKOUT_NOT_ON_DEV` / `DEV_CHECKOUT_DIRTY` / `DEV_CHECKOUT_MOVED` 拒绝，
不合并、不推进。所以**不要在 dev clone 里留未提交/未跟踪的改动**（它会被拒绝而不是被覆盖），也**不要**在集成
进行中手工切它的分支。

**影响**：一旦 trust，Agent 工具、验证命令与 Git hooks 会**以你的用户权限**运行。
STRICT 下界面会明确写着：这**不**授权 commit、更新 main、push 或使用未知工具。

**防漂移**（重要）：`trust` 会把「你刚看过的身份 + 验证策略 digest + 影响映射 digest」一起提交。
若在你查看与确认之间这些文件动了，Runtime 以 `VERIFICATION_POLICY_CHANGED` 或 `IMPACT_POLICY_CHANGED` 拒绝，
而不是静默按新内容确认。仓库身份变了则以 `REPOSITORY_CHANGED` 拒绝。

同一个仓库可以有多份工作树（稳定 `main` 树与开发树）：Runtime 按 **Git common dir** 识别一个 Project，
所以再打开另一个工作树是幂等的。

### 3.3 一条命令搞定：`open`

日常最快的路径是 `open`，它把 inspect → 策略展示 →（必要时）确认 → 打开界面串起来：

```sh
bun run codeestra open /path/to/repo --dev-repo /path/to/dev-clone              # 接入并打开 Web UI
bun run codeestra open /path/to/repo --dev-repo /path/to/dev-clone --no-open    # 只打印带 token 的地址
bun run codeestra open /path/to/repo --dev-repo /path/to/dev-clone --yes        # STRICT 非交互确认
```

因为这条命令会组合一次 `project trust`，它的 `--dev-repo` 同样**可选**（ADR-0060：留空 = Task 基线取项目文件夹当前检出的分支；
给了就给 dev 基线与提升）。打开一个**已信任**仓库的另一个
工作树时 trust 会被跳过，那条路径不需要该 flag。

`open` 会明确打印 `dev baseline`（**来自 dev clone**）、验证策略命令清单、影响映射状态、当前检出的
过渡本地 `dev` ref 状态，以及**是否需要再次确认**。

### 3.4 过渡的本地 `dev` ref：什么时候可以删

如果你的主检出里还有一个本地 `refs/heads/dev`（分离两个 clone 之前的遗留），要明确：
**Runtime 不再从它读任何东西**。所有 dev 事实都来自 dev clone（§3.1.1），Task 基线、集成与提升候选都不看它。

想知道它现在还有没有用，只读地问一次：

```sh
bun run codeestra project inspect /path/to/main-checkout --dev-repo /path/to/dev-clone
```

输出里的 `devRefRetirement` 就是答案：

| 情况 | 含义 |
|---|---|
| `localDevRefPresent: false` | 那个检出里已经没有这个 ref 了 |
| `projectsWithoutDevRepo` 非空 | 这些已信任项目**还没有** dev clone，那个 ref 是它们仅存的一份 `dev` —— **先给它们 trust 一个 dev clone**，别删 |
| `projectsWithoutDevRepo: []` | 没有任何项目依赖它：可以人工删除（`git -C <检出> branch -D dev`） |

删除**永远是人工动作**：Runtime 不替你删，也不会因为它的状态改变任何判定。CLI 会在
`project inspect` 的 stderr 里把上面的结论写成一句话（含"是否有项目仍需要它"）。

> 图：`02-project-trust.png` — 「项目」标签页的「添加本地项目」：路径输入、检查项目后的仓库身份表、
> 验证策略命令表，以及底部的「添加此项目」（FULL）或「信任此项目 + 输入 TRUST」（STRICT）。

### 想深入看哪篇

- 完整的接入步骤与预期输出：[getting-started.md](./getting-started.md) §4
- Project 的概念与 common dir 识别：[concepts.md](./concepts.md)
- `project *` 每条命令：[cli-reference.md](./cli-reference.md) §3

---

## 4. 第一个任务

### 4.1 创建草稿

```sh
bun run codeestra task create $PROJECT "为 parser 增加一个 CRLF 输入用例" \
  --constraint "不得改动公开 API"
```

- `$PROJECT` 是 `project list` 返回的 Project ID。
- `--constraint <text>` 可以重复；每条约束都是 Agent 必须遵守的具体限制，会作为规格的一部分保存。
- `--kind DEVELOPMENT` 是当前允许的值（默认就是它）。`SELF` 会被拒绝：Runtime 还没有 Self-Evolution 行为。

**创建出来的 Task 是 `DRAFT`**：它**不会**自动启动 Agent。结果里要记住两个值：`taskId` 与 `version`
（乐观版本号，后面每条改状态的命令都要传它）。

界面上对应底部常驻的**新建任务停靠条**：收起时是一行输入（回车即创建），展开后可以写多行规格、加约束。
从任何标签页都能创建；创建成功后界面自动切回任务工作台，让新草稿立刻可见。

> 图：`12-new-task-dock.png` — 停靠条展开状态：多行规格正文、约束列表（＋ 添加约束）、任务类型下拉框、
> 「＋ 创建草稿」与「收起」按钮。

### 4.2 提交为就绪

```sh
bun run codeestra task submit $PROJECT <task-id> <expected-version>
```

`submit` 把 `DRAFT` 变成 `READY`，并在**同一条命令里**核对依赖 + 跑一次调度 pass。
所以提交之后你不需要再推任何东西：**未声明功能的 Task 会在容量允许时就在这条命令里被启动**
（返回的 `schedule.started` 就是它）；只有被依赖、被功能冲突、被容量或 draining 拦住时才停在
`READY`——见下一小节与 §10.1。

版本不符会以版本冲突类错误拒绝，而不是覆盖别人的修改。

### 4.3 启动 Agent

```sh
bun run codeestra task run $PROJECT <task-id> <expected-version> \
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

Runtime **自己会调度**：一次相关事件（提交、合入 dev、停止、revision 投递、槽位释放、容量变化）触发一次 pass，
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
| `EXECUTED` 成果已提交 | 有成果 commit，等待验证与合入；**尚非发布** |
| `SUCCEEDED` 已合入 dev | 已完成**任务集成**；**不等于 main 已发布** |
| `FAILED` / `RECOVERY_REQUIRED` | 失败 / 需要人工对账（**不要靠重试掩盖**） |

其他常用操作：

```sh
bun run codeestra task list $PROJECT [--all]           # 列出任务（--all 含归档）
bun run codeestra task status $PROJECT <task-id>       # 执行/验证/集成投影 + 会话结束注记
bun run codeestra task pause  $PROJECT <task-id> <expected-version>
bun run codeestra task resume $PROJECT <task-id> <expected-version> [--adapter <id>]
bun run codeestra task retry  $PROJECT <task-id> <expected-version> [--adapter <id>]
bun run codeestra task cancel $PROJECT <task-id> <expected-version>
bun run codeestra task archive|unarchive $PROJECT <task-id> <expected-version>
bun run codeestra task purge  $PROJECT <task-id> <expected-version> --yes [--reason <text>]
```

- **暂停**是协作停止：确认 provider 进程退出后才进 `PAUSED`，工作树与会话保留。
- **继续**在同一工作树新建一次执行，并**复用已暂停会话的 provider conversation**。
- **重试**只对 `FAILED` 生效，只由这条显式命令触发；重试后仍走同一道调度门禁（会排队，不会插队）。
- **终止**是终态；**归档**只隐藏任务，不删记录、不回收工作树，可随时取消归档。
- **永久删除**（`task purge --yes`）是唯一不可撤销的操作：它删掉任务的全部记录与它自己的 worktree、验证副本、`task/<id>` 分支，
  同时在事件流里留下一条 `TaskPurged`（含每个被删分支的 tip）。三点必须知道：
  1. **成果已进 `dev` 的任务删不掉**（`TASK_INTEGRATED_INTO_DEV`）——否则那个 commit 会失去「谁把它带进来」的记录；这类任务只能归档，`SUCCEEDED` 任务都属于这一类。
  2. **正在跑的任务会先被真地终止**（能确认 provider 退出才继续）；无法确认时什么都不删，先用 `task recover` 对账。
  3. 它会连带删掉**指向该任务的依赖边**（下游会因此重新判定）。

日常清理不再需要的任务：先 `task cancel`（如果需要），再 `task purge --yes`。只想让列表安静下来就用 `task archive`。

> 图：`03-task-workbench.png` — 任务工作台：顶部「项目任务概况」四个计数卡（全部任务 / 执行中 /
> 需要你处理 / 成果已提交）、搜索与筛选行、任务行（状态徽标 + 提示文字 + 「查看详情 →」）。

### 想深入看哪篇

- 完整端到端流程：[workflow.md](./workflow.md)
- 状态机与不变量：[concepts.md](./concepts.md)、[../architecture/state-machines.md](../architecture/state-machines.md)
- `task` 每条命令：[cli-reference.md](./cli-reference.md) §4–§5
- 「我想做 X」的步骤化做法：[recipes.md](./recipes.md)

---

## 5. 看它干活：会话、提问、指导、执行过程、终端

### 5.1 Agent 会停下来问你

Agent 需要你决定时会留下一条 **Attention**（需要人回答的请求）。你**不需要盯着终端**：请求会出现在
CLI 的 `attention list` 与界面的「待处理」标签页里，并且**只暂停对应的那个 Task**，其他合格任务继续跑。

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

- `--choose <题>:<选项>` **可以重复**；题号与选项号都是 **1-based**，与界面显示一致。
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
bun run codeestra task status $PROJECT <task-id>        # stderr 会打印 [waiting] … 与 Agent 的问题原文
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
bun run codeestra task transcript    $PROJECT <task-id> [--execution <id>] [--after <entry-id>] [--limit <n>] [--reverse]
bun run codeestra session transcript <session-id> [--after <entry-id>] [--limit <n>] [--reverse]
bun run codeestra session transcript part <session-id> <entry-id> <part-index>
```

内容来自 **Provider 自己的会话文件**：工具调用与工具返回、助手文本、thinking、token 与成本。

**它的边界要记清**：这是**只读**展示——不写数据库、不改任务状态、**不是 attach、也不是终端接管**。
长内容默认截断，`part` 命令取回整块；`--reverse` 是给人看的渲染选择（与 `--json` 互斥）。

界面上对应「Agent 会话与执行过程」面板：默认折叠为单行时间线，可以展开、可以切换正序/倒序，
运行中的会话由界面自动增量轮询。

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
  改规格、改约束、改验收目标**必须**走 `task amend`（`task revision create`），旧验证仍然因此失效。这两条通道不能互相代替。
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

- 逐屏 UI 走查（每个标签页、每个按钮）：[ui.md](./ui.md)
- Attention、Session、handoff 的概念：[concepts.md](./concepts.md)
- `attention` / `session handoff` / `events` 命令：[cli-reference.md](./cli-reference.md) §7、§17–§18
- 「Agent 停下来问我了」怎么处理：[recipes.md](./recipes.md)

---

## 6. 审阅成果

「成果提交」（result commit）把 Agent 在工作树里的改动固定成一个 commit。

### FULL（默认）：一步

```sh
bun run codeestra task result capture $PROJECT <task-id> [execution-id]
```

### STRICT：两步

```sh
bun run codeestra task result prepare $PROJECT <task-id> [execution-id]   # 拿到 authorizationId
bun run codeestra task result commit  $PROJECT <task-id> <authorization-id> --confirm
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

界面上，「提交成果」按钮只在**可捕获**的状态出现（任务 `RUNNING`、该 Execution 仍在运行、持有资源、
**且它的 Session 已 `EXITED`**）。STRICT 下按钮变成「准备成果提交」，随后出现「成果提交授权」区块，
显示预期 HEAD、变更指纹、是否已静止、工作区路径，并由你按下「确认成果提交」。

> 图：`04-task-detail.png` — 任务详情：「下一步」提示行、任务操作按钮组（提交为就绪 / 启动 Agent /
> 暂停 / 提交成果 / 验证任务 / 合入 dev）、规格正文与约束列表。

### 想深入看哪篇

- 成果 commit 的安全策略与全部拒绝码：[workflow.md](./workflow.md) §5、[troubleshooting.md](./troubleshooting.md)
- `task result` 命令：[cli-reference.md](./cli-reference.md) §8

---

## 7. 任务验证

```sh
bun run codeestra task verify $PROJECT <task-id> [execution-id] [--policy auto|targeted|project] [--background]
bun run codeestra task verification list $PROJECT <task-id>
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
bun run codeestra task operation list   $PROJECT <task-id> [--json]
bun run codeestra task operation get    $PROJECT <operation-id> [--json]
bun run codeestra task operation cancel $PROJECT <task-id> <operation-id> [--json]
```

界面上的「长命令进度」面板只显示**Runtime 记录的事实步骤**，不预估百分比。取消是**协作停止**：
只有在确认进程组静止后才记录终态；无法确认时保留占用并需要人工处理（退出码 1，**不要当成已取消**）。

### 按分支职责分层的测试证据

开发分支（`task/*`、`lane/*`、feature）**在建分支时就**写下一份小的 `.codeestra/tests.json`
（一个 scope 说明 + 1–16 条带 `covers` 的 argv 命令）。它是**显式、可审计的追加**：

```sh
bun run codeestra task tests record  $PROJECT <task-id> [--commit <full-sha>] [--expected-plan-digest <sha256>]
bun run codeestra task tests show    $PROJECT <task-id>
bun run codeestra task tests history $PROJECT <task-id> [--limit <n>]
```

- `task verify` 运行的是**已记录的计划**，**不是文件本身**；所以事后改文件不会悄悄改变判定命令。
- 属于**另一个 revision 或 commit** 的旧计划会被拒绝（`TARGETED_TEST_PLAN_REVISION_MISMATCH` /
  `_COMMIT_MISMATCH` / `_DIGEST_MISMATCH`），**不会**被静默换成项目策略。

### 想深入看哪篇

- 验证的完整语义与策略文件格式：[workflow.md](./workflow.md) §6、[concepts.md](./concepts.md)
- 验证相关的全部拒绝码：[troubleshooting.md](./troubleshooting.md) §1
- `task verify` / `task tests` / `task operation`：[cli-reference.md](./cli-reference.md) §9、§10

---

## 8. 合入 dev

```sh
bun run codeestra task integrate $PROJECT <task-id> <expected-version>
bun run codeestra task integration list $PROJECT [<task-id>]
```

过程固定三步：

1. 在 Runtime 数据目录的 **detached integration worktree** 里合并成果 commit（**能 ff 就 ff，否则 `--no-ff`**）；
2. 跑**独立的集成验证**（它是独立实体、独立记录）；
3. 集成验证 `PASSED` 之后才用 **CAS** 推进 `dev`，并把 Task 推到 `SUCCEEDED`。

**退出码**：只有 `state === "INTEGRATED"` 才是 `0`；`CONFLICTED`/`FAILED`/`STALE`/`CANCELLED` 等已记录的
非集成终态是 `1`；需要人先处理的未收口批次（`RECOVERY_REQUIRED`）是 `3`；用法错误是 `2`。
它们都**不推进 `dev`**。

### 一次合入多个 Task（多成员批次）

两个（或更多）Task 的成果可以先**组成一个批次**，一次集成验证覆盖整批，`PASSED` 才一起进入 `dev`：

```sh
bun run codeestra task integration create $PROJECT \
  --member <task-id>:<expected-version> --member <task-id>:<expected-version>
bun run codeestra task integration integrate $PROJECT <batch-id>
bun run codeestra task integration cancel $PROJECT <batch-id> --reason "<为什么不要了>"
```

- `create` **不碰 Git**：它固定每个成员当前的 revision/成果提交与整批的 `dev` 基线。成员按 task-id 排序，
  与实际命令行顺序无关（同一组成员集合总是产生同一次集成）。
- `integrate` 按该顺序逐个成员合并，然后对最终提交跑**一次**独立验证；`PASSED` 后才推进 `dev` 并把**每个**
  成员 Task 推到 `SUCCEEDED`。
- 组成后但集成前，任一成员的 revision 或 `dev` 基线移动，批次会落 **`STALE`**（不合并、不推进、成员状态如实保留）；
  这时按当前事实重新 `create` 即可（`STALE` 不阻塞新批次）。
- `cancel` 只对一个还没碰过 Git 的批次成立；已经合并或已经排了验证的批次会变成 `RECOVERY_REQUIRED`
  并**继续占用**该成员，等人工按记录处理。取消不需要确认（FULL 与 STRICT 都一样）。
- 一个已组成但未集成的批次会占用它的成员：这些 Task 上的 `task integrate` 会以 `INTEGRATION_IN_PROGRESS` 拒绝，
  直到批次被 `integrate` 或 `cancel`。

**常见拒绝前提**：Task 验证未通过（`TASK_VERIFICATION_NOT_PASSED`）、没有成果 commit（`NO_CAPTURED_RESULT`）、
`dev` 正被某个工作树检出（`DEV_REF_CHECKED_OUT`）、`dev` 分支缺失（`DEV_REF_MISSING`）、已有集成在进行
（`INTEGRATION_IN_PROGRESS`）。

**Task 验证 ≠ 集成验证**：前者判定一个 Task 的成果 commit，后者判定合并后的 dev 提交。两者不能互相替代。

### 在界面上组批、集成与取消

「项目」标签页的 `集成批次 · dev` 面板是同一命令面的前端（不新增语义、不绕过门禁）：

- 上面的批次表与成员表是**只读**投影（列表来自 `task integration list`）；成员按 task-id 排序。
- 「组批（task integration create）」用项目里的任务组一个批次：成员下拉框列出每一个任务（不按状态过滤），
  每个成员旁边写清这次发送的 `expected-version`（CAS），下面是请求字段预览。
- 每个批次的「集成」与「取消」按钮**不按本地状态隐藏或禁用**：能不能做由 Runtime 判断，被拒绝时界面
  逐字显示它返回的稳定码（如 `TASK_NOT_EXECUTED`、`INTEGRATION_IN_PROGRESS`、`CONCURRENT_MODIFICATION`）。
- 「取消」不保证成功：只有记录能证明无副作用（仍 `CREATED`且无 worktree/合并/验证）才会真正 `CANCELLED`；
  否则它变成 `RECOVERY_REQUIRED`（退出码 3）并继续占用成员。界面把这个差别分开写。
- 批级 `INTEGRATED` **不等于**已进 `main`：稳定提升是下一步（见下章）。

界面**不**提供删除批次或重试合并；失败/失效的批次保留现场，按当前事实重新组批。

### 想深入看哪篇

- 集成的完整流程：[workflow.md](./workflow.md) §7
- 集成相关拒绝码：[troubleshooting.md](./troubleshooting.md) §1
- `task integrate` / `task integration`：[cli-reference.md](./cli-reference.md) §11
- 界面上的批次视图与组批/集成/取消：[ui.md](./ui.md) §5.3

---

## 9. 发布到 main

这是全流程里**唯一需要人工介入**的一步，也是**最容易误解**的一步。先把三件事分开：

| 事实 | 它的含义 |
|---|---|
| 任务验证通过 | 这个 Task 的成果 commit 在固定副本上跑过了项目策略 |
| 合入 `dev` | 成果进了开发分支；**不等于发布** |
| 提升到 `main` | 开发分支的内容进入稳定分支，并且稳定服务重启 |

### 9.1 本机构造：`main` 与 `dev` 是两个独立 clone，提升**必须经 GitHub 中转**

本机的 `main` 与 `dev` 是**两个分别 clone 的独立仓库**（各有两个 `.git` 目录与 `origin`，不是彼此的 worktree）。
因此提升不能是本地的 `git merge`：**dev 的代码必须先经 GitHub 上传，再由 main 检出自己拉取。**
唯一提升路径是四步：

```text
① 在 dev clone：把固定候选 push 到 origin/dev，并读回核对 origin/dev == 候选 SHA
② 在 main clone：git fetch origin，然后 git merge --ff-only origin/dev
③ 在 main clone：重启稳定 Runtime（并拉起 Web UI）后核对 status: READY 且 uiRunning: true
④ 核对通过后，才把 main 推回 origin/main
```

硬性约束（写死在 `AGENTS.md`，不是建议）：

- **只 push 固定候选这一个 ref**；**不 `--force`**、不覆盖远端已有提交、不对已检出的 `main` 用 `update-ref`。
- **断网、SSH 认证失败或远端不可达时不推进任何 ref**；也不得把「本地等价」当作提升成功。
- `git merge --ff-only` 不成立（`main` 与候选分叉）就**停止并报告**，不改用 merge commit、reset 或强推。
- **重启核对通过之前不得报告提升完成**；失败时**不擅自回滚**，保留现场并如实报告。
- 提升前必须在**精确的 dev 候选 SHA** 上跑完全量测试；候选、测试配置或锁文件变化即证据失效，必须重跑。

可照抄的操作序列（在 main clone 里）：

```sh
cd ~/Documents/codeestra
git fetch origin
git merge --ff-only origin/dev        # 只在本次是已批准的提升时执行
bun install --frozen-lockfile
bun run build:ui
bun run codeestra stop
bun run codeestra status              # 拉起 Runtime
bun run codeestra ui --no-open        # 再拉起 Web UI 服务器（不自动开浏览器），并打印带 token 的链接
bun run codeestra status              # 必须看到 status: "READY" 且 uiRunning: true
git push origin main                  # 提升收尾：把已拉取并验证过的 main 推回
```

**为什么第 ③ 步要多一条 `codeestra ui --no-open`**：`stop` / `status` 不会把 Web UI 服务器带回来
（ADR-0007：UI 是按需客户端），实测重启后 `uiRunning` 为 `false`。而恢复判据要求 `uiRunning: true`，
所以必须显式拉起，否则这一步永远无法通过。

上面第 ②–④ 步的等价入口是 `just promote-main <候选SHA>`（在 dev clone 里跑；候选 SHA 必须显式给出）；
只重启、不提升的等价入口是 `just restart-main`。第 ① 步与提升前的全量测试证据仍需人工完成。

### 9.2 产品命令 `promotion` 的现状（**重要边界**）

产品里有一套 `promotion` 命令面：

```sh
bun run codeestra promotion full-suite run $PROJECT --dev-commit <full-sha> [--json]
bun run codeestra promotion full-suite list $PROJECT [--limit <n>] [--json]
bun run codeestra promotion prepare $PROJECT <batch-id> <expected-dev-commit> <expected-main-commit>
bun run codeestra promotion approve $PROJECT <promotion-id>          # 仅 STRICT
bun run codeestra promotion promote $PROJECT <promotion-id> [--json]
bun run codeestra promotion get|list|abandon …
```

- `promotion full-suite run` 由 **Runtime** 在精确 dev SHA 的 detached 副本里运行项目固定策略并**观察**结果
  （客户端**不能自报**「我跑过了」）；证据绑定三样东西：**候选 commit**、该策略的 **digest**、
  **候选 commit 上的锁文件 digest**。
- `prepare` **不写 Git**：它只是把「已验证的 dev commit / 预期旧 main commit / 该 commit 的集成验证 +
  dev 全量证据」固定下来。
- `promote` **一次只推进一步**：先把固定候选 push 到远端 `dev` 并读回核对，此时报「已推送、等待拉取」
  （`state: PROMOTING`，`phase: AWAITING_PULL`，**退出码 3**）且**不记录任何重启步骤**；你在 main 检出做完
  第 ② 步后**再调用一次**，它才核对到 main 检出已在候选上、记录并执行重启序列
  `bun install --frozen-lockfile` → `bun run build:ui` → `bun run codeestra stop` → `bun run codeestra status`，
  最后把候选推回远端 `main`。
  **重启只有在每一步都退 0、且重启后的 Runtime 回答 `READY` 时才会被记录**（`uiRunning` 只记录为事实，
  不是产品侧的重启判据；`promote` 不替你把 UI 拉起来）。
- 失败时**不会自动回滚**：若 main 已被推进而重启序列失败，CLI 会明确打印这一点，并说明重跑
  `promotion promote` 会重跑已记录的后置步骤。

> **⚠ 现状（必须如实说明）**：`promotion prepare/approve/promote` **已经实现** §9.1 的 GitHub 中转路径
> （ADR-0047 / FOUNDATION-077、schema v29，落地细则见 ADR-0052），旧的本地 `git merge --ff-only` 实现已删除。
> 但**本仓库自身的提升仍一律走 §9.1 的人工四步，不得使用产品 `promotion promote`**；
> 交付记录里要如实写明实际用了哪条路径、执行到哪一步。

界面上的「稳定提升记录 · dev → main」面板是**只读**的：它显示记录里的事实（候选 commit、main 是否被改动、
权限模式与批准、重启步骤与退出码），**不执行任何提升**。它还明确写着：**main 已移动不等于 Runtime 已完成重启**。

> 图：`15-promotion-record.png` — 「稳定提升记录 · dev → main」表格与详情：状态、候选 commit、dev 基线、
> main 结果、模式、重启状态、结果，以及展开后的「Runtime 重启」步骤表（命令 / 退出码 / 耗时）。

### 想深入看哪篇

- 提升的完整流程与全部拒绝码：[workflow.md](./workflow.md) §8、[troubleshooting.md](./troubleshooting.md) §1
- `promotion` 每条命令：[cli-reference.md](./cli-reference.md) §15
- 经 GitHub 中转的决策与理由：[ADR-0047](../decisions/0047-github-mediated-promotion.md)、
  本机两个 clone 的布置：[ADR-0048](../decisions/0048-dev-clone-and-separate-runtime-home.md)
- 本仓库自身的四步操作与重启规程：[AGENTS.md](../../AGENTS.md)

---

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
bun run codeestra task schedule explain $PROJECT <task-id> [--adapter <id>] [--json]
bun run codeestra project impact show    $PROJECT <task-id> [--json]
bun run codeestra project impact explain $PROJECT <task-id> [--json]
```

`task schedule explain` 退出码：`0` = 正在跑或现在会启动；`3` = 等待（`WAIT_CONFLICT` / `WAIT_CAPACITY`）；
`1` = `BLOCKED` 或根本不可调度。

### 10.2 依赖：上游必须真的进了 dev

```sh
bun run codeestra task depends add    $PROJECT <task-id> <expected-version> <prerequisite-task-id> [--revision <revision-id>]
bun run codeestra task depends remove $PROJECT <task-id> <expected-version> <prerequisite-task-id>
bun run codeestra task depends list   $PROJECT [task-id] [--json]
```

- 依赖图必须是 **DAG**；加环会以 `DEPENDENCY_CYCLE` / `DEPENDENCY_GRAPH_INVALID` 拒绝，**且不部分应用**。
- **关键语义**：上游必须通过集成验证并进入 `dev`，下游的 **Task 基线 ref** 才包含它的结果。
  **仅 Task 验证成功不释放依赖。**
- 基线来源（ADR-0060 第三轮修订）：有 dev clone 时是那个 clone 的 `dev`，managed 时是项目文件夹当前检出的分支；
  读不到基线就按未满足阻塞（`DEV_BASELINE_MISSING`），**不会**因此拒绝整条命令。managed 项目不会产生
  INTEGRATED 批次，所以带依赖边的 Task 会以 `UPSTREAM_NOT_INTEGRATED` 保持未满足。

### 10.3 调度：三种「不跑」互不相同

```sh
bun run codeestra task schedule status  $PROJECT [--adapter <id>] [--json]
bun run codeestra task schedule plan    $PROJECT [--adapter <id>] [--json]   # 有序 dry run，不预留、不启动
bun run codeestra task schedule run     $PROJECT [--adapter <id>] [--json]
bun run codeestra task schedule clear-unknown $PROJECT <task-id> [--json]
```

| 现象 | 含义 | 退出码 |
|---|---|---|
| `BLOCKED` | **依赖未满足**（唯一含义） | 1 |
| `WAIT_CONFLICT` | 与某个**未完成且声明了同一功能**的 Task 冲突 | 3 |
| `WAIT_CAPACITY` | 项目级上限或 Adapter 上限已满 | 3 |
| `WAIT_CONTROL` | **Runtime 全局暂停**（`SCHEDULER_GLOBALLY_PAUSED`），见 §10.5 | 3 |
| `SCHEDULER_DRAINING` | Runtime 正在 draining，不接受新预留 | 3 |

`UNKNOWN` 的**显式单次放行**（`task schedule clear-unknown` 或 `task run --allow-unknown`）绑定
revision、基线与分析器/策略版本，写入审计台账，被**恰好一次**启动消费，并且**不改变已记录的判定**。
ADR-0059 之后当前规则**不再产生 `UNKNOWN`**，所以这条路日常不可达；`CONFLICTING` 永远不放行。

### 10.4 容量与槽位

```sh
bun run codeestra scheduler capacity get   $PROJECT [--adapter <id>] [--json]
bun run codeestra scheduler capacity set   $PROJECT --limit <n> [--adapter <id>] [--json]
bun run codeestra scheduler capacity clear $PROJECT --adapter <id> [--json]
bun run codeestra scheduler reservations list $PROJECT [--task <task-id>] [--include-released] [--limit <n>]
bun run codeestra scheduler reservations release $PROJECT <reservation-id> --reason "…"
bun run codeestra scheduler reservations reconcile $PROJECT [--json]
```

- 两个上限同时生效：**项目全局**与**每 adapter**（adapter 没有覆写时跟随全局上限）。默认 2，上限 16。
- 非法值有自己的稳定码（`CAPACITY_LIMIT_INVALID` / `CAPACITY_LIMIT_OUT_OF_RANGE` / `UNKNOWN_ADAPTER`），
  **不会被静默夹取**。
- **释放必须显式且必须给原因**。**没有任何东西会因为心跳过期、客户端消失或用户等待而自动释放。**
  可证明仍存活的持有者会被拒绝释放（`SLOT_HOLDER_STILL_RUNNING`）。
- `reconcile` 只**读真实进程表**：已死 → 释放并记录；仍存活 → 保持占用；无法核验 → `RECOVERY_REQUIRED`。
  它**不发信号、不杀进程、不删资源、不声称静止**。
- 一个常见的误解：**Task 启动后，槽位由预留移交给该 Execution**，所以「没有活跃预留但任务在跑」是正常事实。
  用 `--include-released` 可以看到这次移交。

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
界面上对应外壳里的「全局负载控制」条（暂停全部 / 继续全部），与选中的项目无关。

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
`runtime stop`，以及不调用模型的 Git/验证/集成操作。**延后**的是新启动与 answer/guidance 的实际投递
（正文可以先耐久记录，恢复后按既有有效性与幂等规则投递）。

`reconcile` 只**观察**：不发任何信号，可以把「已证明退出」的目标收口，但**不会**把不可核验的目标猜成已停止，
也**不会**把 `RECOVERY_REQUIRED` 提升成 `PAUSED`。

> **当前实现的可冻结范围**：只有 **Pi** 的 `providerProcessSuspension` 是 `SUPPORTED`（真实进程实测）。
> Codex 与 Claude Code 仍是 `REQUIRES_VALIDATION`，因此它们的会话会让本次 epoch 进入 `RECOVERY_REQUIRED`
> 并保持屏障——这是诚实结果，不是「已经冻住了」。详情见
> [ADR-0061](../decisions/0061-runtime-global-load-control.md) 与 `docs/spikes/*.md` 的「Provider 进程冻结」一节。


### 想深入看哪篇

- 完整流程中的依赖与调度：[workflow.md](./workflow.md) §3
- `SAFE`/`UNKNOWN`/`CONFLICTING` 的准确含义：[concepts.md](./concepts.md)
- `task depends` / `task schedule` / `scheduler`：[cli-reference.md](./cli-reference.md) §12–§14
- 「两件事互相冲突怎么办」：[recipes.md](./recipes.md)

---

## 11. 设置与权限：FULL 与 STRICT

### 11.1 权限模式

```sh
bun run codeestra permission get
bun run codeestra permission set strict
bun run codeestra permission set full      # 切回默认
```

| | `FULL`（默认） | `STRICT`（显式 opt-in） |
|---|---|---|
| 项目接入 | 不确认 | 需输入 `TRUST`（脚本 `--yes`） |
| Agent 工具调用 | 自动允许 | gate 逐次审批（Attention） |
| 成果 commit | `task result capture` 单步 | `prepare` → `commit … --confirm` 两步；保留敏感路径拒绝 |
| 验证策略变化 | 不确认 | 需确认 |
| 提升 `dev → main` | 无需批准 | 保留批准（`promotion approve`） |

**不变的**：revision/ref/归属/进程身份核对、静止证据、幂等与崩溃恢复**始终有效**。那些是正确性核对，
不是权限审批，不会被 FULL 关掉，也不会被包装成审批。

界面上左侧栏底部会显示当前模式：`FULL · 全权限，零确认` 或 `STRICT · 严格模式`。
STRICT 下界面才出现 TRUST 输入框和（旧流程的）二次确认；FULL 下它们**不出现**。

### 11.2 界面效果设置

五个键都在 Runtime 里持久化（不是浏览器本地存储），CLI 与界面读写的是**同一份值**：

```sh
bun run codeestra settings ui list [--json]              # 全部键：当前值、默认值、是否显式设置、可取值
bun run codeestra settings ui get <key> [--json]
bun run codeestra settings ui set <key> <value> [--json]
bun run codeestra settings ui reset [<key>] [--json]
```

| 键 | 取值 | 默认 |
|---|---|---|
| `theme` | `system` / `light` / `dark` | `system` |
| `density` | `comfortable` / `compact` | `comfortable` |
| `fontSize` | `medium` / `small` / `large` | `medium` |
| `motion` | `full` / `reduced` | `full` |
| `timeDisplay` | `relative` / `absolute` | `relative` |

- 未知键或非法值是**用法错误（退出码 2）**，不会被夹取。
- 文件读不了时报 `INVALID_UI_SETTING`（退出码 1）；不带 key 的 `reset` 会重写文件，是损坏时的恢复路径。
- **设置不是门禁**：每次写入都是一个命令、零确认，不改变任何 Task 被允许做什么。

> 图：`11-settings.png` — 「设置」标签页的「界面效果」：五个键各一行（中文名 + 键名 + 一句说明 +
> 下拉框 + 当前/默认/是否显式设置 + 恢复默认），以及每行的等价 CLI 命令。

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
- `permission` / `settings` / `agent` 命令：[cli-reference.md](./cli-reference.md) §1–§2、§19

---

## 12. 数据在哪、怎么备份与回收

### 12.1 数据分布

| 位置 | 内容 | 是否进 Git |
|---|---|---|
| `$CODEESTRA_HOME/runtime.sqlite` | 领域数据库（Task / revision / Execution / Session / Attention / 验证 / 集成 / 预留 / 账本等），当前 schema **v28** | 否 |
| `$CODEESTRA_HOME/runtime.sock` | Runtime 的 Unix socket（`0600`） | 否 |
| `$CODEESTRA_HOME/*.json` 等 | 生命周期记录、锁、`ui-settings.json`、`prose-question-attention.json` | 否 |
| `$CODEESTRA_HOME/worktrees/<project-id>/<task-id>/` | Task 独占的工作树 | **否**（Task 成果在内部 `refs/heads/task/<task-id>`） |
| `$CODEESTRA_HOME/verifications/...` | 验证用的 detached 副本 | 否 |
| `$CODEESTRA_HOME/integrations/...` | 集成用的 detached worktree | 否 |
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
- **失败现场默认保留**：没有 `--include-failure-scenes` 时，未提交改动、失败/取消的验证或集成是 `RETAIN`。
- **未注册目录不会被删**，除非用 `--remove-unregistered <精确路径>` 指名。
- 不带 `--project`（或加 `--all-projects`）覆盖**所有**已信任项目，结果按项目分组。
- 退出码：`FAILED` → `1`；可回收数量为 0（plan）或实际回收数量为 0（apply）→ `3`（「没什么可回收」不是错误）；
  否则 `0`。
- 被回收的 Task 工作树之后可以用 `task retry` 从保留的 Task 分支**重建**。

### 想深入看哪篇

- 回收的完整语义与全部拒绝码：[workflow.md](./workflow.md) §9、[troubleshooting.md](./troubleshooting.md)
- `reclaim` 每条命令：[cli-reference.md](./cli-reference.md) §16
- 「保住失败现场」「回收磁盘」：[recipes.md](./recipes.md)

---

## 13. 出问题怎么办

### 13.1 先做的三件事

```sh
bun run codeestra status                             # Runtime 是否可用、权限模式、ownership 结论
bun run codeestra events tail                        # 事实流：事件比文案更接近真相
bun run codeestra task status $PROJECT <task-id>     # 执行 / 验证 / 会话注记
```

### 13.2 记住退出码的三分法

| 码 | 含义 |
|---|---|
| `0` | 成功。**注意**：某些命令的成功是「已受理」而不是「已完成」 |
| `1` | 拒绝或失败（含 `RECOVERY_REQUIRED` 这类需要人处理的状态） |
| `2` | **用法错误**：参数个数/取值不合法、未知 flag、缺少必填 flag |
| `3` | **等待**（冲突/容量等待、draining）或**没什么可做**（reclaim 没有可回收项） |

**`3` 从不表示 `BLOCKED`**——`BLOCKED` 只表示依赖未满足，属于「需要处理」而不是「等一等」。
看到一个 `1` 时，**先读错误码，不要读文案**：文案可能会变，码不会。

### 13.3 界面打不开 / 令牌失效

| 症状 | 处理 |
|---|---|
| `UI_ASSETS_MISSING` | 先 `bun run build:ui` |
| 界面说令牌无效，或旧链接突然失效 | Runtime 每次启动都换内存 token：重新执行 `bun run codeestra ui` |
| 命令打到了「另一个」Runtime | 检查 `CODEESTRA_HOME`；一个 home 只跑一个 Runtime |

### 13.4 任务一直不跑

它可能是**等待**（退出码 3），不是失败。三种互不相同的答案见 §10.3。
看谁占着：`scheduler capacity get`、`scheduler reservations list`。
**没有任何东西会自动释放**，释放必须显式并给出原因。

### 13.5 看到 `RECOVERY_REQUIRED`

这是**多个实体都有的状态**，含义是「有事实无法被证明，需要一次带审计的对账」，
**不是**让你重试掩盖它。先看 `task status` 与 `events tail`。

Task/Execution 的 `RECOVERY_REQUIRED` 用 **`task recover <project-id> <task-id> <expected-version>`**（ADR-0055）：
只读事实（记录的 provider 身份按真实进程表核对、后代快照、workspace 是否还在磁盘），
只有能证明 provider 已消失才收口为 `FAILED`（workspace 保留、不发信号、不声称静止），
否则拒绝并保持占用（退出码 `1`，码为 `RECOVERY_PROVIDER_ALIVE` / `RECOVERY_DESCENDANTS_ALIVE` /
`RECOVERY_OWNERSHIP_UNVERIFIABLE` / `RECOVERY_PROCESS_IDENTITY_MISSING`）。收口后 `task retry` 可重排、
`task cancel` 可作废。IntegrationBatch 与 Promotion 的 `RECOVERY_REQUIRED` 各自有自己的收口命令，见
[cli-reference.md](./cli-reference.md)。

### 13.6 完整的错误码表在哪

**本文不复制错误码表。** 稳定码、每条的触发条件与处理方式都在
[troubleshooting.md](./troubleshooting.md) 的 §1（按症状）与 §2（按领域速查表）里；
每条命令的参数、退出码与码位在 [cli-reference.md](./cli-reference.md) 里。

### 想深入看哪篇

- 常见故障与稳定码表：[troubleshooting.md](./troubleshooting.md)
- 每条命令的退出码：[cli-reference.md](./cli-reference.md) §0
- 「我想做 X」：[recipes.md](./recipes.md)

---

## 14. 术语表

按你在本书里遇到的顺序排列。**粗体**是必须记清的那几个。

| 词 | 一句话定义 |
|---|---|
| **Runtime** | 独立本地服务，Codeestra 的软件本体。每用户单实例，一个 `CODEESTRA_HOME` 一个 Runtime，通过 Unix socket 通信 |
| **CLI** | 完备命令面。每个能力都能只靠它完成并脚本化驱动（`--json`、稳定退出码） |
| **Web UI** | Runtime 的便利前端，与 CLI 走**同一个命令面**，不新增业务语义、不绕过门禁、不直接访问 SQLite |
| **Project** | 一个已接入（trust）的 Git 仓库。按 **Git common dir** 识别，所以同一仓库的多份工作树是同一个 Project |
| **Task** | **业务主实体**：一次有边界的开发工作。持有当前规格、不可覆盖的 revision 历史、约束、依赖、执行历史、验证与集成状态 |
| **TaskRevision** | Task 规格的快照，append-only。第一次创建 Task 就产生第一条 |
| **Revision Delivery** | 「修订是否真的到达了运行中的 Execution」的独立可观察过程。`revisionAcknowledgement` 不支持的 Adapter 会**如实保持未确认** |
| **Execution** | **一次执行尝试**，恰好绑定**一个**主 Agent。换 Agent 要新建 Execution |
| **Session** | 有身份、有生命周期、有恢复信息的运行实体，不是「一次 shell 命令」 |
| **Incarnation** | 同一 conversation 的进程代号。**不是同一个进程**，任意时刻最多一个 Provider writer |
| **Attention** | 一条需要人回答的请求。`kind` = `PERMISSION` / `QUESTION` / `RECOVERY` |
| **散文提问等待** | Agent 没用工具、在正文里提问并结束轮次，被记成 `PROSE_QUESTION_NO_TOOL_USE`。**provider 已退出**，用 `attention resolve` 结束 |
| **result commit（成果 commit）** | Agent 的改动被固定成的一个 commit，落在内部 `refs/heads/task/<task-id>` |
| **Task verification** | 判定**一个 Task 的成果 commit**。命令来自 `main` ref 上人工维护的策略，在固定 commit 的 detached 副本里跑 |
| **Integration verification** | 判定**一个 IntegrationBatch 合并后的 dev 提交**。**独立实体、独立记录**，不能与 Task 验证互相替代 |
| **IntegrationBatch** | 把成果合入 `dev` 的正式记录：成员 Task 与 revision、成果 commit、固定的 `dev` 基线、集成结果与验证证据 |
| **Promotion** | `dev → main` 的正式记录。固定「已验证的 dev commit + 预期旧 main commit + 证据」三元组 |
| **dev 全量测试证据** | 对**精确 dev 候选 SHA** 在 detached 副本里运行项目固定策略的结果，由 Runtime 运行并观察。客户端不能自报 |
| **ImpactSnapshot** | 一次影响分析的 append-only 记录：changed 路径集合、命中的目录/模块/全局资源、是否完整 |
| **Conflict assessment** | `SAFE_TO_PARALLELIZE`（默认）/ `UNKNOWN`（当前规则不产生）/ `CONFLICTING`。**只有「双方声明同一功能且对方未完成」是冲突** |
| **Slot reservation（槽位预留）** | 一次执行权的正式记录。归属证据 = Runtime boot + pid + OS start token。释放必须显式且有原因 |
| **Capacity** | 两个上限：项目全局与每 adapter。它是**配置**不是测量 |
| **Operation（长命令）** | `task.run` / `task.verify` 这类长命令的持久句柄，带步骤级进度，可查、可取消 |
| **Handoff / writer lease** | 原生终端接管的编排：attach / detach / release、单一 writer、安全点与准入决策 |
| **Reclaim** | Runtime 数据目录下工作树 / 验证副本 / 集成工作树的回收。**唯一具有破坏性的命令面** |
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
- [ui.md](./ui.md)：**逐屏 UI 走查**（7 个标签页，每个按钮做什么）
- [cli-reference.md](./cli-reference.md)：CLI 与 HTTP/SSE 命令参考
- [recipes.md](./recipes.md)：常见任务的做法
- [acceptance-checklist.md](./acceptance-checklist.md)：人工观感核对清单
- [troubleshooting.md](./troubleshooting.md)：常见故障与稳定码表
- [images/README.md](./images/README.md)：插图清单（图由用户提供）

仓库级文档：[PROJECT_SPEC.md](../../PROJECT_SPEC.md)（长期规格）、[AGENTS.md](../../AGENTS.md)（协作规则）、
[../decisions/README.md](../decisions/README.md)（ADR 索引）、[../tasks/README.md](../tasks/README.md)（当前任务与进度）。
