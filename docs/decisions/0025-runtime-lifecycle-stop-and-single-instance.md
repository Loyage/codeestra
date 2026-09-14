# ADR-0025：Runtime 生命周期的可判定停止、单实例归属与只读诊断

Status：Accepted（本轮目标与边界由用户派单直接指定：`stop` 返回后进程必须真的退出或如实报告「未退出」、
单实例与 socket 竞态不得留下不可达进程、诊断必须只读且**本轮不新增自动杀进程能力**。下面 D01–D06 是这些约束下的
实现级选择，随本格报告一并提请确认；D07 明确列出未采纳的替代项。）

## Context

`docs/tasks/README.md` FOUNDATION-042「剩余问题 1」记录并复现了一个真实缺陷：`codeestra stop` 之后 Runtime 进程
有时不退出——socket 已被 `rmSync`、storage 已 `close`、进程被 reparent 到 init，但进程仍存活。Wave B 结束时一次性
清理出 46 个孤儿进程（23 个 Runtime + 21 个 stub-pi + 2 个测试 Runtime，来自已删除的 b2/b3 工作树），每次并行波次
都会再产生一批。本轮先在隔离 home 复现，再定位根因。

### 实测根因（两层，都有直接证据）

**第 1 层：完成 shutdown 之后，事件循环被「bounded grace」计时器多留了 5 秒（可累积到 10 秒以上）。**

各子系统都用 `Bun.sleep(graceMs)` 放进 `Promise.race` 做有界宽限，但**从不清理该 timer**：

- `apps/runtime/src/agent-runtime-service.ts` `AgentRuntimeCoordinator.close()`：`#shutdownGraceMs` 默认 5000。
- `packages/agent-adapters/src/pi-process.ts` `PiRpcProcess.stop()`：`stopGraceMs` 默认 5000，且一次 stop 里最多两段 race。
- `apps/runtime/src/verification-service.ts`：`stopGraceMs = 2000`，另有 `drainDeadline = stopGraceMs + 5000`。
- `apps/runtime/src/operation-service.ts` `close()`：`#shutdownGraceMs` 默认 5000。

Bun 在还有 pending timer 时会继续跑事件循环，所以「race 的另一边早已完成、shutdown 已经跑完」的进程仍然活着，
直到最长的那段宽限到期。证据（隔离 home，逐项关闭 shutdown 步骤测量进程退出时刻）：

| 关闭的步骤 | 进程退出时刻 |
|---|---|
| 无（完整 shutdown） | ~5.5s（shutdown 在 0.4s 完成，之后又活了 5.1s） |
| 跳过 `coordinator.close()` | ~0.53s |
| 跳过 `handoff.close()` | 永不退出（监听 socket 仍在，属预期） |

微实验对照：`Promise.race([Promise.resolve(1), Bun.sleep(3000)])` 的进程总耗时 3.02s；把 `Bun.sleep` 换成
清 timer 的 `withDeadline` 后立即退出。原始复现（用户给的步骤）实测：`stop` 后 `ps -p <pid>` 仍存活，进程
在 **~5.00s** 后才消失；FOUNDATION-042 观察到的「socket 已删、storage 已关、进程仍在」正是这个 5 秒窗口。

**第 2 层：`stop` 是 fire-and-forget，谁都不确认退出；而启动路径没有归属锁，可留下永久不可达进程。**

- `runtime.stop` 分支只 `setTimeout(() => void shutdown(), 10)` 并立刻回 `{stopping: true}`；CLI 打印后退出，
  没有任何一方等待或核对进程是否真的结束。于是「已发出信号」被当成「已停止」。
- 启动序言 `if (await endpointIsLive()) process.exit(0); rmSync(socketPath, force: true); ... Bun.listen(...)`
  是 TOCTOU：两个启动者可以都判定 endpoint 不存活，各自 `rmSync` 同一路径再 bind。并发 4 个启动者的实测里，
  3 个以 `EADDRINUSE`（`runtime.sock`）/`EEXIST`（`session-handoff.sock`）崩溃，或在已迁移库上以
  `SQLiteError: table project_trusts already exists` 崩溃（两个进程同时跑迁移、同时打开一个 SQLite）。
  更糟的时序是「败者先 `rmSync` 掉胜者的 socket 路径、再成功 bind」：胜者的 listener 留在无人可达的 inode 上，
  而**监听 socket 会让事件循环永不空闲**，那个进程就成了既不可达、又永不退出、`stop` 也够不到的孤儿——
  FOUNDATION-042 记录的「无 `runtime.sock`、无 sqlite fd、shutdown 已跑完」正是这个签名。

## Options

1. 让 `stop` 可判定：(a) CLI 两阶段——先请求、再有界等待进程消失并按事实报告；(b) Runtime 在响应前自己
   `await` 完整 shutdown（响应延迟受限于最长宽限）；(c) 保持现状，只缩短宽限。
2. 让进程真的及时退出：(a) 逐个清掉泄漏的 timer；(b) 只做清 timer；(c) 清 timer + 在当前 shutdown 顺序全部
   完成后由 Runtime 确定性结束进程（`process.exit`）。
3. 单实例：(a) 独占归属锁文件 + 启动前先取锁；(b) 只用 unix socket bind 的原子性（不额外落文件）；
   (c) 全局 registry 目录 + 按 home 命名。
4. 锁的内容与失败语义：(a) 记录 `bootId/pid/startToken/startedAt/argv/cwd`，硬链接原子写入，owner 存活则拒绝、
   owner 已死则接管；(b) 只记录 pid；(c) 记录 pid + 时间戳。
5. 诊断面：(a) Runtime 每次都写 boot 记录，CLI 只读生命周期记录并如实报告；(b) 扫进程表按 argv/cwd 猜归属；
   (c) 只在内存里报告。
6. `stop` 在「从未启动」/「进程活着但不可达」时的输出：(a) `NOT_RUNNING`(exit 0) / `UNREACHABLE_PROCESS`(exit 1)；
   (b) 都 exit 0；(c) 都 exit 1。
7. 不可达孤儿是否自动回收：(a) 本轮不做，只报告；(b) 由 `stop` 直接 SIGKILL；(c) 引入新的自动回收命令。

## Decision

1(a)、2(c)、3(a)、4(a)、5(a)、6(a)、7(a)。

### D01：根因修复——有界宽限不得把进程留活

`apps/runtime/src/lifecycle.ts`（新）提供 `withDeadline(work, timeoutMs)`：与 `work` 竞速，**并在 finally 里
`clearTimeout`**。`AgentRuntimeCoordinator.close()` 改用它（这是本格唯一一处非领地文件改动，2 行 + 1 个 import），
宽限语义不变（未 settle 仍然只记日志、不阻塞）。

其余三处同类写法在**禁改文件**里（`packages/agent-adapters/src/pi-process.ts`、
`apps/runtime/src/verification-service.ts`、`apps/runtime/src/operation-service.ts`）。它们是同一个模式，建议由各自
领地负责人改成同一个 `withDeadline`；**本格不越界修改**。它们不再能让进程久留（见 D02），但仍会让「循环因别的原因
未清空时」多留数秒。

### D02：shutdown 完成后确定性结束进程，未确认的 owned 进程除外

`apps/runtime/src/main.ts` 的 shutdown 顺序不变，末尾追加两件事：

1. `releaseRuntimeOwnership({ home, bootId })`（D03）——归属在最后释放，「home 空闲」只在其它一切释放完之后才为真。
2. 检查仍未被确认停止的 owned 进程：`coordinator.activeSessionIds()`（provider 观察流未结束）与
   `verificationRunner.unconfirmedStops`。**两者都为空**时 `process.exit(0)`：此时所有持久状态已关闭，剩下还占着
   事件循环的只可能是「宽限 timer」这类其自身工作已经完成的句柄，进程不必再等它。**任一非空**则不退出，打日志并
   保持可观察——让 `stop` 如实报 `NOT_EXITED`，而不是在活的 provider/验证命令之上假装 shutdown 干净。
   `provider` 释放失败的事实仍由既有 `recordRuntimeDisconnect` 与 recovery 投影承担。

### D03：一个 home 只有一个 Runtime（独占归属）

- 归属文件 `<home>/runtime.lock`，内容 `{bootId, pid, startToken, startedAt, argv, cwd}`；用「先写临时文件、再
  `linkSync`」原子创建（`linkSync` 已存在时 `EEXIST`），因此读者只会看到「没有锁」或「完整记录」，不存在
  「读到半条记录 → 误判 owner 已死 → 删掉活人的锁」的窗口。
- 身份不靠 pid：`startToken`（与 `@codeestra/agent-adapters` 的 `readProcessStartToken` 同格式，均为 `/proc` 或
  `ps -o lstart=`）用于区分「同一个进程」与「pid 被复用」。**zombie 不算活着**（已退出、只等 reap）：因此被杀死的
  Runtime 留下的锁会被正确视为过期。
- 启动序言改为：先取锁 → 取不到则报出 owner 并 `exit 3`（owner 存活）/`exit 4`（争用）→ 再探测 endpoint，
  若还有人应答（旧版本 Runtime 没有锁文件）则释放自己的锁并 `exit 0` → 确认无人应答后才 `rmSync` 旧 socket 并
  listen。取锁发生在打开 SQLite **之前**，两个进程同时迁移一个数据库的情况从根上不可能。
- 每次启动写一条 boot 记录 `<home>/runtime-boots/<bootId>.json`；只有干净退出（D02）才删自己的锁与自己的记录。
  别人的锁/记录是证据，本进程永不删除。不可解析的锁文件被重命名为 `runtime.lock.corrupt` 保留，不静默丢弃。

### D04：`stop` = 请求 + 有界等待 + 事实报告

`runtime.stop` 的响应只报告「被要求停止的进程是谁」：`{stopping, pid, bootId, startedAt}`，**不再隐含已停止**。
CLI `codeestra stop [--wait <seconds>]`（默认 10s）：

1. 先只读读取本 home 的归属记录（不写、不发信号）。
2. ping 不到 endpoint 时**不启动 Runtime**（旧行为会为了停它而先把它拉起来）：`verdict=UNREACHABLE_PROCESS` 或存在
   存活 boot 记录 → `status: UNREACHABLE_PROCESS`、`exit 1`（进程仍活着，如实报告，**不杀**）；否则
   `status: NOT_RUNNING`、`exit 0`。
3. ping 得到 endpoint 时：用「lock 记录的 `bootId` == ping 的 `bootId`」确认同一个进程，取它的 `startToken`，
   发 `runtime.stop`，然后有界轮询：`pid` 不存在即已退出；`GONE`/`ZOMBIE` 也算已退出；超时才做最后一次身份核对
   （start token 变了 ⇒ 被 replace 的原进程已退出）。随后输出
   `{status: STOPPED|NOT_EXITED, pid, bootId, stopReportedPid, pidMismatch, waitedMs, identityVerified, identityChanged, ownership}`
   并给退出码 0/1。重复 `stop` 幂等（第二次是 `NOT_RUNNING`）；从未启动过也不创建任何文件。
4. **升级窗口兼容**：本改动落地后、稳定 Runtime 重启前，新 CLI 面对的是旧 Runtime——它的 `runtime.stop` 只回
   `{stopping: true}`、它的 ping 没有 `startedAt`。两者都不算失败：`stop` 把「`stopping === true`」视为请求已被接受，
   然后按 ping 的 pid 做同一个有界等待，并如实报 `identityVerified: false`、`stopReportedPid: null`（没有可核对的记录）；
   `status` 原样打印旧 Runtime 的 ping 字段并附上只读 `ownership`。这是 ADR-0022 重启序列（`stop` → `status`）在第一次
   提升时不会因版本差异而中断的前提。

### D05：只读诊断（CLI 完备，不依赖 Runtime 存活）

`inspectRuntimeHome({home, socketPath})` 只做只读操作（`readFile`/`existsSync`/`readdir`、一次 connect-and-close
endpoint 探测、`ps` 读 start token），**不写、不删、不发信号**。它报告：lock 是否存在/是否可解析/记录内容/
holder 是否存活/身份是否匹配、每条 boot 记录的 `processAlive`/`identityMatches`/verdict、`unreadableRecords`、
以及整体 `verdict`（`NOT_RUNNING | RUNNING | UNREACHABLE_PROCESS | STALE_LOCK | CORRUPT_LOCK`）。
`traces` 是「不是当前那个可达 Runtime」的记录：进程还在但不可达（`RUNNING`）、未记录干净退出
（`EXITED_WITHOUT_CLEAN_SHUTDOWN`）、pid 已被复用（`PROCESS_ID_REUSED`）。

- `codeestra stop` 与 `stop`/`status` 的 JSON 都带 `ownership`（lock + traces + verdict）。
- `codeestra status` = 先 ensure（保持 ADR-0004 的「CLI 首入口自动启动」语义不变）+ 打印 ping 结果 + `ownership`；
  拿不到 Runtime 时打印 `{status: UNAVAILABLE, error, ownership}` 并 `exit 1`（此前是未捕获异常栈）。
- 归属记录与 boot 记录都在 Runtime 数据目录内，CLI 只读它、不写它；不进入 `.codeestra/`、不影响仓库。
- 不按进程名/argv 猜归属：没有归属记录的进程（例如旧版本留下的孤儿）**不予归属**，因此不谎报也不误杀。

### D06：合同面（只加两个已有命令的结果定义）

`packages/contracts` 新增 `runtimePingResultSchema`（含 `startedAt`）与 `runtimeStopResultSchema`（`stopping/pid/bootId/
startedAt`），就地放在 `runtime.ping`/`runtime.stop` 的定义旁，不新开 group、不动其它命令。

### D07：明确未采纳的替代项

1. **不自动回收不可达 Runtime 进程**（本轮不做，仅报告）。若要自动化，建议另立 ADR，方案与成本：
   新命令（如 `runtime reclaim`)按「锁/boot 记录里的 pid + startToken 匹配 + endpoint 不应答」三重校验后发送
   `SIGTERM`（有界等待）再 `SIGKILL`，账本入 Runtime 数据目录。**效率成本**：常态路径 0 步 0 等待（只在显式命令里
   执行）；异常路径多一步人工命令。风险：pid 复用、跨用户 EPERM、旧版本孤儿无记录可校验（只能不处理）。
   本轮的取舍是「只报告 + 保留现场」，与 ADR-0021「物理回收必须显式且归属校验」一致。
2. 不采用「Runtime 在响应 `stop` 前自己等完 shutdown」：那会把最长宽限（可 >10s）压进 CLI 命令的响应时间，
   而且仍然无法回答「进程真的退出了吗」（响应本身由将死进程发出）。
3. 不采用「只缩短宽限」：那只掩盖根因，并让实时 provider 释放缺少有界宽限。
4. 不采用「全局 registry 目录」：`CODEESTRA_HOME` 已是单实例边界，锁放在 home 内可随 home 删除/隔离自然清理。
5. 不为 `stop` 增加任何确认或审批层（ADR-0008/0011）：`stop` 是用户显式命令，FULL/STRICT 都不新增门禁。
6. 不改 `entrypointIsLive` 的旧语义之外的公共 API：`runtime.ping`/`runtime.stop` 只加字段，不改字段含义。

## Consequences

- `stop` 的事实可判定：正常情况 ~0.03–0.2s 内进程消失并报 `STOPPED`（旧实现 5s 后仍可能被观察到活着）；不可达时
  报 `UNREACHABLE_PROCESS` 且 `exit 1`；从未启动报 `NOT_RUNNING` 且不创建任何文件。
- 一个 home 不可能有两个 Runtime；并发启动不再产生迁移崩溃、socket 争用或不可达孤儿；被杀死的 Runtime 留下的过期锁
  会被下一次启动接管，其 boot 记录作为「未干净退出」的证据保留。
- ADR-0022 的重启序列因此更可靠：`stop` 真正等待旧进程退出，`status` 才启动新 boot；旧进程不会与新进程并发持有
  SQLite 与 socket。
- ADR-0004 的「CLI 自动启动 Runtime」语义不变；`stop` 不再触发启动（这正是它此前会「先起一个再停掉」的行为）。
- 新增两类 Runtime 数据目录文件（`runtime.lock`、`runtime-boots/*.json`）：都不是密钥、不含凭据；未干净退出的 boot
  记录会累积（每个异常退出 1 个小 JSON），本格不自动清理（属 ADR-0021 之外的第四类资源，未注册、未列入回收范围）。
  存在一个已知的微小伪影：若进程恰好在写临时文件与 `linkSync` 之间被杀，会留下 `runtime.lock.<pid>.tmp`（不参与任何
  判定，同名重试会被覆盖）。
- 首次启动多一次 `ps` 读取 start token（约 10ms）与一次硬链接写入；常态开销可忽略。

## Verification

- 复现对照（同一隔离 home 步骤 `status` → `stop` → `ps -p <pid>`）：修复前 `stop` 在 ~50ms 返回且进程仍存活，
  进程在 **~5.00s** 后才消失；修复后 `stop` 总耗时 **0.13s**、`waitedMs: 29`、进程立即消失、
  `runtime.lock` 与 boot 记录均已释放。
- 根因定位实验：逐项跳过 shutdown 步骤测进程退出时刻（完整 ~5.5s / 跳过 `coordinator.close()` ~0.53s /
  跳过 `handoff.close()` 永不退出）；`Bun.sleep` 与 `withDeadline` 的微实验对照。
- `apps/runtime/test/runtime-lifecycle.test.ts`（新，10 项；真实 CLI + 真实 Runtime + 协议 stub provider + 真实临时
  Git 仓库，全部独立临时 `CODEESTRA_HOME`）：`stop` 后进程消失且 `STOPPED`（FOUNDATION-042 回归）；宽限 timer 不得
  留住进程（对照：裸 race 计时 3s，`withDeadline` 立即退出）；`stop` 幂等与「从未启动不启动、不落文件」；并发 4 个
  启动者恰好 1 个存活且为锁的 owner、其余 `exit 3` 且不打迁移错误；socket 缺失但进程存活时 `stop`/`status` 报
  `UNREACHABLE_PROCESS`/`UNAVAILABLE` 且**不杀**；SIGKILL 后过期锁被接管、boot 痕迹保留；活跃 provider 子进程下
  `stop` 同时结束 Runtime 与该 provider；归属记录单元面（活 owner 拒绝第二claim、死后接管、非本 boot 的锁不删、
  损坏锁保留为 `runtime.lock.corrupt`、各类 verdict 与身份复用判定）。
- 全量检查：见 `docs/tasks/README.md` FOUNDATION-045 的「实际验证」。
- 升级窗口兼容（人工，无自动化：需要同时存在两版代码）：把本格改动 `git stash` 后用旧代码启动一个 Runtime（无 lock/boot
  记录、ping 无 `startedAt`），再用新 CLI `status`/`stop`：`status` 报 `verdict: RUNNING`、`lock.present: false` 且原样打印
  旧字段；`stop` 报 `STOPPED`、`exit 0`、`identityVerified: false`、`stopReportedPid: null`，进程随后确实消失。
- 未验证：真实 Pi（非 stub）会话下的 stop；跨用户 EPERM 场景；旧版本（无锁）Runtime 与新版并存的完整矩阵
  （仅覆盖「endpoint 应答则让位」这一条）；`stop` 之外的命令面在孤儿存在时的行为。

## Related

- `PROJECT_SPEC.md` §1.1（效率至上、CLI 完备、测试仅限命令面）、§2.12、§3（外部操作不假定原子性、恢复时核对真实资源）
- `AGENTS.md`（数据与副作用：可恢复步骤、路径归属校验；Git 与文件安全：不覆盖用户改动、保留失败现场）
- ADR-0004（CLI 首入口并自动启动独立 Runtime）、ADR-0008/0011（FULL 零确认、不新增门禁）
- ADR-0019（长命令 shutdown 顺序）、ADR-0021（回收必须显式且校验归属）、ADR-0022（重启序列依赖可靠的 stop/status）
- `docs/tasks/README.md` FOUNDATION-042（剩余问题 1/2）、FOUNDATION-039、本格 FOUNDATION-045
