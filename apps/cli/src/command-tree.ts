import type { RuntimeRequest } from '@codeestra/contracts';

/** The name of one versioned Runtime command, taken from the contract's request union. */
export type RuntimeCommandName = RuntimeRequest['command'];

/**
 * How many transcript pages `--reverse` reads at most. It lives here because the moved `usage()` text
 * interpolates it: the number and the sentence that explains it stay in one place.
 */
export const maxTranscriptReverseReads = 50;

/**
 * The CLI command tree: the ONE description of every command this client can run.
 *
 * Nothing else may enumerate commands. `help` renders this tree, the dispatcher resolves argv
 * against it, and the targeted tests assert that the eight `docs/guides/cli` files and the Runtime's
 * versioned command face are both covered by it. A command that is not in this tree does not exist;
 * a command in this tree that the dispatcher does not handle fails
 * `apps/runtime/test/cli-command-surface.test.ts` (ADR-0068).
 *
 * The long text is the old `usage()` dump, moved here verbatim: only the place it is printed from
 * changed.
 */
export interface CommandNodeSpec {
  /** GROUP nodes only hold children; COMMAND nodes are runnable. */
  readonly kind: 'GROUP' | 'COMMAND';
  /** One line: what this level of the tree is for. Shown by the parent's listing. */
  readonly summary: string;
  /**
   * Where the dispatch chain stops and handles the children itself. The resolver must return exactly
   * the node the chain branches on, so these are the nodes that own their subtree.
   */
  readonly unit?: true;
  /** The usage line, verbatim (including the `bun run codeestra` prefix). COMMAND nodes only. */
  readonly usage?: string;
  /** Other forms of the same command (for example the four `attention answer` shapes). */
  readonly variants?: readonly string[];
  /** `#` comments and the topic's own paragraphs from the old dump. */
  readonly detail?: string;
  /** The versioned Runtime commands this node reaches. Checked against the contract's union. */
  readonly runtime?: readonly RuntimeCommandName[];
  /** Resolved by `resolveCommand` itself, never by the dispatch chain (`help`). */
  readonly resolverHandled?: true;
}

export const commandNodes = {
  "agent": {
    kind: "GROUP",
    summary: "Agent 配置与插件/资源选择",
  },
  "agent.config": {
    kind: "GROUP",
    summary: "Agent 配置（provider / model / thinking）按全局默认与每项目覆盖读写",
    unit: true,
  },
  "agent.config.clear": {
    kind: "COMMAND",
    summary: "清掉某一层（全局或某项目）的 Agent 配置覆盖",
    usage: `bun run codeestra agent config clear [--project <project-id>] [--adapter <id>]`,
    runtime: [
      "agent.config.clear",
    ],
  },
  "agent.config.get": {
    kind: "COMMAND",
    summary: "读生效中的 Agent 配置及其来源层（环境变量 > 项目 > 全局 > 适配器默认）",
    usage: `bun run codeestra agent config get [--project <project-id>] [--adapter <id>]`,
    runtime: [
      "agent.config.get",
    ],
  },
  "agent.config.set": {
    kind: "COMMAND",
    summary: "写一层 Agent 配置；只影响新 Session，生效值随 Execution 记录",
    usage: `bun run codeestra agent config set [--project <project-id>] [--adapter <id>] [--provider <name>] [--model <id>] [--thinking <off|minimal|low|medium|high|xhigh|max>] [--unset provider|model|thinking]`,
    runtime: [
      "agent.config.set",
    ],
  },
  "agent.plugins": {
    kind: "GROUP",
    summary: "Pi 插件/资源的只读检测与选择（ADR-0044）",
    unit: true,
  },
  "agent.plugins.list": {
    kind: "COMMAND",
    summary: "只读检测可选的 extensions / skills / prompt templates / themes",
    usage: `bun run codeestra agent plugins list [--project <project-id>] [--adapter <id>] [--json]`,
    runtime: [
      "agent.plugins.list",
    ],
  },
  "agent.plugins.select": {
    kind: "COMMAND",
    summary: "整份替换插件选择（或 --clear 清空）；每个路径都先核验可用",
    usage: `bun run codeestra agent plugins select [--project <project-id>] [--adapter <id>] [--extension <path>]… [--skill <path>]… [--prompt-template <path>]… [--theme <path>]… [--clear] [--json]`,
    detail: `# The four kinds are the scope the user approved (ADR-0044): extensions, skills, prompt
# templates and themes. "select" replaces the whole selection with exactly the flags given
# (repeatable flags rather than a JSON file, so a path never needs a second escaping rule);
# "--clear" removes the selection.
# Every selected path is verified before anything is written and again before a Session starts;
# a path that cannot be loaded is refused with a stable code and no Execution is created.
# Exit codes: 0 applied, 1 refused (unusable path or adapter without plugin selection), 2 usage.`,
    runtime: [
      "agent.config.set",
    ],
  },
  "attention": {
    kind: "GROUP",
    summary: "等待人的 Attention：列出、回答（含结构化问卷）、收口散文提问",
  },
  "attention.answer": {
    kind: "COMMAND",
    summary: "回答一条 Attention（confirm / value / cancel / 结构化问卷）",
    usage: `bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no>`,
    variants: [
      `bun run codeestra attention answer <project-id> <attention-id> value <text>`,
      `bun run codeestra attention answer <project-id> <attention-id> cancel`,
      `bun run codeestra attention answer <project-id> <attention-id> [--choose <question>:<options>]… [--text <question>=<text>]… [--cancel]`,
    ],
    runtime: [
      "attention.answer",
    ],
  },
  "attention.list": {
    kind: "COMMAND",
    summary: "列出项目当前打开的 Attention",
    usage: `bun run codeestra attention list <project-id>`,
    runtime: [
      "attention.list",
    ],
  },
  "attention.resolve": {
    kind: "COMMAND",
    summary: "收口一条没有 provider dialog 的等待（散文提问）：--dismiss 或 --answer",
    usage: `bun run codeestra attention resolve <project-id> <attention-id> --dismiss [--note <text>] [--json]`,
    variants: [
      `bun run codeestra attention resolve <project-id> <attention-id> --answer <text> [--note <text>] [--json]`,
    ],
    detail: `attention resolve ends a prose-question wait: an Agent that used no tool and ended its turn by
asking its question in ordinary prose leaves a Task whose provider process already exited. The
Runtime records that as its own Attention (a heuristic about the shape of the ending, never a claim
about intent) and puts the Task in WAITING_FOR_USER; --dismiss records a false alarm, --answer
records the user's own text. Neither resumes the conversation and neither is a TaskRevision: an
answer is a statement about this wait, not an amendment of the specification. Delivering one through
attention answer is refused with PROSE_QUESTION_RESOLUTION_REQUIRED, because there is no provider
dialog to write to.`,
    runtime: [
      "attention.resolve",
    ],
  },
  "events": {
    kind: "GROUP",
    summary: "领域事件流：按游标读一次，或持续 tail",
  },
  "events.list": {
    kind: "COMMAND",
    summary: "按游标读一批领域事件",
    usage: `bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>] [--json]`,
    runtime: [
      "events.list",
    ],
  },
  "events.tail": {
    kind: "COMMAND",
    summary: "持续跟随领域事件流",
    usage: `bun run codeestra events tail [--project <project-id>] [--since <sequence>]`,
    runtime: [
      "events.subscribe",
    ],
  },
  "help": {
    kind: "COMMAND",
    summary: "说明某一层有哪些命令以及各自的大致功能范围（这份清单本身由命令树生成）",
    resolverHandled: true,
    usage: `bun run codeestra help [<命令路径…>] [--json]`,
    detail: `# help 是本客户端自己的命令：它只读命令树，不连 Runtime、不启动 Runtime、不写任何东西。
    # 三种拼写等价：\`codeestra help [<路径…>]\`、\`codeestra <路径…> help\`、\`codeestra <路径…> --help|-h\`。
    # 退出码 0；用法错误（未知命令、缺少子命令、多余参数）退 2 并只打印一行，提示对应层的 help。`,
  },
  "project": {
    kind: "GROUP",
    summary: "项目：身份、信任、验证策略、影响映射与项目知识",
  },
  "project.impact": {
    kind: "GROUP",
    summary: "确定性冲突分析：把改动映射到 main ref 的 .codeestra/impact.json 再比对（ADR-0031）",
    unit: true,
    detail: `project impact is deterministic conflict analysis: it maps the owned worktree's Git change set onto
the .codeestra/impact.json mapping at the project main ref and compares it with every Task that
currently holds a resource. It is read-only, it never starts or schedules a Task, and it uses no
model: the verdict is SAFE_TO_PARALLELIZE, UNKNOWN, or CONFLICTING, each with stable reason codes and
the exact intersecting paths, directories, modules, or shared resources. show prints one Task's
ImpactSnapshot, explain explains a verdict against the active Tasks, and validate reports whether a
mapping is present at the main ref and is the digest project trust confirmed. UNKNOWN is recorded
for every Task whose mapping is missing, unconfirmed, invalid, or empty, and for any active Task
whose change set cannot be observed — that is the point: nothing is called safe without proof.`,
  },
  "project.impact.explain": {
    kind: "COMMAND",
    summary: "解释某 Task 相对活动集合的判定（SAFE / UNKNOWN / CONFLICTING）",
    usage: `bun run codeestra project impact explain <project-id> <task-id> [--json]`,
    detail: `# exit 0 for validate only when a mapping exists at the main ref and is the confirmed one;
# exit 0 for explain only for SAFE_TO_PARALLELIZE. UNKNOWN means "cannot be proven", not
# "no conflict", and exits 1 like CONFLICTING does (the code is in --json).`,
    runtime: [
      "project.impact.explain",
    ],
  },
  "project.impact.show": {
    kind: "COMMAND",
    summary: "读回某个 Task 已记录的 ImpactSnapshot",
    usage: `bun run codeestra project impact show <project-id> <task-id> [--json]`,
    runtime: [
      "project.impact.show",
    ],
  },
  "project.impact.validate": {
    kind: "COMMAND",
    summary: "报告影响映射是否存在、是否为已确认的那一份",
    usage: `bun run codeestra project impact validate [path] [--json]`,
    runtime: [
      "project.impact.validate",
    ],
  },
  "project.inspect": {
    kind: "COMMAND",
    summary: "看一个项目文件夹的仓库身份，并说明建 Task workspace 时的基线",
    usage: `bun run codeestra project inspect [path]`,
    runtime: [
      "project.inspect",
    ],
  },
  "project.knowledge": {
    kind: "GROUP",
    summary: "分层项目知识：人工层只从 main ref 读，机器层读写都在 Runtime 数据目录（ADR-0041）",
    unit: true,
    detail: `project knowledge is the layered knowledge of PROJECT_SPEC section 4: human-maintained instructions
and skills, plus a machine-generated layer the Runtime owns. The human layers are read from the
project main ref, never from a Task branch, and the machine layer lives under the Runtime data
directory rather than inside the project tree, so it cannot be committed by accident. There is no
override semantics: every human entry that parses is in the snapshot, a duplicate id or path is a
refusal, and a layer with any refused entry produces no snapshot at all — which is what makes it
impossible for a machine to silently replace human knowledge. validate and list report every
refusal, show reads back one recorded snapshot with the Executions bound to it, and resolve reports`,
  },
  "project.knowledge.list": {
    kind: "COMMAND",
    summary: "列出项目知识层的条目与来源",
    usage: `bun run codeestra project knowledge list <project-id> [--json]`,
    runtime: [
      "project.knowledge.list",
    ],
  },
  "project.knowledge.resolve": {
    kind: "COMMAND",
    summary: "报告某 Task 的下一个 Execution 会用到什么知识，且不启动它",
    usage: `bun run codeestra project knowledge resolve <project-id> <task-id> [--json]`,
    detail: `# The human-maintained layers (.codeestra/instructions, .codeestra/skills) are read from the
# project main ref only, so a Task branch can never rewrite the knowledge that judges its own
# execution. The machine-generated layer is Runtime data, not part of the project tree. validate
# and list exit 1 when any entry is refused (there is then no snapshot at all); show exits 1 when
# the project has no recorded snapshot; resolve reports what the next Execution would use and
# exits 1 only when no honest answer exists.`,
    runtime: [
      "project.knowledge.resolve",
    ],
  },
  "project.knowledge.show": {
    kind: "COMMAND",
    summary: "读回某个已记录的 Execution 知识快照",
    usage: `bun run codeestra project knowledge show <project-id> [snapshot-id] [--json]`,
    runtime: [
      "project.knowledge.show",
    ],
  },
  "project.knowledge.validate": {
    kind: "COMMAND",
    summary: "逐条报告知识层被拒的条目（有拒条目时整层不出快照）",
    usage: `bun run codeestra project knowledge validate <project-id> [--json]`,
    runtime: [
      "project.knowledge.validate",
    ],
  },
  "project.list": {
    kind: "COMMAND",
    summary: "列出已注册（trust）的项目",
    usage: `bun run codeestra project list`,
    detail: `# ADR-0066: the product no longer models a dev clone, a long-lived dev branch, integration into
# it or dev→main promotion, so there is no \`--dev-repo\` flag and no DEV_REPO_* code. A Task
# worktree is based on the branch the project folder has checked out right now, fixed with the
# workspace; a detached HEAD there is refused with TASK_BASE_REF_UNRESOLVED (check out a branch,
# or pass --base-ref to task run). project inspect reports the repository identity and says the
# baseline in one line.`,
    runtime: [
      "project.list",
    ],
  },
  "project.policy": {
    kind: "COMMAND",
    summary: "读该项目 main ref 上的人工验证策略",
    usage: `bun run codeestra project policy [path]`,
    runtime: [
      "project.verificationPolicy",
    ],
  },
  "project.trust": {
    kind: "COMMAND",
    summary: "把一个项目文件夹接入本 Runtime（FULL 下零确认）",
    usage: `bun run codeestra project trust [path] [--yes]`,
    runtime: [
      "project.trust",
    ],
  },
  "reclaim": {
    kind: "GROUP",
    summary: "回收 Runtime 自有资源（worktree、验证副本），默认 dry-run 且保留失败现场",
    unit: true,
  },
  "reclaim.apply": {
    kind: "COMMAND",
    summary: "真正回收（只删归属校验通过的三类资源，默认保留失败现场）",
    usage: `bun run codeestra reclaim apply [--project <project-id> | --all-projects] [--task <task-id>] [--kind <kind>]… [--include-failure-scenes] [--unregistered] [--scan-root <path-inside-home>] [--remove-unregistered <path>]… [--json]`,
    runtime: [
      "reclaim.apply",
    ],
  },
  "reclaim.plan": {
    kind: "COMMAND",
    summary: "只读干跑：列出会被回收的资源，不删任何东西",
    usage: `bun run codeestra reclaim plan [--project <project-id> | --all-projects] [--task <task-id>] [--kind <TASK_WORKTREE|VERIFICATION_COPY|INTEGRATION_WORKTREE>]… [--include-failure-scenes] [--unregistered] [--scan-root <path-inside-home>] [--remove-unregistered <path>]… [--json]`,
    runtime: [
      "reclaim.plan",
    ],
  },
  "reclaim.records": {
    kind: "COMMAND",
    summary: "读 append-only 的回收账本",
    usage: `bun run codeestra reclaim records [--project <project-id> | --all-projects] [--task <task-id>] [--source <ALL|REGISTERED|UNREGISTERED_DIRECTORY>] [--since <epoch-ms|ISO>] [--until <epoch-ms|ISO>] [--limit <n>] [--json]`,
    runtime: [
      "reclaim.records",
    ],
  },
  "runtime": {
    kind: "GROUP",
    summary: "Runtime 命令面自身的发现入口",
  },
  "runtime.commands": {
    kind: "COMMAND",
    summary: "列出 Runtime 的每一条 versioned 命令及其大致功能范围",
    usage: `bun run codeestra runtime commands [--json]`,
    detail: `# Runtime 命令面自身的发现入口：列出这个 Runtime 接受的每一条 versioned 命令、它属于哪一组、
    # 以及一行功能范围。它读的是契约里的 request union（命令名与 Runtime 的 switch 同源），因此不会
    # 列出 Runtime 不接受的命令。CLI 的每一个命令都应当能追到这里的某一条（ADR-0068）。`,
    runtime: [
      "runtime.commands",
    ],
  },
  "scheduler": {
    kind: "GROUP",
    summary: "调度器：全局容量、槽位预留、全局暂停/继续",
    unit: true,
  },
  "scheduler.capacity": {
    kind: "GROUP",
    summary: "Runtime 全局并发容量（唯一跨项目上限，ADR-0061）",
  },
  "scheduler.capacity.get": {
    kind: "COMMAND",
    summary: "读这条唯一上限、它的来源、当前占用者与放行/等待原因码",
    usage: `bun run codeestra scheduler capacity get [--json]`,
    detail: `scheduler capacity get reports the **Runtime-wide** concurrency facts a scheduler uses: the single
limit for this CODEESTRA_HOME and where it came from, how many slots are occupied across every
project with the occupiers themselves (project, task, adapter, since, reservation or Execution), the
stable reason code a new acquisition would get right now, the global control state, and whether the
Runtime is draining. It takes no project and no adapter: a candidate's project and adapter no longer
produce a second ceiling. scheduler capacity set --limit <n> writes that one limit and reset removes
the explicit value so the documented default 2 applies again; both are zero-confirmation, both read
the value back, and writing the value that is already effective is an idempotent no-op. An invalid
limit (0, negative, above the ceiling) is refused with its own stable code instead of being clamped.
Exit codes: 0 written or read, 1 refused (CAPACITY_LIMIT_INVALID / CAPACITY_LIMIT_OUT_OF_RANGE), 2
usage. CAPACITY_ADAPTER_SLOT_LIMIT_REACHED is historical: no code path produces it any more, and it
stays readable in old events and old command results.`,
    runtime: [
      "scheduler.capacity.get",
    ],
  },
  "scheduler.capacity.reset": {
    kind: "COMMAND",
    summary: "删除显式上限，回到文档默认值",
    usage: `bun run codeestra scheduler capacity reset [--json]`,
    runtime: [
      "scheduler.capacity.reset",
    ],
  },
  "scheduler.capacity.set": {
    kind: "COMMAND",
    summary: "写这条唯一上限（零确认、写后读回、幂等）",
    usage: `bun run codeestra scheduler capacity set --limit <n> [--json]`,
    runtime: [
      "scheduler.capacity.set",
    ],
  },
  "scheduler.control": {
    kind: "GROUP",
    summary: "全局负载控制：跨重启持久的暂停屏障与 Provider 主进程冻结（ADR-0061 D09）",
    detail: `The Runtime global load control (ADR-0061). It belongs to no Project: one CODEESTRA_HOME has one
host-wide barrier. pause freezes the admitted execution set at the process level — no new
Execution/Session starts and no new Provider delivery, while running tasks keep their Task,
Execution and Session state and their capacity slot. resume continues exactly the processes this
pause epoch verified and froze; a target whose pid changed or exited is reported instead of being
woken. Exit codes: 0 reached the complete target state (or it was already there); 1 a target could
not be verified, the platform cannot freeze a provider, or a resume is still in flight, with the
stable code (GLOBAL_PAUSE_UNSUPPORTED, GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE,
GLOBAL_PAUSE_TARGET_NOT_STOPPED, GLOBAL_RESUME_TARGET_CHANGED, GLOBAL_PAUSE_RECOVERY_REQUIRED,
GLOBAL_CONTROL_IN_PROGRESS) in --json and on stderr; 3 is used only by a Task that *waits* for the
barrier (SCHEDULER_GLOBALLY_PAUSED), never for a partially frozen Runtime. reconcile only observes
and records: it sends no signal, and it never turns an unverifiable target into a stopped one.`,
  },
  "scheduler.control.pause": {
    kind: "COMMAND",
    summary: "冻结模型驱动：持久化屏障后按 pid + start token + incarnation 核验冻结",
    usage: `bun run codeestra scheduler control pause [--json]`,
    runtime: [
      "scheduler.control.pause",
    ],
  },
  "scheduler.control.reconcile": {
    kind: "COMMAND",
    summary: "按观察对账冻结目标（不发信号、不改写 Task 生命周期状态）",
    usage: `bun run codeestra scheduler control reconcile [--json]`,
    runtime: [
      "scheduler.control.reconcile",
    ],
  },
  "scheduler.control.resume": {
    kind: "COMMAND",
    summary: "解除冻结（只有显式继续才会解除）",
    usage: `bun run codeestra scheduler control resume [--json]`,
    runtime: [
      "scheduler.control.resume",
    ],
  },
  "scheduler.control.status": {
    kind: "COMMAND",
    summary: "读全局控制状态与每个冻结目标的核验事实",
    usage: `bun run codeestra scheduler control status [--json]`,
    runtime: [
      "scheduler.control.status",
    ],
  },
  "scheduler.reservations": {
    kind: "GROUP",
    summary: "槽位预留：把「谁占着、凭什么占」写成 schema 事实",
  },
  "scheduler.reservations.acquire": {
    kind: "COMMAND",
    summary: "在一个事务里重核版本/依赖/快照代际/容量后记录一条预留",
    usage: `bun run codeestra scheduler reservations acquire <project-id> <task-id> <expected-task-version> --revision <revision-id> [--snapshot <impact-snapshot-id>] [--adapter <id>] [--json]`,
    detail: `scheduler reservations acquire is the reservation primitive: it re-checks the Task version, the
assessed revision, the dependency facts, the cached ImpactSnapshot generation and both capacity
dimensions inside one immediate transaction, then records a reservation together with the evidence of
who created it (Runtime boot, pid, OS start token). --snapshot names the ImpactSnapshot the caller
assessed against: the mapping version, analyzer version and observed change set are read again, and
the Task revision and worktree baseline are re-read inside the write transaction, so a generation that
moved is refused with SNAPSHOT_STALE (or SNAPSHOT_UNAVAILABLE when it cannot be confirmed at all)
and no reservation row is written — the recheck is freshness, not a second conflict analysis. Exit code
0 means a slot is held, 3 means a *capacity wait* (the reason code says which limit), and 1 means a
refusal (unmet dependencies, a stale revision, a stale snapshot generation, an already-held slot, ...).
A refusal that carries facts prints them as JSON and then exits 1. Exit code 3 is never BLOCKED:
BLOCKED means unmet dependencies only.`,
    runtime: [
      "scheduler.reservations.acquire",
    ],
  },
  "scheduler.reservations.get": {
    kind: "COMMAND",
    summary: "按 reservation-id 读回一条预留及其历史",
    usage: `bun run codeestra scheduler reservations get <project-id> <reservation-id> [--json]`,
    runtime: [
      "scheduler.reservations.get",
    ],
  },
  "scheduler.reservations.list": {
    kind: "COMMAND",
    summary: "列出项目的活动预留及其持有者证据与历史",
    usage: `bun run codeestra scheduler reservations list <project-id> [--task <task-id>] [--include-released] [--limit <n>] [--json]`,
    detail: `scheduler reservations list shows the active reservations of a project with their holder evidence and
their append-only history (--include-released keeps the audit rows), and get reads one reservation
back by id together with that same history. release is explicit and requires
--reason; nothing releases a slot because a heartbeat expired, a client disappeared or a user waited.
A release refused with SLOT_HOLDER_STILL_RUNNING means the recorded holder process is provably still
alive and was not signalled. prepare-workspace prepares the Task worktree for one reservation and
binds it, and reconcile re-checks every active reservation's recorded holder against the real process
table: a holder proven gone is released and recorded, while a holder that is alive or unverifiable
keeps the slot (RECOVERY_REQUIRED) — no process is signalled and no resource is deleted.`,
    runtime: [
      "scheduler.reservations.list",
    ],
  },
  "scheduler.reservations.prepare-workspace": {
    kind: "COMMAND",
    summary: "为一条预留准备并绑定 Task 工作树",
    usage: `bun run codeestra scheduler reservations prepare-workspace <project-id> <reservation-id> <expected-task-version> [--json]`,
    runtime: [
      "scheduler.reservations.workspace.prepare",
    ],
  },
  "scheduler.reservations.reconcile": {
    kind: "COMMAND",
    summary: "把每条活动预留的持有者与真实进程表对账（能证明已消失才释放）",
    usage: `bun run codeestra scheduler reservations reconcile <project-id> [--json]`,
    runtime: [
      "scheduler.reservations.reconcile",
    ],
  },
  "scheduler.reservations.release": {
    kind: "COMMAND",
    summary: "显式释放一条预留（必须给 --reason）",
    usage: `bun run codeestra scheduler reservations release <project-id> <reservation-id> --reason <text> [--json]`,
    runtime: [
      "scheduler.reservations.release",
    ],
  },
  "session": {
    kind: "GROUP",
    summary: "会话：只读转写、Session Guidance、原生终端交接",
  },
  "session.guidance": {
    kind: "GROUP",
    summary: "Session Guidance 的只读账本",
    unit: true,
  },
  "session.guidance.get": {
    kind: "COMMAND",
    summary: "按 guidance-id 读回一条 guidance 及其执行绑定",
    usage: `bun run codeestra session guidance get <project-id> <guidance-id> [--json]`,
    runtime: [
      "session.guidance.get",
    ],
  },
  "session.guidance.list": {
    kind: "COMMAND",
    summary: "列出某 Task 的 guidance 记录与投递尝试",
    usage: `bun run codeestra session guidance list <project-id> <task-id> [--json]`,
    runtime: [
      "session.guidance.list",
    ],
  },
  "session.guide": {
    kind: "COMMAND",
    summary: "投递一条 Session Guidance：立即影响当前执行，但不产生 TaskRevision",
    usage: `bun run codeestra session guide <project-id> <task-id> --message <text> [--json]`,
    detail: `# Session Guidance, not a TaskRevision: it never changes the specification and never invalidates
# a verification. exit 0 = handed to the running conversation or recorded with nothing running;
# 1 = a provider was asked and did not take it (CHANNEL_UNSUPPORTED/TIMED_OUT/FAILED).
# "delivered" means the provider's channel accepted the message (enqueued), not that the model
# read it (ADR-0051/0057).`,
    runtime: [
      "session.guidance.record",
    ],
  },
  "session.handoff": {
    kind: "GROUP",
    summary: "原生终端交接（ADR-0023/0026）：incarnation、单 writer lease、安全点与接纳",
    unit: true,
    detail: `session handoff projects the Runtime-side handoff contract: the provider incarnation history, the
single writer lease, the handoff fence/safe point and the admission decision. A second writer lease
acquisition exits 1 with ATTACHMENT_BUSY, and a refused admission exits 1. admit really starts the
successor — a PTY-hosted native terminal for takeover, an RPC provider for the return — so it is the
command that moves the lease; it refuses before recording anything rather than leaving a half-started
successor, and an already admitted request replays the successor it recorded instead of starting a
second one.`,
  },
  "session.handoff.admit": {
    kind: "COMMAND",
    summary: "真正启动 successor（PTY 原生终端或 RPC provider），并移动 lease",
    usage: `bun run codeestra session handoff admit <project-id> <session-id>`,
    runtime: [
      "session.handoff.admit",
    ],
  },
  "session.handoff.attach": {
    kind: "COMMAND",
    summary: "接入原生终端流（最多一个写者；detach 不终止终端与 provider）",
    usage: `bun run codeestra session handoff attach <project-id> <session-id> --holder <ref> [--writer|--observer] [--since <cursor>]`,
    detail: `session handoff attach/detach/release are the native terminal face: attach returns the projected
terminal stream from a cursor (at most one writer attachment; a second one exits 1 with
ATTACHMENT_BUSY), detach leaves the terminal and the provider running, and release writes the
terminal's own release byte, verifies the provider process exited and the provider session file still
holds the conversation, then hands it back to automation on the same session file. Exit code 1 means
the release or the successor start could not be confirmed — never "probably fine".`,
    runtime: [
      "session.handoff.attach",
    ],
  },
  "session.handoff.cancel": {
    kind: "COMMAND",
    summary: "取消一次交接请求",
    usage: `bun run codeestra session handoff cancel <project-id> <session-id>`,
    runtime: [
      "session.handoff.cancel",
    ],
  },
  "session.handoff.detach": {
    kind: "COMMAND",
    summary: "离开原生终端，保留终端与 provider 继续运行",
    usage: `bun run codeestra session handoff detach <project-id> <session-id> --holder <ref>`,
    runtime: [
      "session.handoff.detach",
    ],
  },
  "session.handoff.release": {
    kind: "COMMAND",
    summary: "交还给自动化：写 release 字节、核验 provider 已退出、复用同一会话文件",
    usage: `bun run codeestra session handoff release <project-id> <session-id> [--no-resume]`,
    runtime: [
      "session.handoff.release",
    ],
  },
  "session.handoff.request": {
    kind: "COMMAND",
    summary: "记录一次交接请求（takeover 或 return）",
    usage: `bun run codeestra session handoff request <project-id> <session-id> <takeover|return>`,
    runtime: [
      "session.handoff.request",
    ],
  },
  "session.handoff.status": {
    kind: "COMMAND",
    summary: "读回交接状态：incarnation 历史、writer lease、fence 与接纳判定",
    usage: `bun run codeestra session handoff status <project-id> <session-id> [--json]`,
    runtime: [
      "session.handoff.status",
    ],
  },
  "session.handoff.terminal": {
    kind: "GROUP",
    summary: "原生终端的 versioned 传输（读 / 写 / resize）",
  },
  "session.handoff.terminal.read": {
    kind: "COMMAND",
    summary: "从游标读终端输出",
    usage: `bun run codeestra session handoff terminal read <project-id> <session-id> [--since <cursor>]`,
    runtime: [
      "session.handoff.terminal.read",
    ],
  },
  "session.handoff.terminal.resize": {
    kind: "COMMAND",
    summary: "调整终端尺寸（作用在 slave fd 上的 stty）",
    usage: `bun run codeestra session handoff terminal resize <project-id> <session-id> --cols <n> --rows <n> [--holder <ref>] [--json]`,
    detail: `# exit 0 only when the PTY really changed size (the transport's own answer), 1 when it refused
# (not held, writer seat taken) or did not take effect, 2 for an out-of-range size`,
    runtime: [
      "session.handoff.terminal.resize",
    ],
  },
  "session.handoff.terminal.write": {
    kind: "COMMAND",
    summary: "向终端写文本",
    usage: `bun run codeestra session handoff terminal write <project-id> <session-id> --text <text>`,
    runtime: [
      "session.handoff.terminal.write",
    ],
  },
  "session.handoff.writer": {
    kind: "GROUP",
    summary: "session writer lease（任意时刻最多一个 writer）",
  },
  "session.handoff.writer.acquire": {
    kind: "COMMAND",
    summary: "申请 writer lease（已被占用则 ATTACHMENT_BUSY 退 1）",
    usage: `bun run codeestra session handoff writer acquire <project-id> <session-id> --holder <ref> [--kind AUTOMATED_RPC|TERMINAL_ATTACHMENT]`,
    runtime: [
      "session.handoff.writer.acquire",
    ],
  },
  "session.handoff.writer.release": {
    kind: "COMMAND",
    summary: "释放 writer lease",
    usage: `bun run codeestra session handoff writer release <project-id> <session-id> --holder <ref>`,
    runtime: [
      "session.handoff.writer.release",
    ],
  },
  "session.transcript": {
    kind: "COMMAND",
    summary: "只读展示某个 Session 的 provider 转写（工具调用、助手文本、thinking、用量）",
    usage: `bun run codeestra session transcript <session-id> [--after <entry-id>] [--limit <n>] [--reverse] [--json]`,
    detail: `--reverse prints the newest transcript entry first. It is a rendering choice for the human view
only (it is refused together with --json), and because the command face reads forward from a cursor
it may read up to ${maxTranscriptReverseReads} pages to reach the newest entries.`,
    runtime: [
      "session.transcript",
    ],
  },
  "session.transcript.part": {
    kind: "COMMAND",
    summary: "读回转写中某一条目的某一段完整内容",
    usage: `bun run codeestra session transcript part <session-id> <entry-id> <part-index>`,
    runtime: [
      "session.transcript.part",
    ],
  },
  "settings": {
    kind: "GROUP",
    summary: "Runtime 级设置的总览与逐项读写（权限模式、散文提问、全局并发上限）",
  },
  "settings.concurrency": {
    kind: "GROUP",
    summary: "全局并发上限的设置面拼写（与 scheduler capacity 同一条 Runtime 命令）",
    unit: true,
    detail: `settings concurrency is the settings spelling of the one Runtime-wide concurrency limit (ADR-0061):
get, set --limit <n> and reset send exactly the same Runtime commands as scheduler capacity, so the
value, its audit event and its idempotency can never diverge between the two spellings. It is a
setting, not a gate: zero confirmations, same behavior in FULL and STRICT, and a change takes effect
on the next scheduling decision — raising it triggers a scheduling pass for every project (a Task
waiting on capacity can therefore start immediately), while lowering it never pauses, releases or
terminates a Task that already holds a slot. Invalid limits are refused with the same stable codes.`,
  },
  "settings.concurrency.get": {
    kind: "COMMAND",
    summary: "读全局并发上限与占用事实的摘要",
    usage: `bun run codeestra settings concurrency get [--json]`,
    runtime: [
      "scheduler.capacity.get",
    ],
  },
  "settings.concurrency.reset": {
    kind: "COMMAND",
    summary: "删除显式上限，回到文档默认值",
    usage: `bun run codeestra settings concurrency reset [--json]`,
    runtime: [
      "scheduler.capacity.reset",
    ],
  },
  "settings.concurrency.set": {
    kind: "COMMAND",
    summary: "写全局并发上限（马上生效，不抢占已在跑的任务）",
    usage: `bun run codeestra settings concurrency set --limit <n> [--json]`,
    runtime: [
      "scheduler.capacity.set",
    ],
  },
  "settings.list": {
    kind: "COMMAND",
    summary: "总览当前启用中的全部 Runtime 级设置（只读、零确认）",
    usage: `bun run codeestra settings list [--json]`,
    detail: `settings list is the overview of every enabled Runtime-level setting (ADR-0064/0067): the
permission mode, the prose-question switch and the one concurrency limit, each with its effective
value, its product default, whether it is this Runtime home's own choice or the product default, the
values it accepts and where it is stored. Every entry comes from the same read its own command uses,
so the list cannot disagree with settings permission get, settings prose-question-attention or
scheduler capacity get. Human-readable by default; --json prints the whole record.`,
    runtime: [
      "settings.list",
    ],
  },
  "settings.permission": {
    kind: "GROUP",
    summary: "权限模式：FULL（默认，零确认）与 STRICT（显式 opt-in，恢复旧门禁）",
    unit: true,
    detail: `settings permission reads or writes the permission mode (ADR-0011). It is a setting like any other:
get reports the mode in force with the product default, set accepts a case-insensitive full|strict,
needs no confirmation, and writes $CODEESTRA_HOME/permission-mode.json (0600, atomic replacement).
The mode applies to new operations and new Agent sessions; a Session already running keeps the mode
it started with.`,
  },
  "settings.permission.get": {
    kind: "COMMAND",
    summary: "读当前权限模式及其默认值",
    usage: `bun run codeestra settings permission get [--json]`,
    runtime: [
      "permission.get",
    ],
  },
  "settings.permission.set": {
    kind: "COMMAND",
    summary: "切换权限模式（无确认）",
    usage: `bun run codeestra settings permission set <full|strict> [--json]`,
    runtime: [
      "permission.set",
    ],
  },
  "settings.prose-question-attention": {
    kind: "COMMAND",
    summary: "散文提问是否升级为等待：auto（默认）/ record-only / off",
    usage: `bun run codeestra settings prose-question-attention [auto|record-only|off] [--json]`,
    detail: `settings prose-question-attention reads or writes the global switch that decides
whether such a completion becomes a wait at all (auto, the default; record-only; off). Changing it
needs no confirmation and never rewrites a wait that was already recorded.`,
    runtime: [
      "settings.proseQuestionAttention.get",
      "settings.proseQuestionAttention.set",
    ],
  },
  "status": {
    kind: "COMMAND",
    summary: "报告本 Runtime 的状态与所有权证据（必要时先拉起 Runtime）",
    usage: `bun run codeestra status`,
    detail: `status starts the Runtime when none is running and prints the runtime.ping result together with an
ownership report read from this home's lifecycle records: the lock, the boot traces, and whether
the endpoint answers. It is read-only, so an unreachable Runtime process is reported rather than
replaced. Exit code 1 means the Runtime could not be reached or started.`,
    runtime: [
      "runtime.ping",
    ],
  },
  "stop": {
    kind: "COMMAND",
    summary: "请求本 home 的 Runtime 停机，并按 pid + start token 核验它真的退出",
    usage: `bun run codeestra stop [--wait <seconds>]`,
    detail: `stop asks the Runtime that owns this CODEESTRA_HOME to shut down and then checks the process it
named until it is gone (default 10s, bounded by --wait). It reports STOPPED (exit 0), NOT_EXITED
(exit 1) when the process is still there, NOT_RUNNING when no Runtime owns this home, and
UNREACHABLE_PROCESS (exit 1) when a Runtime process is still there but nothing answers on its
socket. It never starts a Runtime to stop it and never signals a process it cannot identify.`,
    runtime: [
      "runtime.stop",
    ],
  },
  "task": {
    kind: "GROUP",
    summary: "Task 生命周期：创建、调度、执行、控制、修订、成果与验证",
  },
  "task.archive": {
    kind: "COMMAND",
    summary: "归档（软删除：只写 archived_at，默认列表隐藏）",
    usage: `bun run codeestra task archive <project-id> <task-id> <expected-version>`,
    runtime: [
      "task.archive",
    ],
  },
  "task.cancel": {
    kind: "COMMAND",
    summary: "终止任务（终态 CANCELLED，不自动重开，审计与证据保留）",
    usage: `bun run codeestra task cancel <project-id> <task-id> <expected-version>`,
    runtime: [
      "task.cancel",
    ],
  },
  "task.create": {
    kind: "COMMAND",
    summary: "新建 Task（三个必填字段：显示标题、命名标题、任务详情）",
    usage: `bun run codeestra task create <project-id> <任务详情…> --title <显示标题> --name <命名标题> [--feature <module-id>]…`,
    detail: `# 三个字段都必须给出（ADR-0065）：--title 是一句话摘要（任务列表显示它），
# --name 是小写英文短横线 slug（^[a-z][a-z0-9]*(-[a-z0-9]+)*$，≤ 50 字符），
# 用于分支 task/<编号>-<name> 与 worktree 目录；位置参数是任务详情。缺任一字段退出码 2。
# --feature declares the feature(s) this Task works on: module ids from the project's
# .codeestra/impact.json as read from its main ref. The Runtime refuses an id the mapping does
# not declare (UNKNOWN_FEATURE), and refuses any declaration when the mapping cannot be read.
# A Task that declares nothing is never in a feature conflict (ADR-0059).
# --constraint 与 --kind 已删除（ADR-0065），传入会被当作未知 flag。`,
    runtime: [
      "task.create",
    ],
  },
  "task.depends": {
    kind: "GROUP",
    summary: "任务依赖（DAG）：add / remove / list",
    unit: true,
  },
  "task.depends.add": {
    kind: "COMMAND",
    summary: "增加一条依赖（写入前检测环，失败不部分应用）",
    usage: `bun run codeestra task depends add <project-id> <task-id> <expected-version> <prerequisite-task-id> [--revision <revision-id>] [--json]`,
    runtime: [
      "task.depends.add",
    ],
  },
  "task.depends.list": {
    kind: "COMMAND",
    summary: "列出依赖关系，以及上游 result commit 是否对基线可达",
    usage: `bun run codeestra task depends list <project-id> [task-id] [--json]`,
    runtime: [
      "task.depends.list",
    ],
  },
  "task.depends.remove": {
    kind: "COMMAND",
    summary: "删除一条依赖",
    usage: `bun run codeestra task depends remove <project-id> <task-id> <expected-version> <prerequisite-task-id> [--json]`,
    runtime: [
      "task.depends.remove",
    ],
  },
  "task.list": {
    kind: "COMMAND",
    summary: "列出项目的 Task（--all 含已归档）",
    usage: `bun run codeestra task list <project-id> [--all]`,
    runtime: [
      "task.list",
    ],
  },
  "task.operation": {
    kind: "GROUP",
    summary: "长命令 Operation：进度、结果与取消",
    unit: true,
  },
  "task.operation.cancel": {
    kind: "COMMAND",
    summary: "取消一个 Operation（先确认进程静止，未确认则 RECONCILE_REQUIRED）",
    usage: `bun run codeestra task operation cancel <project-id> <task-id> <operation-id> [--json]`,
    runtime: [
      "task.operation.cancel",
    ],
  },
  "task.operation.get": {
    kind: "COMMAND",
    summary: "按 operation-id 读回一个 Operation 的步骤级进度",
    usage: `bun run codeestra task operation get <project-id> <operation-id> [--json]`,
    runtime: [
      "task.operation.get",
    ],
  },
  "task.operation.list": {
    kind: "COMMAND",
    summary: "列出某 Task 的 Operation",
    usage: `bun run codeestra task operation list <project-id> <task-id> [--json]`,
    runtime: [
      "task.operation.list",
    ],
  },
  "task.pause": {
    kind: "COMMAND",
    summary: "协作暂停：确认 provider 已退出后才落 PAUSED，保留工作树与会话证据",
    usage: `bun run codeestra task pause <project-id> <task-id> <expected-version>`,
    runtime: [
      "task.pause",
    ],
  },
  "task.purge": {
    kind: "COMMAND",
    summary: "永久删除任务及其资源（唯一显式 --yes，不在任何常态路径上）",
    usage: `bun run codeestra task purge <project-id> <task-id> <expected-version> --yes [--force] [--reason <text>] [--json]`,
    detail: `# DESTRUCTIVE and irreversible: deletes the Task, its revisions, executions, sessions, evidence,
# owned worktrees, verification copies and branches. A non-terminal Task is cancelled first
# through the ordinary cooperative stop, and a RECOVERY_REQUIRED Task is reconciled by
# observation first (the "task recover" rule; result stop.stop: "RECOVERED"); a stop or a
# provider that cannot be proven gone deletes nothing (RECONCILE_REQUIRED, exit 1).
# --yes is required and is the only guard; without it the command exits 2 without sending
# anything. --force (ADR-0058 D09) is the same caller saying "delete it anyway": the Runtime
# first tries to terminate the provider processes the Task recorded (identity-verified pids
# only), then deletes what it otherwise would have refused — a provider it could not prove gone
# and resources whose ownership it cannot prove (those files are left on disk).
# Everything stepped over is printed to stderr and recorded in the forced field of the view
# (stop.stop: "FORCED") and in the TaskPurged audit event. Replaying the same command ID returns
# the receipt instead of a second deletion.
# stdout is the printed view (JSON shape regardless of --json), including rowsDeleted,
# dependencyEdgesRemoved and the tip commit of every branch that was deleted.`,
    runtime: [
      "task.purge",
    ],
  },
  "task.recover": {
    kind: "COMMAND",
    summary: "对 RECOVERY_REQUIRED 任务按事实对账，只在能证明 provider 已消失时收口",
    usage: `bun run codeestra task recover <project-id> <task-id> <expected-version> [--reason <text>] [--json]`,
    detail: `The reconcile of a RECOVERY_REQUIRED Task (ADR-0055), the step the state machine promised and no
command face had. It reads real facts only — the recorded provider process identity (checked
against the real process table, start token and descendants), the recorded descendant snapshot,
and whether the recorded workspace is still on disk — and it changes something only when the
provider is provably gone: Execution and Task become FAILED (the resource is released), the
Session becomes EXITED, and the workspace becomes RETAINED. It never signals a process, never
removes or moves a worktree, never rewrites exit_json and never claims quiescence
(quiescenceProven: false, signalsSent: 0). A refusal changes nothing and exits 1 with
RECOVERY_PROVIDER_ALIVE / RECOVERY_DESCENDANTS_ALIVE / RECOVERY_OWNERSHIP_UNVERIFIABLE /
RECOVERY_PROCESS_IDENTITY_MISSING; TASK_NOT_IN_RECOVERY is exit 1 as well, ALREADY_RECONCILED is
exit 0 and read-only. After it, "task retry" can requeue the Task and "task cancel" can retire it
("task purge" performs this same reconcile itself before deleting, so a manual recover is optional).`,
    runtime: [
      "task.recover",
    ],
  },
  "task.result": {
    kind: "GROUP",
    summary: "成果 commit：固定 HEAD/ChangeSet/revision，只在已核验归属的 worktree 提交",
    unit: true,
  },
  "task.result.capture": {
    kind: "COMMAND",
    summary: "FULL 下的单步成果提交（不确认、不应用敏感路径拒绝）",
    usage: `bun run codeestra task result capture <project-id> <task-id> [execution-id]`,
    runtime: [
      "task.result.capture",
    ],
  },
  "task.result.commit": {
    kind: "COMMAND",
    summary: "STRICT 下的两步成果提交第二步：带 authorization-id 确认提交",
    usage: `bun run codeestra task result commit <project-id> <task-id> <authorization-id> --confirm`,
    runtime: [
      "task.result.commit",
    ],
  },
  "task.result.prepare": {
    kind: "COMMAND",
    summary: "STRICT 下的两步成果提交第一步：准备并固定差异",
    usage: `bun run codeestra task result prepare <project-id> <task-id> [execution-id]   # strict mode`,
    runtime: [
      "task.result.prepare",
    ],
  },
  "task.resume": {
    kind: "COMMAND",
    summary: "在同一工作树新建 Execution，并以 provider conversation resume 继续",
    usage: `bun run codeestra task resume <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>] [--allow-unknown]`,
    detail: `resume continues the *same* provider conversation of a PAUSED Task. A retry is a different
operation: it requeues a FAILED Task and a new Execution follows.`,
    runtime: [
      "task.resume",
    ],
  },
  "task.retry": {
    kind: "COMMAND",
    summary: "重新排队一个 FAILED Task（绝不自动重试）；新 Execution 走同一道门",
    usage: `bun run codeestra task retry <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>] [--json]`,
    detail: `Retries a FAILED Task. Nothing is automatic: only this command requeues it. Without --adapter
the Adapter this Task last ran on is reused. The Task goes back to READY (or BLOCKED when an
upstream dependency is unmet) and the Runtime then asks the same scheduling gate that
"task run" uses for one start of *that* Task, so a retry queues behind conflicts and capacity
instead of jumping them. Exit 0 only when the new Execution started, 3 when the Task is
requeued and waiting (the reason code is in --json and on stderr), 1 when the retry or the start
was refused.`,
    runtime: [
      "task.retry",
    ],
  },
  "task.revision": {
    kind: "GROUP",
    summary: "任务修订与修订投递（改任务详情或功能声明必须生成 TaskRevision）",
    unit: true,
  },
  "task.revision.create": {
    kind: "COMMAND",
    summary: "新建一条 TaskRevision（改任务详情或功能声明）",
    usage: `bun run codeestra task revision create <project-id> <task-id> <expected-version> [--specification <text>] [--feature <module-id>]… [--reason <text>] [--json]`,
    detail: `# --feature sets the feature declaration of the new revision (validated against the project's
# mapping). Omitting it inherits the current revision's declaration; passing it at all replaces
# the declaration with the ids given (ADR-0059).
# 至少要有 --specification 或 --feature 之一：什么都不改的修订会被拒为 INVALID_REVISION。
# --constraint 已删除（ADR-0065），传入会被当作未知 flag。`,
    runtime: [
      "task.revision.create",
    ],
  },
  "task.revision.delivery": {
    kind: "GROUP",
    summary: "修订投递到运行中 Execution 的账本（记录事实，不伪造 ACK）",
  },
  "task.revision.delivery.get": {
    kind: "COMMAND",
    summary: "按 delivery-id 读回一次投递",
    usage: `bun run codeestra task revision delivery get <project-id> <delivery-id> [--json]`,
    runtime: [
      "task.revision.delivery.get",
    ],
  },
  "task.revision.delivery.list": {
    kind: "COMMAND",
    summary: "列出某 Task 的修订投递及其状态",
    usage: `bun run codeestra task revision delivery list <project-id> <task-id> [--json]`,
    runtime: [
      "task.revision.delivery.list",
    ],
  },
  "task.revision.delivery.resolve": {
    kind: "COMMAND",
    summary: "对一次投递做显式收口（结构化 ACK 或经核验的 successor）",
    usage: `bun run codeestra task revision delivery resolve <project-id> <task-id> <delivery-id> <expected-version> --action <stop-and-restart|retry> [--adapter <id>] [--json]`,
    detail: `# exit 0 only when the delivery ended satisfied; 1 when it stays unconfirmed`,
    runtime: [
      "task.revision.delivery.resolve",
    ],
  },
  "task.revision.list": {
    kind: "COMMAND",
    summary: "列出某 Task 的修订历史",
    usage: `bun run codeestra task revision list <project-id> <task-id> [--json]`,
    runtime: [
      "task.revision.list",
    ],
  },
  "task.run": {
    kind: "COMMAND",
    summary: "显式请求启动一次执行；与自动调度走同一道门（依赖/冲突/容量）",
    usage: `bun run codeestra task run <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>] [--base-ref <refs/heads/...>] [--allow-unknown] [--json]`,
    detail: `Adapters: pi (default), codex, claude. Every run is bound to one Agent; changing --adapter starts a
new Execution rather than switching the Agent inside one. This is the explicit start request of
the same gate the automatic scheduler applies, so it exits 3 when the Task is *waiting* (the
conflict or capacity reason code is in --json and on stderr) and 1 when it is refused.
--base-ref fixes the baseline of a **new** workspace (ADR-0066): a local branch of the project
folder. Omitted, the baseline is the branch that folder has checked out right now. A Task that
already has a workspace keeps its recorded baseline and the flag
is refused with TASK_BASE_REF_ALREADY_FIXED instead of being ignored; a ref that is not a local
branch exits 1 with TASK_BASE_REF_NOT_A_BRANCH, and a missing one with TASK_BASE_REF_MISSING.`,
    runtime: [
      "task.run",
    ],
  },
  "task.schedule": {
    kind: "GROUP",
    summary: "调度引擎的命令面：观察、干跑、解释，以及请求一趟调度 pass",
    unit: true,
    detail: `task schedule is the scheduling engine's command face. The Runtime schedules on its own: a
relevant event (submit, integration into dev, a stop, a revision delivery, a freed slot, a capacity
change) triggers a pass, and a periodic recovery pass converges what a crash left behind. status
reports the facts (the active set, occupancy, the last pass), plan is the ordered dry run of the
candidate loop and starts nothing, and explain answers why one Task is not running now: its
dependency verdict, its conflict verdict against every active/reserved Task with the intersecting
paths/directories/modules/shared resources, and the capacity numbers. The order is priority
descending, then creation time, then ID ascending, and raising a priority only changes the next
order — it never interrupts a Task that already holds its resources. explain exits 0 when the Task
is running or would start now, 3 when it is *waiting* (a conflict or capacity wait is never BLOCKED:
BLOCKED means an unmet dependency only), and 1 when it is BLOCKED or not schedulable at all.`,
  },
  "task.schedule.clear-unknown": {
    kind: "COMMAND",
    summary: "记录一次对 UNKNOWN 判定的显式单次放行（不改写已记录的判定）",
    usage: `bun run codeestra task schedule clear-unknown <project-id> <task-id> [--json]`,
    detail: `task schedule clear-unknown records the explicit single-shot release of an UNKNOWN assessment
(ADR-0030 D05): it is bound to the assessed revision, baseline and analyzer/policy versions, it is
written to the audit ledger, it is consumed by exactly one start, and it does *not* change the
recorded verdict, which stays UNKNOWN. It is a widening of the gate, never a new one: without it,
nothing changes. A CONFLICTING assessment is a proven overlap and is never released (exit 1).`,
    runtime: [
      "task.schedule.clearUnknown",
    ],
  },
  "task.schedule.explain": {
    kind: "COMMAND",
    summary: "解释某 Task 现在为什么没在跑（依赖判定、冲突判定、容量）",
    usage: `bun run codeestra task schedule explain <project-id> <task-id> [--adapter <id>] [--json]`,
    runtime: [
      "task.schedule.explain",
    ],
  },
  "task.schedule.plan": {
    kind: "COMMAND",
    summary: "按候选顺序干跑一遍，不预留也不启动任何东西",
    usage: `bun run codeestra task schedule plan <project-id> [--adapter <id>] [--json]`,
    runtime: [
      "task.schedule.plan",
    ],
  },
  "task.schedule.run": {
    kind: "COMMAND",
    summary: "请求一趟调度 pass（与事件触发、周期恢复用的是同一个循环）",
    usage: `bun run codeestra task schedule run <project-id> [--adapter <id>] [--json]`,
    runtime: [
      "task.schedule.run",
    ],
  },
  "task.schedule.status": {
    kind: "COMMAND",
    summary: "报告调度事实：活动集合、占用、最近一趟 pass",
    usage: `bun run codeestra task schedule status <project-id> [--adapter <id>] [--json]`,
    runtime: [
      "task.schedule.status",
    ],
  },
  "task.status": {
    kind: "COMMAND",
    summary: "读回一个 Task 的完整投影（含 Execution、Session 与等待原因）",
    usage: `bun run codeestra task status <project-id> <task-id> [--json]`,
    detail: `# every Execution's Agent completion is printed with its note; a code such as
# PROSE_QUESTION_NO_TOOL_USE marks a completion the Runtime annotated instead of
# leaving an unexplained SUCCESS (heuristic: no tool call in the run and the last
# assistant text ends with a question mark). The note is printed to stderr.
# --json is accepted and is the default, so a script can state its intent.`,
    runtime: [
      "task.status",
    ],
  },
  "task.submit": {
    kind: "COMMAND",
    summary: "把 DRAFT Task 提交为 READY，进入调度",
    usage: `bun run codeestra task submit <project-id> <task-id> <expected-version>`,
    runtime: [
      "task.submit",
    ],
  },
  "task.tests": {
    kind: "GROUP",
    summary: "分支定向测试计划：把 .codeestra/tests.json 快照成 append-only 记录（ADR-0038/0039）",
    unit: true,
  },
  "task.tests.history": {
    kind: "COMMAND",
    summary: "列出该计划的 append-only 历史",
    usage: `bun run codeestra task tests history <project-id> <task-id> [--limit <n>] [--json]`,
    runtime: [
      "task.tests.history",
    ],
  },
  "task.tests.record": {
    kind: "COMMAND",
    summary: "把当前 tests.json 快照成绑定 (task, revision, commit, digest) 的记录",
    usage: `bun run codeestra task tests record <project-id> <task-id> [--commit <full-sha>] [--expected-plan-digest <sha256>] [--json]`,
    runtime: [
      "task.tests.record",
    ],
  },
  "task.tests.show": {
    kind: "COMMAND",
    summary: "读回当前生效的定向测试计划",
    usage: `bun run codeestra task tests show <project-id> <task-id> [--json]`,
    runtime: [
      "task.tests.show",
    ],
  },
  "task.transcript": {
    kind: "COMMAND",
    summary: "只读展示某个 Task 执行过程的 provider 转写（不入库、不是 attach）",
    usage: `bun run codeestra task transcript <project-id> <task-id> [--execution <id>] [--after <entry-id>] [--limit <n>] [--reverse] [--json]`,
    runtime: [
      "task.status",
      "session.transcript",
    ],
  },
  "task.unarchive": {
    kind: "COMMAND",
    summary: "取消归档",
    usage: `bun run codeestra task unarchive <project-id> <task-id> <expected-version>`,
    runtime: [
      "task.unarchive",
    ],
  },
  "task.verification": {
    kind: "GROUP",
    summary: "某 Task 的验证记录",
  },
  "task.verification.list": {
    kind: "COMMAND",
    summary: "列出某 Task 的验证记录（含绑定 revision/commit/policy digest）",
    usage: `bun run codeestra task verification list <project-id> <task-id>`,
    runtime: [
      "task.verification.list",
    ],
  },
  "task.verify": {
    kind: "COMMAND",
    summary: "在固定 commit 的隔离副本上运行验证策略，并记录绑定 revision/commit 的证据",
    usage: `bun run codeestra task verify <project-id> <task-id> [execution-id] [--background] [--policy <auto|targeted|project>]`,
    detail: `task verify --background returns a durable Operation handle instead of waiting for the policy to
finish; follow it with task operation list and stop it with task operation cancel. Exit code 0 there
means "the Operation was recorded and started", not "the verification passed".

Long-command progress is published as domain events: every step and every observed output chunk of
a running verification, and the Operation's settle, arrive on the same stream as everything else
(events tail). A progress event never carries a verdict — a passed
verification is only ever reported by VerificationCompleted and by the run's own state.`,
    runtime: [
      "task.verify",
    ],
  },
} as const satisfies Record<string, CommandNodeSpec>;

/** Prose from the old `usage()` dump that names no single command. */
export const commandNotes: readonly string[] = [
  `ADR-0066 removed the whole integration and promotion face this text used to describe: there is no
\`task integrate\`, no \`task integration *\`, no \`promotion *\`, no IntegrationBatch, no independent
integration verification and no dev clone. A Task's result commit stays on \`refs/heads/task/<task-id>\`
and merging it is the user's own Git step; the Runtime never merges, never pushes and keeps no
promotion records. Likewise no command reports a dev baseline any more: the one Task baseline is the
branch the project folder has checked out when the workspace is prepared.`,
  `ADR-0038 splits verification cost by branch responsibility. A \`task/*\`, \`lane/*\` or feature branch
commits its own small \`.codeestra/tests.json\` (a scope statement plus 1-16 argv commands, each with
what it covers); \`task tests record\` snapshots that file into an append-only record bound to the
exact task/revision/commit, and \`task verify\` runs that recorded plan -- never the file, so a scope
change is an explicit audited append. A Task with no recorded plan keeps using the fixed project
policy, and a recorded plan that belongs to another revision or commit is refused instead of being
silently replaced by the project policy. (The \`dev → main\` full-suite evidence gate this paragraph
used to describe went with the promotion face; this repository's own full-suite discipline is stated
in AGENTS.md instead.)`,
];

export type CommandId = keyof typeof commandNodes;


/** Command ids in a stable order (the tree's own key order is already grouped). */
export const commandIds = Object.keys(commandNodes) as readonly CommandId[];

/**
 * The nodes the OUTER chain branches on.
 *
 * A node is one if the resolver stops there — it is a `unit` (the branch resolves the children
 * itself) or it is runnable (`usage`) or it is a leaf — and no ancestor is a `unit`, because a unit's
 * subtree is resolved inside that unit's branch. `main.ts` compares exactly this union, so `tsc`
 * fails when a node is added to the tree without a branch, and when a branch names an id that is not
 * in the tree.
 */
export type ChainId = {
  [Id in CommandId]: (typeof commandNodes)[Id] extends { readonly resolverHandled: true } ? never
    : HasUnitAncestor<Id> extends true ? never
    : (typeof commandNodes)[Id] extends { readonly unit: true } ? Id
      : (typeof commandNodes)[Id] extends { readonly usage: string } ? Id
        : Extract<CommandId, `${Id}.${string}`> extends never ? Id : never;
}[CommandId];

type UnitId = {
  [Id in CommandId]: (typeof commandNodes)[Id] extends { readonly unit: true } ? Id : never;
}[CommandId];

/**
 * Every proper ancestor of an id (`a.b.c` -> `a` | `a.b`).
 *
 * Written out to the tree's maximum depth of four instead of recursively: TypeScript resolves a
 * self-recursive conditional type here to `never`, and the surface test asserts the depth bound.
 */
type Ancestors<Id extends string> =
  Id extends `${infer A}.${infer B}.${infer _C}.${infer _D}` ? A | `${A}.${B}` | `${A}.${B}.${_C}`
    : Id extends `${infer A}.${infer B}.${infer _C}` ? A | `${A}.${B}`
      : Id extends `${infer A}.${infer _B}` ? A
        : never;

type HasUnitAncestor<Id extends string> =
  [Extract<Ancestors<Id>, UnitId>] extends [never] ? false : true;

/** True when some proper prefix of `id` is a `unit`, so the chain never sees `id` on its own. */
export function hasUnitAncestor(id: CommandId): boolean {
  const segments = id.split('.');
  for (let end = 1; end < segments.length; end += 1) {
    const prefix = segments.slice(0, end).join('.') as CommandId;
    if ((commandNodes[prefix] as CommandNodeSpec).unit === true) return true;
  }
  return false;
}

/**
 * True when the resolver stops at `id`: a `unit`, a runnable command, or a leaf. It is the runtime
 * twin of `ChainId`, and the resolver's stop condition.
 */
export function isChainId(id: CommandId): id is ChainId {
  const node: CommandNodeSpec = commandNodes[id];
  return node.unit === true || node.usage !== undefined || directChildIds(id).length === 0;
}

/**
 * The spec of a node as the interface type, so callers read `unit`/`usage`/`runtime` without each
 * of them having to narrow the literal union by hand.
 */
export function nodeSpecOf(id: CommandId): CommandNodeSpec {
  return commandNodes[id];
}

export function parentIdOf(id: CommandId): CommandId | null {
  const separator = id.lastIndexOf('.');
  return separator === -1 ? null : (id.slice(0, separator) as CommandId);
}

export function lastSegmentOf(id: string): string {
  return id.slice(id.lastIndexOf('.') + 1);
}

/** The children exactly one level below `parent` (never grandchildren). */
export function directChildIds(parent: CommandId | null): readonly CommandId[] {
  const prefix = parent === null ? '' : `${parent}.`;
  return commandIds.filter((id) =>
    id.startsWith(prefix) && !id.slice(prefix.length).includes('.'));
}

/** Direct children of a specific parent, as a union so a switch over them can be exhaustive. */
export type DirectChildIds<Parent extends string> = {
  [Id in CommandId]: Id extends `${Parent}.${infer Rest}`
    ? Rest extends `${string}.${string}` ? never : Id
    : never;
}[CommandId];

/** The argv walk stops here: a unit owns its subtree, and a leaf has nothing below it. */
function endsWalk(id: CommandId): boolean {
  const node: CommandNodeSpec = commandNodes[id];
  return node.unit === true || directChildIds(id).length === 0;
}

/**
 * Resolves one token to a direct child of `parent`. Returns `null` for a token the tree does not
 * declare there, which is how a caller keeps "unknown subcommand" (a usage error) apart from
 * "declared but not handled" (a defect the targeted tests catch).
 */
export function childIdOf<Parent extends CommandId>(
  parent: Parent,
  token: string | undefined,
): DirectChildIds<Parent> | null {
  if (token === undefined) return null;
  const match: CommandId | undefined = directChildIds(parent).find((id) => lastSegmentOf(id) === token);
  return (match ?? null) as DirectChildIds<Parent> | null;
}

/** The path of a node as the user types it (dotted id with spaces). */
export function commandPathOf(id: CommandId | null): string {
  return id === null ? 'codeestra' : `codeestra ${id.split('.').join(' ')}`;
}

/** The usage line, or the path when a node has no `usage` of its own. */
export function usageLineOf(id: CommandId | null): string {
  if (id === null) return 'codeestra <group> [<command>] [<subcommand>] …';
  const node: CommandNodeSpec = commandNodes[id];
  return node.usage ?? `bun run codeestra ${id.split('.').join(' ')}`;
}

export type Resolution =
  /** A help request. `id` is the deepest node named, or null for the whole CLI. */
  | { readonly kind: 'HELP'; readonly id: CommandId | null }
  /** A runnable command. `rest` is every token after the matched path. */
  | { readonly kind: 'DISPATCH'; readonly id: ChainId; readonly rest: readonly string[] }
  /** A token that matches nothing at `parent`. */
  | { readonly kind: 'UNKNOWN'; readonly parent: CommandId | null; readonly token: string }
  | { readonly kind: 'BARE'; readonly parent: CommandId | null };

const helpTokens = ['help', '--help', '-h'];

/**
 * Walks argv against the tree. It stops at the deepest node the dispatch chain branches on, so the
 * chain in `main.ts` never has to guess how many tokens the command consumed.
 *
 * `codeestra <path…> help|--help|-h` and `codeestra help <path…>` are the same request. Help is only
 * recognised in the position right after the matched path: `task create … --title -h` is a Task whose
 * detail happens to start with `-h`, not a help request.
 */
export function resolveCommand(argv: readonly string[]): Resolution {
  // `help` counts when every token before it is exactly a command path. That covers `task revision
  // delivery help` (the walk stops at the unit) without mistaking a Task detail that happens to end
  // in `-h` for a help request: `task create x y --title -h` has extra tokens before the flag.
  if (argv[0] === 'help') return { kind: 'HELP', id: resolvePathTokens(argv.slice(1)).id };
  const helpIndex = argv.findIndex((token) => helpTokens.includes(token));
  if (helpIndex !== -1) {
    const path = resolvePathTokens(argv.slice(0, helpIndex));
    if (path.consumed === helpIndex) return { kind: 'HELP', id: path.id };
  }

  let id: CommandId | null = null;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    const match: CommandId | undefined =
      directChildIds(id).find((child) => lastSegmentOf(child) === token);
    if (match === undefined) break;
    id = match;
    index += 1;
    // `session transcript` is runnable *and* has a `part` subcommand, so the walk only stops where
    // nothing can follow: a unit (which owns its subtree) or a leaf.
    if (endsWalk(match)) break;
  }
  if (index < argv.length) {
    const token = argv[index] as string;
    if (id === null || !isChainId(id)) return { kind: 'UNKNOWN', parent: id, token };
    return { kind: 'DISPATCH', id, rest: argv.slice(index) };
  }
  if (id !== null && isChainId(id)) return { kind: 'DISPATCH', id, rest: [] };
  return { kind: 'BARE', parent: id };
}

/** Resolves a path written as separate tokens, stopping at the first unknown one. */
function resolvePathTokens(tokens: readonly string[]): { id: CommandId | null; consumed: number } {
  let id: CommandId | null = null;
  let consumed = 0;
  for (const token of tokens) {
    const match: CommandId | undefined =
      directChildIds(id).find((child) => lastSegmentOf(child) === token);
    if (match === undefined) break;
    id = match;
    consumed += 1;
  }
  return { id, consumed };
}

export interface HelpChildView {
  readonly id: string;
  readonly kind: 'GROUP' | 'COMMAND';
  readonly summary: string;
  /** The remaining path the user types after the parent (`run`, `delivery get`). */
  readonly command: string;
}

export interface HelpView {
  readonly path: string;
  readonly kind: 'GROUP' | 'COMMAND' | 'ROOT';
  readonly summary: string;
  readonly usage: string | null;
  readonly variants: readonly string[];
  readonly detail: string | null;
  readonly children: readonly HelpChildView[];
  readonly notes: readonly string[];
}

/** The machine-readable help record. Everything the human view prints comes from here. */
export function helpViewOf(id: CommandId | null): HelpView {
  const node = id === null ? null : (commandNodes[id] as CommandNodeSpec);
  return {
    path: id === null ? 'codeestra' : id,
    kind: id === null ? 'ROOT' : node?.kind ?? 'GROUP',
    summary: node?.summary ?? 'Codeestra 的 CLI 命令面',
    usage: id === null ? usageLineOf(null) : node?.usage ?? null,
    variants: node?.variants ?? [],
    detail: node?.detail ?? null,
    children: directChildIds(id).map((child) => {
      const childNode: CommandNodeSpec = commandNodes[child];
      const prefix = id === null ? '' : `${id}.`;
      return {
        id: child,
        kind: childNode.kind,
        summary: childNode.summary,
        command: child.slice(prefix.length).split('.').join(' '),
      };
    }),
    notes: id === null ? commandNotes : [],
  };
}

/**
 * The listing the user reads. It is generated from the same tree the dispatcher resolves against, so
 * it cannot name a command that does not exist and cannot miss one that does (ADR-0068).
 */
export function renderHelp(id: CommandId | null): string {
  const view = helpViewOf(id);
  const lines: string[] = [];
  lines.push(view.kind === 'COMMAND'
    ? `${usageLineOf(id)}`
    : commandPathOf(id));
  lines.push(`  ${view.summary}`);
  for (const variant of view.variants) lines.push(`  或 ${variant}`);
  if (view.children.length > 0) {
    lines.push('');
    lines.push(`命令（${String(view.children.length)}）：`);
    const width = Math.max(...view.children.map((child) => child.command.length));
    for (const child of view.children) {
      lines.push(`  ${child.command.padEnd(width)}  ${child.summary}`);
    }
  }
  if (view.detail !== null) {
    lines.push('');
    lines.push(view.detail);
  }
  if (view.notes.length > 0) {
    lines.push('');
    for (const note of view.notes) {
      lines.push(note);
      lines.push('');
    }
    if (lines[lines.length - 1] === '') lines.pop();
  }
  return lines.join('\n');
}
