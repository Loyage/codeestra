# Service Kernel 改造 Roadmap

状态：**ADR-0068 已接受，目标架构尚未实现**。当前可运行基线仍是 schema v36 / ADR-0066/0067：只有现有 `project` / `task` / `session` / `attention` / `scheduler` CLI，没有通用 `service` / `process` / `signal` / `intent` 命令，也没有产品侧受管 integration。

本文件是接下来多 Agent 改造的权威分波计划。历史实现记录不在这里重复，见 [`docs/tasks/README.md`](../tasks/README.md)；旧 ADR 保留原样，不因 roadmap 改写而失去审计价值。

## 1. 目标与硬边界

目标：把现有 Task Runtime 增量演进为“AI 的操作系统”内核：

```text
Codeestra Service #0
  ├─ Scheduler Service
  ├─ Attention Service
  └─ Project Services
       ├─ Task Services
       │    └─ Development Processes → Agents
       └─ Integration Processes → Agents

SIG_A：明确 API → Service handler / Operation
SIG_P：自然语言意图 → Process → Agent → Service APIs
```

硬边界：

1. 内核 Service-first，Scheduler 仍 Task-first；不把任意 Service 都变成调度任务。
2. Service 是 Runtime 内持久 Actor，不是 OS 进程或 busy-loop。
3. Process 只监督 Agent；Git/验证等确定性程序继续由 Operation 表达。
4. Signal 至少一次交付 + 幂等，不宣称跨 Git/进程/SQLite exactly-once。
5. 默认 FULL 零确认；不新增审批、RBAC、沙箱或信任层。
6. CLI/Unix socket 先行，所有能力有 `--json`、稳定退出码；Web UI 继续暂停。
7. 自动化验收只走 CLI/Runtime 命令面和临时仓库。
8. 增量 migration，不覆盖旧数据、不一次性重写、不并行抢 migration 号。
9. 当前用户改动、失败现场、现有 branch/worktree 不被清理或重置。
10. 产品受管 integration 与本仓库自身的人工 `dev → main` 发布规程是两件事；后者仍按 `docs/agents/runbook.md`。

## 2. 总依赖图

```text
S0 文档与契约冻结（本次）
 ├─ S1 纯领域内核
 │   ├─ S2 v37 持久化与只读投影
 │   │   ├─ S3 Signal dispatcher / Service registry
 │   │   │   ├─ S4 内核 CLI + 兼容 facade
 │   │   │   ├─ S5 Execution→Process 与控制面
 │   │   │   └─ S6 Intention / Attention 路由
 │   │   └─ S7 Task/Project Service 写路径切换
 │   │       └─ S8 v38 受管 integration
 │   └─ S9 Scheduler eligibility 解耦
 └───────────────────────────────┬───────────────
                                 └─ S10 收口、迁移演练与文档
```

`S4`、`S5`、`S6` 可在 S3 contract 稳定后并行；`S8` 必须等 S7 确认 Project/Task Service 已有单一事实源。`S9` 可与 S5–S7 并行开发，但最终接线依赖 S7。

## 3. 波次与验收

### S0 — 规格、ADR 与术语冻结（本次文档格）

交付：

- ADR-0068；
- `docs/architecture/service-process-signal.md`；
- `PROJECT_SPEC.md`、架构索引、领域/调度文档的目标语义；
- 本 roadmap 与多 Agent 分工；
- 当前实现与目标设计明确分层，不伪造已实现命令。

验收：本地链接成立；全文检索不再把“产品永远不集成”当长期目标；当前用户指南仍明确 v36 不具备新命令。

### S1 — 纯领域内核（无 schema、无副作用）

负责模块：`packages/domain`、必要的 `packages/contracts` 纯类型。

交付：

- `ServiceId` / `ServiceKind` / `ServiceTree`；
- parent/child 合法性、树无环、Task 只能直属 Project；
- core state version / metadata key/value 与 CAS reducer；
- `SignalEnvelope`、状态机、claim/ack/nack/retry/dead-letter 判定；
- `Process` 生命周期与 `Execution` 映射约束；
- `TaskEligibility` 值对象；
- 事件名先冻结，不实现 transport。

定向测试：

- 非法树边、环、Process 当父节点全部拒绝且零部分应用；
- metadata 不能修改 core state；
- 重复 signal idempotency key 收敛；
- Process 终态不复活、一个活动 Process 一个主 Agent；
- eligibility version 变化使旧准入失效。

退出条件：领域对象不导入 Bun/SQLite/Agent SDK；没有空 port 冒充能力。

### S2 — v37 additive storage 与只读投影

**migration 唯一 owner：一个 Agent。其他 Agent 不修改 migration/version。**

建议表（最终 DDL 由该格 ADR/设计确认）：

- `services`、`service_metadata`、`service_links` 或等价父关系；
- `signals`、`signal_attempts`、`signal_receipts`；
- `processes`、`process_execution_links`；
- root singleton 与 service contract version；
- append-only trigger / partial unique index / FK。

迁移策略：

- 启动时为每个 home 建稳定 root Service、Scheduler Service、Attention Service；
- 现有 Project/Task 先建立一一 projection link；Project/Task 表仍是 core state 权威源；
- 现有 Execution 建 Process projection link；不复制 lifecycle 字段的写权威；
- migration 可重复打开、旧库升级保留全部行，失败保留原库。

定向测试：v36→v37 真实文件升级、root singleton、树约束、幂等回执、FK check、故障注入与重新打开。

### S3 — Service registry 与持久 Signal dispatcher

负责模块：`apps/runtime`，复用 storage/outbox/Operation 原语。

交付：

- Runtime bootstrap 恢复 root/system/project/task Service registry；
- per-kind contract registry；
- enqueue / claim lease / dispatch / ack / retry / reconcile；
- `SIG_A` 严格 payload 校验；`SIG_P` 只记录并交给 Process factory，不直接在 Service 上挂 Agent；
- 事件驱动唤醒 + 周期 reconcile，无每 Service busy-loop；
- dead-letter / recovery facts 与 Attention 升级 hook；
- Runtime stop/draining 与全局暂停屏障接入。

故障矩阵：

1. enqueue 前失败；
2. enqueue 已提交、未 claim；
3. claim 后 handler 前崩溃；
4. Operation 已发起、Signal 未 ack；
5. handler 成功、ack 回写前崩溃；
6. 重复 signal / 重复 boot reconcile。

退出条件：每格都通过真实 SQLite + 临时 Runtime 测试证明“零丢失、不双副作用、不谎报 exactly-once”。

### S4 — 内核 CLI 与兼容 facade

负责模块：`packages/contracts`、`apps/cli`、Runtime dispatch；不得改 migration。

目标命令（本格冻结准确拼写）：

```text
service list|get|tree|state get|state set
process list|get|input|pause|resume|terminate
signal send|list|get|retry
intent send
```

要求：

- 所有 query/command 有严格 Zod、`--json`、退出码 0/1/2/3；
- `service state set` 只写 metadata；核心迁移必须走类型化命令；
- `signal send` 必须通过目标 contract，不能发送任意未注册 API；
- 现有 `project/task/session/attention/scheduler` 命令保持可用；
- 同一事实从新旧命令读出的 ID/state/version 一致；
- usage 与 `docs/guides/cli/` 同格更新。

### S5 — Execution → Process 与 Agent 控制面

负责模块：domain/runtime/agent adapters；不改变 Service/Signal schema。

交付：

- 每个新 Execution 同事务关联一个 Process；旧 Execution 懒迁移/投影；
- Process 固定 parent Task/Project Service、任务书、Agent config、预算与 status；
- `process input/pause/resume/terminate` 复用现有 Session Guidance、Task pause/resume/cancel 与 provider capability；
- token/cost/tool count/last progress 只读投影；
- successor Agent 创建 successor Process 或明确 incarnation 关系，不双 writer；
- Process 终态向 parent 发 Signal，重复 completion 幂等。

关键验收：Pi/Codex/Claude 不支持的能力继续如实拒绝；“已入队”不写成“模型已读”；进程身份不只看 PID。

### S6 — Intention 与 Attention 路由

交付：

- root/project/task/service 级 `intent send`；
- `SIG_P` 创建意图分析 Process；
- Process 上下文只包含目标 Service contract、可见子节点摘要和必要知识快照；
- 结构化输出只能是 route / typed command / create task / request clarification；
- 目标不明确时建立 Attention；回答按 correlation/causation 路由回原 Process；
- root Attention list 支持跨项目，现有 project filter 保持兼容；
- 原始用户输入、分类与路由审计保留。

非目标：本格不让模型自由生成 SQL/CLI 字符串，不自动把 task guidance 当 TaskRevision。

### S7 — Project / Task Service 成为单一写路径

交付：

- `project trust` 创建/恢复 Project Service；
- `task create` 创建 Task Service，Project/Task 表变为该 Service kind 的类型化 core projection；
- Task 创建、submit、revision、执行、验证、取消、归档统一经 Service handler；
- Service tree/query 与旧 CLI 无双写漂移；
- Scheduler 请求 Task Service 创建 Development Process，不直接拼装 Agent start；
- 兼容期事件名不重命名，新 Signal 事实与旧 domain event 的职责分开。

切换条件：必须有 migration rollback/forward 演练与“一条 command 只有一个权威 handler”的静态/测试证据。

### S8 — v38 受管 integration 与 Project merge queue

**必须在独立波次、由唯一 migration owner 执行。** 不复制旧 ADR-0018/0053 表，先按 ADR-0068 重新设计。

交付：

- Project Service 的 `integration_ref`、owned integration worktree 与 ownership token；
- Task 默认从 current integration commit 建固定 base；
- merge-request Signal、持久队列、单项目唯一活动 integration；
- Integration Process（Agent supervisor）与受控 Project Git API；
- task verification 与 integration verification 分离；
- expected integration OID + CAS 推进；
- conflict / failed verification / crash / stale ref 保留现场；
- 成功 Signal 更新 Task integration projection并触发下一项；
- CLI 类型化 facade（准确命名在该格 ADR 冻结），不恢复旧 `promotion *`。

验收：

- 两项目可同时集成，同项目严格串行；
- 用户主工作树始终 clean、HEAD/ref 不被直接操作；
- Task A 合入后，新 Task B 基线可达 A；
- ref 外部移动产生 STALE，不 force；
- merge 冲突只阻塞该项目 queue 的推进，不阻塞 root/其它项目/Attention；
- 集成成功后回收遵守 ownership，失败现场保留。

### S9 — Scheduler eligibility 解耦

交付：

- Task/Project 服务产出版本化 `TaskEligibility`；
- DAG、revision、冲突与基线可达性在领域服务求值；
- Scheduler 只做排序、全局控制、容量与 reservation；
- reserve 事务内重验 eligibility version；
- submit/Signal/依赖变化/集成成功触发 eligibility refresh；
- `BLOCKED` 仍只表示依赖，不把容量/全局暂停混进去。

验收：旧 scheduler CLI 的 explain 输出能指向 eligibility evidence；真实两个 SAFE Task 并发仍需真实 provider 验收，fake 不替代。

### S10 — 收口、演练、文档与兼容层清理

交付：

- v36→v37→v38 升级演练、备份与失败注入；
- Runtime crash/restart、signal reclaim、process reconcile、integration stale 全矩阵；
- current user guides 全面切换到新命令；
- 删除临时双读/投影代码前，证明旧 CLI 与新 CLI 使用同一权威 handler；
- 标注废弃但不突然删除兼容命令；删除需要独立 ADR；
- 真实 provider 验收清单更新；
- `docs/tasks/README.md` 逐格记录实际检查，不把未跑测试写成通过。

## 4. 多 Agent 分工建议

建议 8 个 ownership lane；同一文件只分给一个 lane，避免大量冲突：

| Lane | 主要所有权 | 首个任务 | 依赖 |
|---|---|---|---|
| A Contract | `packages/domain`、内核 contract 设计 | S1 | S0 |
| B Storage | `packages/storage`、migration | S2，之后 S8 migration | S1；唯一 migration owner |
| C Runtime Kernel | Service registry、Signal dispatcher | S3 | S1/S2 |
| D CLI | `apps/cli`、request schemas、CLI guides | S4 | S3 contract |
| E Process | Execution/Session/Adapter 映射 | S5 | S2/S3 |
| F Intent | intention、Attention 路由 | S6 | S3/S5 factory |
| G Project/Task | typed handlers、兼容 facade、eligibility | S7/S9 | S3，部分可并行 |
| H Integration | Git integration workspace、queue、verification | S8 | S7 + B migration |

协调者职责：

1. 先冻结跨 lane interface 与文件 ownership；
2. B lane 独占 migration 号和 `migration.ts`；
3. 每个 lane 只运行定向测试，范围扩大时更新 `.codeestra/tests.json`；
4. 每个合并点做 contract/schema/event 名审查；
5. 最终在长期 `dev` 的精确候选 SHA 上才运行全量检查；
6. 不让多个 Agent 同时改 `PROJECT_SPEC.md`、ADR 索引、roadmap；文档收口由协调者统一完成。

## 5. 每格交付模板

每个 Agent 的任务书必须包含：

- 本格目标与明确非目标；
- 可修改文件清单和禁止修改文件；
- 输入 contract 版本 / schema 版本；
- 3–8 条不变量；
- 具体定向测试文件/命令；
- 稳定错误码与退出码；
- crash/retry/idempotency 预期；
- 文档落点；
- 未验证能力的诚实声明。

完成定义：代码、定向测试、CLI contract、migration（如有）、对应架构/用户文档和 `docs/tasks/README.md` 记录同格交付。只写代码不写命令面或文档，不算完成。

## 6. 保留但不阻塞内核改造的既有缺口

这些缺口仍然真实，但不抢在 S1–S4 前破坏新内核接口：

- 真实 provider 的并发、暂停/恢复、revision ACK 与取消超时复验；
- PTY 跨交接权限矩阵与真实模型完整复验；
- Project Knowledge 的模型侧消费验证；
- Codex 散文问题事实层；
- Phase 7 Self Evolution / bootstrap；
- Web UI 继续暂停。

若某缺口会改变 Service/Process/Signal 公共 contract，应先升级为当前波次的阻塞项；否则独立并行处理。

## 7. 非目标

- 云端分布式 Service、跨机器 Signal、Kafka/RabbitMQ；
- 每 Service 一个进程、容器或线程；
- 多用户/RBAC/租户/密钥托管；
- 自动发布 integration ref 到用户 main/release；
- 恢复 Web UI；
- 桌面/键鼠自动化测试；
- 一次性 schema reset 或删除历史审计。
