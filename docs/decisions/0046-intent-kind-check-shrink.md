# ADR-0046 — `intents.kind` 缩小到可产生取值（schema v28）

状态：**Accepted**（用户 2026-09-15 就「未使用取值」明确选择「缩小 CHECK（要迁移）」）。
任务：FOUNDATION-075（Wave K / K2，`lane/k2-spec-and-intent-kind`）。基线：`dev = 8bc1262`（K1 文档校准之后）。
同格还完成一次**已被用户明确授权的规格修订**（`PROJECT_SPEC.md` 的状态段与 §1 intent 清单，见末节）。

## 背景

`intents.kind` 自 schema v1 起的 CHECK 声明了七个取值：

```
'CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT','CANCEL_TASK',
'CHANGE_PRIORITY','ANSWER_AGENT','SELF_MODIFICATION'
```

FOUNDATION-074（K1 文档校准）在 `docs/guides/troubleshooting.md` §3 第 10 条如实记录了这里的声明与实际不一致，
但**把事实写错了一半**：它写「`CHANGE_PRIORITY`、`ANSWER_AGENT`、`SELF_MODIFICATION` 三种取值都没有任何 CLI
产生路径」。本格逐条复核 `packages apps --include=*.ts` 的非测试命中后确认：

| 取值 | 真实情况 | 证据 |
|---|---|---|
| `CREATE_TASK` | 有产生路径 | `packages/storage/src/database.ts` 的 `createTask` |
| `AMEND_TASK` / `ADD_CONSTRAINT` | 有产生路径 | 同文件 `appendRevision`（由 `apps/runtime/src/revision-delivery-service.ts` 传入） |
| `ANSWER_AGENT` | **有产生路径**（K1 写成「没有」，是错的） | 同文件 `planAttentionAnswer` 与 `createTask` 之外的 Attention answer 事务：intent 与同名 `operations.kind` 在同一写事务内写入 |
| `CHANGE_PRIORITY` | 无产生路径 | 非测试命中只有 CHECK 定义本身 |
| `SELF_MODIFICATION` | 无产生路径 | 同上 |

`ANSWER_AGENT` 的完整性可以直接从数据读出：本机稳定库 `intents` 共 33 行，取值分布只有 `ANSWER_AGENT` 24、
`CREATE_TASK` 9（迁移前复核，见「验证要求」）。因此**任何把这三个取值一起删掉的做法都会直接弄坏 attention
answer**——这正是本格必须先把 K1 的事实错误改正、再动手的原因。

问题本身是**声明与能力不一致**：schema 承诺了产品根本产生不了的状态。声明里的取值会进入审计语义、UI 投影与
后来者的判断（K1 就被它误导了一次），而它本身没有任何命令面支撑。

## 选项

| 选项 | 说明 | 否决理由 |
|---|---|---|
| **A. 缩小 CHECK**（本格采用） | 迁移重建 `intents`，只保留五个可产生取值 | 声明与能力一致；代价是 `CHANGE_PRIORITY` 连同「优先级可被改」这件事一起被移除（见「后果」） |
| B. 补命令面 | 新增 `CHANGE_PRIORITY` / `SELF_MODIFICATION` 的命令与语义 | 这是**新能力**：需要命令面、状态迁移、DRAFT/READY 语义、调度交互与测试，以及 ADR-0030 里「优先级是否抢占」的再确认。用户本轮明确选的是 A，补命令面是另一个决策 |
| C. 保留未用取值 | 什么都不做，只在文档里标注 | 声明的假状态会继续误导（K1 已经发生过一次），且 `SELF_MODIFICATION` 要等到 Phase 7 才有意义——中间这段时间里它只是噪声 |
| D. 用触发器拒绝两个取值，不重建表 | 不改 CHECK、只加 `BEFORE INSERT` 触发器 | 拒绝的是运行时写入，**表 DDL 仍然声明七个取值**，`sqlite_master` 里那句假话还在；触发器还可以被删掉。声明本身必须改 |

## 决定

### D01 CHECK 缩小为五个取值，`ANSWER_AGENT` 保留

```sql
kind TEXT CHECK(kind IN ('CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT','CANCEL_TASK','ANSWER_AGENT'))
```

`ANSWER_AGENT` **必须留下**：`answerAttentionRequest` 在同一事务里写 `ANSWER_AGENT` intent、
`intent_attention_targets` 与同名 `ANSWER_AGENT` Operation，删掉它会让每一次回答 Attention 直接失败。

### D02 schema v28：重建 `intents`，三处外键引用一字不动

SQLite 不能就地收窄 CHECK，因此 `intents` 被重建（先例：v7 重建 `workspaces`、v9 重建 `executions`、
v24 重建 `reclamation_records`）。`intents` 被三张表按名字引用——`task_revisions.source_intent_id`、
`intent_targets.intent_id`（`WITHOUT ROWID` 复合主键）、`intent_attention_targets.intent_id`——所以：

- 重建期间必须 `PRAGMA foreign_keys=OFF`；
- 迁移后必须 `PRAGMA foreign_key_check` 为空（沿用既有 rebuild 步骤的收尾校验）；
- 三张引用表的行、外键子句与各自的触发器（`task_revisions` 的 append-only 触发器对）必须原样保留；
- `intents` 的键必须原样保留：主键索引与 `UNIQUE(project_id, idempotency_key)`。v27 的 `intents` 上没有任何
  触发器，v28 也不新增。

### D03 迁移号：追加 v28，不插旧号

`phase1SchemaVersion` 27 → 28，`migrate()` 只在既有升序链尾追加 `if (version < 28)`。**v16 继续永久未使用、
v22 继续未占用**，既有迁移段一字未改（包括 `phase1Migration` 里那句仍然声明七个取值的 v1 DDL——历史迁移不重写）。

`rebuildsTable` 谓词从 `version < 9` 改为 `version < 28`：`workspaces`(v7)、`executions`(v9)、`intents`(v28) 三者
都被别的表按名字引用，因此**任何**低于最新 rebuild 步骤的升级都要关外键并在结束时校验全库。这比原来更宽，
是本格对先例的第一处刻意偏离（原来的写法只为 v7/v9 服务，继续沿用会让 v28 在真实库里撞上外键）。

### D04 绝不静默丢数据或改写取值：升级前拒绝，升级后比对行数

被移除取值的既有行是**用户数据**，不是可以顺手清理的垃圾。因此 `migrate()` 在 v28 步骤上做两件事：

1. **升级前**：统计 `intents` 中 `kind` 属于被移除取值的行（`NULL` 不算，v1 的 CHECK 本来也允许它）。只要有一行，
   就以稳定码 `INVALID_STATE` 明确失败，报文列出取值与行数，并明说「nothing was changed」；不执行任何语句。
2. **升级后**：比对重建前后的 `intents` 行数，不等就报 `INVALID_STATE` 并让整个事务回滚。

第 2 条不是装饰。实测（Bun 1.4.2，本机）**`Database.exec()` 对多语句脚本里的 step-time 错误不抛异常**：语句
报错后它继续执行后面的语句、并且不把错误交给调用方（`prepare` 阶段的错误仍然会抛，所以「表不存在」这类会停）。
把这条与本次迁移的形状放在一起看就是一条真实的数据丢失路径：若 `INSERT ... SELECT` 因收窄后的 CHECK 被拒，
后面的 `DROP TABLE intents` 仍会执行，行就没了而且没有异常。**任何未来重建表的迁移都必须同样守卫自己的复制步骤**，
不能依赖 `exec()` 的报错。

### D05 边界拒绝有稳定码，不靠 SQLite 的 CHECK 报文

三个写 `intents` 的点（`createTask`、`planAttentionAnswer`、`appendRevision`）统一走一个私有 `insertIntent`，
它先用 `assertIntentKind` 校验取值：不在集合内则抛 `StorageError('UNSUPPORTED_INTENT_KIND')`，
报文列出可接受取值。数据库 CHECK 仍是最后一道防线，但调用者拿到的是稳定码而不是 `CHECK constraint failed`。

**如实边界**：这三个点的 kind 目前分别是字面量、字面量、编译期联合 `'AMEND_TASK' | 'ADD_CONSTRAINT'`，
因此**产品命令面上没有一条路径能把被移除的取值送进来**——这也正是「声明无产生路径」的另一面。这个守卫
（连同它被导出的 `assertIntentKind`/`intentKinds`）因此是**边界不变量**的显式表达与回归锚点，不是「修了一个
用户可达的 bug」。本格在测试里直接驱动它，不假装它网络可达。

## 后果

- **`CHANGE_PRIORITY` 被移除 = 优先级目前任何命令都改不了，`tasks.priority` 恒为 0。** 这是本格必须如实记录的
  代价：**ADR-0030 里「候选顺序 priority desc → createdAt asc → id asc」中的 priority 一项在现状下是惰性的**
  （排序仍然执行，只是所有候选都是 0，等价于按 createdAt asc → id asc）。ADR-0033 的引擎、`tasks_schedule`
  索引与 §2 不变量 2 都继续保留 priority 字段与语义，但**没有任何命令能让它非 0**。要恢复可变优先级，
  应当新开一格补 `CHANGE_PRIORITY` 的命令面（选项 B），届时需要再次迁移把取值加回来。
- **`SELF_MODIFICATION` 的预告**：Phase 7 落地 Self Evolution 时必须**再做一次迁移**（v29 或更后）把该取值重新
  加入 CHECK，并重建 `intents` 一次；本格不预留占位取值，也不提前创建未来语义。
- 新增稳定码 `UNSUPPORTED_INTENT_KIND`（`StorageError`）与导出 `intentKinds` / `IntentKind` / `assertIntentKind`。
- 真实库升级风险：稳定库 33 行 `intents` 全部是 `ANSWER_AGENT`(24) / `CREATE_TASK`(9)，两者都保留，因此
  真实升级路径上不会触发 D04 的拒绝；这一事实已在迁移前重新复核（见「验证要求」）。
- 不新增确认、门禁、权限层或沙箱（ADR-0008/0011）；不改 FULL/STRICT 语义。
- 与 `docs/architecture/sqlite-schema.md` 第 2 节的 `intents` DDL 记录一致的问题由同格同步修正（该文档记录的是
  **实现里实际存在的** DDL，不改就会变成假话）。

## 被否掉的选项（补充）

| 选项 | 否决理由 |
|---|---|
| 收窄时顺手把被移除取值的行改写成 `CREATE_TASK` 或删掉 | 改写历史与静默丢数据，违反审计不变量；D04 选择明确失败并保留原库 |
| 在迁移里用 `SELECT RAISE(ABORT, …)` 做前置守卫 | 实测 SQLite 只在 trigger 程序内允许 `RAISE()`，多语句脚本里会以「no such table / misuse」类错误失败，做不到「说清原因」；改为在 `migrate()` 里用 TS 守卫 |
| 让迁移脚本自己 fail-closed（依赖 `exec()` 抛错） | D04 第 2 条已说明 Bun 的行为不允许这样假设 |

## 验证要求

**必须由迁移前的真实数据复核**：`intents` 的取值分布。本格以 `{readonly:true}` 只读打开本机稳定库
`~/.local/state/codeestra/runtime.sqlite`（当时仍是 v27，未写、未改、未停稳定 Runtime）：**33 行 = `ANSWER_AGENT` 24 + `CREATE_TASK` 9**，
`CHANGE_PRIORITY` / `SELF_MODIFICATION` 各 0 行（`tasks.priority` 9 行也全为 0）。复核命令与输出见 `docs/tasks/README.md` 的 FOUNDATION-075 一节。

已执行（ADR-0038 的定向范围，**未**运行全量/聚合检查）：

- `packages/storage/test/intent-kind-shrink.test.ts`（新增，6 项通过）：
  1. v28 属于本格、`intentKinds` 是那五个、迁移文本不含两个被移除取值、含 `CREATE TABLE intents_v28`；
  2. **真实文件库 v27 → v28**：用 v1…v27 的完整迁移链构造一个**合法** v27 库（外键打开、`foreign_key_check` 为空）
     并种入 `intents` 与三张引用表各一行；升级后断言 `user_version`、`foreign_key_check` 为空、`intents` 两行逐字段
     原样、三张引用表的行与关键字段原样、三处外键子句仍指向 `intents`、`intents` 仍有两个键（PK + 唯一键）且
     重复幂等键被拒、`intents` 上仍无触发器而 `task_revisions` 的两个 append-only 触发器仍在；
  3. 含 `CHANGE_PRIORITY` **或** `SELF_MODIFICATION` 的 v27 库：`StorageError` 稳定码 `INVALID_STATE`、
     报文含取值名与「nothing was changed」；升级后原库仍是 v27、该行仍在、没有留下 `intents_v28`、行数不变、
     `foreign_key_check` 仍为空；
  4. 迁移文本不会被「会丢行」的升级路径执行到（并解释为什么不直接 `exec()` 它）；
  5. 边界：`assertIntentKind` 对两个被移除取值与未知取值抛 `UNSUPPORTED_INTENT_KIND`，`ANSWER_AGENT` 通过；
     直接 SQL 写入这两个取值被 CHECK 拒绝且零落库；
  6. **`ANSWER_AGENT` 仍可写**：在升级后的 v28 库上调用产品路径 `planAttentionAnswer`，断言写出
     `ANSWER_AGENT` intent 与 `intent_attention_targets` 行（证明保留它是必要的，而不是把 K1 的错误实现成回归）。
- `apps/runtime/test/cli-attention.test.ts`（既有 e2e，3 项通过）：真实 CLI + 真实 Runtime 的问卷问答往返——
  产品路径上的 `ANSWER_AGENT` 仍然成立。
- `apps/runtime/test/workspace-service.test.ts`（既有，21 项通过）：其中一项直接断言 attention answer 写入
  `kind='ANSWER_AGENT'`、`status='APPLIED'`。
- 既有 `phase1SchemaVersion` / `user_version` 断言的 storage 与运行时用例回归（共 128 + 48 + 32 项通过，含 v10/v16/v20/v26/v27 库的升级用例、
  `reclaim` 账本与 promotion/verification/revision-delivery 的完整 e2e）；`CREATE_TASK` 路径的 `apps/runtime/test/cli-task-create.test.ts`
  4 项通过。逐命令与结果见 `docs/tasks/README.md` 的 FOUNDATION-075 一节。
- `bun run typecheck` 退出码 0。

（注：涉及 HTTP/SSE 的 e2e 在本机需先取消 `http_proxy`/`https_proxy`/`all_proxy` 并设 `NO_PROXY=127.0.0.1,localhost`——
Bun 的 `fetch` 会把这些代理用在 `127.0.0.1` 上，表现为 UI 传输面拿到非 JSON 响应。这是环境问题，不是代码问题，已记入 FOUNDATION-075。）

**未验证（不得当作已成立）**：

- 稳定 Runtime 上的真实升级**没有在本格执行**（禁止触碰 `/Users/loyage/Documents/codeestra` 与其稳定 Runtime）；
  真实库的取值分布只做只读复核。
- 「升级后行数比对」（D04 第 2 条）本身没有直接测试，因为除了 kind 列之外重建不引入任何新约束，
  构造不出「复制被拒但不在前置检查里」的场景；它是前置检查之外的第二道网。
- Bun `exec()` 吞掉 step-time 错误的行为只在**本机 Bun 1.4.2** 上实测（`package.json` 的 pin 是 1.3.13，
  本机实际运行的是 1.4.2），未验证其它版本。

## 同格完成的规格修订（用户明确授权）

用户 2026-09-15 裁决：「`PROJECT_SPEC.md` §1 的状态段与同文件 §3 自相矛盾 → 开一格修规格」，并明确授权本格
修改规格文件；随后追加授权「一并修 §8 的现状陈述」。逐句见 `docs/tasks/README.md` 的 FOUNDATION-075
「本次规格修订」一节。**§1.1 第一原则、§2 不变量、§3–§9 的规范语义一字未改**（`git diff` 只有三行：
第 3 行状态段、§1 的 intent 分类句、§8 的现状陈述段）。
