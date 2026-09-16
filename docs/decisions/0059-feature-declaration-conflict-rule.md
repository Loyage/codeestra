# ADR-0059：冲突判定改为「声明同一功能且对方未完成」（取代 ADR-0031 的保守判定）

Status：Accepted（用户 2026-09-16 逐项明确选择；schema **v32**（`task_revisions.features_json`，纯 `ADD COLUMN`）；**零新增确认、零新增门禁**）
任务：格 2（`lane/p1-task-purge` 后续）。基线：`dev = 17b4dd6`。

## Context

用户的诉求（本轮原话）：

> 「现在的冲突判断太保守了，我需要快，可以把冲突判断改成默认不认为冲突，只有在用户想改进某个功能，但这个功能还没开发完的时候，才视作冲突。」

**「太保守」不是感觉，是可测的事实。** ADR-0031 的判定要求「证明不相交」，而在本仓库上：

- `.codeestra/impact.json` 把 `package.json`、`bun.lock`、`apps/runtime/src/main.ts`、`apps/cli/src/main.ts`、`PROJECT_SPEC.md` 声明为 `consumers.state = 'UNKNOWN'` 的全局资源 → 任何改动它们的 revision 得到 `UNCERTAIN_GLOBAL_EFFECT` → `complete=false` → `UNKNOWN` → 不并行；
- 映射未确认（`POLICY_NOT_CONFIRMED`）、项目无映射（`POLICY_ABSENT`）、工作树不可观测（`MISSING_IMPACT_SNAPSHOT`）、基线不同（`STALE_BASE`，`dev` 一前进就发生）各自都能把判定变成 `UNKNOWN`；
- 未启动的 `READY` 任务**没有变更集**，因此「按实际改了哪些文件推断影响」在启动前根本不成立（这就是本 ADR 必须让用户**事先声明**功能的原因）；
- 结果是默认就是串行：要并行必须每次显式 `--allow-unknown`。

所以本 ADR 把「无法证明不相交」换成「用户声明了同一件事」：判定比较的是**声明**，而声明是用户自己写的，缺失就只是「没声明」。

## Options

| 选项 | 说明 | 用户选择 |
|---|---|---|
| A. 只保留「同一功能声明 + 对方未完成」，连改同一文件也不再拦 | 最贴用户原话、最快 | **采用** |
| B. A + 同文件硬冲突 | 成本≈0，能避免必然的 merge 冲突 | 未选（同文件冲突留到 IntegrationBatch 处理） |
| C. 只把「不完整」降级为 SAFE，保留全部文件级重叠判定 | 改动最小 | 未选 |
| 功能的表达：A 复用 `.codeestra/impact.json` 的 `modules[].id` / B 新增 `features.json` / C 从 revision 文本推断 / D 自由文本 | — | **A** |
| 「未完成」边界：A 任何非终态（含 DRAFT/FAILED/EXECUTED）/ B 只有仍在跑或占资源的 / C 只有 RUNNING/WAITING | — | **A** |
| UNKNOWN：A 保留三值但默认路径不再产出 / B 取消 UNKNOWN / C 保留现状语义 | — | **A** |
| 规格与决策记录：A 新 ADR 取代 ADR-0031 + 同步规格与文档 / B 新 ADR + 保留严格模式开关 / C 不写 ADR | — | **A** |

## Decision

### D01：唯一判据是「声明同一功能且对方未完成」

- 「未完成」= 状态不是 `SUCCEEDED`/`CANCELLED`，**且未归档**（`taskIsUnfinishedForConflict`；归档是用户说「这个不在飞行中」，一个被归档的 `DRAFT` 不该拦住任何人）。
- 命中 `SAME_UNFINISHED_FEATURE`（`class=CONFLICT`，`features` 为交集、有序，`relation=SAME_FEATURE`），detail 写明对方的实际状态。
- 聚合：有命中即 `CONFLICTING`，否则 `SAFE_TO_PARALLELIZE`。**不再有其它任何判据**。
- 判定输入换成 `listFeatureConflictPeers`（同项目、非终态、未归档、至少声明一个功能的 Task）——**不再**是「持有 Execution 资源的 Task」（ADR-0031 D06 的活跃集合）。一个还没启动的 `READY` 任务正是这条规则的对象。
- 判定**不读**快照、映射、基线或文件集合。`ImpactSnapshot` 仍然派生（`project impact show`、槽位预留的代际重检需要它），但只是证据。

### D02：默认 SAFE，且没有产生 UNKNOWN 的路径

- 映射缺失/非法/未确认、`EMPTY_MAPPING`、`UNCERTAIN_GLOBAL_EFFECT`、`UNBOUNDED_SCOPE`、`MISSING_IMPACT_SNAPSHOT`、`STALE_*`、`ACTUAL_DIFF_EXCEEDS_SNAPSHOT` 都**不再影响判定**。它们在快照上仍然是事实，`project impact validate` 仍然如实报告。
- `UNKNOWN`、`--allow-unknown`、`scheduler.unknown.clear`/`TaskUnknownCleared` **保留**（用户选 A）：历史 assessment 行与客户端仍要能渲染 `UNKNOWN`，命令面也保持完整。当前规则没有产生它的路径，因此日常不可达；`clear-unknown` 对 `CONFLICTING` 继续拒绝并如实报告（`recorded:false`）。
- 这是本项目里第一次**主动删掉一个保守默认**：`SAFE` 不再表示「在声明映射与观测事实下无法证明重叠」，而表示「用户没有声明与某个未完成任务相同的功能」。残余风险（两个 Agent 改同一文件）由 IntegrationBatch 的 CONFLICTED 处置承担，不再由启动前门禁承担。

### D03：功能声明存放在 revision 上，写入时校验

- schema **v32**：`task_revisions ADD COLUMN features_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(...) AND json_type(...)='array')`。纯 `ADD COLUMN`，不重建表；历史行一律 `'[]'`——这正是对的，因为**在引入该列之前没有任何声明**，而「没声明」的安全读法就是「不参与功能冲突」。`phase1SchemaVersion` 31 → 32；`v16` 继续永久未使用。
- 命令面：`task create --feature <module-id>`（可重复）、`task revision create --feature <module-id>`（可重复）。**省略即继承**当前 revision 的声明（改规格不该把任务静默踢出功能规则）；显式给出即整体替换（这也是任务「停止声明某功能」的唯一方式）。只改声明本身也是合法 revision（`INVALID_REVISION` 的判据从「必须改规格或加约束」扩展为「必须改规格、加约束或改声明」）。
- id 必须是项目 **main ref** 的 `.codeestra/impact.json` 的 `modules[].id`：`UNKNOWN_FEATURE` / `IMPACT_POLICY_ABSENT` / `INVALID_IMPACT_POLICY` 在写入前拒绝（**校验发生在写入时，不在判定时**，所以判定不需要读映射）。
- **不要求该映射已被 `project trust` 确认**：UI 的 trust 流程不发送映射摘要（已知缺口），要求确认会让「从界面信任的项目」无法声明功能；是否已确认仍由 `project impact validate` 报告。这是对 ADR-0031 D07「未确认即拒绝」的**有意收窄**：那条规则的落点从「判定」移到「写入校验」，而它保护的（不能把坏映射当成没有映射）没有丢。
- `task_revisions.features_json` 在读取时重新校验形状（与 `constraints_json` 同惯例）。

### D04：旧规则与旧码保留为历史，`impactAnalyzerVersion` 前进到 v2

- `impactAnalyzerVersion = 'impact-analyzer-v2'`：判定语义变了，快照的重用键必须跟着变，否则 v1 快照（它的 `complete` 与 `files` 回答的是另一个问题）会被当成等价事实复用。
- 旧 reason code 全部**留在类型与 `impactReasonClass` 里**（历史 `impact_assessments` 行、`TaskWaitingForConflict` 事件、UI 词汇表都要能渲染它们），但分析器不再产出；`conflict-analyzer.md` §1–§4 保留为 ADR-0031 的设计记录，新增 §8 记录当前规则。
- `impact_assessments` 仍按「两侧都有可观测快照」写配对行。它**是部分的**，不能读成「没有行 = 没有冲突」；判定的审计是 `TaskScheduleDecided`/`TaskWaitingForConflict` 事件（含 reason codes 与 blocking task ids）与 `explain` 输出。ADR-0031 D05 那张 append-only 表因此保留但覆盖面收窄，这一点写进后果。

### D05：运行时接线

- `schedule-service`：`#assess` 用 `#featureSubjects`（来自 `listFeatureConflictPeers` + 已有快照作为证据）替代 `#refreshSubjects`；**删除** `#refreshSubjects`（每个 tick 为每个活跃任务派生快照是本产品最贵的一步，而它对判定已无影响）与 `#unavailableAssessment`（`MISSING_IMPACT_SNAPSHOT` 那条 UNKNOWN 路径）。
- `assertResumeAllowed` / `#conflictDecision` 的判定顺序不变（`CONFLICTING` 即拒绝/等待，永不放行）；`TaskWaitingForConflict` 事件的 reason codes 现在来自新规则；wait view 的 hit 增加 `features`。
- 增长检测（ADR-0031 §4 的 `TaskImpactPredictionRevoked`）**保留但不因 diff 增长而暂停任何人**：增长不再是冲突，只有「对方声明现在与本任务重叠」才是（`pauseRequested:false`、`conflictingTaskIds:[]` 是当前默认结果）。
- UI：`scheduling-labels.ts` 增加 `SAME_UNFINISHED_FEATURE` 的中文标签（旧的保留在表里，供历史事件渲染）；任务详情显示当前 revision 声明的功能；schedule 的冲突命中显示声明的功能 id。

## Consequences

- 已实现：`packages/contracts/src/index.ts`（`taskFeaturesSchema`/`maxTaskFeatures`、`task.create`/`task.revision.create` 的 `features`、hit view 的 `features`）；`packages/storage/src/{migration,database,index}.ts`（v32、`features_json` 读写与继承、`listFeatureConflictPeers`、`ImpactCandidateTaskRef.features/archived`）；`packages/domain/src/impact-analysis.ts`（v2、新码、`taskIsUnfinishedForConflict`、重写 `assessCandidate`，删除 `subjectHits`/`pairHits`/`staleDetail`/`boundedPaths`/`intersectByKey`）；`apps/runtime/src/{impact-analysis-service,schedule-service,main,revision-delivery-service}.ts`（`resolveDeclaredFeatures`、feature 主体与 peer 投影、增长不再暂停、声明变更成为合法 revision）；`apps/cli/src/main.ts`（`--feature` 于 task/revision create）；`apps/ui/src/{scheduling-labels,types,App,schedule}.tsx`；`PROJECT_SPEC.md` §2.6、`docs/architecture/conflict-analyzer.md`（§8）、本 ADR、`docs/decisions/README.md`。
- **默认行为反转（最大的后果）**：以前「提交后什么都不会自动开始（UNKNOWN）」，现在**没有声明功能的 Task 提交后会在容量允许时立即开始**。这是用户要的「默认不冲突」的直接结果，也是既有测试大量依赖旧默认的原因（见「验证」）。
- 残余风险由谁承担：两个未声明功能的 Task 可以并发修改同一文件，冲突在 IntegrationBatch/结果 commit 阶段以 CONFLICTED 暴露。这是用户明确选择的权衡，不再由启动前门禁兜底。
- `SUCCEEDED`/`CANCELLED`/已归档的任务不再拦任何人；`DRAFT`/`BLOCKED`/`FAILED`/`EXECUTED` 仍然拦（「功能还没开发完」）。
- `impact_assessments` 的覆盖是部分的（只有两侧都有快照的配对），且判定审计以事件为准；`UNKNOWN`/`--allow-unknown`/`clear-unknown` 保留但日常不可达。这两点都是有意留下的、需要在文档里写清的事实，不是遗漏。
- 效率：FULL 下常态路径新增确认 **0 步**、新增等待 **0**；判定本身不再读映射与快照，调度 pass 少了一次「为每个活跃任务派生快照」的开销。

## Verification

只用 CLI/命令面与 Runtime 命令面（含临时 `CODEESTRA_HOME`、临时仓库）与包内测试断言（ADR-0008）；功能分支只跑定向测试（ADR-0038）。

**已通过：**

| 范围 | 结果 |
|---|---|
| `packages/domain/test/impact-analysis.test.ts`（按新规则重写，19 项） | pass |
| `bun test packages/storage/test packages/domain/test`（474 项） | pass（含三处 v26/v28/v29 升级 fixture 补 `ALTER TABLE task_revisions DROP COLUMN features_json`，与 ADR-0057 对 v31 表的同款处理一致） |
| `apps/runtime/test/schedule-service.test.ts`（10 项，按新规则重写 5 项） | pass |
| `apps/runtime/test/cli-schedule.test.ts`（6 项，重写 3 项） | pass |
| `apps/runtime/test/cli-impact.test.ts`（1 项端到端，重写） | pass |
| `apps/runtime/test/scheduler.test.ts` + `snapshot-generation-recheck` + `cli-task-create`（22 项） | pass |
| `bun x vitest run`（UI 22 文件 489 项）+ `bun run typecheck` + `bun run typecheck:ui` | pass（0 类型错误） |

**未通过（如实记录，本格未完成）：** 无。FOUNDATION-091 收尾（同一分支 `lane/p1-task-purge`）已把下面 74 项重写完毕：

| 范围 | 结果 |
|---|---|
| `bun test apps/runtime/test`（66 文件 469 项） | **469 pass / 0 fail**（收尾前 395 pass / 74 fail） |
| `bun x vitest run`（22 文件） | **490 pass / 0 fail** |
| `bun run typecheck` + `bun run typecheck:ui` | 0 类型错误 |

收尾时发现两个**真实缺陷**（不是测试问题），已修：

1. **调度启动的 Session 没有 incarnation**：`handoff.recordAutomationIncarnation` 原先只在 `task.run`/`task.resume`/`task.retry` 调用；
   ADR-0059 让自动 tick / submit 自动启动成为常态，这类 Execution 因此没有 incarnation、没有单 writer lease，
   原生终端接管无 predecessor 可核（ADR-0023/0026）。修法：`ScheduleService` 的 `start` 回调包一层，启动出 Session 后记同一个 incarnation。
2. **测试进程的 loopback fetch 会被开发者代理拦下**（环境里的 `http_proxy` 对 Runtime HTTP 回 502 空 body）——已在
   `apps/runtime/test/cli-attention.test.ts` 导入期设 `no_proxy`（子进程 CLI 早已各自设置）。

未验证：真实 provider 下的并发运行（两个 `SAFE` 任务真的同时跑）、UI 实际点击、`--allow-unknown` 的日常路径
（已不可达，只在重构后保留）、真实 provider 下「调度启动的 Session」能被原生终端接管（incarnation 修复只在协议 stub 上验收）。

## 关联文档

- `PROJECT_SPEC.md` §1.1、§2.6（本轮修订）、§2.5、§2.10
- ADR-0030（Phase 2 判定固化的决策来源）、**ADR-0031（被本 ADR 取代的判定语义；其快照/失效/D05 审计表仍在用）**、ADR-0032（槽位预留与 `SNAPSHOT_STALE` 重检，未改）、ADR-0033（调度引擎）、ADR-0038（定向测试与 dev 全量）、ADR-0050（文档同步纪律）、ADR-0058（格 1 的删除能力）
- `docs/architecture/conflict-analyzer.md`（§1–§4 历史、**§8 当前规则**）、`docs/architecture/scheduler.md`（§1 两个集合、§2 更正）、`docs/architecture/domain-model.md`（TaskRevision 的 `features`）、`docs/architecture/sqlite-schema.md`（v32）、`docs/architecture/event-model.md`（`TaskRevisionCreated.features`）
- `docs/guides/`：`cli-reference.md`（§3 impact、§4 `--feature`/`submit`/`run`）、`concepts.md`（调度三态）、`features.md`、`manual.md`、`recipes.md`、`troubleshooting.md`（含四个拒绝码）、`ui.md`
- `docs/decisions/README.md`、`docs/tasks/README.md` FOUNDATION-091、`docs/tasks/FOUNDATION-091-remediation.md`（交办单，现已执行完毕）
