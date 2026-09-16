# ADR-0068：CLI 每一层都必须自描述，且清单与实际命令同源

Status：Accepted（用户 2026-09-17 明确决定：这条准则是基本准则，写入宪法）

## Context

第一原则第 2 条要求 CLI 是完备、可脚本化的命令面，但「CLI 里有哪些命令」这件事一直没有单一来源：
`apps/cli/src/main.ts` 的 `usage()` 是一个**手写模板字符串**（405 行），而分发是一条 1700 行的嵌套
`if/else`（`group` → `action` → 子动作，最深四层）。两处靠人同步，类型检查看不见其中任何一处。

这个缺陷不是假设，已经发生过三次：

1. `e0b2224` 修的是「`usage()` 文本里仍列着已删除的集成/提升命令」——模板字符串里的漂移，`tsc` 抓不到。
2. **`task recover` 从头到尾不存在**：`git show 3d31533` 显示那次提交给 `usage()` 加了 `task recover` 的用法行、
   给 Runtime 加了 `case 'task.recover'`、给契约加了请求、给 storage 加了事务、还写了 8 项 service 测试，
   **唯独没有给 CLI 加分发分支**。于是 `codeestra task recover …` 落到链尾的 `usage()`，退出码 2，
   而 ADR-0055、FOUNDATION-086 与五篇用户指南都在教用户敲它（`docs/guides/cli/task-lifecycle.md` §4、
   `manual.md` §13.5、`recipes.md`、`troubleshooting.md`、`cli-reference.md`）。
3. 同一个 `usage()` 里还写着两条**已删除**的 `scheduler reservations get` 说明之外的漂移（FOUNDATION-074 修过一轮）。

用户的要求是：**CLI 的每一层都要有总结这一层有哪些命令、以及这些命令大致功能范围的命令；这个命令要内恰**
（清单与实际可执行命令集合同源，既不列出不存在的命令，也不漏掉存在的命令）。

## Options

1. **继续手写清单，靠人同步。** 维持 `usage()`，多写几条校验规则。
   拒绝：这正是三次事故的成因，而且规则仍然看不见「命令存在但分发没有分支」。
2. **只加一个生成清单的命令，分发不变。** 新增 `help`，从一份新登记表渲染；分发仍是 `group/action` 比较。
   拒绝：清单与分发仍是两份事实，第 2 类缺陷（清单有、分发没有）依旧只在运行时暴露。
3. **把命令树做成唯一来源，并让类型系统把分发钉在树上。** argv 解析、`help` 渲染、分发分支的 id 都来自
   同一份 `command-tree.ts`；分发链以 tree id 比较，链尾用 `assertNever` 要求穷尽。
   选择方案 3，并用定向测试补齐类型系统看不见的部分。

## Decision

### D01：准则（写入 PROJECT_SPEC §1.1 第 4 条）

CLI 的**每一层**（顶层、组、子组、命令）都必须能自报「这一层有哪些命令、各自大致做什么」，
且该清单必须与**实际可执行命令集合同源**：列出的每条命令都能执行，能执行的每条命令都被列出。
「只有源码里有、CLI 进不去」的命令面（含 Runtime 命令）是缺陷，不是设计选择。

### D02：命令树是唯一来源

`apps/cli/src/command-tree.ts` 是 CLI 唯一的命令清单，每个节点带 `kind`、一行 `summary`、`usage`、
（可选）`unit`、`runtime`、以及旧 `usage()` 的原文 `detail`。**长文本是搬移，不是重写**：382 行原文一字未改
（迁移核对：旧 `usage()` 的每一行都能在树里找到）。

### D03：argv 解析与分发都按树

- `resolveCommand(argv)` 走树，返回 `HELP | DISPATCH(id, rest) | UNKNOWN | BARE`；`DISPATCH.id` 的类型
  `ChainId` 就是分发链比较的集合（unit 自身、unit 之外的叶子与可运行命令）。
- 分发链以 `commandId === '<id>'` 比较，链尾 `assertNever(commandId)`；**加节点不加分支、或分支写错 id 都是编译错误**。
- unit 分支内部用 `childIdOf(unit, token)` 解析子命令：子命令名由树校验（写错即编译错误），
  声明了却没有分支的分支以 `UNHANDLED_COMMAND`（退出码 70）**大声失败**，而不是像以前那样静默无操作
  （`agent config bogus` 以前会静默退 0）。

### D04：用法错误是一行

`usage()` 只剩一行：该命令自己的用法行 + `run \`<命令路径> help\``。未知命令是
`UNKNOWN_COMMAND: \`x\` is not a command under \`<层>\` — run \`<层> help\``，缺子命令与参数错误同理，全部退出码 2。
**整份清单不再在错误路径打印**，但仍完整可读——它现在在 `help` 里。

### D05：`help` 的三种拼写与它不做的事

`codeestra help [<路径…>]`、`codeestra <路径…> help`、`codeestra <路径…> --help|-h` 是同一个请求（退出码 0）；
`--json` 给机器读（`path`/`kind`/`summary`/`usage`/`variants`/`detail`/`children`/`notes`）。
`help` 只读命令树：**不连 Runtime、不启动 Runtime、不写任何东西**。「问 CLI 能做什么」不该启动一个进程。
`help` 只在紧跟命令路径的位置被识别，所以 `task create … --title -h` 里的 `-h` 仍是任务详情。

### D06：Runtime 命令面也要能自描述

新增 Runtime 命令 `runtime.commands`（CLI 拼写 `runtime commands [--json]`）：列出这个 Runtime 接受的每一条
versioned 命令、它归属的 CLI 组与一行功能范围。命令名列表**从 `runtimeRequestSchema` 本身派生**，
描述是 `Record<RuntimeRequest['command'], …>`——新增命令不写描述就编译不过。
它不引入新的业务语义：只是一份对「同一 versioned 命令面」的自描述投影。

### D07：测试补上类型系统看不见的部分（并说明强度边界）

`apps/runtime/test/` 新增三项定向测试：

- `cli-help.test.ts`：对**树里每个节点**跑 `<路径> help`，断言它打印的子命令与 summary **等于树自己的**
  （清单与实际命令的一致性不是手写期望，而是与树对比）；并断言 `help` 没有创建 socket/lock/boot 痕迹。
- `cli-command-surface.test.ts`：节点形状（summary/usage/父节点/unit 有孩子/深度 ≤ 4）、解析器对树里每个路径都成立、
  **每个 Runtime 命令都能追到某个 CLI 节点且其名字在 CLI 代码里作为字面量出现**（这条正是能抓住 `task recover` 的检查）、
  以及 `docs/guides/cli` 覆盖每一个 CLI 命令。
- `cli-task-recover.test.ts`：从 CLI 走通 `task recover`（到达 Runtime 的 reconcile，而不是退 2）。

**强度边界（必须如实读）**：这些都是**可达性与覆盖面**检查，不是行为证明。文档检查只能发现「整节缺失」，
不能发现「这一节过时了」——那仍是 ADR-0050 的人工纪律，ADR-0050 的 D03 映射目标不变。

### D08：类型系统仍覆盖不到的一处（如实记录）

unit（`unit: true` 的节点）**内部**的子命令链按 `childIdOf` 校验名字，但穷尽性由运行时
`UNHANDLED_COMMAND` 兜底（`settings.concurrency` 这类把动作转发给共享解析函数的节点也在其中）。
顶层链是编译期穷尽的；内层是「名字编译期 + 缺分支运行时大声失败」。若以后要内层也编译期穷尽，
做法是把内层 `if/else` 换成对 `DirectChildIds<unit>` 的 `switch` 并加 `assertNever`——本 ADR 不做。

### D09：与 ADR-0050 的关系

ADR-0050 说「功能变更同步 docs/guides，人工规范、不加机器门禁」。本 ADR **不撤回**该纪律：
新增的文档检查只是一条**覆盖**断言（命令有没有落点），落点内容是否准确仍由人负责。
`docs/guides/cli-reference.md` 的 §N 对照表新增 §22（新章节号沿用既有编号规则）。

## Consequences

- 新增/删除/改名一个 CLI 命令，必须同时改命令树与分发分支，否则 `tsc` 失败；漏写文档或漏接 Runtime 命令由定向测试失败。
- `help` 的输出永远等于树：不存在「帮助里有的命令其实不能跑」。
- 用法错误输出从 405 行变成 1 行；需要清单的人改用 `help`（可脚本化、`--json`、退出码 0）。
- 旧的 `usage()` 长文本没有丢：它在树里，`<命令> help` 与顶层 `help`（含两条不属于任何单条命令的段落）都能读到。
- 代价：`command-tree.ts` 约 1500 行（其中大部分是搬过来的原文），CLI 的 `main.ts` 因守卫改写而重新排版；
  分发链的顺序仍是人工维护（树保证集合，顺序由人决定）。
- 已知遗留（不在本 ADR 范围）：`task.recover` 对一个**没有 Execution** 的 Task 回 `NOT_FOUND: Task was not found in this project`
  （用于 join 了 `executions`），文案与事实不完全一致；本 ADR 只保证命令面可达。

## Verification

- `bun run typecheck`：新增节点不写分支、分支写错 id、unit 子命令名写错，都必须失败（已实测：`ChainId` 的
  `assertNever` 曾精确列出未比较的 `task.recover`）。
- `bun test apps/runtime/test/cli-help.test.ts apps/runtime/test/cli-command-surface.test.ts apps/runtime/test/cli-task-recover.test.ts`
- 回归：`apps/runtime/test/cli-*.test.ts`（CLI 命令面全量 e2e）。
- 迁移无损核对：旧 `usage()` 的 382 行全部能在命令树里逐行找到（一次性核对，见交付记录）。

## 关联

- **Amends ADR-0008**：§1.1 由三条第一原则变为四条，新增第 4 条「CLI 每一层自描述且同源」。
- 执行面：ADR-0019（长命令 Operation 的退出码语义不变）、ADR-0025（`stop`/`status` 语义不变）。
- 被本 ADR 记入历史的具体缺陷：ADR-0055 / FOUNDATION-086 的 `task recover` 命令面缺失（本 ADR 一并修复）。
- 文档纪律：ADR-0050（本次按其 D03 同步 `docs/guides/cli/`，并按 D02 保留版本头口径）。
