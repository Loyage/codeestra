# ADR-0041 — Project Knowledge：分层、只读来源与 Execution 绑定

状态：已接受（FOUNDATION-067 第一小步已实现；Provider 侧消费未验证）
日期：2026-09（Phase 6 第一小步）
相关：`PROJECT_SPEC.md` §2 不变量 15、§4；ADR-0006（验证策略只读 main ref）、ADR-0008（效率至上 / CLI 完备 / 测试仅限命令面）、ADR-0011（FULL 零确认）、ADR-0031（impact 映射只读 main ref）、ADR-0038（开发分支定向测试）

## 背景

`PROJECT_SPEC.md` §4 预留了 `.codeestra/{instructions,skills,policies,generated}` 布局，§2 不变量 15 要求「Human-authored knowledge 和 machine-generated knowledge 分离；Agent 不能静默覆盖人工维护的知识文件」，`docs/roadmap/mvp.md` Phase 6 的验收是「机器生成不能覆盖人工知识；Execution 能追溯实际使用的知识版本」。但仓库里**完全没有任何知识加载路径**（协调者已 grep 确认），`.codeestra/` 下只有 `policies/verification.json`，且 `AgentStartRequest.knowledgeSnapshotRefs` 虽已预留却始终传 `[]`。本格是本阶段的第一个小步，语义基本未定，因此所有产品行为、数据语义、Git 跟踪策略与 schema 形态都先由用户拍板（三轮共 13 题）再实现。

## 决定

### D01 载体与格式：Markdown + 窄 YAML front-matter，手写解析器，只加载 `.md`

人工知识是 Markdown 文件，可选 front-matter 只支持**顶层标量键** `id` 与 `scope`；`instructions/` 与 `skills/` 用同一套规则。**不新增 YAML 依赖**，front-matter 解析器只支持这一个子集：嵌套、序列、多行标量、锚点、注释、重复键与**未知键一律拒绝**（`KNOWLEDGE_INVALID_FRONT_MATTER`）。理由：把 `scope: SELF` 误写成 `scpoe: SELF` 时，静默忽略未知键等于把「只给 SELF 任务看」变成「所有任务都看」，而这是无声的语义改变。扩展名不是 `.md` 的文件（含 `generated/` 旁的 `.meta.json`）**忽略且不报错**。

### D02 层序与无覆盖语义

加载顺序是固定常量：`instructions` → `skills` → `generated`（先人工后机器），仅决定列举与渲染顺序。**没有覆盖语义**：所有可解析的人工条目整体进入快照，一条都不丢弃；重复 `id` 或重复路径是 fail-closed 拒绝（`KNOWLEDGE_DUPLICATE_ID` / `KNOWLEDGE_DUPLICATE_PATH`），不是「后者胜」。**不引入任务级覆盖**，因此 Task 分支无法改写判自己的知识——与 ADR-0006、ADR-0031 对 `verification.json` / `impact.json` 的处理一致。

### D03 人工层只从项目 `main` ref 读取

人工层用与 `.codeestra/policies/verification.json` 完全相同的读法（`git rev-parse` + `git ls-tree` + `git cat-file blob`）从项目 `main` ref 读取。Task 分支（包括其 worktree）上的同名文件**不参与判定**。读取用 `TextDecoder({fatal:true})` 解码，非 UTF-8 是拒绝而不是有损替换。

### D04 人工层非法则拒绝建立 Execution（fail-closed）

语法非法、超出上限（每层 256 条、单条 64 KiB、整快照 1 MiB、front-matter 32 行）、非 UTF-8、重复 id/路径 → **在 `reserveExecution` 之前抛出稳定错误码，Execution 行不落库**。`generated/` 缺失或为空是正常状态。这是正确性核对，**不是新增确认门禁**（ADR-0008/0011）。`project knowledge validate|list` 一次列出全部拒绝项（退出码 1），而不是只报第一条。

### D05 机器生成层的读写都在 Runtime 数据目录，项目树里一个字节都不写

机器生成层的**读**位置是 `<CODEESTRA_HOME>/knowledge/<project-id>/generated/`；某个 Execution 物化出的知识上下文**写**到 `<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md`。**规格修订**：`PROJECT_SPEC.md` §4 原先只写「`.codeestra/generated/` 机器生成」，本轮显式修订为上述布局并记录理由。

理由是一次实测到的缺陷，而不是偏好：

- worktree 里未被 ignore 的未跟踪文件会进入该 Task 的 Git change set（`packages/git/src/result-commit.ts` 的 `git ls-files --others --exclude-standard` 与 `git add --all`）。因此把 `knowledge-context.md` 写进 Task worktree 会（a）让**任意两个并发 Task 都因同一个路径被判 `SAME_FILE`/`CONFLICTING`**——实测现象是 `apps/runtime/test/cli-task-retry.test.ts` 的容量等待用例从退出码 3 变成冲突拒绝，impact 报告原文为 `SAME_FILE against <holder>: 1 file(s) changed by both — paths .codeestra/generated/knowledge-context.md`；（b）让它被 `task result capture` 的 `git add --all` 提交进成果 commit，随后经 IntegrationBatch 进入 `dev`，直接违反「机器生成不得进提交」。
- 本仓库的 `.gitignore` 规则只对本仓库生效；用户项目没有这条规则，所以这不是夹具缺规则，而是产品缺陷。
- 唯一能同时消除两者的替代方案是写用户仓库的 Git 元数据（`.git/info/exclude`，实测为 **common dir** 作用域，会影响该仓库所有 worktree 与用户自己的工作树），或让 change set/成果提交按路径过滤（跨领地且引入需审计的语义）。两者都被否掉。

因此 `.codeestra/generated/` 在 `.gitignore` 里只是**守卫规则**（防止用户仓库里残留同名目录被提交），不是存放位置。`policies/` 仍由既有 JSON 机制独占，不进知识层。

### D06 机器生成的写入者与来源元数据

只有 Runtime 的 knowledge service 可写机器生成层；**不新增「机器写 generated/」的 CLI 命令**（没有「用户写机器生成知识」这个产品能力）。`generated/` 下每个 `<entry>.md` 必须有一个 `<entry>.meta.json` 记录来源与版本（`version:1` + `source` 必填，`kind`/`revision`/`commit`/`generatedAt` 可选）；缺元数据或元数据非法 → 拒绝（`KNOWLEDGE_GENERATED_PROVENANCE_MISSING` / `_INVALID`），因为 §4 要求机器生成内容携带来源与版本信息。

写入路径唯一且 fail-closed：`assertMachineGeneratedWriteTarget` 拒绝任何非机器生成区路径、任何 `.codeestra/` 下非 `generated/` 的路径（`KNOWLEDGE_HUMAN_FILE_PROTECTED`，写入前抛出、零字节写入），并拒绝 `..`/空段/`.git`/反斜杠/绝对路径/`~`；`writeRuntimeKnowledgeFile` 没有 worktree 或绝对路径参数，目标只能由 Runtime home 推导，且拒绝 symlink 与非普通文件目标。

### D07 digest 粒度与 schema v26

digest 粒度 = **每文件 body digest + 整体快照 digest**（逐条目 + 人工/机器分层 digest）。快照 digest 覆盖 `policyVersion`、`mainRef`、`mainCommit`、逐条 `{layer,path,id,scope,digest,origin}`（`origin` 键序固定），**不含 `generatedAt`**：时间戳不是知识身份，内容相同的重新生成不应让快照失效；但 `source`/`kind`/`revision`/`commit` 参与 digest，因为它们是知识来源的一部分。

schema **v26** 新建两张 append-only 表：

- `knowledge_snapshots`：`(project_id, main_commit, snapshot_digest)` 唯一，`no_update`/`no_delete` 触发器使「不可改写」成为 schema 事实；记录逐条 `entries_json` 与各层 digest。
- `execution_knowledge_snapshots`：每 Execution 一行，记录所用 `snapshot_id`、物化文件的 `context_path`/`context_digest`/`context_bytes` 与 `refs_json`。

**不重建 `executions` 表、不新增列**：把绑定的插入放进 `reserveExecution` 的同一写事务，即可让「Execution 存在」与「已绑定所用知识版本」不可分开观察，而没有表重写的风险，既有历史行原样保留。`phase1SchemaVersion` 24 → 26，只追加 `if (version < 26)`（v25 属并行 lane，v16 永久未使用，绝不插入更早的号）。迁移断言一律用常量或 `>= 26`，禁止写死 `== 26`。

### D08 适用范围复用既有 `Task.kind`

`scope` 取 `ALL`（缺省）| `DEVELOPMENT` | `SELF`，复用 schema 里已存在的 `tasks.kind`；`project knowledge resolve` 按该 Task 的 kind 过滤。不发明第二套适用范围词汇。

### D09 命令面

`project knowledge validate <project-id>` / `list <project-id>` / `show <project-id> [snapshot-id]` / `resolve <project-id> <task-id>`，全部 `--json`、退出码 0/1/2、零新增确认，读法风格与 `project impact *` 一致。四个命令都是只读观察：它们派生条目与 digest，**不**记录快照、**不**物化上下文、**不**启动 Task。记录发生在恰好的一个地方——建立 Execution 时。`validate`/`list` 在任何条目被拒时退出 1（此时没有快照）；`show` 在项目还没有记录过快照时退出 1；`resolve` 只在没有任何诚实答案时退出 1。

### D10 Execution 绑定与 Adapter 契约

`#startPreparedExecution`（`task.run` 与调度引擎共同的唯一建立点）在 `reserveExecution` 之前解析、校验并物化知识，把 `{snapshotId, snapshotDigest, contextPath, contextDigest, contextBytes, entryCount, refs, commandId}` 作为 `knowledgeBinding` 传入；`refs` 同时经 `startReservedExecution` 填进 `AgentStartRequest.knowledgeSnapshotRefs`（`knowledge-snapshot:<digest>` 加逐条 `knowledge-entry:<layer>:<path>#<digest12>`）。successor Session 复用该 Execution 已记录的 refs（绑定不可改写）。对 `apps/runtime/src/agent-runtime-service.ts` 与 `agent-start-service.ts` 的改动是最小追加式的：新增参数与调用，不改既有分支语义，已在 `docs/tasks/README.md` 逐处列出。

## 后果

- 「机器生成不能覆盖人工知识」在本格是**结构性**的：Runtime 从不写项目树，人工路径在写入前被具名拒绝，人工层只从 `main` ref 读。
- 「Execution 能追溯实际使用的知识版本」是可脚本化查询的事实：`project knowledge show <project-id>` 给出该快照与绑定到它的 Execution（含物化文件的 digest）。
- 零新增确认、零新增门禁，常态路径不增加任何用户步骤。
- 已知边界（如实记录，不声称已完成）：
  - **Provider 侧消费未验证**。本轮 Agent Adapter 不消费 `knowledgeSnapshotRefs`，本格领地也不含 `packages/agent-adapters/**`，所以「Agent 真的读到了知识」**不成立**；只有「解析、物化、绑定与可追溯」成立。adapter 侧注入属后续格。
  - 机器生成层的**写入者**（除了每 Execution 的 `knowledge-context.md`）尚未实现；`generated/` 的读取、provenance 校验与拒绝路径已实现并有测试。
  - 无向量检索 / embedding / LLM 摘要；`policies/` 不进知识层。
  - UI 未投影（`apps/ui/**` 不在本格领地）。
  - 知识层大小上限是常量，不是项目配置。

## 验证要求

- 纯领域：`packages/domain/test/knowledge.test.ts`（front-matter 子集与拒绝、路径与层的归属、body digest 忽略 front-matter、层序、重复 id/路径 fail-closed、空快照合法 vs 超限拒绝、digest 稳定性与变更敏感性、`generatedAt` 不参与 digest、scope 过滤、渲染确定性）。
- 真实 SQLite：`packages/storage/test/knowledge.test.ts`（v24 → 当前版本的加性升级且既有行保留、`>= 26` 断言、快照按 key 幂等、append-only 触发器、绑定唯一且不可改写、引用完整性、`reserveExecution` 同事务绑定与失败整体回滚且零残留）。
- 真实命令面：`apps/runtime/test/cli-knowledge.test.ts`（临时 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）——分层与加载、Execution 绑定与可追溯、`main` ref 是人工层唯一来源、机器写人工路径被拒且零写入、人工层非法拒绝建立 Execution、机器生成 provenance 校验，以及**两个并发 Task 不因机器生成知识互相判冲突**（worktree change set 只含 Agent 产物）。
- 回归：本格修改的既有版本断言（`phase1SchemaVersion`）与受影响路径的定向测试必须重跑并通过。
