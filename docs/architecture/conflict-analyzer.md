# 第一版 Conflict Analyzer

## 1. 目标与限制

优先低误判安全率，而不是最大并发。分析是保守预测，不是锁系统、更不是安全沙箱。LLM 可辅助预测影响，但“没有提到同文件”不能作为 SAFE 的唯一依据。

## 2. 输入

每份 ImpactSnapshot：taskId、revisionId、baseCommit、analyzerVersion、policyVersion、complete、files、importantDirectories、modules、globalResources、evidence。

路径相对仓库根，统一分隔符并尊重实际文件系统大小写行为；拒绝 `..`、绝对路径与 symlink 逃逸；rename 同时计入 old/new path。目录比较按路径组件，不能把 `src/map` 误匹配 `src/mapping`。

重要目录/模块来源于仓库内跟踪文件 `.codeestra/impact.json`（项目配置的声明式映射）；该文件只从**项目 main ref** 读取，读法与 `.codeestra/policies/verification.json` 一致：先把 ref 解析到 commit，再读该 commit 的文件，Task branch 上的同名文件**不参与判定**，文件缺失或映射缺失都是「没有可靠映射」而不是「没有影响」。尚无可靠映射则 complete=false。公共 API、依赖锁文件、schema migration、构建/测试基础配置通常属于 globalResources。

## 3. 纯判断规则

```text
if wrong project/base/policy/revision or invalid scope:
  UNKNOWN(reason: stale_or_invalid)
else if overlap(files) or directoryAncestorOverlap(importantDirectories)
     or fileInsideOtherImportantDirectory
     or overlap(modules) or overlap(globalResources):
  CONFLICTING(reason + intersecting scope)
else if either incomplete or unbounded impact or uncertain global effects:
  UNKNOWN(reason: incomplete_impact)
else:
  SAFE_TO_PARALLELIZE(evidence references)
```

全局资源影响不能只与同名 globalResources 对比：某任务修改共享构建/依赖/schema 时，如果另一个任务依赖该资源，即使未计划修改，也必须纳入读写冲突；无法获得可靠读依赖时视作整个项目范围 UNKNOWN/CONFLICTING，不错误返回 SAFE。

文件删除/创建、配置生成、代码生成器输出、测试 fixture 和包公共接口都是影响。运行时共享数据库、端口、开发服务器等非 Git 资源由 resource claims 单独管理；不同文件不能证明这些资源可共享。

## 4. 失效与解释

任务修订、基线变化、模块映射/分析器/策略版本变化、实际 diff 超范围都使旧 assessment 不再适用。保留旧记录做审计，新建新版本。

结果提供稳定 reason codes，例如 SAME_FILE、IMPORTANT_DIRECTORY_OVERLAP、SAME_MODULE、GLOBAL_RESOURCE、INCOMPLETE_IMPACT、STALE_BASE。UI 展示具体冲突范围，不只显示红色状态。

第一版没有“用户强制忽略 UNKNOWN 并发”的隐藏 override。**该能力现已由 ADR-0030 授权为显式单次放行（`--allow-unknown`），且仍然不是隐藏开关**：它是用户对「无法证明不冲突」的显式承担，不是分析器可以自己打开的旁路。放行必须绑定**被评估的 revision** 与**评估版本**（analyzer/policy 版本）并写入审计；任务修订、基线变化、映射/分析器/策略版本变化、实际 diff 超范围都使放行随 assessment 一并失效（见上），需要重新评估与重新放行。

放行**不改变 assessment 记录本身**：`conflict_assessments` 里那次结论仍是 `UNKNOWN`，放行只是「允许在 UNKNOWN 下启动、并可与当前活跃任务并发」的独立事实。因此**放行不等于 SAFE**：它不构成证据、不改写冲突结论、不提高后续判定的置信度，也不减少 `reason codes`（仍是 `INCOMPLETE_IMPACT` / `STALE_BASE` 等）。风险归属在放行方：`UNKNOWN` 不是「无冲突」而是「无法证明」；放行后若两个 Agent 越界，责任在放行的人，Runtime 不因放行而增加额外隔离（残余风险见 `scheduler.md` §4）。

## 5. 测试

同文件、目录祖先关系、相邻但不重叠目录、rename、大小写不敏感仓库、symlink、公共配置、读写冲突、未知模块、空但完整性不足的文件集合、修订后缓存失效，以及已知完全不相交范围的 SAFE 正例。

## 6. 实现现状（FOUNDATION-053 / ADR-0031，schema v20）

本节记录**已经合入 `dev` 的实现**，与前四节的设计意图分开。**不含调度**：没有任何引擎会 tick 或启动任务（见 §7）。

### 6.1 `.codeestra/impact.json` 的字段

映射载体是仓库内跟踪文件 `.codeestra/impact.json`（`packages/contracts/src/impact-policy.ts`，`impactPolicyVersion = 'impact-policy-v1'`），**只从项目 `main` ref 读取**（先解析 ref 到 commit，再读该 commit 的文件），Task branch 上的同名文件不参与判定。Zod `strictObject`，未知键与非法值 fail-closed。

```jsonc
{
  "version": 1,
  "importantDirectories": ["src/core"],                       // 路径按组件比较，src/map ≠ src/mapping
  "modules": [{ "id": "scheduler", "paths": ["packages/scheduler/**"] }],
  "globalResources": [{
    "id": "lockfile", "kind": "DEPENDENCY_LOCKFILE",
    "paths": ["bun.lock"],
    "consumers": { "state": "UNKNOWN" }                        // 或 { "state": "DECLARED", "paths": [...] }
  }]
}
```

- `kind` 只接受 `PUBLIC_API` / `DEPENDENCY_LOCKFILE` / `SCHEMA_MIGRATION` / `BUILD_CONFIG` / `TEST_CONFIG` / `GENERATED_OUTPUT` / `PROJECT_POLICY`。
- 上限：每条目最多 512 项（`maxImpactPolicyEntries`）、每项最多 64 个路径模式、路径最长 400 字符。
- 路径拒绝绝对路径、`~`、`..`、`.git`、反斜杠、通配符逃逸与 NUL；这些路径**从不被文件系统打开**，因此 symlink 逃逸在结构上不可能。
- `consumers.state='UNKNOWN'` 是安全的默认：某 revision 写了该资源而消费者未声明时，整个项目范围变 `UNKNOWN`，**永不 SAFE**。`DECLARED` 空列表是「该资源没有 Codeestra 需要跟踪的消费者」的明确声明。

### 6.2 确认

确认复用**既有** `project trust` 事件（ADR-0031）：FULL 零步自动记录；STRICT 复用同一次 TRUST，**不新增确认或权限门禁**。落表 `project_impact_policy_confirmations`，`policy_state ∈ {ABSENT, PRESENT, INVALID}`：

- `PRESENT` 存标准化映射的 sha256 摘要（`policy_digest`）；`INVALID` 存原始字节摘要（`content_digest`）与 `error_code`；`ABSENT` 两者都为 NULL。
- 编辑任何声明路径都改变摘要 → 需要新确认，并让旧确认下产生的每个快照失效。重新 trust 时旧确认置 `SUPERSEDED`。

### 6.3 快照失效键

`impact_snapshots` 的唯一键就是「能否复用」的判据：`(task_id, revision_id, base_commit, analyzer_version, policy_version, change_fingerprint)`。其中 `policy_version` 是「版本 **和** 内容」的组合（`impact-policy-v1#<digest 前 12 位>`）。快照还记录 `case_mode`（实测文件系统大小写行为，`SENSITIVE`/`INSENSITIVE`）。因此下列任一变化都写**新行**，旧行保留做审计且永不被再次选中：

- Task 修订（新 revision）、基线移动（`base_commit`）、映射编辑（`policy_digest`/`policy_version`）、分析器换代（`analyzer_version`）、观测到的 diff 变大（`change_fingerprint`）。

`impact_snapshots` 与 `impact_assessments` 都有 `no_update` / `no_delete` 触发器与 `no_update`/`no_delete` 的 append-only 约束：配对判定按两个 snapshot 唯一，没有任何列能把已记录的 `SAFE` 改成别的值；「实际 diff 超出预测」由新快照 + 新判定表达，不是编辑历史。

### 6.4 稳定 reason code 清单

判定器（`packages/domain/src/impact-analysis.ts`，无 Bun/DB/Git/模型依赖）输出的 `ImpactReasonCode`，按稳定顺序排列：

| code | class | 含义 |
|---|---|---|
| `SAME_FILE` | CONFLICT | 两侧变更集含同一路径（rename 计入 old **与** new） |
| `IMPORTANT_DIRECTORY_OVERLAP` | CONFLICT | 声明的重要目录有祖先/相等关系，或一侧文件落入另一侧的重要目录 |
| `SAME_MODULE` | CONFLICT | 两侧命中同一声明模块（即使文件不同） |
| `GLOBAL_RESOURCE` | CONFLICT | 两侧写同一全局资源 |
| `GLOBAL_RESOURCE_DEPENDENCY` | CONFLICT | 一侧写资源，另一侧改动声明为依赖该资源的路径 |
| `INCOMPLETE_IMPACT` | INCOMPLETE | 任一侧快照 `complete=false` |
| `MISSING_IMPACT_SNAPSHOT` | INCOMPLETE | 活跃侧没有可用快照 |
| `STALE_BASE` / `STALE_REVISION` / `STALE_POLICY` / `STALE_ANALYZER` | STALE_OR_INVALID | 基线/revision/映射/分析器与评估时不再一致 |
| `ACTUAL_DIFF_EXCEEDS_SNAPSHOT` | STALE_OR_INVALID | 观测到的变更集超出快照记录 |
| `SNAPSHOT_SCOPE_MISMATCH` / `INVALID_SCOPE` | STALE_OR_INVALID | 快照作用域与当前事实不匹配 |
| `NO_CONFLICT` | SAFE | 在声明的映射与观测事实下未发现重叠 |

`ImpactIncompleteReason`（使 `complete=false`）：`POLICY_ABSENT` / `POLICY_INVALID` / `POLICY_NOT_CONFIRMED` / `EMPTY_MAPPING` / `UNCERTAIN_GLOBAL_EFFECT` / `UNBOUNDED_SCOPE`。判定优先级：先 stale/invalid 与 `CONFLICTING`，再 incomplete，最后才是 `SAFE`——即「发现的真冲突」永不被不完整性覆盖。判定同时返回具体命中范围（相交路径/目录/模块/资源 + 关系），不只给一个颜色。

### 6.5 命令面与退出码

```
project impact validate [path] [--json]              # 校验映射；code 为 OK / OK_UNTRUSTED 时 exit 0，否则 exit 1
project impact show <project-id> <task-id> [--json]  # 派生并记录快照；没有快照（change set 不可观测）时 exit 1
project impact explain <project-id> <task-id> [--json]# 给出判定与理由；exit 0 **仅当** SAFE_TO_PARALLELIZE
```

三者都是**只读**：派生快照、append-only 记录、解释判定，**从不**调度、启动或批准任何 Task。

### 6.6 未实现（不得声称）

调度循环、容量、自动 tick、多成员批次、非 Git 共享资源（端口/数据库/dev server）的 resource claim、gitignore 产物的语义、以及映射未声明路径的目录/模块语义；`--allow-unknown` 的命令形态。这些属 Wave F / 后续 ADR。

## 7. 与调度引擎的关系（Wave F）

**本基线里没有调度引擎。** `apps/runtime/src/scheduler.ts` 目前只是 ADR-0024 的**依赖判定器**（回答「这个 Task 能否 READY」与「图编辑是否保持无环」两条问题），它刻意不启动任何东西、不预留资源、不挑 Task。

调度引擎（自动 tick、候选排序 + 冲突/容量判定接入、实际 diff 超出预测的处置、`--allow-unknown` 命令形态）由 **FOUNDATION-055** 在**本格之后**落地。因此在本格及其基线里：

- 不得写「自动 tick 已实现」或「两个 SAFE 任务真的会同时开始」；
- 本节§6 描述的是一组**原语 + 只读命令面**，不是一个会自己跑起来的调度器。
