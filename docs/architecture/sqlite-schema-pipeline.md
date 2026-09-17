# SQLite Schema：影响/冲突、验证与回收

> 层级：L2 按需参考 · 体量 ≈ 13k · **何时读**：改冲突判定、影响快照、验证运行、定向测试计划或资源回收账本 · **权威来源**：`packages/storage/src/migration.ts`（DDL 由当前 v37 库导出）。判定语义见 [`conflict-analyzer.md`](./conflict-analyzer.md)、验证语义见 [`state-machines.md`](./state-machines.md) §1。

## 1. 表与它们各自持有的事实

| 表 | 持有的事实 | 关键不变量 |
|---|---|---|
| `impact_snapshots` | 一次观察到的变更集与映射结果（文件、重要目录、模块、全局资源、缺失原因） | append-only；唯一键 `(task, revision, base, analyzer, policy, change fingerprint)` 就是「能否复用」的判据——任一要素变化都是**新行** |
| `impact_assessments` | 两个快照之间的配对判定记录 | append-only；按两个 snapshot 唯一；没有列能把已记录的 `SAFE` 改成别的值 |
| `project_impact_policy_confirmations` | `.codeestra/impact.json` 的接受状态 | 每项目最多一条 `ACTIVE`；`INVALID` 保留原始字节摘要，使「映射坏了」是被记录的**事实** |
| `verification_runs` | 一次验证运行的固定主体与证据 | `(project_id, command_id)` 唯一；终态必须带 `ended_at` + `outcome_code`；subject 与 Task 当前 revision、已捕获 result commit 匹配 |
| `targeted_test_plans` | 某分支的定向测试计划及其被选定时的精确绑定 | append-only；`(project, task, revision, commit, plan_digest)` 唯一；验证消费**已记录的计划**，绝不读当下文件 |
| `project_verification_policy_confirmations` | `.codeestra/policies/verification.json` 的接受状态 | 每项目最多一条 `ACTIVE`；重新 trust 时旧 trust 与旧确认分别失效 |
| `reclamation_records` | 一次资源回收的 append-only 账本 | `(operation_id, kind, resource_id)` 唯一；后续尝试追加新行，从不改写旧行；失败现场默认保留 |

要点：

- **判定不读快照。** ADR-0059 之后冲突判定只比较两侧声明的功能与「对方是否未完成」，`impact_snapshots`/`impact_assessments` 仍是**证据**：它们解释「为什么当时这么判」，但不是判定的输入。没有 assessment 行不等于没有冲突。
- 验证在**固定 commit 的隔离副本**上运行，策略来自项目 `main` ref 的人工文件；Task 分支上的同名文件不参与判定。
- 验证证据绑定 revision / commit / policy digest，且**不保存原始命令输出**（只留 exit code、时长、字节数、摘要、路径列表与副本处置）。
- 终态一旦写入，重放 completion 不改变结论；新 commit 或新 policy digest 使旧 `PASSED` 变成 `STALE`（保留原结论与失效原因，不改写）。
- `reclamation_records` 表达三类已登记资源与一类「未注册目录」；`task_id` 可空是刻意的——残留的 `verifications/<project>/<id>` 只有项目、没有可诚实归属的 Task，编造归属正是这个能力绝不能做的事。`kind` 里的 `INTEGRATION_WORKTREE` 取值保留：账本是 append-only 审计，去掉取值需要另一次 schema 变更，而 Runtime 已不再产生该类候选。

## 2. DDL（v37 实际形态）

### `impact_snapshots`

```sql
CREATE TABLE impact_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  analyzer_version TEXT NOT NULL CHECK(length(trim(analyzer_version)) > 0),
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
  case_mode TEXT NOT NULL CHECK(case_mode IN ('SENSITIVE','INSENSITIVE')),
  change_fingerprint TEXT NOT NULL CHECK(length(trim(change_fingerprint)) > 0),
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  incomplete_reasons_json TEXT NOT NULL
    CHECK(json_valid(incomplete_reasons_json) AND json_type(incomplete_reasons_json)='array'),
  files_json TEXT NOT NULL CHECK(json_valid(files_json) AND json_type(files_json)='array'),
  important_directories_json TEXT NOT NULL
    CHECK(json_valid(important_directories_json) AND json_type(important_directories_json)='array'),
  modules_json TEXT NOT NULL CHECK(json_valid(modules_json) AND json_type(modules_json)='array'),
  global_resources_json TEXT NOT NULL
    CHECK(json_valid(global_resources_json) AND json_type(global_resources_json)='array'),
  unclassified_files_json TEXT NOT NULL
    CHECK(json_valid(unclassified_files_json) AND json_type(unclassified_files_json)='array'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(task_id,revision_id,base_commit,analyzer_version,policy_version,change_fingerprint),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  -- An incomplete snapshot must say why: "incomplete for no recorded reason" is not a state anyone
  -- should be able to write, because it would be indistinguishable from a bug in the analyzer.
  CHECK((complete=1) = (json_array_length(incomplete_reasons_json)=0))
) STRICT;
CREATE INDEX impact_snapshots_by_task ON impact_snapshots(project_id,task_id,created_at,id);
CREATE TRIGGER impact_snapshots_no_delete
BEFORE DELETE ON impact_snapshots BEGIN
  SELECT RAISE(ABORT,'impact snapshots are append-only evidence');
END;
CREATE TRIGGER impact_snapshots_no_update
BEFORE UPDATE ON impact_snapshots BEGIN
  SELECT RAISE(ABORT,'impact snapshots are append-only; record a new snapshot instead');
END;
```

### `impact_assessments`

```sql
CREATE TABLE impact_assessments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  candidate_task_id TEXT NOT NULL,
  candidate_revision_id TEXT NOT NULL,
  candidate_snapshot_id TEXT NOT NULL REFERENCES impact_snapshots(id),
  other_task_id TEXT NOT NULL,
  other_revision_id TEXT NOT NULL,
  other_snapshot_id TEXT NOT NULL REFERENCES impact_snapshots(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('SAFE_TO_PARALLELIZE','UNKNOWN','CONFLICTING')),
  reason_codes_json TEXT NOT NULL
    CHECK(json_valid(reason_codes_json) AND json_type(reason_codes_json)='array'),
  hits_json TEXT NOT NULL CHECK(json_valid(hits_json) AND json_type(hits_json)='array'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(candidate_snapshot_id <> other_snapshot_id),
  UNIQUE(candidate_snapshot_id,other_snapshot_id)
) STRICT;
CREATE INDEX impact_assessments_by_candidate
  ON impact_assessments(project_id,candidate_task_id,created_at,id);
CREATE INDEX impact_assessments_by_other
  ON impact_assessments(project_id,other_task_id,created_at,id);
CREATE TRIGGER impact_assessments_no_delete
BEFORE DELETE ON impact_assessments BEGIN
  SELECT RAISE(ABORT,'impact assessments are append-only evidence');
END;
CREATE TRIGGER impact_assessments_no_update
BEFORE UPDATE ON impact_assessments BEGIN
  SELECT RAISE(ABORT,'impact assessments are append-only; a changed fact needs a new snapshot');
END;
```

### `project_impact_policy_confirmations`

```sql
CREATE TABLE project_impact_policy_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  policy_state TEXT NOT NULL CHECK(policy_state IN ('ABSENT','PRESENT','INVALID')),
  policy_digest TEXT,
  content_digest TEXT,
  error_code TEXT,
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  main_commit TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
  confirmed_at INTEGER NOT NULL CHECK(confirmed_at >= 0),
  superseded_at INTEGER,
  CHECK((policy_state='PRESENT' AND policy_digest IS NOT NULL AND content_digest IS NULL)
    OR (policy_state='INVALID' AND policy_digest IS NULL AND content_digest IS NOT NULL)
    OR (policy_state='ABSENT' AND policy_digest IS NULL AND content_digest IS NULL)),
  CHECK((status='ACTIVE' AND superseded_at IS NULL)
    OR (status='SUPERSEDED' AND superseded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_impact_policy
  ON project_impact_policy_confirmations(project_id) WHERE status='ACTIVE';
```

### `verification_runs`

```sql
CREATE TABLE "verification_runs" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  command_id TEXT NOT NULL,
  tested_commit TEXT NOT NULL,
  tested_tree TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  main_commit TEXT NOT NULL,
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json) AND json_type(commands_json)='array'),
  copy_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','CANCELLED','STALE')),
  outcome_code TEXT,
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
  started_at INTEGER,
  ended_at INTEGER, policy_source TEXT NOT NULL DEFAULT 'PROJECT_POLICY'
  CHECK(policy_source IN ('PROJECT_POLICY','TARGETED_TEST_PLAN')), plan_id TEXT, plan_version TEXT, plan_digest TEXT,
  UNIQUE(project_id,command_id),
  CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK((state IN ('QUEUED','RUNNING') AND ended_at IS NULL AND outcome_code IS NULL)
    OR (state IN ('PASSED','FAILED','ERROR','CANCELLED','STALE')
      AND ended_at IS NOT NULL AND outcome_code IS NOT NULL)),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id)
) STRICT;
CREATE INDEX verification_by_task ON verification_runs(project_id,task_id,queued_at);
CREATE INDEX verification_subject ON verification_runs(task_id,revision_id,tested_commit);
```

### `targeted_test_plans`

```sql
CREATE TABLE targeted_test_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tested_commit TEXT NOT NULL,
  plan_version TEXT NOT NULL CHECK(length(trim(plan_version)) > 0),
  plan_digest TEXT NOT NULL CHECK(length(plan_digest) = 64),
  source_path TEXT NOT NULL CHECK(length(trim(source_path)) > 0),
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json) AND json_type(commands_json)='array'),
  scope TEXT NOT NULL CHECK(length(trim(scope)) > 0),
  recorded_by TEXT NOT NULL CHECK(length(trim(recorded_by)) > 0),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id)
) STRICT;
CREATE UNIQUE INDEX one_targeted_test_plan_per_subject
  ON targeted_test_plans(project_id,task_id,revision_id,tested_commit,plan_digest);
CREATE INDEX targeted_test_plans_by_task
  ON targeted_test_plans(project_id,task_id,recorded_at DESC,id);
CREATE TRIGGER targeted_test_plans_no_delete
BEFORE DELETE ON targeted_test_plans BEGIN
  SELECT RAISE(ABORT,'targeted test plans are append-only; they are never deleted');
END;
CREATE TRIGGER targeted_test_plans_no_update
BEFORE UPDATE ON targeted_test_plans BEGIN
  SELECT RAISE(ABORT,'targeted test plans are append-only; record a new plan instead');
END;
```

### `project_verification_policy_confirmations`

```sql
CREATE TABLE project_verification_policy_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  policy_state TEXT NOT NULL CHECK(policy_state IN ('ABSENT','PRESENT')),
  policy_digest TEXT,
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  main_commit TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
  confirmed_at INTEGER NOT NULL CHECK(confirmed_at >= 0),
  superseded_at INTEGER,
  CHECK((policy_state='ABSENT' AND policy_digest IS NULL)
    OR (policy_state='PRESENT' AND policy_digest IS NOT NULL)),
  CHECK((status='ACTIVE' AND superseded_at IS NULL)
    OR (status='SUPERSEDED' AND superseded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_verification_policy
  ON project_verification_policy_confirmations(project_id) WHERE status='ACTIVE';
```

### `reclamation_records`

```sql
CREATE TABLE "reclamation_records" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  operation_id TEXT NOT NULL REFERENCES operations(id),
  command_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'REGISTERED'
    CHECK(source IN ('REGISTERED','UNREGISTERED_DIRECTORY')),
  kind TEXT NOT NULL CHECK(kind IN ('TASK_WORKTREE','VERIFICATION_COPY','INTEGRATION_WORKTREE',
    'UNREGISTERED_DIRECTORY')),
  resource_id TEXT NOT NULL,
  path TEXT NOT NULL,
  ownership_token TEXT,
  external_ref TEXT,
  resource_state TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('RECLAIMED','ALREADY_ABSENT','RETAINED','REFUSED','FAILED',
    'RECOVERY_REQUIRED')),
  reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) > 0),
  detail TEXT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE UNIQUE INDEX one_reclamation_record_per_resource
  ON reclamation_records(operation_id,kind,resource_id);
CREATE INDEX reclamation_records_by_project ON reclamation_records(project_id,created_at,id);
CREATE INDEX reclamation_records_by_source ON reclamation_records(source,created_at,id);
CREATE INDEX reclamation_records_by_task ON reclamation_records(project_id,task_id,created_at,id);
```

## 3. Self Evolution（Phase 7 预留逻辑表，尚未实现）

未创建、不提前建表；形态只在规格里保留：

- `candidate_versions(id, self_task_id, source_commit, artifact_ref, artifact_hash, build_manifest_json, compatibility_json, state, created_at)`
- `self_test_runs(id, candidate_id, isolated_data_ref, tested_artifact_hash, state, evidence_ref, started_at, ended_at)`
- `promotion_records(id, candidate_id, old_version, new_version, approved_artifact_hash, actor, state, backup_ref, health_evidence_ref, created_at, completed_at)`

Stable 版本指针由 bootstrap 独立管理；Runtime 数据库不是唯一恢复依据。迁移/备份兼容策略未确认前不虚构最终 DDL（ADR-0068 Self Evolution 阶段）。
