# 当前任务与进度

## FOUNDATION-001 — 架构基线

状态：设计基线已建立；非全部最终定稿。

已完成：
- 创建并同步 `PROJECT_SPEC.md`、`AGENTS.md`、四类 docs 目录。
- 记录用户八项明确选择：ADR-0001 / ADR-0002。
- 总体架构、主要领域对象、五类状态机、SQLite 关系设计、事件模型、Adapter/Workspace port 草案。
- Conservative Scheduler、Conflict Analyzer、module structure、MVP roadmap、非目标与最大风险。
- 将影响后续实现的未决事项按 Phase 1/2/4/7 分开，不当作用户已接受默认。

设计限制：SQLite 文档不是发布 migration，部分后续阶段 CHECK/跨表约束与 Self Evolution 最终 DDL 仍需补齐；Adapter API 未经真实 Pi 验证。

## FOUNDATION-002 — Phase 0 纯领域工程

状态：第一小步完成；整个 Phase 0 尚未完成。

已实现：
- Bun workspace、TypeScript strict、Vitest 5.0.0、锁文件与常用开发/验证命令的 `Justfile`。
- SpecificationHistory / TaskRevision：完整不可变快照、约束 ID 唯一、保留用户原文、乐观版本冲突拒绝。
- Execution FSM：准备/启动/运行、用户等待、修订暂停/ACK/恢复、协作取消、SUPERSEDED、成功/失败、失联保护。
- 终态不复活、控制超时不释放资源、旧 ACK 不应用、未确认最新 revision 不恢复、未关闭 Attention 不恢复。

明确未实现：Task 全聚合服务、完整 Task FSM、Zod 外部边界、SQLite storage、outbox/幂等命令服务、fake/真实 Adapter、Git 副作用、真实恢复、应用 shutdown、调度器、Terminal/UI。

实际验证：
- Nix 提供 Bun 1.3.13；当前 Node 24.19.0。
- `bun run check`：TypeScript 通过；2 个测试文件、212 项测试通过（含 Execution 状态×事件拓扑矩阵）。
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：`Justfile` 完整验证通过，212 项测试通过且无已知依赖漏洞。
- 首次 `bun audit` 发现 Vitest 3.2.4 相关 3 项漏洞；升级至 5.0.0 后重新跑 check 通过，`bun audit` 报告无已知漏洞。
- 文档 SQL：用 Node 内存 SQLite 执行 5 个 SQL block，成功建立 22 张业务表；空 schema 外键检查无违规。**这只验证语法/空结构，不是 migration 或业务数据约束验收。**
- 检查规格/架构/决策索引的 17 个本地链接均存在。

Git：目录开始时不是 Git 仓库；未初始化、未 commit、未 push，未操作其他项目 Git。

## FOUNDATION-003 — Pi 0.84.4 首轮协议 Spike

状态：文档核对与受控本机 RPC spike 已完成；真实 Adapter 尚未实现。

已验证：
- 固定当前 Pi 0.84.4（MIT、Node `>=22.19.0`），选择 RPC 子进程作为接入候选。
- extension UI 的 RPC confirm request/response 通路可用，可承载受控 permission/question gate；Pi 默认并不提供覆盖所有工具的审批策略。
- `abort` 等待 idle；内置 bash 的进程组终止 spike 中，abort response 返回前 tool 已结束且测试 PID 已不存在。
- 含真实 conversation 的 session 可凭 file 恢复相同 Pi session ID 和 extension custom entry。
- 明确不支持 pause/resume、可靠 revision ACK、Runtime 重启后重接 live Pi 进程；修订必须走停止并新建 Execution。

证据与能力矩阵：`docs/spikes/pi-0.84.4.md`。

未验证：Codeestra fail-closed gate extension、允许工具全集静止性、取消超时、启动部分失败、事件重投、孤儿进程 reconcile。Spike 在 `/tmp` 中运行，未修改项目 Git。

## FOUNDATION-004 — 成果 Commit 安全策略

状态：决策已确认，设计已同步；尚未实现 Git 副作用。

用户已选择并记录为 ADR-0003：
- 每次 Runtime 创建成果 commit 前确认固定 HEAD/ChangeSet/revision；变化后重新确认。
- 沿用仓库已有 identity，缺失时停止，不代写 Git config。
- 项目 trust 后正常执行 hooks；失败保留现场，不 `--no-verify`。
- 暂存固定基线全部差异，敏感/运行数据路径命中则 fail-closed。

已同步 `PROJECT_SPEC.md`、Git Workspace API、SQLite 授权记录与事件目录。验证：`bun run check` 通过（2 个文件、212 项测试）；Node 内存 SQLite 执行 5 个文档 SQL block，建立 23 张表；文档本地链接无断链。未 commit、未 push、未实现自动 main 更新。

## FOUNDATION-005 — Phase 1 Storage 第一小步

状态：首个 schema version 1 与底层事务原语已实现；FOUNDATION-009 已以 additive migration 升至 version 2，完整 storage/repository 尚未完成。

已实现：
- `packages/storage` 使用 Bun 原生 SQLite；每连接启用 foreign keys/busy timeout，文件库启用 WAL，拒绝未知较新 schema version。
- Phase 1 实际使用子集：Project/Intent/Task/Revision、Workspace/Execution、成果 commit 授权、Task verification、Operation、event/outbox 与 command receipt。
- 延迟循环 FK 支持 Task + 首 Revision 同事务创建；revision UPDATE/DELETE trigger 拒绝历史改写。
- 活动 workspace/execution/授权唯一性、Execution 终态与资源持有一致性、授权状态时间戳、verification 复合主体外键。
- Task version CAS 和 command receipt 幂等事务原语；同 command ID 异 payload 拒绝，回调失败时事件和 receipt 一并回滚。

实际验证：
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 -c bun run check`：TypeScript 通过；原有 212 项 domain 测试及新增 12 项 Bun SQLite 测试通过。
- SQLite 测试使用真实内存数据库和临时文件数据库，覆盖重启保留与较新 schema 拒绝；不访问用户仓库。Integration verification 表按 Phase 4 准入未提前创建。

尚未实现：Drizzle 映射、业务 repository/完整 command service、event delivery worker、Operation reconcile、并发连接与 migration 失败注入、备份 migration、fake/真实 Adapter。

## FOUNDATION-006 — 最小 CLI / 独立 Runtime 骨架

状态：项目接入入口可试用；尚未形成 Task/Agent 闭环。

用户已确认并记录 ADR-0004：CLI 首入口、CLI 自动启动后台 Runtime、项目显式一次信任、Pi 敏感操作逐次审批且未知工具拒绝。

已实现：
- `apps/cli` 通过本用户 Unix socket 连接 Runtime，未运行时自动启动后台 Bun 进程；支持 `status`、`stop`、`project inspect/trust/list`。
- `apps/runtime` 使用权限为 0700 的数据目录和 0600 的 socket；每条 JSONL request 经 Zod 严格 schema/version 校验。
- trust 分成 inspect 与 confirm 两步；Runtime 在写入前重新检查 canonical root、Git common dir、main ref、object format 与 HEAD，快照变化则拒绝。
- trust 记录持久化到 SQLite；提示明确说明 Agent/命令/hooks 权限，且 trust 不授权成果 commit、main 或 push。
- Git 检查使用参数数组；新增临时 Git 仓库测试，不修改真实仓库配置或 refs。

实际手工 smoke：以临时 `CODEESTRA_HOME` 依次执行 status、inspect、trust、list、stop 成功；后台 Runtime 在 CLI 退出后继续响应，数据写入临时 SQLite 后删除。该 smoke 只读检查当前仓库，没有修改其 Git。

尚未实现：Task CLI、owned worktree、Agent/fake adapter、Attention、单实例竞态完整证明、进程 identity/reconcile、仓库 identity 变化后的 trust 失效流程。当前入口不能声称已经能完成开发任务。

## FOUNDATION-007 — Task 入口与 owned worktree 原语

状态：Task create/list/submit 与 Operation 驱动的 Git prepare 应用服务已实现；尚未接入 Scheduler/Execution。

用户已确认并记录 ADR-0005：Task CLI 使用稳定 Project ID，新建 Task 为 DRAFT；owned worktree 放在 Runtime 数据目录，不污染仓库根目录或 Git common dir。

已实现：
- `task create <project-id> <specification>`、`task list <project-id>`、`task submit <project-id> <task-id> <expected-version>` 的严格 IPC schema 与 CLI；仅 ACTIVE trust 项目可访问。
- submit 以 CAS 将 DRAFT 转为 READY 并记录 TaskStateChanged；重复 command 返回首次结果，旧 version 或非 DRAFT 状态拒绝。
- Task create 同事务写入原始 Intent、DRAFT Task、首个不可变 Revision、IntentRecorded、TaskCreated 与 command receipt。
- command ID 幂等：同 payload 返回首次固定结果，不重复分配显示编号；异 payload 仍拒绝。
- 约束文本保留且约束 ID 在 IPC 边界要求唯一；Project 内 display number 单调分配。
- Git prepare 使用固定 main/base OID，在 `CODEESTRA_HOME/worktrees/<project-id>/<task-id>` 创建 `refs/heads/task/<task-id>` 与 worktree；路径段只接受 UUID。
- Runtime workspace service 在 Git 副作用前持久化 Workspace reservation 与 PLANNED/IN_PROGRESS Operation，成功后原子记录 READY/SUCCEEDED 与 WorkspacePrepared。
- 重复已完成 workspace command 直接返回已记录资源，即使仓库随后不可访问也不重放 Git；运行中/恢复态拒绝盲重试。
- prepare 拒绝 stale base、既有 branch/path、相对 worktree root 和 symlink escape；确定的前置冲突记 FAILED/RELEASED，可能已产生副作用的错误记 RECOVERY_REQUIRED；临时仓库测试确认用户 main 工作区保持 clean。
- workspace 准备前复核仓库 identity；无法检查或 identity 变化时使 ACTIVE trust 失效。

实际验证：
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 -c bun run check`：TypeScript（含 apps）通过；212 项 domain 测试及 25 项 Bun contracts/storage/Git/Runtime 测试通过。
- 临时 `CODEESTRA_HOME` 与临时 Git 仓库手工 smoke：trust、project list、task create/list/submit、stop 成功；任务从 DRAFT 以 version 0 提交为 READY/version 1。

其后的 FOUNDATION-008 已补充 Execution 预留与 workspace Operation 启动扫描；仍未实现 Task revision CLI、自动 Scheduler、fake/真实 Adapter 与 event delivery worker。

## FOUNDATION-008 — Execution 预留与 Workspace 启动恢复

状态：Execution 原子预留和 workspace prepare Operation 启动扫描已实现；尚未启动 Agent Session。

已实现：
- READY Task + READY owned workspace 可在单事务中预留一个 CREATED Execution，固定 current revision、base commit、adapter/version 与 attempt number。
- 同事务将 workspace 置 IN_USE、Task 置 RUNNING/version+1，并写 ExecutionReserved、TaskStateChanged 与 command receipt；重复 command 不创建第二次 Execution。
- Git reconcile 使用 `git worktree list --porcelain -z`、canonical path、branch 与 HEAD 核对资源，不依赖显示名称或普通文本输出。
- Runtime 启动扫描 PLANNED/IN_PROGRESS/RECONCILE_REQUIRED workspace Operation，但不盲目重放 `git worktree add`。
- 已完成且 HEAD 仍为固定 base 的副作用补记 SUCCEEDED/READY；确认无 path/ref 的操作记 FAILED/RELEASED；路径、branch、HEAD 或仓库状态不确定时保留 RECONCILE_REQUIRED/RECOVERY_REQUIRED。
- PLANNED（尚未进入副作用）的操作只报告 SAFE_TO_RESUME，当前不在启动时自动执行。

实际验证：
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 -c bun run check`：TypeScript 通过；212 项 domain 测试及 29 项 Bun contracts/storage/Git/Runtime 测试通过。
- 临时仓库覆盖 Execution 重复预留、Git 成功但 DB 未回写、无外部资源及 worktree HEAD 被外部推进四类场景；用户 main 工作区保持 clean。

尚未实现：READY Task 自动选择/串行调度、Execution PREPARING/STARTING 状态服务、Agent start Operation/Session、非 workspace Operation 恢复、event delivery worker。

## FOUNDATION-009 — Agent Start Operation 与 deterministic fake

状态：start-only Adapter port 与 Session 启动编排已实现；尚无事件观察、工具执行或结果捕获。

已实现：
- `packages/contracts` 导出最小 `AgentStartAdapter`、capabilities、start request 与 Session ref；未实现的 observe/control API 不以空方法冒充。
- `packages/agent-adapters` 提供 deterministic start-only fake，支持成功、明确 start 前失败、start 可能已发生三种模式；它不执行命令。
- schema version 2 以 additive migration 新增 `agent_sessions`；真实文件数据库可从 version 1 升级，较新未知版本仍拒绝。
- Execution 按 CREATED→PREPARING→STARTING→RUNNING 分步 CAS/事务更新；Adapter 调用前持久化 Session STARTING 与 START_AGENT Operation。
- 成功启动原子记录 Session ACTIVE、Execution RUNNING、Operation SUCCEEDED、ExecutionStateChanged 与 AgentSessionStarted。
- 可证明未创建 Session 的失败记录 Execution/Task FAILED、Session EXITED、workspace RETAINED 并释放 Execution ownership；未知或可能已启动的错误使 Session/Execution/Task/workspace 与 Operation 进入恢复态，不释放资源。
- Runtime 重启遇到 IN_PROGRESS Agent start 时不重放 Adapter start，而是记录 RUNTIME_RESTARTED 并进入 RECOVERY_REQUIRED；PLANNED start 只标为可安全继续。
- 重复成功 start command 返回原 Session，不第二次调用 Adapter；adapter/version 与 Execution reservation 不一致时在副作用前拒绝。

实际验证：
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 -c bun run check`：TypeScript 通过；212 项 domain 测试及 34 项 Bun contracts/storage/Git/Runtime 测试通过。
- 测试覆盖 version 1→2 migration、成功 start 幂等、明确 pre-start failure、可能已启动 failure 与 Runtime 在 start 中途重启。

限制：fake 只证明 Codeestra 协议和状态编排，不能声称真实 Pi、进程静止、resume、attach 或权限门禁已验收。

## FOUNDATION-010 — Adapter Observation、去重与 durable outbox

状态：attention/completed observation 子集已实现；回答/control、真实 Pi 与成果捕获尚未实现。

已实现：
- `AgentObserveAdapter` 仅增加当前有 coordinator 语义的 attention/completed event；事件在 Runtime 经严格 Zod 边界校验。
- schema version 3 additive migration 增加 Session observation cursor、`adapter_events` 与 `attention_requests`；覆盖 v2→v3 真实文件升级。
- provider event 以 Session/event ID 去重并约束 cursor 唯一；同 ID/同内容返回已有结果，不重复迁移状态或写事件，同 ID/cursor 异内容 fail-closed。
- Attention 在单事务建立 OPEN request，将 Session/Execution/Task 转为 WAITING_FOR_USER，并记录 UserAttentionRequested 与状态事实。
- completion failure 只有携带显式工具和归属 writer 静止证据才使 Session EXITED、Execution/Task FAILED、workspace RETAINED 并释放 ownership。
- completion success 只记录 Session EXITED 与 AgentSessionCompleted；在成果 commit 尚未按 ADR-0003 捕获前，Execution/Task 不虚假标为成功。
- observation cursor 与投影同事务保存；重启后从 cursor 继续。deterministic fake 支持固定事件序列和重复事件测试。
- durable delivery worker 为消费者补齐 outbox，按 sequence 至少一次投递，持久化 attempt、错误和退避；consumer 必须按 eventId 幂等。

实际验证：
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 -c bun run check`：TypeScript、212 项 domain 测试及 39 项 Bun contracts/storage/Git/Runtime 测试通过。
- 覆盖 Attention 重复事件/内容冲突、cursor 恢复、outbox 失败后到期重投、成功 completion 不越权宣称 Execution 成功、带静止证据的失败 completion。

限制：fake 不执行工具；fake evidence 只能证明协议分支，不能证明真实 provider 进程或后代 writer 已静止。当前 outbox worker按批次调用，尚未接 UI 长连接循环。

## FOUNDATION-011 — Pi RPC framing 与 fail-closed gate

状态：Pi transport/gate 子集已实现并可由 Pi 0.84.4 加载；尚不是完整真实进程 Adapter。

已实现：
- LF-only UTF-8 JSONL decoder，不使用会误切 U+2028/U+2029 的通用 line reader；支持分块多字节、CRLF 输入、尾记录和 record size 上限，malformed/non-object 输入明确失败。
- RPC command encoder 固定单个 LF；extension UI dialog 经严格 Zod schema 转换为 provider identity/cursor 绑定的 Attention event，已知 fire-and-forget UI 消息不误建 Attention，未知 UI method fail-closed。
- 受控 Pi 参数固定 `--mode rpc --no-approve --no-extensions --extension <gate> --tools <known builtins>`；不加载项目/全局 extension，也不把 Codeestra trust 等同 Pi 动态资源授权。
- gate 按用户补充确认的 Phase 1 策略：内置 read/grep/find/ls 直接允许；write/edit/bash/powershell 每次调用 Pi 原生 `ctx.ui.confirm`；其他工具、无 RPC channel 与不可序列化参数均拒绝并请求终止。
- Permission title 绑定 toolCallId、tool name 与完整 input SHA-256；RPC request ID 作为 providerRequestId，后续 answer Operation 可精确关联。

实际验证：
- 新增 7 项 framing/gate tests，覆盖 split UTF-8、U+2028、malformed/oversize records、allow/deny/unknown/no-UI、Permission 映射与受控参数。
- 本机 Pi 0.84.4 smoke：使用 `--no-approve --no-extensions` 与源码 gate 启动 RPC，`get_state` 成功返回并建立隔离临时 Session；未发送 prompt、未调用模型或工具。
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript、212 项 domain 测试与 46 项 Bun tests 通过，`bun audit` 无已知漏洞；fake/单测不能替代真实工具执行与取消验收。

限制：尚未持有/恢复 Pi 子进程 identity 与 pipes；因此不能声称真实 Pi 执行闭环已完成。

## FOUNDATION-012 — Typed Attention answer 与持久投递

状态：answer command/storage/coordinator 子集已完成；Runtime 主循环尚未绑定真实 Adapter registry。

已实现：
- 新增 `attention list` 与类型化 `attention answer` Runtime/CLI 合约：`CONFIRM(true/false)`、`VALUE(string)`、`CANCEL`；用户明确选择不暴露 provider-shaped 原始 JSON。
- Adapter Attention 必须声明 `responseType=CONFIRM|VALUE`，存储边界拒绝不匹配回答；Pi 映射和 `extension_ui_response` encoder 保留 confirm false 与 cancel 的不同语义。
- schema v4 增加 typed response、`attention_answers` 和 Intent→Attention target；命令事务原子写 ANSWER_AGENT Intent、answer、PLANNED Operation、command receipt 与不含敏感正文的 `UserAnswerRecorded`。
- delivery coordinator 在 Adapter 副作用前持久化 IN_PROGRESS；成功后写 `UserAnswerDelivered`，且仅在没有其他阻塞 Attention 时恢复 Session/Execution/Task。
- 明确 pre-delivery 失败回到 PLANNED，可安全重试；可能已投递、receipt 异常或 Runtime 在 IN_PROGRESS 中重启时不重放，保留 ownership 并令 Session/Execution/Task/workspace 进入 RECOVERY_REQUIRED。
- deterministic fake 支持 answer 幂等、明确投递前失败与可能投递后失败；拒绝（confirmed=false）是成功投递的有效回答。

实际验证：
- 覆盖 denial、command/delivery 去重、response type mismatch 原子回滚、明确失败重试、未知投递与重启 reconcile、v3→v4 migration、Pi typed response encoding。
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript、212 项 domain 测试与 53 项 Bun tests 通过，`bun audit` 无已知漏洞；fake 仍不证明真实 Pi pipe、进程或工具恢复行为。

限制：CLI 当前只记录 PLANNED answer；真实 Pi Adapter/event loop 接入后才会由 Runtime 自动投递。无 provider identity 证据时不尝试恢复或重放。

## FOUNDATION-013 — 真实 Pi RPC 子进程 Adapter

状态：`PiRpcAdapter` 已实现并通过 stub-transport 测试与本机真实 Pi transport smoke；Runtime 尚未接入 adapter registry/事件 pump。

已实现：
- `PiRpcClient` 拥有一个 `pi --mode rpc` 子进程的 stdio：LF-only framing、按 `id` 关联 command response、超时、与进程退出/流损坏捆绑的 `disconnected` 信封，以及 stderr 只保留长度与 hash 的边界。
- 进程身份不再只有 PID：`readProcessStartToken` 在 Linux 读 `/proc/<pid>/stat` + boot id，否则回退 `ps -o lstart=`；拿不到 start token 时拒绝启动。身份连同 argv hash、executable、capturedAt 持久化到 `agent_sessions.process_identity_json`，session file 存 `session_storage_ref`。
- `PiRpcAdapter` 受控启动：`--mode rpc --no-approve --no-extensions --extension <gate> --no-skills --no-prompt-templates --no-themes --no-context-files --tools <builtins>`；Task 输入只来自持久化 revision（`knowledgeSnapshotRefs` 留作后续显式交付）。
- start 流程为 spawn → `get_state`（取 provider session id/file）→ 采集身份 → `prompt`（revision 规格与 constraints）；任一步失败都会终止自有子进程并在错误里报告是否确认停止。
- observe 把 permission/question dialog 映射为 typed Attention，把 `agent_settled` 映射为 SUCCESS completion（evidence ref 写明依据），把进程意外退出映射为 `disconnected`；无 live 进程、provider 身份不符、陈旧 cursor epoch 一律拒绝，不重接、不重放。
- answer 写入 `extension_ui_response`（confirm false 与 cancel 语义不同），仅当持有 live 进程时返回 accepted；Pi 无回答回执，accepted 只表示已交给 transport。
- `agent_settled` 后不保留 idle 子进程：先做有界停止尝试，确认停止后才发出 completion；无法确认停止的 PID 由 `unconfirmedStops()` 暴露（Phase 1 尚无 UI 展示，已知缺口）。
- 断连投影经 schema v5 落地：Session `DISCONNECTED`、Execution/Task/workspace `RECOVERY_REQUIRED` 且保留 `resource_held=1`，不声称静止、不释放占用。

实际验证：
- 新增 6 项 stub-transport 集成测试（真实 spawn、真实 stdio、可注入 argv）：受控 argv、身份字段、revision prompt、dialog→Attention→confirm(false) 写回→settled→SUCCESS、意外退出→disconnected（未出现 completed）、无 live 进程/陈旧 cursor/provider 不匹配拒绝、版本探测与能力边界。
- 新增 disconnect 投影与 v4→v5 migration 测试；fake adapter 支持 `disconnected` 事件。
- 本机真实 Pi 0.84.4 transport smoke：受控 argv 启动、`get_state` 返回 provider session id/file、`ps` start token、SIGTERM 后确认退出且无残留 `pi --mode rpc` 进程；未发送 prompt、未调用模型。
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript、212 项 domain 测试与 61 项 Bun tests 通过，`bun audit` 无已知漏洞。

限制：Runtime 尚无 adapter registry 与事件/回答 pump，所以 CLI 仍不会自动启动真实 Pi；completion 仍需后续 result capture 门禁；真实工具执行、取消超时与孤儿进程 reconcile 未验收。

## FOUNDATION-014 — Runtime Adapter registry、Agent 运行循环与自动投递

状态：单 Task 从 CLI 到 Adapter 事件投影与 answer 投递的运行循环已实现；真实 Pi 工具执行与结果捕获尚未验收。

已实现：
- `AdapterRegistry` 按 Adapter ID 保持唯一实例；未注册 Adapter 在 Git/DB/Adapter 副作用前拒绝。生产 Runtime 只注册 Pi，deterministic fake 不进入生产 registry，避免把 fake Session 当作真实执行。
- `AgentRuntimeCoordinator.runTask` 串起 owned worktree prepare、Execution 预留、Agent start 与 observation pump。同一次 `task.run` 的各子步骤使用由 run command ID 派生的稳定内部 ID，因此重放同一命令会分别命中已记录的 operation/receipt，不重复 Git 副作用、不创建第二个 Execution、不第二次调用 Adapter。
- event pump 复用既有 observation 校验/去重/投影路径，新增 `onProjected` 钩子；投影后按 Session 尝试投递 PLANNED answer。
- `attention.answer` 在记录 answer 后立即通过持有 live Session 的 Adapter 投递；没有 live Session 时保持 `ANSWER_RECORDED`/PLANNED 并返回 `NO_LIVE_SESSION`，不重放、不谎称已投递。仅可证明的 pre-delivery 失败保留可重试 PLANNED；不确定投递进入 RECOVERY_REQUIRED。
- 新增可选 `AgentProcessRelease` 合约（`releaseSession`）。`PiRpcAdapter` 据此实现原 `dispose`，Runtime shutdown 释放自有 provider 进程；未确认停止只记录日志。
- Runtime shutdown 对已释放的 live Session 写入 Runtime 来源的 disconnect 投影（Session DISCONNECTED、Execution/Task/workspace RECOVERY_REQUIRED、保留 resource ownership），不写入伪造的 provider event 或 cursor。
- storage 新增 `listTaskExecutions` 只读投影与 `recordRuntimeDisconnect`；CLI 新增 `task run [--adapter <id>]` 与 `task status`；Runtime 错误响应改用上游稳定 error code（如 `PROVIDER_VERSION_UNAVAILABLE`）而非一律 `INVALID_REQUEST`。

实际验证：
- 新增 7 项 Bun 测试：交互式脚本 Adapter 走完 attention→typed answer→completion（completion 不把 Execution 标为 SUCCESS）；同 command ID 重放不重复副作用；未注册 Adapter 无副作用；无 live Session 时 answer 保持 recorded；proven pre-delivery 失败后重试成功；shutdown 释放进程并记录 RECOVERY_REQUIRED；派生 ID 稳定且互异。
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript、212 项 domain 测试与 68 项 Bun tests 通过，`bun audit` 无已知漏洞。
- 临时 `CODEESTRA_HOME` + 临时 Git 仓库手工 smoke：trust→task create/submit/status→`task run`（`CODEESTRA_PI_EXECUTABLE` 指向不可用 provider）失败为 `PROVIDER_VERSION_UNAVAILABLE`，未创建 workspace/Execution，Task 保持 READY，用户 main 工作区 clean。

限制：未以真实 Pi 运行模型与工具，因此真实工具执行、取消超时、真实事件重投、孤儿进程 reconcile 与 Runtime 重启后的 live Session 恢复仍未验收；脚本/fake Adapter 只证明协议与编排。outbox 长连接当时仍未实现；成果 commit（ADR-0003）与 Task verification 已在其后的 FOUNDATION-015/016 实现。

## FOUNDATION-015 — 成果 Commit（ChangeSet、敏感策略与一次性确认）

状态：ADR-0003 的最小实现已完成，限于成果 commit；Task verification 尚未实现（由其后的 FOUNDATION-016 补齐）。

用户本轮确认：确认流程采用两步 `task result prepare` + `task result commit --confirm`；敏感/运行数据路径采用版本化 deny policy 且 fail-closed 无覆盖；本轮只做成果 commit。

已实现：
- `packages/git` 新增 ChangeSet 检查：tracked 增删改/rename 与未被 ignore 的 untracked 文件；指纹在私有临时 index 上计算 worktree 完整 tree OID，因此不受用户真实 index/暂存状态影响，只随内容/模式/HEAD 变化。
- 版本化敏感路径策略（v1）作为纯函数先于任何暂存执行，fail-closed 且 Phase 1 不提供绕过参数；`.env` 类、私钥/凭据、`.ssh`、Codeestra runtime 数据库与 `pi-sessions` 等命中即拒绝，不创建授权。
- 身份只读取仓库可解析的 `user.name`/`user.email`，缺失时报错，不代写 config；commit 使用仓库自身 hooks，从不传 `--no-verify`。
- storage 新增 `result_commit_authorizations` 生命周期（ACTIVE/CONSUMED/INVALIDATED，单 Execution 仅一 ACTIVE）与 `CAPTURE_RESULT` Operation；`prepare` 写授权，`capture` 先写 IN_PROGRESS 再执行 Git 副作用。外部副作用型 Operation 不重放：重放返回已完成的 Operation，中断则要求 reconcile。
- `packages/contracts` 的 `task.result.commit` 在 IPC 层就要求 `confirm: true`，未确认请求无法到达 Git。
- 消费后 Execution→SUCCEEDED、workspace→RETAINED、Task→EXECUTED，`ResultCommitCreated` 事件记录 commit/tree/实际身份/hook 结果/policy 来源；不自动 main、不 push。
- 失败处理：hook 失败则不提交、保留 staged 现场、Operation FAILED 且授权保持 ACTIVE 可重试；`git commit` 报错但 HEAD 已移动时按 parent/message 核对后采纳并记录 `REPORTED_FAILURE_AFTER_COMMIT`，不重写历史；不匹配则 invalidate 并要求人工处理。启动 reconcile 采纳已生成 commit，未生成则记 FAILED，HEAD 异常则保留恢复态。
- CLI 新增 `task result prepare <project-id> <task-id> [execution-id]` 与 `task result commit <project-id> <task-id> <authorization-id> --confirm`。

实际验证：
- 新增 8 项 git 测试（敏感路径分类、ChangeSet/rename/内容与 HEAD 变化、身份解析、hook 执行与失败、`--no-verify` 未使用）与 9 项 runtime 测试（prepare 只读、敏感拒绝、未静止拒绝、正常提交与状态迁移/事件、同命令重放不产生第二次 commit、变更后失效、hook 失败保留现场并可重试、崩溃后采纳与无 commit 失败）。新增 2 项 IPC 契约测试。
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript、212 项 domain 测试与 87 项 Bun tests 通过，`bun audit` 无已知漏洞。
- 临时 `CODEESTRA_HOME` + 临时 Git 仓库 CLI smoke：`task result prepare` 无 Execution 时返回 `NO_ACTIVE_EXECUTION`；未带 `--confirm`或带其他 flag 的 commit 在 CLI 被拒绝；main 工作区保持 clean。

限制：未以真实 Pi 产出变更后做完整 prepare→commit 手动验收（正链路由脚本/真实临时仓库测试覆盖）。ChangeSet 是全量 tree 指纹，不保存逐文件内容；reconcile 只能依据 parent + 确定性 message 采纳 commit，不能重算已提交差异。Task verification 已在其后的 FOUNDATION-016 实现；IntegrationBatch 与 main 提升仍未实现。

## FOUNDATION-016 — Task Verification（策略来源、trust 预授权与隔离副本）

状态：ADR-0006 的最小实现已完成；Integration verification 与调度器仍未实现。

用户本轮确认（记录为 ADR-0006）：验证命令来自项目内人工维护的策略文件；授权在项目 trust 时列入并一次性确认，策略未变化则后续自动运行。

已实现：
- `packages/contracts` 新增严格验证策略 schema 与内容摘要：未知字段、重复 ID、空命令表、非法 `cwd`（绝对/`~`/`..`）、绝对或越界 program、单命令超时 >1800s、总超时 >3600s 均拒绝；digest 对规范化内容做 SHA-256，并有固定值测试锁住算法。
- 策略只从项目配置的 main ref 读取（`git cat-file` 解析到具体 commit 作为证据）。Task branch 上的同名文件不参与判定，因此 Agent 无法用更弱的命令判定自己。
- schema v6：新增 `project_verification_policy_confirmations`（ACTIVE/SUPERSEDED + 单活动唯一），重建 `verification_runs`（补 `project_id`/`operation_id`/`command_id`/`tested_tree`/`policy_digest`/`main_commit`/`copy_path`/`outcome_code`/`evidence_json`/`queued_at`，`tree_fingerprint` 改为 `tested_tree`，`UNIQUE(project_id,command_id)`，终态必须有 `ended_at` 与 `outcome_code`）；真实文件库覆盖 v5→v6 升级。
- trust 增加策略确认：`project.verificationPolicy` 只读检查 + 两步 confirm；Runtime 在写入前重读并核对 state/digest/mainCommit，不一致返回 `VERIFICATION_POLICY_CHANGED`；重复 trust 以新 ACTIVE 记录替换旧记录（旧行保留为 INVALIDATED/SUPERSEDED），project 不重复创建；trust 失效同时废止确认。
- 验证执行：`task.verify` 在 `<CODEESTRA_HOME>/verifications/<project-id>/<verification-id>` 创建固定 commit 的 detached 副本；命令以 argv 直接 spawn（附加 `CI=1`），每命令独立进程组，超时按组 SIGTERM→SIGKILL。
- 状态与证据：`QUEUED → RUNNING → PASSED | FAILED | ERROR`；`COMMAND_FAILED` 停止后续命令，超时记 `ERROR/COMMAND_TIMEOUT`，tracked 改动或 HEAD 移动记 `ERROR/TREE_MUTATED`（不覆盖已判定 FAILED），副本创建失败记 `ERROR/WORKTREE_FAILED`。证据只含 exit code、时长、字节数、输出摘要、路径列表与副本处理结果；原始命令输出只在调用方终端以有界尾部展示，不入库。
- 旧 `PASSED` 在新 commit 或新 policy digest 下变为 `STALE` 并保留原结论与 stale 原因，写 `VerificationInvalidated`；重放同一 command ID 返回已记录结果且不重跑。
- Runtime 重启：未完成 run 记 `ERROR/RUNTIME_RESTARTED` 并保留副本路径供检查；shutdown 按进程组停止自有验证命令，未确认停止只记录。
- CLI 新增 `project policy`、`task verify`、`task verification list`，`project trust` 展示将运行的命令与 cwd/超时后才请求确认；`task status` 附带验证记录。

实际验证：
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript、212 项 domain 测试与 122 项 Bun tests 通过，`bun audit` 无已知漏洞。
- 新增 6 项策略测试（含固定 digest）、8 项 Git 副本测试、7 项 storage 测试（含 v5→v6 与 trust 重确认）、11 项 runtime 验证测试（正常/拒绝/失败/超时/树改动/重放/重启 reconcile）。
- 临时 `CODEESTRA_HOME` 与临时仓库 CLI smoke：`project policy` 输出确认摘要；首次与策略变更后的 `project trust --yes` 均成功且旧 trust/确认变为 SUPERSEDED、project 仍为 1 条；对未捕获成果的 Task 执行 `task verify` 返回 `TASK_NOT_EXECUTED`；`verification list` 为空；`stop` 后用户仓库 `git status` clean、无 worktree 残留、数据目录无 `verifications` 残留。

限制：未以真实 Pi 产出变更后跑完整 prepare→commit→verify 手动验收（正链路由脚本与临时仓库测试覆盖）；无沙箱/网络隔离；无 `integration verification`、无 main 提升；副本目录尚无 `task verification prune`，失败现场需人工清理；同一 Task 并发触发多次验证会各自创建副本并行执行（互不干扰但会重复运行命令），Phase 1 不做去重。

## FOUNDATION-017 — 只读事件订阅长连接

状态：Runtime 订阅传输、Hub 与 CLI `events list`/`events tail` 已实现并通过真实 socket 测试；长命令进度可见性本轮明确不做。

用户本轮选择：下一步切片为「事件订阅基础」；verification「进度可见」暂不改（不新增进度事件、不改 `task.verify` 同步语义）。

已实现：
- `packages/contracts` 新增 `events.list`（`sinceSequence` 默认 0、`limit` ≤500）与 `events.subscribe`（`sinceSequence` 缺省表示“从当前尾部开始”，不默认成 0），以及严格流帧 schema：`subscribed` / `event` / `heartbeat` / `error`；帧的 `cursor` 与事件 envelope 均受校验。
- `packages/storage` 新增只读游标读取：`listEventsAfter`（排他游标、可选 project 过滤、1..500 上限、非法游标/上限拒绝）与 `latestEventSequence`。不写 `event_deliveries`，不改变任何业务状态。
- `apps/runtime/src/event-subscription-service.ts`：共享轮询的 `EventSubscriptionHub`，一帧 `subscribed` 后按 sequence 交付 `event`，定期 `heartbeat`，`error` 为终止帧；订阅只持有 socket 与游标，不重放 command。
- 游标语义：排他；显式游标超前于日志时回 `INVALID_CURSOR` 并终止（不静默夹到尾部）；客户端断开或发送能力失败即移除订阅；日志读取失败回 `EVENT_READ_FAILED` 并移除，不假装仍在跟踪。project 过滤只影响交付，游标仍会前进（读到不满一批即证明已读到尾部），因此过滤订阅重连同样不漏不重。
- Runtime socket 现在同时承载一次性命令与长连接：`events.subscribe` 不走一次性 dispatch，订阅建立后同一连接再发 command 属违约并直接关闭；`runtime.ping` 报告 `eventSubscribers`；shutdown 关闭 hub 且订阅 socket 随 listener 停止。终止帧与 `socket.end()` 同次刷出，避免客户端只看到断电而拿不到原因。
- CLI 新增 `events list [--project] [--since] [--limit]` 与 `events tail [--project] [--since]`；`tail` 的 stdout 每行一个 event envelope（供脚本消费），订阅元信息与错误走 stderr，游标失效以退出码 1 报告。

实际验证：
- 新增 20 项测试：contracts 5 项（请求默认值/越界拒绝、流帧校验）、storage 5 项（顺序/排他游标/项目过滤/上限与游标拒绝/空日志为 0）、hub 8 项（快照游标、显式重放与 resume 不漏不重、项目过滤下游标仍前进、`INVALID_CURSOR` 不夹断、对端掉线移除、heartbeat、定时轮询自动交付、读取失败终止）、真实 socket 集成 2 项（同 socket 并发一次性命令、连接后新事件实时到达并以记录的游标 resume 无重复；`INVALID_CURSOR` 只关闭该连接且不留下订阅）。
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript、212 项 domain 测试与 144 项 Bun tests 通过，`bun audit` 无已知漏洞。
- 临时 `CODEESTRA_HOME` + 临时 Git 仓库 CLI smoke：`events list --since 0` 返回 2 条事件与 `cursor`/`hasMore`；后台 `events tail` 打印 `Subscribed at cursor 2`，随后新 Task 的两条事件以 sequence 3/4 实时流出；`events tail --since 9999` 打印 `INVALID_CURSOR` 且退出码 1；`status` 显示 `eventSubscribers` 计数；smoke 后已停止 Runtime 并清理临时目录。
- 校验中发现并修复两处真实缺陷：`socket.end()` 与终止帧的写出顺序（原先可能丢掉错误帧，客户端看到“无输出的成功”）；CLI `tail` 先 `socket.end()` 再报告错误，会被同步触发的 close 覆盖成退出码 0。

限制：这是一条只读观察通道，不构成“已交付”证据，也不替代 outbox 的至少一次投递。CLI 不持久化游标、无自动重连（重连需显式 `--since`）；订阅无按 project 的鉴权，边界仍是 0600 socket；`heartbeat` 间隔固定 15s 且未写入业务事件；长命令（`task.run`/`task.verify`）仍同步占用连接，其进度事件需扩事件目录与后台 Operation，本轮未做。

## FOUNDATION-018 — 本地 Web UI 入口（`codeestra ui`）

状态：ADR-0007 已确认并实现；HTTP/SSE 边界、CLI 入口、React 界面与真实浏览器验证均已完成。真实 Pi 工具执行仍未验收。

用户本轮选择：“可以运行的、有 UI 界面的软件”“先让我有一个可操作的东西” → 本地 Web UI（不是 Tauri/终端 TUI），且首版包含跑 Agent 的按钮。

已实现：
- `apps/runtime/src/http-api.ts`：按需启动、只绑 `127.0.0.1` 的 HTTP 服务。`/api/command` 复用同一 `dispatch` 与同一 Zod 请求 schema（HTTP 不新增业务语义）；`/api/events` 把 `EventSubscriptionHub` 的帧以 SSE 形式输出（`fetch` 流式读取，因此 token 从不进 URL）。
- 安全边界：每次启动随机 token（`randomBytes(32)`），只存 Runtime 内存，经既有 0600 socket 由 `runtime.ui` 下发，不写盘、不进事件与日志；`Authorization: Bearer` 常量时间比较；无 CORS 头，存在 `Origin` 时要求同源；POST 必须 `application/json`；所有响应 `no-store` + `nosniff`；静态资产路径拒绝 `..`/绝对路径；`events.subscribe` 与 `runtime.ui` 不能经 HTTP 调用。
- `runtime.ui` 幂等（重复调用返回同一地址与 token），未调用时不监听任何端口；shutdown 停止 HTTP 服务与订阅。资产未构建时报 `UI_ASSETS_MISSING` 并提示构建命令，不回退到伪界面。
- `apps/ui`（React 19 + Vite）：项目 inspect/trust（两步确认 + 策略展示）、任务 create/list/submit/status（含 Execution/Session 与验证记录）、Attention Inbox（allow/deny/value/cancel）、`task run`、`task result prepare` + `commit --confirm`（展示 expected HEAD/指纹/静止证据）、`task verify`、实时事件流（自跟踪 cursor）。token 经 URL fragment 传入并立即 `replaceState` 清除，存入 `sessionStorage`。
- CLI：`codeestra ui [--no-open]` 打印地址并可选打开浏览器；`runtime.ping` 增 `uiRunning`。
- 构建与校验：`bun run check` 现含 `apps/ui` 类型检查与 Vite 构建；`just` 增 `ui-typecheck`/`ui-build`。

实际验证：
- 新增 5 项 HTTP 边界测试：无/错 token 401、异源 POST 403（同源 200）、非 JSON 415、未知命令与 HTTP 上禁止的流式/UI 启动命令 400、静态资产与 SPA 回退、无资产时 `UI_ASSETS_MISSING`、`stop()` 释放端口、SSE 帧与 `INVALID_CURSOR` 终止帧、start 幂等且 token 不出现在服务器可见的 URL 部分。
- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript（Runtime/CLI）、212 项 domain 测试、149 项 Bun tests、UI 类型检查与 Vite 构建、`bun audit` 无已知漏洞。
- 临时 `CODEESTRA_HOME` + 临时仓库 HTTP smoke：页面 200（`<title>Codeestra</title>`）、JS 资产 200、无 token 的 `/api/command` 401、带 token 的 `task.list` 返回任务、`/api/events?sinceSequence=0` 输出 `subscribed` 与事件帧；未构建资产时 `codeestra ui` 报 `UI_ASSETS_MISSING` 且退出码 1。
- **真实浏览器验证**（Zen + Orca computer-use，截图证据）：页面渲染项目选择器/任务列表/新建表单；在界面上输入规格并点击 `Create draft` 后 `#2 DRAFT` 出现且事件流显示 `live cursor 4` 与对应 `TaskCreated` 帧——即 UI → HTTP → Runtime → SQLite → 事件 → SSE → UI 的真实闭环。

> 注（ADR-0008）：本条记录的 computer-use 浏览器验证是历史证据，今后不再采用该方式复现；UI 验收改为 headless 命令面/HTTP 断言加用户在场人工确认。
- 浏览器验证时发现并修复两个真实缺陷：Bun 默认 `idleTimeout` 10s 会在 15s 心跳之间断开 SSE（改为 120s，并在流开头发送注释帧立即 flush）；UI 原先把一次断流当成终止错误，现改为按最后 cursor 自动重连（最多 5 次退避），只有终止性 `error` 帧才停止跟随。

限制：UI 不新增可绕过门禁的旁路，trust/成果 commit 仍需显式确认；没有 cancel/pause 按钮（Task cancel 仍是 NEXT 项），运行中的任务只能靠停止 Runtime 释放。token 只在 Runtime 进程存活期间有效，重启即失效；订阅无按 project 鉴权（边界仍是本机 127.0.0.1 + token）。curl 等客户端访问回环地址时需自行绕过系统代理（本机 `http_proxy` 未含回环例外，浏览器默认绕过）。真实 Pi 模型与工具执行、gate 审批、取消超时仍未验收——界面上的“Run task”按钮会直接触发它们，因此首次真实运行仍应在一次性仓库中有人在场时进行。

## FOUNDATION-019 — 真实 Pi 端到端受控验收（deepseek-flash）

状态：真实模型 + 真实工具执行 + 真实 gate 审批 + 成果 commit + Task verification 全链路已跑通并有证据；过程中发现并修复 7 个真缺陷。

用户本轮决定：用本 UI 做受控真实验收；因 Codex 额度耗尽，重试模型选定 `deepseek/deepseek-flash`；模型选择先只做环境开关（`CODEESTRA_PI_PROVIDER` / `CODEESTRA_PI_MODEL`），暂不写入领域记录。

### 已验收（有证据）

环境：临时 `CODEESTRA_HOME` + 临时 Git 仓库（含人工维护的 `.codeestra/policies/verification.json`），headless 驱动真实 Pi 0.84.4；模型 `deepseek/deepseek-flash`。

- 真实模型与工具：pi session 文件记录 `model_change: deepseek deepseek-flash`；assistant 第一条 `stopReason: toolUse`（2336 tokens）发起 `write {"path":"hello.txt","content":"hello from codeestra\n"}`，第二条 `stopReason: stop`（2377 tokens）。**文件只在人工批准后写入**，内容与要求一致。
- fail-closed gate + typed Attention：`UserAttentionRequested`（kind PERMISSION、responseType CONFIRM），title 形如 `CODEESTRA_PERMISSION:<toolCallId>:write:<input sha256>`，并在界面上逐次审批（Allow）后交付；事件序列 `UserAttentionRequested → IntentRecorded(ANSWER_AGENT) → UserAnswerRecorded → UserAnswerDelivered → Session ACTIVE → Execution/Task RUNNING`。
- 状态与事件：Task #1 共 21 条事件，从 `TaskCreated` 到 `VerificationCompleted`；最终 `task #1 EXECUTED v5`、Execution `SUCCEEDED`（resources released、Session EXITED）、`VerificationCompleted PASSED` 绑定 tested commit `2e9a494e`/tree `a782ba57`/policyDigest（证据含每条命令 exitCode/duration/digest，不含原始输出）。
- 成果 commit：authorization 只列出 `ADDED hello.txt`；commit `2e9a494e` 沿用仓库 identity、`hookOutcome: PASSED`（未 `--no-verify`）。
- 隔离性：用户仓库 main 全程停在 base `0c537b6`、`git status` clean；成果只落在内部 `refs/heads/task/<task-id>`，未合并、未 push。
- UI 闭环：在界面上选择任务→`Run task…`→无需手点 Refresh 就看到 Attention 徽标与卡片→`Allow`；浏览器截图与事件日志互相印证。
- 失败面：Task #2 的验证以 `FAILED/COMMAND_FAILED` 结束（`test -f hello.txt` 退出 1），因为它的分支不含 Task #1 的成果。这正是“Task 验证 ≠ 集成验证、上游成果未集成前下游无法通过”的预期行为，而非回归。

### 本轮发现并修复的缺陷

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | `createPiAdapterRegistry` 读了 `environment` 却未传给 `PiRpcAdapter` | 生产 Runtime **从来无法启动 Pi**（env 为空、无 PATH）；此前“真实 Pi transport smoke”是直接构造 adapter，绕过了该装配路径 | 传递 `environment` + registry 回归测试（修复前失败/修复后通过） |
| 2 | worktree 归属校验要求传入 root 字符串等于 realpath | macOS `/tmp`→`/private/tmp` 等符号链接祖先直接误报 `UNSAFE_CHECKOUT`；验证副本路径同源问题 | `packages/git` 先解析一次规范 root，再用规范路径做包含判定与记录；新增符号链接根测试 |
| 3 | service 预留路径（非规范）与 `prepareWorkspace` 返回路径（规范）不一致 | `INVALID_STATE: Prepared workspace did not match its reservation` | workspace service 统一规范化 worktrees root 后再预留；路径两处同源 |
| 4 | `workspaces.path` 无条件 UNIQUE | **失败一次就永久无法重试**（“修好冲突再重试”的已声明流程不可用） | schema v7：改为部分唯一索引（仅约束非 RELEASED）；真实 v6→v7 迁移测试 + `foreign_key_check` |
| 5 | `agent_settled` 一律记 SUCCESS | **模型报错/空跑被记为“任务完成”**（诚实性缺陷） | 按 `message_end`/`turn_end` 的 assistant `stopReason` 分类：非 `stop`/`toolUse` 记 `FAILURE` 并附 provider 原文（截断）；新增两条 stub-transport 测试 |
| 6 | Bun `idleTimeout` 默认 10s，而 Hub 心跳 15s | UI 上运行长任务会先被断连，丢掉响应 | `idleTimeout: 120` + 命令响应保活字节（首个间隔内完成则不插入任何填充）+ UI 按 cursor 自动重连退避；新增慢命令测试 |
| 7 | UI 不随事件刷新 Attention/任务详情 | Agent 已阻塞等审批，界面却显示“Nothing is waiting for you” | 订阅流命中 Attention/Execution/Task/Session/Verification 事件时自动刷新对应视图（浏览器验证：徽标与卡片自动出现） |

### 实际验证

- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript、212 项 domain 测试、**158 项 Bun tests**、UI 类型检查与 Vite 构建、`bun audit` 无已知漏洞。
- 验收环境与证据保留在 `/tmp/codeestra-ds-home.pI0P`（含 pi session、verifications 副本、runtime.sqlite）与 `/tmp/codeestra-acceptance-evidence/`（首轮失败证据：`errorMessage: Codex error: The usage limit has been reached`、`stopReason: error`）。两者均为临时目录，可随时删除。

### 仍未验收 / 已知限制

- gate 的**拒绝路径**未在真实 provider 下验证（本轮只走了 Allow）；未知工具、无 UI channel 仍只有单测覆盖。
- 无 Task cancel/pause：首轮环境中失败后无变更的 Execution **永久卡在 RUNNING**（`task result prepare` 返回 `NOTHING_TO_COMMIT`，且 `resource_held=1`），目前只能停止 Runtime；这直接说明 cancel 是下一个必需能力。
- 无 Integration/main 提升：Task #2 因缺少 Task #1 的成果而验证失败，属预期；跨任务累积需要 Phase 4。
- Attention 的 `prompt_json` 会把工具输入原样入库（本例是文件内容），与“终端输出不入库”的策略不同；工具参数可能含敏感数据，需在后续决定是否摘要化。
- 长命令仍为同步请求（保活让它不至于断连，但浏览器无法在请求内展示“取消”）；未做孤儿进程 reconcile 与真实取消超时。

## FOUNDATION-020 — 效率优先 / 服务形态（CLI 完备）/ 测试边界（ADR-0008）

状态：决策已确认并已同步全部相关文档；无代码改动（本轮不删除任何门禁、不改测试）。

用户本轮提出三条原则，经四题选择题确认后记录为 ADR-0008（选项：1a / 2a / 3a / 4a）：

1. 效率至上：用户效率是第一目标；安全次要。**保留现有门禁只改优先级表述**——项目 trust、Pi 敏感工具逐次审批与 fail-closed、成果 commit 确认、验证策略确认、main 提升批准全部继续有效，但不再新增任何门禁；权限管理（RBAC/多用户/租户/密钥托管/路径沙箱/网络策略/供应链）明确移出当前范围，不预留。常态路径上任何门禁最多一次显式确认。
2. 软件本体是服务，CLI 完备：Runtime 是本体；“CLI 接口”定义为 versioned command/query/event 面；每个能力必须能只靠 CLI 完成并可脚本化驱动（含 `--json`、稳定退出码）。Web UI 与未来桌面只是同一命令面的便利前端，**不采用 UI spawn CLI 子进程**的实现方式；“只有 UI 能做”视为缺陷。
3. 测试边界：自动化测试与验收只用 CLI/命令面（含其 HTTP/SSE 传输）断言；**不使用 computer-use、OS 级键鼠/窗口自动化、桌面应用操作与真实桌面会话**；开发 Agent 不为验证取得用户电脑控制权；产品内 Agent 也不新增屏幕/桌面控制类工具。

### 修改的文件

- 新增 `docs/decisions/0008-efficiency-first-service-form.md`（Status: Accepted；amend ADR-0002/0004/0007 的优先级与入口定位，不取消 ADR-0001 D03 / 0003 / 0006 门禁）。
- `docs/decisions/README.md`：新增索引项与“优先级标注”说明；ADR-0002/0004/0007 标 Amended。
- ADR-0002 / 0004 / 0007：Status 行加 Amended 说明；ADR-0007 另注今后验收方式变更。
- `PROJECT_SPEC.md`：新增 §1.1 “第一原则”；§2 新增不变量 18/19/20；§6 补 CLI 完备与 UI 便利层；§8 补“不实现权限管理”与验收方式；§9 标注第一原则优先级最高。
- `AGENTS.md`：新增“第一原则”章节；决策规则新增“新增门禁需效率成本评估”；实现与验证新增“不获取电脑控制权”与产品内 Agent 工具边界。
- `README.md`：顶部新增“第一原则”三条；UI 描述改为共享命令面的便利层。
- `docs/architecture/README.md`：总体架构补服务形态；已确认语义与风险表补 ADR-0008。
- `docs/architecture/repository-structure.md`：补入口分层（runtime=本体、cli=完备命令面、ui/desktop=便利前端）与测试边界。
- `docs/roadmap/mvp.md`：新增“排序原则”节；非目标补权限管理与桌面/键鼠自动化测试。
- `docs/tasks/README.md`：FOUNDATION-018 的 computer-use 浏览器验证标为历史证据。

### 实际验证

- 代码检索：`grep -rn "computer-use\|Playwright\|playwright\|osascript\|screencapture"`（排除 node_modules）仅命中文档（PROJECT_SPEC/ADR-0008/AGENTS/README 的规则文本与 FOUNDATION-018 的历史记录），**仓库内无桌面自动化或键鼠控制的测试代码/脚本**；本轮未新增依赖。
- CLI 完备性核查：对 `PROJECT_SPEC.md` §2 第 12/13 条与 ADR-0003/0006 描述的能力逐个对照 README §本地检查 中的命令清单，`project inspect/trust/list`、`task create/list/submit/run/status/result prepare|commit/verify`、`task verification list`、`attention list`（及 answer 路径）、`events list/tail`、`ui`、`stop` 均存在 CLI 入口，未发现仅 UI 可用能力。
- 回归确认：`bun run check` 通过——TypeScript（Runtime/CLI）与 UI 类型检查通过、212 项 domain Vitest 通过、**159 项 Bun tests** 全部通过、UI Vite 构建成功。本轮无代码改动，此结果只证明既有门禁/测试未被文档变更影响。
- 未执行：真实 Pi 端到端验收、真实浏览器/桌面验证——本轮为文档级决策记录，不含运行时变更。

### 剩余问题

- 门禁的实际“一次确认”预算目前靠约定而非测试约束；若出现第二道确认，需当作回归开缺陷。
- CLI `--json` 覆盖度尚未系统核查（当前仅部分命令提供），是 D03 完备性的下一批具体工作项。
- ADR-0007 列出的 UI 验证项（token/Origin/SSE）今后改用 headless 断言重写，现有实现未变。

## FOUNDATION-021 — 在 Web UI 中打开本项目开发（`codeestra open` + 本仓库验证策略）

状态：已实现并在 CLI/命令面验证（按 ADR-0008 的测试边界，不使用电脑控制/浏览器自动化）；本仓库已注册为真实可信项目。

用户本轮要求“在 Web UI 中打开本项目进行开发”，四题确认选择（均为推荐项）：

1. 提交策略：**一个完整提交**——把本轮全部未提交工作与验证策略文件写入 main。Agent 的 worktree 从 main ref 创建，不提交则 Agent 看不到 `apps/ui`、事件订阅与验收修复。
2. 验证策略：**`bun run check`**（typecheck + UI typecheck + 212 项 Vitest + Bun tests + UI 构建）。
3. 入口形态：**新增 `codeestra open [path]`**（ADR-0008：CLI 完备命令面，UI 只是便利层）。
4. 成果回收：**先手动 merge**（Integration/main 提升仍留后续阶段）。

### 已实现

- `.codeestra/policies/verification.json`（人工维护，位于 main ref，Task 分支无法改写判它的命令）：两条命令——`install`（`bun install --frozen-lockfile`）与 `check`（`bun run check`）。**为什么需要 install**：验证副本是 `git worktree add --detach` 的固定 commit，不含被 gitignore 的 `node_modules`，因此任何依赖 `node_modules` 的策略命令必须先装依赖。
- `codeestra open [path] [--yes] [--no-open]`（`apps/cli/src/main.ts`）：inspect 仓库 → 打印身份与将要执行的验证命令 → 走与 UI 相同的 TRUST 确认门禁 → `project.trust` → 启动/复用 Web UI → 输出把该项目放进 URL fragment 的地址并按需打开浏览器。它**只组合既有命令**（`project.inspect/verificationPolicy/trust/list`、`runtime.ui`），未新增任何只有 UI 或只有 CLI 可用的路径，也未新增门禁。
- **一次确认**：`project.list` 增加 `confirmedPolicy`（ADR-0006 的有效策略确认）；`open` 在“已信任且已确认的策略 digest 与 main ref 当前策略一致”时**不再要求确认**，只在项目陌生或策略文件真的变了时走 TRUST 门禁。判定规则与 `task verify` 的门禁一致（比 digest，不比 main commit），所以日常向 main 提交代码不会反复要求确认——符合 ADR-0008“常态路径上任何门禁最多一次显式确认”。
- 预选实现：URL fragment 增加 `project=<id>`（token 仍只在 fragment，绝不进 query/日志）；`apps/ui/src/main.tsx` 一次性解析 fragment 后清空地址栏，`App`/`Console` 用 `initialProjectId` 选中该项目，若该项目不存在则回退到列表首项。
- `CODEESTRA_UI_DIST` 环境变量：UI 静态资产根可配置（打包安装与测试都需要），默认仍是 `apps/ui/dist`。
- 端到端测试 `apps/runtime/test/cli-open.test.ts`（Bun test，CLI 子进程 + 独立 temp home/仓库/资产）：断言 `open` 打印策略命令、项目出现在 `project list`（repoRoot 为规范路径）、URL 的 fragment 同时含 token 与 project 且 query 为空、host 为 `127.0.0.1`；断言无确认时**拒绝信任**且 `project list` 仍为空。

### 实际验证

- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：TypeScript 与 UI 类型检查通过、**212 项 Vitest** 通过、**164 项 Bun tests** 通过（含新增 5 项 `cli-open`）、UI Vite 构建成功、`bun audit` 无已知漏洞。
- `cli-open` 的 5 项断言覆盖：首次信任并预选、已确认时不再要求确认、main ref 前进但策略未变时仍不要求确认、策略文件变更后要求重新确认、无确认时拒绝信任且 `project list` 仍为空（stdin 为 /dev/null，任何多余的提问都会变成失败而不是挂起）。
- 真实注册（默认 `CODEESTRA_HOME`）：`codeestra open . --yes --no-open` 输出 URL 的 fragment 含本项目 id；`codeestra project list` 显示本仓库；`task verify` 的策略来源为 main ref 上的 `digest`。
- 该策略命令的实际可行性由真实 `task verify` 运行确认（见下条“剩余问题”中记录的耗时与网络依赖）。

### 剩余问题

- 验证副本没有 `node_modules`，所以 `install` 依赖网络（bun 缓存可加速）；离线环境会失败并记为 `COMMAND_FAILED`。后续可考虑“验证副本复用主仓库依赖”的可配置策略，但那会改变隔离语义，需先决策。
- 无 Integration 阶段：成果只在 `refs/heads/task/<task-id>`，需要人工 `git merge task/<task-id>`；main 提升的授权门禁仍未实现。
- `open` 只预选项目，不预选/创建任务；界面内建任务仍需手填规范。
- `confirmedPolicy` 目前随 `project.list` 逐个项目查询返回（项目数量级很小）；若项目数增长，应改成按需查询的命令。
- 验证策略变更（改 `.codeestra/policies/verification.json` 并提交）会使已确认的 digest 失效，需重新 `open`/`trust` 确认——这是 ADR-0006 的预期行为，但用户会看到“策略未确认”的拒绝。

## FOUNDATION-022 — 本仓库自举开发首次真实运行 + socket 大响应截断缺陷

状态：已在本仓库上真实跑通“打开 → 派发 → 审批 → 成果 commit → Task 验证”，并修复一个会让 CLI 与 UI 永久挂起的传输缺陷。

### 真实运行（本项目作为项目）

- `codeestra open .` 注册本仓库（`a2e9d7eb-…`，main `refs/heads/main`），UI 地址带 `project=` 预选；再次运行不再要求确认（已确认策略 digest 未变）。
- 任务 `#1`（`45357c5e-…`）：要求新建 `docs/notes/dogfooding.md`，**不得修改任何既有文件**。
- 真实模型 `deepseek/deepseek-flash`：4 次工具调用——`bash ls`（侦察）、`bash cat .codeestra/policies/verification.json`、`write docs/notes/dogfooding.md`、`bash git status + cat`（自检），共 4 次 gate 审批（全部经 CLI `attention answer … confirm yes` 批准），最终 `stopReason: stop`；**14,270 tokens**。
- 成果 commit `1fa3c91c`（`docs/notes/dogfooding.md`，hooks PASSED），落在 `refs/heads/task/45357c5e-…`；main 未改动。
- `task verify` **PASSED**：在结果 commit 的隔离副本里执行策略 `install`（0.1s，exit 0）与 `check`（30.1s，exit 0），证据绑定 testedCommit `1fa3c91c`/policyDigest `7d72c822`，副本已回收。

### 修复的缺陷（真实运行中发现）

`Bun.listen` 的 `socket.end(payload)` 只接受能放进 socket 缓冲区的字节——本机为 **8192**——其余既不再刷新也**不关闭连接**。最小复现：服务端 `socket.end(50_012 字节)`，客户端只收到 8192 字节且永不收到 close。

- 触发场景：`task verify` 的完整报告超过 8192 字节，**Runtime 已经跑完并把证据写进数据库，CLI 却永久挂起**（实测挂 20 分钟以上）；UI 的 `Verify task` 按钮同理。
- 修复：`apps/runtime/src/main.ts` 改为按背压写入——`queueWrite` 记录未接受的字节，listener 新增 `drain` 回调在缓冲腾空时继续 flush，`sendAndClose` 等全部字节送达后才 `end()`；事件订阅的帧与终止帧走同一路径，`onStop` 先 flush 再关闭。
- 回归测试 `apps/runtime/test/socket-response.test.ts`：断言 >8192 字节的响应完整送达（`task.list` 8 条长规范）并被解析、错误响应路径也会关闭连接；**用旧实现跑该测试失败**（`Connection closed with 8192 bytes and no complete response`），用修复实现通过。

### 实际验证

- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify`：类型检查（含 UI）通过、212 项 Vitest 通过、**166 项 Bun tests** 通过、UI 构建成功、`bun audit` 无已知漏洞。
- 真实复测：修复后重启 Runtime，`task verify` 从“永久挂起”变为 **31 秒返回完整报告**（install 0.1s / check 30.1s，均 exit 0，state PASSED）。
- 未执行：浏览器自动化验证（ADR-0008 测试边界）；UI 侧的等价行为由同一 HTTP/命令面覆盖。

### 剩余问题

- 每次 `task verify` 都会重跑整套策略（新的 commandId → 新运行），没有“同一 commit+策略已有新鲜证据则复用”的复用判定；策略 `check` 在此仓库约 30s，可接受但应记录。
- 模型/Provider 仍只是 Runtime 进程的环境变量，**切换模型必须重启 Runtime**（`stop` 后用带环境变量的方式重新 `open`）；UI 上不会显示当前模型。
- 成果仍在 `refs/heads/task/<task-id>`，需人工合并（Integration 阶段未实现）。
- 本轮为修复与验收额外产生了 4 条 verification 运行记录（同一 task/commit），未做清理；`prune`/失败现场回收仍未实现。

## FOUNDATION-023 — 固定 main/dev 双分支与稳定服务重启规则（ADR-0009）

状态：决策与开发指导已同步；本地 `dev` 已从当前本地 `main` 创建。自动 Integration/Promotion/重启编排尚未实现。

用户明确要求并补充确认：

1. 项目长期保留 `main` 与 `dev`；`main` 用于日常实际运行和开发辅助，`dev` 用于新功能实验。
2. 所有功能 Task/worktree 从 `dev` 建立基线，完成功能先经验证与 IntegrationBatch 进入 `dev`，不得直接进入 `main`。
3. `dev → main` 必须由用户批准固定 dev/main SHA 与验证证据；沿用既有一次确认门禁。
4. main 更新后立即在 main 工作树运行 `bun run codeestra stop`，再运行 `bun run codeestra status` 拉起并检查 Runtime；重启成功前不得报告提升完成。
5. 当前 `dev` 以本地 `main` 为初始基线，因此保留本地相对 `origin/main` 超前的 16 个提交。

### 修改

- 新增 Accepted ADR-0009，并标注其对 ADR-0001 D02/D03 的修订。
- 同步 `PROJECT_SPEC.md`、`AGENTS.md`、README、架构总览、Git Workspace Integration 设计与决策索引。
- 创建本地 `dev` 分支并切换到该分支；未 commit、未 push、未改动 `main` ref。

### 验证

- 文档检查与链接检查通过；`git branch --list` 同时包含 `main`、`dev`。
- 本轮仅修改文档与创建分支，未执行代码测试；现有 Phase 1 `task.run` 仍按项目 `mainRef` 创建 worktree，尚未落实 dev 基线。自动 dev Integration、dev→main Promotion 与 Runtime 重启编排仍属后续实现，不能声称已完成。

## FOUNDATION-024 — Web UI 中文化

状态：已完成。

### 修改

- 将 `apps/ui` 的导航、任务、待处理请求、事件流、项目接入、操作提示和客户端错误文案改为中文。
- 为任务、执行、会话、验证和待处理请求的常见状态增加中文显示名称，同时保留协议中的原始英文枚举值不变。
- 页面语言声明改为 `zh-CN`，时间使用中文区域格式。

### 验证

- `bun run --cwd apps/ui typecheck`：通过。
- `bun run --cwd apps/ui build`：通过。
- `git diff --check`：通过。
- 未执行浏览器自动化验证（遵守 ADR-0008 测试边界）。

## FOUNDATION-025 — 运行中 Agent 原生终端接管设计（ADR-0010）

状态：产品语义与架构设计已确认；无代码实现，真实 Pi 双向交接 spike 尚未执行。

用户选择：

1. 介入体验为 Provider 原生终端/TUI 完全接管，不接受把日志浏览或仿终端聊天框称作 attach。
2. 输入采用双通道：Session Guidance 立即指导当前 Agent但不改变验收规格；规格/约束变化必须显式生成 TaskRevision。
3. 生效时机为安全点立即转向：不 abort 已开始的工具，在当前工具与模型轮次结束后尽快交接。
4. Pi 当前 RPC 进程不能原地附着原生 TUI，因此采用安全点进程交接：确认 RPC 退出后以同一持久 conversation 启动 TUI/PTY，用户交还后再恢复 RPC。

已同步：

- 新增 Accepted ADR-0010，定义 Task-first CLI/Runtime 命令面、双通道语义、安全点竞态、RPC↔TUI successor Session、单 writer lease、detach/release 区别、权限模式 side channel 与 PTY 数据边界；ADR-0011 随后修订为 FULL 零确认、STRICT 保留 gate。
- 更新 PROJECT_SPEC、架构总览、Domain Model、状态机、Adapter API、Event Model、SQLite 逻辑设计、Pi spike 结论、Roadmap、README 与决策索引。
- 明确 `agent_sessions.execution_id UNIQUE` 在 Phase 3 要改为“历史多 incarnation、活动态部分唯一”；现有 schema version 7 和代码仍是单 Session，不能声称接管已实现。

效率成本：无新增审批；常态入口 `task takeover attach` 一条命令。相比 RPC steer，原生 TUI 首次接管需等待当前工具安全结束并完成一次 Provider 进程切换；这是避免双 writer/会话损坏的正确性等待，不是人为门禁。

验证：`git diff --check` 通过；检查 28 个 Markdown 文件，本地链接 0 断链；SQLite 文档 6 个 SQL block 在 Bun 内存库执行成功且 `foreign_key_check=0`。未执行接管代码测试，因为接管尚无代码实现。实现前必须用临时仓库与真实 Pi 依次验证 RPC 安全退出→同 session TUI resume→PTY detach/reattach→TUI 安全退出→RPC resume，并验证权限模式不因交接改变（FULL 零确认；STRICT 工具审批进入 Runtime 审计）。不得用 fake 或桌面自动化替代。

## FOUNDATION-026 — 默认全权限模式（ADR-0011）

状态：现有 Phase 1 门禁已切换为默认 FULL；STRICT 兼容模式保留。未来 Integration/Promotion 的零确认语义已写入规范，但对应阶段尚未实现。

已实现：

- 新 Runtime 无配置时默认 `FULL`；`permission get` 与 `permission set full|strict` 通过同一 Runtime 命令面查询/持久化，切换不确认，影响后续操作与新 Session。
- Pi FULL Session 使用 `--approve`，不传 `--tools` allowlist；Codeestra gate 对所有已注册工具（含未知名称、无 UI channel、不可序列化输入）直接允许。STRICT 保留原逐次审批、未知工具拒绝与工具 allowlist。
- FULL 项目 `open/trust` 不要求 TRUST 输入；STRICT 保留旧流程。Web UI 显示权限模式，FULL 隐藏 TRUST 输入。
- FULL verification policy 变化后直接执行；策略仍来自 main ref、经过严格 schema、在固定 commit 副本中运行并绑定证据。STRICT 保留 digest 确认。
- FULL 新增 `task result capture` 单步成果提交，并跳过敏感路径 deny policy；STRICT 保留 prepare + confirm 和敏感路径拒绝。Web UI 根据模式显示单步或两步流程。
- ADR-0011 显式修订 ADR-0001/0002/0003/0004/0006/0008/0009/0010 中冲突的确认要求；FULL 下未来 dev→main/Self Promotion 也不得新增批准，但固定 SHA/证据、归属、静止、幂等和重启等正确性检查继续有效。

效率成本：FULL 常态路径为 0 次确认、0 次确认等待；STRICT 是用户主动切换后的兼容路径。

验证：`nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify` 通过——212 项 domain Vitest、174 项 Bun tests、TypeScript/UI typecheck、Vite build、`bun audit` 无漏洞；另以临时 `CODEESTRA_HOME` 实测默认 FULL → set strict → 持久查询 STRICT → set full，`runtime.ping` 报告 FULL。补了本轮发现的一处诚实性缺陷：成果提交已释放 workspace 后再次 prepare 会明确拒绝（`NO_ACTIVE_EXECUTION` / `INVALID_EXECUTION_STATE`）且不留下 dangling ACTIVE 授权。未操作真实用户 ref，未使用桌面自动化。真实 Pi FULL 端到端工具执行尚未复验。

## FOUNDATION-027 — 失败原因结构化入库并在 CLI/Web UI 显示

状态：已实现并在命令面（CLI + Runtime HTTP/SSE 传输）验证。触发场景：用户在 Web UI 提交任务后只看到「失败」，没有任何原因。

### 背景（用户报告）

2026-09-13 用户从 Web UI 提交的两个任务（#3「继续开发」、#4「检查为什么失败」）都显示失败。真实原因是 Agent 侧：pi 0.84.4 以 provider `openai-codex` / model `gpt-5.6-sol` 启动后，assistant 轮次以 `stopReason: "error"`、`errorMessage: "Codex error: The usage limit has been reached"` 结束（Codex 用量接口确认 Plus 计划 5 小时窗口 100%）。Runtime 的行为**是正确的**（FOUNDATION-019 修复 #5 已按 stopReason 分类为 FAILURE），但原因只存在于 `ExecutionFailed` 事件的 `stopEvidenceRef` 字符串尾部和 pi session 文件里：`executions.error_json` 只有 `{"code":"AGENT_REPORTED_FAILURE"}`，`listTaskExecutions` 投影不读 `error_json`，UI 执行表也没有原因列。

### 用户本轮确认（数据语义选择题）

从「结构化 code+message 入库显示」「只投影事件链（不改入库语义）」「显示 code + 从证据串提取 turn 原因」中选定**结构化 code+message 入库并显示**。代价是 provider 错误原文进数据库；边界为适配器已截断到 160 字符、空白折叠为单行，且只在 FAILURE 时写入。

### 已实现

- `packages/contracts`：`completed` 观察事件新增可选 `failure: { code, message }`（`agentTurnFailureSchema`，strict）。仅描述 provider 侧分类，缺失表示适配器没有给出原因。
- `packages/agent-adapters`：`PiRpcAdapter` 在上轮 stopReason 分类为失败时一并发出 `failure: { code: 'PROVIDER_TURN_FAILED', message: <provider 原文> }`；成功轮次不带该字段。deterministic fake 支持透传 `failure`。
- `packages/storage`：`recordAgentCompletion` 接受 `failure`，FAILURE 分支把 `{ code: 'AGENT_REPORTED_FAILURE', message }` 写入 `executions.error_json`（无原因时退回只有 `code`，不编造 message），并把 `failure` 一并写入 `ExecutionFailed` 事件载荷（`stopEvidenceRef` 保留为审计证据链）。`ExecutionSummary` 新增 `error: { code, message? } | null`，由 `error_json` 经 Zod（`executionErrorSchema`）校验后投影；未知形状不编造原因。
- `apps/runtime`：`task.status` 原样返回该投影，因此 CLI 与 UI 无需新增命令语义；观察服务拒绝「`outcome: SUCCESS` 却带 failure」的自相矛盾事件（`INVALID_ADAPTER_EVENT`），不静默忽略。
- `apps/ui`：执行记录表新增「失败原因」列（code + provider 原文）；无原因显示 `—`。
- 失败但未产生 Session 的路径（`markAgentStartFailed`，例如 `PROVIDER_VERSION_UNAVAILABLE`）本来就把 `{ code, message }` 写进 `error_json`，现在同样通过投影暴露。

### 实际验证

- `bun run check`：TypeScript（Runtime/CLI）、UI 类型检查、212 项 domain Vitest、**176 项 Bun tests**（新增 1 项、扩充 3 项）、UI Vite 构建 全部通过。新增/扩充断言：provider 错误轮次带结构化 `failure` 且成功轮次不带；`SUCCESS`+`failure` 被拒绝且不投影（Session 保持 ACTIVE、`error` 仍为 null）；FAILURE completion 的 `error` 同时出现在 `task.status` 投影与 `ExecutionFailed` 事件载荷；预启动失败路径的 `error` 暴露；契约边界对 `failure` 的 strict 校验。
- **真实 provider 端到端（命令面）**：临时 `CODEESTRA_HOME=/tmp/ce-real-smoke-home` + 临时仓库 + 真实 Pi 0.84.4（默认 provider/model，未设 `CODEESTRA_PI_PROVIDER/MODEL`）。`task run` 后 pi 轮次以 `stopReason: "error"`（本轮为 `errorMessage: "fetch failed"`，沙箱 WebSocket 传输失败）结束，`task status` 返回 `taskState FAILED`、Execution `FAILED`、`error: { "code": "AGENT_REPORTED_FAILURE", "message": "error: fetch failed" }`；同一 Runtime 的 HTTP `/api/command`（`codeestra ui` 的 token）返回相同 payload，页面资产 200。两个任务均如此。
- 脚本 provider 端到端（同一命令面、可复现的 quota 文本）：临时 `CODEESTRA_HOME=/tmp/ce-err-smoke-home` + `CODEESTRA_PI_EXECUTABLE` 指向一个按 RPC 协议应答 `get_state`/`prompt` 并发出 `message_end(stopReason=error)` + `agent_settled` 的脚本，`task status` 返回 `error.message = "error: Codex error: The usage limit has been reached"`。**这是协议/编排替身，不是真实 Agent 集成证据**；同一路径的真实 provider 证据见上一条。
- 未执行：真实 Codex quota 报错复测（额度仍为 100%，`task run` 会立刻失败但该请求走 WebSocket，本沙箱下表现为 `fetch failed`）；浏览器截图/桌面自动化（遵守 ADR-0008，UI 渲染仅由类型检查 + Vite 构建覆盖，视觉确认留给用户）。
- 未触碰用户 ref：全程只在临时仓库与临时 `CODEESTRA_HOME` 上运行；稳定 Runtime（pid 75937，`~/Documents/codeestra`）仅做只读查询，未停止、未改动。

### 剩余问题

- provider 错误原文现在会入库（≤160 字符、单行）。这与 FOUNDATION-019 记录的「Attention `prompt_json` 是否摘要化」是同一类未决问题，后续可一并决定。
- 历史 Execution 的 `error_json` 里没有 message（旧代码写入），升级后这些执行只显示 `AGENT_REPORTED_FAILURE` 而无原文；不回溯改写历史。
- 排查过程用的 `/tmp/ce-err-smoke-home`、`/tmp/ce-real-smoke-home` 及其临时仓库已停止 Runtime，目录保留（可随时删除）。
- UI 的失败原因列较长时只做了自适应换行，未做折叠/详情展开；长 provider 文本仍以表格单元格展示。

## NEXT — 最小可用纵向切片

0. 落实 ADR-0009 的 dev 基线：项目快照/Workspace 从 dev OID 建立，先补临时仓库测试；在此之前产品内 `task.run` 仍使用 mainRef，不能用于声称符合新分支规则。
1. Task cancel（协作停止 + 超时转人工并保留资源）：已有一个被真实场景证明的卡死形态（RUNNING + `NOTHING_TO_COMMIT` + `resource_held=1`）。
2. 长命令后台化与进度事件：让 `task.run`/`task.verify` 成为持久 Operation，界面可展示进度并允许取消。
3. ADR-0010 Phase 3 技术 spike：真实 Pi session-file 双向 RPC↔TUI 恢复、PTY 生命周期、safe-point 与权限模式 side channel；通过后再落 handoff Operation、Session incarnation 和 CLI attach。
4. revision 投递确认，以及 Runtime 重启后对 stale ACTIVE Session 的启动 reconcile。
5. 验证副本与失败现场的回收：明确的 `prune`/归属校验与可追溯记录；同时决定 Attention 工具参数是否入库/摘要化。
