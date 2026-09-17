# SQLite Schema：项目、意图、Task、知识

> 层级：L2 按需参考 · 体量 ≈ 11k · **何时读**：改 Task/Revision/依赖/知识绑定的表结构或查询 · **权威来源**：`packages/storage/src/migration.ts`（下列 DDL 由当前 v37 库导出）。索引与版本台账见 [`sqlite-schema.md`](./sqlite-schema.md)。

## 1. 表与它们各自持有的事实

| 表 | 持有的事实 | 关键不变量 |
|---|---|---|
| `projects` | 项目身份：canonical repo root、Git common dir、`main_ref`、object format、策略版本 | `repo_root` / `git_common_dir` 唯一；启动时重核身份，目录搬迁不悄悄关联到另一仓库 |
| `project_trusts` | 用户接受该仓库时的身份快照 | 每项目最多一条 `ACTIVE`（部分唯一索引）；身份变化使其失效，不静默更新快照 |
| `intents` | 用户原始输入的原文、分类与处理状态 | `(project_id, idempotency_key)` 唯一；`kind` 是历史分类，只加不改 |
| `intent_targets` / `intent_attention_targets` | 一次意图指向的 Task / Attention | 纯关联，无独立生命周期 |
| `tasks` | Task 聚合根：显示编号、两个标题、当前 revision、状态、priority、`archived_at` | `(project_id, display_number)` 唯一；`current_revision_id` 与同表复合 FK（延迟到 commit 检验）；每项目每 Task 一个活跃行 |
| `task_revisions` | 不可覆盖的规格快照与声明的功能 | append-only（UPDATE/DELETE 触发器拒绝）；`(task_id, number)` 唯一；`features_json` 是**声明**不是推断 |
| `task_dependencies` | 依赖边与它钉住的上游 revision | 边不可变（只能删了再加）；自环禁止；双端点同项目；`required_revision_id` 必须属于上游 |
| `knowledge_snapshots` | 某 `main` commit 上解析出的知识条目集合（人类层 + 机器生成层） | append-only；`(project_id, main_commit, snapshot_digest)` 唯一，所以重复声明复用同一行、内容变化必是新行 |
| `execution_knowledge_snapshots` | 一个 Execution **实际使用**的知识版本与物化文件 | 主键就是 `execution_id`；append-only；插在 `reserveExecution` 同一事务内，因此「Execution 存在」与「已绑定知识」不可分开观察 |

要点：

- 创建 Task 与首 Revision 必须在**同一事务**，延迟 FK 于 commit 检验；新 Task 是 `DRAFT`，显式 submit 前不参与调度。
- DAG 环检测在 `BEGIN IMMEDIATE` 下读取并插入：两条并发边各自合法但合起来成环，SQLite 无法表达，必须由纯领域图在写锁内拒绝。
- `task_revisions.features_json` 的取值在**写入时**按项目 `main` ref 的 `.codeestra/impact.json` 校验（`UNKNOWN_FEATURE` / `IMPACT_POLICY_ABSENT` / `INVALID_IMPACT_POLICY` / `INVALID_FEATURE`），因此冲突判定本身不必读映射（ADR-0059）。省略 `--feature` 的新 revision 继承上一条的声明。
- 历史行不得编造：v35 之前创建的 Task `naming_title` 恒为 `NULL`（Git 命名退回内部 ID），`display_title` 由当前 revision 首行派生并截断到 200 字符。
- `knowledge_snapshots.entries_json` 只存逐条 `{layer,path,id,scope,digest,bytes,origin}`（不含正文），因此事后能完整读回「这个 Execution 用了哪些条目、各自内容 digest 是多少」。

## 2. DDL（v37 实际形态）

### `projects`

```sql
CREATE TABLE "projects" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  repo_root TEXT NOT NULL UNIQUE,
  git_common_dir TEXT NOT NULL UNIQUE,
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
```

### `project_trusts`

```sql
CREATE TABLE project_trusts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_root TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  policy_version INTEGER NOT NULL CHECK(policy_version > 0),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','INVALIDATED')),
  accepted_at INTEGER NOT NULL CHECK(accepted_at >= 0),
  invalidated_at INTEGER,
  CHECK((status='ACTIVE' AND invalidated_at IS NULL)
    OR (status='INVALIDATED' AND invalidated_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_project_trust ON project_trusts(project_id) WHERE status='ACTIVE';
```

### `intents`

```sql
CREATE TABLE "intents" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  idempotency_key TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  kind TEXT CHECK(kind IN ('CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT','CANCEL_TASK',
    'ANSWER_AGENT')),
  status TEXT NOT NULL CHECK(status IN ('RECORDED','NEEDS_CLARIFICATION','APPLIED','REJECTED')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(project_id,idempotency_key)
) STRICT;
```

### `intent_targets`

```sql
CREATE TABLE intent_targets (
  intent_id TEXT NOT NULL REFERENCES intents(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(intent_id,task_id)
) STRICT, WITHOUT ROWID;
```

### `intent_attention_targets`

```sql
CREATE TABLE intent_attention_targets (
  intent_id TEXT PRIMARY KEY REFERENCES intents(id),
  attention_id TEXT NOT NULL REFERENCES attention_requests(id)
) STRICT;
```

### `tasks`

```sql
CREATE TABLE "tasks" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_number INTEGER NOT NULL CHECK(display_number > 0),
  display_title TEXT NOT NULL
    CHECK(length(trim(display_title)) > 0 AND length(display_title) <= 200
      AND display_title NOT LIKE '%' || char(10) || '%'
      AND display_title NOT LIKE '%' || char(13) || '%'),
  naming_title TEXT CHECK(naming_title IS NULL OR (
    length(naming_title) BETWEEN 1 AND 50
    AND naming_title GLOB '[a-z]*'
    AND naming_title NOT GLOB '*[^a-z0-9-]*'
    AND naming_title NOT LIKE '-%'
    AND naming_title NOT LIKE '%-'
    AND naming_title NOT LIKE '%--%')),
  current_revision_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','BLOCKED','READY','RUNNING','PAUSING','PAUSED',
    'WAITING_FOR_USER','RECOVERY_REQUIRED','EXECUTED','FAILED','CANCELLING','CANCELLED','SUCCEEDED')),
  priority INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  archived_at INTEGER CHECK(archived_at IS NULL OR archived_at >= 0),
  pending_retry_from_execution_id TEXT REFERENCES executions(id),
  UNIQUE(project_id,display_number),
  UNIQUE(project_id,id),
  UNIQUE(id,current_revision_id),
  FOREIGN KEY(id,current_revision_id) REFERENCES task_revisions(task_id,id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX tasks_project_archived ON tasks(project_id,archived_at);
CREATE INDEX tasks_schedule ON tasks(project_id,state,priority DESC,created_at,id);
```

### `task_revisions`

```sql
CREATE TABLE "task_revisions" (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  number INTEGER NOT NULL CHECK(number > 0),
  previous_revision_id TEXT,
  specification TEXT NOT NULL CHECK(length(trim(specification)) > 0),
  features_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(features_json) AND json_type(features_json)='array'),
  source_intent_id TEXT REFERENCES intents(id),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(task_id,number),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id,previous_revision_id) REFERENCES task_revisions(task_id,id),
  CHECK((number=1 AND previous_revision_id IS NULL) OR (number>1 AND previous_revision_id IS NOT NULL)),
  CHECK(previous_revision_id IS NULL OR previous_revision_id <> id)
) STRICT;
CREATE TRIGGER task_revisions_no_delete
BEFORE DELETE ON task_revisions BEGIN
  SELECT RAISE(ABORT,'task revisions are append-only');
END;
CREATE TRIGGER task_revisions_no_update
BEFORE UPDATE ON task_revisions BEGIN
  SELECT RAISE(ABORT,'task revisions are append-only');
END;
```

### `task_dependencies`

```sql
CREATE TABLE task_dependencies (
  dependent_task_id TEXT NOT NULL,
  prerequisite_task_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  required_revision_id TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(dependent_task_id,prerequisite_task_id),
  CHECK(dependent_task_id <> prerequisite_task_id),
  FOREIGN KEY(project_id,dependent_task_id) REFERENCES tasks(project_id,id),
  FOREIGN KEY(project_id,prerequisite_task_id) REFERENCES tasks(project_id,id),
  FOREIGN KEY(prerequisite_task_id,required_revision_id) REFERENCES task_revisions(task_id,id)
) STRICT;
CREATE INDEX task_dependencies_by_dependent
  ON task_dependencies(project_id,dependent_task_id);
CREATE INDEX task_dependencies_by_prerequisite
  ON task_dependencies(project_id,prerequisite_task_id);
CREATE TRIGGER task_dependencies_no_update
BEFORE UPDATE ON task_dependencies BEGIN
  SELECT RAISE(ABORT,'task dependency edges are immutable; remove and add again');
END;
```

### `knowledge_snapshots`

```sql
CREATE TABLE knowledge_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  main_commit TEXT NOT NULL CHECK(length(trim(main_commit)) > 0),
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
  human_digest TEXT NOT NULL CHECK(length(human_digest) = 64),
  generated_digest TEXT NOT NULL CHECK(length(generated_digest) = 64),
  entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
  human_entry_count INTEGER NOT NULL CHECK(human_entry_count >= 0),
  generated_entry_count INTEGER NOT NULL CHECK(generated_entry_count >= 0),
  total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
  entries_json TEXT NOT NULL CHECK(json_valid(entries_json)),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(entry_count = human_entry_count + generated_entry_count)
) STRICT;
CREATE INDEX knowledge_snapshots_by_project ON knowledge_snapshots(project_id,created_at,id);
CREATE UNIQUE INDEX one_knowledge_snapshot_per_state
  ON knowledge_snapshots(project_id,main_commit,snapshot_digest);
CREATE TRIGGER knowledge_snapshots_no_delete BEFORE DELETE ON knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'knowledge snapshots are append-only'); END;
CREATE TRIGGER knowledge_snapshots_no_update BEFORE UPDATE ON knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'knowledge snapshots are append-only'); END;
```

### `execution_knowledge_snapshots`

```sql
CREATE TABLE execution_knowledge_snapshots (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
  context_path TEXT NOT NULL CHECK(length(trim(context_path)) > 0),
  context_digest TEXT NOT NULL CHECK(length(context_digest) = 64),
  context_bytes INTEGER NOT NULL CHECK(context_bytes >= 0),
  entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
  refs_json TEXT NOT NULL CHECK(json_valid(refs_json)),
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE INDEX execution_knowledge_snapshots_by_snapshot
  ON execution_knowledge_snapshots(snapshot_id,created_at,execution_id);
CREATE INDEX execution_knowledge_snapshots_by_task
  ON execution_knowledge_snapshots(project_id,task_id,created_at,execution_id);
CREATE TRIGGER execution_knowledge_snapshots_no_delete
  BEFORE DELETE ON execution_knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'execution knowledge bindings are append-only'); END;
CREATE TRIGGER execution_knowledge_snapshots_no_update
  BEFORE UPDATE ON execution_knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'execution knowledge bindings are append-only'); END;
```
