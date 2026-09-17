# Conflict Analyzer

> 层级：L1 · 体量 ≈ 7k 字符 · **何时读**：改冲突判定、影响快照/mapping（`.codeestra/impact.json`）、失效键或 reason code · 权威来源：`packages/domain/src/impact-analysis.ts`（纯判定）、`apps/runtime/src/impact-analysis-service.ts`、`packages/contracts/src/impact-policy.ts`。
>
> **当前判定规则在 §8**；§1–§5 是 ADR-0031 时代的设计（判定部分已被 ADR-0059 取代，快照构造与失效键仍在用）。章节号沿用拆分前的编号。

## 1. 目标与限制

analyzer 的目标是**确定性**：同样输入必然得到同样结论，判定可复现、可解释、可审计。它**不能**事先证明两个 Agent 永不越界——这是明确接受的残余风险（[`scheduler.md`](./scheduler.md) §4），因此它给出的 `SAFE_TO_PARALLELIZE` 在当前规则下是**默认值**而不是被证明的结论。

## 2. 输入

判定与快照的来源：

- 项目 `main` ref 上的 `.codeestra/impact.json`（映射：`modules[].id` → 路径/目录、`importantDirectories`、`globalResources`）；
- 每条 Task revision 固定的 `base_commit`；
- analyzer 版本与策略版本/digest；
- 该 revision 相对 base 的变更集（tracked/untracked/rename + tree fingerprint）。

「拿不到可靠信息」在 ADR-0031 时代一律映射成 `UNKNOWN`；ADR-0059 起不再产生该取值（§8）。

## 3. 纯判断规则（历史：ADR-0031 的设计，已被 ADR-0059 取代）

当时的规则按优先级短路：同一重要目录 / 路径重叠 / 同一模块 / 共享 `globalResources` 命中即 `CONFLICTING`；映射缺失、未确认、未分类路径或基线不可观测则 `UNKNOWN`；两者都完整且无交集才是 `SAFE_TO_PARALLELIZE`。

**当前不再这样判**：判定只读两侧**声明**的功能，文件/目录/模块/共享资源重叠与映射完整性都不再影响结论（§8）。保留这段是为了解释历史 assessment 行与 `reason_codes` 的来历——历史行按原样可读，**不改写**。

## 4. 失效与解释

**失效键（仍是当前实现）**：任一分量移动即视为「这份快照不再可用」，需要新快照而不是就地更新——revision、`base_commit`、analyzer 版本、policy 版本/digest、观测到的 change fingerprint（diff 变大也算）。这个键写在 `impact_snapshots` 的唯一约束里，所以「能否复用」由 schema 决定，而不是由调用方记得。

**解释**：每次判定都带稳定的 `reason_codes` 与 hits，供 `task schedule explain` 输出。原因码是**有界枚举**（见 §6.4），不把自由文本当原因。

## 5. 测试

纯函数按输入组合做表驱动测试；快照的 append-only、唯一键与失效键由真实 SQLite 测试覆盖。判定不依赖时钟、文件系统顺序或随机性。

## 6. 实现现状（FOUNDATION-053 / schema v20）

### 6.1 `.codeestra/impact.json` 的字段

人工维护的映射，只从项目 `main` ref 读取（读法同验证策略）。`modules[]` 的 `id` 是**功能 id**——它同时是 `task create --feature` 的取值域与冲突判定的关键字；路径、重要目录与全局资源是快照的证据，不再是判定输入。

### 6.2 确认

`project_impact_policy_confirmations` 记录该映射被接受的状态与摘要（`ABSENT`/`PRESENT`/`INVALID`）。`INVALID` 保留原始字节摘要，使「映射坏了」是被记录的**事实**，而不是被静默报成「没有映射」。

### 6.3 快照失效键

`(task, revision, base_commit, analyzer_version, policy_version, change_fingerprint)`。Task 修订、基线移动、映射编辑、analyzer 换代、观测到的 diff 变大，都产生**新行**；旧行保留做审计且永不被再次选中（`impact_snapshots` 有 `no_update`/`no_delete` 触发器）。

### 6.4 稳定 reason code 清单

判定原因码（有界枚举，出现在 `impact_assessments.reason_codes_json` 与 `explain` 输出）：`SAME_UNFINISHED_FEATURE`（当前唯一能产生 `CONFLICTING` 的码）、`SAME_IMPORTANT_DIRECTORY`、`PATH_OVERLAP`、`SHARED_MODULE`、`SHARED_GLOBAL_RESOURCE`、`MAPPING_ABSENT`、`MAPPING_UNCONFIRMED`、`UNCLASSIFIED_PATHS`、`BASELINE_UNOBSERVABLE`（后五个是历史/证据类码，自 ADR-0059 起不再产生判定结论）。

### 6.5 命令面与退出码

`task schedule status|plan|explain|run|clear-unknown`（零确认、`--json`、退出码 0/1/3）。`explain` 给出该 Task 当前的判定与原因码，是「为什么它在等」的可脚本化答案。

### 6.6 未实现（不得声称）

- 没有 LLM 辅助预测（明确不做，见 [`scheduler.md`](./scheduler.md) §6）。
- 非 Git 共享资源（端口/数据库/dev server）不被启动前门禁覆盖。
- `impact_snapshot_id` 的跨表代重检尚未实现（既有字段，Wave F 遗留）。
- 判定不再读快照，因此**「没有 assessment 行」不等于「没有冲突」**。

## 7. 与调度引擎的关系

调度引擎消费判定结果（§8）并把它变成等待原因；analyzer 本身**不做调度决策**，也不写 Task 状态。判定的审计面是 `TaskScheduleDecided` / `TaskWaitingForConflict` 事件与 `explain` 输出，不是 assessment 行。

## 8. 当前判定（ADR-0059 / FOUNDATION-091）

### 8.1 规则

- **默认 `SAFE_TO_PARALLELIZE`**。
- 只有当**双方声明了同一个功能**、且对方**仍未完成**（状态不是 `SUCCEEDED`/`CANCELLED`，且未归档）时，才是 `CONFLICTING`（`SAME_UNFINISHED_FEATURE`）。
- **文件路径重叠、同一目录、同一模块路径、共享构建/依赖/schema 资源都不再构成冲突**：它们仍是可观测事实并进入解释输出，但不再阻止并发。
- `UNKNOWN` 保留为取值（历史 assessment 与客户端仍能渲染），当前规则**没有产生它的路径**：映射缺失/未确认/不完整、基线移动、worktree 不可观测都不再使判定变成 `UNKNOWN`。
- `--allow-unknown` 与一次性放行命令面保留，但只对 `UNKNOWN` 有意义，**永不放宽 `CONFLICTING`**。
- `impactAnalyzerVersion` 前进到 `impact-analyzer-v2`；快照、映射、基线、变更集仍是**记录的证据**（`impact_assessments` 仍按「两侧都有可观测快照」写配对行）。

### 8.2 功能从哪来

取自项目 `.codeestra/impact.json` 的 `modules[].id`（`task create --feature` / `task amend --feature`）。功能 id 在**写入时**按项目 `main` ref 的映射校验（未声明即 `UNKNOWN_FEATURE`，映射不可读即拒绝），因此**判定本身不需要读映射**、也不需要确认步数——默认路径确认步数为 0。省略 `--feature` 的新 revision 继承上一条的声明；一个功能都不声明的 Task 永远不参与功能冲突。

### 8.3 保留而不产生的东西

`UNKNOWN` 取值、`--allow-unknown`、`scheduler.unknown.clear`（`task schedule clear-unknown`）、`TaskUnknownCleared` 事件与历史 `impact_assessments` 行都保留可读、可执行（对 `CONFLICTING` 一律拒绝），只是当前规则不再产生新的 `UNKNOWN`。

### 8.4 定向测试

判定规则的表驱动测试覆盖：同一功能且对方未完成 → `CONFLICTING`；同一功能但对方 `SUCCEEDED`/`CANCELLED`/已归档 → `SAFE`；无声明、无交集、路径重叠、共享资源重叠 → `SAFE`；`--allow-unknown` 对 `CONFLICTING` 拒绝。历史 assessment 行与历史 `UNKNOWN` 取值的读回由 storage 测试覆盖。
