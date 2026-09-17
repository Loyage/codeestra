# Project Knowledge

状态：Phase 6 第一小步已实现（FOUNDATION-067 / ADR-0041，schema v26）。Provider 侧消费**未验证**。

本文描述已落地的知识分层、只读来源、适用面与 Execution 绑定。语义裁决见 [ADR-0041](../decisions/0041-project-knowledge-layers-and-execution-binding.md)，规格见 `PROJECT_SPEC.md` §4 与 §2 不变量 15。

## 1. 三个层与它们的位置

| 层 | 类型 | 位置 | 谁写 | 进 Git |
|---|---|---|---|---|
| `instructions` | 人工维护 | `<repo>/.codeestra/instructions/**.md` | 人 | 是 |
| `skills` | 人工维护 | `<repo>/.codeestra/skills/**.md` | 人 | 是 |
| `generated` | 机器生成 | `<CODEESTRA_HOME>/knowledge/<project-id>/generated/` | 只有 Runtime | 否（不在项目树内） |
| ——（每 Execution 的物化上下文） | 机器生成 | `<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md` | Runtime | 否（不在项目树内） |

`policies/` 仍是人工维护目录，但由既有 JSON 机制独占（`verification.json` / `impact.json`），**不进知识层**；`project knowledge *` 不读取它。

**人工层只从项目 `main` ref 读取**，读法与验证策略、影响映射完全一致：`git rev-parse --verify <ref>^{commit}` → `git ls-tree -r -z` 列举 → `git cat-file blob <commit>:<path>` 逐条读取，用 `TextDecoder({fatal:true})` 解码。因此 Task 分支（及其 worktree）上的同名文件不参与判定。

**机器生成层与物化上下文都是 Runtime 数据，项目树里一个字节都不写。** 这不是风格选择：worktree 里未被 ignore 的未跟踪文件会进入 Task change set（`git ls-files --others --exclude-standard`、`git add --all`），并被成果 commit 提交；ADR-0068 目标下还会进入 Project managed integration ref。放在 Runtime 数据目录让“机器生成不进提交”成为结构事实，而不依赖 ignore 规则。项目中 `.gitignore` 的 `.codeestra/generated/` 只是守卫规则，不是存放位置。

## 2. 条目、层序与无覆盖语义

- 只有 `.md` 是条目；其它扩展名（含 `generated/` 旁的 `.meta.json`）**忽略且不报错**。
- 可选 front-matter 仅支持顶层标量键 `id`（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`）与 `scope`（`ALL` | `DEVELOPMENT` | `SELF`，缺省 `ALL`）。未知键、嵌套、序列、多行标量、重复键一律拒绝——静默忽略未知键会把 `scpoe: SELF` 这样的一次手误变成「所有任务都读」。
- 层序是固定常量 `instructions → skills → generated`，只决定列举与渲染顺序。
- **没有覆盖语义**：所有可解析的人工条目整体进入快照，一条都不丢弃。重复 `id` 或重复路径是 fail-closed 拒绝（`KNOWLEDGE_DUPLICATE_ID` / `KNOWLEDGE_DUPLICATE_PATH`）。不做任务级覆盖，Task 无法改写判自己的知识。
- `scope` 曾复用 `tasks.kind`；自 ADR-0065 起 Task 不再有 kind（v35 删了该列），而 `scope` 的解析**不变**（不让人工维护的现有文件变成非法）：`ALL` 与 `DEVELOPMENT` 条目适用，`scope: SELF` 条目当前无法适用于任何执行（SELF 尚不存在），这也是 `project knowledge resolve` 如实的 `appliesToTask: false`。Phase 7 落地 Self Task 时按 PROJECT_SPEC §5 重新迁移。

## 3. 失败语义

| 情况 | 结果 |
|---|---|
| 人工层 front-matter/取值非法、超限、非 UTF-8、重复 id/路径 | 稳定错误码；`validate`/`list` 退出 1；**拒绝建立 Execution**（在 `reserveExecution` 之前抛出，Execution 行不落库） |
| `generated/` 缺失或为空 | 正常的空层 |
| `generated/<entry>.md` 缺 `<entry>.meta.json`，或元数据非法 | `KNOWLEDGE_GENERATED_PROVENANCE_MISSING` / `_INVALID`（§4 要求机器生成内容携带来源与版本） |
| 机器试图写人工维护路径 | `KNOWLEDGE_HUMAN_FILE_PROTECTED`，**写入前**抛出，零字节写入 |

拒绝是正确性核对，不是新增确认门禁：FULL 下没有任何额外步骤（ADR-0008/0011）。

## 4. 快照与 Execution 绑定

一次「快照」= 某个 `main` commit 上解析出的完整条目集合（人工层 + 机器生成层），带：

- `snapshotDigest`：覆盖 `policyVersion`、`mainRef`、`mainCommit`、逐条 `{layer,path,id,scope,digest,origin}`（`origin` 键序固定）；
- `humanDigest` / `generatedDigest`：分层 digest；
- 每条目 `digest`：该文件 **body**（去掉 front-matter）的 sha256，因此改 front-matter 的 `id` 不会伪装成内容变化；
- `origin`：机器生成条目的 `source`/`kind`/`revision`/`commit`；`generatedAt` 参与记录但**不参与 digest**（时间戳不是知识身份）。

建立 Execution（`task.run` 与调度引擎共同的唯一路径 `#startPreparedExecution`）时，Runtime 按固定顺序：

1. 从 `main` ref + Runtime 生成层解析并校验（任一条目被拒即抛出，Execution 不建立）；
2. 渲染该 Task 适用的条目为确定性 Markdown（ADR-0065 之后一律按 `DEVELOPMENT` 判定），写入 `<home>/knowledge/<project-id>/<task-id>/knowledge-context.md`；
3. `recordKnowledgeSnapshot`（按 `(project, mainCommit, snapshotDigest)` 幂等）得到 `snapshotId`；
4. 在 `reserveExecution` 的**同一写事务**里插入 `execution_knowledge_snapshots`，记录 `snapshotId`、`context_path`、`context_digest`、`context_bytes`、`refs_json`；
5. 把 `refs`（`knowledge-snapshot:<digest>` + 逐条 `knowledge-entry:<layer>:<path>#<digest12>`）填进 `AgentStartRequest.knowledgeSnapshotRefs`。

因此「Execution 存在」与「已绑定所用知识版本」不可分开观察；绑定不可改写；successor Session 复用同一绑定。

## 5. 命令面

```
bun run codeestra project knowledge validate <project-id> [--json]
bun run codeestra project knowledge list <project-id> [--json]
bun run codeestra project knowledge show <project-id> [snapshot-id] [--json]
bun run codeestra project knowledge resolve <project-id> <task-id> [--json]
```

四个命令都是**只读观察**：派生条目与 digest，不记录快照、不物化上下文、不启动 Task。退出码：`0` 成功；`1` 拒绝（`validate`/`list` 有任一条目被拒；`show` 无记录快照；`resolve` 无诚实答案）；`2` 用法错误。`show` 不带 id 时给出最近记录的快照，并列出绑定到它的 Execution 及其物化文件的 digest——这是「本次执行用了哪个知识版本」的可脚本化答案。

## 6. schema

v26 只新增两张 append-only 表，**不重建 `executions`**：

- `knowledge_snapshots(project_id, main_commit, snapshot_digest, policy_version, human_digest, generated_digest, entry_count, …, entries_json, created_by, created_at)`，`UNIQUE(project_id, main_commit, snapshot_digest)`，`no_update`/`no_delete` 触发器；
- `execution_knowledge_snapshots(execution_id PK, project_id, task_id, snapshot_id, snapshot_digest, context_path, context_digest, context_bytes, entry_count, refs_json, command_id, created_at)`，`no_update`/`no_delete` 触发器。

`phase1SchemaVersion` 24 → 26，只追加 `if (version < 26)`；v25 属并行 lane，v16 永久未使用。测试断言用迁移常量或 `>= 26`，禁止写死 `== 26`。

## 7. 已知边界（不得声称已完成）

- **Provider 侧未验证**：Agent Adapter 目前不消费 `knowledgeSnapshotRefs`，本格也不含 `packages/agent-adapters/**`。因此只有「解析、物化、绑定、可追溯与拒绝路径」成立，**不**成立「Agent 真的读到了知识」。
- 机器生成层的其它写入者尚未实现（`generated/` 的读取、provenance 校验与拒绝路径已实现并有测试）。
- 不做向量检索 / embedding / LLM 摘要。
- 没有 UI 投影（`apps/ui/**` 不在本格领地）。
- 上限（每层 256 条、单条 64 KiB、整快照 1 MiB、front-matter 32 行）是常量，不是项目配置。
- 未明确的语义：把知识注入 Provider prompt / 原生指令文件的方式与时机，属后续格。
