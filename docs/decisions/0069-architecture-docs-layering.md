# ADR-0069：架构文档分层、按需读入与低价值内容删除

状态：Accepted（用户 2026-09-16 选定：直接删除低价值内容；范围限 `docs/architecture/**` + 分层入口；形式为 L0 索引 + 每篇「体量/何时读」头 + 拆出按需子文档，旧章节号保留并附对照表）。

## Context

`docs/architecture/**` 是 Agent 与人类共同的架构事实面，`AGENTS.md` 的「开始工作」要求阅读它。实际使用中它已成上下文瓶颈，而且**读得越多越容易读到过时口径**：

- 单篇过大：`sqlite-schema.md` 79.8k 字符（其中 §8「逐版本 migration 记录」约 55k，是 `packages/storage/src/migration.ts` 的镜像）、`event-model.md` 27.3k、`agent-adapter-api.md` 25.8k、`state-machines.md` 22.1k。
- 含量里夹杂四类每次都要重新筛选的内容：① 已在 v36 删除的能力的完整描述（集成/提升/dev clone）；② 已被取代的设计稿 DDL（如 Phase 0 的 `revision_deliveries` 形态与实现的 `task_revision_deliveries` 不同）；③ doc-sync 记账与「更正（FOUNDATION-0xx）」补记；④ 已裁决的历史差异表（设计名 vs 实现名）。
- 没有路由：Agent 无法在不读完整篇的情况下知道「改冲突判定该看哪一节」，于是整篇读入。
- 读取成本与收益倒挂：`docs/tasks/README.md`（1MB）才承载验收状态，架构文档却承载了大量过程记录。

约束：代码注释与既有 ADR 正文引用了架构文档的章节号（`scheduler.md` §1/§2/§4、`conflict-analyzer.md` §2–§4、`state-machines.md` §1–§4、`event-model.md` §2/§2.1–§2.3/§3/§3.1/§4、`sqlite-schema.md` §5/§8、`agent-adapter-api.md` 帧表）。ADR 正文是历史记录，按 `AGENTS.md` 不重写。

## Options

- **A. 只裁剪不拆文件**：删减后单篇仍会整体读入，且 19k+ 的 schema 篇仍无法按需取。
- **B. 移到 `docs/architecture/archive/`**：信息零丢失，但仓库继续留着一堆大文件，未来仍会被误读为现行事实。
- **C. L0 索引 + 每篇元信息头 + 按领域拆出 L2 子文档 + 保留旧章节号并附对照表**（选定）。

## Decision

1. **新增 L0 入口** `docs/architecture/README.md`：只做路由（拓扑、当前/目标分界、风险门禁、问题→文档节→体量→权威来源的对照表），并写明读取协议：按节读、L2 默认不读、**权威来源永远是源码而不是文档**。
2. **每篇文档顶部加元信息块**：`层级 · 体量 · 何时读 · 权威来源`。
3. **按领域拆分三篇超 30k 文档**：
   - `sqlite-schema.md`（L1 索引：约定、版本台账 v1–v37、迁移工程规则、旧章节号对照）+
     `sqlite-schema-{task,execution,sessions,pipeline,runtime,kernel}.md`（L2 逐域 DDL）。逐域 DDL **由当前 v37 库的 `sqlite_master` 导出**，不再维护「逻辑设计稿」与「实现记录」两套口径。
   - `event-model.md`（L1：信封、事件目录、命名规则、一致性/订阅/终端边界、测试）+ `event-model-payloads.md`（L2：逐事件 payload 与事实边界）。
   - `agent-adapter-api.md`（L1：端口、能力位、语义）+ `agent-adapter-providers.md`（L2：逐 provider 实测矩阵与证据）+ `terminal-and-handoff.md`（L2：PTY 帧表、安全点、跨交接权限矩阵）。
   - `state-machines.md`（L1：§0 内核 FSM、§1 Task lifecycle、§2 Execution、§8 补充事实）+ `state-machines-sessions.md`（L2：§3 Session/接管、§7 修订投递）+ `state-machines-runtime.md`（L2：§4 已删除集成、§5 Self Evolution、§6/§6.1 Runtime 与全局控制）。
4. **删除低价值内容，靠 git + ADR + 源码追溯**（用户选定）：
   - 逐版本 migration 的 DDL 叙述与验收记录 → 换成一行一版本的台账 + `migration.ts`；
   - v36 已删除能力（集成/提升/dev clone）的事件表、表结构、命令面叙述 → 删除，保留「不再产生、历史行可读」一句；
   - 已被取代的设计稿 DDL（与实现不同形态者）→ 删除，只保留「实现形态」与仍有效的语义；
   - 事件「设计名 vs 实现名」对照表 → 删除，保留三条命名规则与 ADR-0035 指针；
   - doc-sync 记账、`settings ui *` 等已暂停能力的过程记录 → 删除或压成一行。
5. **保留旧章节号可解析**：拆出的 `terminal-and-handoff.md` 沿用旧 §5–§7；`state-machines-{sessions,runtime}.md` 沿用旧 §3/§3.1/§3.2/§7 与 §4/§5/§6/§6.1；`event-model.md` 保留 §3.1/§4/§4.1/§5；`sqlite-schema.md` 提供 §1–§8 → 新位置的对照表。仅改动一处代码注释指针（`pi-pty-host.ts` 的帧表指向新文件）。
6. **未验证能力与「当前/目标」边界逐篇显式标注**，不用措辞变化掩盖状态变化。

## Consequences

- 默认路径成本下降：常见任务只需 L0（6k）+ 一到两篇 L1（4–11k），而不是整篇 26–80k。
- 总量只小幅下降（约 222k → 200k 字符）：真正的收益在**可路由性**与**删除过时口径**，不在总字数。schema 域篇仍各 8–19k，属按需读取；拆开后最大的 L1 文档为 9k（`state-machines.md`）。
- 仓库不再持有「逻辑设计稿 DDL」与「实现记录」两套 schema 口径，减少把草案当现有实现读错的风险。
- 信息并非零丢失：被删内容需从 `git log docs/architecture/`、对应 ADR 与源码取回；这是刻意的取舍（与 ADR-0063 对 `cli-reference.md` 的处理同一思路）。
- 文档与实现不一致时按 `AGENTS.md` 先明确变更；本次**不改任何产品语义、命令面、schema 或代码行为**（唯一代码改动是一处注释指针）。

## Verification

- `docs/architecture/**` 内部相对链接全部解析（人工核对 + 链接清单）。
- 逐域 DDL 与 `PRAGMA` 导出的 v37 `sqlite_master` 一致：脚本从真实迁移库导出 56 张表，逐表拼接进文档，无手抄。
- 旧章节号对照表存在且覆盖代码注释/ADR 实际引用到的号：`scheduler.md` §1–§4、`conflict-analyzer.md` §2–§4/§8、`state-machines{,-sessions,-runtime}.md` §1–§4/§6.1/§7、`event-model.md` §2.x/§3.1/§4、`sqlite-schema.md` §5/§8。
- 未运行全量测试（本仓库纪律：全量只在精确 `dev` 候选上跑一次，见 ADR-0038）；受影响但必要的定向检查为文档链接核对与 `packages/agent-adapters/test/pi-pty.test.ts`（唯一触及的源码文件是注释）。

## 关联文档

- [`docs/architecture/README.md`](../architecture/README.md)
- [ADR-0050](0050-user-manual-and-doc-sync-discipline.md)、[ADR-0063](0063-split-cli-reference-by-command-group.md)（用户文档与命令面参考的同类拆分先例；本次不涉及 `docs/guides/**`）
- [ADR-0035](0035-event-name-and-handoff-faces.md)（事件命名规则的权威记录）
- [ADR-0066](0066-remove-dev-clone-and-dual-baseline.md)、[ADR-0070](0070-service-process-signal-kernel.md)（被删除内容所对应的能力变更）
