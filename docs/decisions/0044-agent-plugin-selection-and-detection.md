# ADR-0044：Agent 插件/资源可定制与只读自动检测（FOUNDATION-071，schema v27）

Status：Accepted（用户在本轮四题裁决中逐项选定；四条范围/语义不得扩大或改选）

## Context

用户原话：「需要可以定制化 agent，比如开启哪些插件，不开启哪些插件，最好有自动检测功能，在 agent 设定页面，就可以通过选择配置 agent 可以选用的模型/思考深度/插件开启等等模块。」

在此之前：

- 受控启动**写死**在 `packages/agent-adapters/src/pi-rpc.ts` 与 `pi-pty.ts`：`--no-extensions --extension <gate> --extension <question> --no-skills --no-prompt-templates --no-themes --no-context-files`。用户完全没有办法让 Agent 使用自己的 extension / skill / prompt template / theme。
- Agent 配置（ADR-0012）只有 `provider`/`model`/`thinkingLevel` 三个标量字段，命令面是 `codeestra agent config get|set|clear`。
- 本机真实存在可检测对象：`~/.pi/agent/extensions/{herdr-agent-state,orca-agent-status,orca-prefill,orca-titlebar-spinner}.ts`、`~/.pi/agent/skills/{computer-use,orca-cli,orchestration}`（均为符号链接）、`~/.pi/agent/prompts/*.md`；`~/.pi/agent/themes` 不存在。

必须同时满足的既有不变量：Execution 的证据绑定（生效值写入 `executions.agent_config_json`）；FULL 下零新增确认（ADR-0011）；CLI 先完备、UI 只是便利前端（ADR-0008）；检测只读、不写 provider 配置。

## Options

用户本轮逐项选择（括号内为未选项）：

1. **范围 = Pi 四类**：extensions / skills / prompt templates / themes。**AGENTS.md/CLAUDE.md 类 context files 继续关闭且不提供开关**（关闭 context files 但提供开关 / 只做 extensions / 做统一跨 provider 抽象）。**Codex / Claude 本轮不支持插件开关**（本轮一起做 / 只做 Pi 且不显示不支持）。
2. **默认全关 + FULL 零确认**：不勾选任何插件时，Pi 的启动 argv 必须与现状**逐字节相同**；勾选后立即对**新 Session** 生效（不重启 Runtime），**不新增任何确认步骤**；生效值写入 Execution 留痕（新增确认 / 需要重启 Runtime / 不写留痕）。
3. **允许第三方 extension，如实记录风险**：ADR、设置页文案、Execution 留痕三处都写明「Pi 的 fail-closed 审批门禁靠 `--no-extensions` 保证唯一加载的 extension 是 Codeestra 自己的；用户显式加载的第三方 extension 可能影响或绕过该审批」。**不新增审批层、不做运行期越权拦截**（运行期越权即拒绝启动 / 完全不提风险）。
4. **自动检测只读 provider 用户配置目录**：`~/.pi/agent/{extensions,skills,prompts,themes}` 与 provider 自己的启用状态（`settings.json`/`pi list`，只读）；**不扫描仓库内的 `.pi/`、`.claude/`、`.codex/`**。核验不了的一律标为不可启用并给出原因，不猜（也扫描仓库内 `.pi/` / 用 `pi list` 代替 `settings.json` / 仅列出不做启用状态判断）。

## Decision

### D01 范围与「不支持」的诚实投影

- 可选范围恰好是 Pi 四类：`extensions`、`skills`、`promptTemplates`、`themes`。`AGENTS.md`/`CLAUDE.md` 继续由 `--no-context-files` 关闭，**没有开关**。
- Adapter 能力投影新增 `AdapterCapabilities.pluginSelection`：Pi `SUPPORTED`；Codex / Claude Code `UNSUPPORTED`（它们没有等价的逐资源启动选择）。设置页与 `agent plugins list` 如实显示该值，而不是伪造一个统一抽象或展示一个点了也不生效的选择框。
- 该值来自 Adapter 自己的**声明常量**（`packages/agent-adapters` 的 `declaredPluginSelectionSupport`），不走 `probe()`：投影不该因为本机没装某个 provider 二进制就改口说「不支持」。

### D02 启动形态：零选择逐字节相同，有选择追加且 gate 仍生效

- **零选择 == 现状**：`buildPiPluginArguments` 在任何一类都为空时返回空数组，`buildPiRpcArguments`/`buildPiTerminalArguments` 不追加任何参数，因此 argv 与本次改动之前逐字节相同（有逐项断言覆盖，含 gate/question extension 与四个 `--no-*`）。
- **有选择**：按 `extensions → skills → promptTemplates → themes` 的固定类别顺序、类内保持用户给定顺序追加 `--extension/--skill/--prompt-template/--theme <path>`。参数块插在 `--no-context-files` 之后、`--tools`/`--session-dir` 之前。
- **gate 先于用户插件**：Codeestra 的 `--extension <gate>` / `--extension <question>` 仍然排在最前。理由：gate 负责安装审批通道与安全点通知，先加载它才能保证审批在用户 extension 运行之前就已生效；把用户插件追加在后不改变 gate 的生效顺序，反之则会。
- **两处共用一份生成逻辑**：RPC 与原生终端（PTY）都调用同一个 `buildPiPluginArguments`，传输方式切换不能改变 Agent 能加载什么（ADR-0010 D06 的同一原则）。
- **fail-closed**：选中的路径在启动前核验（存在、可读、类型可加载）。核验失败 → 拒绝启动该 Session，稳定码 `AGENT_PLUGIN_UNAVAILABLE`，**不静默忽略**。Runtime 在建立 Execution **之前**核验（因此不会有「配置写着加载、实际没加载」的 Execution 行）；Adapter 在自己的边界上再核验一次，任何调用方都无法绕过。
- **生效时机**：只影响此后新建的 Session/Execution，不重启 Runtime、不新增确认、不打断运行中的 Agent（沿用 ADR-0012 D03）。

### D03 第三方 extension 的风险如实记录，不新增门禁

- 三处写明：本 ADR、设置页文案、Execution 留痕字段 `plugins.thirdPartyExtensionApprovalRisk: true`（当且仅当选择了 ≥1 个 extension）。
- **不新增审批层、不做运行期越权拦截**：用户明确否掉了「运行期越权即拒绝启动」。Runtime 只记录事实，责任在放行方。
- 同理不因为「是第三方」而禁止路径：用户可以选择 provider 目录之外的绝对路径。

### D04 存储与解析：schema v27，选择是「一个字段」

- 迁移只追加 `if (version < 27)`：`ALTER TABLE agent_configurations ADD COLUMN plugin_selection_json TEXT CHECK(... json_valid ...)`。**不重建表**，既有行原样保留且 `pluginSelection` 为 `null`。v16 永久未使用；25/26 分别是 FOUNDATION-065/067。
- 解析沿用 ADR-0012 的 `GLOBAL`/`PROJECT` 两级：**选择是一个整体字段**，项目一旦设置就整体替换全局列表（而不是逐项合并）。对列表而言，「项目覆盖全局」只有这一种读法可预测；逐项合并会产生「全局里被删掉的路径仍然生效」这类无法解释的状态。
- **环境变量不是一层**：环境变量无法表达列表（需要发明分隔符与转义规则），而命令面已经有一等的方式设置它。因此没有 `CODEESTRA_PI_PLUGINS` 之类的变量；解析优先级仍为 **项目 > 全局 > Adapter 默认（不加载）**。
- 留痕：`executions.agent_config_json` 记录的 `plugins` 包含 `source`（`GLOBAL`/`PROJECT`/`null`）、`entries[]`（每条 `kind` + `path` + 来源层）与 `thirdPartyExtensionApprovalRisk`。Adapter 启动时**从这条记录读回选择**（`agentPluginSelectionFromTrace`），不重新解析可变配置，因此重放（含 Runtime 重启后按事实重放）启动的就是 Execution 行里写的那些资源。**不改状态机**。
- 既有三字段的语义、`null` 表示「走 Adapter 默认」、以及「未配置任何东西时该列为 NULL」全部不变：没有选择也没有模型配置时 `agent_config_json` 仍是 `NULL`。

### D05 只读自动检测的边界

- 扫描范围：provider 用户配置目录（`PI_CODING_AGENT_DIR` 覆盖存在则用它，否则 `~/.pi/agent`）下的 `extensions/`、`skills/`、`prompts/`、`themes/`；外加该目录 `settings.json` 中 `extensions`/`skills`/`prompts`/`themes` 数组列出的额外绝对路径（`source: PROVIDER_SETTINGS`）。`pi list` 读的是同一份 `settings.json`，所以只读该文件即可，不为此启动一个 provider 进程。
- **绝不扫描仓库内目录**：不读 `.pi/`、`.claude/`、`.codex/`，不跟随符号链接进入一个 Git 工作树（判定方式是有界地向上找 `.git`，最多 64 层）。这类条目仍会列出，但标为 `selectable: false` + `SYMLINK_OUTSIDE_PROVIDER_DIRECTORY`：不扫描仓库是硬约束，所以「它指向什么」无法核验，**核验不了就不猜**（用户仍可用显式路径选择它）。本机 `~/.pi/agent/skills/{computer-use,orca-cli,orchestration}` → `~/.agents/skills/...`（非 git 工作树）因此仍可启用。
- 每项的字段：`kind`、`name`、`path`、`source`、`providerEnabled`（`true/false/null`，`null` 表示 provider 状态不可读、**未核验**）、`selectable`、`reason`（不可启用时的稳定码）、`selected`（是否在当前生效选择里）。
- 稳定 reason 码：`NOT_FOUND`、`NOT_READABLE`、`UNSUPPORTED_FILE_TYPE`、`SYMLINK_OUTSIDE_PROVIDER_DIRECTORY`、`TYPE_UNDETERMINED`、`PROVIDER_STATE_UNREADABLE`、`ADAPTER_DOES_NOT_SUPPORT_PLUGIN_SELECTION`。`PROVIDER_DISABLED` 已定义但本实现不会产出：本轮的扫描范围内没有发现 provider 侧能「禁用某个用户目录条目」的状态字段，如实保留为未产出码（宁可不产出，也不凭猜测产出）。
- **零副作用**：检测只 `stat`/`realpath`/读一个字节（判可读性）/列一层目录/读 `settings.json`；不写任何文件、不启动 provider、不改 provider 配置。测试对整棵 fixture 树做前后快照比对。
- 类型判定：extensions = 可读的 `.ts/.js/.mjs/.cjs` 文件；skills = `.md` 文件或含 `SKILL.md`/`.md` 的目录；prompt templates = `.md` 文件或含 `.md` 的目录；themes = `.json` 文件或含 `.json` 的目录；其余为 `UNSUPPORTED_FILE_TYPE`/`TYPE_UNDETERMINED`。

### D06 实测证据与未验证项的边界（**不得把推断写成实测**）

本机 `pi` 0.85.1（任务的起点记录为 0.84.4；本格的命令面证据取自 0.85.1），用 `PI_CODING_AGENT_DIR=<fake home> pi --mode rpc --no-session <flags>` 发一条 `{"id":"1","type":"get_commands"}` 后读回响应逐条实测。**每条命令都在 8 秒内被 `kill -9`**（本机没有 `timeout`），不等待交互、不触发任何网络请求（`PI_OFFLINE=1`）。fake provider home 里预置了 `extensions/probe-disc.ts`（注册命令 `probe-disc`）、`prompts/probe-template.md`、`skills/probe-skill/SKILL.md`；fake home 之外另有 `selected-skill/`、`selected-template.md`。

| # | 实际命令（略去固定前缀） | 实际输出（`get_commands` 的 `data.commands[].name`） |
|---|---|---|
| S3 | `-e /tmp/.../probe2.ts`（不关发现） | `['probe2','llama','probe-template','skill:probe-skill','skill:computer-use','skill:orca-cli','skill:orchestration','skill:research-skill']` |
| S1 | `-e .../probe2.ts --no-extensions --no-skills --no-prompt-templates --no-themes --prompt-template /tmp/.../explicit/prompts/selected-template.md` | `['probe2','llama','selected-template']` |
| S2 | `-e .../probe2.ts --no-extensions --no-skills --no-prompt-templates --no-themes --skill /tmp/.../explicit/skills/selected-skill` | `['probe2','llama','skill:selected-skill']` |

读法：S3 证明探针确实能观测到「发现」的结果（extension、prompt template、skills 都在）；S1/S2 证明在四个 `--no-*` 全开的前提下，**显式路径仍然被加载**，且被发现的同类资源（`probe-template`、`skill:probe-skill`）确实不再加载。S1/S2 里只有 `probe2`（显式 `-e`）与 `llama`（内置 inline 扩展）保留。

原始响应 JSON 由一次性的 spike harness 产生，收尾时已删除（本表的输出是逐字复制）。

- **extensions**：`pi --help` 明确写 `--no-extensions … (explicit -e paths still work)`，实测一致。
- **skills / prompt templates**：实测一致（见上表）。`resource-loader` 中 `skillPaths = noSkills ? mergePaths(cliEnabledSkills, …) : …` 的合并语义解释了该行为：`--no-*` 只关「发现」，CLI 显式路径不被丢弃。
- **themes**：**未用真实二进制单独实测**。原因：RPC 模式下 `ctx.ui.getAllThemes()` 被实现为硬编码返回空数组（TUI 才populate），没有可观测输出；用无效 theme 文件也不会报错。设计按「与 extensions/skills/prompt templates 同构的 `resource-loader` 代码路径」实现（`noThemes ? mergePaths(cliEnabledThemes, …) : …`），并如实标注为**推断**。保守性论证：theme 只影响 TUI 配色，与审批门禁（gate extension）没有任何交互，即使某个 provider 版本忽略显式 `--theme`，也不会放宽任何权限——与第三方 extension 的风险完全不同。

### D07 命令面：一条命令列出，一条命令设置

- `codeestra agent plugins list [--project <id>] [--adapter <id>] [--json]`：列出全部候选 + 当前选择状态 + 来源层 + adapter 支持情况。`--json` 输出 Runtime 的原始 payload；默认输出窄行文本。退出码 0 = 支持并可列出；1 = 该 adapter 不支持插件选择（或 Runtime 拒绝）；2 = 用法错误。
- `codeestra agent plugins select [--project] [--adapter] [--extension <path>]… [--skill <path>]… [--prompt-template <path>]… [--theme <path>]… [--clear] [--json]`：**一条命令设置或清除选择**，零确认。
- **选「可重复 flag」而非 `--from-file <json>` 的理由**：路径是命令行最自然的输入，重复 flag 让命令自解释、可脚本化（`$(...)` 展开即可），不需要临时文件、第二套转义规则或「文件里写错一个字段才失败」的延迟反馈；清除是 `--clear`，而 JSON 文件无法自然表达「清空某一类还是整份清空」。整份选择语义明确：**传入的 flag 就是全部选择**，未传入的类别为空——不隐藏合并规则，因此重复执行同一命令是幂等的。
- 命令面（versioned request）：
  - `agent.config.set` 新增可选 `pluginSelection`（`null` 清除；缺省不变），并在 handler 内用严格 schema 解析。
  - 新增 `agent.plugins.list`（只读检测 + 当前选择 + 支持情况）。
- UI 只是同一命令面的便利前端：设置页调用的是同样三个请求，不新增业务语义、不绕过任何校验。

### D08 稳定错误码

| 码 | 含义 | 何时出现 |
|---|---|---|
| `INVALID_AGENT_PLUGIN_SELECTION` | 选择不满足严格 schema（相对路径、`..`、空白、未知字段、超长、超上限） | `agent.config.set`（handler 内解析）；CLI 提交前 Runtime 拒绝，**零写入** |
| `AGENT_PLUGIN_UNAVAILABLE` | 选中的路径无法核验/加载 | 保存时与每次启动前；**拒绝启动该 Session**，不静默忽略 |
| `AGENT_PLUGIN_KIND_UNSUPPORTED` | 该 adapter 本轮不支持插件选择（Codex / Claude） | `agent.config.set` 带 `pluginSelection` 时 |

检测候选的 reason 码见 D05。保存时的核验与启动时的核验是同一份函数，因此「能保存」与「能启动」不会互相矛盾；不一致只可能来自保存与启动之间的文件系统变化，此时启动按 fail-closed 拒绝。

### D09 UI：最小追加

- 新增 `apps/ui/src/agent-settings.tsx`（`AgentSettingsPanel`）：选择 adapter → 作用域 → provider/model/思考深度 → 四类插件勾选（显示来源目录、provider 启用状态、不可启用原因）→ 显示当前生效值与来源层 → 明确提示「只对新 Session 生效并写入 Execution 记录」与「第三方 extension 可能影响或绕过 Codeestra 的审批」。
- `apps/ui/src/App.tsx` 只做四处纯追加：`Tab` 联合类型加 `'plugins'`、`tabLabels` 加一项、导航数组加一项、渲染分支加一处。**未改动** `.app`/`.app-header`/`.sidebar`/`.workspace-shell` 的任何样式规则（J3 领地），**未改动** `apps/ui/src/settings.tsx` 与 `ui-settings.ts`（J4 领地）。

## Consequences

- 用户第一次可以让 Agent 使用自己的 skill/extension/prompt template/theme，并且「默认全关」使既有行为在默认路径上完全不变。
- 选择是一份**显式列表**而不是继承链：代价是项目覆盖会整体替换全局列表，用户需要显式勾选想保留的项；收益是状态可预测、可解释、可幂等重放。
- 检测只覆盖 provider 自己的用户配置目录。代价是本机 `~/.pi/agent/skills/*` 这类符号链接条目在指向 Git 工作树时会被标为不可启用；收益是绝不扫描仓库目录这条硬约束不被破坏。
- 选择第三方 extension 会削弱「唯一加载的 extension 是 Codeestra 自己的」这一前提；本 ADR、设置页与 Execution 记录三处如实说明，且**不新增审批层**。
- 未产出码 `PROVIDER_DISABLED` 保留在枚举里但不会产生，客户端不应依赖它出现。

## Verification

执行过的定向验证（ADR-0038：**没有**跑 `bun run check`/`check:fast`/`just check`/`just verify`）：

1. `bun run typecheck` → 0 错误；`bun run typecheck:ui` → 0 错误。
2. `bun test packages/agent-adapters/test packages/storage/test/agent-plugin-selection.test.ts apps/runtime/test/agent-plugin-detection-service.test.ts apps/runtime/test/agent-config-service.test.ts` → 123 pass / 0 fail。
   - 新增 `packages/agent-adapters/test/pi-plugin-arguments.test.ts`：零选择逐项等于改动前的 argv（FULL/STRICT/Windows/resume）、显式空选择与无选择等价、选择顺序与 gate/question 先加载、RPC 与 PTY 参数块位置一致、不可用路径 fail-closed 并带 kind/path/reason。
   - 新增 `packages/storage/test/agent-plugin-selection.test.ts`：v26 → v27 在**真实临时文件库**上升级且既有行保留（断言 `>= 27`，不断言「当前版本 == 27」）、整体替换语义、非法选择拒绝且零写入。
   - 新增 `apps/runtime/test/agent-plugin-detection-service.test.ts`：fake provider home 覆盖可加载/错类型/不可读（mode 000）/指向 Git 工作树的符号链接/悬空符号链接/无入口目录/仅 `settings.json` 列出 七种形状，断言分类、原因、provider 启用状态与「扫描前后整棵树逐条相同」的零写入；另有「provider 状态不可读 → 一律 `providerEnabled: null` 且标为不可启用」与解析/留痕断言。
3. `bun test apps/runtime/test/cli-agent-plugins.test.ts`（新 e2e，用 `apps/runtime/test/support/runtime-reclamation.ts` + 独立临时 `CODEESTRA_HOME` + 临时 `PI_CODING_AGENT_DIR`）→ 2 pass / 0 fail：`plugins list --json`/默认文本、`select` 写入与幂等重放、`--clear` 与空选择的 no-op、候选 `selected` 状态回流、`/nonexistent` 与错类型路径 exit 1 + `AGENT_PLUGIN_UNAVAILABLE` 且零写入、相对路径 exit 1 + `INVALID_AGENT_PLUGIN_SELECTION`、`--adapter codex` exit 1 + `AGENT_PLUGIN_KIND_UNSUPPORTED`。
4. 回归定向：`bun test packages/storage/test/database.test.ts apps/runtime/test/cli-agent-config.test.ts` → 55 pass / 0 fail；`bun test apps/runtime/test/agent-runtime-service.test.ts` → 7 pass / 0 fail；`bun test apps/runtime/test/terminal-service.test.ts apps/runtime/test/session-handoff-service.test.ts` → 24 pass / 0 fail（PTY 参数生成未漂移）。
5. 真实 `pi` RPC 探测（`get_commands`，每条命令 8 秒内被终止）：见 D06 表格。原始输出保存在临时目录的一次性 spike 中（`/tmp/ce-j2-spike/out/*.json`，收尾时已删除）。

**未执行的检查（如实记录）**：

- 未跑任何全量测试/构建（`check`、`check:fast`、`just check`、`just verify`、`build:ui`）——ADR-0038 禁止在 lane 分支上跑全量。
- 未用真实模型跑一次带插件选择的 `task.run`（不消耗真实额度），因此「真实 Pi 在 RPC 模式下确实把选中的 skill/theme 注入 system prompt 并让模型使用它」只有 argv 与命令面证据，不等于真实执行验收。
- 未做 UI 的手工/浏览器验收（AGENTS.md 禁止 computer-use 与桌面自动化）；设置页只有 typecheck 与「调用同一命令面」的结构性保证。

## 未验证清单

- 真实模型下加载第三方 extension 的行为，以及该 extension 是否真的能影响/绕过 gate 审批（只记录了风险事实，未做对抗验证）。
- themes 的「关发现 + 显式路径」在真实二进制下的行为（D06：推断，未单独实测；theme 与审批无交互）。
- `PI_CODING_AGENT_DIR` 覆盖之外的自定义 provider 配置目录布局；`~/.agents/skills` 这类 provider 的第二全局 skills 目录不在扫描范围内（用户已限定扫描范围），因此不会作为候选列出。
- Codex / Claude 的插件选择（本轮如实报告为 `UNSUPPORTED`，未实现）。
- 检测在超大目录（>512 候选）下的截断行为：schema 上限为 512，超限会被 Runtime 边界拒绝而不是静默截断；未做真实压力验证。
- `agent.plugins.list` 的 UI 增量刷新（当前设置页每次重新拉取完整 payload）。

## Related

- `PROJECT_SPEC.md` §1.1（效率至上）、§2（不变量）、§6；ADR-0008（CLI 完备/UI 便利层）、ADR-0011（FULL 零确认）、ADR-0012（Agent 配置作用域与留痕）、ADR-0010/0026（传输切换不改变 Agent 权限）、ADR-0038（定向测试）。
- 代码：`packages/contracts/src/agent-plugins.ts`、`packages/storage/src/migration.ts`（v27）、`packages/agent-adapters/src/pi-plugins.ts`、`apps/runtime/src/agent-plugin-detection-service.ts`、`apps/runtime/src/agent-config-service.ts`、`apps/cli/src/main.ts`（`agent plugins`）、`apps/ui/src/agent-settings.tsx`。
- `docs/tasks/README.md` FOUNDATION-071。
