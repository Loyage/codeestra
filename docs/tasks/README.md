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

## FOUNDATION-028 — Agent 配置（模型、Provider、思考深度）

状态：已实现并在 CLI/命令面验证（含一次真实 Runtime + 协议 stub provider 的端到端 smoke）。决策记录为 ADR-0012。真实模型下按新配置启动尚未验收。

背景：FOUNDATION-022 已记录“模型/Provider 只是 Runtime 进程环境变量，切换必须重启 Runtime，UI 不显示当前模型”。本轮补齐该能力。

用户本轮选择题（记录为 ADR-0012）：

1. 作用域：**全局默认 + 每项目覆盖**（未选：全局单份 / 每任务覆盖 / 三层）。
2. 可配置项：**provider + model + thinking level**（未选：再加 `--models` 轮换、再加自由额外 argv）。
3. 生效与留痕：**仅新 Session 生效 + 记录到 Execution**（未选：不写执行历史、快照进 TaskRevision）。
4. 配置来源：**持久化配置 + 环境变量为高优先级覆盖**（未选：env 仅作首次默认、只用持久化配置）。

### 已实现

- `packages/contracts`：新增 `thinkingLevels`/`agentConfigurationSchema`，以及 `agent.config.get` / `agent.config.set` / `agent.config.clear` 三个命令；`AgentStartRequest` 新增可选 `agentConfig`。`set` 用「缺省=不变、`null`=清除」区分两种意图，并导出 Pi 的环境变量名映射。
- `packages/storage`：schema v7→v8 纯新增迁移——`agent_configurations`（作用域 CHECK + 两个部分唯一索引，GLOBAL 每 Adapter 一条、PROJECT 每项目每 Adapter 一条）与 `executions.agent_config_json`（可空、JSON 校验）；`setAgentConfiguration` 按字段合并、全空即删除记录，`clearAgentConfiguration` 返回是否删除；`reserveExecution` 写入生效配置，`listTaskExecutions` 与 `agentStartRow` 投影为 `agentConfig`（形状非法时不编造，返回 `null`）。旧 Execution 该列为 NULL，不回溯改写。
- `apps/runtime`：新增 `agent-config-service`，逐字段按 环境变量 > 项目 > 全局 > 适配器默认 解析并给出每字段 `sources`；空白的 `CODEESTRA_PI_*` 视为未设置，非法 `CODEESTRA_PI_THINKING` 报 `INVALID_AGENT_CONFIGURATION` 而不是静默回退；`GLOBAL`/`PROJECT` 与 `projectId` 的一致性由 Runtime 在写入前校验（契约无法表达）。`task.run` 在预留 Execution 之前解析配置，因此记录值与启动值同源。
- `packages/agent-adapters`：注册表不再把环境里的 provider/model 写死进进程参数；`PiRpcAdapter.start` 依据 `request.agentConfig` 生成 `--provider` / `--model` / `--thinking`，未设字段不传 flag，stop evidence 摘要包含模型参数。
- CLI：`agent config get|set|clear [--project <id>] [--adapter <id>]`，`set` 支持 `--provider` / `--model` / `--thinking` 与 `--unset provider|model|thinking`；`get` 直接输出 Runtime 的 `effective` 与 `sources`。
- Web UI：新增「Agent 配置」标签页（生效值 + 来源、环境覆盖说明、编辑项目/全局作用域、保存/清除），执行记录表新增「模型/思考」列。UI 不自行计算优先级，只投影同一命令面，未新增任何门禁。

### 实际验证

- `nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just -c just verify` 通过：TypeScript（Runtime/CLI）与 UI 类型检查、**212 项 Vitest**、**196 项 Bun tests**（新增 20 项）、UI Vite 构建、`bun audit` 无已知漏洞。
- 新增/扩充断言：契约边界（默认 adapterId、缺省与 `null` 区分、7 个 thinking 等级、非法值/空值/未知字段/非 UUID 项目）；存储（v7→v8 迁移与 `foreign_key_check`、作用域独立、部分更新合并、全空删除、非法 thinking 被 schema 与列约束双重拒绝、Execution 记录与 NULL 语义）；解析（默认/项目继承全局/环境覆盖最高且 `sources` 正确/空白变量/未知 Adapter/非法环境 thinking）；Adapter argv（配置存在时三个 flag 均出现，无配置时均不出现）；注册表不再把 env 模型写进 argv。
- CLI 端到端（真实 CLI 子进程 + 独立 `CODEESTRA_HOME` + 临时仓库）：初始默认 → 全局 set → 项目 set 仅覆盖指定字段 → `clear --project` 回落全局 → `--unset` 单字段 → `CODEESTRA_PI_MODEL` 使 `sources` 变 `ENVIRONMENT` → 非法 thinking 与不存在的项目被拒绝。
- **真实 Runtime + 协议 stub provider smoke**（`CODEESTRA_PI_EXECUTABLE` 指向按 RPC 协议应答的脚本，记录自身 argv）：`agent config set --model deepseek-flash --thinking high` 后 `task run`，provider 实际 argv 末尾为 `--model deepseek-flash --thinking high`，`task status` 的 Execution 记录 `agentConfig: {"model":"deepseek-flash","thinkingLevel":"high"}`。**该 stub 是协议/编排替身，不构成真实 Agent 集成证据。**
- 未执行：真实模型/Provider 下按新配置的 `task.run`（本轮未消耗真实额度）；浏览器/桌面自动化（ADR-0008）。未触碰用户仓库与用户 ref：全部在临时仓库与临时 `CODEESTRA_HOME` 上运行（smoke 目录 `/tmp/codeestra-agentcfg-smoke.WCgxk4`，可删除）。

### 剩余问题

- 模型/Provider 取值不在 Codeestra 侧校验（没有模型目录就不假装有）：写错时由 Pi 在启动时报错，按既有失败路径记录，不静默降级。若要做模型选择器，需要单独决定是否以及如何解析 `pi --list-models`。
- 配置是环境级而非 TaskRevision 级：同一 revision 在不同配置下重跑会产生不同配置的 Execution 记录；要复现“完全相同的一次执行”需同时固定两者。这由 ADR-0012 明确接受，不在未确认前改成 revision 快照。
- 环境变量覆盖若在用户 shell 中残留，会一直压过持久化配置（CLI/UI 会显示 `sources: ENVIRONMENT`，可解释但不阻止）。
- 未提供 `agent config list`（查看所有项目的覆盖）：当前 `get` 每次只回答一个作用域，项目数量级很小；若增长再按需添加。

## FOUNDATION-029 — 只读 Agent 执行过程视图（Web UI + CLI）

状态：已实现并在命令面（真实 CLI 子进程 + 临时 `CODEESTRA_HOME` + 协议 stub provider 写出真实形状的会话文件）与 HTTP 传输上验证。决策记录为 ADR-0013。**真实模型下的 UI 目视确认尚未做（需用户在场）。**

### 背景与用户本轮确认

用户要求“在 Web UI 看到 Agent 执行过程的详细内容”。现状是 UI 的「事件」页只有 domain event 元数据：看不到 Agent 说了什么、调用了哪些工具、工具返回了什么、花了多少 token。

四题确认（选项均为推荐项，已写入 ADR-0013）：

1. 数据来源：**读取 Pi 的持久 session 文件**（未选：把 RPC 事件投影入库实时推送 / A+B 组合 / 完整 PTY 原生终端接管）。
2. 内容：**工具调用与返回 + 助手文本 + thinking + token 用量与成本**（全选）。
3. 敏感内容：**截断展示 + 可展开全文**（未选：原样全量 / 只显示元数据 / 按类型脱敏）。
4. 实时性：**运行中自动刷新（增量轮询）**（未选：新增 SSE 帧 / 手动刷新 / 只做历史回看）。

### 已实现

- `packages/contracts`：新增 `session.transcript`（`afterEntryId` 排他游标 + `limit` ≤200）与 `session.transcript.part`（取回单个完整内容块）两个只读命令，以及共享视图类型 `SessionTranscriptEntry`/`SessionTranscriptPart`/`SessionTranscriptUsage`/`SessionTranscriptView`/`SessionTranscriptPartView` 与边界常量（预览 4000 字符、单块硬上限 200000）。
- `packages/storage`：新增 `getSessionTranscriptTarget(sessionId)`：由 Session 反查出 project/task/attempt/执行与会话状态以及 **provider 会话文件路径**（仅 Runtime 可见）。与 `getObservableAgentSession` 不同，已结束的 Session 也可读——transcript 是历史投影，不要求 live 可观察。
- `apps/runtime/src/session-transcript-service.ts`：流式逐行读取 provider JSONL，归一条目（user / assistant / toolResult / model_change / thinking_level_change / 其他），丢弃 `thinkingSignature` 等 provider 回放产物，保留 `usage`（含 `totalTokens` 与 `cost.total`）与 `stopReason`；`SESSION_FILE_NOT_OWNED`/`SESSION_FILE_UNREADABLE`/`TRANSCRIPT_CURSOR_UNKNOWN`/`TRANSCRIPT_ENTRY_UNKNOWN`/`TRANSCRIPT_PART_UNKNOWN` 为稳定错误码。未知条目类型、未知消息角色与无法解析的行都显式报告（`note`/`unparsedLines`），不静默丢弃。
- 路径归属：只允许 Runtime 自己的 Pi session 目录（`CODEESTRA_PI_SESSION_DIR` 或 `<CODEESTRA_HOME>/pi-sessions`，即 `adapter-registry` 新增的 `piSessionDirectory()` 单一来源）内的普通文件；判定在 `realpath` 后的规范路径上做，因此配置目录位于符号链接下（macOS `/tmp`）仍可读，而目录内指向外部的符号链接被拒绝。Runtime 是唯一读者，**不把文件路径回传给客户端**。
- `apps/runtime/src/main.ts` 接入两个命令；`apps/cli/src/main.ts` 新增 `task transcript`（组合 `task.status` 解析 Session，不新增第二条语义路径）、`session transcript`、`session transcript part`，默认人类可读渲染（工具名/参数/输出/thinking/用量），`--json` 输出原始视图。
- `apps/ui`：任务详情新增「Agent 执行过程」面板，按 Execution 选择（默认最新一个真的启动过 Session 的尝试），展示工具调用/返回、助手文本、thinking、token 与成本；长内容折叠、点“展开全文”经 `session.transcript.part` 取回完整块；运行中每 1.5s 增量读取（以最后一个 entry ID 为游标），游标失效时明确提示并从头重读一次；Session 已 `EXITED` 即停止轮询（Execution 在成果 commit 前仍持资源，但文件不会再变）。

### 实际验证

- `bun run check`：TypeScript（Runtime/CLI）、UI 类型检查、212 项 domain Vitest、**207 项 Bun tests**（新增 11 项）、UI Vite 构建全部通过。
- 新增 9 项服务单测：真实 Pi 会话文件形状的归一化（thinking 签名丢弃、toolCall 参数、`totalTokens`/`cost.total` 映射、toolResult 的 `isError`、未知条目类型的 `note`、1 行非法 JSON 计入 `unparsedLines`）；排他游标分页不重不漏与 `hasMore`；截断预览与 `session.transcript.part` 返回同源完整内容；单块超过硬上限时报 `truncated:true` 且 `fullChars` 为真实长度；未知游标 `TRANSCRIPT_CURSOR_UNKNOWN`；未知 entry/part 的稳定错误码；文件缺失/未记录路径返回 `fileAvailable:false` 与说明；目录外路径、目录内符号链接逃逸、非普通文件全部 `SESSION_FILE_NOT_OWNED`；配置目录位于符号链接下仍可读（macOS `/tmp` 回归）。
- 新增 2 项 CLI 端到端（真实 CLI 子进程 + 独立 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider 写出真实形状会话文件）：`task transcript --json` 与人类可读输出（含 `TOOL_CALL write` 与工具输出）、`session transcript --after` 续读、`session transcript part` 展开、不存在 Session 的退出码 1；以及**直接篡改数据库**把 `session_storage_ref` 指到目录外后 `task transcript` 必须 `SESSION_FILE_NOT_OWNED` 且不把该路径回显给调用方。
- HTTP/SSE 传输（Web UI 实际使用的路径）头less 实测：无 token / 错 token 均 401，`session.transcript` 与 `session.transcript.part` 返回与 socket 相同的结果，`events.subscribe` 仍为 `NOT_AVAILABLE_OVER_HTTP`(400)。
- 临时 `CODEESTRA_HOME` 上的 CLI smoke：`task transcript` 人类可读输出正确显示模型切换、任务输入、assistant 的 thinking+toolCall+usage、8400 字符的工具返回预览与“已截断”提示，并给出完整块的获取命令；`session transcript part` 取回 8400 字符且 `truncated=false`；`--after` 续读不重不漏；未知游标退出码 1。smoke 目录与临时 home 已删除。

### 未执行 / 剩余问题

- **未用真实模型端到端做 UI 目视确认**（ADR-0008 禁用桌面/浏览器自动化），渲染正确性由类型检查 + Vite 构建 + HTTP 断言覆盖，视觉确认留给用户；本机稳定 Runtime 未被触碰（全部在临时 `CODEESTRA_HOME` 上运行）。
- 粒度是 provider 写入会话文件的粒度（一条消息一次），不是 token 级流式；需要 token 级实时就要做 ADR-0013 选项 B（新增事件与保留策略），未预先承诺。
- 该视图会展示工具参数与工具输出（可能含密钥、大段文件内容），缓解手段是客户端截断与按需展开、以及 Runtime 不持久化；没有脱敏规则。这与 FOUNDATION-019 记录的 Attention `prompt_json` 入库问题是同一类未决问题。
- 该面板是观察而非控制：运行中的任务不能从这里发 guidance 或接管终端；那是 ADR-0010 的范围。
- `usage`/`cost` 是 provider 自报值，Codeestra 不做计费校验。
- Session file 被 provider 重写（而非追加）时会让已发出的游标失效；面板已明确提示并从头重读一次，但没有跨“文件被替换”的稳定历史。

## FOUNDATION-030 — Agent 结构化提问通道（ADR-0014）

状态：已实现并在 CLI/命令面（含 Runtime socket 与 HTTP 同一 dispatch）验证；**真实 Pi 0.84.4 + 真实模型的一次性探针已确认扩展在受控启动下可加载、可注册、可往返**，但真实模型经 Runtime 的完整 `task run` 与 UI 目视确认尚未做。

背景（用户报告）：pi 的 `@juicesharp/rpiv-ask-user-question` 与 Codeestra 配合得不好。查明的原因不是扩展写得不好，而是三件结构性事实：受控启动 `--no-extensions` 从不加载它；即使实测加载，一份问卷会变成 N 个 `select` dialog（N 条 Attention、N 次 `WAITING_FOR_USER`、N 次 CLI 往返）；而且 RPC 路径下选项被编码成 `"2. bun — …"` 字符串，回答只要不是整数序号（例如 `banana`）就被当成 Esc，**整份问卷作废**且模型只看到 `User declined to answer questions`，Codeestra 侧那些 Attention 却已是 `DELIVERED`。

用户本轮选择题（记录为 ADR-0014）：

1. 痛点：**Agent 根本问不了**（未选：能问但答起来很坑 / 两者都要）。
2. 方向：**Codeestra 自有问卷工具**（未选：直接加载第三方 rpiv + 只改呈现 / 不加工具纯提示词约定）。

### 已实现

- `packages/contracts/src/questionnaire.ts`：结构化问卷契约（1–4 题、每题 2–4 个带描述选项、`multiSelect`、每题自由文本）、存储用 `prompt` 判别形状、回答 schema、唯一一份校验规则（越界/重复题号/重复选项/单选多选），错误文案按用户在界面看到的 1 基编号；dialog title 编解码（`CODEESTRA_QUESTIONNAIRE:v1:<json>`）与回答 payload 编解码。`agentAnswerSchema` 新增 `{ type: 'QUESTIONNAIRE', answer }`：结构化回答是它自己的类型，不是一段字符串。
- `packages/agent-adapters/src/pi-question-extension.ts`：Codeestra 自己的扩展，注册同名工具 `ask_user_question`（promptSnippet/promptGuidelines 告诉模型何时问、一次问完）。无 UI、参数非法、回答读不懂三种情况分别返回可区分的错误；**读不懂不是拒绝**。它只依赖 `@codeestra/contracts`，在真实 pi 进程内加载已实测。
- `pi-rpc.ts`：`buildPiRpcArguments` 现在加载 gate + question 两个 Codeestra 扩展（仍是 `--no-extensions`），STRICT 的 `--tools` 增加该工具；问卷 title 被解码成 `prompt.kind = "codeestra.questionnaire"` 的**单条** `QUESTION` Attention；`QUESTIONNAIRE` 回答在 Adapter 里被编码成 provider dialog 接受的字符串（线格式属于 Adapter）。
- `pi-gate-extension.ts`：`ask_user_question` 在 STRICT 下也无需审批（它只读用户意图，不产生副作用）。
- `apps/runtime`：`adapter-registry` 解析 `CODEESTRA_PI_QUESTION_EXTENSION`（默认仓库内扩展）；`attention.answer` 在**记录任何东西之前**按被问的那份问卷校验，失败返回 `INVALID_QUESTIONNAIRE_ANSWER:<PROBLEM>` / `NOT_A_QUESTIONNAIRE`，状态不动。
- `packages/storage`：`StoredAgentAnswer` 改为直接引用契约类型（删掉了手抄的第二份 answer union），`planAttentionAnswer` 额外要求「结构化回答只能落在真正带问卷 prompt 的 VALUE Attention 上」（含 `json_extract` 判别）；新增 `getAttentionRequest` 供上述前置校验。
- CLI：`attention answer` 新增 `--choose <题>:<选项>[,<选项>]`、`--text <题>=<文本>`、`--cancel`，原有 `confirm/value/cancel` 位置参数不变；契约硬上限在 CLI 拦，具体题目范围在 Runtime 拦。
- Web UI：问卷渲染为单选/多选 + 每题自由文本（二选一互斥），提交发送结构化回答。
- 健壮性附带修复（原代码会把执行打断）：`mapPiExtensionUiRequest` 对未知 `extension_ui_request` method 不再抛 `PiRpcProtocolError`（未知 method 忽略；字段不匹配的 dialog 按可回答的问题降级上报，既不挂住 Agent 也不中断执行）。

### 实际验证

- `bun run check`：TypeScript（Runtime/CLI）与 UI 类型检查、**212 项 Vitest**、**224 项 Bun tests**（较上一轮 207 新增 17 项：契约 6、扩展 7、Adapter 2、CLI 端到端 2）、UI Vite 构建全部通过。
- 命令面端到端（`apps/runtime/test/cli-attention.test.ts`，协议 stub provider —— **不是真实 Agent 集成证据**）：`task run` 阻塞 → `attention list` 出现一条带 `codeestra.questionnaire` 的 Attention（整份问卷一条）→ `--choose 1:9` 被 CLI 拒绝、`--choose 1:3` 被 Runtime 以 `INVALID_QUESTIONNAIRE_ANSWER:CHOICE_INDEX_OUT_OF_RANGE` 拒绝且 Attention 仍为 `OPEN` → `--choose 1:2 --choose 2:1,2` 被接受、投递，stub 收到精确的结构化 payload，`task run` 退出码 0、Session `EXITED`。对照用例：dialog 标题是普通文本时，结构化回答被 `NOT_A_QUESTIONNAIRE` 拒绝，而原始 `value` 路径仍可用。
- **真实 Pi 0.84.4 + 真实模型探针**（一次性脚本 `/tmp/rpiv-probe/probe5.ts`，非仓库内测试）：用与 Codeestra 完全相同的 argv 启动真实 `pi`，让它调用 `ask_user_question` 提两个问题——只产生**一个** `extension_ui_request`，title 为 `CODEESTRA_QUESTIONNAIRE:v1:…`；以编码回答响应后工具返回 `The user answered 2 of 2 questions.` 并逐题列出所选与所写内容。
- 未执行：真实模型经 Codeestra Runtime 的完整 `task run`（会消耗真实额度）；浏览器/桌面自动化（ADR-0008 测试边界）。全程未触碰用户 ref，稳定 Runtime 未被干扰。

### 剩余问题

- **散文提问仍未识别**：模型不用工具、而是结束轮次在正文里问问题时，Codeestra 仍会把它记为 `SUCCESS`。这是本次报告痛点的另一半，需要单独决定（识别 + 恢复会话）后才能声称解决。
- 问卷对话没有 rpiv TUI 的 Tab 栏、Submit 复核页、逐题备注与并排 preview；这些是原生宿主 dialog 的能力，Codeestra 的选择是 CLI/Web UI 而不新增宿主语义。
- `attention_requests.prompt_json` 现在承载结构化问卷（Codeestra 生成、受控，非 provider 原文），与 FOUNDATION-019 记录的「Attention prompt 是否摘要化」是同一类未决问题。
- 问卷的 `waiting` 没有超时：没人回答就一直 `WAITING_FOR_USER`（与既有 Attention 行为一致）；取消仍靠人显式 `--cancel`。
- `packages/storage` 现在正式依赖 `@codeestra/contracts`（bun.lock 随之更新）。

## FOUNDATION-031 — dev → main 稳定提升（结构化提问通道，ADR-0009/0014）

状态：已提升并在 main 工作树重启验证 Runtime 恢复响应。用户本轮明确授权 commit 并合并到 main。

提升记录（ADR-0009 要求的固定 SHA / 权限模式 / 验证证据）：

| 项 | 值 |
|---|---|
| 权限模式 | `FULL`（默认；ADR-0011 下无批准步骤） |
| 提升前 main | `714e9e426aaee69424ceb3d804f9a5ddc2293eb5` |
| 被提升的 dev 提交（实现提交） | `8a52a37c547067d83f6f9b40080b9749d6f4e548`（feat(runtime): structured Agent question channel (ADR-0014)） |
| 验证证据 | 在该提交上工作树干净；`bun run check` 退出码 0——TypeScript（Runtime/CLI）与 UI 类型检查通过、**212 项 Vitest**、**224 项 Bun tests**、UI Vite 构建成功；`bun audit` 无已知漏洞 |
| 提升方式 | main 工作树内 `git merge --ff-only dev`（`main` 被检出在 `~/Documents/codeestra`，不得用 `update-ref` 直接推进） |
| 取消/回滚 | 未执行任何回滚；未 push；未触碰用户仓库与 ref |

提升后的后续步骤（缺一不可，否则 stable Runtime 跑不起来）：

1. main 工作树 `bun install --frozen-lockfile`——本轮新增 `packages/storage` → `@codeestra/contracts` 依赖，缺该链接时 stable Runtime 会在导入 storage 时直接失败（已实际确认：安装前该链接不存在）。
2. main 工作树 `bun run build:ui`——`apps/ui/dist` 是 gitignore 的本地资产，不重建则 UI 仍是旧版（无问卷表单）。
3. `bun run codeestra stop`：旧 Runtime pid `65678` 在 3 秒内退出。
4. `bun run codeestra status`：新 Runtime pid `64518` 返回 `status: READY`、`permissionMode: FULL`、`adapters: ["pi"]`、`activeSessions: []`。**Runtime 恢复响应后**才在本条声明提升完成。
5. 已校验 main 工作树里 `packages/agent-adapters/src/pi-question-extension.ts` 存在、默认解析路径指向该文件、且 `packages/agent-adapters/node_modules/@codeestra/contracts` 链接可解析（扩展在 provider 进程内靠该链接加载契约）。

资源回收（归属校验后执行，不属于本轮改动但已记录）：

- 本轮命令面端到端测试残留的协议 stub 与临时 Runtime：pid `5568`（`/tmp/codeestra-question-tools-*/stub-pi.ts`）、pid `5459`（其临时 `CODEESTRA_HOME` 已被测试清理）。已 SIGTERM。
- 上一轮（FOUNDATION-029）遗留的 transcript smoke Runtime：pid `41447`，`CODEESTRA_HOME=/private/tmp/ce-transcript-smoke.gIHmeF/home`，临时目录，SIGTERM 未退出后 SIGKILL。经归属核对确认它不连着任何用户数据。
- 未触碰 stable Runtime（pid `65678`）以外的用户状态，且它已按 ADR-0009 流程被主动重启为新 pid `64518`。

本记录提交随后以同样的 `--ff-only` 方式提升到 main，因此 `main` 与 `dev` 在本条写完后再次相同；以 `git rev-parse main dev` 核对，本条不写死自身 OID。

## FOUNDATION-032 — 任务工作台与深浅主题（ADR-0015）

状态：前端已实现；类型检查、CLI/HTTP 命令面回归与构建资产 smoke 通过。**浏览器视觉、键盘操作与窄屏效果尚待用户人工确认**，不把命令面验证等同 UI 渲染验收。

用户本轮明确选择「任务工作台重构」和「深浅主题可切换」，记录于 ADR-0015。

### 已实现

- `apps/ui/src/App.tsx`、`styles.css`：侧栏导航、项目任务概况、搜索/状态筛选、双栏任务列表与详情；窄屏转单栏。草稿创建后选中（用户未在等待期间切走时），不自动提交/运行；同一项目中切换导航保留草稿输入。
- 任务详情集中显示下一步、状态适用的现有操作、当前任务问卷、只读执行过程；执行与验证表格、原始响应折叠，最近验证状态和绑定 commit 单独显示。没有新增取消、暂停、自动集成或发布能力。
- 主题组件 `theme.tsx`：默认跟随系统，可选浅色/深色；本地存储不可用不阻止本次切换。统一语义色、焦点样式、字段标签、错误/忙碌提示、窄屏表格横向滚动。主题是浏览器呈现偏好，不进入 Runtime 数据。
- `use-pending-action.ts`：按任务、创建动作或问题等局部对象防重复点击；不使用全局忙碌状态禁用回答。问卷 radio 使用独立表单 ID，避免同名题目跨问卷互相干扰。
- 数据刷新：切项目即清旧列表/详情，异步详情按选择与请求序号核对；列表更新保留较新状态版本，事件同时刷新列表与选中详情。选择新任务清除旧授权/局部运行响应/验证报告；STRICT 授权仍检查任务版本，不复用别的任务授权。
- 项目页合并仓库与策略两个只读检查；修改路径清除旧检查结果。保留 FULL 原有零确认与 STRICT 的 TRUST；Agent 配置保存期间保护表单不被并发修改。
- `transcript.tsx`：手动刷新与轮询不并发读同一游标，结束时补读最后一页；历史会话提供「加载后续记录」，不再把后续内容误称为更早的记录。

### 实际验证

- `bun run check`：Runtime/CLI 与 UI TypeScript、**212 项 Vitest、225 项 Bun tests**、Vite 构建全部通过（0 fail）。新增命令面测试使用 Web UI 自身 `RuntimeClient`，在独立 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider 上验证：等待回答期间可创建/读取另一草稿；草稿没有自动执行；未提交成果不能验证；非法问卷答案保留 OPEN；合法选项/自由文本可投递；Session 退出后 Task 仍为 RUNNING，不能冒充成果提交或验证通过。
- 首轮检查新增测试失败：测试错误地假定 `task.run` CLI 退出就意味着 provider 已退出（实际可能先返回 WAITING_FOR_USER）。改为通过 `task.status` 有界等待独立完成投影后，重新运行完整检查通过；没有改变 Runtime 状态语义。
- `/tmp/codeestra-ui-assets-smoke.ts`：通过 dev CLI 在临时 home 启动独立 Runtime，验证实际构建 HTML/JS/CSS 均 HTTP 200、工作台/主题内容包含于资产、无令牌命令 401、有令牌 `project.list` 返回空项目集。结束后停止该临时 Runtime 并回收其 home。
- `git diff --check` 通过。未操作浏览器/桌面，未调用真实模型，未声称 stub 能证明真实 Agent 验收。

### 交付边界

- 新增 ADR-0015、同步决策索引与本任务记录；**未修改 `PROJECT_SPEC.md` 或 `AGENTS.md`**。
- 本轮实现已提交为 `548e45627941d5e1013423bdf1fef2b87426b492`，并按用户授权在 main 工作树以 `git merge --ff-only dev` 完成提升；未 push。`main` 与 `dev` 当前同一 SHA。
- 提升后在 main 工作树执行 `bun install --frozen-lockfile`（无变化）、`bun run build:ui`，随后执行 `bun run codeestra stop` → `bun run codeestra status`；Runtime 已恢复 `READY`（PID `92408`、`FULL`、`adapters: ["pi"]`、`activeSessions: []`）。
- 仍需人工确认：主题切换与系统变化、窄屏、焦点顺序、快速切项目/任务、问卷回答、终态执行过程分页。长命令后台化、取消/暂停、原生接管及 Integration/main 后续能力继续属于 NEXT，不在本轮提前实现。

## FOUNDATION-033 — Task 暂停 / 终止 / 归档（ADR-0016）

状态：CLI/命令面与 Web UI 已实现并通过命令面测试；未做真实 provider 的暂停/恢复端到端复验，不声称真实取消超时已验收。

用户本轮明确选择（记录于 ADR-0016）：1) 暂停 = 暂停运行中的执行（协作停止 + 确认静止，恢复时新建 Execution 复用 provider conversation）；2) `CANCELLED` 为终态，重开必须新建任务；3) 删除 = 归档软删除并保留 worktree/branch；4) CLI 与 Web UI 同批。

### 已实现

- 新增命令面：`task.pause` / `task.resume` / `task.cancel` / `task.archive` / `task.unarchive`（CLI + HTTP 走同一 Zod 命令面）。`task list` 增 `includeArchived`（默认隐藏归档），`task list --all` 显式包含；`task status` 按 ID 仍可读归档任务。
- schema v9：`tasks.archived_at`、`executions.resume_from_execution_id`，并重建 `executions` 以把 `stop_reason` CHECK 扩为 `USER_CANCEL|USER_PAUSE|REVISION_RESTART|SHUTDOWN`；v8→v9 保留既有行且 `foreign_key_check` 无违规。
- 终止：无活动 Execution 的状态直接 `CANCELLED`；有活动 Execution 的状态先 `CANCELLING` 并把 Execution 置 `STOPPING (USER_CANCEL)`，Adapter 确认自有进程退出后才落 `CANCELLED`、`resource_held=0`、workspace `RETAINED`；未确认则 `RECOVERY_REQUIRED` 并保留全部占用。
- 暂停/恢复：`PAUSING → PAUSED`（Execution `SUPERSEDED (USER_PAUSE)`、Session `EXITED`、workspace 保留）；`task resume` 在同一 retained worktree 上 `PAUSED → READY`，新建 Execution 并以 `--session <file>` 复用前任会话，启动消息是有界的继续指令而非重发规格；新 Execution 记录 `resume_from_execution_id`。
- 归档：只写 `archived_at`，不删除任何 Task/Revision/Execution/Session/事件行，也不回收 worktree/branch；活动 Execution（`RUNNING/PAUSING/PAUSED/WAITING_FOR_USER/CANCELLING`）或 `RECOVERY_REQUIRED` 时拒绝归档；重复归档幂等。
- Web UI：任务详情新增暂停/继续/终止/归档/取消归档按钮与「显示已归档」开关；UI 仍只投影同一命令面，`task.list` 以 `includeArchived: true` 读取后由前端开关控制展示，不新增 Runtime 语义或确认。

### 实际验证

- `bun run check`：TypeScript（Runtime/CLI）与 UI TypeScript、**212 项 Vitest**、**239 项 Bun tests**、UI Vite 构建全部通过（0 fail）。
- 新增命令面/存储测试：v8→v9 迁移保留行且拒绝非法 `stop_reason`；归档不销毁行、默认列表隐藏、幂等、活动任务拒绝；`READY` 直接终止且不重开；运行中终止在确认后 `CANCELLED`（`resource_held=0`、workspace `RETAINED`）；暂停后恢复复用同一 workspace、新 Execution 携带 `resume_from_execution_id` 且 Adapter 收到 `resume.sessionStorageRef`；停止不可确认时 `RECOVERY_REQUIRED` 并保留占用。
- 新增 CLI 测试（真实 Runtime + 临时 Git 仓库，无 provider）：`task cancel` 终态与重复执行的幂等、`task archive/unarchive` + `--all`、过期 version 返回 `CONCURRENT_MODIFICATION` 且退出码 1。
- 新增脚本 Adapter 测试覆盖 pause/resume/cancel 的命令编排；**脚本 Adapter 不证明真实 Pi 进程已静止**，真实 provider 的暂停/恢复与取消超时仍需一次性临时仓库中有人在场时复验。
- 未使用桌面/键鼠自动化；浏览器视觉与键盘操作仍待用户人工确认。

### 交付边界

- 新增 ADR-0016，并同步 `docs/decisions/README.md`、`PROJECT_SPEC.md`（§2 不变量 24、§6）与本任务记录。
- 本轮不提供物理删除或 purge；「归档 + 归属校验后回收 worktree/branch」作为独立高风险能力留给后续决策。
- 未 commit、未 push、未提升到 `main`；未重启任何运行中的 Runtime。

## FOUNDATION-034 — 底部新建任务停靠条（ADR-0017）

状态：前端已实现；类型检查、构建、命令面回归与构建资产 HTTP smoke 通过。**浏览器视觉、停靠行为、键盘焦点与窄屏布局尚待用户人工确认**，不把命令面验证等同 UI 渲染验收。

用户本轮明确选择：常驻所有标签页、收起为单行输入 + 创建按钮、展开提供详细设定并补 CLI 对等参数、SELF 显式标记未实现。因 dev 工作树存在并发未提交改动（FOUNDATION-033），先只落 UI 骨架（不碰 `apps/cli/src/main.ts`），随后按用户要求补齐 CLI 对等参数并开放约束与类型字段。记录于 ADR-0017。

### 已实现

- `apps/ui/src/new-task-dock.tsx`（新增）：底部停靠条。收起为单行输入 + `＋ 创建草稿` + `展开 ⌃`（回车提交）；展开为多行规格输入、约束列表（逐条添加/删除）与任务类型；`⌘/Ctrl + Enter` 创建、`Esc` 收起，切换形态后把焦点移到对应的输入。创建成功后清空输入与约束并收起；失败的创建保留输入（不丢草稿）。空白约束行在发送前丢弃，Runtime 仍会再校验。
- `apps/ui/src/App.tsx`：停靠条挂在 `.workspace-shell` 末尾，已选项目时在所有标签页渲染；按 `projectId` 重建（切项目不沿用上一项目的草稿）；创建后加载任务列表、选中新草稿、切到任务工作台，并以 `createToken` 让工作台清空搜索与状态筛选，保证新草稿一定可见。任务列表卡片内的旧输入框与其 `specification` 状态已删除，`usePendingAction` 的 `'create'` 键随之下移到达停靠条（任务内操作仍按 task 键隔离）。
- `apps/ui/src/styles.css`：`.new-task-dock` 用 `position: sticky; bottom: 0.75rem` 的正常流定位，滚动时贴在视口底部且不覆盖上方内容，页面无需预留高度；`.workspace-shell` 增加 0.75rem 底部内边距；≤1100px 收窄边距，≤620px 收起条换行、展开标题纵向排列。
- `apps/cli/src/main.ts`：`task create <project-id> <specification> [--constraint <text>]… [--kind DEVELOPMENT]`。约束 ID 由客户端生成（一个 revision 内唯一非空）；未知 `--flag`、空 `--constraint`、缺失值均为 usage 错误（退出码 2）；无参数的多词规格仍按原样拼接，旧用法不变。`--kind SELF` 以 `TASK_KIND_UNSUPPORTED`（退出码 1）拒绝，不静默降级为 DEVELOPMENT。
- 停靠条提交字段与 CLI 逐字段一致：`specification`、`constraints[]`、`kind`；类型字段只提供 `DEVELOPMENT`，`SELF` 在选择器中可见但禁用并附原因。因此不存在仅 UI 可用的能力（`PROJECT_SPEC.md` §1.1、ADR-0008）。

### 实际验证

- `bun run check` 退出码 0：根与 UI 的 `tsc --noEmit`、vitest **212 项**、Bun tests **244 项**、UI Vite 构建全部通过。本次最终检查在同时含 FOUNDATION-033 未提交 UI 改动（`types.ts` 的 `archivedAt`、任务暂停/终止/归档操作）的工作树上运行，因此计数含该任务新增的测试；确认两边的 UI 改动共存且可共存编译（`NewTaskDock`/`createToken` 与 `task.pause`/`task.cancel`/`task.archive` 同时在位）。
- 新增 `bun test apps/runtime/test/cli-task-create.test.ts`（4 项，均在临时仓库 + 独立 `CODEESTRA_HOME`）：`--constraint` 重复传入的文本与唯一非空 ID 进入 revision 并可由 `task.list` 读回；无参数的多词规格仍按原样拼接且约束为空；`--kind SELF` 退出码 1、stderr 含 `TASK_KIND_UNSUPPORTED` 且任务列表仍为空；未知 flag、空白约束、缺失值退出码 2 且不创建任何任务。
- HTTP smoke（临时 `CODEESTRA_HOME` + 真实 `apps/ui/dist`，由真实 Runtime 托管；回环请求绕开本机代理）：`/`、JS、CSS 均 200；bundle 含 `new-task-dock`、展开面板文案、约束编辑器与类型字段标记；构建 CSS 的 `.new-task-dock` 规则含 `position:sticky` 与 `bottom:.75rem`、约束行样式在位；旧 `task-composer` 在 JS 与 CSS 中均已消失；无令牌 `POST /api/command` 401、带令牌 `project.list` ok。
- 该检查发现并修正一个真实缺陷：`.new-task-dock form`（0,1,1）压过 `.new-task-bar`（0,1,0）的 `flex-direction: row`，收起条会变成纵向排列；规则改为 `.new-task-dock .new-task-bar`，并在构建产物中断言该选择器存在。
- 命令面回归：`bun test apps/runtime/test/http-api.test.ts` 6 项、`apps/runtime/test/cli-attention.test.ts` 3 项（含用 UI 自身 HTTP 客户端创建草稿、读取任务并投递回答）全部通过。
- 未执行：浏览器/桌面/键鼠自动化（仓库禁止）。因此“停靠条是否真的贴底、展开与收起的键盘路径、窄屏换行、任务详情是否被遮挡”仅由用户人工确认，本条不声称已验证；`bun run check` 通过不能证明排版与焦点正确。

### 交付边界与剩余问题

- 新增 ADR-0017，并同步 `docs/decisions/README.md` 与本任务记录；**未修改 `PROJECT_SPEC.md` 或 `AGENTS.md`**。
- 未 commit、未 push、未提升到 `main`；未重启任何运行中的 Runtime。修改了 `apps/cli/src/main.ts` 的 `task create` 分支与 usage 文本（该文件同时在 FOUNDATION-033 的未提交改动范围内；两处改动在最终检查中已验证共存），未触碰 FOUNDATION-033 的其他改动。
- 剩余问题（需显式跟踪，不得当作已完成）：1）**契约与 Runtime 仍接受 `kind: 'SELF'`**（`packages/contracts` enum、数据库 CHECK 都包含它），绕过 CLI/UI 直接调用命令面仍可创建行为与 DEVELOPMENT 无异的 SELF 任务；本轮只在两个客户端边界拒绝，未收紧 Runtime 边界（那属改动契约与服务语义的独立决策）；2）SELF 在 Runtime 中仍无区别行为（无隔离 Self worktree、无 Candidate/Stable 隔离），Phase 7 前不得在 UI 或 CLI 开放；3）停靠条的展开/收起状态与草稿约束不跨页面刷新保留，每次载入均为收起。
- 资源回收（已做归属校验）：HTTP smoke 前两次因本机代理导致 `fetch` 失败并在 `stop` 之前中断，留下两个 `CODEESTRA_HOME=/tmp/ce-ui-dock-smoke-home`（已随临时目录删除）的孤儿 Runtime（pid `47624`、`48276`，经 `ps eww` 核对环境变量确认归属）。已 SIGTERM 确认退出。
- 本轮自查发现并修正的测试缺陷：新增的 `cli-task-create.test.ts` 最初漏了仓库惯例的 `await cli(['stop'])`，每轮泄漏一个 Runtime daemon（三轮共 12 个，`CODEESTRA_HOME` 前缀 `codeestra-task-create-home-*`，经 `ps eww` 核对归属后已 SIGTERM 回收，均在数秒内退出）。已改为在 `afterEach` 中先停 Runtime、再删临时目录；重跑该文件与完整 `bun run check` 后确认 0 个残留进程、0 个残留临时目录。同时观察到同一工作树另一个任务的测试 Runtime（`CODEESTRA_HOME` 为 `/var/folders/.../codeestra-transcript-home-*`）正在运行，已确认不属于本轮、未做任何操作。

## FOUNDATION-035 — 执行过程面板折叠为单行时间线 + 正序/倒序排列

状态：前端与 CLI 展示层已实现；UI 类型检查、构建、构建产物断言、CLI 端到端测试通过。**渲染与交互的目视确认尚待用户人工确认**（ADR-0008 禁用浏览器/桌面自动化），未把构建通过当作 UI 验收。

用户本轮明确选择：**执行过程面板默认只以一行显示基本内容，想看细节自己点开**（参考 deepseek harness 的形态）。跟进要求：**增加正序/倒序编排的可选项**。两轮共四题确认：1）**除用户输入外全部折叠**（未选：只折叠工具类与思考 / 全部条目都折叠）；2）**点一行展开整条**（未选：每个 part 各自一行独立展开）；3）倒序时**自动加载到最新**（未选：只反转已加载内容 / 新增尾部游标命令）；4）**同时加 CLI flag**（未选：只做 UI）。

### 已实现

- `apps/ui/src/transcript.tsx`：新增 `entrySummary(entry)`——折叠行取“可见文本 → 工具调用名+参数 → thinking → 首块”中第一个有内容者，经 `oneLine()` 把换行/连续空白压成一行，超过 160 字符截断加省略号；工具返回的条目额外用 `entry.toolName` 作前缀。条目新增 `open` 状态：**USER 条目默认展开**（可点收起），其余条目默认折叠为一行；折叠行是带 `aria-expanded` 的 `<button>`，包含折叠箭头、类型徽标（任务输入 / Agent / 工具返回 / …）、单行摘要与右侧元信息（`工具报错`↔`工具成功`、`N 段`、时间）。
- 展开后的内容与改动前一致：原来 header 里的诊断字段（role、provider/model、`stop=`、`tool=`、usage/成本、entryId）移到 `.entry-detail`，各 part 的「展开全文 / 收起」（按需经 `session.transcript.part` 取回完整块）与“已截断，仅显示前 N 字符”提示保持不变。切换 Session 时同时清空 `open` 状态。
- 排列选项：面板动作行新增「排列」选择器（`正序（最早在前）`/`倒序（最新在前）`），偏好以 `codeestra.transcript.order` 存 `localStorage`（与主题同样只属展示偏好，存储不可用时回落 `forward`）。倒序只是把同一批已读取条目反向渲染（`[...entries].reverse()`），不改数组本身，也不改后端的文件顺序。
- 倒序的取数语义：命令面只有正向 `afterEntryId` 游标，所以倒序必须读到文件末尾才能保证顶部是最新条目。`read` 在倒序下会连续分页直到 `hasMore === false`，上限 `maxReverseReads = 50` 页；到上限就显式提示“仍可能有更新的记录未显示”，并把页脚按钮改为「加载更新的记录」（文案也随排列切换），不静默地把旧条目排在顶部。切换为倒序时立即触发一次追赶，不等轮询节拍。
- `apps/cli/src/main.ts`：新增 `--reverse`（`task transcript` 与 `session transcript` 都可），只影响人类可读渲染（最新在前），条目内容与截断提示不变；因为只有正向游标，`--reverse` 同样连续分页到末尾（同一 50 页上限，到上限时 stderr 明确提示并给出 `--after <cursor>` 续读方式）。`--reverse` 与 `--json` 同时使用是 usage 错误（退出码 2）——`--json` 一直承诺“Runtime 视图原样输出”，不静默重排数据；`session transcript` 仍拒绝 `--execution`。usage 文本与文件头也注明倒序的含义与页数上限。
- `apps/ui/src/styles.css`：`.entry-line` / `.entry-summary`（`white-space: nowrap` + `text-overflow: ellipsis`）/ `.entry-meta` / `.entry-detail` 规则；折叠条目减为 `padding: 0.2rem 0.6rem`；`.entry-line` 覆写全局 `button` 的边框/背景/内边距使其成为列表行；类型徽标沿用左侧色条配色。

### 实际验证

- `bun run check` 退出码 0：根与 UI `tsc --noEmit`、vitest **212 项**、Bun tests **245 项**（本次新增 1 项）、UI Vite 构建（22 modules，CSS 14.40 kB、JS 278.14 kB）。
- 新增命令面端到端（`apps/runtime/test/cli-transcript.test.ts`，协议 stub provider 写出真实会话文件——**不是真实 Agent 集成证据**）：`task transcript --reverse` 退出码 0、stderr 含“倒序：最新在前”、六个 `=== <id>` 在 stdout 中的位置严格递减（真的最新在前）、工具调用与工具输出仍完整；`session transcript --limit 2 --reverse` 在三页内读完全部 6 条（证明倒序确实连续分页）、无上限提示；`task transcript --reverse --json` 退出码 2 且 stdout 为空。
- 构建产物断言（headless，命令面可复现）：`apps/ui/dist/assets/*.css` 中存在 `.entry-line`、`.entry-line:hover:not(:disabled)`、`.entry-line .caret`、`.entry-line .kind-chip`、`.entry-summary{...text-overflow:ellipsis...}`、`.entry-detail`、`.transcript-entry.collapsed{padding:.2rem .6rem}` 与 `.transcript-entry.kind-user .kind-chip`/`.kind-tool_result .kind-chip`；JS bundle 中存在 `entry-summary`、`kind-chip`、`entry-detail`、`工具报错`。
- 未执行：浏览器/桌面/键鼠自动化（仓库禁止）。折叠行的实际排版、摘要是否溢出、点击展开与键盘焦点行为、排列选择器的交互仅由用户人工确认；本机稳定 Runtime 未被触碰。

### 交付边界与剩余问题

- 改动范围：`apps/ui/src/transcript.tsx`、`apps/ui/src/styles.css`、`apps/cli/src/main.ts`（transcript 渲染与 flag 解析）、`apps/runtime/test/cli-transcript.test.ts`。未改 `packages/contracts`、未改 Runtime 命令语义（没有新增尾部游标），因此未新增 ADR：`--reverse` 是只读视图的渲染顺序，不是新的业务能力。
- 未 commit、未 push、未提升到 `main`；未重启任何运行中的 Runtime。
- 未做（需显式跟踪）：1）倒序在超长会话下最多读 50 页，超过则顶部可能不是真正最新的一条（已明确提示，未静默）；若今后要一次拿到尾部，需要为 `session.transcript` 增加尾部游标（本轮用户已选不这样做）。2）UI 只有 50 页上限提示，没有“继续追赶直到最新”的一键操作（页脚按钮每次再读最多 50 页）。3）面板仍不提供“全部展开/全部折叠”批量控制；折叠状态与排列偏好中的折叠状态不跨刷新保留，排列偏好跨刷新保留。
## FOUNDATION-036 — 任务列表与任务详情分页

状态：前端已实现；类型检查、Vitest/Bun 测试与 Vite 构建通过。**浏览器视觉与键盘操作待用户人工确认**。

用户要求把任务列表与任务详情拆成两个页面：列表页只显示列表，点击某个任务才进入详情。

### 已实现

- `apps/ui/src/App.tsx`：`TasksTab` 拆成两条渲染路径。`task === null` 时只渲染任务概况、搜索/状态筛选、任务列表与新建草稿；选中任务（`taskId` 命中列表项）时渲染独立详情页，并在顶部提供「← 返回任务列表」。
- 列表行增加「查看详情 →」提示，点击行即进入详情页；从待处理页的「查看关联任务」也直接进入对应详情。
- 详情页保留原有全部能力：下一步提示、命令操作、任务内问卷、执行/验证证据、只读 Agent 执行过程；未新增取消、暂停、自动集成或发布能力。
- 页面标题在任务页随视图切换为「任务列表 / 任务详情」；切换项目仍清空选择回到列表。创建草稿成功后进入该草稿详情（沿用原「创建后选中」行为）。
- `apps/ui/src/styles.css`：移除双栏 `.columns`/`.task-workspace` 布局（含两处响应式覆盖），任务列表改为整页宽度并把列表最大高度提高到 60vh；新增 `.back-link` 与 `.task-open` 样式。

### 实际验证

- `bun run --cwd apps/ui typecheck`：通过。
- `bun run check`：Runtime/CLI 与 UI TypeScript、**212 项 Vitest、226 项 Bun tests**、Vite 构建全部通过（0 fail）；`bun run --cwd apps/ui build` 产出 `dist/assets/index-BNVX8BYE.js`、`index-CdaUrOdv.css`。
- 本轮仅改前端呈现与页面切换，未改变任何 Runtime 命令、契约或数据语义，因此未新增命令面测试。
- 未操作浏览器/桌面；构建与类型检查不能证明排版、焦点顺序或窄屏视觉正确。

### 交付边界

- 未修改 `PROJECT_SPEC.md`、`AGENTS.md` 或任何 ADR；未提交、未 push、未提升 `dev → main`，也未重启 Runtime。
- 仍需人工确认：列表/详情切换、返回按钮、窄屏单列、搜索与筛选后进入详情、从待处理页跳转详情。

## FOUNDATION-037 — 检查分层：加快开发循环

状态：已实现并在本工作树实测通过。未 commit、未 push、未提升 `dev → main`、未重启 Runtime。

用户要求减少检查规模、加快研发速度，主要去掉耗时长或必要性不强的检查。先测量再决定：`bun run check` 约 52s，其中 Bun 测试 46.8s（245 项）、根 typecheck 2.2s、UI typecheck 1.8s、Vitest 212 项 0.5s、UI 构建 0.5s。慢测试的成本是分散的：约 120 项 Runtime/CLI 用例各 300–500ms（每例都建临时仓库 + worktree + Runtime + SQLite），另有 6 例 1.2–1.8s；`bun test --concurrency`/`--max-concurrency` 无收益（文件已并行，8 核 44s）。因此删除个别用例最多省约 3s，真正的杠杆是把进程级 e2e 从开发循环里移出。

### 已实现

- `package.json`：新增 `check:fast`（根 typecheck + UI typecheck + Vitest + `test:unit`）与 `test:unit`/`test:e2e`。`test:unit` 用 `--path-ignore-patterns='**/{...12 个文件...}.test.ts'` 跑「全部 Bun 测试减去 e2e」，`test:e2e` 显式列出这 12 个进程级文件；两者相加 = 245 项，无重复、无遗漏。
- `check` 保持分层前的相同覆盖：typecheck + UI typecheck + Vitest + `test:storage`（Bun 测试目录整体）+ UI 构建；fast 档的 `test:unit` 只是它的子集，所以开发循环与提交门禁可以用同一个 245 项用例口径对齐。
- `Justfile`：新增 `check-fast`、`test-e2e`；`verify` 不再跑 `bun audit`（网络相关、与本次改动无关），`audit` 保留为独立目标。
- `README.md`「本地检查」：说明两层检查各自的耗时、覆盖与用途，以及 audit 已移出 verify。

### 实际验证

- `bun run check:fast`：退出码 0，约 10.3s（typecheck、UI typecheck、Vitest 212 项、`test:unit` 163 项 / 17 文件 0 fail）。
- `bun run test:e2e`：82 项 / 12 文件 0 fail，38.6s。
- `bun run test:unit` + `bun run test:e2e` 的用例数 163 + 82 = **245**，与 `bun run test:storage` 的 245 项一致，证明分层没有漏跑或重跑。
- `bun run check`：退出码 0，46.3s，245 项 Bun 测试 0 fail、212 项 Vitest、根与 UI typecheck、Vite 构建全部通过。
- 未改 `.codeestra/policies/verification.json`：task verification 仍跑全量 `bun run check`，证据强度不变；因策略文件内容未变，`policyDigest` 不变，STRICT 下不产生额外确认。
- 未使用桌面/浏览器自动化，未操作真实用户仓库。

### 剩余问题

- 完整 `check` 仍约 46s，其中 38.6s 是进程级 e2e。若要再压，方向是复用 fixture（12 个文件各自重建临时仓库/worktree/Runtime）或将 `task verify` 加同一 commit+policy digest 的新鲜证据复用（行为改动，需 ADR），不是再删用例。
- 已发现既有 flakiness（非本轮引入）：`apps/runtime/test/cli-attention.test.ts:248`（workbench HTTP client）在与其它文件组成子集运行时会因 `envelope` 为 null 失败，单独跑整套 12 文件 e2e 时通过。未修，仅记录。

## FOUNDATION-038 — Task 成果合入 dev（IntegrationBatch 第一小步）

状态：已实现并在本工作树实测通过。未 commit、未 push、未提升 `dev → main`、未重启 Runtime。决策见 ADR-0018。

### 已实现

- `packages/contracts`：新增 `task.integrate`（`expectedVersion` CAS）与 `task.integration.list`；`devBranchRef = 'refs/heads/dev'`；`project.trust.expectedIdentity` 改为 `projectIdentitySchema`（identity + `devRef`/`devCommit`/`devRefPresent`），因此确认信任同时确认了看到的 dev 基线。
- `packages/storage`：schema v10 `integrationPipelineMigration`（`integration_batches`、`integration_batch_items`、`integration_verification_runs`、`projects.dev_ref`）。批次状态按 `docs/architecture/state-machines.md` §4 命名：`CREATED → PREPARING → VERIFYING → INTEGRATING_DEV → INTEGRATED`，另有 `CONFLICTED/FAILED/RECOVERY_REQUIRED`；`merged_commit` 在 ref 更新前落库，作为崩溃恢复的判定依据。`ExecutionSummary` 增加 `resultCommit`（UI 用它精确判断能否合入）。
- `packages/git`：新增 `integration.ts`（`readLocalRefCommit`/`listCheckedOutRefs`/`isAncestor`/`createIntegrationWorktree`/`mergeResultCommit`/`advanceLocalRef`/`removeIntegrationWorktree`）与 `inspectBaseRef`；`prepareWorkspace` 参数由 `mainRef`/`expectedMainCommit` 更名为 `baseRef`/`expectedBaseCommit`。
- `apps/runtime/src/integration-service.ts`：前置校验（EXECUTED + 当前 revision 的成果 commit + 该 revision/commit 的 Task 验证 PASSED）、dev ref 读取与「未被任何工作树检出」校验、独立 integration worktree 合并（能 ff 就 ff，否则 `--no-ff` 并核对第一父为固定基线、候选为后代）、独立集成验证（独立记录，绑 candidate/merged commit/dev 基线/policy digest/main commit/Task 验证 ID）、`INTEGRATING_DEV` 后 CAS 推进 `dev`、最后才 `EXECUTED → SUCCEEDED`。失败一律保留现场且不推进 `dev`；成功才尝试删除 integration worktree（不加 force）。
- `apps/runtime/src/verification-service.ts`：抽出 `executeVerificationPolicy` 供 Task 验证与集成验证共用（行为不变，既有验证用例仍通过）。
- `apps/runtime/src/recovery-service.ts`：`reconcileInterruptedIntegrations` 以 ref 事实恢复——`INTEGRATING_DEV` 且 `dev` 已等于 `merged_commit` 时核验后补记 `INTEGRATED`（不二次写 ref），否则 `RECOVERY_REQUIRED` 并写明观察到的 ref；`CREATED/PREPARING/VERIFYING` 记为 `RECOVERY_REQUIRED` 并明确“dev 未被推进”；未完成集成验证记 `ERROR(RUNTIME_RESTARTED)` 且保留副本。
- CLI/UI：`task integrate`（仅 `INTEGRATED` 退出码 0）、`task integration list`、`task status.integrations` 投影；UI 任务详情新增「合入 dev」按钮（仅在该成果 commit 的验证 PASSED 且无进行中/已合入批次时可用）与集成记录表；不新增确认步骤。

### 实际验证

- `bun run typecheck`、`bun run typecheck:ui`：退出码 0。
- `bun test apps/runtime/test/integration-service.test.ts`：15 项全部通过（ff 合入、dev 前移时的合并提交、未通过 Task 验证时拒绝且不建批、dev 被检出时拒绝、合并冲突保留 `MERGE_HEAD` 现场、集成验证失败保留合并工作树、集成过程中 dev 被移动时 `DEV_REF_MOVED`、同 commandId 重放不重复合入、STRICT 策略确认匹配/不匹配、`commit-msg` hook 拒绝记为 `FAILED/MERGE_FAILED` 而非冲突、无 identity 仍可 ff，以及三条崩溃恢复用例）。
- `bun test apps/runtime/test/cli-integrate.test.ts`：2 项通过（真实 CLI + 真实 Runtime + 协议 stub provider，临时仓库）：`create → submit → run → result capture → verify → integrate` 后 `dev` 前进到成果 commit、`main` 不变、Task `SUCCEEDED`、`task integration list`/`task status.integrations` 一致；验证未通过时 `task integrate` 退出码 1 且 `dev` 不变。
- `packages/storage/test/database.test.ts` 新增 v9 → v10 升级用例；`packages/contracts/test/request.test.ts` 新增 `task.integrate`/`task.integration.list` 请求边界用例。
- `bun run check` 退出码 0：根/UI typecheck、Vitest 212 项、Bun 测试 264 项（`test:unit` 165 + `test:e2e` 99）、Vite 构建。受影响既有用例只做与“仓库必须有 dev 分支/基线 ref 改名/inspect 结果类型”有关的最小调整。

### 剩余问题

- `dev` 已被检出时无法一键合入（本机开发工作树就是该情形）：Runtime 拒绝并提示在 dev 工作树自行合并；选项“允许改动已检出的 dev 工作树”被明确否决。
- 集成验证与 Task 验证使用同一份项目策略，只是独立记录；更强的独立验证器不在本轮。
- 未实现：多成员批次、批级 `STALE`/`CANCELLED`、`dev → main` 提升与重启、失败现场与副本的回收策略。
- 未用真实 provider 驱动合入（只用 stub）；未使用桌面/浏览器自动化。

## FOUNDATION-039 — 长命令成为持久 Operation（进度、取消与重启 reconcile）

状态：已实现、已提交并合入 `dev`。实现提交 `af1fcdf`（分支 `lane/a1-run-operation-progress`，基线固定为 `dev@4c8bc87`，未 rebase）；集成合并 `d70bc46`（两个父：`af1fcdf` 与当时的 `dev@c7a6f93`）。未 push、未提升 `dev → main`、未重启 Runtime。决策见 ADR-0019（用户确认：保持同步默认 + 新增 `--background`；复用现有枚举表达取消，不改状态机；进度用查询命令 + 轮询；UI 做进度列表 + 取消按钮）。

### 已实现

- `packages/storage`：schema **v11** 新增 `operation_progress(operation_id, sequence, step_key, step, state, detail_json, recorded_at)`，`UNIQUE(operation_id, step_key)` 使步骤幂等；**v11 已被本轮占用，未释放**（并发 lane 的 ADR-0021 保留 v12，合并后 `phase1SchemaVersion = 12`）。追加方法：`beginRunOperation`、`recordOperationProgress`（第一个步骤把 Operation 从 `PLANNED` 推进到 `IN_PROGRESS`，并同时充当 heartbeat）、`getOperation`、`listTaskOperations`、`findActiveRunOperation`、`listIncompleteRunOperations`、`completeOperation`、`getVerificationRunPlan`；未改动任何既有方法签名。
- `apps/runtime/src/operation-service.ts`（新增）：run Operation 生命周期（`beginTaskRunOperation`/`recordRunStep`/`settleRunOperation`）、按事实的重启 reconcile（`reconcileRunOperations`）、后台验证作业（`LongOperationService.startVerification`）、取消编排（`cancel`）、任务级查询（`listForTask`/`get`）。
- `verification-service.ts`：拆出 `queueTaskVerification`（校验 + 建 run + `QUEUED→RUNNING`，不 spawn 任何命令）与 `executeQueuedVerification`（逐命令跑策略并落证据），`runTaskVerification` 组合两者因此既有调用者行为不变；`executeVerificationPolicy` 支持 `isCancelled`/`onCommandStart`/`onCommandEnd`/`onCopyCreated` 并在取消时不判定、不删除副本；`VerificationRunner.stopOwned` 按进程组停止并报告是否确认退出。
- `agent-runtime-service.ts`：`task.run` 在任何 Git/provider 副作用前创建 `RUN_TASK` Operation，并记录 `RUN_REQUESTED → WORKSPACE_PREPARED → EXECUTION_RESERVED → AGENT_SESSION_STARTED`；观察流结束后 `settleRunOperation` **只按已记录的 Session/Execution 状态**收口（正常 settle → `SUCCEEDED/AGENT_SETTLED`；未知或断连 → `RECONCILE_REQUIRED`）；失败路径记 `RUN_FAILED` 并按错误码收口。
- `recovery-service.ts`：新增 `reconcileInterruptedRunOperations`（启动时调用）。
- `packages/contracts`（仅 `task.*` 区）：`task.verify` 增 `background`（默认 `false`），新增 `task.operation.list`/`task.operation.get`/`task.operation.cancel`。
- CLI：`task verify … [--background]`、`task operation list|get|cancel … [--json]`；`--background` 的退出码 0 表示「已受理」而非「验证通过」；`task operation cancel` 在 `stop === 'UNCERTAIN'` 时退出码 1；usage 的 task 段同步更新（末尾行未动）。
- Runtime：`task.status` 增加 `operations` 投影；启动时 reconcile；shutdown 先 `beginShutdown()` 再停进程组，使被关闭中断的长命令不写判定，由下次启动记 `RUNTIME_RESTARTED`。
- UI（`App.tsx`/`types.ts`）：任务详情新增「长命令进度」区块（类型/状态/最新步骤/更新时间/全部步骤）与非终态时的「取消」按钮；「验证任务」改用后台形式并按 1.5s 轮询（仅当存在非终态 Operation），走同一命令面，不新增业务语义。

### 合入 dev（含冲突处理）

合入前 `dev` 已被 A3 的 ADR-0021 推进到 `c7a6f93`（`phase1SchemaVersion = 12`，并已在注释里明确把 v11 留给本格）。因此不能快进，必须在集成工作树里做一次真正的合并：

- 冲突只出现在两处：schema 版本与文档索引。解决方式：`phase1SchemaVersion` 取两者最大值 **12**，并把两条 additive 迁移按升序同时保留（`if (version < 11) operationProgressMigration;` 然后 `if (version < 12) reclamationMigration;`，`packages/storage/src/database.ts` 的 `migrate()` 同步）；`docs/decisions/README.md`、`docs/tasks/README.md` 同时保留 ADR-0019/ADR-0021 两条索引与 FOUNDATION-039/041 两节。
- 自动合并但已人工复核：`apps/runtime/src/main.ts`（两条启动 reconcile、两个服务接线都在；shutdown 顺序保持 `beginShutdown()` → 停进程组 → 等长命令作业，因此关停不会把被杀的命令写成判定）、`apps/cli/src/main.ts`（`task operation` 与 `reclaim` 分支互不遮蔽，usage 同时列出两组命令）、`packages/contracts/src/index.ts`（`task.operation.*` 在 `task.*` 区，`reclaim.*` 在 union 末尾）、`packages/storage/src/index.ts`（两个迁移导出均在）。两个父提交的行为都没有丢失。
- 集成工作树与 dev 工作树都跑了 `bun install --frozen-lockfile` 与全量 `bun run check`，均为退出码 0：**301 项 Bun tests（A1 278 + A3 23）0 fail**、212 项 Vitest、根/UI typecheck、UI Vite 构建。两边 HEAD tree 均为 `a58a777`（doc 记录更新前）——即“被验证的树”就是 dev 当时的内容。
- dev 工作树只执行了 `git merge --ff-only`（不在那里解决冲突）；未在那里改过源文件；`git status` 始终 clean。临时集成工作树与临时分支已回收。

### 实际验证

- 本格分支（`af1fcdf`）：`bun run check` 退出码 0 —— 根与 UI `tsc --noEmit`、**212 项 Vitest**、**Bun tests 278 项**（`test:unit` 165 + `test:e2e` 113）、UI Vite 构建。
- 合入后 `dev` 工作树（`d70bc46`）：`bun install --frozen-lockfile` 无变化，`bun run check` 退出码 0 —— 212 项 Vitest、**301 项 Bun tests 0 fail**、UI 构建；tree `a58a777`。
- `bun run check:fast` 退出码 0（开发循环：typecheck + UI typecheck + 212 Vitest + 165 unit）。
- `apps/runtime/test/operation-service.test.ts` 12 项：v10→v11 迁移（含 `step_key` 唯一与旧 Operation 保留）；run 步骤序列与按事实收口（Execution 仍 `RUNNING`、不冒充成果已捕获）；provider 版本探测失败也留下 `FAILED` run 记录，且不产生 workspace/Execution；同一 run commandId 重放只留 1 条 Operation 且无重复步骤；Execution 仍活动时重启 → `RECONCILE_REQUIRED` 且 `resourceHeld` 仍为 true；未记录 Execution 的 run → `FAILED/RUNTIME_RESTARTED`；后台验证逐命令步骤 + `PASSED`；确认静止的取消 → run `ERROR/CANCELLED_BY_USER`、Operation `FAILED`、副本保留、无 `unconfirmedStops`；无法确认的取消（注入不可确认的 runner）→ Operation `RECONCILE_REQUIRED` + `CANCEL_UNCONFIRMED` 且 run 保持 `RUNNING`（不伪造终态）；取消 Agent 运行 → 协作暂停（Task `PAUSED`、Operation `FAILED/STOPPED_BY_USER`）且不被观察流覆盖；同一 verify commandId 重放只跑一次。
- `apps/runtime/test/cli-task-run-progress.test.ts` 2 项（真实 CLI 子进程 + 真实 Runtime + 独立 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）：`task.run` 步骤可经 CLI 读取、`--json` 可解析、`task.status.operations` 同一投影、对已终态 Operation 取消返回 `ALREADY_TERMINAL` 且不杀 Task、未知 flag 退出码 2；`task verify --background` 返回 handle（退出码 0 = 已受理，stderr 明确说明）、慢命令出现 `COMMAND:slow:STARTED`、`task operation cancel` 退出码 0、`dev` 未变、Task 仍 `EXECUTED`、验证记 `ERROR/CANCELLED_BY_USER`。
- 资源归属：测试全部使用临时仓库与临时 `CODEESTRA_HOME`（真实仓库未被写入，fixture 测试断言 `git status --porcelain` 为空）；运行后检查无残留临时目录与孤儿 Runtime。
- **未执行**：真实 provider 下的后台验证/取消复验（本轮只用协议 stub 与注入的 fake）；浏览器/桌面/键鼠自动化（仓库禁止）；UI 视觉、键盘焦点、窄屏效果仍待用户人工确认——`bun run check` 通过不构成 UI 验收。未触碰 `main`、未重启任何运行中的 Runtime。

### 交付边界与剩余问题

- 改动文件：`packages/storage/src/{migration,database,index}.ts`、`packages/contracts/src/index.ts`、`apps/runtime/src/{operation-service,verification-service,agent-runtime-service,recovery-service,main}.ts`、`apps/cli/src/main.ts`、`apps/ui/src/{App.tsx,types.ts}`、`package.json`（仅把两个新测试文件加入既有 `test:unit`/`test:e2e` 分层清单）、`docs/decisions/0019-*.md`、`docs/decisions/README.md`、本文件。未修改 `PROJECT_SPEC.md`、`AGENTS.md`、状态机与事件模型文档。
- 明确未做（不得当作已完成）：verification run 的独立 `CANCELLED` 状态（状态机变更，ADR-0019 D05 保留后续决策）；被取消验证副本的 `prune`/回收；token 级进度事件；`task.run` 的「排队后立刻返回」（现状仍在 Session 启动后返回）；多任务批级进度视图。
- 取舍：取消 Agent 运行的 Operation 是**协作暂停**（可 `task resume`），唯一终态停止仍是 `task cancel`；被取消的验证副本与既有失败现场一样保留在 `<CODEESTRA_HOME>/verifications/...`，尚无自动回收。

## FOUNDATION-040 — Pi session-file 双向交接与安全点技术 Spike（ADR-0010 Phase 3 第 1 步）

状态：**技术 spike 已完成、已提交并合入 `dev`**。实现提交 `9193d95`（分支 `lane/a2-pi-session-handoff-spike`，基线固定为 `dev@4c8bc87`，未 rebase）；集成合并 `925c9d9`（两个父：`6fb9783` 与 `9193d95`）。**未修改任何生产代码**、未 push、未提升 `dev → main`、未重启 Runtime。结论见 `docs/spikes/pi-session-handoff.md`。

### 已实测（真实 Pi 0.84.4 + 真实模型 deepseek-flash，spike 脚本与原始输出在 `/tmp`，不入库）

- **session-file 双向恢复成立**：RPC 会话（SIGTERM 退出）→ 真实 TUI `--session <file>` 在 PTY 中恢复同一 session ID 与同一 conversation（屏幕可见 RPC 阶段内容）→ TUI 中键入真实用户消息（同一文件追加 entry）→ 客户端 detach/reattach 不停止 TUI → Ctrl+D release（`exit 0`）→ RPC `--session <file>` 恢复同一 session ID，并让模型同时复述 RPC 阶段与 TUI 阶段的 token 与 passphrase。session file 为 append-only，entry id 跨进程稳定、parent 链完整，可作跨 incarnation cursor。
- **耐久性**：TUI 键入正文在 ≤1s 内落 provider session file，SIGKILL 后仍在；工具执行中 SIGKILL pi 后 JSONL 全部可解析、无半行、可同 ID 恢复（被打断的工具没有 toolResult）。
- **PTY/进程生命周期**：detach 不停止 TUI；release 用 Ctrl+D（`exit 0`）；SIGTERM 给 TUI 也是 `exit 0`（**退出码不能区分正常 release**）；Runtime 关闭 master → TUI `exit 129`(SIGHUP)；Runtime 进程被 SIGKILL → TUI 随之退出；关闭 RPC stdin → pi 自行 `exit 0`（Runtime 崩溃不留孤儿 pi 进程）。
- **关键风险**：SIGKILL provider **不会**终止已开始的工具；孤儿 bash 子进程被 reparent 到 PID 1 后继续运行并在 41s 后写入了工作区 sentinel。`--session <file>` **没有排他**：两个 writer 可并发同写一个 session file 且都不报错（entry id 仍唯一、parent 链可解析）。因此单 writer 必须由 Runtime lease 强制，且 successor 启动前要做后代进程归属核验。
- **权限模式与安全点**：FULL 下已注册工具 0 次确认；STRICT(RPC) 下生产 gate 的 allow/deny 两条路径均实测（拒绝不挂死，`terminate` 后仍到达 `agent_settled`，**故 settled ≠ SUCCESS**）；STRICT 下把 Agent 交给原生 TUI 时**现有 gate 会直接阻断**（`cannot approve … without its RPC permission channel`），必须新增 Runtime side channel；spike 扩展证明 TUI 模式下 side channel（`hello mode=tui` → `permission_request` → typed 决议）端到端可用，原生 `ctx.ui.confirm` 对话框也可渲染（Enter=Yes，Escape=取消）。
- **fence 语义**：在 `sleep 7; echo slept-ok` 执行中打开 fence → 该工具**不被 abort**（+6.9s `isError=False`，输出正确）；下一个工具调用被终止性 block 拦截（`CODEESTRA_HANDOFF_FENCE`）；随后立即 `agent_settled`（无额外 LLM 调用）。`steer` 也实测在当前工具结束后、下一次 LLM 调用前生效。
- 明确列出**未验证**（完整 takeover 编排、并行工具批次下的安全点、writer lease/`ATTACHMENT_BUSY`、归属核验、跨交接模式保持、竞答协调、`ctx.shutdown()` 的 `session_shutdown` 通知不可靠、Windows/其他 provider、compaction）与**不支持/做不到**（无法 attach 到 live RPC 进程、Pi 无 pause/resume、Pi 无 session 文件锁、杀进程 ≠ 工作区静止、退出码不能判定交接正常、不能从屏幕文本推断状态）。

### 合入与验证

- 集成在临时集成工作树 `/tmp/a2-integration` 完成（分支 `tmp/a2-integration` 从 `dev@6fb9783` 建立，合并 `lane/a2-pi-session-handoff-spike`）；冲突只出现在 `docs/tasks/README.md` 的章节插入点（两侧都在 `## NEXT` 前插入新章节），按 **FOUNDATION-039 / 040 / 041 升序**保留三条记录，未丢弃任何一侧内容；合并结果相对 `dev` 只多出本 spike 的两个文件。
- 合并树验证（`/tmp/a2-integration`）：`bun install --frozen-lockfile`，然后 `bun run check` **退出码 0** —— 根与 UI TypeScript、212 项 Vitest、301 项 Bun tests（0 fail，35 个文件）、UI Vite 构建。
- `dev` 工作树只执行了 `git merge --ff-only 925c9d9`（不在那里解决冲突、不在那里编辑源文件）；临时集成工作树与临时分支已回收。
- 本 spike 没有代码、schema、迁移或测试改动，因此合并不会改变父提交中任何行为。

### 边界

- 本格**没有**修改 `packages/agent-adapters/src/pi-gate-extension.ts`。`STRICT + TUI` 必须改该扩展（接收 side channel 决议）才能继续验证，按 spike 规则在此停下记录，留给下一波（会与 A1 的 Operation 语义一起处理）。
- 未使用浏览器/桌面/键鼠自动化；TUI 观测通过真实 PTY + UNIX socket 控制面 headless 驱动。
- **未占用 ADR-0020，已释放**（未推翻 ADR-0010/0011；实现契约与风险事实见 spike §5/§6）。

## FOUNDATION-041 — 验证副本与失败现场的回收（`reclaim`，ADR-0021）

状态：已实现并通过 CLI/命令面测试；未用真实 provider 驱动回收（回收不依赖 provider），未使用桌面/浏览器自动化。**本轮占用 schema v12；v11 保留给 A1 格，未使用。**

用户本轮选择（记录为 ADR-0021）：

1. 回收范围 = Runtime 自己拥有的三类资源（Task worktree / 验证副本 / integration worktree），不是整个数据目录。
2. 失败现场默认保留，`--include-failure-scenes` 才显式回收。
3. 命令面 = 只读预览 `reclaim plan` + 执行 `reclaim apply` + 账本 `reclaim records`，预览与执行共用同一决策结构。
4. 不新增确认门禁（显式用户命令；FULL 零确认预算保持 0，STRICT 也不新增）。
5. 审计入 append-only 表 `reclamation_records`（schema v12）。

### 已实现

- `packages/git/src/reclaim.ts`（新）：`inspectOwnedPath`（realpath 归属判定 + symlink 拒绝）、`inspectOwnedWorktreeRegistration`（`git worktree list --porcelain -z` 注册证据）、`inspectWorktreeState`（tracked/untracked 脏度）、`removeOwnedWorktree`（删除前逐一复核 owned root / 注册路径 / branch 或 detached HEAD；缺失目录时仅 `git worktree prune`；`git worktree remove --force` 不可用时在已证明归属的路径上有界回退 `rmSync`）。**不删 branch、不 `git clean`、不 `reset --hard`。**
- `apps/runtime/src/reclaim-service.ts`（新）：
  - `planReclamation`：只读预览，逐资源给出 `RECLAIM`/`RETAIN`/`REFUSE`/`ALREADY_ABSENT` 与 reason/evidence。
  - `applyReclamation`：把目标列表与 payload 哈希在副作用前写入 `operations`（`kind='RECLAIM_RESOURCES'`），逐资源重新校验后删除，并把每次判断落入账本；`outcome` 为 `FAILED` 仅当有资源真的删除失败。
  - `reconcileInterruptedReclamations`：启动时按真实状态收敛被中断的 operation（消失的记 `RECLAIMED/RECONCILED_INTERRUPTED` 并补做 workspace→`RELEASED`；仍在的记 `RETAINED/INTERRUPTED_UNFINISHED`），自身不删除任何东西。
  - `listReclamationRecords`：账本查询（先校验项目处于 ACTIVE trust）。
- `packages/storage`：`phase1SchemaVersion` 10 → 12；新增 additive `reclamationMigration`（`reclamation_records` + 索引 + `UNIQUE(operation_id,kind,resource_id)`）；新增只读/记账方法 `getReclamationCandidates`、`releaseWorkspaceForReclamation`、`planReclamationOperation`/`startReclamationOperation`/`finishReclamationOperation`/`findReclamationOperation`/`listIncompleteReclamationOperations`、`listReclamationRecords`。
- `packages/contracts`：`reclaim.plan` / `reclaim.apply` / `reclaim.records` 三个严格请求（union 末尾追加）。
- `apps/cli/src/main.ts`：`reclaim plan|apply|records`（JSON 输出；`apply` 仅在 `outcome=FAILED` 时退出码 1；未知/未信任项目 `NOT_FOUND` 退出码 1）；usage 追加命令行。
- `apps/runtime/src/main.ts`：新服务接线 + 启动 reconcile（只做新服务接线与一行 reconcile）。

### 归属与安全判定（删除前全部满足）

1. 路径绝对且 realpath 后严格位于对应 owned root 内；资源路径本身是 symlink → `SYMLINK_ESCAPE` 拒绝（不跟随）。
2. 路径必须在 `git worktree list --porcelain -z` 注册，且注册路径与记录一致；有目录但无注册 → `UNREGISTERED_DIRECTORY` 拒绝。
3. Task worktree 注册 branch 必须等于 `workspaces.branch_ref`；detached 副本 HEAD 必须等于记录承诺的 commit（验证副本 = `tested_commit`，integration ∈ {`dev_commit`,`merged_commit`,`integrated_commit`}）。
4. held Execution（`resource_held=1`）或 Task 处于运行/暂停/等待/回收确认状态 → `ACTIVE_EXECUTION`/`TASK_NOT_TERMINAL` 拒绝，`--include-failure-scenes` 也不能覆盖。
5. 删除对象只由 `workspaces` / `verification_runs` / `integration_batches` 记录决定，不凭显示名、CLI 路径或未校验 ref。

### Attention 工具参数结论（ADR-0021 D05）

本轮明确决定：**`attention_requests.prompt_json` 继续原样保存 provider dialog 的完整工具参数，不做 Runtime 侧摘要化**。理由：审批绑定的是精确输入（标题含 input SHA-256），截断/摘要会让审计无法复现“当时批准了什么”并削弱 fail-closed gate 证据链；本机单用户 FULL 信任边界内数据库目录 0700/socket 0600 与用户可见的工具调用同一信任级；由 Runtime 改写 provider 原始材料属“机器替代叙述”。后果：参数可能含敏感内容并随 `runtime.sqlite` 长期保留，本轮不提供脱敏/加密/轮转；若将来要最小化存储需另立 ADR（不在本能力内隐式改变）。

### 实际验证

- `bun run check:fast` 通过；`bun run check` 通过（见下方结果）。
- `packages/git/test/reclaim.test.ts`：15 项通过 —— 归属内路径解析、symlink 不跟随、注册/分支/HEAD 读取、未注册目录识别、相对路径拒绝、注册 worktree 删除且 branch 保留、重复回收 `ALREADY_ABSENT`、stale 注册 prune、owned root 之外拒绝、symlink escape 拒绝、未注册目录拒绝、branch 不匹配拒绝、detached 副本 commit 校验、脏 worktree 判定、缺失路径不算 clean。
- `apps/runtime/test/cli-reclaim.test.ts`：8 项通过 ——
  - `reclaim plan` 只读（不删除、不写账本）且与 `apply` 同构；`apply` 回收 EXECUTED+已合入+clean 的 Task worktree、branch/用户仓库不被触碰、workspace 变 `RELEASED`；重复 `apply` 幂等（`alreadyAbsent=1`）；`reclaim records` 可查归属证据。
  - 失败现场默认 `RETAIN/FAILURE_SCENE`，`--include-failure-scenes` 才回收，且仍保留 branch。
  - 记录路径实为 Runtime 之外目录时 `REFUSE/PATH_OUTSIDE_OWNED_ROOT`，外来目录与其文件未被删除。
  - held Execution 时 `REFUSE/ACTIVE_EXECUTION`，worktree 原样保留。
  - 未知项目 `NOT_FOUND` 且退出码 1（plan/records 均是）。
  - 崩溃 reconcile：副作用已发生但未记账的 operation 由启动 reconcile 收敛为 `SUCCEEDED`、workspace `RELEASED`、账本记 `RECLAIMED/RECONCILED_INTERRUPTED`，且不再次删除。
  - schema：v10 库 additive 升级到 v12、`reclamation_records` 存在、`foreign_key_check` 无违规、非法 outcome 被 CHECK 拒绝。
- 所有测试只用临时 Git 仓库与临时 `CODEESTRA_HOME`；未对任何真实用户仓库执行破坏性操作，未使用 computer-use/桌面自动化。

### 未验证 / 剩余问题

- 未在真实 provider 长跑后回收（正确性不依赖 provider，但未做端到端长时场景）。
- 未注册目录（DB 写入前崩溃或用户手工放置）只报 `UNREGISTERED_DIRECTORY`/`ALREADY_ABSENT`，不自动清理；需要人工确认后处理，本轮无“清理一切”开关。
- 未做跨项目一次回收（`--project` 必填）、并发多次 `apply` 压力测试、磁盘配额/轮转。
- 副本失败现场当前由 `verification-service` 在 run 结束时删除；本能力回收的是它留下的残留（删除失败、Runtime 中断）。未修改 A1 格领地文件。
- Attention 参数保留决策未做敏感性扫描（例如真实 Agent 在参数里写入密钥的形态）。

## FOUNDATION-042 — `dev → main` 稳定提升与重启成为产品能力（ADR-0022）

状态：已实现并通过 CLI/命令面测试；**未在真实 `main` 上执行提升，未重启任何真实 Runtime**（本格禁止）。本轮占用 schema v13；v11/v12 两段迁移原位未动。

集成记录：lane commit `af93a4c`（`lane/b1-main-promotion`）→ dev merge `dd8f05f`（`--no-ff`，与已合入的 B3/FOUNDATION-044 冲突在 dev 工作树手工解决）。合并后在 `~/Documents/codeestra-dev` 执行 `bun install --frozen-lockfile` 与 `bun run check`，退出码 0（Vitest 231；Bun 351 = `test:unit` 205 + `test:e2e` 146，分层之和与总数一致；Vite 构建）。未 push、未提升 `main`、未重启稳定 Runtime。

合并时的 schema 解决方式（沿 B3 在 ADR-0024 中写下的约定）：`if (version < 13) stablePromotionMigration;` 与 `if (version < 15) taskDependenciesMigration;` 两段并存且升序，常量保持三者最大值 `15`；**v14 仍留给并发 B2 格**。dev 工作树没有本地 `runtime.sqlite`，因此没有「旧库已被标成 15 而跳过 v14」的既有实例；稳定库（`~/.local/state/codeestra/runtime.sqlite`）当前仍是 v12，只有在 `main` 被提升后才会升级，因此 B2 应在其落地前插入 `if (version < 14)` 分支并保持常量 15。


用户本轮选择（记录为 ADR-0022）：

1. 提升后的后置步骤 = ADR-0009 D03 的完整序列：`bun install --frozen-lockfile` → `bun run build:ui` → `bun run codeestra stop` → `bun run codeestra status`（不采用“只 stop+status”或“默认跳过资产”的方案）。
2. 后置序列由 **CLI 客户端**执行：Runtime 只做核对 + fast-forward + 记为 `RESTARTING` 并返回计划；客户端在 `stop` 后仍存活，再用新 Runtime 的证据记账。
3. 「Runtime 恢复响应」的成功判定 = `status: READY`；`uiRunning` 只作为**观察到的事实**记录，不作为提升条件（UI 是按需前端，ADR-0007/0008）。`AGENTS.md` 给 Agent 的人工规程不变。

### 已实现

- `packages/git/src/promotion.ts`（新）：`findCheckedOutWorktree`（定位检出某分支的工作树；未检出返回 null，多工作树检出同一分支报 `FOREIGN_RESOURCE`）、`inspectPromotionWorktree`（分支/HEAD 必须精确匹配、读取 tracked 改动与未跟踪文件、`clean` 只由 tracked 改动决定）、`fastForwardCheckedOutWorktree`（在**该工作树内** `git merge --ff-only <固定 OID>`，合并后回读 ref/HEAD/分支，只有 ref 真的等于候选才算成功；脏工作树、非后代候选一律 `FAILED` 且 ref 不动）。**不提供任何写 `main` 的 `update-ref` 路径。**
- `apps/runtime/src/promotion-service.ts`（新）：`prepareStablePromotion`（固定并校验 dev commit / 预期 main OID / 集成验证三元组 + 成员 revision，只读 Git）、`approveStablePromotion`（STRICT 一次批准；FULL 拒绝 `APPROVAL_NOT_REQUIRED`）、`promoteStableBranch`（重新核对 → 记录 `PROMOTING` → fast-forward 已检出的 `main` → 回读 ref → 记录重启计划与 `promoting_boot_id` → `RESTARTING`）、`recordPromotionRestart`（boot 身份 + 步骤计划一致性 + `READY` 判定）、`abandonStablePromotion`（显式关闭无法续跑的记录）、`promotionRestartPlan`（固定 4 步序列）。拒绝码：`INVALID_COMMIT_ID`、`PROMOTION_EVIDENCE_MISMATCH`、`BATCH_NOT_INTEGRATED`、`VERIFICATION_NOT_PASSED`、`DEV_REF_MOVED`、`MAIN_REF_MOVED`、`PROMOTION_NOTHING_TO_PROMOTE`、`PROMOTION_NOT_FAST_FORWARD`、`MAIN_WORKTREE_MISSING`、`MAIN_WORKTREE_DIRTY`、`PROMOTION_NOT_APPROVED`、`APPROVAL_NOT_REQUIRED`、`PROMOTION_STALE`、`PROMOTION_IN_PROGRESS`、`MAIN_UPDATE_FAILED`、`RESTART_PLAN_MISMATCH`、`RUNTIME_NOT_OBSERVED`、`RUNTIME_NOT_RESTARTED`、`RUNTIME_NOT_READY`、`RESTART_STEP_FAILED`、`PROMOTION_FINISHED`。
- `packages/storage`：`phase1SchemaVersion` 12 → 13；additive `stablePromotionMigration`（`stable_promotions` + `stable_promotion_members` + 「单项目单提升位」部分唯一索引 + 状态/终态/`SUCCEEDED` 必须有 `promoted_commit` 的 CHECK）；方法 `getPromotionCandidates`、`beginStablePromotion`、`findStablePromotionByCommand`、`approveStablePromotion`、`startStablePromotion`、`recordStablePromotionMainUpdate`、`recordStablePromotionRestart`、`markStablePromotionStale`、`failStablePromotion`、`markStablePromotionRecoveryRequired`、`listStablePromotions`、`getStablePromotion`、`getStablePromotionPlan`、`listIncompleteStablePromotions`。
- `packages/contracts`：新增一个 `promotion.*` group（`prepare`/`approve`/`promote`/`restart.record`/`abandon`/`get`/`list`），union 末尾追加；`runtime.ping` 结果新增 `bootId`（重启证据）。
- `apps/cli/src/main.ts`：新增 `promotion prepare|approve|promote|abandon|get|list` 分支块与重启执行器（逐步执行记录中的序列、失败即停止并把未运行步骤记为 `exitCode: null`、输出重定向到 stderr 以保持 stdout 机器可读、只记录摘要不记录原始输出）；`usage()` 追加行。`promotion promote` 只有 `SUCCEEDED` 退出码 0。
- `apps/runtime/src/main.ts`：只做新服务接线、`bootId`、自己的 dispatch 分支与启动 reconcile 调用。
- `apps/runtime/src/recovery-service.ts`：尾部追加 `reconcileInterruptedPromotions`（按 `main` ref 事实收敛：未更新 → `FAILED/MAIN_NOT_UPDATED`；已是候选 → `RECOVERY_REQUIRED/RESTART_UNPROVEN` 且**不二次写 ref**、可续跑；其他 → `RECOVERY_REQUIRED/MAIN_REF_OBSERVED`）。既有函数未改。

### 明确未做（本轮范围外）

- **真实 `main` 提升与稳定 Runtime 重启**：本格禁止操作 `/Users/loyage/Documents/codeestra`，因此这条验收未验证（见下）。
- UI 投影（`apps/ui/**` 本轮无人改，ADR-0022 D01 明确留后续）。
- 多批次合并提升、`main` 未检出时的提升路径、`push`/`origin/main`、系统外手动更新 `main` 的监控。
- `docs/architecture/state-machines.md` §4 的 `VERIFYING` 与本实现的差异未回写该文档（该文件不在本格领地）。

### 实际验证

- `bun run check:fast` 退出码 0：根/UI typecheck + Vitest 212 项 + Bun 单测 194 项。
- `bun run check` 退出码 0：`bun run test:storage` 332 项通过（`test:unit` 194 + `test:e2e` 138，分层之和与总数一致）、`bun run build:ui` 成功。
- `packages/git/test/promotion.test.ts`（新，6 项）：主工作树定位/未检出/非法 ref；干净与脏工作树、分支与 HEAD 不匹配；`merge --ff-only` 后 ref+HEAD+index+文件同时前进；已提升幂等；脏工作树拒绝且本地改动保留；非后代候选拒绝。全部使用临时仓库。
- `apps/runtime/test/promotion-service.test.ts`（新，21 项）：v12 → v13 additive 升级；`prepare` 固定三元组与成员 revision、不写 Git、`commandId` 重放；拒绝非批次集成结果/缩写 OID/main 不符或已等于候选/批次未 INTEGRATED/验证未 PASSED/工作树脏/`main` 未检出；FULL 提升后记录 ADR-0009 的 4 步计划（cwd = main 工作树）且 ref+HEAD+文件同时前进；只有「不同 boot + READY + 全步退出 0」`SUCCEEDED`；同 boot → `RUNTIME_NOT_RESTARTED`；`observedBootId` 非当前 Runtime → `RUNTIME_NOT_OBSERVED`；步骤被替换/截断 → `RESTART_PLAN_MISMATCH`；某步非 0 → `RESTART_STEP_FAILED` 且不回滚；非 READY → `RUNTIME_NOT_READY`；单提升位与不重复提升；STRICT 未批准拒绝、FULL 拒绝 `approve`、批准后成功；dev/main 移动 → `STALE` 且 ref 未动；崩溃 reconcile 三种分支与续跑/abandon。
- `apps/runtime/test/cli-promotion.test.ts`（新，4 项，真实 CLI + 真实 Runtime + 临时仓库 + 协议 stub provider，临时 `CODEESTRA_HOME`）：
  - 完整链路 `create → submit → run → result capture → verify → integrate → promotion prepare → promotion promote`：`main` 前移到成果 commit、`dev` 不变、工作树干净且文件已更新、记录中的四步**真实执行**（含真实 `bun install --frozen-lockfile`、`bun run build:ui`、`bun run codeestra stop`、`bun run codeestra status`，Runtime 真的被停掉并由 `status` 拉起）、`runtimeStatus=READY`、`uiRunning=false` 被记录、`promotion get/list` 一致。
  - 后置步骤失败（`build:ui` 退出 1）：退出码 1、`FAILED/RESTART_STEP_FAILED`、后续步骤记为未运行、`main` 保持已提升不回滚、Runtime 仍可响应、终态记录拒绝 `abandon`。
  - STRICT：未批准时 `promotion promote` 退出码 1（`PROMOTION_NOT_APPROVED`）；`approve` → `AWAITING_APPROVAL`；`abandon` → `FAILED/ABANDONED` 且 `main` 未动。
  - 证据不符（错误 main OID / 错误 dev commit）退出码 1 且不建记录、不动 ref。
- 所有 Runtime/CLI 运行都在各测试自己的临时 `CODEESTRA_HOME` 下（等价隔离，且不连接 main 的稳定 Runtime）；未运行任何针对真实仓库的破坏性命令；未使用 computer-use/桌面/浏览器自动化。
- 结束后已回收本格产生的临时目录与孤儿 Runtime 进程（逐一核验 argv/cwd 属于本工作树且已无 `runtime.sock` 才终止）；未触碰其他格或稳定工作树的进程。

### 剩余问题

1. **既有缺陷（本格发现，未修复，非本格领地）：`codeestra stop` 之后 Runtime 进程有时不退出。** 复现（隔离 home，不触碰稳定服务）：
   ```bash
   cd /Users/loyage/Documents/codeestra-wt/b1-main-promotion
   CODEESTRA_HOME=/tmp/ce-b1-probe bun run codeestra status   # 记录 pid
   CODEESTRA_HOME=/tmp/ce-b1-probe bun run codeestra stop
   ps -p <pid>   # 仍存活：socket 已被 rmSync、storage 已 close、进程被 reparent 到 init
   ```
   影响：多次重启/测试后累积**不可达**的孤儿 Runtime 进程；本格测试与该现象叠加时会留下孤儿（已清理）。依据：同一签名出现在并行的 b2 工作树（pid 48442，无 `runtime.sock`、无 sqlite fd，`shutdown` 已跑完），因此判断为既有 `shutdown()`/启动路径问题而非本格引入；修复涉及 `apps/runtime/src/main.ts` 的 shutdown/启动绑定，需另开任务（并考虑「socket 文件被并发启动者删掉」的竞态）。
2. **越界最小改动（需集成者确认）**：
   - `package.json` 的两个测试脚本列表追加本格新测试文件（`test:unit` 的 ignore glob 加 `cli-promotion`/`promotion-service`，`test:e2e` 加两个文件），以保持 FOUNDATION-037 的分层与 `check:fast` 速度；与其他格同时追加会产生可直接解决的并排冲突。
   - `apps/runtime/test/cli-reclaim.test.ts` 的迁移断言把硬编码 `12` 改为 `phase1SchemaVersion`（schema v13 由本格独占导致的必然影响，1 行）。
3. `promotion prepare` 要求调用方给出**完整** OID（不接受缩写）：脚本需从 `task integration list`/`project inspect` 取值。若希望接受缩写，需要额外的「解析但不接受 ref 名」规则设计。
4. 固定重启序列假定 main 工作树是本仓库的 bun 检出（存在 `build:ui` 与 `codeestra` 脚本）；其他形态会以 `RESTART_STEP_FAILED` 如实失败，`main` 保持已更新。
5. 提升记录的 `RECOVERY_REQUIRED`/`FAILED` 现场没有自动回收策略（ADR-0021 只管 worktree/副本）。

## FOUNDATION-043 — STRICT 权限转 Attention、Session incarnation 与单 writer lease（ADR-0023）

状态：**已提交并合入 `dev`**。lane commit `561e7d5`（`lane/b2-session-handoff`，基线固定
`dev@e5b15a7`，未 rebase）→ dev merge `c853b11`（dev 工作树内 `--no-ff`，与已合入的
B1/FOUNDATION-042、B3/FOUNDATION-044 的冲突在 dev 工作树手工解决；**这是手工合并，不是 IntegrationBatch**）。
**Runtime 侧契约与状态已实现并通过 CLI/命令面测试**；真实 Pi 0.84.4 + 真实模型（deepseek-flash）已在
RPC 模式下 headless 复验 STRICT 权限与 fence 两条路径。**未实现 PTY/TUI 实际转交与 successor 进程启动**
（留给下一格），能力投影里如实写 `UNIMPLEMENTED`/`UNSUPPORTED`。**本轮占用 schema v14**（B1 占 v13
`stablePromotionMigration`，B3 占 v15 `taskDependenciesMigration`）；合并后 `phase1SchemaVersion = 15`，
三段迁移按升序同时保留。未 push、未提升 `main`、未重启稳定 Runtime。

集成与验证（dev 工作树，即合并提交所记录的树）：`bun install --frozen-lockfile`，随后 `bun run check`
**退出码 0** —— 根与 UI TypeScript、231 项 Vitest、**377 项 Bun tests（0 fail，44 文件）**、UI Vite 构建；
分层 `test:unit` 229 + `test:e2e` 148 = 377，与总数一致（分层无遗漏/重复）。冲突解决逐条记录在合并提交里，
并用「逐行比对两个父提交 → 合并结果」检查确认没有丢任何一侧内容（`phase1SchemaVersion` 取 15、
`migrate()` 三步升序、contracts 的 promotion/depends 与 session.handoff 两组并存、
`task.run`/`task.resume` 同时保留依赖门禁与本轮的 writer lease 记录、recovery 两个 reconcile 并存、
CLI usage 两段并存、`docs/tasks` 按 042/043/044 升序）。

用户本轮决策（记录为 ADR-0023）：STRICT 下需要审批的工具调用**不得**沿用 `ctx.ui.confirm` 直接阻塞，
改为经 Runtime side channel 转成一条结构化 Attention，用**现有** `attention list` / `attention answer`
命令面回答；FULL 保持 0 确认、不产生 Attention、不新增门禁。

### 已实现

- `packages/agent-adapters/src/pi-gate-extension.ts`：STRICT 不再使用 `ctx.ui.confirm`；gate 通过
  Runtime side channel（`${CODEESTRA_HOME}/session-handoff.sock`，`CODEESTRA_HANDOFF_SOCKET` 可覆盖）
  发送结构化 `permission_request`（toolName + 原样 input + sha256 指纹 + pi mode），等待 typed 决议
  （ALLOW/DENY/CANCEL），DENY/CANCEL 返回 terminating block。新增 `session_start`（hello）、
  `tool_execution_start/end`、`agent_settled` 的上报（安全点需要结构化事实），以及 fence 的本地生效与
  `fence_ack`。通道不可达时 fail-closed（有界重试，默认 10s，`CODEESTRA_HANDOFF_CONNECT_MS` 可收窄）。
  FULL 仍然完全不接触通道。
- `packages/agent-adapters/src/pi-process.ts`：`readProcessTable`（`ps -eo pid,ppid,pgid,command`）、
  `captureProviderProcessTree`（provider 存活时抓取自身 + 后代 pid/start token）、
  `inspectProviderProcessOwnership` → `STOPPED | ALIVE | DESCENDANTS_ALIVE | UNVERIFIABLE`。不使用
  `pgrep -f`（spike 已证明不可靠），任何无法与记录身份比较的情况都报不可核验而不是假设静止。
- `packages/storage`：`phase1SchemaVersion` 12 → 14；新增 additive `sessionHandoffMigration`
  （`session_incarnations` / `session_writer_leases` / `session_handoff_requests` /
  `session_permission_requests`，+ 索引与 `agent_sessions.current_incarnation_id`）。单 writer 由数据库
  约束兜底：`one_active_session_writer_lease`（每 Session 至多一条未释放租约）与
  `session_incarnations(session_id,incarnation_number)` / `(session_id,command_id)` 唯一。新增方法：
  incarnation 记录（commandId 幂等）、租约 acquire/release、handoff request/fence/safe point/admit/
  cancel、权限请求记录与 `claimSessionPermissionDecision`（原子条件更新）、`markSessionPermissionRequestStale`、
  `failAgentAnswerOperation`、`getAgentSessionIdentity`、按 provider session 反查 Session 等。
- `apps/runtime/src/session-handoff-service.ts`（新）：side channel 服务端（hello/welcome/rejected/fence/
  permission_decision）、incarnation 记录（从 Adapter 已记录的进程身份）、单 writer lease 的
  `ATTACHMENT_BUSY` 拒绝、handoff 请求与 fence、安全点判定、`admitSuccessor` 的归属核验、权限决议送达、
  以及 `status` 只读投影（含 `capabilities`）。帧在 Runtime 尚未记录 incarnation 时会**按序排队等待**
  （有界），不会因为瞬间时序丢弃或误拒；identity 不匹配则立即拒绝。
- `apps/runtime/src/agent-answer-service.ts`：按 Attention 的真实来源路由——provider dialog（
  `extension_ui_response`）走 Adapter；Runtime side channel 的权限请求先在 storage 里原子 claim
  （要求 asking incarnation 仍是当前 writer），再写 side channel，最后才落 `completeAgentAnswer`。
  `STALE_INCARNATION` 的答案记为 `FAILED` 且 Attention 记 `STALE`（不可重试、不触及 provider）。
- `apps/runtime/src/recovery-service.ts`：尾部追加 `reconcileSessionHandoffs`（live incarnation →
  `RECOVERY_REQUIRED` 并清空 current、租约以 `RUNTIME_RESTARTED` 释放、未决 handoff →
  `RECOVERY_REQUIRED`、未决权限与 Attention → `STALE`），不乐观恢复、不改写 Session/Execution/Task 投影。
- `packages/contracts`：新增 `session.handoff.status|request|cancel|writer.acquire|writer.release|admit`
  六个严格请求（union 末尾追加）与 `permissionPromptSchema`（`codeestra.permission` 结构化 prompt）。
- `apps/cli/src/main.ts`：`session handoff status|request|cancel|writer acquire|release|admit`（`--json`
  为默认输出，`writer acquire` 竞争与 `admit` 被拒绝时退出码 1）；usage 追加命令行。
- `apps/runtime/src/main.ts`：新服务接线（socket 在任何 Agent 启动前监听）、`task.run`/`task.resume`
  成功后记录 automation incarnation、六个 dispatch 分支、`attention.answer` 的权限分流、shutdown 关闭
  side channel、启动 reconcile 一行。

### Attention 与决议形状

`attention_requests.prompt_json` 对这类请求是结构化的：

```json
{ "kind": "codeestra.permission", "version": 1, "sessionId": "…", "incarnationId": "…",
  "incarnationNumber": 1, "toolCallId": "call_00_…", "toolName": "bash",
  "input": { "command": "rm -rf build" }, "inputFingerprint": "sha256:…",
  "piMode": "rpc", "requestedAt": 0 }
```

用户回答面不变：`attention list <project>` 看到 `kind=PERMISSION`、`responseType=CONFIRM`；
`attention answer <project> <attention-id> confirm no|cancel`。ADR-0021 的"参数原样入库"决定继续适用。

### 实际验证（全部 headless，未使用浏览器/桌面/键鼠自动化）

- `bun run check`：退出码 0 —— 根与 UI TypeScript、212 项 Vitest（2 个文件）、**327 项 Bun tests
  （0 fail，38 个文件）**、UI Vite 构建；`bun run check:fast` 亦通过（209 项 Bun tests 的精简分层）。
- `packages/agent-adapters/test/handoff-gate.test.ts`（13 项）：真实 UNIX socket 上的 gate 契约——
  hello 携带 mode/pid/provider session id+file；FULL 零确认且不发权限帧；STRICT 只读工具不问、
  敏感工具发结构化请求并按 ALLOW/DENY/CANCEL 收束；通道在等待中被关闭 → fail-closed；Runtime 无监听 →
  fail-closed；Runtime 自身拒绝的理由不与"用户拒绝"混同；通道丢失后新的工具调用会重新建连（不是永久
  fail-closed）；fence 先于审批生效、不发送审批帧、释放后恢复；未知工具直接拒绝。另含真实进程归属
  3 项：SIGKILL provider 后仍检测到存活的后代 `DESCENDANTS_ALIVE`，后代消失后 `STOPPED`，进程表不可读
  → `UNVERIFIABLE`，pid 复用不误判为存活。
- `apps/runtime/test/session-handoff-service.test.ts`（11 项）：租约被第二个 holder 拒绝
  `ATTACHMENT_BUSY`（并报出当前 holder）、同 holder 幂等、重复 commandId 不新建 incarnation/租约、
  STRICT 权限→Attention→DENY 送达且 Execution 不记为成功、旧 incarnation 决议
  `STALE_INCARNATION`（不写 provider、Attention `STALE`、Operation `FAILED`）、claim 原子性（第二次
  `ALREADY_DECIDING`）、安全点（fence ack + 无活动工具 + settled）与 `PREDECESSOR_NOT_STOPPED` /
  `DESCENDANTS_ALIVE` / `PREDECESSOR_UNVERIFIED` 拒绝、admitted 时 `successorStarted:false` 且不移动租约、
  无法记录的权限请求被单独 fail-closed 拒绝且不摧毁通道、fence 释放、重启 reconcile 幂等、未知 provider
  不被采纳。
- `apps/runtime/test/cli-session-handoff.test.ts`（2 项，协议 stub 扮演 provider + 真实 socket/CLI）：
  权限 Attention 经 `attention answer confirm no` 记为 `DELIVERED`/`DENY`、stub 收到 DENY、
  `session handoff writer acquire` exit 1 + `ATTACHMENT_BUSY`（原租约不变）、`session handoff status --json`
  投影 incarnation/lease/安全点/capabilities、fence 确认后 `AT_SAFE_POINT`、`session handoff admit`
  因 predecessor 存活 exit 1（`PREDECESSOR_NOT_STOPPED`）、`session handoff cancel` 释放 fence。
- **真实 Pi 0.84.4 + 真实模型（deepseek-flash）headless 复验**（`/tmp/b2-real-pi.ts`，不入库）：
  RPC 模式下生产 gate extension 真实加载并 hello（真实 provider session id/file 与 pid）；让模型执行
  `echo REALPI-STRICT-PROBE` → 收到结构化 `permission_request`（toolName bash、input 原样、sha256 指纹）；
  **DENY** → Pi 的 toolResult 为 `Codeestra permission denied by user`（`tool_end isError:true`）→
  `agent_settled`（拒绝不挂死）；**ALLOW** → 工具真实执行（输出 `REALPI-STRICT-PROBE`，isError false）；
  打开 fence 后新 prompt 的工具调用被 `CODEESTRA_HANDOFF_FENCE: no new tools after the safe point` 拦下并
  settled。
- 既有 `packages/agent-adapters/test/pi-rpc.test.ts` 的两个 STRICT 测试改为新契约（原断言 `ctx.ui.confirm`
  的部分被 side channel 契约测试取代）；`apps/runtime/test/cli-reclaim.test.ts` 的 schema 版本断言改为
  引用 `phase1SchemaVersion`（v12 → v14 的必然变化，不再是硬编码数字）。
- 迁移验证：临时的 **v12 库 additive 升级到 v14** 检查脚本（不入库）确认 `user_version` = 14、4 张新表
  存在、`PRAGMA foreign_key_check` 无违规、`agent_sessions.current_incarnation_id` 已加。

### 未验证（不得当成已成立）

- **PTY/TUI 实际转交与 detach/reattach 编排**：`session handoff admit` 只做判定并记录，从不启动 successor
  进程、也不移动租约；`capabilities` 明确 `terminalTransport: UNIMPLEMENTED`、
  `nativeTerminalAttach: UNSUPPORTED`、`successorProcessStart: UNIMPLEMENTED`。
  **（已由 FOUNDATION-046 / ADR-0026 实现并取代：`admit` 真启动 successor、终端经 Runtime 拥有的 PTY helper
  运行、attach/detach/release 与能力投影见该记录；本条的「只判定不启动」不再是当前状态。）**
- 跨交接的权限模式/工具集保持（需要真正换进程才能验）。
- 并行工具批次下的安全点、compaction、长会话/大 session file、PTY resize。
- 真实 Pi 的两条路径只在 RPC 模式复验；TUI/PTY 模式下的 side channel 端到端（spike 只验证过 spike 专用
  扩展，未验证生产 gate）**未复验**。
- Windows/其他 provider/非 macOS；`ctx.shutdown()` 的 `session_shutdown` 通知不可靠（沿用 spike 结论）。
- Runtime 重启后对 stale ACTIVE Session 的 Session/Execution 投影 reconcile 仍是既有未关闭议题
  （NEXT #4）；本轮只 reconcile 自己的 incarnation/lease/handoff/permission 状态，不猜 provider 状态。

### 交付边界与权衡

- 改动文件：`packages/agent-adapters/src/{pi-gate-extension,pi-process,index}.ts`、
  `packages/storage/src/{migration,database,index}.ts`、`packages/contracts/src/index.ts`、
  `apps/runtime/src/{session-handoff-service,agent-answer-service,recovery-service,main}.ts`、
  `apps/cli/src/main.ts`、三个新测试文件 + `pi-rpc.test.ts`（gate 契约更新）+
  `cli-reclaim.test.ts`（schema 版本断言）、`package.json`（仅把新 CLI 测试加入既有
  `test:unit`/`test:e2e` 分层清单）、`docs/decisions/0023-*.md`、`docs/decisions/README.md`、本文件。
  未修改 `PROJECT_SPEC.md`、`AGENTS.md`、`packages/domain/**`、`scheduler.ts`、`packages/git/**`、
  `apps/ui/**`、`pi-adapter.ts`。
- 未新增任何权限门禁或审批层：FULL 的零确认预算保持 0；STRICT 的审批仍是逐次工具审批，只是通道从
  provider dialog 换成 Runtime side channel + 既有 Attention 命令面。
- 取舍：STRICT 下 gate 不再显示原生 Pi 对话框。这是有意的——一条通道才能把决议绑定到 incarnation 并
  保证"只接受第一份合法决议"；代价是 Runtime 不在时 STRICT 工具全部 fail-closed（有界重试后拒绝，
  不是静默放行）。

## FOUNDATION-044 — 任务依赖、DAG 环校验与 BLOCKED 语义（ADR-0024）

状态：已实现并通过 CLI/命令面测试（真实临时仓库 + 临时 `CODEESTRA_HOME` + 协议 stub provider）；未用真实 provider 驱动依赖解阻塞，未使用桌面/浏览器/键鼠自动化。**本轮占用 schema v15；v13 保留给 B1 格、v14 保留给 B2 格，均未占用。**

集成记录：lane commit `bf4c3ef`（`lane/b3-task-dependencies`）→ dev merge `7b99b57`（`--no-ff`）。合并后在 `~/Documents/codeestra-dev` 执行 `bun install --frozen-lockfile` 与 `bun run check`，退出码 0（Vitest 231、Bun 320 = `test:unit` 199 + `test:e2e` 121、Vite 构建），合并后工作树与本 lane commit 的 tree 完全一致。未 push、未提升 `main`、未重启稳定 Runtime。合并时 dev 工作树没有本地 `runtime.sqlite`，因此不存在「旧库被标成 15 而跳过 v13/v14」的既有实例；B1/B2 合入时仍需按 ADR-0024 D04 同时保留三段升序分支并取最大常量。

上游语义由 ADR-0009 与用户本轮派单固定：**上游成果先进入 `dev` 才满足依赖**；仅 Task verification PASSED 不释放依赖；DAG 变更必须检验环；`BLOCKED` 只表示依赖未满足。决策记录为 ADR-0024（依赖满足定义、环校验策略、`BLOCKED` 迁移点、幂等与拒绝规则、命令面）。

### 已实现

- `packages/domain/src/dependency-graph.ts`（新，纯函数；不导入 Bun/SQLite/Git/Adapter）：`createDependencyGraph`（自环/重复边/空标识/越界 Task 拒绝并带结构化 `issue`）、`detectCycle`、`wouldCreateCycle`、`assertAcyclic`、`topologicalOrder`、`dependencyClosure`、`transitivePrerequisites`、`transitiveDependents`、`dependencyImpact`；错误为 `DependencyGraphError`。`index.ts` 只追加导出。
- `packages/storage`：`phase1SchemaVersion` 12 → 15；追加 `taskDependenciesMigration`（`task_dependencies`：PK `(dependent,prerequisite)` 即 UNIQUE、`CHECK(dependent<>prerequisite)`、两条 `(project_id, task_id)` 复合外键到 `tasks`、`(prerequisite_task_id, required_revision_id)` 外键到 `task_revisions`、`task_dependencies_no_update` 不可改写触发器、两个索引）；追加 `listTaskDependencyFacts`（读边 + 该钉 revision 的最新 INTEGRATED 事实）、`addTaskDependency`、`removeTaskDependency`、`applyTaskDependencyState`（只允许 `READY↔BLOCKED`，带 CAS、事件与 command receipt）与 `TaskDependencyError('DEPENDENCY_CYCLE'|'SELF_DEPENDENCY')`。**环校验在 `executeCommand` 写事务内调用领域图**，成环即拒绝且不写任何行。`migrate()` 只追加 `if (version < 15)`。
- `apps/runtime/src/scheduler.ts`（新）：`inspectTaskDependencies`（投影：每条边的 `satisfied` + 原因码 + 闭包/影响；不写状态）、`reconcileTaskDependencyState`（重算并把 `READY↔BLOCKED` 落库，非这两种状态只报告不改）、`reconcileDependentTasks`（上游合入后对传递下游闭包逐个重算，单任务失败记入 `errors` 而不使父命令失败）、`assertDependenciesSatisfied`、`assertTaskRunnable`。满足判定 = INTEGRATED 批次事实 + `integrated_commit` 仍可从当前 `dev` ref 到达（`readLocalRefCommit` + `isAncestor`，均来自现有 `@codeestra/git`，未改该包）。
- `packages/contracts/src/index.ts`：union 末尾追加 `task.depends.add` / `task.depends.remove` / `task.depends.list` 三个严格请求。
- `apps/cli/src/main.ts`：`task depends add|remove|list`（`--json`、稳定退出码；`list` 无 `--json` 时给人读视图，有 `--json` 时与 Runtime 投影一致；`add` 成功但任务因此 `BLOCKED` 仍为退出码 0）；usage 追加三行。
- `apps/runtime/src/main.ts`（接线 + 新增 dispatch 分支 + 三处最小接入）：新分支 `task.depends.*`；`task.submit` 记录 `DRAFT→READY` 后在同一命令内执行依赖判定（未满足则 `READY→BLOCKED`）；`task.run` 在预留任何 workspace/Execution **之前**执行依赖守卫；`task.integrate` 成功后在响应里附带 `dependencyReconcile`；`task.resume` 先做只读依赖断言。
- 依赖 `@codeestra/domain` 加入 `packages/storage` 与 `apps/runtime` 的 `package.json`（bun.lock 同步 +2 行，`bun install --frozen-lockfile` 通过）；`package.json` 的 `test:unit` 忽略表与 `test:e2e` 列表追加两个新测试文件。

### 归属与安全判定

1. 依赖两端点必须属于同一项目（复合外键），钉的 revision 必须属于上游（外键）——不依赖显示名或调用方自律。
2. 边不可原地改写（触发器），改钉只能删除再加；`add` 命中已存在但版本不同的边返回 `INVALID_STATE`。
3. 环在写事务内用领域图判定；拒绝时表内行数与 Task 版本均不变。
4. 满足判定 fail-closed：`dev` ref 缺失或 Git 读取失败一律按未满足（`DEV_BASELINE_MISSING` / `DEV_REF_UNREADABLE`）。
5. 依赖未满足时 `task.run`/`task.resume` 在任何 Git 或进程副作用前拒绝，因而不创建 Execution、不占用 worktree。
6. 所有写路径带 `expectedVersion` CAS；重复 `commandId` 经 command receipt 重放，不产生第二行、不二次推进版本。

### 实际验证

- `bun run check:fast` 通过；**`bun run check` 通过（退出码 0）**：根/UI typecheck、Vitest 231 项、Bun 320 项（`test:unit` 199 + `test:e2e` 121，分层之和与总数一致）、Vite 构建。
- `packages/domain/test/dependency-graph.test.ts`（Vitest，新增）：非法图与环（自环、直接环、间接环、带无环前缀的环）、候选边成环路径、非环图（链/菱形）、双向索引与冻结、传递闭包与影响（菱形去重、不含自身、环上终止、未知 Task 空闭包）、确定性拓扑序。
- `packages/storage/test/task-dependencies.test.ts`（Bun，10 项）：v12→v15 additive 迁移保留既有行且 `foreign_key_check` 无违规、`user_version=14` 已盖章库 → v15、自依赖/未知 Task 拒绝（直接 INSERT 也被 schema 拒绝）、加边钉版本、同 `commandId` 重放幂等、不同 `commandId` 同边 `added:false` 不推进版本、改钉拒绝、仅 INTEGRATED 批次算事实、环拒绝且不写入、`RUNNING/PAUSED/SUCCEEDED/EXECUTED/CANCELLED` 拒绝改图而 `FAILED` 保持可编辑、删除与不存在删除 `NOT_FOUND`、`READY↔BLOCKED` 迁移（无理由 BLOCKED、带理由 READY、无变化不写事件不动版本、运行态不受影响）、边拒绝 UPDATE。
- `apps/runtime/test/scheduler.test.ts`（Bun，6 项，真实临时 Git 仓库）：未合入 `dev` 时下游保持 `BLOCKED` 且无 workspace/Execution、`DEPENDENCIES_UNMET`、上游合入 `dev` 后下游转 `READY`、陈旧版本 `CONCURRENT_MODIFICATION`、`dev` 重写后 `NOT_REACHABLE_FROM_DEV`、`dev` 前进后的严格祖先仍满足、传递下游闭包重算（已 BLOCKED 的记 `unchanged`）、投影与运行中 Task 不被改动、环拒绝后图与版本不变、`dev` ref 缺失按 `DEV_BASELINE_MISSING`。
- `apps/runtime/test/cli-task-depends.test.ts`（Bun，2 项，真实 CLI + 真实 Runtime + 协议 stub provider + 临时仓库）：`add`/`list`/自依赖与未知端点退出码 1/重复加边 `added:false`/环 `DEPENDENCY_CYCLE` 退出码 1/项目级列表/下游闭包/`remove` 与不存在 `remove` 的 `NOT_FOUND`/未知项目退出码 1；完整流程：`depends add → submit`（`BLOCKED`）→ `run` 退出码 1 且无 Execution、无 worktree 目录 → 上游 `run → result capture → verify → integrate` → 响应 `dependencyReconcile.readied` 含下游、`task depends list` `satisfied`、下游 `READY`、`dev` 等于成果 commit → `remove` 后无边仍 `READY`。
- `packages/contracts/test/request.test.ts`（新增 1 项）：三个新请求的必填/可选字段与拒绝多余字段。
- 既有测试仅一处机械修正：`apps/runtime/test/cli-reclaim.test.ts` 把硬编码 `12` 改为 `phase1SchemaVersion`（该断言本意即「升级到当前 schema」）。
- 未改动 `packages/git/**`、`packages/agent-adapters/**`、`apps/ui/**`、`workspace-service.ts`、`PROJECT_SPEC.md`、`AGENTS.md`；未 push、未提升 `main`、未重启稳定 Runtime；所有 Git 测试均用临时仓库与临时 `CODEESTRA_HOME=/tmp/ce-b3*`。

### 未验证 / 剩余问题

- 未用真实 provider（非 stub）驱动「上游合入 `dev` → 下游解阻塞」；未验证真实模型长跑下的依赖行为（正确性不依赖 provider）。
- **不包含并行调度**：不选任务、不预留资源、不启动多个 Agent、不做 Conflict Analyzer；`docs/architecture/scheduler.md` 其余部分仍属后续 Phase 2。
- `task.submit` 记录 `DRAFT→READY` 与 `READY→BLOCKED` 两条迁移（storage `submitTask` 属共享热点，本轮只追加），对外状态与 FSM 一致但版本会 +2。
- 上游被修订时不自动改钉 revision（ADR 中列为待用户确认项）；不实现边 `NEEDS_REVIEW`。
- `task.resume` 的依赖断言在命令层，断言与启动之间仍有理论窗口；未加锁。
- 跨项目依赖不支持；依赖图只能在 `DRAFT / BLOCKED / READY / FAILED` 编辑，`EXECUTED`／`SUCCEEDED`／运行中 Task 拒绝改图（不实现「依赖变化使已捕获证据失效」路径）。
- Task 运行期间 `dev` 被重写使边转为未满足时，该 Task 已捕获的成果仍可按 ADR-0018 合入 `dev`（`task.integrate` 前不重验依赖，属 Phase 4）；守卫只阻断启动，不追溯进行中的执行。
- **lane 版本号**：本轮直接把常量设为 15 并只加 `if (version < 15)`；B1(v13)/B2(v14) 合入时集成方必须保留全部升序分支并取最大常量，且本分支单独创建的本地库不会被 v13/v14 步骤补盖。
- 测试只用 CLI/命令面与 HTTP 无关的 socket 命令面驱动，未使用桌面/浏览器/键鼠自动化；未做并发压力与多进程竞争测试（写锁内环校验与 CAS 已有单元覆盖）。

## FOUNDATION-045 — Runtime 生命周期的可判定停止、单实例归属与只读诊断（ADR-0025）

状态：已实现并通过 CLI/命令面测试（真实 CLI + 真实 Runtime + 协议 stub provider + 真实临时 Git 仓库，全部独立临时
`CODEESTRA_HOME`）；**未使用真实 provider（非 stub）验证带活跃 provider 的 stop**，未验证跨用户 EPERM 场景，未做
并发压力测试。**本轮不使用任何 schema 迁移**（v16 留给 C2、v17 留给 C3，均未占用；`phase1SchemaVersion` 保持 15）。
未 push、未提升 `main`、未重启稳定 Runtime，未触碰稳定工作树 `/Users/loyage/Documents/codeestra`。

上游目标由用户派单固定（ADR-0025）：`stop` 返回后进程必须真的退出或如实报告「未退出」；单实例与 socket 竞态不得
留下不可达进程；诊断只读；**本轮不新增自动杀进程能力**，如需自动回收先提方案另立 ADR。

### 根因（实测，两层）

1. **`shutdown()` 跑完后事件循环仍被「有界宽限」timer 多留 ~5s（可累积）。** 各子系统都用
   `Bun.sleep(graceMs)` 放进 `Promise.race` 且**从不清理 timer**：`AgentRuntimeCoordinator.close()`（5000ms）、
   `PiRpcProcess.stop()`（5000ms×2）、`verification-service.ts`（2000ms + 7000ms）、`LongOperationService.close()`
   （5000ms）。Bun 为 pending timer 保持事件循环，所以「race 另一侧早已完成、所有 close 都返回了」的进程仍活着到最长
   宽限到期。逐项跳过 shutdown 步骤的实测：完整 shutdown → 进程 ~5.5s 才退出（shutdown 在 0.4s 完成）；跳过
   `coordinator.close()` → ~0.53s；跳过 `handoff.close()` → 永不退出（监听 socket 仍在，属预期）。原始复现实测：
   `stop` 50ms 返回、进程仍存活、**5.02s 后**才消失——FOUNDATION-042 看到的「socket 已删、storage 已关、进程仍在」
   就是这个窗口。
2. **`stop` 是 fire-and-forget，且启动路径没有归属锁。** `runtime.stop` 只 `setTimeout(() => shutdown(), 10)` 并回
   `{stopping:true}`，没有任何一方等待或核对退出（「已发出信号」被当成「已停止」）。启动序言是 TOCTOU：
   `endpointIsLive()` → `rmSync(socket)` → `Bun.listen`，两个启动者可都判定不可达后各自删同一路径再 bind。并发 4 个
   启动者的实测：3 个分别以 `EADDRINUSE`（`runtime.sock`）、`EEXIST`（`session-handoff.sock`）或
   `SQLiteError: table project_trusts already exists`（两个进程同时迁移/打开一个 SQLite）崩溃；而「败者删掉胜者 socket
   路径、胜者留在无人可达的 inode 上」这一时序会让胜者**既不可达又永不退出**（监听 socket 使事件循环不空闲），
   `stop` 也够不到——正是 FOUNDATION-042 记录的孤儿签名。

### 已实现

- `apps/runtime/src/lifecycle.ts`（新）：`withDeadline`（清 timer 的宽限竞速）、`pidExists`/`readProcessState`
  （zombie 视为已退出）、`readProcessStartToken`（与 `@codeestra/agent-adapters` 同格式）、`probeRuntimeEndpoint`、
  归属锁 `acquireRuntimeOwnership`/`releaseRuntimeOwnership`、只读 `inspectRuntimeHome`。**零 workspace import**，
  因此 CLI 可以直接只读同一份记录；没有新增任何 workspace 依赖（`bun.lock` 未变）。
- `apps/runtime/src/main.ts`（仅启动/shutdown 绑定区）：启动改为「先取 `<home>/runtime.lock` → 取不到则报出 owner 并
  `exit 3/4` → endpoint 仍有人应答（旧版本无锁）则释放自己的锁并 `exit 0` → 才清旧 socket 并 listen」；每次启动写
  `<home>/runtime-boots/<bootId>.json`；ping 结果加 `startedAt`，stop 结果加 `pid/bootId/startedAt`（只报「被要求停止的
  是谁」）；shutdown 末尾在最后释放归属，并在**没有未确认停止的 provider/验证进程**时确定性 `process.exit(0)`，
  否则打日志并保持可观察（让 `stop` 如实报 `NOT_EXITED`）。
- `apps/runtime/src/agent-runtime-service.ts`：`close()` 的宽限竞速改用 `withDeadline`（唯一一处非领地文件改动，
  2 行 + 1 个 import；语义不变，仍未 settle 只记日志）。
- `apps/cli/src/main.ts`（仅 `stop`/`status` 分支块 + `usage()` 对应行，另加相邻的本地辅助函数）：
  `stop [--wait <seconds>]`（默认 10s）先只读读归属记录，ping 不到 endpoint **不启动 Runtime**——
  `UNREACHABLE_PROCESS`（进程仍在但没人应答，`exit 1`，**不杀**）或 `NOT_RUNNING`（`exit 0`）；ping 得到时按
  `bootId` 关联同一进程、取其 `startToken`、发 `runtime.stop`，然后有界轮询直到 `pid` 不存在 / `GONE` / `ZOMBIE`，
  超时才做最后一次身份核对，输出 `STOPPED|NOT_EXITED` 与 `waitedMs/identityVerified/identityChanged/stopReportedPid/
  pidMismatch/ownership` 及退出码 0/1。`status` = ensure（ADR-0004 自动启动语义不变）+ ping + 只读 `ownership`；
  拿不到 Runtime 时打印 `{status: UNAVAILABLE, error, ownership}` 且 `exit 1`（此前是未捕获异常栈）。
- `packages/contracts/src/index.ts`：新增 `runtimePingResultSchema`（含 `startedAt`）与 `runtimeStopResultSchema`，
  就地放在这两个命令的定义旁，不新开 group、不改其它命令。
- `package.json`（**越界最小改动，需集成者确认**）：把 `runtime-lifecycle` 加入 `test:unit` 的 ignore glob 与
  `test:e2e` 文件清单，保持 FOUNDATION-037 分层与 `check:fast` 速度（与其他格同时改动会产生并排冲突）。
- **未新增任何权限门禁、审批层或确认步骤**：`stop` 是用户显式命令，FULL/STRICT 都不新增门禁；只加只读诊断与事实报告。
- **升级窗口兼容**（新 CLI + 旧 Runtime，即本改动落地后的稳定 Runtime）：`stop` 把旧响应 `{stopping: true}` 视为「请求已被
  接受」并同一个有界等待，如实报 `identityVerified: false`、`stopReportedPid: null`（没有可核对的记录）；`status` 原样
  打印旧 ping 字段并附上只读 `ownership`。否则 ADR-0022 重启序列的第一步（`stop`）会在版本差异下莫名其妙地失败。

### 回归测试（`apps/runtime/test/runtime-lifecycle.test.ts`，新，10 项）

- `stop` 后进程真的消失且报 `STOPPED`（FOUNDATION-042 回归：`stop` 返回后进程已不在，`waitedMs`/wall < 4s 而非 5s 窗口）。
- 宽限 timer 不得留住进程：对照实验——裸 `Promise.race(Bun.sleep(3000))` 的子进程 3s 才退出，`withDeadline` 立即退出。
- `stop` 幂等；从未启动的 home 上 `stop` 报 `NOT_RUNNING`、`exit 0`、**不创建任何文件**、不启动 Runtime。
- 并发 4 个启动者：恰好 1 个存活且它是锁的 owner，其余 `exit 3` 且 stderr 为「another Runtime owns this Runtime home」
  （不再出现 `EADDRINUSE`/`EEXIST`/SQLite 迁移冲突），随后 `stop` 让全部消失。
- socket 缺失但进程存活：`stop`/`status` 报 `UNREACHABLE_PROCESS`/`UNAVAILABLE`、`exit 1`、列出该 pid 与身份，且**不杀**。
- SIGKILL 后新启动接管过期锁、把旧 boot 记为 `EXITED_WITHOUT_CLEAN_SHUTDOWN` 并保留其记录（不重写历史）。
- 归属记录单元面：活 owner 拒绝第二次 claim、死后接管、非本 boot 的锁不删、损坏锁保留为 `runtime.lock.corrupt`、
  存活/已退出/pid 复用三类 verdict 与整体 verdict。
- 活跃 provider 子进程：协议 stub provider 保持存活时 `stop` 同时结束 Runtime 与该 provider 进程。

### 实际验证

- 同一复现步骤对照（隔离 home：`status` → `stop` → `ps -p <pid>`）：
  - 修复前（`git stash` 回退本格改动后实测）：`stop` 50ms 返回 `exit 0`（`{stopping:true}`），进程在 `stop` 返回时
    **仍然存活**，**5.02s 后**才消失。
  - 修复后：`stop` 0.10s 返回 `exit 0`（`{status:STOPPED, waitedMs:29, identityVerified:true}`），进程在 `stop` 返回时
    **已经不存在**，`runtime.lock` 与 boot 记录均已释放。
- `bun run check:fast` 退出码 0：根/UI typecheck、Vitest **231** 项、Bun 单测 **229** 项。
- `bun run check` 退出码 0：根/UI typecheck、Vitest **231** 项、`test:storage` **387** 项（0 fail，45 文件）、
  UI Vite 构建。
- `bun run test:e2e` 退出码 0：**158** 项 / 22 文件；与 `test:unit` **229** 项之和等于总数 **387**（分层无遗漏/重复）。
- 结束后回收本格产生的临时目录与进程（逐一核验 argv/cwd/归属记录属于本工作树与临时 home 后才终止），未触碰
  稳定 Runtime（`~/.local/state/codeestra`，PID 65545）与其他格（`c3-verification-progress`）的进程；未使用
  桌面/浏览器/键鼠自动化。
- 升级窗口兼容（人工，需两版代码：`git stash` 后启动旧代码 Runtime，再用新 CLI）：旧 Runtime（无 lock/boot 记录、
  ping 无 `startedAt`）下 `status` 报 `verdict: RUNNING`、`lock.present: false` 并原样打印旧字段；`stop` 报 `STOPPED`、
  `exit 0`、`identityVerified: false`、`stopReportedPid: null`，进程随后确实消失（首次实现会误报 `STOP_FAILED` 并 `exit 1`，
  已修正并复测）。

### 未验证 / 剩余问题

1. **未用真实 Pi（非 stub）复验带活跃 provider 的 stop**：stub provider 只证明编排与释放路径，不证明真实 provider 的
   释放时延与子进程（子 agent）行为。
2. **其余三处同类 `Bun.sleep` 竞速未改（禁改领地）**：`packages/agent-adapters/src/pi-process.ts`、
   `apps/runtime/src/verification-service.ts`、`apps/runtime/src/operation-service.ts` 仍是「race 里放 `Bun.sleep` 且不清理」。
   本格的确定性退出使它们不再拖长进程寿命，但若循环因其他原因未清空，它们仍会多留数秒；建议各领地负责人改用
   `withDeadline`（本格已把该 helper 放在 `apps/runtime/src/lifecycle.ts`）。
3. **不可达孤儿仍只报告、不回收**（派单要求的边界）：若要自动化，建议另立 ADR，方案是显式命令 + `pid`/`startToken`
   匹配 + endpoint 不应答三重校验后 SIGTERM→SIGKILL，并记账；常态路径 0 步 0 等待，异常路径多一条人工命令。
   旧版本（无归属记录）的孤儿无记录可校验，本格不猜归属、不误杀。
4. **`runtime-boots/` 会累积未干净退出的 boot 记录**（每个异常退出 1 个小 JSON，本格不自动清理；它是 ADR-0021 之外的
   第四类未注册资源）。是否需要纳入回收属后续决策；保留现场是当前取舍。
5. `stop` 只有在「endpoint 应答」或「归属/boot 记录存在」时才能识别进程；`runtime.lock` 含 `cwd`/`argv`（无密钥），
   跨用户 EPERM 场景只按 fail-closed 处理（视为存活），未实测。
6. 新版 Runtime 与旧版（无锁）Runtime 并存只覆盖了两条路径：「endpoint 应答则让位」与「新 CLI 停旧 Runtime」
   （已在「实际验证」里人工复测）；旧 Runtime 与新 Runtime 真正同时启动、以及旧 Runtime 先于新 Runtime 持有的
   `session-handoff.sock` 冲突未验证。
7. 未做并发压力测试（数十个 home 同时 stop/status）与长时间运行下的 boot 记录规模测试。
## FOUNDATION-046 — 原生终端 PTY 传输、successor 启动与 attach/detach/release（ADR-0026）

状态：**已实现、已提交并合入 `dev`**（真实 PTY + 真实进程表 + 协议 stub provider），并在**真实 Pi 0.84.4**
上完成了传输与 side channel 的 headless 实测（见下「实际验证」）。lane commit `730880e`（`lane/c2-pty-handoff`，
基线固定为 `dev@abec3f3`，未 rebase）→ dev merge `abc0685`（在 dev 工作树内 `--no-ff`，与 FOUNDATION-045/047
的并排冲突在此解决）。**未 push、未提升 `main`、未重启稳定 Runtime**。
集成时因 C3 的 v17 先合入，本格迁移**改占 schema v18**（`sessionTerminalMigration`：`session_terminals` +
`session_terminal_attachments`；本格原预留的 v16 作废——dev 的数据库可能已被标为 17，`version < 16` 会被跳过）；
V13/V14/V15/V17 四段既有迁移原样保留，`phase1SchemaVersion` 17 → 18。

Phase 3 第二小步：把 `session handoff admit` 从「只判定并记录」变成**真的能接管**。ADR-0023 的安全点、单
writer lease、incarnation 与决议路由语义不变；本格实现 ADR-0010 D04/D05 的传输半边，不新增任何权限门禁或
审批层（FULL 仍 0 确认，STRICT 仍走既有 `attention answer` 通道）。

### 已实现

- `packages/agent-adapters/src/pi-pty-host.ts`（新）：Runtime 拥有的极小 PTY host 进程。`setsid` →
  `posix_openpt`/`grantpt`/`unlockpt`/`ptsname` → 以 slave 作**控制终端** spawn provider → 用 LF-JSON 帧
  （`input`/`signal`/`shutdown` ↔ `ready`/`output`/`exit`/`error`）与 Runtime 交换终端字节流与退出事实。
  窗口大小在 spawn 前经 `stty rows/cols` 应用（直接 `ioctl(TIOCSWINSZ)` 在本环境写入垃圾值，已弃用并在代码里
  注明原因）；master 只在 `poll` 报告可读时才读（阻塞读会把 helper 卡死在 provider 退出之后）；provider 的
  退出由 `waitpid(WNOHANG)` 判定，不由 promise 或空读推断；helper 关掉自己的 slave 副本以便 EOF 可见；
  **控制管道关闭 = 没有 writer 拥有这个终端 → 终止 provider 并退出**（孤儿防护）。
- `packages/agent-adapters/src/pi-pty.ts`（新）：`buildPiTerminalArguments`（与 RPC 启动同源，仅少
  `--mode rpc`）、`PiPtyTerminal`（有序 cursor 投影 + 有界内存缓冲 + `truncated` 上报、`write`、
  `waitForExit`、`captureTree`/`refreshTree`（按 pid 并集合并）、`inspectOwnership`、`stop`、
  `closeControl`）、`terminalReleaseByte`。
- `packages/agent-adapters/src/pi-session-file.ts`（新）：只读、有界、可报告「只读了前缀」的 provider session
  file 事实读取（条目数、最后一个 entry id、可选 entry id 列表、不可解析行数）。
- `packages/agent-adapters/src/{index,pi-gate-extension}.ts`：追加导出；gate 新增 `session_shutdown` 上报
  （**仅作附加证据**，FOUNDATION-040 实测不可靠，任何判定都不依赖它）。
- `apps/runtime/src/terminal-service.ts`（新）：PTY 传输的 Runtime 侧——`launchTerminal`（用**记录的** start
  plan 拼 argv，权限模式经 argv 与 `CODEESTRA_PERMISSION_MODE` 双通道进入 provider）、`commitTerminal`、
  `view`（投影）、`read`/`write`、`attach`/`detach`（`ATTACHMENT_BUSY` 报出当前 holder）、`release`
  （release 字节 → 退出事实 → 刷新后的并集树归属核验 → session file 事实；退出码只入审计）、
  `stopTerminal`（结束终端并释放其 lease）、`close`（Runtime 关闭时 best-effort）、
  `noteProviderShutdown`、以及终端存活期间的进程树定时刷新（合并写回 incarnation）。
- `apps/runtime/src/session-handoff-service.ts`：`admitSuccessor` 现在真的完成交接（TUI 与 RPC 两个方向）；
  predecessor 仍 `ALIVE` 但由本 Runtime 持有时先协作停止再重新核验（`releaseAutomationProcess`）；
  新增 `EXECUTION_NOT_ACTIVE` 拒绝；新增 `releaseTerminal`（先持久化 RETURN 请求，再 release，再交还）、
  `attachTerminal`/`detachTerminal`/`readTerminal`/`writeTerminal`；`capabilities` 改为 `capabilitiesFor(platform)`
  的真实值；`close()` 顺带停止自己持有的终端。
- `apps/runtime/src/agent-runtime-service.ts`（追加，非本格独占文件）：`#handoffSafeAdapter` 在存在 open
  handoff 请求时**不把 settled 事实投影为 Execution 完成**（ADR-0010 D03），该 pump 也不结算 run Operation
  （对话由新 incarnation 继续，运行没有结束）；新增 `startAutomationSuccessor`（用记录的 start plan 在同一
  session file 上启动 RPC successor、核验 session file 未被换掉、启动观察循环）与 `AgentRuntimeServiceError`。
- `apps/runtime/src/adapter-registry.ts`：抽出 `piControlledLaunch`，让 RPC 与 PTY 两条传输共用同一份受控启动
  路径/platform/provider 可执行文件（避免两条传输漂移）。
- `packages/storage`：v18 additive 迁移 + `session_terminals`/`session_terminal_attachments` 的
  record/release/end/attach/detach/release-attachments 方法；追加 `markSessionIncarnationExited`（结束
  incarnation 同时清空 `current_incarnation_id`，旧决议立即 `STALE_INCARNATION`）、
  `mergeSessionIncarnationProcessTree`（按 pid 合并并集树）、`markSessionTerminalHandoffSafePoint`
  （终端 release 自己的安全点，不需要 fence）、`getAgentStartPlanForSession`。
- `apps/runtime/src/recovery-service.ts`（**尾部追加**）：`reconcileSessionTerminals` 把上一代仍 `RUNNING`
  的终端收敛为 `RECOVERY_REQUIRED`、关闭附加，并**报告**记录的 helper/provider pid（不杀、不猜）。
- `packages/contracts`：在 `session.handoff.*` group 内追加 `attach`/`detach`/`release`/
  `terminal.read`/`terminal.write` 五个严格请求（`admit` 增加 `commandId`）。
- `apps/cli/src/main.ts`：`session handoff attach|detach|release|terminal read|write`（默认 `--json`、稳定
  退出码：第二 writer `ATTACHMENT_BUSY` exit 1、detach 非自己的附加 exit 1、release 未确认或 successor 未启动
  exit 1）；usage 追加行。
- `apps/runtime/src/main.ts`：终端服务接线（`piExecutable`/`gateExtensionPath`/`questionExtensionPath` 来自
  `piControlledLaunch`）、`startAutomationSuccessor`/`releaseAutomationProcess` 回调、启动时
  `reconcileSessionTerminals` 与「未发信号的旧终端」报告、六个 dispatch 分支。

### 命令面（CLI 完备，可脚本化）

```text
session handoff status <project> <session>                       # 含 terminal 投影与 capabilities
session handoff request <project> <session> takeover|return      # 持久化意图 + 装 fence（takeover）
session handoff admit <project> <session>                        # 真交接：启动 TUI successor
session handoff attach <project> <session> --holder <ref> [--writer] [--since <cursor>]
session handoff detach <project> <session> --holder <ref>
session handoff release <project> <session> [--no-resume]         # 显式交还自动化
session handoff terminal read <project> <session> [--since <cursor>]
session handoff terminal write <project> <session> --text <text>
session handoff cancel <project> <session>
session handoff writer acquire|release ...
```

### 实际验证（全部 headless；未使用浏览器/桌面/键鼠自动化）

- `bun run check:fast`：通过（Vitest + 分层 Bun tests + 根/UI typecheck）。
- **`bun run check`：退出码 0** —— 根与 UI TypeScript、Vitest、**392 项 Bun tests（0 fail，47 个文件）**、
  UI Vite 构建。
- `packages/agent-adapters/test/pi-pty.test.ts`（7 项，真实 PTY + 真实进程表）：provider 真的拿到 tty 且
  `stty size` 读到 Runtime 申请的 `30 100`；cursor 单调、增量读只返回新字节；无人读取时 provider 继续产出且
  过期 cursor 被报 `truncated`（有界缓冲）；release 字节后退出事实（含 exit code）被观察到；**控制管道关闭
  即终止 provider**（Runtime 崩溃不留孤儿）；provider 被 SIGKILL 后仍活着的后代被报 `DESCENDANTS_ALIVE`，
  且该孤儿**确实在 3 秒后写入了工作区**（用 `nohup` 模拟忽略 SIGHUP 的工具子进程）；session file 事实与
  截断读；**生产 gate 扩展在 `mode: 'tui'` 下对真实 UNIX socket 的完整契约**（hello/STRICT 请求/ALLOW/
  fence 阻止新工具且不产生审批请求）。
- `apps/runtime/test/terminal-service.test.ts`（7 项，真实 PTY + fake provider）：终端进程身份与 session file
  事实入库、投影 cursor、`ATTACHMENT_BUSY` 报出 holder、observer 可多个、同 commandId 重放、detach 后
  provider pid 不变且仍可写、reattach、未授权 detach 为 `NOT_ATTACHED`；**release 在 provider exit code 7 下
  仍 `released: true`**（退出码只入审计）、release 证据（字节/命令/退出/两段 session file 事实）落库；
  `RELEASE_NOT_CONFIRMED` 时不杀 provider 且终端仍是 writer；`SESSION_FILE_REWRITTEN` 拒绝；后代仍活时拒绝
  release；重启 reconcile → `RECOVERY_REQUIRED` 并报告 pid（幂等）；incarnation 链（`AUTOMATED_RPC` EXITED →
  `HUMAN_TUI` ACTIVE，同一 session file，单 lease 移交）与结束终端后 lease 释放。
- `apps/runtime/test/cli-session-attach.test.ts`（1 项，62 个断言；真实 CLI + 真实 Runtime + 真实 PTY +
  协议 stub provider）：`request takeover` → 安全点 → `admit` **真启动 `HUMAN_TUI`**（`successorStarted: true`、
  `terminalTransport: 'PTY'`、同一 session file、lease 变为 `TERMINAL_ATTACHMENT`、**Execution 仍 `RUNNING`**，
  即 settled 未把 Execution 记成完成）→ `terminal read/write` 经 CLI 往返 → 第二 writer `ATTACHMENT_BUSY`
  exit 1、observer 成功 → `detach` 后 provider pid 不变、reattach 成功、未授权 detach exit 1 →
  `release` 在 exit code 7 下 `released: true`、successor RPC 从**同一** session file 继续
  （`tui-release-entry` + `rpc-return-entry` 追加、provider 报告 `resumed: true`）、incarnation 链
  `RPC → TUI → RPC` 可追溯 → 重复 `admit` **回放**（`replayed: true`）且不产生第四个 incarnation →
  已释放终端再次 release 为 `TERMINAL_NOT_RUNNING` exit 1。
- **真实 Pi 0.84.4（headless，脚本在 `/tmp`，不入库）**：
  - 真实 `pi` 原生 TUI 在本格的 PTY helper 下运行：拿到真实 tty、`stty size` 为 Runtime 申请的 `100 30`、
    4 秒内投影 7979 字节并渲染出 `pi v0.84.4` 启动界面与 `[Extensions]` 段；**Ctrl+D（release 字节）→ exit 0**。
  - 真实 TUI 中**生产 gate 扩展**在 Runtime side channel 上 hello：`{"kind":"hello","protocol":1,"mode":"tui",
    "hasUI":true,"permissionMode":"FULL","pid":58859,"providerSessionId":"01a09ee2-…","providerSessionFile":"…"}`，
    其 `pid` 与本格记录的 provider pid 一致（incarnation 身份核验对真实 provider 成立）；随后 Runtime 下发
    `{"kind":"fence","active":true}`，真实 TUI 回 `{"kind":"fence_ack","active":true}`——**补上了 FOUNDATION-043
    遗留的「生产 gate 在 TUI 模式未复验」缺口**（当时只验证过 spike 专用扩展）。
- 迁移验证：本格分支上（临时脚本，不入库）v15 库 additive 升级到 v16 后 `user_version` = 16、两张新表存在、
  `PRAGMA foreign_key_check` 无违规。**集成后按 v18 重新验证**（`apps/runtime/test/verification-cancel.test.ts`，
  随集成全量检查执行）：标记 16 的库升级到 18（v17 重建 + v18 两张新表都在、`foreign_key_check` 无违规），
  标记 17 的库（本格 C3 先合入后 dev 的真实形态）只跑 v18 一步。

### 待用户人工确认（本格无法自行完成）

- **TUI 画面目视确认**：真实 Pi 启动界面、键入、resize 后的显示效果需要用户在场目视（headless 只能断言字节流
  中存在渲染内容）。用户在本格中途中断了 PTY 探针，因此**没有**做目视确认。
- 真实模型在 TUI 中键入消息后 `release` 交还 RPC 继续同一 conversation 的完整复验（本格用 stub 验证了编排与
  同一 session file 的续接；FOUNDATION-040 已用真实模型验证过 session file 双向恢复）。

### 未验证（不得当成已成立）

- 跨交接的权限模式/工具集**完整矩阵**（两条传输的 argv 确由同一 `piControlledLaunch` 与同一拼装函数产生，
  但只测了 FULL 的成对转换；`capabilities` 报 `PARTIAL`）。
- 并行工具批次下的安全点（`UNVERIFIED`）、compaction、长会话/大 session file（`SESSION_FILE_TRUNCATED_READ`
  会拒绝交还，未实测真实大文件）、**PTY resize**（不支持；初始尺寸经 `stty` 应用）、Windows、其他 provider。
- 真实 provider 崩溃点注入（在 TUI 启动前后、release 前后 SIGKILL Runtime/helper）仍未做；本格只覆盖了
  「Runtime 崩溃 → helper 终止 provider」这一条（单元测试）与重启 reconcile。
- `session handoff admit` 的重放在**同一进程内**幂等；跨 Runtime 重启后请求会被 reconcile 成
  `RECOVERY_REQUIRED`（沿用 ADR-0023 D05），未做「重启后继续未完成交接」。

### 未做 / 明确不支持（不得静默降级）

- `attachToLiveRpcProcess`：仍 `UNSUPPORTED`（Pi 没有把原生 TUI 附加到运行中 RPC 进程的原语）。
- `ptyResize`、`windows`、`sessionCompactionDuringHandoff`：`UNSUPPORTED`。
- 不新增任何权限门禁或审批层；FULL 的常态路径确认数仍为 0（`admit`/`attach`/`detach`/`release` 都不确认）。
- **UI 终端不做**（`apps/ui/**` 本波属 C3 格，未改动一行）。

### 交付边界与权衡

- 改动文件：`packages/agent-adapters/src/{pi-pty,pi-pty-host,pi-session-file,pi-gate-extension,index}.ts`、
  `packages/storage/src/{migration,database,index}.ts`、`packages/contracts/src/index.ts`、
  `apps/runtime/src/{terminal-service,session-handoff-service,agent-runtime-service,adapter-registry,recovery-service,main}.ts`、
  `apps/cli/src/main.ts`、三个新测试文件、`package.json`（新测试加入既有分层清单）、
  `packages/storage/test/task-dependencies.test.ts` 与 `apps/runtime/test/{session-handoff-service,cli-session-handoff}.test.ts`
  的机械修正（schema 常量断言改为 `>= 15`；capabilities 与「admit 只判定」的旧断言改为新语义）、
  `docs/decisions/0026-*.md`、`docs/decisions/README.md`、本文件。**未修改** `apps/ui/**`、
  `packages/agent-adapters/src/pi-adapter.ts`、`apps/runtime/src/agent-observation-service.ts`、
  `packages/domain/**`、`apps/runtime/src/lifecycle.ts`、`packages/git/**`、`PROJECT_SPEC.md`、`AGENTS.md`。
- 越出「只按槽位插入」的地方（明确记录，供集成方复核）：`agent-runtime-service.ts` 追加了 settled 抑制与
  successor 启动（RPC successor 必须由其拥有；Wave C 无其他格占该文件）；`adapter-registry.ts` 抽出
  `piControlledLaunch`；`recovery-service.ts`、`main.ts`、`contracts`、`cli/main.ts`、`migration.ts`、
  `database.ts` 均按槽位追加。
- Runtime 停止路径：`SessionHandoffService.close()`（既有 shutdown 调用点）会请求停止本 Runtime 持有的终端；
  **保证**来自 helper 的「控制管道关闭即终止 provider」，因此不依赖 shutdown 是否 await。C1 格重写
  shutdown 绑定区时若要显式等待，可调用 `TerminalService.close()`（已导出、幂等）。
- 权衡：终端字节不落盘（ADR-0010 D06），因此 Runtime 重启后旧终端输出无法回溯，只能报 `RECOVERY_REQUIRED`；
  release 采用「不确认就不交还」的保守语义，代价是 provider 卡住时需要用户重试或 `cancel`。

### dev 集成（`abc0685`，手工合并；与 FOUNDATION-045/047 并排）

- **schema 改占 v18**：`migration.ts` 常量 18，步进顺序 `< 13 / < 14 / < 15 / < 17 / < 18`（v16 保持未使用）；
  两段迁移模板与各自分支逐字节一致（机械核对过），只有一个 `sessionTerminalMigration` 定义。
- **冲突解决**（都在 dev 工作树内，lane 不 rebase）：`migration.ts`（18 + 两个 `<` 步进）、`database.ts`
  （`migrate()` 两个门 + C2 的 562 行终端方法 + C3 的 `completeOperation` 改动都在）、
  `task-dependencies.test.ts`（版本断言保留双方理由）、`package.json`（`test:unit` 忽略清单与 `test:e2e` 文件表
  取并集）、`cli/main.ts`（C1 的 `stop`/`status` 段 + C2 的 handoff 段）、`docs/tasks/README.md`（045/046/047 升序
  + NEXT 第 2 条取 C3、第 3 条取 C2）。
- **超出纯并集的集成修正**（不在任何 lane 上，故在此记录）：
  - `cli/main.ts` 末段仍写着「admit 只记录判定、本版本没有 PTY 传输、从不启动 successor、从不移动 lease」，
    已被本合并证伪，改为描述实际行为（启动 PTY 终端或 RPC successor、失败先收束不留半成品、已 admit 的请求回放）。
  - `runtime/main.ts`：合并把 ADR-0023 的注释悬空在 ADR-0026 的终端接线之上，已放回 `SessionHandoffService`；
    shutdown 改为在 `handoff.close()` 与 `storage.close()` **之前** `await terminals.close()`，使 shutdown 时仍开着的
    终端被记为 `STOPPED`，而不是留下 `RUNNING` 行、下次启动只能报 `RECOVERY_REQUIRED`（硬杀仍由 helper 的
    「控制管道关闭即终止 provider」兜底；`TerminalService.close()` 幂等）。
  - `verification-cancel.test.ts`：两处版本字面量断言按 18 修正，v16 升级测试加一条 v18 生效断言，并新增
    「标记 17（v17 已跑）的库只跑 v18」的用例。
- **集成验证**（dev 工作树，即 merge commit 记录的树）：`bun install --frozen-lockfile` 后
  `bun run check` 退出码 0 —— 根与 UI TypeScript、231 项 Vitest、**415 项 Bun tests（0 fail，50 个文件）**、
  UI Vite 构建。未 push、未提升 `main`、未重启稳定 Runtime。
- **已知测试脆弱性（未掩盖）**：本格的 PTY 测试对机器负载敏感。本格分支上多次跑全量时出现间歇失败
  （`waitFor` 超时；一次是 `release` 返回 `released: false` 而非确认交还），单独跑与本次集成跑均全绿。
  排查时发现本格工作树基线早于 C1 的生命周期修复，先前测试运行留下了 **21 组 Runtime + stub-pi 孤儿进程**
  （`CODEESTRA_HOME` 指向 `codeestra-attach-home-*` 测试夹具）；已在核验归属后终止（只动本工作树夹具，稳定
  Runtime `65545` 未受影响）。孤儿清理后同一全量检查连续通过。**根因未最终定位**（怀疑并集进程树里
  短暂子进程的 `startToken` 为 null，PID 复用后使归属核验返回 `UNVERIFIED` → 保守拒绝），需后续单独跟进。
- **本次未覆盖**：真实模型在 TUI 中键入后交还 RPC 的复验、跨交接权限模式完整矩阵、并行工具批次安全点、
  PTY resize、compaction、大 session file、Windows、其他 provider、UI 终端（C3 领地）与 TUI 目视确认（需用户在场）。

## FOUNDATION-047 — verification run 的 `CANCELLED` 状态与长命令实时进度事件（ADR-0027，schema v17）

状态：**已提交并合入 `dev`**。lane commit `8629e28`（`lane/c3-verification-progress`，基线固定为 `dev@abec3f3`，未 rebase）→ dev merge `fadc094`（在 dev 工作树内 `--no-ff`；与 FOUNDATION-045 的并排冲突在 `docs/tasks/README.md` 与 `package.json` 合并保留）。合并前在 dev 的合并树上完成独立全量检查；**这是手工合并，不是产品 IntegrationBatch**。未 push、未提升 `main`、未重启稳定 Runtime。决策见 ADR-0027；本格只做 ADR-0019 明确留下的两项（「未实现（不得声称）」第 1、2 条），不新增任何确认门禁。

### 已实现

- `packages/storage`：schema **v17** 占用（新迁移 `verificationProgressMigration`）：
  - **重建** `verification_runs`（`verification_runs_v17` → 复制全部列/行 → `DROP` → `RENAME` → 重建 `verification_subject`/`verification_by_task` 索引），state CHECK 加入 `CANCELLED`，终态一致性 CHECK 扩充为「`PASSED`/`FAILED`/`ERROR`/`CANCELLED`/`STALE` 必须同时有 `ended_at` 与 `outcome_code`」。无表引用 `verification_runs`，因此无需关闭外键；迁移后 `PRAGMA foreign_key_check` 为空。
  - 新表 `operation_progress_events(operation_id, progress_sequence, event_id, dedup_key, phase, detail_json, recorded_at)`，`PRIMARY KEY(operation_id,progress_sequence)`、`UNIQUE(operation_id,dedup_key)`、`event_id UNIQUE`、`phase ∈ STEP|OUTPUT|CANCEL|SETTLED`，append-only。
  - `VerificationState` 增加 `'CANCELLED'`；`completeVerificationRun` 接受 `'CANCELLED'`，并在同一事务里写 `OperationSettled`；Operation 侧仍是 ADR-0019 词汇（`FAILED` + `cancelled: true`）。
  - 新增 `recordOperationProgressEvent`（幂等、单调、终态拒绝、与步骤行同事务）、`listOperationProgressEvents`（按 `progressSequence` 的排他游标读取）、私有 `publishOperationSettled`；`completeOperation` 对**曾发布过进度**的 Operation 追加发布 `OperationSettled`（从未发布进度的子 Operation 不进入进度流）。未改动任何既有方法签名；`migrate()` 只追加 `if (version < 17)`。
- `apps/runtime/src/verification-service.ts`：`VerificationExecutionCallbacks` 增加 `onOutput(chunk)`（`commandId`/`stream`/`chunkBytes`/`streamBytes`/`elapsedMs`，**只有大小与耗时**），`captureStream` 按块回调，`runCommand`/`executeVerificationPolicy`/`executeQueuedVerification` 透传；取消路径与副本保留语义不变。
- `apps/runtime/src/operation-service.ts`：`recordRunStep` 改为「步骤行 + 进度事件」同事务发布；`#launchVerification` 增加输出块事件并按命令最小间隔合并（`outputProgressIntervalMs`，默认 100ms；每个命令的首块总是发布，块计数按命令而非按 stream）；`#cancelVerification` 落 `CANCELLED`/`CANCELLED_BY_USER`（未确认静止仍 `RECONCILE_REQUIRED` + run 保持 `RUNNING`）；`#cancelRun`/`reconcileRunOperations`/`#completeIfOpen` 的终态写入都会发布 settle 事实。
- `apps/runtime/src/reclaim-service.ts`（**领地外的最小改动**）：`CANCELLED` 视同 `FAILED`/`ERROR` 的 failure scene，默认 `RETAIN/FAILURE_SCENE`，`--include-failure-scenes` 才 `FAILURE_SCENE_INCLUDED`；仍然 `QUEUED`/`RUNNING` 一律 `REFUSE/ACTIVE_VERIFICATION`。
- `apps/ui/src/{App.tsx,types.ts}`：新增进度事件的结构化校验（**拒绝任何 `verdict !== false` 的 payload**）与增量合并（`STEP`/`CANCEL` 按 `stepKey` 合并去重、`OUTPUT` 只刷新「最新输出」一行、`SETTLED` 更新状态并触发一次同命令面详情读取）；轮询从「常态 1.5s」改为「仅当存在非终态 Operation **且事件流不是 `live`** 时 5s 兜底」；Operation 行按 `result.cancelled` 显示「已取消（用户）」，`tasks verification` 表的 `CANCELLED` 用「已取消」+ 新增 `.state-cancelled`（warn 色）区别于 `FAILED`/`ERROR` 的 danger 色。`apps/ui/src/styles.css` 只加这一条规则。
- `apps/cli/src/main.ts`：`task operation list|get` 人类视图对取消的 Operation 打印「已取消（用户）」；`usage()` 增加一段说明「进度是事件，从 `events tail` 读，进度事件不携带判定」。
- `packages/contracts`：**未改动**。命令面没有新 flag/新命令，事件 payload 沿用既有 `payload: unknown` 约定（`OperationProgressed`/`OperationSettled` 的类型在 Runtime 写出侧定义、在读侧结构化校验），因此没有需要追加的请求/响应 schema。
- `apps/runtime/src/main.ts`：**未改动**（进度事件由 storage/operation-service 写出，`task.status` 与 dispatch 分支无需变化）。**未改** `lifecycle.ts`、`session-handoff-service.ts`、`terminal-service.ts`、`agent-runtime-service.ts`、`agent-observation-service.ts`。
- `package.json`：只把两个新测试文件加入既有 `test:unit` 忽略清单与 `test:e2e` 清单（沿用 FOUNDATION-039 的分层做法）。

### 命令面已实测（CLI + 真实 Runtime + 独立 `CODEESTRA_HOME`）

- `bun test apps/runtime/test/cli-task-run-progress.test.ts`（真实 CLI 子进程 + 真实 Runtime + 临时仓库 + 协议 stub provider，2 项通过）：`task.run` 的进度事件经 `events list` 可读、`progressSequence` 单调、无 `state` 字段、settle 为 `verdict: false`；`task verify --background` → `task operation cancel` 后 `task status.verifications` 与 `task verification list` 都读到 `CANCELLED`（不再需要从 `ERROR` 猜），`events list` 读到 `VERIFICATION_QUEUED`/`VERIFICATION_COPY_CREATED`/`COMMAND:slow:STARTED`/`CANCEL_REQUESTED` 与一次 `OperationSettled`，`dev` 未移动、Task 仍 `EXECUTED`。
- 手工隔离复验（`CODEESTRA_HOME=/tmp/ce-c3`，临时仓库 + `dev` 分支 + 真实 Runtime 进程；用失败的 `pi` stub 让 `task.run` 在版本探测处结束，避免真实模型）：
  - 新库 `PRAGMA user_version = 17`、`verification_runs` 的 CHECK 含 `CANCELLED`、`operation_progress_events` 存在、`foreign_key_check` 为空；
  - `events tail --project <id>`（真实 socket 订阅）收到：`seq=4 OperationProgressed progressSequence=0 stepKey=RUN_REQUESTED verdict=false` → `seq=5 … stepKey=RUN_FAILED verdict=false` → `seq=6 OperationSettled operationState=FAILED verdict=false`；
  - `task operation list` 人类视图按序打印两条步骤，`task status` 的 `operations` 投影给出同一份数据。
- 以上均为 CLI/命令面与 socket/HTTP-SSE 断言；未使用浏览器/桌面/键鼠自动化。UI 的视觉、键盘焦点、窄屏与取消按钮观感**仍需用户人工确认**（`bun run check` 通过不等于 UI 验收）。

### 实际跑过的检查与结果

- `bun run check:fast` 退出码 0（根 typecheck + UI typecheck + 231 项 Vitest + 229 项 unit Bun tests 0 fail）。
- lane 上 `bun run check` 退出码 0：根与 UI `tsc --noEmit`、231 项 Vitest、**389 项 Bun tests 0 fail**（46 个文件）、UI Vite 构建成功。本格未改 `packages/domain`/`packages/contracts`，Vitest 数量与本格无关。
- dev 合并树上的独立集成检查 `bun run check` 退出码 0：根与 UI typecheck、231 项 Vitest、**399 项 Bun tests 0 fail**（47 个文件，包含 FOUNDATION-045 的 10 项 Runtime lifecycle 测试）、UI Vite 构建成功；验证通过后才创建 merge commit `fadc094`。
- 新增/更新的测试：
  - `apps/runtime/test/verification-cancel.test.ts`（4 项通过）：v16→v17 迁移保留行/索引/`foreign_key_check`；`CANCELLED` 缺少 `ended_at`/`outcome_code` 被拒、`QUEUED` 带终态事实被拒；已在 17 时不重跑；确认静止 → `CANCELLED` + 副本保留 + `listVerificationRuns` 表达 + `reclaim` 默认保留/显式才回收；未确认静止 → run 仍 `RUNNING` + Operation `RECONCILE_REQUIRED` + `reclaim` `REFUSE/ACTIVE_VERIFICATION`。
  - `apps/runtime/test/operation-progress-events.test.ts`（8 项通过）：顺序/幂等/排他游标/终态后不再发布（步骤仍记录）/订阅可达/HTTP-SSE 可达；验证输出块事件（间隔 0）字节递增且不含输出文本；默认间隔合并为 1 条而终止步骤带真实总字节数；后台受理后进度里没有 `PASSED`；`task.run` 五步 + 一次 settle 且无 `PASSED`；未发布进度的 Operation 不进入进度流。
  - 更新既有测试：`operation-service.test.ts`（取消确认 → `CANCELLED`）、`cli-task-run-progress.test.ts`（按 `CANCELLED` 读取 + `events list` 断言）、`packages/storage/test/task-dependencies.test.ts`（把 `phase1SchemaVersion` 的字面量 15 改为 `≥ 15`，与 A1 的既有写法一致）。
- **未执行**：真实 provider 下的后台验证/取消复验（本轮只用协议 stub 与注入的 fake）；浏览器/桌面/键鼠自动化（仓库禁止）；UI 目视确认。

### 交付边界与剩余问题

- **占用了 schema v17**。本次先于预留 v16 的 C2 schema 改动合入，因此本格合入时 dev 是 `phase1SchemaVersion = 17` 且没有 v16 迁移。数据库现在可能已被标记为 17，后续不得再插入 `if (version < 16)`（它会被既有 v17 数据库跳过）；C2 若需要 schema 变更必须使用下一个高于 17 的版本并提供相应升级测试。v16 保持未使用。**（已按此规则执行：C2 于 `abc0685` 以 v18 合入，见 FOUNDATION-046；当前 dev 的 `phase1SchemaVersion` = 18。）**
- **领地外的最小改动（需在交付说明中保留）**：`apps/runtime/src/reclaim-service.ts`（加 `CANCELLED` 到 failure scene，1 处分支）、`packages/storage/src/index.ts`（导出新迁移）、`packages/storage/src/database.ts` 的既有 `completeOperation`（对发布过进度的 Operation 追加 settle 事件，见 ADR-0027 D04）、`apps/ui/src/styles.css`（1 条 `.state-cancelled`）、`package.json`（测试分层清单）、以及 3 个既有测试文件的断言更新（其中 `task-dependencies.test.ts` 的字面量版本断言在 C2 的 v16 合入后必然失败）。
- **剩余（不得声称已完成）**：
  - `task.run` 的进度是步骤级 + settle，不含 provider 事件级进度；provider token/PTY 字节按 event-model §4 与 ADR-0013 永不进入 domain event（细粒度通道仍是只读的 `session.transcript`）。要加 provider 事件级进度需要 `agent-runtime-service.ts`/`agent-observation-service.ts`（C4 槽位），本格未改。
  - `integration_verification_runs` 没有 `CANCELLED` 状态（其 Operation kind 不可经 `task.operation.cancel` 触达）。
  - 重启时仍 `RUNNING` 的 run（含取消未确认）记 `ERROR/RUNTIME_RESTARTED`，不是 `CANCELLED`——重启无法证明静止。
  - 默认 100ms 合并会丢弃部分输出块观测（活跃度事实，不是完整输出日志）。
  - **`docs/architecture/state-machines.md` §1 的 Task Verification 状态列表与 `docs/architecture/event-model.md` §2 的事件目录尚未同步 `CANCELLED` 与 `OperationProgressed`/`OperationSettled`**；按 ADR-0019 的先例本格不动架构文档，已在 ADR-0027 显式记录该不一致，需一次 doc-sync。
  - 事件量未做并发/压力测量；未测多客户端同时订阅同一长命令的负载。

## FOUNDATION-048 — revision 投递确认与重启后 stale ACTIVE Session 的启动收敛（ADR-0028）

状态：**已实现、已提交并合入 `dev`**（CLI/命令面测试）；lane commit `dcd185c`（`lane/d1-revision-delivery`，基线固定 `dev@77eaf678`，未 rebase）→ dev merge `0c960ad`（在 dev 工作树内 `--no-ff`，与 FOUNDATION-049/050 无文件冲突），集成详情见下方「Wave D 集成记录」。**已 push：否**、未提升 `main`、未重启稳定 Runtime。**本轮占用 schema v19**（只追加 `if (version < 19)`，既有段一字未动；**v16 继续永久未使用**，未新增 `version < 16`）。

用户本轮没有做 A/B/C 选择：本格的两件事早已是 `## NEXT` 第 4 项，实现方式由已确认的原则与 spike 事实决定（§1.1 效率至上与 CLI 完备、ADR-0001 的停止并新建 Execution fallback、ADR-0010/0023 的单 writer 与归属核验、ADR-0021 的失败现场、`docs/spikes/pi-0.84.4.md` 的 `revisionAcknowledgement = UNSUPPORTED`）。选项与取舍逐条记在 ADR-0028 的 Options/Decision 中，若用户要另一种语义可以在下一轮推翻。

### 已实现

- `packages/domain/src/revision-delivery.ts`（新）：投递 FSM。satisfied **只有** `ACKNOWLEDGED`（带 Adapter 结构化 evidence）与 `SUPERSEDED_BY_RESTART`（successor 行被证）；stale ACK → `STALE_REVISION_ACKNOWLEDGEMENT`，重复 ACK/重复开 attempt → `REVISION_ALREADY_ACKNOWLEDGED`，successor revision 不符 → `SUCCESSOR_REVISION_MISMATCH`；`packages/domain/src/errors.ts` 新增这三个稳定错误码（纯追加）。
- `packages/storage/src/migration.ts`：`phase1SchemaVersion` 18 → 19，新增 additive `revisionDeliveryMigration`：`task_revision_deliveries`（需求 + FSM 状态 + 通道/期限/证据 + `version` 乐观版本 + ack 时间戳 CHECK）、`task_revision_delivery_attempts`（append-only 尝试台账：通道、Execution/Session/incarnation、起止时间、结果、error_code、`IN_FLIGHT ⇔ ended_at IS NULL`）、`agent_session_startup_reconciliations`（append-only 收敛台账）。
- `packages/storage/src/database.ts`（只追加）：`createTaskRevision`（append-only revision + 移动 current_revision_id + 有运行中 Execution 时同事务记投递需求）、`listTaskRevisions`、`listTaskRevisionDeliveries`/`getTaskRevisionDelivery`/`findUnsatisfiedRevisionDelivery`、`beginRevisionDeliveryAttempt`/`completeRevisionDeliveryAttempt`（状态推进全走领域 FSM；stale ACK 回滚后把尝试就地记 `FAILED`，不留悬挂 in-flight）、`resolveRevisionDeliveryByRestart`（同事务读回 successor Execution 的 `applied_revision_id` 才标记满足）、`listExpiredRevisionDeliveryAttempts`/`listInFlightRevisionDeliveryAttempts`、`listStaleAgentSessions`/`convergeStaleAgentSession`/`listAgentSessionStartupReconciliations`。
- `apps/runtime/src/revision-delivery-service.ts`（新）：能力门控的会话投递（实时 `probe()`；非 SUPPORTED / 缺 `applyRevision` 端口 / 非 live Session 分别如实记 `CHANNEL_UNSUPPORTED`，无 evidence 的 ACK 记 `UNACKNOWLEDGED/MISSING_ACK_EVIDENCE`，`withDeadline` 超时记 `TIMED_OUT`）、显式处置（`stop-and-restart` 复用 ADR-0016 的协作停止 + 既有 `resumePausedTask`；停止不能确认则 `RECOVERY_REQUIRED`）、启动收口（`reconcileAtStartup`）。
- `apps/runtime/src/recovery-service.ts`（尾部追加）：`reconcileStaleAgentSessions`——按记录的 pid+start token 判所有权，一律收敛为 `DISCONNECTED`/`RECOVERY_REQUIRED`，不写 RUNNING、不声称静止、不发信号不杀进程、不删任何资源，观察值写 append-only 台账 + 四类事件，幂等且不碰本代 Runtime 仍持有的 Session。
- `apps/runtime/src/agent-runtime-service.ts`：`startAutomationSuccessor` 在 Task 的 current revision 与该 Session 钉住的 revision 不一致时拒绝（`REVISION_NOT_ACKNOWLEDGED`）——否则交还自动化就是在未被确认的旧规格上恢复执行。`agent-observation-service.ts` 本格未改（该路径不需要改；结论已在 ADR-0028 写明）。
- `packages/contracts/src/index.ts`：新增 `task.revision.create|list|delivery.list|delivery.get|delivery.resolve` 五个严格请求（只追加在 union 末尾；**未动 adapter 能力区**，那是 D2 领地）。
- `apps/cli/src/main.ts`：`task revision create|list` 与 `task revision delivery list|get|resolve`（`--json`、稳定退出码：resolve 仅在确实满足时 0），usage 追加命令行。零新增确认。
- `apps/runtime/src/main.ts`：服务接线、启动 reconcile（在 `reconcileSessionHandoffs` 之前跑，以便台账记下 incarnation 的启动时状态）、自己的 dispatch 分支。

### 实际验证

- `bun run check:fast`：退出码 0 —— 根与 UI TypeScript、231 项 Vitest、250 项 unit Bun tests（0 fail）。
- `bun run check`：退出码 0 —— 根与 UI `tsc --noEmit`、231 项 Vitest、**439 项 Bun tests（0 fail，52 文件）**、UI Vite 构建。其中本格新增：`apps/runtime/test/revision-delivery.test.ts`（17 项）、`apps/runtime/test/stale-session-reconcile.test.ts`（7 项）；同时更新了 FOUNDATION-047 的 `verification-cancel.test.ts` 中两处写死 `phase1SchemaVersion === 18` 的断言（现为 19，因为本格占了 v19）。
- 真实 CLI + 真实 Runtime + 独立 `CODEESTRA_HOME` + 协议 stub provider 的端到端：`task revision create`（未确认投递）→ `revision list`/`delivery list` → `task result capture` 被 `STALE_REVISION` 拒绝（exit 1）→ `delivery resolve --action retry`（exit 1，`UNSATISFIED`）→ `delivery resolve --action stop-and-restart`（exit 0，`SUPERSEDED_BY_RESTART`，successor revision = 新 revision）→ `delivery get` 回到 `satisfied: true`。
- 收敛路径：stale 投影收敛后用**真实进程**验证「provider 仍在跑时不发信号」（`sleep 60` 在收敛后仍活着，由测试自己回收），以及 `PROVIDER_STOPPED`/`PROVIDER_OWNERSHIP_UNVERIFIABLE`/`PROCESS_IDENTITY_MISSING` 三个分支与 lease/incarnation 残留、重复启动幂等。
- 迁移：真实 SQLite 上 v18 → v19 与 v16 → v19 两种历史库 additive 升级，既有行保留、三张新表存在、`foreign_key_check` 空。
- 本格没有真实 provider 参与（无 Adapter 实现 `applyRevision`，Pi 仍 `UNSUPPORTED`），因此**没有**验证真实 provider 的 ACK 行为。

### 未验证（不得当成已成立）

- 真实 Provider 的 revision ACK：没有任何 Adapter 实现 `applyRevision`；`capabilities.revisionAcknowledgement` 对 Pi 仍是 `UNSUPPORTED`。脚本 Adapter 只证明「能力为 SUPPORTED 且端口返回 evidence 时才记 ACK」的编排与守卫，**不能**证明真实 Agent 能确认新规格。
- 真实 provider 在 stop-and-restart 下复用同一 conversation（stub 只证明编排与 `sessionStorageRef` 参数的传递；真实 session file 双向恢复由 FOUNDATION-040 单独验证过）。
- 修订期间未决 Attention 的顺序、实时 UI 投影（D3 领地）与 `task revision *` 的 UI 面。
- 本格未改动 `packages/agent-adapters/**`、`apps/ui/**`、`packages/git/**`、`terminal-service.ts`、`session-handoff-service.ts`、`session-transcript-service.ts`、`agent-answer-service.ts`、`task-control-service.ts`（只调用其导出）；未改 `packages/storage/src/database.ts` 的任何既有方法或 `migrate()` 既有分支。

## FOUNDATION-049 — 第二个真实 Adapter：Codex 接入（ADR-0029）

状态：**已实现、已提交并合入 `dev`**（CLI/命令面测试 + 真实 Codex smoke）。lane commit `cd9bf1b`（`lane/d2-codex-adapter`，基线固定 `dev@77eaf67`）→ dev merge `6688766`；详见下方「Wave D 集成记录」。**未使用 schema 迁移**（v19 归 D1），未 rebase、未合并新 dev、未 push、未提升 `main`、未触碰稳定工作树。

本格成果分三档证据，正文按此分级：

- **真实集成已验证**：`codex-cli 0.151.0` + 真实 ChatGPT 登录 + 真实模型 `gpt-5.5` 下的 `CodexAdapter` 本体
  smoke（probe / STRICT gate allow / FULL 零确认 / 完成证据 / 进程身份 / 跨进程 `thread/resume`）。
- **仅 stub 验证**：Adapter 的失败映射细节（协议 stub）与全部 CLI 命令面流程（stub provider）。
- **不支持/未验证**：attach、PTY handoff、pause、revision ACK、live process reconnect、受控配置隔离；
  以及 Runtime 侧 `FAILED → READY` 缺失导致的「失败后换 Agent」缺口（见下）。

### Spike 与实测（`docs/spikes/codex-0.151.0.md`）

先 spike 后实现。用真实 provider 实测了两种程序化接口，并选定传输：

- `codex exec --json`：单向 JSONL 事件（`thread.started` / `turn.started` / `item.completed` /
  `turn.completed` / `turn.failed` / `error`），无审批应答、无结构化提问、无 interrupt；`codex exec resume
  <thread-id>` 可恢复 conversation（实测复述前一轮 token）。
- `codex app-server --stdio`：**LF-JSONL / JSON-RPC 2.0 双向通道**（可用 `codex app-server
  generate-json-schema` 自描述，262 个 v2 schema 文件）。实测：
  - 审批 fail-closed：`item/commandExecution/requestApproval` 在应答前命令不执行；`decline` →
    `status:"declined"`、`exitCode:null`；`accept` → 命令执行、`exitCode:0`、文件真的写入。
  - `turn/interrupt` 立即返回 `turn/completed status:"interrupted"`，但**已在跑的 shell 工具继续运行并正常
    `exit 0`**（interrupt 之后 marker 才落盘）。
  - 对 app-server 发 `SIGTERM` **不会**终止在跑的工具：孤儿继续运行并写入工作区（与 FOUNDATION-040 对 Pi 的
    测量一致）。
  - 跨进程 `thread/resume {threadId}` 恢复同 thread id、同 rollout 路径、同 conversation（实测模型复述
    secret）。
  - `item/tool/requestUserInput`（结构化提问）**默认模式下工具不可用**，需
    `--enable default_mode_request_user_input`（under development）才实测可触发并接受结构化答案。
  - `app-server` 没有 `--ignore-user-config`；`-c mcp_servers={}` 也未阻止 ambient plugin/MCP 与
    `~/.codex/hooks.json` 参与，rollout 里能看到 provider 自带的 `<recommended_plugins>` 片段进入模型输入。

### 已实现

- `packages/agent-adapters/src/codex-protocol.ts`（新）：LF-JSONL framing/解码、受控 argv
  （`app-server --stdio [-c model_reasoning_effort=<level>] [--enable default_mode_request_user_input]`）、
  FULL/STRICT → `approvalPolicy`/`sandbox` 映射、`thread`/`turn` payload 解析、审批与提问的 prompt 构造、
  `{decision}`/`answers` 编码。无法承载的语义在此显式抛 `UNSUPPORTED_ANSWER`，不猜测。
- `packages/agent-adapters/src/codex-process.ts`（新）：一个 app-server 子进程的 stdio 所有权、请求/响应
  关联、**服务端→客户端请求不自动应答**（挂起即 fail-closed）、`blockedWriters` 无关的 stderr 摘要、
  stop（SIGTERM→SIGKILL 并只按 OS 事实报告退出）。
- `packages/agent-adapters/src/codex-adapter.ts`（新）：实现既有 `AgentAnswerAdapter` +
  `AgentProcessRelease`，`adapterId = 'codex'`。FULL/STRICT 策略、revision/resume prompt、进程身份
  （pid + start token + argv hash）、attention/完成/断连映射、typed answer 写回、resume 归属与身份核对。
- `packages/contracts/src/index.ts`：**只改 adapter 能力/配置区** —— `AdapterCapabilities` 新增
  `controlledConfiguration`（Pi `SUPPORTED`、Codex `UNSUPPORTED`、fake 显式声明），
  `agentConfigurationEnvironmentVariables` 新增 `codex`（`CODEESTRA_CODEX_{PROVIDER,MODEL,THINKING}`）。
  未触碰 `task.*`/`session.handoff.*`/`promotion.*` 命令定义。
- `apps/runtime/src/adapter-registry.ts`：`createPiAdapterRegistry` → `createAdapterRegistry`，同时注册 Pi 与
  Codex（`CODEESTRA_CODEX_EXECUTABLE` / `CODEESTRA_CODEX_HOME` / `CODEESTRA_CODEX_REQUEST_USER_INPUT`）。
- `apps/runtime/src/main.ts`：仅注册接线（一行改名调用）。
- `apps/cli/src/main.ts`：`task run` usage 列出可用 adapter；`task resume` 新增可选 `--adapter`
  （默认仍是 `pi`，行为不变）。
- `packages/agent-adapters/test/codex-adapter.test.ts`（新，21 项）与
  `apps/runtime/test/cli-codex-adapter.test.ts`（新，5 项）。

### 能力矩阵（实测填写，写进 `capabilities()`）

| 能力 | Codex 0.151.0 | 依据 |
|---|---|---|
| persistentSession | `SUPPORTED` | thread id + rollout 文件，跨进程恢复实测 |
| structuredAttention | `SUPPORTED`（开启 `--enable default_mode_request_user_input` 时）/ `UNSUPPORTED`（默认） | 默认模式下 provider 报 `request_user_input is unavailable in Default mode` |
| nativePermissionRouting | `SUPPORTED` | 命令级审批 fail-closed，allow/deny 两条路径真实实测 |
| pauseWithQuiescence | `UNSUPPORTED` | 无 pause/resume 原语 |
| revisionAcknowledgement | `UNSUPPORTED` | 无确认通道；不从自然语言推断 ACK |
| cooperativeStop | `REQUIRES_VALIDATION` | interrupt 不停工具、杀 app-server 留孤儿（实测） |
| attach | `UNSUPPORTED` | 交互 TUI 走共享 app-server daemon，与我们的 stdio 子进程不是同一 writer |
| reconnectToLiveSession | `UNSUPPORTED` | 丢失 stdio 后不重新接管 live 进程 |
| resumeAfterExit | `SUPPORTED` | `thread/resume` 实测同 thread/同 rollout 路径 |
| controlledConfiguration | `UNSUPPORTED` | 无 `--ignore-user-config`；ambient plugin/MCP/hook 参与执行 |

Pi 的 attach / PTY handoff / incarnation（ADR-0010/0023/0026）**没有**被套用到 Codex；能力矩阵与代码里都
明确写 `UNSUPPORTED`，也没有静默降级路径。

### 失败后换 Agent（含实测缺口，必须如实读）

- **成立**：每次 Execution 只有一个主 Agent；换 Agent 必须新建 Execution（无热切换）。实测：`task run
  --adapter codex` 在 provider probe 阶段失败（可执行文件不存在）后，Task 保持 `READY`、没有 Execution 行，
  随后 `task run --adapter pi` 建立**新的** Execution 并成功。
- **成立**：pause → `task resume --adapter codex` 重开 predecessor 的 thread（stub 收到 `thread/resume`）；
  `task resume --adapter pi` 被 fail-closed 拒绝（`AGENT_START_FAILED: The resumed session file is not inside
  the Runtime Pi session directory`）——即跨 provider 恢复不会悄悄开一段新对话。
- **缺口（本格领地外，未修）**：Runtime 目前没有 `FAILED → READY` 的路径。实测 `task run` 一个 FAILED Task
  返回 `INVALID_STATE: Workspace cannot be reserved while Task is FAILED`（`task resume` 同样拒绝）。因此
  Phase 5 的「失败后新 Execution 可更换 Agent」目前只在 **Execution 建立之前失败** 与 **pause→resume** 两条
  既有路径上成立；要覆盖「Execution 失败后换 Agent」需要 domain/scheduler/storage 的 retry/requeue 决策
  （D1 领地），已在 ADR-0029 D07 记录，不由本格抢改。

### 实际跑过的检查与结果

- `bun run check`（**提交前全量，退出码 0**）：`tsc --noEmit`（root + UI）通过；Vitest 231 passed（3 文件）；
  Bun 441 pass / 0 fail（52 文件，含本格新增 21 + 5 项）；`vite build` 通过。
- 开发循环中另跑过 `bun run check:fast`（同上前三步）：268 pass / 0 fail（27 文件）——与全量的差异来自
  `test:storage` 分层。
- 真实 smoke（`/tmp/ce-d2-spike/adapter-smoke.ts`、`adapter-resume-smoke.ts`，真实 `codex` + `gpt-5.5`）：
  FULL `attentions=0` + `SUCCESS`；STRICT `attentions=1` + `answer(accept)` + `SUCCESS` 且命令目标文件真的
  生成；两个独立 Adapter 实例 resume 得到 `same-thread=true same-path=true`，同一 rollout 文件内可见 p1
  与 p2 两轮 prompt。
- 未使用浏览器/桌面/键鼠自动化；全部驱动都是 CLI/命令面与 headless 脚本。

### 未做 / 不声称

- 未用真实模型跑完整 CLI 流程（`task run --adapter codex` 对真实 provider）：真实 provider 只用于 Adapter
  本体 smoke；CLI 流程是 stub 证据。**stub 不是真实集成验收。**
- 未验证：`item/fileChange/requestApproval` 与 `item/permissions/requestApproval` 的真实触发、多工具批次下
  的 interrupt、Windows、Codex 升级后的协议兼容（app-server 标注 experimental）、`mcpServer/elicitation`
  的真实语义。
- 不支持：attach、PTY/handoff、pause/resume、revision ACK、reconnect live、完全受控启动；不使用
  `dangerously-bypass-*`；不修改用户 `~/.codex` 配置或凭据，不打印 token。
- **provider 会改自己的全局配置（实测，已还原）**：在 `/tmp/ce-d2-spike/repo` 首次 `codex exec` 后，
  Codex 自行向 `~/.codex/config.toml` 追加了 `[projects."/private/tmp/ce-d2-spike/repo"] trust_level =
  "trusted"`（人类可读 diff 只有这 3 行，见 spike §3.9）。本格没有手工写该文件；spike 结束时按预期把该 3 行
  移除并核对了文件回到 spike 前状态，用户的凭据文件未被读打印、未被复制。本格创建的 18 个 Codex session
  也已用 `codex delete --force` 删除。
- 领地外的最小改动（需在交付说明中保留）：`apps/runtime/test/adapter-registry.test.ts`（registry 现在注册
  两个 adapter，改断言）、`apps/runtime/test/{agent-runtime-service,operation-service,task-control-service}.test.ts`
  （三处内联 capability 字面量补齐新必填字段）、`apps/cli/src/main.ts`（`task resume --adapter` + usage）。
- **已知文档不一致（需一次 doc-sync）**：`docs/architecture/agent-adapter-api.md` 的类型清单仍未包含新增的
  `controlledConfiguration`（沿用 ADR-0019/0027 先例：不在本格改架构文档，已在 ADR-0029 显式记录）。

## FOUNDATION-050 — 原生终端的 UI 投影 + 会话交接/依赖/提升投影补全（纯投影，无新 ADR）

状态：**已实现、已提交并合入 `dev`**。lane commit `62f49aa`（`lane/d3-terminal-ui`，基线固定
`dev@77eaf678a13d955fe7f01cba160cd5e9302f3fab`）→ dev merge `87d2c7e`；详见下方「Wave D 集成记录」。
未 rebase、未合并新 dev、未 push、未提升 `main`、未重启稳定 Runtime。**未新增 ADR**：本格只把已经存在于 CLI
命令面的能力做成 UI 投影，不新增 Runtime 语义、不新增确认步骤、不改后端契约（`apps/runtime/**`、
`apps/cli/**`、`packages/**`、架构文档、`PROJECT_SPEC.md`、`AGENTS.md` 一行未改）。

### 已实现

- `apps/ui/src/terminal.tsx`（新）：`TerminalPanel`——一个 Session 的会话交接与原生终端。全部走同一命令面：
  - **接管**：`session.handoff.request takeover` → 显示安全点/ fence 事实（`safePoint.missing` 原样列出）→
    `session.handoff.admit`（`admitted`/`successorStarted`/`terminalTransport`/`successorIncarnation` 原样呈现，
    拒绝时显示 code + detail，**不显示成已接管**）→ `session.handoff.cancel` 释放 fence。
  - **附加身份**：`WRITER` / `OBSERVER` 可选，显示本客户端 holder ref、当前身份与 Runtime 报出的写入者；
    `attach` 从保留缓冲起点（`since: 0`）取回投影。
  - **游标增量读取**：附加后每 700ms `session.handoff.terminal.read --since <cursor>`，游标单调；
    `truncated` 如实提示「游标已落在有界缓冲之外，可能有缺失」；终端结束即停止跟随。
  - **detach**：释放本客户端附加，不停终端、不动 provider。
  - **write**：`terminal.write`（base64），可选末尾附加 CR（等同按 Enter）；单次超过合同上限时本地拒绝。
  - **release**：`session.handoff.release`，可选「交还后继续自动化」；`released`/`code`/退出码/
    `predecessorObservation`/session file 事实/successor 全部原样呈现，并写明退出码只是审计数据。
  - 只读投影：incarnation 历史表（模式/状态/pid/记录的后代/前身）、写入租约、side channel、能力矩阵
    （含 UI 不认识的键，绝不隐藏）、终端进程/游标/保留字节/附加记录。
  - **写入不是审批通道**：面板明说这一点，并只指向既有 Attention；面板内没有任何批准入口。
- 终端文本按**不可信内容**渲染：`displayTerminalText` 把 `\r\n`/`\r` 归一为换行、ESC 显示为 `␛`、其他 C0
  控制字符显示为 `·`；**不解析 ANSI 序列**、不注入 DOM 标记（React 默认转义），显示缓冲有界（240k 字符）。
- 刷新策略（已记录的取舍）：`session_handoff_requests` / `session_terminals` **不在领域事件目录里**，事件流
  无法驱动它，因此该面板只在「有 open handoff 或终端 `RUNNING`」时每 2s 读一次 `session.handoff.status`，
  其余按需读取 + 每次动作后读取 + 事件 token 变化时一次读取；结束状态不再轮询。
- `apps/ui/src/dependencies.tsx`（新）：`DependencyPanel`（`task.depends.list`）—— 每任务依赖边（前置任务、
  需要的 revision、已合入 commit、满足与否、reason code + detail、集成批次）、`BLOCKED` 原因清单、dev 基线、
  上游/下游闭包；项目页用同一组件给项目级全图（按依赖任务分组）。不自己推导航，判定全部来自 Runtime。
- `apps/ui/src/promotion.tsx`（新）：`PromotionPanel`（`promotion.list` + 详情用 `promotion.get`）—— 状态、
  候选 commit、预期/已读回的 `main`、权限模式与批准、集成批次/验证、包含的任务 revision、重启步骤与
  观测结果。明写「`main` 已移动 ≠ Runtime 已重启」，因此不会把已移动的 ref 显示成提升完成。
- `apps/ui/src/App.tsx`：任务详情把只读执行过程区改为「Agent 会话与执行过程」（终端面板 + transcript，执行
  选择器共用）；任务详情新增依赖与提升两节；项目页新增依赖图与提升记录两节；验证记录表的状态改为带语义色
  的 chip，`CANCELLED` 因此与 `FAILED`/`ERROR` 视觉区分。
- `apps/ui/src/styles.css`：终端/交接/依赖/提升样式，能力值与非满足依赖用 attention 色，窄屏（≤620px）单列。
- **未改动**：长命令 Operation 与进度（FOUNDATION-039/047 的事件驱动 + 非 live 时 5s 兜底）沿用既有实现。

### 命令面断言（UI 自身的 `RuntimeClient` + HTTP `/api/command`、`/api/events`）

驱动方式：从 `codeestra ui --no-open` 取得地址与令牌，用 **UI 的同一个 `RuntimeClient` 类**（`apps/ui/src/api.ts`）
打 `/api/command`；独立 `CODEESTRA_HOME=/tmp/ce-d3`、临时 git 仓库（`main` + `dev`）、协议 stub provider、
真实 PTY 与真实进程表；脚本在 `/tmp`（不入库），运行后 `codeestra stop` 并回收 `/tmp/ce-d3*`。
**结果：82/82 项断言通过**，覆盖：

- 纯函数：ESC/CR/控制字符显示转换、显示缓冲有界、写入 base64。
- 交接投影形状：`incarnation.mode = AUTOMATED_RPC`、`writerLease.holderKind`、能力矩阵（`ptyTransport` /
  `nativeTerminalAttach` = IMPLEMENTED，`attachToLiveRpcProcess` / `ptyResize` = UNSUPPORTED）与 UI 用到键的齐全性。
- 接管：`request` 记录 TAKEOVER 意图 → `safePoint.reached` + `fenceAcknowledged`（安全点是 Runtime 的事实）→
  `admit` 返回 `admitted/successorStarted/terminalTransport=PTY/successorMode=HUMAN_TUI`、incarnation 链
  `RPC → TUI` 指回同一 session file、lease 移到 `TERMINAL_ATTACHMENT`、`held: true`、`windowSize: APPLIED`、
  **Execution 仍 RUNNING**（settled ≠ 执行结束）。
- 游标读取：首次读含 provider 启动输出、`truncated: false`；`since=<cursor>` 再读得到空且游标单调。
- 单 writer：第二个 writer 稳定返回 `ATTACHMENT_BUSY` 且错误文本报出当前 holder `ui-a`；observer 可附加。
- 写入：`terminal.write` 的 base64 输入在投影中回显（轮询到出现为止）。
- detach/reattach：detach 后终端仍 `RUNNING`、provider pid 不变、写入者清空；未持有的 detach 返回
  `detached: false` + `NOT_ATTACHED`（**不是静默成功**）；reattach 成功。
- release：`released: true`、`code=RELEASED`、provider 退出码 7 仅入审计、`predecessorObservation=STOPPED`、
  `predecessorEntrySurvived: true`、successor `RPC` incarnation #3、终端 `RELEASED`、lease 回到自动化、
  Execution 仍 RUNNING；再次 release 为 `TERMINAL_NOT_RUNNING`。
- 依赖：`task.depends.list` 一条边、`satisfied: false`、reason `UPSTREAM_NOT_INTEGRATED` 带 detail、
  READY 任务被 verdict 移到 `BLOCKED`、上游闭包、dev 基线；项目级投影给同一条边且 `taskId: null`。
- 提升：`promotion.list` 返回可渲染列表；不存在的 `promotion.get` 返回稳定错误码（本格没有真实提升记录，
  因此只断言形状与错误码，不断言真实提升的渲染）。
- 长命令/验证：`task.status.operations` 带步骤、`task.verifications` 是列表、`task.verification.list` 同形。
- 事件流仍只走订阅（`/api/events` 给出排他数字游标）。

### 断言发现并修复的一处真实缺陷

`session.handoff.detach` 在 Runtime 侧**不抛错**：本客户端没有附加时返回
`{ detached: false, code: 'NOT_ATTACHED' }`（例如附加已被 release/stop 关闭）。最初的 UI 代码忽略返回值、总是
显示「已分离」——正是「把已受理显示成成功」。已修复为：`detached: false` 时显示错误码并说明只停止跟随投影，
运行断言 `未持有的 detach 不是静默成功` 通过。

### 构建产物断言

`bun run build:ui` 产物（Vite bundle）包含本格新增视图的文案/选择器：`原生终端与会话交接`、`请求接管`、
`接管（启动原生终端）`、`交还自动化（release）`、`末尾附加回车`、`依赖与 BLOCKED 原因`、`稳定提升记录`、
`ATTACHMENT_BUSY`、`truncated`、`已到安全点`；`styles.css` 含 `.terminal-stream`、`.state-blocked` 等新规则。

### 实际跑过的检查与结果

- `bun run check:fast`：**退出码 0**（根 typecheck + UI typecheck + 231 Vitest + 243 unit Bun tests，0 fail）。
- `bun run check` 第一次：**退出码 1**，唯一失败是 `apps/runtime/test/cli-session-attach.test.ts`（FOUNDATION-046
  已记录的**负载敏感抖动**：CLI `session handoff release` 退出码非 0）。该文件单独重跑 **1 pass / 0 fail**。
- `bun run check` 第二次：**退出码 0** —— 根与 UI typecheck、231 Vitest、**415 Bun tests（0 fail）**、UI Vite 构建。
- `bun run check` 第三次（**最终树**，含最后两处纯 UI 文案/属性小改之后）：**退出码 0**（同上），`bun run check:fast`
  在最终树上也再次退出码 0（231 Vitest + 243 unit Bun tests）。三次结果都记录在此，不把抖动说成通过。
- 本格改动只在 `apps/ui/**`（无任何测试导入），因此那次抖动与本次改动无关；**根因仍未定位**（沿用 FOUNDATION-046
  的未结项）。

### 待用户人工确认（本格无法自行完成，构建通过不等于 UI 验收）

- 终端投影的实际观感：渲染效果、滚动行为、控制字符（`␛`/`·`）的可读性、长输出下的性能。
- 键盘与焦点顺序：Tab 顺序、终端输入框上按 Enter 即发送、写入者/观察者切换前后的可用性提示。
- 窄屏（≤620px）与深/浅主题下的布局与对比度（尤其终端区域与 `attention` 色状态）。
- `ATTACHMENT_BUSY` 的实际交互：第二个 writer 被拒绝时错误就地显示、当前 holder 是否清晰。
- 接管按钮在**真实 Pi 原生 TUI** 下的可用性与观感（本格只用协议 stub provider 断言字节与状态）。

### 未验证 / 未做（不得当成已成立）

- 真实模型在 UI 接管的 TUI 中键入消息的复验（本格与 FOUNDATION-046 一样使用 stub provider）。
- PTY resize（Runtime `UNSUPPORTED`，UI 如实显示不支持，不做替代）；Windows；其他 provider。
- 提升页未在**真实**提升记录上渲染（需要真实 `main` 工作树与重启序列，属用户的显式操作）。
- `session_handoff_requests` / `session_terminals` 没有领域事件，UI 只能轮询（见上）；若将来要在 UI 里完全
  事件驱动，需要 Runtime 侧新增事件——本格**不顺手改 Runtime**，作为待决项提出。
- `docs/tasks/README.md` 的 `## NEXT`（第 3 条）仍写着「UI 终端」待办：本格已交付该投影，NEXT 行本身按其
  「只允许在 NEXT 之前插入一节」的边界**未改**，需要一次独立的 NEXT 更新。

### 交付边界

改动/新增文件：`apps/ui/src/{terminal,dependencies,promotion}.tsx`（新）、`apps/ui/src/{App.tsx,types.ts,styles.css}`。
**未改** `apps/runtime/**`、`apps/cli/**`、`packages/**`、`docs/architecture/**`、`docs/decisions/**`、
`PROJECT_SPEC.md`、`AGENTS.md`；本文件只插入本节。未 commit、未 push、未提升 `main`、未重启稳定 Runtime；
证据运行使用的 `/tmp/ce-d3*` 与 `/tmp/d3-evidence` 已回收。

## Wave D 集成记录（FOUNDATION-048/049/050）

状态：**三格均已提交并合入 `dev`**。基线统一固定 `dev@77eaf678a13d955fe7f01cba160cd5e9302f3fab`（`phase1SchemaVersion = 18`），三格均未 rebase、未合并新 dev、未 push、未提升 `main`、未触碰稳定工作树（`/Users/loyage/Documents/codeestra`）。

| 格 | lane 分支 | lane commit | dev merge | FOUNDATION | ADR | schema |
|---|---|---|---|---|---|---|
| D1 | `lane/d1-revision-delivery` | `dcd185c` | `0c960ad` | 048 | 0028 | **v19** |
| D2 | `lane/d2-codex-adapter` | `cd9bf1b` | `6688766` | 049 | 0029 | 无 |
| D3 | `lane/d3-terminal-ui` | `62f49aa` | `87d2c7e` | 050 | 无（纯投影） | 无 |

合并顺序 D1 → D3 → D2（先落 v19，再把最重的 adapter 变更放最后）。三格在各自 worktree 内都跑过完整 `bun run check` 且退出码 0：D1 439 pass / 0 fail（52 文件）、D2 441 / 0（52）、D3 415 / 0（50）。

### 集成时发现并修复的问题（两个分支上都没有）

1. **语义冲突（编译失败）**：D1 的 `apps/runtime/test/revision-delivery.test.ts` 构造 `AdapterCapabilities` 时缺 D2 新增的必填字段 `controlledConfiguration`。两格单独 typecheck 都过，合并后才暴露。修复：在该测试声明该字段为 `'SUPPORTED'`，并注明这只是 stub 编排断言，不代表真实 provider 的隔离能力。
2. **文档合并**：`docs/tasks/README.md` 三格都按「在 `## NEXT` 之前插入一节」的槽位纪律写，因此三次合并都在同一处冲突，按 048 → 049 → 050 顺序手工排序，内容一字未改（另补一个缺失的空行）。`apps/cli/src/main.ts`、`apps/runtime/src/main.ts`、`packages/contracts/src/index.ts`、`docs/decisions/README.md` 按各自的 group/块自动合并成功，无手工冲突。

### 集成后验证

- `bun run check`（合并后的 `dev` 树，`CODEESTRA_HOME=/tmp/ce-integrate`）：退出码 0 —— 根与 UI `tsc --noEmit`、231 项 Vitest、**465 项 Bun tests（0 fail，54 文件）**、UI Vite 构建。
- schema 现在为 **v19**；v16 仍未使用，`if (version < 16)` 不存在。
- 未在 `dev` 上启动真实 provider，也未触碰稳定 Runtime；集成期间产生的 `/tmp/ce-integrate` 与三格的 `/tmp/ce-d*` 已回收。
- **这不是 IntegrationBatch**：是用户确认后的手工 lane commit + `git merge --no-ff`。仓库目前没有 `dev` 检出之外的克隆可供 `task integrate` 跑完整集成批次（ADR-0009 的合规路径），后续若要严格走产品路径需另建克隆。

### 仍未验证（不得当成已成立）

- *真实* Codex 的 attach / PTY handoff / pause / revision ACK / live reconnect：能力矩阵按 spike 实测声明为 `UNSUPPORTED`，它们本来就没有实现。D2 的真实集成证据限于 probe、STRICT gate allow、FULL 零确认、完成证据、进程身份与跨进程 `thread/resume`；全部 CLI 流程与失败映射是协议 stub。
- 真实 provider 的 revision ACK（无任何 Adapter 实现 `applyRevision`，Pi 仍 `UNSUPPORTED`）、真实模型对投递提示的理解。
- Runtime 没有 `FAILED → READY` 路径，因此「Execution 失败后换 Agent」目前只在 Execution 建立前失败与 pause→resume 路径上成立。
- 三格 UI（终端/交接/依赖/提升/CANCELLED）的观感、窄屏与键盘操作**只由人工目视确认**，本轮未做，也没有引入任何浏览器/桌面自动化。
- 架构文档 doc-sync（`state-machines.md` §1、`event-model.md` §2 缺 `CANCELLED`/`OperationProgressed`/`OperationSettled`、`sqlite-schema.md` 落后到 v18 且未说明 v16 未使用、`agent-adapter.md` 缺 `controlledConfiguration`）仍未做。

## FOUNDATION-052 — Phase 2 并行调度的决策固化（ADR-0030，纯文档）

状态：**已实现（纯文档）、已提交并合入 `dev`**（lane commit `0b1d863`，dev 快进合入，集成详情见「Wave E 集成记录」）。lane `lane/e0-phase2-decision`，基线**固定** `dev@cb7078ed`
（不 rebase、不合并新 dev、不 pull）；未提升 `main`、未重启稳定 Runtime、未触碰稳定工作树
`/Users/loyage/Documents/codeestra`。**本格不改任何代码、不占用 schema 版本**：`phase1SchemaVersion` 仍为
**v19**、`migration.ts` 一行未动。本格只把用户已拍板的 10 项决策固化为规格与设计；**Phase 2 的任何代码都还没写**，
因此不得把本节读成「并行调度已实现」。

### 改动（全部为文档）

- `PROJECT_SPEC.md` §2 核心不变量**第 6 条**：逐字替换为含「UNKNOWN 默认等待（不启动、不并行）」与「显式单次放行
  `--allow-unknown`（**可与当前活跃任务并发**、绑定 revision 与评估版本、写审计、默认路径不增加确认步骤）」的措辞。
  这是本格唯一的规格改动；**未动其它条文**，也**未改「阶段进度」段落**（那句「尚未实现 … 并行调度」要等 Phase 2
  真正落地后由 Wave F 更新，本格改它就是谎报已实现）。
- `docs/decisions/0030-phase2-parallel-scheduling.md`（新，ADR-0030）：逐条记录 D01–D10 的决定与**被否掉的选项**，
  以及用户特别关心的三项后果——**效率成本**（放行是放宽而非新增门禁，常态路径 0 新增步骤，无新审批层/沙箱）、
  **风险归属**（UNKNOWN 不是「无冲突」而是「无法证明」；放行后越界责任在放行方，Runtime 不做额外隔离）、
  **审计链**（放行绑定 revision + `analyzerVersion`/`policyVersion`/`baseCommit`，与评估不一致即失效）。
- `docs/decisions/README.md`：在「已接受」**表尾追加** ADR-0030 索引行（未插入中间、未重排既有条目）。
- `docs/architecture/conflict-analyzer.md`：§2 补映射来源 `.codeestra/impact.json`（**只从项目 main ref 读**，读法同
  `.codeestra/policies/verification.json`；Task branch 上的同名文件不参与判定）；§4 把「第一版没有隐藏 override」改为
  已授权的**显式**单次放行，并写明审计要求、绑定失效、风险归属与「**放行不等于 SAFE**」（assessment 记录仍是 UNKNOWN）。
- `docs/architecture/scheduler.md`：补 §1.1 容量模型（全局上限默认 2 可配置 + 每 adapter 上限默认等于全局上限，
  `wait(CAPACITY)` 区分 `GLOBAL_CAPACITY`/`ADAPTER_CAPACITY`）、§1.2 触发模型（事件驱动 + 周期恢复 tick，
  submit 后自动进入调度，FULL 0 确认）、§4.1 UNKNOWN 显式放行语义（放行不改变 assessment 本身），以及 §6「明确不做」
  （非 Git 资源共享资源的 claim、多成员批次、aging 留后续；按主机资源推导容量与 LLM 预测也不做）。既有排序
  （priority desc → createdAt asc → ID asc）、不抢占、不加 aging、两类锁与验收矩阵**未改**。

### 验收自查

- `bun run typecheck` 退出码 0（只用于确认没碰代码）。
- `git diff --stat` 只包含上述文档；`grep -c "allow-unknown" PROJECT_SPEC.md` ≥ 1；§2 第 6 条与本格写入内容逐字一致。
- 未 commit、未 push、未提升 `main`、未重启稳定 Runtime。

### 未做（不得当成已成立）

- **未写任何 Phase 2 代码**：没有 scheduler/conflict-analyzer 实现、没有 `.codeestra/impact.json` 读取器、
  没有 `--allow-unknown` 命令形态；本 ADR 只固化语义。
- **未占 schema 版本**（仍 v19）、未改 `migration.ts`、未改任何 `*.ts`/`*.tsx`/`*.json`/`package.json`/`apps/**`/`packages/**`。
- **未动 `## NEXT` 的条目本身**（含其中仍写着「并行调度」待办的行——按槽位纪律需一次独立的 NEXT 更新）。
- 未 commit、未 push、未提升 `main`、未重启稳定 Runtime、未触碰 `/Users/loyage/Documents/codeestra`。
## FOUNDATION-053 — ImpactSnapshot 与确定性 Conflict Analyzer（ADR-0031，schema v20）

状态：实现 + 自查完成，**已提交并合入 `dev`**（lane commit `749e1fd`，dev merge `c03ee45`，集成详情见「Wave E 集成记录」）。worktree `/Users/loyage/Documents/codeestra-wt/e1-impact-analysis`，
分支 `lane/e1-impact-analysis`，基线固定 `dev@cb7078ede92835bd3663b53dd4ac593b5543a879`（`phase1SchemaVersion` 由 19 → **20**）；
未 rebase、未合并新 dev、未 pull、未 push、未提升 `main`、未触碰稳定工作树。

**关于 ADR-0030**：本节所述的 Wave E **E0 格是并行格**，其决策 ADR（Phase 2 十项决策，编号 0030）在本格基线 `dev@cb7078e`
中**不存在**。本格不自行发明产品语义，只实现用户已拍板的那部分，并把它写成 **ADR-0031**；E0 合入后如有重号或语义差异，在 `dev` 解决。

### 交付物

- `packages/contracts/src/impact-policy.ts`（新）：`.codeestra/impact.json` 严格 Zod schema、`impactPolicyPath`、
  `impactPolicyVersion = 'impact-policy-v1'`、稳定错误码、`normalizeImpactPath`（拒绝绝对路径/`~`/`..`/`.`/空段/`\`/NUL/`.git`/非法通配符）、
  按组件比较的模式匹配、`impactPolicyDigest`/`impactPolicyLabel`、确认 schema。
- `packages/domain/src/impact-analysis.ts`（新，纯函数）：`impactAnalyzerVersion = 'impact-analyzer-v1'`、`createImpactSnapshot`、
  `deriveImpactScope`、`assessCandidate`、`isSnapshotCurrent`、`explainAssessment`、稳定 reason code 与 `CONFLICT | INCOMPLETE | STALE_OR_INVALID | SAFE` 分组。
- `apps/runtime/src/impact-analysis-service.ts`（新）：读 main ref 的映射、实测路径大小写、观测 worktree 变更集、
  持久化/重用快照、逐对写审计行、`validateImpactPolicy`。
- `packages/storage/**`：**v20** 迁移（`project_impact_policy_confirmations`、`impact_snapshots`、`impact_assessments` + 唯一索引 + append-only 触发器）、
  确认与快照/判定读写、活跃集合投影；`trustProject` 增加可选的 impact 确认参数。
- `packages/contracts/src/index.ts`：union 末尾追加 `project.impact.validate|show|explain`；`project.trust` 增加可选 `expectedImpactPolicy`。
- `apps/cli/src/main.ts`：`project impact validate|show|explain`（`--json`、稳定退出码）；`open`/`project trust` 显示并回显映射摘要。
- `apps/runtime/src/main.ts`：三个命令接线 + `project.trust` 记录映射确认 + `project.list` 投影 `confirmedImpactPolicy`。
- 测试：`packages/domain/test/impact-analysis.test.ts`（34）、`packages/contracts/test/impact-policy.test.ts`（9）、
  `packages/storage/test/impact-analysis.test.ts`（12）、`apps/runtime/test/cli-impact.test.ts`（1 项端到端）。
- 文档：`docs/decisions/0031-*.md`（新）、`docs/decisions/README.md`（表尾一行 + Phase 2 一行）、本节。

### 命令面用法

```bash
# 映射是否有效且在生效（退出码 0 = OK / OK_UNTRUSTED；否则 1，code 在 --json 里）
bun run codeestra project impact validate [path] [--json]
# 某个 Task 当前 revision 的 ImpactSnapshot（不完整也产出，complete:false 可脚本判定）
bun run codeestra project impact show <project-id> <task-id> [--json]
# 与每个活跃/已预留 Task 的判定 + 稳定 reason code + 命中范围（退出码 0 仅当 SAFE_TO_PARALLELIZE）
bun run codeestra project impact explain <project-id> <task-id> [--json]
```

`.codeestra/impact.json` 示例（本格证据运行用的就是这一份）：

```json
{ "version": 1,
  "importantDirectories": ["core"],
  "modules": [{ "id": "core-module", "paths": ["core/**"] }],
  "globalResources": [{ "id": "lockfile", "kind": "DEPENDENCY_LOCKFILE", "paths": ["bun.lock"],
    "consumers": { "state": "DECLARED", "paths": ["package.json"] } }] }
```

### 端到端证据（真实 CLI + 真实 Runtime + `CODEESTRA_HOME=/tmp/ce-e1` + 临时仓库）

Agent 是**协议 stub**（写一个 `src/agent/<task-id>.ts` 后保持存活，使 Task 持续持有资源）；它只证明命令面与编排，不是真实
provider 的集成证据。仓库：`main == dev == 2dcc1a5`；两个 Task 都 RUNNING，各有一个 worktree。

1. **SAFE**（`explain`，**退出码 0**）：两侧各只改了自己的 `src/agent/<task-id>.ts`（`mapping` 未声明 `src/agent`，只有文件不重叠）：
   ```
   impact complete (RECORDED)
   plan 2dcc1a5f7003 · mapping impact-policy-v1#590ff5efdedc · path case INSENSITIVE (FILESYSTEM)
   paths 1 changed, 1 not classified by the mapping
   compared 1 active/reserved task(s)
     verdict SAFE_TO_PARALLELIZE (NO_CONFLICT)
     [SAFE] no overlapping scope with 78ae052c-… (revision 5b0075e5-…)
   evidence: path case mode measured on "REPO" resolves to "repo" in the same parent
   ```
2. **CONFLICTING**（`explain`，**退出码 1**）：两侧各在声明的 `core` 下新增**不同**文件（`core/first.ts` / `core/second.ts`）：
   ```
   important directories: core
   modules: core-module
     verdict CONFLICTING (IMPORTANT_DIRECTORY_OVERLAP, SAME_MODULE)
     [CONFLICT] IMPORTANT_DIRECTORY_OVERLAP … (SAME_DIRECTORY): both revisions change files inside
       important director(ies) core (other revision: core) — directories core
     [CONFLICT] SAME_MODULE … both revisions change files of module(s) core-module — modules core-module
   ```
   同一文件相撞时给出命中路径：`[CONFLICT] SAME_FILE … (SAME_FILE): 1 file(s) changed by both — paths src/agent/78ae052c-….ts`。
3. **UNKNOWN（映射缺失）**（`explain`，**退出码 1**）：另一个没有 `.codeestra/impact.json` 的项目（同一个 Runtime）
   ——`validate` 退出码 1 / `code: POLICY_ABSENT`：
   ```
   impact incomplete: POLICY_ABSENT (RECORDED)
   plan 6b0f7672b36b · mapping impact-policy-v1#absent
   compared 0 active/reserved task(s)
     verdict UNKNOWN (INCOMPLETE_IMPACT)
     [INCOMPLETE] INCOMPLETE_IMPACT on the candidate: impact is incomplete: POLICY_ABSENT
   ```
   注意：即使**没有任何活跃任务**，不完整的映射仍是 UNKNOWN——这是本格的核心不变量。
4. **失效与重用**：同一事实重复 `show` → `disposition REUSED`（同一个 snapshot id）；
   `task revision create` 改修订后 → `disposition RECORDED`，新 revision + **新的 snapshot id**（旧快照保留为审计，不被重用也不被覆盖）；
   变更集变大/变小 → 新的 `change_fingerprint` → 新快照（因此删掉冲突文件后不会残留假冲突）。
5. 结束时 `bun run codeestra stop` → `status: STOPPED`；`/tmp/ce-e1` 与 `/tmp/e1-evidence` 已回收。

### 实际跑过的检查与结果

- `bun run check:fast`：**退出码 0**（根与 UI typecheck + **265** Vitest + **297** unit Bun tests）。
- `bun run check`（完整：typecheck + UI typecheck + Vitest + 全部 Bun tests + UI 构建）：
  第一次 **退出码 1**，失败的是**未更新的版本断言**（`phase1SchemaVersion` 由 19 变 20）与我自己的一个 SQLite 排序断言
  （两条快照 `created_at` 相同时按随机 id 排序，测试不该依赖它）；修好后再跑 **退出码 0**（265 Vitest + **487** Bun tests，0 fail）。
- `apps/runtime/test/cli-impact.test.ts` 单独跑：**1 pass / 0 fail**（真实 CLI + 真实 Runtime + 临时 `CODEESTRA_HOME`）。
- 本格四个测试文件单独重跑：**Vitest 34 + Bun 22，0 fail**。
- **负载敏感抖动（既有问题，非本格引入）**：在短时间内连续重跑整个 Bun 套件后，曾出现 2–4 个失败，全部落在**其他格**的
  时序敏感测试上（`stable promotion preparation` 单条耗时 154s、`Runtime lifecycle: stop is a fact` 单条耗时 681s、
  `Codex adapter observation`、`production Pi adapter registry`），本格四个文件一次都没有失败；同样的完整套件在**机器空闲时**
  是 487 pass / 0 fail。抖动根因沿用 FOUNDATION-046/050 的未结项（仍为负载敏感，未定位），本格不声称已修复它。
- 迁移：真实 SQLite 上 **v19 → v20** 与 **v16 → v20** 两种历史库都 additive 升到 20（既有行保留、三张新表存在、
  `PRAGMA foreign_key_check` 为空、升级不会凭空造出确认行）；`if (version < 16)` 不存在。

### 改到的共享槽位文件（按槽位纪律）

- `packages/storage/src/migration.ts`：只占 **v20**，只追加 `impactAnalysisMigration` 与 `if (version < 20)`。
- `packages/contracts/src/index.ts`：只追加 `project.impact.*` 到 union 末尾（并加一行 `export * from './impact-policy.js'` 与 `project.trust` 的可选 `expectedImpactPolicy`）；**未动 adapter 能力区**。
- `apps/cli/src/main.ts`：新增 `project impact` 分支块 + `usage()` 追加行 + `open`/`trust` 的映射摘要展示。
- `apps/runtime/src/main.ts`：只做接线（三个 case + `project.trust` 记录确认 + `project.list` 多一个字段）；**未改启动序列**（启动 reconcile 由 E2 追加）。
- `package.json`：只在 `test:unit` 忽略列表与 `test:e2e` 列表加 `cli-impact`。
- `docs/decisions/README.md`：表尾追加 ADR-0031 一行 + Phase 2 决策表一行。
- **连带改动（非我领地，但版本提升必须）**：`apps/runtime/test/revision-delivery.test.ts` 与 `apps/runtime/test/verification-cancel.test.ts`
  中写死的 `phase1SchemaVersion === 19` 断言改为 20（前者同时把 `impactAnalysisMigration` 加进其迁移步骤列表）。只改了版本断言，未改动这些测试的语义。
- **未改**：`packages/git/**`（复用既有 `inspectChangeSet`/`changeSetPaths`/`readRefFile`/`readLocalRefCommit`，**零改动**）、
  `apps/ui/**`、`apps/runtime/src/{scheduler,workspace-service,adapter-registry,agent-runtime-service,terminal-service,session-handoff-service}.ts`、
  `packages/agent-adapters/**`、`PROJECT_SPEC.md`、`AGENTS.md`、`docs/architecture/**`。

### 未验证 / 未做（不得当成已成立）

- **不用真实 Agent**：端到端证据里的 provider 是协议 stub。「真实 Agent 的改动集是否落在声明的映射里」本格无法验证，
  也不由本格负责——判定只对**观测到的 Git 变更集**负责。
- **映射未声明路径没有目录/模块语义**：只有「同文件」与「声明的资源」规则覆盖它们。SAFE 的含义是「在声明的映射与观测事实下无法证明重叠」，
  不是「两个 Agent 永不越界」；`scheduler.md` §4 的残余风险继续成立。
- **gitignore 的产物不在变更集里**（构建输出、本地环境文件、`node_modules`）；**非 Git 共享资源**（端口/数据库/dev server）本波明确不做。
- **symlink**：端到端测试在 worktree 里构造了指向 `/tmp` 的**真实 symlink**，`show` 把它作为普通仓库相对路径 `escape-link` 报出（按 Git 报的名字比较，
  内容从不被读取，`complete` 仍为 true）；映射侧则由 contracts 测试拒绝一切逃逸语法（`..`/绝对路径/`~`/`.git`/空段）。可逃逸的读取路径在结构上不存在
  （映射经 `git cat-file`、变更集经 `git diff`/`git ls-files`，从不打开工作树文件）。
- **活跃集合只按 `resource_held` 取**：本格不实现调度循环，因此没有「两个 Task 同时被判定为 SAFE 并真的同时开始」的真实并发压力面（Wave F）；
  验证到的只是同一时刻最多一个候选与若干活跃 Task 的判定。
- **基线不同即逐对 UNKNOWN**：本格不实现「把活跃 Task 的快照重算到新基线」（那需要 rebase/重建 worktree），因此 `dev` 前进后未重算的活跃 Task 会让新候选
  保持 UNKNOWN。CLI 会输出项目 dev commit 与是否与基线一致，可解释但仍属保守代价。
- **`validate` 不检查声明路径是否存在于仓库**（一个 Task 即将创建的目录是合法声明）；`show`/`explain` 的「未分类路径数」是操作者的主要提示。
- **UI 投影**：本格不做（`apps/ui/**` 属 Wave F）；`project impact *` 的能力只在 CLI/命令面完备。
- **架构文档 doc-sync 未做**（`docs/architecture/**` 不在本格领地）：`sqlite-schema.md` 仍停在 v18，未记录 v19/v20；
  `docs/architecture/conflict-analyzer.md` 仍是设计文本，未回写实现细节（例如单侧「重要目录」集合的派生含义、聚合判定与配对审计行的关系）。
- `docs/tasks/README.md` 的 `## NEXT`（Phase 2：并行 worktree 调度、资源预留、Conflict Analyzer、多成员批次）**未改**：
  本格按「只允许在 `## NEXT` 之前插入一节」的纪律只插入本节，NEXT 行需要一次独立的更新。
## FOUNDATION-054 — 容量与槽位：全局上限、每 adapter 上限、reservation 与崩溃 reconcile（Wave E / E2）

状态：**已实现、已自查、已提交并合入 `dev`**（lane commit `5982293`，dev merge `bd74e14`，集成详情见「Wave E 集成记录」）。lane 分支 `lane/e2-capacity-slots`，基线固定
`dev@cb7078ede92835bd3663b53dd4ac593b5543a879`（未 rebase、未合并新 dev、未 pull、未 push、未提升 `main`、
未重启稳定 Runtime、未触碰 `/Users/loyage/Documents/codeestra`）。ADR：**0032**（E0 = 0030、E1 = 0031；
基线里还没有这两份，因此本格只写自己的号）。schema：**v21**。

### 已实现

**容量配置（可查可设、CLI 完备）**

- schema v21 新增 `project_capacity_limits`（项目级全局上限）与 `project_adapter_slot_limits`（每 adapter 覆写）。
  没有行 = 未显式设置：读取返回文档默认值 `2` 且 `limitSource = 'DEFAULT'`；adapter 覆写只存显式设置过的行，
  因此「缺省 = 该项目当前全局上限」是**派生事实**，改全局上限会一起移动没有覆写的 adapter。
- 校验：整数、`≥1`、`≤16`（`maxConcurrencyLimit`）。`0`/负数/小数 → `CAPACITY_LIMIT_INVALID`；超上限 →
  `CAPACITY_LIMIT_OUT_OF_RANGE`；未知 adapter id → `UNKNOWN_ADAPTER`（对照 adapter registry）。**拒绝，不夹取**，
  且被拒绝的请求不写任何行（测试与端到端都断言过）。
- 每次改变写一条 append-only `SchedulerCapacityChanged` 事件；重复设置同一个值不 bump 版本、不发事件。
- 降低上限不释放任何已持有槽位：只影响之后的获取判定（`available` 可为 0、`used` 可 > `limit`，事实如实）。

**资源预留（`execution_slot_reservations`，schema v21）**

- 一行表达 scheduler.md §3 的三件事：Task 执行权 + adapter slot +（可绑定的）workspace。两个**部分唯一索引**把不变量
  变成 schema 事实：`one_active_slot_reservation(task_id)`、`one_active_workspace_reservation(project_id, workspace_id)`。
- 获取走 `BEGIN IMMEDIATE`（bun 的 `sqlite.transaction(...).immediate(...)`），在同一事务内按 scheduler.md §2 的顺序重检：
  active trust → Task `version` CAS → `revision_id` CAS → `state = READY` → **依赖事实指纹**重读比对 →
  该 Task 无活跃预留 → **容量（上限在同一事务内从表里重读）** → **draining（事务内求值）** → 写入预留 + append-only 历史行
  + `ExecutionSlotReserved` 事件。两次 tick / 两个启动请求只能有一个成功：第二个要么在写锁上等待后看到已提交的行
  （容量等待），要么撞上部分唯一索引（`SLOT_ALREADY_RESERVED`，错误文本带既有预留 id 与状态）。
- 依赖的 Git 部分（pinned 上游是否仍可从 `dev` 到达）仍由 scheduler 的 `assertDependenciesSatisfied` 判定，本格不复制；
  存储层能证明的是「这次写入与调用方评估时的依赖事实一致」（指纹不匹配 → `DEPENDENCY_STATE_CHANGED`）。
- **快照代如实标注未实现**：本基线没有 impact snapshot 存储（E1 领地），`impact_snapshot_id` 只记录调用方声明的 id，
  「快照代重检」要等 E1 落地后由 Wave F 传入；`assessed_dev_commit` 记录评估所依据的 `dev` OID。
- 容量占用按 **Task** 计（不按行计）：活跃预留 ∪ `executions.resource_held = 1`（既有的 `task.run` 路径）的**并集**，
  这样「先预留、再启动」的同一个 Task 只吃一个槽，同时今天的真实并发也如实计入。

**释放（显式）与归属证据**

- 每个预留记录归属证据：创建它的 Runtime `bootId`、进程 `pid`、该 pid 的 **OS start token**（可为 null，如实记录）、actor。
  **「这行是我建的」不作为证据。**
- 释放必须带 `--reason`，写 `released_at`/`release_reason`/`release_kind = EXPLICIT` + 历史行 + `ExecutionSlotReleased` 事件。
  自己这一代创建的按 owner 的话释放；其他代持有者先做归属核验：**可证明仍存活 → 拒绝（`SLOT_HOLDER_STILL_RUNNING`）**，
  可证明已死或无法核验 → 允许显式释放并把观测写进历史（人类显式决定与 reconcile 自动决定在审计里可区分）。
- **绝不因心跳过期、用户等待或 UI/客户端消失自动释放**（本格没有实现任何心跳）。重复释放是诚实 no-op（`ALREADY_RELEASED`）。

**启动 reconcile（先核对真实写入者，再决定）**

- `inspectSlotHolder`：pid 不存在/僵尸 → `HOLDER_STOPPED`；pid 存活且 start token 相同 → `HOLDER_STILL_RUNNING`；
  pid 存活但 token 不同 → `HOLDER_PROCESS_ID_REUSED`；任一 token 缺失或进程表读不到 → `HOLDER_OWNERSHIP_UNVERIFIABLE`；
  没有进程身份 → `PROCESS_IDENTITY_MISSING`。
- 决定：已死（前两者）→ **记为 RELEASED**（`RECONCILED_HOLDER_EXITED` / `RECONCILED_PROCESS_ID_REUSED`）；
  仍存活 → **保持占用**（不动状态）；无法核验 → `RESERVED` → **`RECOVERY_REQUIRED`，保持占用，不自动放行**。
- `execution_slot_reservation_events` 是 append-only 历史：获取、释放、以及**每一次 reconcile 观测**（包括「决定保持占用」
  这种没有状态变化的情形）都追加，从不改写；`UNIQUE(reservation_id, command_id)` + command 回执让同一代重复 reconcile 幂等。
- reconcile **不发信号、不杀进程、不删资源、不声称静止**。本代自己创建的预留跳过（`SKIPPED_HELD_BY_RUNTIME`）。
- 启动序列：`apps/runtime/src/main.ts` 在既有 reconcile 序列**之后追加**这一步（未移动任何既有调用顺序），
  理由写在代码注释里：槽位必须按其他 reconcile 收敛后的最终图景判定（例如某 Execution 刚被收敛成 `RECOVERY_REQUIRED`，
  它的槽位仍被占）。

**等待原因（不变量 10）与 draining**

- 容量等待有自己的稳定码：`CAPACITY_GLOBAL_LIMIT_REACHED` / `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` / `SCHEDULER_DRAINING`，
  并带 `{ adapterId, limit, used, blocking[] }`；`scheduler capacity get` 也返回每 adapter 的 `waitReason` 与占用者（含 `since`）。
  `BLOCKED` 仍只表示依赖未满足。
- Runtime 的 draining 是**内存事实**，只在开始 shutdown 时置位（持久化 draining 会在崩溃后残留并永久拒绝新预留，故不做）；
  没有新增操作者 drain 开关（那会是本格之外的新产品语义）。

**命令面（零新增确认、`--json`、稳定退出码）**

```
scheduler capacity get <project-id> [--adapter <id>] [--json]
scheduler capacity set <project-id> --limit <n> [--adapter <id>] [--json]
scheduler capacity clear <project-id> --adapter <id> [--json]
scheduler reservations list <project-id> [--task <task-id>] [--include-released] [--limit <n>] [--json]
scheduler reservations get <project-id> <reservation-id> [--json]
scheduler reservations acquire <project-id> <task-id> <expected-task-version> --revision <revision-id> [--adapter <id>] [--json]
scheduler reservations release <project-id> <reservation-id> --reason <text> [--json]
scheduler reservations prepare-workspace <project-id> <reservation-id> <expected-task-version> [--json]
scheduler reservations reconcile <project-id> [--json]
```

`acquire` 退出码：**0** = 拿到槽位，**3** = 容量等待/正在排水（`--json` 的 `wait.code` 是原因），**1** = 拒绝
（依赖未满足、revision/版本过期、已有预留、未知 adapter、非法上限）。`prepare-workspace` 只有**本代创建**的
`RESERVED` 预留可用（否则 `SLOT_HELD_BY_ANOTHER_RUNTIME`），准备出的 worktree 绑定到该预留，同一 commandId 重放不产生第二个 worktree。

### 迁移结论（真实 SQLite 文件，additive）

- `phase1SchemaVersion = 21`，迁移链只在尾部追加 `if (version < 21)`（`capacitySlotReservationMigration`），
  **没有插入任何更早的版本号**（v16 继续永久未使用）；v20 留给并行的 E1（impact snapshot）。
- 测试 `packages/storage/test/slot-capacity-migration.test.ts`（4 项）在真实文件上验证：
  **v20 → v21** 与 **v16 → v21** 都只新增 4 张表（`project_capacity_limits`、`project_adapter_slot_limits`、
  `execution_slot_reservations`、`execution_slot_reservation_events`），既有项目行与既有表（`agent_sessions`、
  `task_revision_deliveries`、`operation_progress_events`）原样保留，`user_version` 到 21，`getProjectCapacity` 立即返回默认值；
  已标 21 的库重开不再跑迁移且保留显式配置；「`RELEASED` 不带释放记录」被 schema CHECK 拒绝。
- 已存在库的两种历史都被覆盖（17–20 的库走到 21 只跑 `version < 21` 一步）。
- 已知共享槽位后果（写在 ADR-0032）：单独合并本格后，**已经被标成 21 的库**不会补跑后来出现的 v20 步骤；跨格合并必须按
  Wave E 既定顺序 E0 → E1 → E2。

### 真实证据：CLI + 真实 Runtime + `CODEESTRA_HOME=/tmp/ce-e2` + 临时仓库（协议 stub provider）

运行方式：本格工作树内 `bun run codeestra …`，临时 Git 仓库（`main` + `dev`）、`/tmp/ce-e2` 为 home。
下面的引文来自 `/tmp/ce-e2-evidence.log`（脚本与夹具在收尾时已回收；本机 `CODEESTRA_*` 只指向 `/tmp/ce-e2`）。

1. **容量默认值与读回**。`scheduler capacity get <project> --json` → `globalLimit: 2`、`globalLimitSource: "DEFAULT"`、
   `globalAvailable: 2`，`adapters` 为 `pi`/`codex` 各 `limit: 2, limitSource: "DEFAULT"`。
   `capacity set --limit 2` → `{"changed": true, ... "globalLimitSource": "EXPLICIT"}`，随后 `get` 读回 `globalLimit: 2`。
   `capacity set --limit 1 --adapter pi` 后 `get` 显示该 adapter `limit: 1, limitSource: EXPLICIT`，而 `codex` 仍为 `DEFAULT`；
   `capacity clear --adapter pi` 后回到 `limit: 2, limitSource: DEFAULT`。
2. **非法值稳定拒绝**：`--limit 0` → `CAPACITY_LIMIT_INVALID: A concurrency limit must be an integer of at least 1; got 0`（exit 1）；
   `--limit 99` → `CAPACITY_LIMIT_OUT_OF_RANGE: A concurrency limit must not exceed 16; got 99`（exit 1）；
   `--limit 1 --adapter claude` → `UNKNOWN_ADAPTER: Adapter claude is not registered; known Adapters: pi, codex`（exit 1）。
3. **容量 2：两个不相交任务可同时预留**。两次 `acquire` 均 `"outcome": "RESERVED"`（第二条的 `capacity.globalUsed` 为 1 再变 2），
   预留记录里带归属证据与基线：`holder: { bootId, pid: 2873, startToken: "ps:一  9月/14 20:31:10 2026" }`、
   `assessedDevCommit: "352693f59b0e44f0ab884d3fee6a66d767e65001"`。
4. **第三个任务得到容量等待（不是 BLOCKED）**：
   ```
   "outcome": "CAPACITY_WAIT",
   "wait": { "code": "CAPACITY_GLOBAL_LIMIT_REACHED", "adapterId": "pi", "limit": 2, "used": 2,
             "blocking": [<task2>, <task1>], "detail": "2 of 2 project slots are in use" },
   "reservation": null,
   "holderEvidence": [ { "observation": "HOLDER_STILL_RUNNING", "detail": "the recorded holder process 2873 is still
     running with the recorded start token; it was not signalled and its slot is not released" }, … ]
   [scheduler] capacity wait: CAPACITY_GLOBAL_LIMIT_REACHED (2 of 2 project slots are in use)
   ### exit=3
   ```
5. **重复/并发预留只有一次成功**。同一任务再次 `acquire` →
   `SLOT_ALREADY_RESERVED: Task already has an active slot reservation 1148b686-… (RESERVED)`（exit 1），
   `reservations list` 仍只有 2 条活跃预留。并发证据另由测试给出（见下）：两个 CLI 进程同时为**不同**任务 acquire 都成功、
   同时为**同一**任务 acquire 只有一个成功。
6. **workspace 绑定**：`prepare-workspace <project> <reservation> 1 --json` →
   `"path": "/private/tmp/ce-e2/worktrees/<project>/<task>"`、`"branchRef": "refs/heads/task/<task-id>"`、
   `"baseCommit": "352693f5…"`、`"created": true`，`ls -d` 确认目录存在；该 `workspaceId` 出现在预留详情里。
7. **显式释放 → 可重新预留**：`release … --reason "manual handoff: agent finished"` → `{"released": true, "outcome": "RELEASED",
   "reservation": {"state": "RELEASED", "releaseKind": "EXPLICIT", "releaseReason": "manual handoff: agent finished"}}`，
   历史为 `["RESERVED","RELEASED"]`；随后同一任务再次 `acquire` 成功。
8. **崩溃 reconcile（真实进程证据）**：`status` 报出本 home 的 Runtime `pid 2873`，`kill -9 2873` 后确认进程消失；
   下一条命令启动新 boot，启动 reconcile 处理残余预留：
   ```
   "state": "RELEASED",
   "releaseKind": "RECONCILED_HOLDER_EXITED",
   "releaseObservation": "HOLDER_STOPPED",
   "releaseReason": "no process with the recorded holder identity is running (pid 2873), so the recorded writer is gone",
   "holder": { "bootId": "6b211dc9-…", "pid": 2873, "startToken": "ps:一  9月/14 20:31:10 2026" },
   events[1].evidence: { "decision": "RELEASE", "observation": "HOLDER_STOPPED", "previousState": "RESERVED",
     "projectedState": "RELEASED", "quiescenceProven": false, "signalsSent": 0, "resourcesDeleted": 0 }
   ```
   `capacity get` 随后 `globalUsed: 0`、`occupants: []`；显式 `scheduler reservations reconcile` 再跑一次 `"outcomes": []`（幂等）。
9. **无法核验 → 不放行（真实进程证据）**。停掉 Runtime 后写入一条残余预留（真实存在的活进程 `pid 14563` 作为
   `holder_pid`，`holder_start_token` 故意为 NULL、`holder_boot_id = 'boot-crashed-generation'`），再启动 Runtime：
   ```
   "state": "RECOVERY_REQUIRED",
   "releaseObservation": "HOLDER_OWNERSHIP_UNVERIFIABLE",
   "detail": "pid 14563 is alive but its identity cannot be compared with the recorded holder (a start token is missing),
              so ownership is unproven",
   events[0].evidence: { "decision": "MARK_RECOVERY_REQUIRED", "observation": "HOLDER_OWNERSHIP_UNVERIFIABLE",
     "recordedStartToken": null, "observedStartToken": "ps:一  9月/14 20:33:57 2026",
     "quiescenceProven": false, "signalsSent": 0, "resourcesDeleted": 0 }
   foreign process still alive after the reconcile?  →  yes, never signalled
   ```
   显式 `reconcile` 再跑一次仍是 `"outcome": "HELD"`、`"state": "RECOVERY_REQUIRED"`；`capacity get` 显示
   `globalUsed: 1` 且 `occupants` 里有该任务 —— **槽位没有被放行**。

### 测试与实际跑过的检查

- `packages/storage/test/slot-capacity.test.ts`（17 项，in-memory + 真实 schema）：默认 2 / 设置读回 / adapter 覆写与清除 /
  非法值与未知 adapter 的稳定码且不写入 / `SchedulerCapacityChanged` / 每 Task 唯一 + 同 commandId 重放一份 /
  容量 2 时第三个等待且不写入 / adapter 维度独立 / 版本与 revision CAS / 依赖指纹不匹配 / draining /
  `resource_held` 执行计入占用 / 释放可审计且可再预留 / reconcile 观测与幂等 / `RECOVERY_REQUIRED` 仍占容量 /
  一个 workspace 不能绑到两个活跃预留 / 释放后不能绑定。
- `packages/storage/test/slot-capacity-migration.test.ts`（4 项）：v20→v21、v16→v21、已标 21 重开、`RELEASED` 缺释放记录被拒。
- `apps/runtime/test/slot-reservation-service.test.ts`（18 项，真实临时仓库 + in-memory DB）：容量读回影响判定 / adapter 覆写 /
  非法值与未知 adapter / 容量等待以 reason code 表达（并断言不是 `BLOCKED`）/ 归属证据与 `assessedDevCommit` /
  过期版本与 revision 拒绝 / 依赖未满足 = `DEPENDENCIES_UNMET` / 依赖图变化 / draining / **提优先级不打断已持有预留** /
  释放后重新预留 / 显式释放拒绝可证明仍存活的持有者 / 已死与无法核验的 reconcile 决定 / 本代自己的预留不被自己 reconcile /
  workspace 绑定与重放 / 另一代不能准备本代的 workspace / **真实进程**上的 `inspectSlotHolder`（存活、token 不符、token 缺失、
  token 不可读、已退出）。
- `apps/runtime/test/cli-capacity-slots.test.ts`（6 项，真实 CLI + 真实 Runtime + 临时 home/repo + 协议 stub provider）：
  上面第 1–9 条全部断言化（含两个并发 CLI 进程的竞争、SIGKILL 崩溃后的启动 reconcile、以及「无法核验 → 不放行」且外进程未被发信号）。
- `bun run check:fast`：**退出码 0**（根 typecheck + UI typecheck + 231 Vitest + 315 unit Bun tests，0 fail）。
- `bun run check` 第一次：退出码 1 —— 三个**旧断言**硬编码 `phase1SchemaVersion === 19`（`revision-delivery.test.ts` 与
  `verification-cancel.test.ts` 的迁移测试），本格升到 v21 后必然失败；已按新版本更新这三处断言（只改期望值，不改测试语义）。
- `bun run check` 第二次：退出码 1 —— 唯一失败是 `runtime-lifecycle.test.ts`「a deadline that never fires cannot hold a process open」
  的**既有负载敏感抖动**（对照组脚本断言 `raw 0`，高并发下得到 `raw 1`）。该文件单独重跑 **10 pass / 0 fail**。
- `bun run check` 第三次（**最终树**，含上述清理之后）：**退出码 0** —— 根与 UI `tsc --noEmit`、231 项 Vitest、
  **510 项 Bun tests（0 fail，58 文件）**、UI Vite 构建。
- `bun run check:fast` 在最终树上跑了两次：第一次退出码 1，唯一失败是 `terminal-service.test.ts`「releases only when the
  provider exited…」的**既有负载敏感抖动**（`outcome.released` 期望 true 得到 false；该文件只用 fake adapter 与 terminal/handoff
  服务，不 import 本格任何模块，单独重跑 **7 pass / 0 fail**）；第二次**退出码 0**（231 Vitest + 315 unit Bun tests，0 fail）。
  三次抖动都如实记录，不把「重跑通过」当成「从没失败」。
- 未引入任何 UI/桌面/键鼠自动化；全部断言只通过 CLI 命令面与 Runtime 命令面（含其 `--json` 输出与退出码）驱动。

### 共享槽位与本格改动文件

- **独占**：`apps/runtime/src/capacity-service.ts`（新）、`apps/runtime/src/slot-reservation-service.ts`（新）、
  `apps/runtime/src/workspace-service.ts`（追加 `prepareReservedWorkspace`）、本格测试文件、
  `docs/decisions/0032-capacity-and-slot-reservations.md`（新）、本文件本节。
- **共享槽位（按槽位写）**：`packages/storage/src/migration.ts`（只占 v21、只追加迁移常量与 `if (version < 21)`）、
  `packages/contracts/src/index.ts`（只追加容量命令组与结果类型/常量到 union 末尾）、`apps/cli/src/main.ts`
  （只加 `scheduler` 命令块与 `usage()` 追加行 + 一个 `splitFlagTokens` 辅助函数）、`apps/runtime/src/main.ts`
  （只做接线 + 启动 reconcile 追加 + shutdown 开始处 `drain.begin`）、`package.json`
  （只在 `test:unit` 忽略列表与 `test:e2e` 列表加 `cli-capacity-slots`）、`docs/decisions/README.md`（表尾追加 ADR-0032）。
- **需要说明的额外改动**：`packages/storage/src/database.ts` 与 `packages/storage/src/index.ts` —— 预留的持久化方法只能落在
  存储层（本格的「容量/槽位存储」），全部为**追加**（新方法、新类型、新错误类、新 helper），没有修改任何既有方法/类型/迁移步骤；
  另有 `apps/runtime/test/{revision-delivery,verification-cancel}.test.ts` 三行版本断言 19 → 21（升 schema 的必然连带）。
- **未改**：`apps/ui/**`、`packages/domain/**`、`packages/contracts/src/impact-policy.ts`、
  `apps/runtime/src/scheduler.ts`（候选排序/冲突判定未动，一行未改）、`packages/agent-adapters/**`、
  `session-handoff-service.ts`、`terminal-service.ts`、`PROJECT_SPEC.md`、`AGENTS.md`、`docs/architecture/**`。

### 未验证 / 不得当成已成立

- **真实多任务并发执行**：本格只提供容量/槽位原语，没有任何引擎会自己 tick；「两个任务真的同时跑起来」需要 Wave E 的 E3。
- **真实 adapter 进程并发**：端到端用的是协议 stub provider；provider 级槽位观测（例如每个 provider 进程自己的资源上限）没有实现，
  adapter slot 目前只是「每 adapter 的并发上限」这一维度的记账。
- **非 Git 共享资源**（端口/数据库/dev server 的 claim）：按用户决策 8 本波不做。
- **impact snapshot 的「快照代」重检**：本基线没有快照存储（E1 领地），只记录调用方声明的 `impact_snapshot_id`，不假装已重检。
- **真实 provider 的崩溃现场**：崩溃场景注入的是「记录到的持有者进程已死/无法核验」，不是真实 Agent 进程的崩溃（没有引擎驱动真实执行）。
- 容量默认 2 / 上限 16 的数值与「降低上限不释放已持有槽位」的语义已按 ADR-0032 记录；若用户希望不同默认或上限，改常量 + ADR 即可。
- 既有的测试遗留问题（与本次交付无关）：CLI 类测试会通过 `ensureRuntime` 启动临时 home 的 Runtime 而不 stop。
  本轮这些遗留进程**已按归属核验回收，共 43 个**（三次清理：`/tmp/ce-e2` 证据期间 1 个 + 本格 CLI 测试产生 30 个 +
  `bun run check` / `check:fast` 产生 6 个 + 最终复跑 4 个测试文件产生 6 个）。回收判据是三重证据同时成立才 SIGTERM：**argv 指向本格工作树的 Runtime 入口**
  + **cwd = 本格工作树** + **打开的状态文件落在本次夹具 home**（`/tmp/ce-e2` 或 `codeestra-slot-home-*` 等临时目录）。
  稳定 Runtime（`/Users/loyage/Documents/codeestra`）与其它 lane 工作树的进程**一个未动**（清理后实测：稳定树 2 个进程仍在、
  `-wt` 下其它 lane 8 个仍在）；全部进程收到 SIGTERM 后自行退出，没有用到 SIGKILL。
- 临时夹具与 home 全部回收：`/tmp/ce-e2`、`/tmp/ce-e2-repo`、`/tmp/ce-e2-tools`，以及本格测试产生的
  `codeestra-slot-*` 临时目录（实测剩余 0）；证据日志与清理记录是 `/tmp` 下的临时文件，已在报告后删除（关键引文已写进本节）。

## Wave E 集成记录（FOUNDATION-052/053/054，Phase 2 并行调度主体）

状态：**三格均已提交并合入 `dev`**。基线统一固定 `dev@cb7078ede92835bd3663b53dd4ac593b5543a879`（`phase1SchemaVersion = 19`），三格均未 rebase、未合并新 dev、未 push、未提升 `main`、未触碰稳定工作树。

| 格 | lane 分支 | lane commit | dev merge | FOUNDATION | ADR | schema |
|---|---|---|---|---|---|---|
| E0 | `lane/e0-phase2-decision` | `0b1d863` | fast-forward（无冲突） | 052 | 0030 | 无（纯文档） |
| E1 | `lane/e1-impact-analysis` | `749e1fd` | `c03ee45` | 053 | 0031 | **v20** |
| E2 | `lane/e2-capacity-slots` | `5982293` | `bd74e14` | 054 | 0032 | **v21** |

合并顺序 E0 → E1 → E2（E0 先落规格与决策，再落 v20，最后落 v21）。三格在各自 worktree 内都跑过完整 `bun run check` 且退出码 0：E0 纯文档（typecheck）、E1 487 pass / 0 fail（57 文件）、E2 510 pass / 0 fail（58 文件）。

### 集成时发现并修复的问题（两个分支上都没有）

1. **迁移号与常量**：E1 与 E2 各自把 `phase1SchemaVersion` 提到 20 / 21 并各自追加自己的 `if (version < N)`，合并后取 **21** 且两步按升序共存（v20 impact、v21 capacity；**没有任何 `if (version < 16)`**）。
2. **语义冲突（编译失败）**：E1 自己的迁移测试 `packages/storage/test/impact-analysis.test.ts` 写死了 `phase1SchemaVersion === 20`。在 E1 单独看是对的，在合并后（E2 的 v21）必失败。修复（`340dc67`）：断言改为 21，并说明该测试要证明的是「升级到达**当前**版本且落到本格的表」，不是「本格一定是最后一步」。这是与 Wave D 同类的问题：**单格绿、合并后才暴露**。
3. **文档合并**：E0/E1/E2 三格都按「在 `## NEXT` 之前插入一节」的槽位纪律写，三次合并撞同一锚点，按 052 → 053 → 054 手工排序，内容一字未改。
4. **`docs/tasks/README.md` 以外的 10 个文件手工冲突**（E2 合入时）：`packages/storage/src/{migration,database,index}.ts`、`packages/contracts/src/index.ts`、`apps/cli/src/main.ts`、`apps/runtime/src/main.ts`、`package.json`、两个 schema 版本断言测试。除版本号外均为**两侧都保留**（迁移两步共存、两格命令组共存、两份 import 共存、`test:unit`/`test:e2e` 列表取并集）。另外发现四处 git 的「共享前缀/后缀行」陷阱：两侧共用了同一个 `/**` 注释开头、同一个 `import {`、同一个结尾 `` `; ``，手工解决时必须把共用的那一行补回两次，否则会留下语法错误（已在提交前用 typecheck 逐一发现并修好）。

### 集成后验证

- `bun run check`（合并后的 `dev` 树，`CODEESTRA_HOME=/tmp/ce-integrate`）：退出码 0 —— 根与 UI `tsc --noEmit`、**265 项 Vitest**、**532 项 Bun tests（0 fail，61 文件）**、UI Vite 构建。
- schema 现在为 **v21**；v16 仍未使用。
- 同一次运行里有过 1 个失败是**既有负载敏感抖动**（`terminal-service.test.ts` 的 PTY 时序断言，FOUNDATION-046/050/053/054 已记录为未结项）：单独重跑 **7 pass / 0 fail**，与本波合入无关。
- 未在 `dev` 上启动真实 provider，也未触碰稳定 Runtime；集成期间产生的 `/tmp/ce-integrate` 已回收。
- **这不是 IntegrationBatch**：是用户确认后的手工 lane commit + `git merge --no-ff`。
- **本波只交付了 Phase 2 的"原语"**：ImpactSnapshot/Conflict Analyzer（E1）与容量/槽位预留（E2）已经就位，但**没有任何引擎会自动 tick**——「两个 SAFE 任务真的同时开始」与 `--allow-unknown` 命令形态要等 Wave F 的调度引擎。任何人读 FOUNDATION-053/054 时不得把它们当作「并行调度已实现」。

### 仍未验证（不得当成已成立）

- **真实多任务并发执行**：本波没有引擎；E1 的端到端只有一个候选对若干活跃 Task 的判定，E2 的端到端只到「第三个任务得到容量等待」，没有两个 Task 真的同时跑。
- **真实 Agent 的改动集是否落在声明映射里**：E1 的端到端 provider 是协议 stub；判定只对**观测到的 Git 变更集**负责。映射未声明的路径没有目录/模块语义，SAFE 的含义仍是「在声明的映射与观测事实下无法证明重叠」。
- **真实 adapter 进程并发**与 provider 级槽位观测；**非 Git 共享资源**（按决策 8 不做）；**impact snapshot 的「快照代」重检**（E2 只记录调用方声明的 id）。
- **架构文档 doc-sync 仍未做**：`sqlite-schema.md` 停在 v18，`state-machines.md`、`event-model.md` 缺 `CANCELLED`/`OperationProgressed`/`OperationSettled`，`agent-adapter.md` 缺 `controlledConfiguration`。
- **UI**：`project impact *` 与 `scheduler capacity|reservations *` 只有 CLI/命令面完备，没有任何 UI 投影（`apps/ui/**` 本波未动）。

## FOUNDATION-051 — 架构文档 doc-sync：`docs/architecture/**` 对齐已合入 `dev` 的实现（Wave F / F2，纯文档，无 ADR）

状态：**已实现、已提交并合入 `dev`**（lane commit `4dec130`，dev merge `b293e4c`，集成详情见「Wave F 集成记录」）。lane 分支 `lane/f2-doc-sync`，基线固定 `dev@866fa027c7457cba640865f1eb7ecfe52a2863d6`（未 rebase、未合并新 dev、未 pull）。**纯文档：一行 `*.ts`/`*.tsx`/`*.json` 都未改**，未改 `PROJECT_SPEC.md`、未改 `docs/decisions/**`（ADR 是历史记录）、未 push、未提升 `main`、未重启稳定 Runtime、未触碰 `/Users/loyage/Documents/codeestra`。无新 ADR：本格只同步已接受决策（ADR-0016/0018/0019/0021/0022/0023/0024/0026/0027/0028/0029/0031/0032）对应的实现。

填补的缺口是 FOUNDATION-047/049/053/054 与 Wave D/E 集成记录反复点名的「架构文档 doc-sync 未做」。

### 改动的文件

| 文件 | 改动 |
|---|---|
| `docs/architecture/sqlite-schema.md` | 状态行更新为 `phase1SchemaVersion = 21`；新增 v7/v9–v15/v17–v21 的逐版本 migration 记录与 DDL（含 CHECK/唯一索引/触发器），显式写明 **v16 永久未使用**及其原因；修正 §3 关于 `agent_sessions`/`revision_deliveries` 的过时逻辑设计说明 |
| `docs/architecture/event-model.md` | 新增 §2.1「实现中实际写入的事件」（OperationProgressed/Settled、TaskRevisionDelivery*、ExecutionSlot*、SchedulerCapacityChanged、Integration*/Promotion*、ResourcesReclaimed 等）与 §2.2「设计名与实现名的差异（交用户裁决）」 |
| `docs/architecture/state-machines.md` | §1 Task Verification 加入 `CANCELLED`；§3 新增 3.1 incarnation/单 writer lease/handoff/permission/terminal 状态；新增 §6 Runtime 生命周期与所有权（ADR-0025）、§7 Revision 投递 FSM（ADR-0028） |
| `docs/architecture/agent-adapter-api.md` | §1 加入 `controlledConfiguration` 维度并说明实现契约与设计类型的差异；新增 §3 Codex（第二个真实 Adapter，ADR-0029）的传输/权限映射/实测能力矩阵，明确 **Pi 的 PTY 交接机制不套用到 Codex** |
| `docs/architecture/scheduler.md` | 新增 §7「实现现状（Wave E / E2，ADR-0032）」：容量默认 2/上限 16、预留状态与归属证据、reconcile 判定、命令面与退出码，并显式写明**调度引擎（FOUNDATION-055）在本格之后落地** |
| `docs/architecture/conflict-analyzer.md` | 新增 §6「实现现状（FOUNDATION-053 / ADR-0031）」：`.codeestra/impact.json` 字段与确认、快照失效键、稳定 reason code 清单、命令面与退出码；新增 §7 与调度引擎的关系（无引擎） |
| `docs/architecture/README.md` | 修正「SQLite 文档…不是已执行 migration」这句已过时的描述（改为指向 §8 的已执行 migration 记录） |
| `docs/tasks/README.md` | 本节 |

`git diff --stat` 只包含 `docs/architecture/**` 与 `docs/tasks/README.md`。

### 文档段落 ↔ 代码/迁移/事件名的对应关系

- **sqlite-schema.md §8 各版本** ↔ `packages/storage/src/migration.ts` 的同名导出常量（`workspaceRetryMigration` v7、`taskControlMigration` v9、`integrationPipelineMigration` v10、`operationProgressMigration` v11、`reclamationMigration` v12、`stablePromotionMigration` v13、`sessionHandoffMigration` v14、`taskDependenciesMigration` v15、`verificationProgressMigration` v17、`sessionTerminalMigration` v18、`revisionDeliveryMigration` v19、`impactAnalysisMigration` v20、`capacitySlotReservationMigration` v21），执行顺序 ↔ `packages/storage/src/database.ts` `migrate()` 的 `if (version < N)` 链（跳过 v16）。
- **event-model.md §2.1** ↔ `packages/storage/src/database.ts` 的 `INSERT INTO domain_events(... event_type ...)` 语句与 `insertRevisionDeliveryEvent` / `insertCapacityEvent` helper；（`OperationProgressed`/`OperationSettled`、`ExecutionSlot*`、`SchedulerCapacityChanged`、`TaskRevisionDelivery*`、`Integration*`、`Promotion*`）。
- **state-machines.md §3.1/§6/§7** ↔ `session_incarnations`/`session_writer_leases`/`session_handoff_requests`/`session_permission_requests`（v14）、`session_terminals`/`session_terminal_attachments`（v18）、`task_revision_deliveries`/`task_revision_delivery_attempts`/`agent_session_startup_reconciliations`（v19）、`apps/runtime/src/lifecycle.ts`、`apps/cli/src/main.ts` 的 `codeestra stop`、`apps/runtime/src/revision-delivery-service.ts`、`apps/runtime/src/recovery-service.ts`。
- **agent-adapter-api.md §3** ↔ `packages/agent-adapters/src/codex-adapter.ts` 的 `codexCapabilities()`、`packages/agent-adapters/src/codex-protocol.ts` 的 `codexPermissionPolicy()`、`packages/contracts/src/index.ts` 的 `AdapterCapabilities.controlledConfiguration`。
- **scheduler.md §7** ↔ `apps/runtime/src/capacity-service.ts`、`apps/runtime/src/slot-reservation-service.ts`、`packages/contracts/src/index.ts` 的 `defaultConcurrencyLimit(2)`/`maxConcurrencyLimit(16)` 与 `CapacityWaitReason`、`apps/runtime/src/scheduler.ts`（仍是依赖判定器）。
- **conflict-analyzer.md §6** ↔ `packages/contracts/src/impact-policy.ts`、`packages/domain/src/impact-analysis.ts`（reason code/incomplete reason 枚举）、`apps/runtime/src/impact-analysis-service.ts`、`apps/cli/src/main.ts` 的 `project impact validate|show|explain`。

### 发现的实现/规格不一致（交用户裁决，**未**在文档里静默改写成「实现是对的」）

1. **任务书说 `sqlite-schema.md` 停在 v18，实际停在 v8**（`git log` 显示它最后在 ADR-0012 时改动）。本格因此把 v9–v21 全部补上，而不仅是 v17–v21，否则会留下 v9–v16 缺失的误导性文档。
2. **事件名大面积不一致**：实现在 `event-model.md` §2.2 逐项列出。`TaskRevisionAppended`→`TaskRevisionCreated`、`DependencyAdded`→`TaskDependencyAdded`、`ExecutionResultCaptured`→`ResultCommitCreated`、`DevIntegrationCandidateCreated`→`IntegrationBatchCreated`、整组 `StablePromotion*`→`Promotion*` 等。需要裁决：是把设计目录改成实现名，还是保留设计名并给实现名加映射（本格选了后者，不静默改写设计）。
3. **交接/终端事件完全未实现**：`TakeoverRequested`/`SessionHandoffStarted`/`TerminalWriterLeaseChanged`/`RevisionDelivered`/`RevisionAcknowledged` 等在设计目录里，但代码中**不存在**（grep 命中 0）。实现只写对应的表。需要裁决。
4. **`AdapterCapabilities` 的设计类型与实现契约不一致**：设计里有 `nativeTerminalHandoff`/`safePointNotification`，实现契约里没有；实现新增了 `controlledConfiguration`（本格已补进设计类型）。
5. **§3 逻辑设计与实现不同**：设计写「一个 Execution 可有多条 AgentSession」，实现（v14）保留 `agent_sessions.execution_id UNIQUE`，把进程交接收敛为同一 Session 内的 incarnation。这是 ADR-0023 的明确选择，本格按 ADR 更新了文档并标注。
6. **`sqlite-schema.md` §4 的 `impact_assessments`/`conflict_assessments` 逻辑 DDL 与 v20 实现不同**（ADR-0031 重定义了形态）。本格把 §4 标为已被 §8 v20 取代。

### 自查结果

- `grep -c "CANCELLED" docs/architecture/state-machines.md` ≥ 1：**通过**。
- `sqlite-schema.md` 的 v19/v20/v21 三节都在：**通过**。
- `grep -c "v16" docs/architecture/sqlite-schema.md` ≥ 1 且写明「永久未使用」：**通过**（3 处）。
- `git diff --stat` 只含 `docs/architecture/**` 与 `docs/tasks/README.md`：**通过**（见报告）。
- 未改动任何 `*.ts`/`*.tsx`/`*.json`、`PROJECT_SPEC.md`、`docs/decisions/**`。

### 未覆盖 / 未验证

- 本格没有跑 `bun run check`：纯文档改动，且基线已有基线自身的检查结果；不改代码不产生新的可运行断言。**未验证**的部分已在各文档中标注（例如 `SessionGuidance*` 事件在实现中的存在性）。
- 未改写任何 ADR；如果上述不一致需要新决策，应由相应 lane 写新 ADR，而不是本格。
- 本格不包含调度引擎；F1（FOUNDATION-055）会补 `scheduler.md` 的「引擎真的会跑」部分。

## FOUNDATION-055 — 调度引擎：自动 tick、候选顺序、等待语义、`--allow-unknown` 与 §4 越界处置（Wave F / F1）

状态：**已实现、已提交并合入 `dev`**（lane commit `e204693`，dev merge `1e458ba`，集成详情见「Wave F 集成记录」）。lane 分支 `lane/f1-scheduling-engine`，基线固定
`dev@866fa027c7457cba640865f1eb7ecfe52a2863d6`（未 rebase、未合并新 dev、未 pull、未 push、未提升 `main`、
未重启稳定 Runtime、未触碰 `/Users/loyage/Documents/codeestra`）。ADR：**0033**。schema：**未占用**（仍 v21；
`packages/storage/src/migration.ts` 一行未动，v22 未被占用，也没有插入 `if (version < 16)`）。

### 已实现

**调度循环（`apps/runtime/src/schedule-service.ts`，新）**

- 稳定顺序 priority 降序 → `createdAt` 升序 → ID 升序；逐候选的判定顺序照 `scheduler.md` §2：
  依赖（未满足/上游 commit 不可达 ⇒ `BLOCKED`）→ 冲突判定 → 容量 → 预留 → worktree → 启动前基线重检 → 启动一个主 Agent。
  「没有 Adapter 可用」不是 `BLOCKED`，是一类带稳定 detail 的 `SKIPPED`。
- **冲突判定调用 E1 的分析器**（`inspectTaskImpact` 观测 + 纯域 `assessCandidate`），调度器不产生 `SAFE`；
  配对判定照 E1 的契约写 append-only 的 `impact_assessments` 审计行。候选没有 worktree 时，其观测改动集是**空集**
  并经 `createImpactSnapshot` 得到预测（映射完整且确认 ⇒ `complete`），预测本身也记为一个 append-only 快照
  （稳定指纹 `codeestra:pre-start-impact:no-observed-change`，evidence 写明「尚无 worktree」）。**这条残余风险不掩盖**：
  空预测与任何活跃任务都不重叠，两个刚提交、还没写出任何东西的任务会被判成 SAFE 并并行——这正是 §4 存在的原因。
- **容量走 E2 的预留原语**：`SlotReservationService.acquire` 在 `BEGIN IMMEDIATE` 内重检 task 版本、revision、依赖指纹、
  两个容量维度与 draining；`GLOBAL_CAPACITY` 与 `ADAPTER_CAPACITY` 分开报告。拿到槽位后准备 workspace，预留 Execution，
  启动 Agent，然后**把预留交给 Execution**（释放原因写明「Execution 已持有资源」，`actor = runtime-scheduler`），
  因此不会留下两份账；崩溃在预留与 Execution 之间时由 E2 的启动 reconcile 按归属核验收敛。
- **启动前重检**：重读 `dev`，与预留记录的 `assessed_dev_commit` 不一致 ⇒ 不启动、释放预留、按 `STALE_BASE` 等待；
  revision 变化 ⇒ 同样不启动。
- 触发面：`task.submit`（同一命令内进入调度，响应里带回 pass 结果）、`task.integrate`、`task.pause|cancel`、
  `task.resume`、`task.schedule.run`、槽位释放、容量变更、修订投递 resolve、执行结束（coordinator 结算后回调），
  以及启动时的一次 `STARTUP` pass 与周期恢复 pass（默认 5s，`CODEESTRA_SCHEDULE_TICK_MS` 可调）。
  **周期 pass 只收敛不启动**：它刷新活跃任务的观测、检测越界、记录等待；启动只由事件或显式命令触发（理由见 ADR-0033 D01）。
  Runtime 内 pass 互斥。
- **活跃集合按 §1**：E1 的资源持有投影 **∪** 仍持有 worktree 的 `PAUSED` 任务。后者的必要性来自一处**既有不一致**：
  暂停确认会把 Execution 置成 `SUPERSEDED`、`resource_held = 0`，所以 PAUSED 既不在 `listImpactActiveTasks` 也不占容量——
  与 ADR-0031 D06 / ADR-0032 D03 的文字相矛盾。本格只在**冲突侧**把它补回来（否则两个范围重叠的 PAUSED 任务可被同时恢复），
  **容量口径一个字没改**（那是 E2 的语义），不一致已写进 ADR-0033 D06 与本文档。
- **§4 实际 diff 超出预测**：以「启动它时依据的那份预测」（`TaskScheduleDecided.candidateSnapshotId`）比对 worktree 现状；
  同 revision/baseline/映射/分析器下改动集合真的变了才叫越界；**可证明重叠**时写 `TaskImpactPredictionRevoked`
  （前后快照 id、增删路径、命中任务、reason code）并经**既有协作暂停**请求该任务安全暂停（确认不了即落 `RECOVERY_REQUIRED`，
  现场保留、禁止自动集成）；同一份观测只撤销一次；不与其他活跃任务可证明重叠时只记录不暂停；**绝不抢占任何任务**。

**`--allow-unknown`（显式单次放行）**

- 命令面：`task run … --allow-unknown`、`task resume … --allow-unknown`、`task schedule clear-unknown <project> <task>`。
- 落点：append-only 事件 `TaskUnknownCleared`（`correlation_id` = 调用命令 ⇒ 重放不产生第二条），绑定
  `revisionId`/`baseCommit`/`analyzerVersion`/`policyVersion`/当时 `reasonCodes`/`hits`/`releasedBy`，`scope = SINGLE_START`。
  **不占 schema**；**被一次启动消费**（决策事件里的 `clearedUnknownBy` = 放行事件 id）；**不改写判定**（`impact_assessments`
  仍是 UNKNOWN，测试断言放行后 `project impact explain` 仍返回 UNKNOWN）；revision/baseline/映射/分析器任一变化即失效。
- **只放行 UNKNOWN**：`CONFLICTING` 被拒绝（退出码 1，状态 `CONFLICTING`）。放行后该任务可与活跃任务并发，不降级为独占。

**门禁形状（本轮用户拍板 + 一处保守化，已在本报告里明说）**

- 自动 pass **只启动能证明 SAFE 的候选**；`UNKNOWN` 一律等待（活跃集为空也一样）。
- 显式请求（`task run`/`task resume`/`task schedule run`/`plan`/`explain`）与自动 pass 共用同一门禁，但允许 `UNKNOWN`
  在**活跃集为空**时独占启动（`scheduler.md` §2「单任务且影响未知可以独占运行」）；活跃集非空时需要 `--allow-unknown`。
  这样「UNKNOWN 默认等待」与「可以独占运行」不再互相打架：等待是默认，独占是用户显式请求的结果。

### 命令面（零新增确认、`--json`、稳定退出码）

```
task schedule status <project-id> [--adapter <id>] [--json]      # 只读：活跃集、容量、上次 pass
task schedule plan   <project-id> [--adapter <id>] [--json]      # 同一套判定的有序 dry run：不预留、不 prepare、不启动
task schedule explain <project-id> <task-id> [--adapter <id>] [--json]
task schedule run    <project-id> [--adapter <id>] [--json]      # 请求一次 pass
task schedule clear-unknown <project-id> <task-id> [--json]      # 只记放行，不启动
task run    <project-id> <task-id> <version> [--adapter <id>] [--allow-unknown] [--json]
task resume <project-id> <task-id> <version> [--adapter <id>] [--allow-unknown]
```

- `explain` 回答「为什么这个任务现在没在跑」：依赖 verdict、与每个活跃任务的 verdict 与命中范围（路径/目录/模块/共享资源）、
  容量数字、等待原因；`PAUSED` 任务还会给出「恢复是否被允许」的判定。退出码 **0** = 在跑或现在会启动、**3** = 等待
  （冲突或容量——等待从来不是 `BLOCKED`）、**1** = `BLOCKED` 或不可调度。
- `task.run` 同构：**0** 启动、**3** 等待（reason code 在 `--json` 与 stderr）、**1** 拒绝（`BLOCKED`/`CONFLICTING`/不可启动状态），
  且响应是**既有结果的超集**（`executionId`/`sessionId`/`workspacePath`/… 原样保留，调度事实并列返回），既有客户端不必改。
- 自动选择 Adapter：`pi` 已注册则用，否则第一个已注册；`--adapter` 覆盖；判定与事件记录实际使用的 Adapter。没有新增配置语义。
- 事件名不碰 E2：新增 `TaskScheduleDecided`/`TaskWaitingForConflict`/`TaskWaitingForCapacity`/`TaskUnknownCleared`/
  `TaskImpactPredictionRevoked`（`aggregate_type = 'TaskSchedule'`），`ExecutionSlot*`/`SchedulerCapacityChanged` 未复用未改名。
  等待事件只在等待**发生变化**时写一条（code + reasonCodes + blocking 去重），因此能读出「从何时起为什么在等」。

### 验证（只用 CLI/命令面与 Runtime 命令面）

- `apps/runtime/test/schedule-service.test.ts`（**10 项**，进程内；真实临时仓库 + 真实数据库 + 真实预留原语，只**注入**「启动 Agent」
  这一步）：候选顺序与「提优先级只改顺序、不动已持有资源的任务」；两个 SAFE 都启动 + 第三个 `CAPACITY_GLOBAL_LIMIT_REACHED`
  （且不是 `BLOCKED`、未创建 Execution）；无映射时自动 pass 等待、显式请求独占启动、有活跃任务时等待、`--allow-unknown`
  可与活跃任务并发启动且审计绑定可读、判定仍 UNKNOWN、放行被一次启动消费、基线移动使放行失效；越界成长 ⇒ 撤销 + 请求暂停；
  同文件重叠时恢复被拒（`--allow-unknown` 也拒）；依赖未满足是 `BLOCKED` 且不启动；两次 pass / 两个并发请求只产生一个 Execution；
  PAUSED 仍在冲突活跃集合（即便不占槽位）；残留预留让启动被拒绝而不是重复创建。
- `apps/runtime/test/cli-schedule.test.ts`（**6 项**，真实 CLI + 真实 Runtime + 独立 `CODEESTRA_HOME` + 临时仓库 + 协议 **stub** provider）：
  1) submit 即自动启动两个 SAFE 不相交任务、都 RUNNING、容量 2、第三个 `task run` 退出 3 且 code 是 `CAPACITY_GLOBAL_LIMIT_REACHED`
  （stderr 里不出现 `BLOCKED`）、审计里有两条 `TaskScheduleDecided`（第二条 `activeTaskIds = [第一个]`）与 `TaskWaitingForCapacity`；
  2) 同文件重叠的 PAUSED 任务 `explain` 给 `WAIT_CONFLICT`/`SAME_FILE` + 命中路径，`resume` 退出 1 且保持 PAUSED，
  `--allow-unknown` 与 `clear-unknown` 都拒绝；3) 无映射项目自动 pass 等待、`task run` 独占启动、第二个任务等待、
  `--allow-unknown` 与活跃任务并发启动、`TaskUnknownCleared` 绑定可读、`project impact explain` 仍 UNKNOWN；
  4) 两次 `task schedule run` + 两个并发 `task run` 只产生一个 Execution，stub 日志每个任务一行；
  5) 越界 ⇒ `TaskImpactPredictionRevoked` + 两个任务都被协作暂停 + 恢复被拒 + 现场保留；
  6) SIGKILL 崩溃后新 generation 不重复创建 Agent（Execution 唯一、stub 日志一行、启动 pass 不再启动它）。
- 既有 e2e 回归：`apps/runtime/test/cli-impact.test.ts` 的 fixture 改为「submit 后等调度器启动」（ADR-0030 D04 的必然结果，
  用户本轮明确同意只改 fixture 两行 + 注释），其余 195 项既有 e2e 未改动并保持通过。
- `bun run check:fast`：退出码 0（root + UI typecheck、265 项 Vitest、**346 pass / 0 fail**，34 文件）。
- `bun run check`：见下方「本次实际运行的检查」。
- 手动端到端证据：`CODEESTRA_HOME=/tmp/ce-f1` + 临时仓库 `/tmp/ce-f1-repo`（含 `.codeestra/impact.json`）+ 协议 stub
  provider（`/tmp/ce-f1-tools/stub-pi.ts`）：`task submit` 的两个任务都进入 RUNNING 且各自 worktree 里有自己的产物、
  `scheduler capacity get` 报 `globalUsed = 2`、`task schedule run` 检测到越界并给出 `TaskImpactPredictionRevoked`
  + `pauseOutcome`。结束前 `stop`，并回收本 home 下的 Runtime 与 stub 进程（ps + lsof 三重证据后 SIGTERM）。

### 本次实际运行的检查（本条即运行记录）

| 检查 | 命令 | 结果 |
|---|---|---|
| 快速循环 | `bun run check:fast` | 退出码 **0**：root + UI `tsc --noEmit`、**265 项 Vitest**、**346 pass / 0 fail**（34 文件） |
| 完整检查 | `bun run check`（最终代码上重跑） | 退出码 **0**（`CHECK_EXIT=0`）：`tsc --noEmit`（root + UI）、**265 项 Vitest**、`test:storage` **548 pass / 0 fail**（63 文件，含本格 16 项）、UI Vite 构建成功 |
| 本格进程内 | `bun test apps/runtime/test/schedule-service.test.ts` | **10 pass / 0 fail** |
| 本格端到端 | `bun test apps/runtime/test/cli-schedule.test.ts` | **6 pass / 0 fail**（真实 CLI + 真实 Runtime + 临时 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider；含「查询类命令不启动任何东西」的断言） |
| 既有无回归 | `bun run test:e2e` | **196 pass / 0 fail**（28 文件；其中 `cli-impact.test.ts` 只改了 fixture） |
| 手动端到端证据 | 见下一节 | 见下一节 |

**未运行 / 无法运行**：真实 provider（Pi/Codex）并发；真实模型驱动两个任务同时工作；UI 投影（未接入 `task schedule *`）；
`task revision delivery resolve` 启动路径的冲突门禁（本格未接）。这些都在下节「未做 / 未验证」里，不得当成已成立。

### 手动端到端证据（`CODEESTRA_HOME=/tmp/ce-f1`，本次会话实际输出）

环境：临时仓库 `/tmp/ce-f1-repo`（`.codeestra/impact.json` 声明 `importantDirectories: ["core"]` 与模块 `core/**`，
`main`/`dev` 双分支）＋ `CODEESTRA_HOME=/tmp/ce-f1` ＋ **协议 stub** provider（`/tmp/ce-f1-tools/stub-pi.ts`：按任务规格里的
`write:<path>` 写文件，然后保持这一轮开启；它**不是真实 Agent**，只证明 Runtime 的编排）。原始日志留在 `/tmp/ce-f1-evidence.log`。

| 步骤 | 实际观察到的结果 |
|---|---|
| `task submit` A（`write:core/first.ts`） | `schedule.trigger = SUBMIT`、`started = [A]`：**提交后自动进入调度并在同一命令内启动** |
| `task submit` B（`write:core/second.ts`） | `started = [B]`；两个任务同时 RUNNING，两个 worktree 里各自出现 `core/first.ts` / `core/second.ts` |
| `task schedule explain <paused A>` | 退出码 **3**、`decision = WAIT_CONFLICT`、`verdict = CONFLICTING`、`reasonCodes = [IMPORTANT_DIRECTORY_OVERLAP, SAME_MODULE]`、`blocking = [C, B]`、detail 里给出相交目录 `core` |
| `task resume A` | 退出码 **1**、`CONFLICTING: The Task stays paused: …`，A 仍是 `PAUSED`（**同文件/重要目录 → 串行**） |
| `task submit` D（`write:src/agent/d.ts`，与活跃任务不相交） | `started = [D]`；`scheduler capacity get` → `globalUsed = 2 / globalLimit = 2` |
| `task submit` E（不相交，但容量已满） | `started = []`、`waiting = [(E, CAPACITY, CAPACITY_GLOBAL_LIMIT_REACHED)]` |
| `task run E 1 --json` | 退出码 **3**、`outcome = WAIT`、`wait.kind = CAPACITY`、`code = CAPACITY_GLOBAL_LIMIT_REACHED`、`blocking = [D, C]`、`verdict = SAFE_TO_PARALLELIZE`；stderr：`[scheduler] CAPACITY wait: CAPACITY_GLOBAL_LIMIT_REACHED — 2 of 2 project slots are in use`（**不是 `BLOCKED`**） |
| `task schedule run`（两个 Agent 都已写出 `core/*.ts` 之后） | `impactGrowth`：`addedPaths: ["core/second.ts"]`、`conflictingTaskIds: [A]`、`reasonCodes: [IMPORTANT_DIRECTORY_OVERLAP, SAME_MODULE]`、`pauseRequested: true`、`pauseOutcome: "PAUSED/RELEASED: Session had already exited (requested: …)"`——**用既有协作暂停，不是抢占** |
| `events list`（本次 99 条事件里的 8 条调度事实） | `TaskScheduleDecided A SAFE_TO_PARALLELIZE active=[]`、`TaskScheduleDecided B SAFE_TO_PARALLELIZE active=[A]`、`TaskImpactPredictionRevoked added=['core/second.ts'] conflicts=[A] reasons=[IMPORTANT_DIRECTORY_OVERLAP,SAME_MODULE] pauseRequested=true`、`TaskImpactPredictionRevoked added=['core/first.ts'] conflicts=[B] …`、`TaskScheduleDecided C SAFE_TO_PARALLELIZE active=[A,B]`、`TaskWaitingForConflict A IMPORTANT_DIRECTORY_OVERLAP`、`TaskScheduleDecided D SAFE_TO_PARALLELIZE active=[C,A,B]`（**A、B 已是 PAUSED 仍在活跃集合里**——§1 活跃集合的补回在此可见）、`TaskWaitingForCapacity E CAPACITY_GLOBAL_LIMIT_REACHED blocking=[D,C]` |
| 收尾 | `codeestra stop` 退出码 0、`status = STOPPED`；随后按 ps + lsof 证据用 **SIGTERM**（未用 SIGKILL/`--force`）回收本会话在该 home 下产生的全部 Runtime 与 stub 进程（回收后 `ps` 计数为 0）；`/tmp/ce-f1`、`/tmp/ce-f1-repo`、`/tmp/ce-f1-tools`、`/tmp/ce-f1-evidence.log` 保留为证据 |

### 手动端到端证据之二：`--allow-unknown`（无映射项目 `/tmp/ce-f1-unknown`，同一 stub）

`/tmp/ce-f1-unknown-repo` **没有** `.codeestra/impact.json`，因此判定恒为 `UNKNOWN (INCOMPLETE_IMPACT)`。实际输出
（原始日志 `/tmp/ce-f1-unknown-evidence.log`）：

| 步骤 | 结果 |
|---|---|
| `task submit A 0`（自动 pass） | `started: []`、`waiting: [{A, kind: CONFLICT, code: INCOMPLETE_IMPACT}]`——**提交后自动进入调度，但 UNKNOWN 默认等待** |
| `task run A 1 --json` | 退出码 **0**、`outcome: STARTED`、`verdict: UNKNOWN`、`clearedUnknownBy: null`（活跃集为空 ⇒ 显式请求可独占运行，无需放行） |
| `task submit B 0` + `task run B 1 --json` | 退出码 **3**、`wait {kind: CONFLICT, code: INCOMPLETE_IMPACT, blocking: [A]}`；stderr：`pass --allow-unknown to start it anyway (single-shot, audited)` |
| `task run B 1 --allow-unknown --json` | 退出码 **0**、`outcome: STARTED`、`verdict: UNKNOWN`、`clearedUnknownBy: b27e87a1-…`；A 与 B **同时 RUNNING**（放行允许与活跃任务并发） |
| `project impact explain B --json` | 退出码 **1**、`verdict: UNKNOWN`、`reasonCodes: [INCOMPLETE_IMPACT]`——**放行没有改写判定** |

审计片段（`events list` 原文，节选）：

```json
{
  "eventType": "TaskUnknownCleared",
  "aggregateType": "TaskSchedule",
  "correlationId": "c9ce85f3-55ad-4872-9bc8-392fd1c7d398",
  "payload": {
    "taskId": "4ad466a9-…", "revisionId": "3b62b818-…",
    "baseCommit": "75d150906cea9bef7d45f3d41f7ec636ab23c7ff",
    "analyzerVersion": "impact-analyzer-v1",
    "policyVersion": "impact-policy-v1#absent",
    "candidateSnapshotId": "ed1693ea-…",
    "verdict": "UNKNOWN",
    "reasonCodes": ["INCOMPLETE_IMPACT"],
    "hits": [ {"reason": "INCOMPLETE_IMPACT", "class": "INCOMPLETE", "taskId": "4ad466a9-…",
               "detail": "impact is incomplete: POLICY_ABSENT"}, {"…": "…", "taskId": "823fb65a-…"} ],
    "releasedBy": "local-user",
    "releasedAt": 1789398378555,
    "scope": "SINGLE_START",
    "detail": "explicit single-shot release of an UNKNOWN assessment; it does not change the recorded verdict, and it stops applying when the revision, the baseline or the analyzer/policy version changes"
  }
}
```

以及消费它的那次启动决定（同一 Task 的 `TaskScheduleDecided`）：

```json
{ "verdict": "UNKNOWN", "reasonCodes": ["INCOMPLETE_IMPACT"],
  "clearedUnknownBy": "b27e87a1-1e1d-4826-b202-6cd6e8fd0683",
  "analyzerVersion": "impact-analyzer-v1", "policyVersion": "impact-policy-v1#absent",
  "baseCommit": "75d150906cea" }
```

两次手动运行都以 `codeestra stop`（退出码 0、`status: STOPPED`）结束，并按 ps + lsof 证据 SIGTERM 回收了本会话在这两个 home 下
产生的全部 Runtime 与 stub 进程（回收后 `ps` 计数为 0）。

**一处如实说明**：这次手动运行里，第三个任务 C **被启动了而不是容量等待**——因为 `task schedule run`/submit 的 pass 会**先**做 §4 的越界检测，
发现 A、B 的 diff 已长进声明范围并互相可证明重叠，于是**先**把两者暂停（PAUSED 不占槽位，见「未做/未验证」），容量因此空出来。
这是设计内的顺序（先撤销旧 SAFE，再考虑新候选），「容量为 2 时第三个 → 容量等待」则在自动化端到端测试
（`cli-schedule.test.ts` 第 1 项，两个不相交任务不触发 §4）与上表 `task run E` 那一步里各自被断言到。

## FOUNDATION-056 — Agent 在散文里提问：不得静默记为 `SUCCESS`（ADR-0004/0014 语义内）

状态：**已实现、已提交并合入 `dev`**（lane commit `db4783d`，dev merge `2182ab5`），并在 CLI/命令面端到端验证（真实 CLI + 真实 Runtime + 协议 stub provider + `CODEESTRA_HOME=/tmp/ce-f3`）。
本格是用户已拍板的**保守方案**：只保证「不得静默记为 `SUCCESS`」。**不新增审批/Attention 语义、不改 Task/Execution 状态机、不新增任何确认步骤、不加 schema 版本、不加迁移。**
任务来源：`## NEXT` 第 6 条 = FOUNDATION-030「剩余问题」的第一条（散文提问仍被记为 `SUCCESS`）。

### 要解决的问题

Agent 有时**不调用任何工具、直接在散文里问一个问题然后结束轮次**。今天这条结束在 `agent_sessions.exit_json` 里就是 `outcome: "SUCCESS"`、
在 run Operation 里就是 `AGENT_SETTLED/SUCCEEDED`，于是任务看起来「成功但什么都没做」——`SUCCESS` 没有任何说明。
本格给这种结束一个**稳定的 reason code 与可审计的事实**，让它在命令面上自我解释；**不**把它升级成 Attention 或 `WAITING_FOR_USER`（那会改变状态机语义，属于本格之外）。

### 判据（集中一处、可单测、明确是启发式）

**事实层（Adapter，`packages/agent-adapters/src/pi-adapter.ts`）**：只从 provider 自己的 RPC 记录里读，不做任何解释，随 `completed` 事件的 `facts` 上报：

| 事实 | 来源与含义 |
|---|---|
| `toolCallCount` | 整个 run 内 provider 报出的工具调用，**按 provider 给的 `toolCallId` 去重**（`tool_execution_start`、助手消息里的 `toolCall` 内容块、`toolResult` 消息三处任一出现即算；同一 id 只算一次） |
| `finalAssistantText` | 最后一条**有文本**的助手消息的 text 块按顺序拼接（只有工具调用的助手消息不算“结束语”），**保留尾部**并截断到 2000 字符 |
| `finalAssistantTextTruncated` | 上面的截断是否发生（规则看的是尾部，所以截断不影响判定，但必须如实记录） |
| `finalAssistantStopReason` | provider 自己报的 stopReason（`stop`/`toolUse`/`error`…），未报则 `null` |

Adapter **报不出事实时不猜**：`facts` 字段整体缺席表示“未知”，不表示“没有工具调用”。

**规则层（纯函数，`packages/domain/src/agent-completion-signal.ts`）**：只有同时满足以下条件才产出 note：

1. `toolCallCount === 0`（整个 run 没有任何工具调用证据）；
2. `finalAssistantText` 去空白后非空；
3. 去掉尾部装饰字符（`* _ ` " ' ’ ” ) ] } 】 》 > .`）后，**最后一个字符是 `?` 或 `？`**；
4. 问号之前还剩 **≥2 个字符的实际文字**（去掉装饰字符与空白后计），所以裸 `?`、`??`、`**?` 都不算。

命中后记 `code = PROSE_QUESTION_NO_TOOL_USE`、`heuristic = NO_TOOL_CALLS_IN_RUN_AND_TRAILING_QUESTION_MARK`，并把**它看到的那份 facts 原样带在 note 里**（`note.facts`），所以任何人都能重新核对这条判定。

**这是启发式，不是语义判定。** note 的文案本身写明这一点（“This is a heuristic about the shape of the ending, not a semantic judgement that the Agent is waiting for an answer.”）。

#### 漏报 / 误报取舍（宁可漏报，不要误报）

把正常完成错标成可疑，和把可疑完成说成正常，是同一种谎报。因此规则往**窄**里取：

- **会漏报（已知、故意）**：中文问句不以 `？` 结尾（例如 `…可以吗`）；问号后面还有别的正文；Adapter 不提供 `facts`（**Codex 目前不提供**，见下）；只有 `?` 或极短尾巴；认为“提问”但不以问号结尾的英文句式。
- **计数取 run 级而不是 turn 级**：turn 级会把「干完活之后随手问一句 Want me to also…?」也算上，那恰恰不是用户抱怨的「成功但什么都没做」。run 级更少触发，符合“宁可漏报”。
- **不做语义判定**：不判断“是不是真的在等用户回答”，也因此**不**产生 Attention、**不**进 `WAITING_FOR_USER`、**不**增加任何确认步骤（不变量 9/21/23、第一原则 1 与 3）。
- **不许把结论写进状态**：note 只是一个附注事实，Task/Execution 状态一个都不变。

### 记录与可见（命令面）

- **持久化**：`agent_sessions.exit_json`（既有 JSON 列，**无需迁移**）存 `facts` 与 `note`；`AgentSessionCompleted` 领域事件 payload 也带 `note`，所以 `events list/tail` 与事件订阅都能读到同一条事实。
- **命令面字段**：`task status <project-id> <task-id> --json` → `executions[].session.completion = { outcome, evidenceRef, failure, facts, note }`；`note` 为 `null` 表示这次完成不需要附注。
- **CLI 显示**：`task status` 仍打印 JSON（`--json` 现在被显式接受，默认即是），但当存在 note 时**额外向 stderr 打印一行** `[note] <execution> (<session>) ended SUCCESS with PROSE_QUESTION_NO_TOOL_USE: …`；未知 flag 仍是 usage error（exit 2）。stdout 的 JSON 不被污染。
- **明确没做**：run Operation 的 `AGENT_SETTLED/SUCCEEDED` 一字未改（所以“命令面哪里还能看到未加说明的 SUCCESS”这个问题的答案是：run Operation 仍是既有措辞，**说明性的那条事实挂在执行/会话完成上**）；不改 `apps/ui/**`（本波不在领地）。

### 测试

- `packages/domain/test/agent-completion-signal.test.ts`（vitest，7 项）：命中形态（`?`/`？`、Markdown 装饰、多段文本尾问号）、命中时 facts 原样带回、有工具调用（含“结构化提问也是工具调用”）不命中、`null`/空/纯空白/无问号/问号在中间/中文无问号不命中、裸 `?` 不命中、截断尾巴仍命中、幂等（同输入同输出）。
- `packages/agent-adapters/test/pi-completion-facts.test.ts`（bun，4 项，协议 stub provider）：无工具 + 尾问号 → `toolCallCount: 0` 与精确文本；同一 `toolCallId` 被三条记录（start / 助手消息 / toolResult / `turn_end` 重复）提及 → **只算 1**；超长文本 → 保留 2000 字符尾部且 `finalAssistantTextTruncated: true`；只有工具调用、没有任何助手散文 → `finalAssistantText: null`。
- `apps/runtime/test/agent-observation-service.test.ts`（bun，7 项，真实 storage + 真实 Adapter 合约 + 确定性 fake Agent）：散文提问结束 → `PROSE_QUESTION_NO_TOOL_USE` 被记录（exit_json 与 `AgentSessionCompleted` 事件各一处）、结果仍是 `SUCCESS`/Session `EXITED`、**没有 Attention**、Task 仍 `RUNNING`；有工具调用的正常完成 → **不标注**（但 facts 仍记录）；Agent 不报 facts → 不标注；**结构化 `ask_user_question` 路径**（一条 QUESTION Attention + 在观察循环内投递回答，与 Runtime pump 同路径）→ 仍然只有那一条 Attention、完成时 `toolCallCount = 1` 且 `note: null`，**不被启发式重复标注**；FAILURE 完成 → 不附注（失败本身已解释自己）；断连（`exit_json` 不是完成 payload）→ `completion: null`，**不编造**；**重复事件/重放** → 第二次是 `duplicate: true`，`adapter_events` 仍只有一行、note 不重复记录。
- `apps/runtime/test/cli-prose-question.test.ts`（bun，2 项，**真实 CLI + 真实 Runtime + 协议 stub provider**）：
  1. 散文提问结束：`task status --json` 报 `note.code = PROSE_QUESTION_NO_TOOL_USE`（附 facts）、stderr 有 `[note]` 行、`task.state` 仍是 `RUNNING`、`attention list` 为 `[]`、`events list` 里 `AgentSessionCompleted` 带同一 code、run Operation 仍是 `AGENT_SETTLED`、未知 flag exit 2；
  2. 有工具调用且同样以问号结尾：`note: null`、`facts.toolCallCount = 1`、stderr 无 `[note]`。

实际跑过的检查（如实记录，不把「重跑通过」当作「从没失败」）：

- `bun run test`（vitest）：5 文件 / **272 项通过**。
- `bun run test:unit`：**347 项通过（0 fail，35 文件）**。
- `bun run check`（`CODEESTRA_HOME=/tmp/ce-f3`）第一次：typecheck、UI typecheck、272 vitest、unit 均通过；`test:storage` 跑 **543 项 / 64 文件**，其中 **1 项失败**是既有负载敏感抖动（`session-handoff-service.test.ts`「makes the incarnation check part of the claim, so two answers cannot both win」，与本格无 import 关系），单独重跑该文件 **11 pass / 0 fail**；因为这一步非零退出，`build:ui` 未执行。
- `bun run check` 第二次（**最终树**，当时 unit 为 345 项）：**退出码 0** —— 根与 UI `tsc --noEmit`、272 项 Vitest、345 项 unit、**543 项 Bun tests（0 fail，64 文件）**、UI Vite 构建全部通过。
- 另外单独跑过三次 `bun run test:storage`：两次 **543 pass / 0 fail**，一次 1 fail（同一类抖动，本次未捕获到用例名）；抖动用例集中在 handoff/PTY 时序断言，与本格新增文件无关。
- 本格新增/改动的文件单独跑均 0 fail：`bun test apps/runtime/test/agent-observation-service.test.ts`（7 pass）、`bun test packages/agent-adapters/test/pi-completion-facts.test.ts`（4 pass）、`bun test apps/runtime/test/cli-prose-question.test.ts`（2 pass）。
- **手工端到端（真实 CLI + 真实 Runtime + 协议 stub provider，`CODEESTRA_HOME=/tmp/ce-f3`）**：
  - `task run` 退出码 0；`task status <p> <t> --json` 退出码 0，`executions[0].session.completion` 为
    `{"outcome":"SUCCESS","facts":{"toolCallCount":0,"finalAssistantText":"Which package manager should I use?","finalAssistantTextTruncated":false,"finalAssistantStopReason":"stop"},"note":{"code":"PROSE_QUESTION_NO_TOOL_USE","heuristic":"NO_TOOL_CALLS_IN_RUN_AND_TRAILING_QUESTION_MARK",…}}`，
    Task 仍为 `RUNNING`；stderr 多出 `[note] <execution> (<session>) ended SUCCESS with PROSE_QUESTION_NO_TOOL_USE: …`。
  - `attention list` → `[]`（没有新增 Attention）；`events list` → `AgentSessionCompleted.payload.note.code = PROSE_QUESTION_NO_TOOL_USE`；
    run Operation 仍为 `SUCCEEDED`/`AGENT_SETTLED`（本格未改它的措辞）；`task status … --bogus` → **exit 2**。
  - 对照组（stub 先调一次工具、再以问号结尾）：`note: null`、`facts.toolCallCount: 1`、stderr 无 `[note]`。
  - 该 home 已 `stop` 并确认进程退出；夹具（`/tmp/ce-f3{,-repo,-tools,-assets}`）已删除。
- 全程只用 CLI 与 Runtime 命令面（含 `--json`、退出码、`events list`）驱动断言；没有使用 computer-use、桌面或浏览器自动化，没有获取电脑控制权。

### 测试夹具与进程回收（归属证据）

- 本格自己启动的夹具与进程全部回收：手工验收的 `/tmp/ce-f3{,-repo,-tools,-assets}`、以及 `bun run check` 跑出的 6 个临时 home Runtime
  （`codeestra-slot-home-*`，来自既有的 `cli-capacity-slots` e2e 遗留：这些 CLI 测试会 `ensureRuntime` 启动临时 home 的 Runtime 而不 stop）。
- 回收判据是**三重证据同时成立**才 SIGTERM（不是 SIGKILL）：**argv 指向本格工作树的 Runtime 入口** + **cwd = 本格工作树** + **打开的状态文件落在自己的临时夹具 home**。
  6 个进程全部 SIGTERM 后自行退出（`exited`），稳定 Runtime（`/Users/loyage/Documents/codeestra`）与其它 lane（`f1-scheduling-engine`、`f4-test-runtime-leak`）的进程**一个未动**。
- 共享 OS 临时目录里仍有几个无法归属于本格的夹具目录（`codeestra-config-*`、`codeestra-deps-home-*`，其它 lane 同时在跑同名测试文件），归属无法证明，**按规则不删**。

### 未验证（不得当成已成立）

- **真实 provider 的语气/语言差异**：端到端用的是协议 stub provider，**不是真实 Agent 集成证据**。中文问句（不带 `？` 结尾）、多段叙述、Markdown 结构、emoji 结尾等真实模型输出形态，本格只有单元级覆盖，**没有真实模型验证**。
- **真实模型触发频率**：本格给不出任何统计意义上的漏报/误报率。真实模型是否会频繁命中这条启发式（例如习惯性地以“…?”收尾）**未知**。
- **Codex 未接入事实层**：`codex-adapter.ts` 未改动，它上报的 `completed` 事件没有 `facts`，因此 Codex 的散文提问结束**不会被标注**（漏报，不是谎报）。真实 Pi 之外的行为未经任何验证。
- **PTY/TUI 接管路径下的事实收集**：`session.handoff` 把 settled 当作安全点而非完成，本格未在真实 TUI 交接后验证 note 的生成。
- **真实 `dev → main`、稳定 Runtime**：本格没有 push、没有提升 `main`、没有重启任何稳定 Runtime；`/Users/loyage/Documents/codeestra` 未被触碰。

### 共享槽位与本格改动文件

- **独占**：`apps/runtime/src/agent-observation-service.ts`（追加 note 计算）、本格测试文件（`packages/domain/test/agent-completion-signal.test.ts`、`packages/agent-adapters/test/pi-completion-facts.test.ts`、`apps/runtime/test/agent-observation-service.test.ts`、`apps/runtime/test/cli-prose-question.test.ts`）、本文件本节。
- **共享槽位**：`packages/domain/src/agent-completion-signal.ts`（新纯函数模块，只**追加**，并在 `index.ts` 追加一行 export）、`packages/contracts/src/index.ts`（只追加 `agentCompletionFactsSchema` 与 `completed` 事件上一个**可选** `facts` 字段；命令 union 一行未动）、`apps/cli/src/main.ts`（`task status` 的 `--json` 接受与 stderr note 渲染、`usage()` 追加行）、`package.json`（`test:unit` 忽略列表与 `test:e2e` 各加 `cli-prose-question`）。
- **需要说明的额外改动**（不在上述槽位清单内，但**本格无法回避**，且全部为追加）：
  - `packages/agent-adapters/src/pi-adapter.ts`：事实只能来自 provider 自己的记录。新增的是**模块级纯收集函数** + `completed` 事件上多一个 `facts` 字段，既有判定（`turnFailure`、evidence、outcome）一行未改。
  - `packages/agent-adapters/src/index.ts`：`FakeObservedEvent` 的 completed 变体追加可选 `facts` 透传（否则本格的编排测试无法注入事实）。
  - `packages/storage/src/database.ts`：`recordAgentCompleted` 追加**可选** `facts`/`note` 入 payload、`AgentSessionCompleted` payload 追加可选 `note`、`ExecutionSummary.session` 追加 `completion`（含 `parseSessionCompletion`）。全部是追加；既有 `quiescent` 判定、状态迁移、幂等路径未改。**没有迁移、没有新 schema 版本（仍是 v21）。**
- **未改**：`apps/runtime/src/scheduler.ts`、`agent-runtime-service.ts`、`operation-service.ts`（run Operation 措辞不变）、`apps/ui/**`、`packages/storage/src/migration.ts`、`apps/runtime/test/support/**`、`docs/architecture/**`、`PROJECT_SPEC.md`、`AGENTS.md`、`codex-adapter.ts`。

### 决策与 doc-sync

- **没有新增 ADR（因此不占用 0034）**。本格落在 ADR-0004（FULL 零确认、观察即事实）与 ADR-0014（提问不是审批、结构化提问走 Attention）**既有语义之内**：只是把一条**观测到的事实 + 稳定码**记录下来并展示，不改状态机、不加门禁、不进 Attention、不加确认，也不需要新的产品语义决策。
- 遗留 doc-sync（本格领地之外，**不改**）：`docs/decisions/README.md` 的 Phase 1「Agent 需要决策时能否结构化提问」一行仍写「未做：把『Agent 结束轮次并在散文里提问』识别为等待人工」。该表述**仍然准确**（本格明确**没有**把它变成等待人工），但没提到第三种处置（标注事实而不改状态）；`docs/architecture/event-model.md`（F2 领地）未同步 `AgentSessionCompleted` 新增的可选 `note`/`facts`。

## FOUNDATION-057 — CLI 类测试不再留下孤儿 Runtime 与临时夹具（Wave F / F4）

状态：**已实现、已自查、已提交并合入 `dev`**（lane commit `46bd815`，dev merge `840da6b`）；提交前未 push、未提升 `main`、未重启稳定 Runtime、未触碰稳定工作树
`/Users/loyage/Documents/codeestra`）。lane 分支 `lane/f4-test-runtime-leak`，基线**固定**
`dev@866fa027c7457cba640865f1eb7ecfe52a2863d6`（未 rebase、未合并新 dev、未 pull）。**未新增 ADR**：本格只在
`apps/runtime/test/**` 内提供测试基础设施，**生产代码（`apps/runtime/src/**`、`apps/cli/src/main.ts`）一行未改**，
不改变任何 Runtime/CLI 语义；对「CLI `ensureRuntime` 在测试模式下是否应更可停」的判断是**不改，理由见下**。

### 根因（文件 + 具体原因，均为实测复现）

1. **`apps/cli/src/main.ts:87` 的 `ensureRuntime()` 是「后台自启动」而不是「测试知道自己启动了它」。** 任何一条
   只读命令（`status`、`project list`、`scheduler capacity get` …）在第一跳 `runtime.ping` 失败后都会用
   `Bun.spawn([...runtimeEntry])` + `child.unref()` 起一个 Runtime，`CODEESTRA_HOME` 由环境继承。这个子进程与测试
   进程**立即解除父子关系**（父 CLI 退出后归 launchd），所以：测试进程无法 `await` 它，不知道它存在，也无法通过
   子进程句柄回收它。这是「测试里跑 CLI = 可能凭空多一个 Runtime」的来源。
2. **停 Runtime 的动作写在测试体最后一行，而不是 teardown。** 除 `cli-capacity-slots` 之外的 CLI 测试都是
   `test()` 结尾 `await cli(['stop'], environment)`，`afterEach` 里只 `cleanupTemporaryDirectories()`。任何早于该行的
   断言失败、超时或异常都会跳过 `stop`；而 `afterEach` 仍然把 home 目录删掉，于是留下「进程还活着、home 已被 unlink
   的不可达孤儿」——正是 FOUNDATION-046/054 手工清理时最难归属的形态。**实测**：给 `cli-open.test.ts` 第一个测试插入
   一条必失败断言后，多出 **1 个**孤儿 Runtime，其 home 已被删除。
3. **`cli-capacity-slots.test.ts`（6 个 test / 1 次 `stop`）在成功路径上每次都漏。** 只有第 6 个测试调了
   `cli(['stop'])`，而那之后它还继续跑 CLI 命令（`sessions reservations list/get`、`reconcile`、`acquire`），
   `ensureRuntime()` 又起了一个新的 Runtime。所以**绿灯跑完也固定漏 6 个**。
4. **`socket-response.test.ts` / `event-subscription-ipc.test.ts` 登记了临时目录却从不调用清理。** 两者的
   `afterEach` 只有 `child.kill('SIGKILL')`；`registerTemporaryDirectory()` 注册的 repo/home 只有在**同一个 bun 进程里
   后面还有别的文件**调用 `cleanupTemporaryDirectories()` 时才会被顺手删掉（registry 是模块级共享的）。单独跑这两个文件
   （或任何以它们结尾的文件选择，例如只跑 `apps/runtime/test/socket-response`）→ **8 个夹具目录 100% 残留**。
5. **`cleanupTemporaryDirectories()` 的顺序与注册表语义都不安全。** 它先 `splice(0)` 再 `rmSync`：删除失败不会重试；
   它也不区分「这个 home 里还有活着的 Runtime」，因此会主动制造「home 被删的孤儿」。
6. **没有任何断言检查「跑完有没有多出进程/目录」。** 所以上述泄漏不会让任何测试变红，只能靠人工 `ps`/`ls` 发现。

### 机制：`apps/runtime/test/support/runtime-reclamation.ts`（新，供所有 CLI/e2e 测试复用）

- **登记**：`registerTemporaryDirectory`（原在 `agent-fixture.ts`，现由本模块拥有并再导出）、`registerRuntimeHome(home)`、
  `registerRuntimeProcess(pid, home)`（测试自己 `Bun.spawn` 的子进程）。
- **发现**：teardown 时对每个已登记夹具目录检查它自己与它的 `home/` 子目录是否存在 `runtime.lock` —— 活着的 Runtime
  一定有锁，干净停掉的没有。因此**测试不需要显式说「我启动过 Runtime」**，「CLI 偷偷起了一个」也能被找到
  （自检里已断言：只登记目录、没有显式登记 Runtime 的情况下仍能停掉它）。
- **归属校验（三重证据，全部成立才允许发信号）**：`runtime.lock`/boot 记录里的 **`cwd` 必须是本工作树**、**`argv` 必须
  指向本工作树的 `apps/runtime/src/main.ts`**、**记录的 OS start token 必须与当前 pid 的 start token 相等**；
  另外 home 必须在本机临时目录内，且 pid 不能是测试进程自身/其父进程/1。任何一条无法证明 → 记入 `unattributed` 并
  **不发信号**（对「看起来是本工作树的 Runtime 但证明不了」的情形打印一行告警）。
- **回收**：`SIGTERM`（Runtime 自己的有序 shutdown）→ 轮询等待退出（zombie 视为已退出，`UNKNOWN` 按「仍活着」失败关闭），
  宽限 15s。**从不 `SIGKILL`**；宽限内不退出 → 记入 `unconfirmed`、**保留它的 home 目录**并在 stderr 打印路径，
  然后按 `strict`（默认开）让该文件的 teardown 失败——让泄漏可见而不是被整理掉。
- **夹具回收**：停止进程之后才删除登记目录；`preserveFailureEvidence(reason)` 是唯一的「保留现场」通道，会打印所有保留
  路径并写进报告；`unconfirmed` 进程的 home 也会被保留。成功与失败路径都会执行。
- **`CODEESTRA_HOME` 安全底线**：`normalizeRuntimeEnvironment()`/`runCli()` 是测试跑 CLI 的唯一入口，它要求显式给出
  `CODEESTRA_HOME`、必须是本机临时目录（`isTemporaryPath`，`/var` 与 `/private/var` 归一），否则抛错。缺省值不存在——
  忘记设置会**报错**而不是连到开发者真实 home；`~/.local/state/codeestra` 与稳定工作树一律被拒（自检已断言）。
- **兼容**：`agent-fixture.ts` 的 `registerTemporaryDirectory`/`cleanupTemporaryDirectories` 保留并改为委托同一注册表；
  `cleanupTemporaryDirectories()` 现在遇到仍带 `runtime.lock` 的目录会**保留并告警**（提示改用
  `reclaimTestResources()`），不再主动制造「home 被删的孤儿」。只跑夹具、不起 Runtime 的服务类测试无需改动。
- **生产代码为什么没改**：`ensureRuntime()` 的 `unref()` 行为是产品语义（CLI 必须能自成服务，FULL 下 0 确认），
  改它（如增加 `--no-daemon`/测试开关）会动到命令面语义；本格的实测已证明**测试侧可以完备地发现并停掉这个进程**
  （启动后必写 `runtime.lock`，含 pid/startToken/argv/cwd），所以按「先报告再动」的纪律**不改运行时而在此报告**：
  如果将来要让 `ensureRuntime` 在测试模式下同步可控（例如把子进程 handle 写进一个可读的记录），那需要一次独立决策。

### 改动前后实测数字（本机另有 F1/F3 两个 lane 同时在跑测试，故所有测量都用**独立 `TMPDIR`** 隔离，
归属判据始终是「argv 指向本工作树的 Runtime 入口 + cwd = 本工作树」）

| 测量 | 改动前（`866fa02`，`TMPDIR=/tmp/f4-b-tmp`） | 改动后（本格最终树，`TMPDIR=/tmp/f4-final-tmp`） |
|---|---|---|
| `bun run check` 退出码 | 0（532 pass / 0 fail，61 文件） | **0（538 pass / 0 fail，62 文件）** |
| 新增孤儿 Runtime | **6**（全部来自 `cli-capacity-slots`，其中 5 个 home 已被删） | **0** |
| 残留临时夹具目录 | **0**（全量 check 中被后续文件的顺手清理掩盖） | **0** |
| 单独跑 `socket-response` + `event-subscription-ipc` | 残留夹具目录 **8**（100%） | （已并入上表全量验证；见下自检） |
| 故意让 `cli-open` 第一个测试断言失败 | 新增孤儿 Runtime **1**（home 已被删）、夹具 0 | 新增孤儿 Runtime **0**、夹具 **0** |
| `bun run check:fast` | — | **退出码 0**（根 + UI typecheck、265 vitest、336 bun unit / 33 文件、0 fail） |

### 失败路径验证（deliberate failure probe，探针文件用完即删）

- **探针 A（默认回收）**：一个用 `runCli(['status'])` 偷偷起了 Runtime、随后断言失败的测试 → 跑完 `orphan_count=0`，
  夹具目录 0，Runtime 收到 `SIGTERM` 后自行退出。
- **探针 B（显式保留现场）**：同一形态但调用 `preserveFailureEvidence(...)` → 目录保留、`[test-reclamation] keeping
  evidence (…): /tmp/f4-probe/codeestra-f4probe-b-m85EBv` 打到 stderr，`detect` 也列得出来（**人能找得到**）。
- **失败路径下测试仍然失败**（2 fail），没有被 teardown 掩盖；本格没有放宽任何断言、没有新增跳过/重试。

### 自检（不靠自觉）

`apps/runtime/test/test-resource-reclamation.test.ts`（6 项，in `test:storage`/`test:e2e`，不进 `check:fast`）断言：
① 没有/非临时/稳定 home 的 CLI 调用被拒；② 只登记目录也能发现并停掉 CLI 偷偷起的 Runtime，且 home 被删、
`inspectRuntimeHome` 变 `NOT_RUNNING`；③ 无法归属的活进程被如实报告、**从不发信号**（`sleep` 仍在）；④ 永远不会把
测试进程自己当成 Runtime；⑤ `preserveFailureEvidence` 保留现场并打印；⑥ 报告的 `unconfirmed` 为空。
**边界**：它证明的是「机制正确」，不能阻止别人新增一个**完全不用**本辅助的 CLI 测试文件（没有全局钩子；bun 的
`--preload` 全局 afterAll 会改测试配置语义，本格不做）。

### 被改动的测试文件清单（只动 teardown 与 CLI 启动入口，断言/覆盖未动）

- 新：`apps/runtime/test/support/runtime-reclamation.ts`、`apps/runtime/test/test-resource-reclamation.test.ts`。
- 改：16 个 `apps/runtime/test/cli-*.test.ts`（`afterEach` 改为 `reclaimTestResources()`；本地 `cli()` 改为
  `runCli(args, environment, { entry: cliEntry })`）、`apps/runtime/test/socket-response.test.ts`、
  `apps/runtime/test/event-subscription-ipc.test.ts`、`apps/runtime/test/runtime-lifecycle.test.ts`（teardown 由
  「按身份 SIGKILL」改为共享的「SIGTERM + 等待」）、`apps/runtime/test/support/agent-fixture.ts`（注册表委托）、
  `package.json`（只在 `test:unit` ignore 列表与 `test:e2e` 列表加入本格自检文件）。
- **未改**：`apps/runtime/src/**`、`apps/cli/src/**`、`packages/**`（含 `packages/**/test/**`）、`apps/ui/**`、
  `docs/architecture/**`、`docs/decisions/**`、`PROJECT_SPEC.md`、`AGENTS.md`；本文件只插入本节（在 `## NEXT` 之前）。

### 实际跑过的检查与结果

- `bun run typecheck`：退出码 0（多次）。
- `bun run check:fast`（最终树）：**退出码 0**。
- `bun run check`（最终树，`TMPDIR=/tmp/f4-final-tmp`）：**退出码 0** —— 538 pass / 0 fail（62 文件）、UI 构建成功；
  跑完后新增孤儿 Runtime **0**、临时夹具残留 **0**（`ps` + `lsof` 三重归属核验）。
- 过程中如实记录到两次**既有、与本格无关的负载敏感抖动**（本机同期有另外两个 lane 在跑测试）：
  `runtime-lifecycle.test.ts`「a deadline that never fires cannot hold a process open」一次（对照组 `raw 0` 得到 `raw 1`，
  单独重跑 10 pass / 0 fail，与 FOUNDATION-050/054 记录同一处）；
  `packages/agent-adapters/test/codex-adapter.test.ts`「reports an unexpected provider exit as disconnected…」一次
  （`PROCESS_IDENTITY_UNAVAILABLE`：刚 spawn 的 stub 子进程已退出，读不到 start token；单独重跑 21 pass / 0 fail）。
  两者都不起 Runtime、不创建夹具，均未因本格改动而改变行为；**不把它们算成本格修复成果**。
- 稳定 Runtime（`/Users/loyage/Documents/codeestra`）的两个进程全程未被触碰；回收只对「argv 指向本工作树 + cwd = 本
  工作树 + home 在本次临时目录内」的进程发 `SIGTERM`，其它 lane 与本机其它进程一个未动；全程未使用 `SIGKILL`。

### 未验证 / 不得当成已成立

- **其它工作树/其它 lane 的测试仍会泄漏**（它们的代码未改）；本格的清理脚本只回收本工作树的进程，未回收也未声称回收
  别人的。本机同期存在的 F1/F3 lane 孤儿进程**保持原样**（归属属于它们）。
- **没有全局钩子**：新增一个完全不 import 本辅助、且不写 `afterEach` 的 CLI 测试文件仍会泄漏。自检只能证明机制正确。
- **`bun test` 的文件级并行**：本格结论基于「同一次 `bun test` 内文件顺序执行、support 模块注册表在文件间共享」这一实测
  行为（socket/ipc 的目录历史上是靠后面文件的清理顺带删掉的）。若将来 bun 改成并行执行文件，共享注册表的假设需要重新验证。
- **未验证**：Windows；Linux（`readProcessStartToken` 走 `/proc`，逻辑相同但未实机跑）；`unconfirmed` 分支只在自检里用
  合成记录覆盖，没有制造「SIGTERM 后仍不退出」的真实 Runtime（那需要一个故意不响应 TERM 的构建，本格不做）。

## Wave F 集成记录（FOUNDATION-051/055/056/057）

状态：**四格均已提交并合入 `dev`**。基线统一固定 `dev@866fa027c7457cba640865f1eb7ecfe52a2863d6`（`phase1SchemaVersion = 21`），四格均未 rebase、未合并新 dev、未 push、未提升 `main`、未触碰稳定工作树。

| 格 | lane 分支 | lane commit | dev merge | FOUNDATION | ADR | schema |
|---|---|---|---|---|---|---|
| F2 | `lane/f2-doc-sync` | `4dec130` | `b293e4c` | 051 | 无（纯文档） | 无 |
| F3 | `lane/f3-prose-question` | `db4783d` | `2182ab5` | 056 | 无（落在 ADR-0004/0014 内） | 无 |
| F4 | `lane/f4-test-runtime-leak` | `46bd815` | `840da6b` | 057 | 无 | 无 |
| F1 | `lane/f1-scheduling-engine` | `e204693` | `1e458ba` | 055 | 0033 | 无（**未占 v22**） |

合并顺序 F2 → F3 → F4 → F1。每格在合入前都由主工作树**重跑一遍完整 `bun run check`**（不只采信 lane 自述）：F1 548 pass / 0 fail、F3 545 / 0、F4 538 / 0；F2 为零代码格，只跑 `typecheck` 并核对 diff 仅含 `docs/architecture/**`。

### 集成时的情况

- 三次 `docs/tasks/README.md` 锚点冲突（每次都是新格在 `## NEXT` 前插节），按号段升序手工排序为 **051 → 055 → 056 → 057**，内容一字未改。
- 两次 `package.json` 冲突（`test:unit` 忽略列表与 `test:e2e` 列表），按并集合并：`cli-schedule`、`cli-prose-question`、`test-resource-reclamation` 同时进入两份列表。
- `apps/cli/src/main.ts`、`packages/contracts/src/index.ts`、`packages/storage/src/{database,index}.ts`、`apps/runtime/src/main.ts` **全部自动合并成功**。
- **本波没有出现「单格绿、合并后才爆」的集成缺陷**（Wave D 的必填字段、Wave E 的 schema 断言那两类都没再发生），合并后第一次 `typecheck` 与完整 `check` 就直接通过。这是槽位纪律与「合并前自己重跑全量 check」两条做法同时生效的结果，但不代表以后不会再发生。

### 集成后验证

- `bun run check`（合并后的 `dev` 树，`CODEESTRA_HOME=/tmp/ce-integrate`）：退出码 0 —— 根与 UI `tsc --noEmit`、**272 项 Vitest**、**567 项 Bun tests（0 fail，63 文件）**、UI Vite 构建。
- schema 仍为 **v21**（F1 判断不需要新表，因此未占 v22；v22 仍空）。
- **Phase 2 验收矩阵里最长的一条现在有断言了**：「两个 SAFE 且不相交的任务在容量 2 下真的同时进入 RUNNING」由 `cli-schedule.test.ts` 在真实 CLI + 真实 Runtime 上验证（provider 仍为协议 stub）。之前 Wave E 只能做到「原语就位」；现在引擎会自己 tick。
- **F4 的效果可测**：在 F4 自己的 lane 上跑完一次完整 `check` 后，残留 Runtime 进程为 **0**（对照：Wave E 一轮开发留下 31 个孤儿进程 + 48 个夹具目录，E2 自报 43 个）。

### 仍未验证（不得当成已成立）

- **真实 provider 的并行**：并发的证据全部来自协议 stub；两个真实 Pi/Codex 进程同时跑一个仓库从未验证。
- **真实模型行为**：F3 的启发式在真实 provider 上的误报/漏报率无统计数据（中文不带问号的提问是设计内漏报）；F1 的实际 diff 超预测处置也只由 stub 驱动。
- **UI 投影**：`task schedule *`、`--allow-unknown`、`project impact *`、`scheduler capacity|reservations *` 与 F3 的完成注记均**只有 CLI/命令面**；UI 半边仍未做（人工目视也不适用）。
- **多成员 IntegrationBatch**、**非 Git 共享资源**、**impact snapshot 的快照代重检**仍未做。
- **F2 把「文档与实现不一致」的清单交给了用户裁决**（未静默改写规格），这些待裁决项仍未决。

## 第一次真实 `dev → main` 提升（`main` `ac1ebc3` → `7c02878`，54 个提交）

状态：**已执行并成功**（用户显式授权）。这是 ADR-0022 的能力就绪后、也是本项目历史上**第一次**把 `dev` 真实提升到 `main` 并重启稳定服务。

| 项 | 值 |
|---|---|
| 提升前 `main` | `ac1ebc32ad891db9b875aa08afc6985b70d03ead` |
| 提升后 `main` | `7c02878f400f289e0ff484552d7a4a1420aa944b`（= 当时的 `dev`） |
| 推进的提交数 | 54 |
| 方式 | 在已检出的 main 工作树内 `git merge --ff-only dev`（同时推进 ref/index/工作文件） |
| `main` 工作树 state | 提升前 clean，提升后 clean；`phase1SchemaVersion = 21` |
| 稳定 Runtime（提升前） | boot `3cdf511d…` / pid `12056` 的**前一代**：pid `12276` 持有 socket 与 lock |

### 重启序列与证据（AGENTS.md 「重启 main 稳定服务」规程）

在 `/Users/loyage/Documents/codeestra` 按顺序执行，每步都检查退出码，前一步失败不继续：

1. `bun install --frozen-lockfile` → 退出码 0（「Checked 65 installs across 84 packages (no changes)」）。
2. `bun run build:ui` → 退出码 0（`dist/index.html` + `index-CpBl2CLg.css` + `index-B6uql77h.js`）。
3. `bun run codeestra stop` → 退出码 0；**持有 socket/lock 的 pid 12276 确认退出**，旧 `runtime.sock` 与 lock 随之消失。
4. `bun run codeestra status` → 新 boot `3cdf511d-0b5c-4a38-8f4a-3338a8c4abe6` / pid **12056**，`status: "READY"`、`permissionMode: "FULL"`、`adapters: ["pi","codex"]`、`activeSessions: []`、lock `holderAlive: true` 且 `holderIdentityMatches: true`。
5. `bun run codeestra ui --no-open` → 退出码 0；再次 `status` 得 `uiRunning: true`（AGENTS.md 要求 READY + uiRunning 两者同时成立才可报告恢复）。UI 链接与内存 token 只在终端与浏览器会话中存在，**未写入任何文档/日志/提交**。

### 记录与诚实边界

- **没有产生领域 `PromotionRecord` 行**：本次走的是 AGENTS.md 规定的「main 工作树内 `git merge --ff-only dev`」手动路径，而不是产品命令 `promotion prepare/approve/promote`。因此提升的 traceability 只在 Git 历史 + 本节，`promotion list` 看不到这次提升。若要两边一致，需后续在产品路径上补做一次提升（或决定不再需要）。
- 提升包含 Wave A–E 全部提交 + Wave F 的 051/055/056/057，包含 schema 从 v11 到 v21 的十一个 additive 迁移（含 v16 永久空号），**没有**在 `main` 工作树上额外跑完整 `bun run check`（按用户本轮选择：只走既定序列）；`dev` 上的最终树已在提升前跑过完整 `check`（272 Vitest + 567 Bun tests，0 fail，0 孤儿进程，0 夹具）。
- **提升后发现一个悬而未决的旧进程**：pid `65545`（`bun run …/codeestra/apps/runtime/src/main.ts`，**启动于 9月13日 22:02**，早于 ADR-0025 的 Runtime 生命周期记录）仍存活。证据：它**不持有** socket、lock 或 `runtime.sqlite`（`lsof` 为空），因此任何客户端都到不了它，`stop` 也无从命名它；但它是 pid `71909`（一个自 9月13日 22:06 起存活的 `pi` 进程，`cwd` 在 `~/.local/state/codeestra/worktrees/<old-id>/.orca-worktree-trash/…`）的父进程。**未动它们**：处理一个仍托管旧 Agent 子进程的进程需要用户决定，不能凭「看起来没用」就 SIGTERM。

## FOUNDATION-058 — 紧凑任务信息行与主操作优先（ADR-0034）

状态：实现与部署前全量检查完成；用户随后明确授权本次人工提交与部署（见下）。本节保留提交时事实，不预先声称 main 已推进或重启成功；视觉、窄屏与键盘体验仍待用户人工确认。

### 已实现

- 用户选择「紧凑信息行」与「紧凑导航＋突出主操作」，记录为 `docs/decisions/0034-compact-task-workbench.md`，同步决策索引；未修改人工规范 `AGENTS.md` 或 `PROJECT_SPEC.md`。
- 新增 `apps/ui/src/task-list.tsx`：两行任务摘要、编号、较醒目的状态标记、OPEN 请求数量、规格版本、优先级、约束数、相对更新时间（可查看绝对时间）。全部读取既有 `task.list` / `attention.list`，不逐行获取完整历史、不改业务状态。
- 概况一键筛选；「需要你处理」按任务去重，涵盖 OPEN 请求、等待用户、失败与恢复态；概况不含归档。新增本地排序（默认保持 Runtime 返回顺序）、`#编号` 搜索、重置筛选；列表与详情仍分开，返回保留查询/筛选/排序，恢复到原任务行的键盘焦点（已不在列表则落到列表标题）。
- 状态使用文字、颜色、符号，进行态轻量旋转；支持减少动态效果偏好。断线显示最近记录提示并停止动效；SSE 订阅/重连补读现有投影。**Task RUNNING 不等于 provider 此刻在运行**，无完整会话数据的列表不伪造工具进度/百分比/执行耗时；详情可捕获成果时显示「会话已退出」，不继续播放该状态动效。
- `apps/ui/src/styles.css`：桌面导航 194px → 146px，页头 76px → 56px；压缩页边距、概况和页脚，搜索筛选横排；列表使用页面滚动而非 60vh（窄屏 18rem）的嵌套滚动框，窄屏信息行变单列。保留文字导航与深浅主题。
- `apps/ui/src/App.tsx`：主操作按状态显示，进行中验证避免重复发起；终止/归档移到「更多操作」且不增加审批；OPEN 问卷移到长命令进度之前；技术说明与原始结果折叠。修正已支持暂停/终止、submit 会进入自动调度等过时文案；不自动串接成果提交、验证和集成。
- 扩充 `apps/runtime/test/cli-attention.test.ts` 的实际 UI HTTP 客户端用例，验证列表元信息、OPEN 请求关联、归档默认隐藏/显式可读/可恢复；保留会话退出不等于成果或验证成功的断言。

### 实际验证

- `bun run typecheck`、`bun run typecheck:ui`、`bun run build:ui`：通过。
- `bun test apps/runtime/test/cli-attention.test.ts apps/runtime/test/http-api.test.ts apps/runtime/test/cli-task-control.test.ts apps/runtime/test/operation-progress-events.test.ts`：**20 pass / 0 fail，200 个断言**；包含问题回答、归档、状态版本、HTTP 授权、SSE 和步骤事件。
- 使用临时 `CODEESTRA_HOME` 与当前 `apps/ui/dist` 经 CLI 启动独立 Runtime，HTTP 核对 HTML、2 个构建资产的字节内容、无令牌 401 和授权 ping 成功。最后经 CLI stop 确认停止并清理该临时目录，未连接/停止 main 稳定 Runtime；未记录实际 token。
- `git diff --check`：通过。初次开发验收只运行定向回归；随后按用户提交/部署要求，以独立 `CODEESTRA_HOME` 运行 `bun install --frozen-lockfile` 与完整 `bun run check`，均退出码 0：根/UI TypeScript、**272 项 Vitest + 567 项 Bun tests（67 文件，3512 个断言，0 fail）**、Vite 构建。完整检查日志位于 `/tmp/codeestra-release-058.1sOl7N/check.log`；之后只补充发布决策与本节文档，未改已测业务代码。

### 边界与待确认

- 未获取电脑控制权，未使用浏览器/桌面自动化。构建与 HTTP 通过不证明视觉排版、动画、焦点或触控体验正确。
- 用户人工确认：三种主题、窄屏、减少动态效果、状态更新、返回原筛选/任务行、更多操作、任务内回答。
- 不新增 Domain/数据库/公共 API/调度能力；列表不声称能展示未查询的模型、具体工具、失败详情或验证证据。

### 本次发布授权与固定基线

- 用户明确选择沿用上次人工发布路径；一次性例外写入 ADR-0034「本次发布路径补充」。不存在 Runtime Task/IntegrationBatch，不能伪造领域批次或 PromotionRecord；此操作不会出现在产品 `promotion list` 中。
- 开发基线：`dev@861932dbd33f836142d491cdfabdf1f4053cdf95`；预期旧 main：`7c02878f400f289e0ff484552d7a4a1420aa944b`。main 工作树 `/Users/loyage/Documents/codeestra` 提升前 clean，稳定 Runtime boot `3cdf511d-0b5c-4a38-8f4a-3338a8c4abe6`、pid 12056、READY、uiRunning=true、无活跃 Session。
- 下一步执行者固定本次 dev 提交 OID，重新核对两个 ref 与 main 干净状态，在 main 工作树 fast-forward 固定 OID，随后按 install → build:ui → stop → status 执行；有需要时再启动 UI 并检查 READY + uiRunning。最终提交 OID、各步退出码与新 boot 由实际执行输出记录，不在提交前捏造发布结果。
- 未授权 push；不直接 update-ref 已检出的 main，失败不回滚，不手工清理未知进程。新 UI token 不写入文档、日志或提交。

## FOUNDATION-059 — 调度、impact、容量与预留、完成注记的 UI 投影（Wave H / H1，纯投影，无 ADR，无迁移）

状态：已提交为 `2db1514` 并合入 `dev`。**未新增 ADR、未占 schema 版本、未改任何后端文件**（`apps/runtime/**`、`apps/cli/**`、`packages/**` 零改动）。视觉、窄屏与键盘体验仍需用户人工目视确认。

用户在本格明确选择（两项）：

1. **导航**：新增「调度」标签承载项目级内容，任务级内容内嵌在任务详情里（不新增第二个「影响」标签）。
2. **UI 单测**：给 `apps/ui` 的纯函数加单测并接入 vitest —— 因此 `vitest.config.ts` 的 `include` 追加 `apps/ui/**/*.test.ts`（这是本格**唯一**跨出 `apps/ui/**` 的改动，纯追加、不改既有配置语义）。

### 已实现（全部是同一命令面的投影）

- `apps/ui/src/scheduling-labels.ts`（新，纯函数、无 DOM）：等待原因、容量 reason code、判定、`SAFE|UNKNOWN|CONFLICTING`、预留状态、reconcile 观测、impact reason code、等待时长、完成注记措辞，以及 7 类调度事件（`TaskScheduleDecided`、`TaskWaitingForConflict`、`TaskWaitingForCapacity`、`TaskUnknownCleared`、`ExecutionSlot*`、`SchedulerCapacityChanged`）的**人话摘要**。两条措辞规则由测试锁定：`UNKNOWN` 渲染为「无法证明」而**不是**「没有冲突」；容量等待/冲突等待**不得**显示成 `BLOCKED`（`BLOCKED` 只表示依赖未满足）。
- `apps/ui/src/schedule.tsx`（新）：
  - `SchedulePanel`（对应 `task schedule status|plan|run`）：活跃集合（任务/执行状态、adapter、预留、已运行时长）、按优先级排序的候选（处置、等待 kind+code+detail+已等待时长、占用方、依赖未满足原因、assessment）、实际影响增长记录；`plan` 以 dry run 横幅呈现且明说「不预留、不启动」。
  - `ScheduleExplainPanel`（对应 `task schedule explain` + `clear-unknown`）：一处任务的决定与命中范围（路径/重要目录/模块/全局资源 + 关系 + class）；`UNKNOWN` 的显式单次放行是**带风险提示的显式动作**，始终显示绑定的 revision/baseCommit/analyzerVersion/policyVersion，并明说「放行不改变判定记录，该次 assessment 仍是 UNKNOWN」「不等于 SAFE」；无确认复选框、无新增门禁。
  - `CapacityPanel`（对应 `scheduler capacity get|set|clear`、`scheduler reservations list|get|release|reconcile`）：两级上限（含 `limitSource` 与「跟随全局」说明）、已用/可用、`globalUsed > globalLimit` 如实显示、占用者与持有开始时间；`set` 把输入原样交给 Runtime（**不夹取**），非法值原样显示稳定错误码；`clear` 只对显式覆写可用；预留表含持有者证据（bootId/pid/startToken 可为 null/actor）与释放证据；`release` 必填原因；`reconcile` 面板区分 `HOLDER_STILL_RUNNING` / `HOLDER_OWNERSHIP_UNVERIFIABLE`→`RECOVERY_REQUIRED` / `PROCESS_IDENTITY_MISSING` 与可释放的两种观测。
- `apps/ui/src/impact.tsx`（新）：`ImpactPolicyPanel`（`project impact validate`，用项目 `repoRoot` 作 path）与 `ImpactTaskPanel`（`project impact show` + `explain`）：映射状态/确认状态/摘要/警告、`complete: false` 与 `incompleteReasons` 如实显示、快照文件/重要目录/模块/全局资源/未分类路径、baseline 与 dev 不一致时的 UNKNOWN 提示、逐活跃任务表与逐配对 append-only 判定。
- `apps/ui/src/types.ts`：补齐上述投影的只读类型；`ExecutionView.session.completion` 补上（`outcome`/`facts`/`note`），与 Runtime 的 `task.status` 投影一致。
- `apps/ui/src/App.tsx`：新「调度」标签（调度面板 + 容量与预留 + impact 校验）；任务详情新增「调度判定」与「影响与冲突判定」；执行记录上方新增「会话结束注记」区块，按注记本意呈现（`结束形态的注记（PROSE_QUESTION_NO_TOOL_USE）——不是「Agent 在等你回答」，也不是失败`），并把 provider 原始事实与 outcome 一并显示；事件流对既有调度事件加一行人话摘要，**保留原始 payload 不替换**。
- `apps/ui/src/styles.css`：新增 `.state-safe` / `.state-unknown` / `.state-waiting` / `.state-conflicting`（`UNKNOWN` 用 attention 色，**不**用成功色）与这些面板的排版；事件流里调度摘要独占一行。
- `apps/ui/test/scheduling-labels.test.ts`（新，25 项）：覆盖 `UNKNOWN` 措辞、容量/分析器 reason code、`BLOCKED` 边界、dry run 不等于启动、reconcile 三类「保持占用」与两类「可释放」、`complete:false`、等待时长、完成注记不得升级为「等待回答」、以及事件摘要遇到不认识的负载必须返回 null。
- `vitest.config.ts`：`include` 追加 `apps/ui/**/*.test.ts`。

### 明确未纳入 UI 的既有命令（不是缺陷，边界声明）

- `scheduler reservations acquire` / `prepare-workspace`：它们是引擎原语（需要 `expectedTaskVersion` + `revisionId`），UI 直接从低层原语启动任务会绕过 `task run`/调度判定的正常路径；启动仍走「提交/启动 Agent」与 `task schedule run`。
- `task run --allow-unknown` / `task resume --allow-unknown`：放行在 UI 里是独立的 `task schedule clear-unknown` 动作（先记录放行，再交给调度决定是否启动），**不**把放行折叠进启动按钮，避免做成「看起来无害的开关」。
- `scheduler reservations list --task`：面板已按项目列出并显示任务编号；未加逐任务过滤控件。

### 本轮实测发现的后端缺陷（**不在本格领地，未修，仅报告**）

1. **`project impact explain` 在候选没有可用快照时崩溃**（FOUNDATION-053 / ADR-0031）。真实 CLI 复现：对一个 READY 且尚无 worktree 的任务执行 `codeestra project impact explain <project-id> <task-id>` → `INVALID_REQUEST: null is not an object (evaluating 'snapshot.revisionId')`。定位：`packages/domain/src/impact-analysis.ts` 的 `assessCandidate` 在第 653 行无条件调用 `subjectHits(candidate, …)`，而 `subjectValidity` 直接解引用 `snapshot.revisionId`，候选 `snapshot === null`（`UNAVAILABLE`）时抛错；调度引擎路径（`schedule-service.ts` 的 `#assess`）在调用 analyzer 前先返回 `#unavailableAssessment`，所以只有 `project impact explain` 这条只读命令面会崩。影响：H1 的「解释判定（explain）」按钮对这类任务会显示 `INVALID_REQUEST: null is not an object…`（UI 如实显示稳定错误码，未吞未猜）。
2. **`apps/runtime/test/cli-impact.test.ts:376` 在本基线上确定性失败**：`task cancel <project-id> <first-task-id> 2` 返回 exit 1、`CONCURRENT_MODIFICATION: Task version did not match`（测试硬编码的 v2 已过期）。已用 `git stash -u`（把 H1 全部改动移出工作树，回到 `dev@8058eb9` 的字节状态）复跑同一测试确认**同样失败**，因此是既有缺陷，不属于本格。

### 实际验证

- `bun run check:fast`：**退出码 0**（根 TypeScript、UI TypeScript、272+25 = **297 项 Vitest**、**357 项 Bun 单测** 0 fail）。
- `bun run build:ui`：成功（29 modules，`dist/assets/index-*.js` 386.65 kB / gzip 113.43 kB）。
- `bun run check`：**未整体通过**，唯一失败即上述既有的 `apps/runtime/test/cli-impact.test.ts`（1 fail / 566 pass，67 文件，3493 断言）；`test:storage` 失败后 `build:ui` 未执行（已单独跑过，成功）。
- 端到端证据（真实 Runtime + 真实 CLI + `CODEESTRA_HOME=/tmp/ce-h1` + 临时仓库 + **协议 stub provider**，用 UI 的 `RuntimeClient`（`apps/ui/src/api.ts`，与浏览器同一类）直连 `/api/command`）：
  - `repo-main`（`.codeestra/impact.json` 存在且已确认）：提交 3 个任务 → 前两个 `started` 且 `task.list` 显示 2 个 `RUNNING`，第三个 `waiting: [{kind: CAPACITY, code: CAPACITY_GLOBAL_LIMIT_REACHED}]`；`task.schedule.status` 的 `active` 为 2、`candidates[0].{disposition: WAITING, assessment.verdict: SAFE_TO_PARALLELIZE}`、`capacity.{globalUsed: 2, globalLimit: 2, globalWaitReason: CAPACITY_GLOBAL_LIMIT_REACHED}`；`plan.dryRun = true` 且 disposition 仍为 `WAITING`；`impact.validate = OK`（digest/Label 齐全）；`capacity.get` 显示两级 `limitSource: DEFAULT`；`capacity.set` 用 `limit=0` / `limit=99` 分别得到 `CAPACITY_LIMIT_INVALID` / `CAPACITY_LIMIT_OUT_OF_RANGE`（无夹取）；`reservations.list(includeReleased)` 显示预留把槽位**移交**给 Execution（releaseKind `EXPLICIT`、理由写明 handed over），`reservations.get` 显示 RESERVED×2 + RELEASED 事件与证据键；`schedule.run` 报告 `trigger REQUESTED`、`coalesced false`。
  - `repo-note`（无映射）：提交 → `waiting CONFLICT/INCOMPLETE_IMPACT`；`task run` 显式独占启动（`outcome STARTED`、`assessment.verdict UNKNOWN`、`candidateIncompleteReasons [POLICY_ABSENT]`）；第二个任务 `explain = WAIT_CONFLICT / UNKNOWN / unknownRelease = null`（**未放行**）；`task.status` 里 `executions[0].session.completion.note` 为 `PROSE_QUESTION_NO_TOOL_USE`（含 `toolCallCount: 0` 与尾问句事实）；`impact.show` 给出 `complete: false` + `incompleteReasons [POLICY_ABSENT]`；`clear-unknown` 返回 `recorded true / state RECORDED / verdict 仍 UNKNOWN`，随后 `explain` 的 `unknownRelease` 出现且 `decision` 变为 `START_NOW`（放行 ≠ SAFE）。
  - 事件面：`events.list` 中实际存在 `TaskScheduleDecided` / `TaskWaitingForCapacity` / `ExecutionSlotReserved` / `ExecutionSlotReleased` / `SchedulerCapacityChanged` 等，UI 摘要函数读取的就是这些既有 payload。
  - 收尾：CLI `stop` 返回 `status: STOPPED`（`identityVerified: true`）；结束时本工作树孤儿 Runtime = 0、stub 进程 = 0、`/tmp/ce-h1` 已删除；稳定 `main` Runtime 未被触碰（仍在运行）。
  - **provider 是协议 stub**：以上只证明 Runtime 的投影形状与 UI 的数据源确实存在，**不**构成真实 Agent 集成或真实模型行为的验收。
- `git diff --check`：通过。

### 未验证 / 需要用户人工确认

- 未使用浏览器/桌面/键鼠自动化（符合本用户规范）：构建与命令面通过**不**证明视觉排版、窄屏、焦点与主题正确。请人工目视确认：
  1. 「调度」标签在窄屏下候选卡片、等待时长与命中范围列表的换行与可读性；
  2. `UNKNOWN` 的措辞与配色是否读起来像「无法证明」而不是「安全」；
  3. 「记录单次放行」按钮的风险提示是否足够醒目、且不误导为无害开关；
  4. 容量表的 `limitSource`、「跟随全局」提示与占用者时长；`set` 非法值只出现稳定错误码、不被静默接受；
  5. 任务详情里「调度判定」「影响与冲突判定」「会话结束注记」三处的位置与观感；
  6. 事件流里调度事件的人话摘要一行（原始 JSON 仍在）。
- 未验证：真实 Pi TUI/真实模型下的调度事件实时表现；`SESSION`/PTY 相关面板未改动；`project impact explain` 缺陷修复后 UI 的错误分支将不再出现（修复属别的领地）。
- 已知呈现限制：`capacity.get` 的每个 adapter 行都会带上当前全局等待码（`CAPACITY_GLOBAL_LIMIT_REACHED`），因此一个 `used 0/available 2` 的 adapter 也会显示「全局上限已满」——这与 Runtime 的语义一致（该 adapter 此刻获取也会因全局上限而等待），已按此措辞显示而未改写。
- `apps/ui/src/schedule.tsx` 的活跃集合里 `reservationId` 常为 `null`：因为启动后槽位已移交给 Execution，占用继续由 `resource_held` 计入；面板已就此写明提示，未把 `null` 显示成丢失。

## FOUNDATION-060 — 预留事务内的快照代重检（Wave H / H2，无新 ADR，无 schema 变更）

状态：已提交为 `8ce269e` 并经 merge `ad2573b` 合入 `dev`；lane 的端到端证据与最终独立集成检查均通过。基线固定 `dev@8058eb9275fbea87c1216c4ac9ea66b7e7d96022`。

### 缺口（已在基线上实测确认）

`scheduler.md` §2 要求事务内「recheck cached snapshot generations」。基线里 `schedule-service.ts` 已经把 `assessment.view.candidateSnapshotId` 传给 `SlotReservationService.acquire`，而 `slot-reservation-service.ts` 全文只有两处 `snapshot`（声明 `impactSnapshotId` 与把它写进 `execution_slot_reservations.impact_snapshot_id`），**从不校验**。因此「SAFE 判定之后、真正预留之前」这段窗口里的 revision / 基线 / 映射 / 分析器 / 变更集变化不会被拦住。

### 实现：重检的确切键与比较方式

- 复用 E1 的判定而不是另写一套：`packages/domain/src/impact-analysis.ts` 把 `isSnapshotCurrent` 的规则抽成 `recheckImpactSnapshotGeneration({generation, observedFiles, context, currentRevisionId, observedChangeFingerprint})`，返回 `{current, reasonCodes, differing, assessed, observed}`；`isSnapshotCurrent` 现在就是它的 `{current, reasonCodes}` 视图（行为不变，既有 domain 测试未改）。新增纯函数：`ImpactSnapshotGeneration`（六元组 + `caseMode` + `files`）、`impactSnapshotGeneration`、`recheckImpactSnapshotGeneration`、`ImpactSnapshotStaleComponent`/`ImpactSnapshotGenerationSummary`/`ImpactSnapshotRecheck`。
- **六元组的比较判据（哪一个在哪里被重读）**：

| 分量 | 预留前观测（Git / 运行中二进制） | `BEGIN IMMEDIATE` 内重读（SQLite） | 拒绝时 `differing` |
|---|---|---|---|
| `revisionId` | 调用方断言的 revision（CAS） | `tasks.current_revision_id` | `revisionId` |
| `baseCommit` | 有 worktree：`workspaces.base_commit`；无 worktree：`refs/heads/dev` 当前 commit | 有 worktree：同一行重读；无 worktree：调用方观测值（外部事实，见「未验证」） | `baseCommit` |
| `analyzerVersion` | `impactAnalyzerVersion`（运行中二进制） | 不重读，断言等于本代常量 | `analyzerVersion` |
| `policyVersion` | 项目 `main` ref 的 `.codeestra/impact.json` 重新解析（`impactPolicyVersionKey`） | 不重读（映射在 Git 里） | `policyVersion` |
| 变更集（`changeFingerprint`） | 有 worktree：`inspectChangeSet` 的路径集合与 `treeFingerprint`；无 worktree：空集 | 不重读（工作树在 Git/文件系统里） | `changeSet` |
| `taskId` | 预留的 Task | 快照行的 `task_id`（不一致即 `SNAPSHOT_UNAVAILABLE`） | — |

- **变更集的比较方式是「路径集合精确相等」，不是指纹相等**：`isSnapshotCurrent`/E1 的重用判据就是路径集合（`caseMode` 感知）；`changeFingerprint` 还包含内容与 `HEAD`，而引擎在「路径不变、内容变了」时会继续选中同一行快照，严格比较指纹会让该 Task 永远预留不成功（活锁）。因此指纹与两侧路径数只作为拒绝事实回报，不参与判定。
- 工作树形状也被重读：观测说有 worktree 而事务里已无（或反之，观测说没有而现在有了）→ `SNAPSHOT_STALE`（`STALE_BASE`）。

### 失败原因码与「失败要干净」

- 两个稳定码，与 `DEPENDENCY_STATE_CHANGED` 同一 `SlotReservationError` 联合类型、同一语法：`SNAPSHOT_STALE`（读到了，但已不再是当前那一代）、`SNAPSHOT_UNAVAILABLE`（快照读不到/不属于该 Task/当前事实无法观测）。**读不到快照绝不当作有效**（映射读失败、`dev` ref 读失败、变更集检查失败都拒绝）。
- 判定发生在 `reserveExecutionSlot` 的 `apply` 内（事务边界 = 预留获取的同一个 `BEGIN IMMEDIATE`），拒绝走 **抛出** 而不是返回值：整笔事务回滚，因此**不留预留行、不留 `ExecutionSlotReserved` 事件、不留 command receipt**。测试用「同一 commandId 在事实恢复后再跑一次即成功」证明回执确实没写。
- 拒绝携带结构化 `detail`：`{code, snapshotId, taskId, reasonCodes, differing, assessed{六元组+pathCount}, observed{...}}`。`reasonCodes` 是既有分析器码（`STALE_REVISION`/`STALE_BASE`/`STALE_POLICY`/`STALE_ANALYZER`/`ACTUAL_DIFF_EXCEEDS_SNAPSHOT`/`SNAPSHOT_SCOPE_MISMATCH`/`INVALID_SCOPE`）。
- `impactSnapshotId` 为 null/未给时**不重检**，并如实记为 `impact_snapshot_id = NULL`：这是 `--allow-unknown` 显式放行后 `UNKNOWN` 评估的形状（引擎的 `#unavailableAssessment` 就传 null），语义是「没有缓存判定可失效」，不是「快照有效」。
- 语义边界：重检只回答**新鲜度**，不重新做冲突分析，也不改判定；`UNKNOWN`/`CONFLICTING` 的评估只要是「当前那一代」就照样可以按既有流程预留。

### 命令面（CLI 完备）

- `scheduler reservations acquire … --snapshot <impact-snapshot-id>`（新增可选 flag，同时进入 `scheduler.reservations.acquire` 的请求 schema）。带 facts 的拒绝**先打印 JSON 再 exit 1**（与 `project impact explain`、`task schedule run` 的 `REFUSED` 同一惯例）：`{outcome:'REFUSED', code, message, detail}`；不带 facts 的拒绝保持既有「stderr + exit 1」形态（`cli-capacity-slots.test.ts` 不受影响）。RPC 错误封套新增可选 `error.detail`（append-only）。
- 退出码不变：0 = 拿到槽位，3 = 容量等待/排水，1 = 拒绝（含两个新码）。`usage()` 增补该 flag 与「重检是新鲜度不是第二次冲突分析」的说明。

### 测试清单

- `apps/runtime/test/snapshot-generation-recheck.test.ts`（12 项，`test:unit`；真实临时仓库 + 内存库 + 真实 worktree）：当前代 → 预留成功；`STALE_REVISION`（改修订后仍 READY，只有快照重检能拦）；`STALE_BASE`（`dev` 前进）；`STALE_POLICY`（往 `main` 提交 `.codeestra/impact.json`）；`STALE_ANALYZER`（旧分析器版本）；`ACTUAL_DIFF_EXCEEDS_SNAPSHOT`（worktree 新增文件）；事务内重读工作树（worktree 在写前消失 → `STALE_BASE`）；反向形状（观测说无 worktree、写入时有 → 拒绝）；不可读/他人的快照 id → `SNAPSHOT_UNAVAILABLE`；拒绝零写入且 commandId 可复用；成功命令重放幂等（同一 reservationId、仍只有一行）；无快照的 Task 不重检且如实记 null。每例都断言「无残留行/无新事件」。
- `apps/runtime/test/cli-snapshot-recheck.test.ts`（5 项，`test:e2e`；真实 CLI + Runtime + 临时 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）：当前代预留成功 → 释放 → `dev` 前进 → 同一 id 被拒且 `differing:['baseCommit']`、两列表零残留、审计行保留；映射变化被拒 → 引擎重新派生的一代可以预留；**并发两个 acquire 同一代只有 1 个成功（另一个 `SLOT_ALREADY_RESERVED`）且只有一行**；不给 `--snapshot` 仍可用且记 null；引擎自身 pre-start 代仍能启动 Task（防回归：证明重检没有把引擎路径一起拦死）。
- 领地与共享槽位：独占 `apps/runtime/src/slot-reservation-service.ts` 与本格测试文件；纯追加 `packages/domain/src/impact-analysis.ts`、`packages/storage/src/database.ts` + `src/index.ts`、`packages/contracts/src/index.ts`；接线 `apps/runtime/src/main.ts`、`apps/cli/src/main.ts`；`package.json` 只加本格测试文件名。**未改** `schedule-service.ts`/`scheduler.ts`/`agent-runtime-service.ts`/`reclaim-service.ts`/`session-handoff-service.ts`/`terminal-service.ts`/`packages/agent-adapters/**`/`apps/ui/**`/`PROJECT_SPEC.md`/`docs/architecture/**`；未改 `migration.ts`。

### 端到端证据（`CODEESTRA_HOME=/tmp/ce-h2`，临时仓库 + 协议 stub provider）

1. 快照有效 → 预留成功：`task schedule status --json` 得到引擎派生的缓存代（`verdict=UNKNOWN/INCOMPLETE_IMPACT`，`candidateSnapshotId=5aaaab72…`，`baseCommit=0978ab42…`，`policyVersion=impact-policy-v1#absent`）→ `scheduler reservations acquire <p> <t> 1 --revision 00db985a… --snapshot 5aaaab72… --json` **exit 0**，`outcome=RESERVED`、`reservation.impactSnapshotId` 正是该 id、`globalUsed=1`。
2. 制造失效（`git commit-tree` + `update-ref refs/heads/dev`，`0978ab42… → 80d3a392…`）→ 同一 id 重试 **exit 1**，stdout JSON：`outcome=REFUSED`、`code=SNAPSHOT_STALE`、`reasonCodes=['STALE_BASE']`、`differing=['baseCommit']`、`assessed.baseCommit=0978ab42…`、`observed.baseCommit=80d3a392…`；stderr 同一句。
3. 无残留：`scheduler reservations list --json` → `active rows: 0`；`--include-released --json` → 1 行（先前那次显式释放，`state=RELEASED`、`releaseReason` 保留）。
4. 读不到的快照：`--snapshot 99999999-…` → exit 1，`outcome=REFUSED`、`code=SNAPSHOT_UNAVAILABLE`。
5. `codeestra stop` exit 0（`status=STOPPED`、`identityVerified=true`、`verdict=NOT_RUNNING`），随后 `/tmp/ce-h2*` 夹具已删除，本工作树的 Runtime 进程数 **0**。

### 实际验证

- `bun run check:fast`：退出码 0（根/UI TypeScript + 272 Vitest + 369 Bun）。
- 提交前完整 `bun run check`：退出码 0。Vitest **272/272**；Bun **584 pass / 0 fail（69 文件）**；`build:ui` ✓。日志 `/tmp/h2-check.log`。
- 跑完后本工作树的孤儿 Runtime 进程 **0**（不属于本格的稳定 `main` Runtime 与兄弟工作树进程未被触碰、未计入）。此前调试留下的两个本工作树孤儿（pid 96373/96647，`cwd`=本工作树、argv 指向本工作树 runtime 入口、home 为 `T/codeestra-slot-home-*` 临时目录）已按三重归属证据 `SIGTERM`，均自行有序退出，其临时 home 一并回收。

### 未验证 / 明确不做

- **真实 provider 参与下的并发窗口未验证**：证据只到「两个并发 acquire 只有一个成功」，不等于「两个真 Agent 不会越界」。数据库预留不是 OS 隔离，本格只解决「判定与预留之间」的窗口。
- **外部（Git）事实的残余窗口仍在**：映射版本、变更集、以及「无 worktree 时」的 `dev` 基线是预留前观测的，SQLite 无法在事务里重读它们。观测与 COMMIT 之间 Git 侧再变一次不会被本格拦住——`scheduler.md` §2/§4 把这一段交给预留后的外部基线复核（引擎已实现的 `assessedDevCommit` 比较）。
- **「路径不变、内容变了」不构成失效**：按 E1 重用规则如此（见上），是把指纹当证据而非判据的有意取舍；若产品要「内容变了也要重算」，需改 analyzer 的重用键，属独立决策。
- **「引擎侧是否也应重算」未做**：本格不重新做冲突分析；调度引擎在下一 tick 仍按自己的评估重新判定。
- 非 Git 共享资源（端口/数据库/dev server）、`--allow-unknown` 的命令语义、UI 投影均不在本格；未使用浏览器/桌面/键鼠自动化。未 push、未提升 `main`、未重启稳定 Runtime、未触碰 `/Users/loyage/Documents/codeestra`。
- **不新增 ADR**：本格实现的是 `scheduler.md` §2 已经写明的要求（「recheck … cached snapshot generations」），语义边界（重检 ≠ 重算、UNKNOWN ≠ SAFE、不新增门禁）在 ADR-0030/0031/0032 里已经成立，故 `docs/decisions/README.md` 未追加 ADR-0035。**不新增 schema**：重检比较的是既有 `impact_snapshot_id` 与既有事实，拒绝可由返回值解释，无需持久化新列，`migration.ts` 未改（v22 未占用）。

## FOUNDATION-062 — `reclaim` 的跨项目批量与未注册目录处置（ADR-0037，schema v24）

状态：**已提交为 `0d35b1c` 并经 merge `afadd96` 合入 `dev`**；未 push、未提升 `main`、未重启稳定 Runtime。lane 基线固定 `dev@8058eb9275fbea87c1216c4ac9ea66b7e7d96022`。ADR：**0037**（本格需要新决策：
账本 schema 变化、批量 operation 语义、未注册目录门槛、ADR-0021 D03 退出码修订）。schema：**v24**（v22/v23 留给并行格，
`if (version < 24)`，绝不插入 `if (version < 16)`）。

任务来源：`## NEXT` 第 5 条的剩余半截——「未注册目录的人工处理与跨项目批量回收」。

### 缺口

`reclaim` 过去只能按 `--project`（或 `--task`）对**已登记**的三类资源做 `plan`/`apply`。于是：① 想清理多个项目要一个
个来；② 磁盘上**不在账本里**的目录（历史遗留、半途中断、别人的格留下的）只能人工 `rm -rf`——正好绕过归属校验与
留痕，这是 ADR-0021 最不想看到的用法。

### 新增/扩展的命令面（不加第二个命令）

```bash
bun run codeestra reclaim plan  [--project <id> | --all-projects] [--task <id>] [--kind <k>]… \
  [--include-failure-scenes] [--unregistered] [--scan-root <home 内绝对路径>] \
  [--remove-unregistered <path>]… [--json]
bun run codeestra reclaim apply [同上] [--json]
bun run codeestra reclaim records [--project <id> | --all-projects] [--task <id>] \
  [--source <ALL|REGISTERED|UNREGISTERED_DIRECTORY>] [--since <epoch-ms|ISO>] [--until <epoch-ms|ISO>] \
  [--limit <n>] [--json]
```

- **省略 `--project` = 全部 ACTIVE-trusted project**（`--all-projects` 是同义显式写法）。两者同时给出、或
  `--task` 没有 `--project`，CLI 以 exit 2 拒绝（不猜）；Runtime 侧 `resolveReclaimScope` 同样以
  `PROJECT_SCOPE_CONFLICT`/`PROJECT_SCOPE_REQUIRED` 拒绝。
- **批量 = 每个项目一个独立 operation**：命令 ID 由批命令 ID 与 project ID 确定性派生（`sha256(commandId:projectId)`），
  所以每个项目有自己的 `operations`/receipt/账本行，重放同一批命令按项目命中各自 receipt、不二次记账；
  **一个项目的拒绝、失败甚至读不出来都不影响其它项目**（失败项目进顶层 `failures[]`，并以 `projectError` 出现在
  自己的分组里，不静默消失）。单项目输出仍是原来的扁平形状（加 `scope` 与 `unregistered` 字段）；批量输出是
  `scope: ALL_PROJECTS` + `projects[]` 分组 + 聚合 `counts`/`outcomeCounts` + `operations[]`/`failures[]`。
- **未注册目录**：`--unregistered` 触发有界扫描（只走
  `<CODEESTRA_HOME>/{worktrees,verifications,integrations}/<project-id>/<resource-id>` 两层、不跟 symlink、
  最多 500 个候选并在超出时记 `truncated: true`），`--scan-root` 可收窄到 home 内任意子树（home 之外
  `SCAN_ROOT_OUTSIDE_HOME`、相对路径 `SCAN_ROOT_NOT_ABSOLUTE`，都 exit 1）。**默认 dry-run**：`plan` 永不删除，
  `apply --unregistered` 不点名任何路径时也只 `RETAIN` 并记账；真正删除必须用 `--remove-unregistered <绝对路径>`
  显式点名**那一个目录**。这是「显式选择」，**不新增任何确认/审批**（FULL 常态路径一步未增）。
- **删除时重核**：每个被点名的目录在删除前重跑同一套判定（同一份进程表读数），任何事实变化（新 symlink、路径被账本
  认领、出现进程、出现未提交文件）都变成一条记录下来的拒绝而不是删除。Git 已注册 → 走既有 `removeOwnedWorktree`
  （重校注册/branch/HEAD 后 `git worktree remove` + prune）；未注册 → 本服务自己的窄删除（重校 owned root、
  路径恰好 `<root>/<uuid>/<uuid>`、`.git` 标记仍在，然后只 `rmSync` 那一个目录）。**都不删 branch、不用 `git clean`/
  `reset --hard`、不用 `--force`、不按名字杀进程。**

### 归属核验：删任何东西之前必须同时成立的证据

已登记资源沿用 ADR-0021 的三重校验（owned root 内 + Git 注册一致 + branch/HEAD 与记录一致），并**新增**一条：
workspace 被 `execution_slot_reservations` 中 `RESERVED`/`RECOVERY_REQUIRED` 的预留认领时一律
`REFUSE/ACTIVE_RESERVATION`，**不受 `--include-failure-scenes` 影响**（预留活过它将要启动的那次 Execution）；
删除前再读一次该预留（`findActiveWorkspaceReservation`），`releaseWorkspaceForReclamation` 也新增同样的拒绝。

未注册目录在同一结果里带出判定依据（不是散文）：**路径形态 `layout`、所属 `runtimeHome`、Codeestra 标记文件
（`gitMarker`/`gitMarkerTarget`）、是否被账本认领（`ledgerClaim`）、Git 注册事实（`registered`/`registeredBranch`/
`registrationHead`）、工作区是否干净（`clean`/tracked/untracked）、进程表（`processCheck`/`processesInUse`）、
是否被显式点名（`explicitlySelected`）**。判定顺序（任一不满足即不删）：symlink → 不在 owned root 内 → 账本已认领
（可信项目直接排除出候选，记入 `scan.claimedByLedger`；不可信项目 `CLAIMED_BY_UNTRUSTED_PROJECT`）→ 项目不可信/无项目行
（`PROJECT_NOT_TRUSTED`）→ 该路径命名了一个仍活跃的 Task（`ACTIVE_TASK`）→ 无 `.git` 标记
（`NOT_A_CODEESTRA_WORKTREE`）→ Git 注册不可读（`GIT_INSPECTION_FAILED`）→ Git 工作区状态不可读
（`GIT_STATE_UNAVAILABLE`）→ 进程表不可读（`PROCESS_CHECK_UNAVAILABLE`）→ 有进程工作目录在里面（`PROCESS_IN_USE`）
→ 有未提交改动（失败现场，`--include-failure-scenes` 才可越过）→ 未被点名（`UNREGISTERED_REQUIRES_EXPLICIT_SELECTION`）。
前三类不可核验的情况一律 `RECOVERY_REQUIRED` 且不删。

进程检查是 OS 事实：Linux 读 `/proc/<pid>/cwd`，否则 `lsof -a -d cwd -Fpn`（本机实测 ~2s，只在 `--unregistered`
时发生一次）；两种方式都不可用即 `PROCESS_CHECK_UNAVAILABLE`（fail closed）。

### 账本形态（schema v24，纯 additive 重建）

`reclamation_records` 重建为 v24：新增 `source`（`REGISTERED`/`UNREGISTERED_DIRECTORY`）、`kind` 增加
`UNREGISTERED_DIRECTORY`、`outcome` 增加 `RECOVERY_REQUIRED`、`task_id` 改为可空（`verifications/<project>/<id>`
这类残留有 project 却没有可诚实归因的 Task）；既有行原样拷贝并盖 `REGISTERED`，两个旧索引保留，新增
`reclamation_records_by_source`。`reclaim records` 可按项目（单项目或 `--all-projects`）、任务、`--source`、
`--since`/`--until`（epoch 毫秒或 ISO-8601）读回，输出仍是记录数组（每条带 `projectId`/`taskId`/`source`/时间）。

### 退出码（**Amends ADR-0021 D03**）

| 退出码 | `plan` | `apply` |
|---|---|---|
| 0 | 至少有一条可回收（`RECLAIM` 或已点名的未注册删除） | 确实 `RECLAIMED ≥ 1` |
| 3 | 正常 no-op：没有可回收项 | 正常 no-op：这次什么都没回收到 |
| 1 | 失败（未知项目 `NOT_FOUND`、扫描根越界、删除失败…） | 同上 + 删除失败 |
| 2 | CLI 用法错误（同既有 `usage()`） | 同左 |

`retained`/`refused` 仍是**正常决策**（不是失败），只是不再与「确实回收了东西」共用 0；退出码 3 时 stderr 保持为空。

### 测试清单

- `apps/runtime/test/cli-reclaim-batch.test.ts`（新，**12 项**，真实 CLI + 真实 Runtime + 1~2 个真实临时仓库）：
  1) 跨项目批量：项目 A `RECLAIMED`、项目 B 因活跃预留 `REFUSED`，一条拒绝不影响另一条，按项目分组、聚合计数、
  每个项目一个 operation、账本按项目读回、按来源过滤；2) 空批量 `plan`/`apply` 均 exit 3，范围冲突/`--task` 无
  `--project` exit 2；3) `git worktree add` 造出的未注册 worktree 被列出（证据断言含 `layout`/`runtimeHome`/
  `gitMarker`/`ledgerClaim`/`clean`/`processCheck`/`explicitlySelected`）→ 默认 `RETAIN` 且目录仍在 → 点名删除后
  目录消失、**branch 保留**、重复执行不二次记账（同路径只有一条 `RECLAIMED`）；4) 项目行不存在的目录与无 `.git`
  标记的目录即便被点名也不删（`ls` 前后对比断言目录与内部文件仍在），可归因的那个记 `RECOVERY_REQUIRED`；
  5) `git clone` 造出的未注册 checkout（Git 不注册）走窄删除，`--scan-root` 越出 home 被拒；6) home 经 symlink 到达时
  （`/tmp` vs `/private/tmp`）**已登记 worktree 不得被当成未注册目录**，且按 symlink 拼写的选择仍命中规范记录
  （这条是本轮 e2e 暴露出的真实缺陷的回归测试：修之前必失败、修之后通过）；7) 活跃预留保护
  `REFUSE/ACTIVE_RESERVATION` 且账本里带预留 ID；8) 真进程 cwd 在未注册目录内 → `RECOVERY_REQUIRED/PROCESS_IN_USE`
  且目录仍在（本测试自己 spawn 一个 cwd 在该目录内的子进程，并在 `finally` 里结束它）；9) 按
  `--source`/`--since`/`--until` 读账本；10) v21→v24 迁移保留既有行、`foreign_key_check` 为空、新 CHECK 拒绝非法
  source/outcome、`task_id` 可为空；11) 迁移不在 base schema 里；12) 已是最新版本的库重开时不重跑。
- `apps/runtime/test/cli-reclaim.test.ts`（既有，4 处断言更新）：无操作/拒绝路径的 `plan`/`apply` 退出码从 0 改为 3。
- `packages/storage/test/{impact-analysis,slot-capacity-migration}.test.ts`、`apps/runtime/test/{revision-delivery,
  verification-cancel}.test.ts`：4 处写死 `phase1SchemaVersion === 21` 的断言随 v24 更新（其中一处改为
  `toBe(phase1SchemaVersion)`，另一处改为 `toBeGreaterThanOrEqual(21)`，避免下次再被同一个断言绊住）。

### 实际验证

- `bun run check`：**退出码 0** —— 根与 UI `tsc --noEmit`、**272 项 Vitest**、**579 项 Bun tests（0 fail，68 文件）**、
  UI Vite 构建成功。**跑完后孤儿 Runtime 进程 0**（`ps` 按 argv/cwd 核验，本 home 无残留）。
- 过程中如实记录一次**既有、与本格无关的负载敏感抖动**：第一次完整 `check` 中
  `cli-impact.test.ts`「derives SAFE, CONFLICTING, and UNKNOWN verdicts from real change sets」在最后一步
  `task cancel <project> <first> 2`（硬编码 expected version）上收到 exit 1；单独重跑该文件 **1 pass / 0 fail**，
  其后的完整 `check` 均 **579 pass / 0 fail**。本格未改动调度/取消/版本路径（`schedule-service`、
  `scheduler`、`slot-reservation-service`、`task-control-service` 一行未动），不把它算成本格修复成果。
- **端到端（真实 CLI + 真实 Runtime + `CODEESTRA_HOME=/tmp/ce-h4` + 两个真实临时仓库）**，完整输出见
  `/tmp/h4-evidence.log`，要点：
  - `reclaim plan --all-projects --unregistered --json`：`scope: ALL_PROJECTS`，两个分组
    （A `TASK_WORKTREE RECLAIM COMPLETED_AND_QUIESCENT`，B `TASK_WORKTREE REFUSE ACTIVE_RESERVATION`），
    聚合 `counts {total: 2, reclaim: 1, refuse: 1}`，`processCheck: AVAILABLE`，exit 0。
  - `reclaim apply --all-projects --json`：exit 0，`outcome: SUCCEEDED`、`outcomeCounts {reclaimed: 1, refused: 1, failed: 0}`、
    `operations` 两个项目各一条、`failures: []`；A 的 worktree 目录消失、B 的 workspace 仍在；账本两条
    （A `RECLAIMED/REMOVED`、B `REFUSED/ACTIVE_RESERVATION`）。
  - 未注册目录：`git worktree add -b task/<uuid>` 造出的目录被列出，证据
    `{layout: "<home>/worktrees/<project-id>/<resource-id>", runtimeHome: "/private/tmp/ce-h4", gitMarker: "FILE",
    ledgerClaim: null, registered: true, clean: true, processCheck: "AVAILABLE", explicitlySelected: false}`，
    动作 `RETAIN/UNREGISTERED_REQUIRES_EXPLICIT_SELECTION`；不点名的 `apply` 之后 `ls -d` 仍显示该目录（exit 3）。
  - 点名删除：`apply --unregistered --remove-unregistered <path>` exit 0、`reclaimed: 1`，目录消失，
    `git rev-parse refs/heads/task/<uuid>` 仍返回原 commit（branch 保留）；第二次同名运行 exit 3 且
    `records --source UNREGISTERED_DIRECTORY` 里同路径只有一条 `RECLAIMED`（append-only，不重复记账）。
  - 无法核验：项目行不存在的目录（真实 worktree）在点名的批 `apply` 里列为
    `unregistered.unattributed` 的 `RECOVERY_REQUIRED/PROJECT_NOT_TRUSTED`（不删、也**不入账本**，见下）；
    可信项目内无 `.git` 标记的目录记为 `RECOVERY_REQUIRED/NOT_A_CODEESTRA_WORKTREE`；`ls -d` 与
    `ls <dir>` 前后对比证明两个目录及其内部 `notes.txt` 都在原处。
  - 真进程占用：在一个真实 worktree 内起 `sleep 120`（cwd 在里面）后，`plan` 列出
    `RECOVERY_REQUIRED/PROCESS_IN_USE` 并附进程工作目录；点名的 `apply` 仍 exit 3、目录仍在。
  - 收尾：`codeestra stop` exit 0（`status: STOPPED`、`waitedMs: 31`、`identityVerified: true`、
    `ownership.verdict: NOT_RUNNING`），随后 `ps` 里没有命名 `/tmp/ce-h4` 的进程；`/tmp/ce-h4*` 夹具已回收。

### 已知边界（如实记录）

- **无法归因到任何 ACTIVE-trusted project 的目录只报告、不入账本**（`unregistered.unattributed`，动作
  `RECOVERY_REQUIRED`）。账本是 project 作用域（`reclamation_records.project_id` 与 `operations.project_id` 非空），
  把别人的目录记到某个项目名下正是本能力要防的假归因；要清理它们需要先把项目重新 trust，或另立一个 home 级账本
  （需单独决策）。这一点写在 ADR-0037 D08/Consequences。
- **进程检查只比对工作目录**：一个把 cwd 设在别处、却持有该目录内文件句柄的进程不会被发现。
- 未被任何记录识别的**非目录条目**（文件）不进入候选，也不会被删除；`--scan-root` 之外的一切都不看。

### 未验证（不得当成已成立）

- 跨用户/跨机器场景：`lsof` 对其它用户进程的可见性、`/proc` 与 `lsof` 之外的平台。
- 真实磁盘压力下的大批量（>500 候选被 `truncated` 截断的路径只有单元级覆盖）。
- 陈旧注册（Git 仍注册、目录已不在）的未注册分支；并发多次 `reclaim apply` 的竞争（仍按 command ID 幂等，
  未做压力测试）。
- UI 投影（本格不做；`apps/ui/**` 一行未动）。
- 把 `reclaim` 接入任何自动路径（本格明确不做，且属于需要单独 ADR 的范围）。

### 改动边界

改动/新增：`apps/runtime/src/reclaim-service.ts`（独占）、`apps/runtime/test/cli-reclaim-batch.test.ts`（新）、
`docs/decisions/0037-*.md`（新）、`docs/tasks/README.md`（本节）；共享槽位按纪律只做追加：
`packages/contracts/src/index.ts`（只动三个 `reclaim.*` 请求）、`packages/storage/src/{migration,database,index}.ts`
（v24 迁移 + 账本/候选纯追加读写 + 新方法）、`apps/cli/src/main.ts`（只加 `reclaim` 的选项与 `usage()` 追加行）、
`apps/runtime/src/main.ts`（只做接线）、`package.json`（两份测试列表各加 `cli-reclaim-batch`）、
`docs/decisions/README.md`（表尾一行 + Phase 2 前那张表的一行更新）。**未改**：`schedule-service`、`scheduler`、
`slot-reservation-service`、`agent-runtime-service`、`session-handoff-service`、`terminal-service`、
`packages/agent-adapters/**`、`apps/ui/**`、`packages/domain/**`、`PROJECT_SPEC.md`、`docs/architecture/**`；
`## NEXT` 条目本身**一字未动**。

### 建议如何更新 `## NEXT` 第 5 条

第 5 条现在只剩「并发压力测试」这一项，建议把该行改为：

> 5. ~~验证副本与失败现场的回收~~：已由 ADR-0021/FOUNDATION-041 完成（…）。~~剩余：未注册目录的人工处理与跨项目批量回收~~
>    已由 ADR-0037/FOUNDATION-062 完成（`--all-projects` 批量、`--unregistered` 有界扫描 + 逐条归属核验 + 默认 dry-run +
>    `--remove-unregistered` 点名才删 + 同一本账的 `source` 留痕；退出码 0/3/1，schema v24）。**剩余**：并发多次
>    `apply` 的竞争压力测试；**无法归因到任何已信任项目的目录只报告不入账**（需先重新 trust，或另立 home 级账本——单独决策）。

## FOUNDATION-061 — `FAILED → READY`：显式 `task retry` 与失败后换 Agent（ADR-0036，schema v23）

状态：已提交为 `a0b7254` 并经 merge `4ecc630` 合入 `dev`；未 push、未提升 `main`、未重启稳定 Runtime、未触碰 `/Users/loyage/Documents/codeestra`。

### 缺口（提交前逐条实测确认，不是猜测）

- `state-machines.md` §1 写了 `FAILED | user retry | 旧执行静止、依赖重验→READY 或 BLOCKED`，`mvp.md` Phase 5 验收写着「失败后新 Execution 可更换 Agent」，ADR-0029 明确记录了「Runtime 没有 `FAILED → READY` 路径」。
- 实测：把 Task 写成 `FAILED` 的路径有多条，**没有任何一条**把它移出；`resumeTask` 只接受 `PAUSED`；`applyTaskDependencyState` 只在 `READY`/`BLOCKED` 间移动；调度引擎的候选集合是 `state === 'READY'`。一次真正跑失败的 Task 只能被新建 Task 取代，丢掉 revision、worktree、依赖边与审计关系。

### 已实现（新增 ADR-0036；schema v23：两列，无新表）

- `docs/decisions/0036-task-retry-after-failure.md`（Accepted），决策索引表尾追加一行；未改 `PROJECT_SPEC.md`、`AGENTS.md`、`docs/architecture/**`。
- **纯领域判定** `packages/domain/src/task-retry.ts`：`planTaskRetry`（来源状态 → 允许/稳定拒绝码）、`selectRetryAdapter`（显式 > 该 Task 上次记录 > 默认）、`decideRetryWorkspace`（复用/从零/两种拒绝）。全部是值而不是异常，调用方必须如实报告。
- **存储** `packages/storage/src/database.ts`：`retryTask`（同一 `executeCommand` 事务内重读状态与版本、校验被指向的失败 Execution 是**最新** attempt、把 Task 移向 `READY`/`BLOCKED`、把核验过的 worktree 从 `RETAINED`/`READY` 置回 `READY`、写 `TaskStateChanged` + `TaskRetryRequested` 两条 append-only 事件）；`getLatestTaskWorkspace`（读回最近一条 worktree 记录，回收后也能看出「不是没有，而是被回收了」）；`reserveExecution` 消费 `tasks.pending_retry_from_execution_id` 并写入 `executions.retry_from_execution_id`（**单次**：恰好一个新 Execution 成为那次失败的 successor），`ExecutionReserved` payload 同步带该字段；`ExecutionSummary` 增加 `retryFromExecutionId`（`task status --json` 可读）。
- **迁移 v23**：`taskRetryMigration` 只加 `tasks.pending_retry_from_execution_id` 与 `executions.retry_from_execution_id` 两列（都 `REFERENCES executions(id)`，NULL 默认）。v22 留给 H2，v16 继续永久未使用，只追加 `if (version < 23)`，未插入更早的号。
- **Runtime 接线** `apps/runtime/src/task-control-service.ts` 的 `retryFailedTask`：版本 CAS → eligibility → 找到最新失败 Execution → Adapter 选择与存在性校验（未知 adapter 在写入前以 `UNKNOWN_ADAPTER` 拒绝）→ `inspectTaskDependencies` 得出目标状态 → `reconcileWorkspace` 核验 worktree 归属 → `storage.retryTask`。**不在这里启动任何东西。**
- **命令面** `apps/cli/src/main.ts` + `apps/runtime/src/main.ts`：`task retry <project-id> <task-id> <expected-version> [--adapter <pi|codex>] [--json]`，零新增确认。requeue 之后只对**该 Task** 调一次 `ScheduleService.runNow`（与 `task run` 完全同一条依赖→冲突→容量门禁），启动请求使用派生 command ID（`deriveCommandId(request.commandId,'retry-start')`），所以同一条命令重放幂等且不与 requeue 自己的回执冲突。`usage()` 明确写出它与 `resume` 的区别（`resume` 续接同一 conversation；`retry` 新建 Execution）。

### 允许与拒绝的来源状态（拒绝不写任何行）

| 来源 | 结果 | 稳定码 |
|---|---|---|
| `FAILED` | requeue（`READY`，或依赖未满足时 `BLOCKED`） | — |
| `CANCELLED` | 拒绝 | `TASK_CANCELLED` |
| `RECOVERY_REQUIRED` | 拒绝 | `RECONCILE_REQUIRED` |
| `PAUSED` | 拒绝（用 `task resume`） | `TASK_PAUSED` |
| `RUNNING`/`PAUSING`/`WAITING_FOR_USER`/`CANCELLING` | 拒绝 | `TASK_STILL_RUNNING` |
| `DRAFT`/`BLOCKED`/`READY`/`EXECUTED`/`SUCCEEDED` | 拒绝 | `TASK_NOT_FAILED` |
| 任意状态 + 已归档 | 拒绝 | `TASK_ARCHIVED` |
| worktree 归属无法核验 | 拒绝 | `WORKSPACE_OWNERSHIP_UNVERIFIABLE` |
| worktree 已被 reclaim（branch 仍在） | 拒绝 | `WORKSPACE_RECLAIMED` |

### 命令用法、退出码与审计形态

```text
task retry <project-id> <task-id> <expected-version> [--adapter <pi|codex>] [--json]
  0 = 新 Execution 已启动（start.outcome=STARTED）
  3 = 重试已记录、Task 已 requeue 但在等待（wait.code 是 CAPACITY_* / 冲突码；Task 留在 READY 排队）
  1 = 重试被拒绝（稳定码在 stderr），或已 requeue 但没有启动（例如落到 BLOCKED → REFUSED/DEPENDENCIES_UNMET）
```

- 版本 CAS **先于**状态判定（与 `submit`/`pause`/`resume` 一致）：版本过期报 `CONCURRENT_MODIFICATION`，让调用方先重新读取，
  而不是按一个 Task 可能已经离开的状态给出结论；状态判定只在版本匹配时进行。
- `--json` 把两件事分开报告：`state`/`version`/`retryId`/`failedExecutionId`/`failedAttemptNumber`/`adapterId`/`previousAdapterId`/`adapterChanged`/`adapterSource`/`workspace{mode,workspaceId,evidence}` 与 `start`（就是 `ScheduleStartOutcomeView`）。
- 审计 = `TaskRetryRequested`（append-only 领域事件，`events list/tail` 可读）：`actor`、`failedExecutionId`、`failedAttemptNumber`、`adapterId`/`previousAdapterId`/`adapterChanged`、`workspaceMode`/`workspaceId`/`workspaceEvidence`、目标状态与依赖原因；关系另有 `executions.retry_from_execution_id` 落在行上。旧 Execution 的 `state=FAILED`/`error_json`/`ended_at` 一律不改写。
- **`--adapter` 的已知边界**：它只作用于本次显式请求。若只得到 `wait`，Task 留在 `READY` 排队，由周期 tick 启动时用的是 Runtime 默认 adapter（引擎的 adapter 是整项目一个，本格未改引擎）。`adapterSource` 与 `start.outcome` 使这一点对脚本可见。

### 实际验证（本机，实际退出码与计数）

- `bun run typecheck`：通过。
- `bun run check:fast`：退出码 0（vitest **279 pass / 6 文件**；`test:unit` **368 pass / 0 fail**）。
- **`bun run check`：退出码 0**（根/UI TypeScript、vitest **279 pass**、`test:storage` 全部 bun 测试 **584 pass / 0 fail / 69 文件 / 3677 断言**、Vite `build:ui`）。最终一次完整日志：`/tmp/h3-check4.log`（`/tmp/h3-check2.log` 是更早一次同样退出码 0 的完整运行）。
- 完整 `check` 首轮出现过 5 个失败，已逐个定位并分类：**其中 3 个（`revision-delivery.test.ts` ×1、`verification-cancel.test.ts` ×2）来自本格 schema 版本推进后失效的硬编码断言**，另在 `bun test packages/storage/test` 里还有 4 个同类失败（`impact-analysis.test.ts` ×2，`slot-capacity-migration.test.ts` ×2 个用例共用的一个断言）；它们全是写死的 `phase1SchemaVersion === 21`（即「本 lane 是最后一格」的过时断言），已按集成惯例改为断言常量本身或 `>= 21` 并逐处注明原因。剩下的三个失败都与本格改动无关，且都是**对负载敏感的既有断言**：**(a)** `cli-impact.test.ts`:376 的 `task cancel` 退出 1 已在基线 `8058eb9` 的干净检出（独立 `git worktree` + 自己的 `bun install`）上单独复现——同样的断言、同样的退出码——属 **pre-existing 失败**，在本格的最终一次完整运行里通过；**(b)** `terminal-service.test.ts` 的 PTY release 断言在基线单独运行通过、在本格两次满载全量运行中各失败一次（两次的断言不同：`released` 与 `SESSION_FILE_REWRITTEN`/`PREDECESSOR_UNVERIFIED`），单独重跑通过；**(c)** `runtime-lifecycle.test.ts` 的「a deadline that never fires cannot hold a process open」断言 `rawStdout` 恰好等于 `'raw 0'`（即内联脚本自测耗时 0ms），满载运行时拿到 `'raw 1'`——这处断言把「0ms 抖动」当成不变量；单独重跑 3/3 通过。三处都在其它格的领地（FOUNDATION-042 / ADR-0026 / FOUNDATION-053），本格**只报告、不改动**，建议后续单独修（把 `toBe('raw 0')` 放宽为对耗时上界的断言、把 PTY release 的等待改为对事实的有界轮询）。
- 端到端（真实 CLI + 真实 Runtime + 临时 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）：`apps/runtime/test/cli-task-retry.test.ts` **6 pass / 0 fail / 81 断言**。(1) 首次失败 → `task retry` 退出 0、attempt 2 建立、`REUSE_VERIFIED`、同一 worktree 里 `runs-<task>.log` 出现第二行（两次尝试确实复用同一 worktree）、`TaskRetryRequested` 与 `ExecutionReserved.retryFromExecutionId` 可读；(2) 未提交/`RUNNING`/`CANCELLED`/已归档各自以稳定码拒绝且版本不变、不产生 Execution，且版本过期先报 `CONCURRENT_MODIFICATION`；(3) `--adapter codex` 后新 Execution 真的由 Codex stub 启动（读 stub 自己的 report：`turns>=1`、prompt 含规格），审计记录 `adapterChanged`；(4) 容量 1 时重试退出 3 且 `CAPACITY_GLOBAL_LIMIT_REACHED`、Task 留在 `READY`、释放槽位后 attempt 2 才跑起来（排队而非插队）；(5) worktree 被 `reclaim` 后重试以 `WORKSPACE_RECLAIMED` 拒绝、版本不变、Execution 仍只有 1 条（并核对 `git branch --list task/<id>` 证明分支仍在）；(6) 依赖未满足时 requeue 到 `BLOCKED`、`start.outcome=REFUSED/DEPENDENCIES_UNMET`。
- 单元：`packages/domain/test/task-retry.test.ts` 7 项（vitest，权限/拒绝码/Adapter 选择/workspace 决策矩阵）；`packages/storage/test/task-retry.test.ts` 11 项（真实 SQLite：requeue + worktree 交还 + 事件、单次关系消费、同 command 重放幂等、七种非 `FAILED` 来源拒绝且不留行、归档、非最新 attempt、换 Adapter、`BLOCKED` 原因约束、不交还未核验的 worktree、v23 两列无新表）。
- 测试卫生：新 e2e 文件用 `apps/runtime/test/support/runtime-reclamation.ts` 的 `runCli` + `reclaimTestResources`（`afterEach`），并已加入 `package.json` 的 `test:unit` 忽略列表与 `test:e2e` 列表。**完整 `check` 之后本格无孤儿 Runtime**（`ps` 只看到 main 稳定工作树的 Runtime 进程与其它 lane 自己的进程；本格从未启动 `/tmp/ce-h3`，e2e 使用各自的临时 home 并由回收辅助统一 stop）。

### 明确未做 / 未验证

- **未验证**：真实 Pi/Codex 失败后的重试行为（协议 stub 只证明编排；真实提供者的失败只能在 `## NEXT` 第 1 项的真实验收里看）；取消后重做（`CANCELLED` 仍拒绝，属另一个决策）；跨 adapter 复用历史 conversation（retry 刻意新建 conversation）；被 reclaim 后重建 worktree（见下）；`task retry` 的 UI 投影（H1 领地）；真实并发/真实模型行为下的重试。
- **已知缺口（如实报告，未静默绕过）**：`packages/git/src/reclaim.ts` 明确不删 task branch，因此**已被回收**的 worktree 无法由既有 preparation 路径重建（`prepareWorkspace` 的 `REF_CONFLICT` 会拒绝在既有分支上建 worktree）。本格选择**拒绝并给出稳定码** `WORKSPACE_RECLAIMED`，而不是引入第二套 Git 逻辑或悄悄复用别人的目录；若要把这一格补成「能从既有分支重建」，需要独立决策与领地安排。
- **未改**：`apps/ui/**`（H1）、`packages/storage/src/migration.ts` 的 v22 号段（H2）、`reclaim-service.ts`（H4）、`session-handoff-service.ts`/`terminal-service.ts`/`packages/agent-adapters/**`（G1）、`schedule-service.ts`/`scheduler.ts`/`slot-reservation-service.ts`（引擎与预留）、`packages/git/**`、`PROJECT_SPEC.md`、`docs/architecture/**`。

## FOUNDATION-063 — 事件名与事件面对齐（ADR-0035）

状态：已提交为 `975fd15`，在顺序末尾经 merge `c8755d4` 合入 `dev`，最终独立集成检查通过。本格来自用户对 FOUNDATION-051（doc-sync）交出的四条不一致的裁决：

1. 事件命名方向（文档对齐实现名 + 新事件用设计名 + 已实现名永不重命名）；
2. 只补交接/终端那 7 个事件，**不做** `ImpactAssessed`/`ConflictAssessed`、不做 Execution 专名事件、不顺手实现 Session Guidance；
3. `AdapterCapabilities` 补进 `nativeTerminalHandoff` 与 `safePointNotification`，由适配器如实声明。

**编号记录：**本格指令原写 ADR-0034 与 FOUNDATION-058，但固定基线 `dev@8058eb9275fbea87c1216c4ac9ea66b7e7d96022` 里这两个编号已被 `ADR-0034 紧凑任务信息行与主操作优先` / `FOUNDATION-058` 占用（同基线内的另一条 lane）。该 lane 原先顺延为 ADR-0035 + FOUNDATION-059；集成时 FOUNDATION-059 已由 H1 占用，因此保留 ADR-0035，并把本格任务记录顺延为 **FOUNDATION-063**，不重命名已合入的 H1–H4 记录。

### 1. `event-model.md`：目录对齐到实现名 + 命名规则

- §2 改为以实现实际写入的名字为准，逐条按 `packages/storage/src/database.ts` 与 `apps/runtime/src/**` 的写入点核对（不照抄原 §2.2 表，原表也一并校对）。§2.1 保留各领域（长命令进度/验证/修订投递/容量与调度/集成与提升/回收）的补充事实，并新增交接与终端一节。
- **命名规则**（§2.2，长期有效）：① 已实现的事件名以实现为准，**永不重命名**（append-only 审计；重命名会让同一语义长期有两个名字，并使已发出的订阅游标、消费者幂等键与外部脚本失效）；② 新事件采用设计目录里的名字；③ 名字变更只能通过「新增事件 + 旧事件不再产生」实现，不迁移历史行、不把旧名行「升级」成新名。
- §2.3 把原「交用户裁决」表改为**已裁决**并指向 ADR-0035：「已废弃」的设计名逐一标注（`TaskRevisionAppended`/`DependencyAdded`/`DependencyNeedsReview`/`RevisionDelivered`/`RevisionAcknowledged`/`ExecutionResultCaptured`/`DevIntegration*`/`StablePromotion*`），未实现的设计名如实登记（`IntentClarificationRequested`/`TaskPriorityChanged`/`SessionGuidance*`/`ResultCommitAuthorizationRequested`/`CandidateBuilt`/`SelfTestCompleted`/`StablePromoted`/`StableRollbackCompleted`/`ImpactAssessed`/`ConflictAssessed`），实现新增的名字反向登记。
- §5 追加三条测试要求：同一 command 重放不产生第二个事件（含拒绝事实）；事件与状态变更同事务提交；旧设计名的历史行仍可读且未被改写。

### 2. 七个交接/终端事件

| Event | aggregate | 写入点（事务边界） |
|---|---|---|
| `TakeoverRequested` | `SessionHandoff` | `recordSessionHandoffRequest`：与 `session_handoff_requests` 行同事务；重放路径不写 |
| `TakeoverSafePointReached` | `SessionHandoff` | `recordSessionHandoffSafePoint`（RPC fence）与 `markSessionTerminalHandoffSafePoint`（终端发布）：各与 `AT_SAFE_POINT` 迁移同事务 |
| `SessionHandoffStarted` | `SessionHandoff` | `beginSessionHandoff`（新）：与「predecessor 置 EXITED + 释放 lease」同一事务 |
| `SessionHandoffCompleted` | `SessionHandoff` | `markSessionHandoffAdmitted`：与 `ADMITTED` 迁移同事务（successor 无法描述则整体回滚） |
| `TerminalWriterLeaseChanged` | `SessionWriterLease` | lease 行的插入（`#insertSessionWriterLease`）与两个释放方法；只在 `changes === 1` 时写 |
| `TakeoverReleased` | `SessionHandoff` | `markSessionTerminalHandoffSafePoint`：与发布安全点同事务；只在发布**被证明**时写 |
| `TakeoverFailed` | `SessionHandoff`（无 takeover 时以 sessionId 为 aggregate id） | `recordSessionHandoffFailure`：拒绝本身没有状态变更，所以单独成事务；event id = `sha256(commandId:stage:reason)`，重放不新增行 |

payload 要点（均在 `packages/contracts/src/index.ts` 用 Zod `strictObject` 定义，存储写入前 `parse()`）：

- `TakeoverRequested`：takeoverId, sessionId, executionId, incarnationId, `kind`（TAKEOVER/RETURN）, `targetMode`；
- `TakeoverSafePointReached`：takeoverId, sessionId, executionId, incarnationId, `reachedFrom`（RPC_FENCE/TERMINAL_RELEASE）, `fenceAcknowledged`, `settledAfterFenceAt`, `activeTools`, `evidenceRef`, `lastEntryRef`, **`missing`**（未观测到的安全点事实）；
- `SessionHandoffStarted`：takeoverId, source/targetSessionId, sourceIncarnationId, fromMode, toMode, `predecessorObservation`, `processEvidenceRef`；
- `SessionHandoffCompleted`：上者 + successorIncarnationId/Number, `terminalTransport`(PTY/RPC/NONE), terminalId, providerPid, processEvidenceRef；
- `TerminalWriterLeaseChanged`：takeoverId（开着的交接才有）, sessionId, leaseId, `action`(ACQUIRED/RELEASED), `before`/`after`（{incarnationId,holderKind,holderRef} 或 null）, reason；
- `TakeoverReleased`：takeoverId, sessionId, executionId, incarnationId, terminalId, reason, predecessorObservation, evidenceRef, `sessionFile{file,entriesAtStart/Release,lastEntryIdAtStart/Release,predecessorEntrySurvived,truncated}`；
- `TakeoverFailed`：takeoverId（可空）, sessionId, executionId, incarnationId（可空）, `stage`(REQUEST/SAFE_POINT/ADMIT/RELEASE), **`reason`（稳定码，不新增枚举）**, detail, evidenceRef。

事实边界（不把愿望写成事实）：`TakeoverRequested` 与 `SessionHandoffStarted` **都不是**「已交接」（前者只是意图 + fence，后者只是 predecessor 不再是 writer、successor 尚未启动）；只有 `SessionHandoffCompleted` 表示 successor 进程真的启动、记录并持有单 writer lease。`TakeoverReleased` 只在发布被证明（provider 退出 + 记录的进程树无存活者 + provider session file 仍保有 predecessor 的 entry）时写；证明不了的是 `TakeoverFailed`。安全点事件经终端发布达成时如实写 `fenceAcknowledged: false`，绝不假装 fence 被 ack。

实现细化：交接路径上的「predecessor 置 EXITED + 释放 lease」两步合并为 `beginSessionHandoff` **一个**事务（原来是两个事务），因此 `SessionHandoffStarted` 与 `TerminalWriterLeaseChanged(RELEASED)` 与两个状态写入同事务；这是**更**原子，不是行为变化。`recordSessionHandoffRequest` 新增一个显式 `NOT_FOUND`（incarnation 不存在）：该路径本来就会因 FK 违反而失败，现在给出可读的稳定错误。`TakeoverFailed` 的 reason 复用既有 CLI/服务已返回的稳定码（`HANDOFF_NOT_REQUESTED`/`SAFE_POINT_NOT_REACHED`/`ATTACHMENT_BUSY`/`HANDOFF_ALREADY_REQUESTED`/`PREDECESSOR_NOT_STOPPED`/`RELEASE_NOT_CONFIRMED`…），**未新增 reason code 枚举**。

UI **零改动**（事件联合是 `eventType: string`，`contracts` 变更不导致 UI typecheck 失败；也未做任何视觉/交互改动）。CLI 唯一改动：`events list` 接受 `--json`（与 `task revision list` 一致，只是明确脚本意图；`list` 本来就输出 Runtime 投影）。

### 3. `AdapterCapabilities` 补齐：所有构造点

新增必填字段 `nativeTerminalHandoff` 与 `safePointNotification`（`packages/contracts/src/index.ts`，与设计类型语义一致）。**9 处**构造点全部显式声明（`bun run typecheck` 会逐处报错，漏一处不会静默通过）：

| 构造点 | `nativeTerminalHandoff` | `safePointNotification` | 依据 |
|---|---|---|---|
| `packages/agent-adapters/src/pi-adapter.ts` | `SUPPORTED` | `SUPPORTED` | ADR-0026 实测：predecessor 停止写作→同一 session file 上启动原生 TUI（Runtime 拥有的 PTY）→单 writer lease；gate extension 上报 tool_start/tool_end/agent_settled。残留边界写在 `SessionHandoffCapabilities`（`crossHandoffPermissionModeMatrix: PARTIAL`、`parallelToolBatchSafePoint: UNVERIFIED`） |
| `packages/agent-adapters/src/codex-adapter.ts` | `UNSUPPORTED` | `UNSUPPORTED` | `docs/spikes/codex-0.151.0.md`：app-server 无终端交接；Codex 自己的 TUI 是同一 thread 的第二个 writer；interrupted turn 不产生完成事实，无工具级安全点通知 |
| `packages/agent-adapters/src/index.ts`（deterministic fake） | `UNSUPPORTED` | `UNSUPPORTED` | 不启动 provider、不说 side channel；声称支持会掩盖它存在的目的——拒绝路径 |
| `apps/runtime/test/agent-runtime-service.test.ts` | `UNSUPPORTED` | `UNSUPPORTED` | 同上（测试 stub） |
| `apps/runtime/test/operation-service.test.ts` | `UNSUPPORTED` | `UNSUPPORTED` | 同上 |
| `apps/runtime/test/task-control-service.test.ts` | `UNSUPPORTED` | `UNSUPPORTED` | 同上 |
| `apps/runtime/test/revision-delivery.test.ts` | `UNSUPPORTED` | `UNSUPPORTED` | 同上（另有 4 处 `{ ...unsupportedCapabilities, … }` 展开，继承声明） |
| `packages/agent-adapters/test/pi-adapter.test.ts` | `SUPPORTED` | `SUPPORTED` | 断言能力矩阵（`toMatchObject`） |
| `packages/agent-adapters/test/codex-adapter.test.ts` | `UNSUPPORTED` | `UNSUPPORTED` | 断言能力矩阵（`toEqual` 全量） |

自检命令（应只列出上面 9 处 + 契约定义 + 注释）：`grep -rn "nativeTerminalHandoff\|safePointNotification" apps packages --include=*.ts`。Wave D 踩过的「单格绿、合并后才爆」由必填字段 + 全仓 typecheck 挡住。

**未改交接路径的能力门禁**：把 Pi 专属机制套到别的 provider 上本就会被拒，但改成「先查能力再决定」会引入新的拒绝码与时序，属于另一次语义变更；交回报告作为建议，不在本格实施。

### 4. 实际验证

- `bun run check:fast`：退出码 0。
- **完整 `bun run check`：退出码 0**（根/UI TypeScript、**272 项 Vitest + 576 项 Bun tests（67 文件）**、Vite 构建）。基线为 567 项 Bun tests，+9 为本格新增（6 单元 + 3 端到端）。日志：`/tmp/ce-g1-check.log`（check:fast 为 `/tmp/ce-g1-checkfast.log`）。
- 新增单元测试（`apps/runtime/test/session-handoff-service.test.ts`，复用已有 harness）：同一 command 重放只产生一条 `TakeoverRequested`；lease 事件只在 lease 真变化时写（重复 release 不加事件）；安全点事件与其状态迁移同时出现、漏斗期不假写；用一个无法描述的 successor 让 ADMITTED **回滚**，验证状态与事件一起消失；拒绝按 command 幂等且不掩盖另一个拒绝；7 个 payload 的 `strictObject` 拒绝未描述字段。
- 新增端到端测试（`apps/runtime/test/cli-session-handoff.test.ts`，真实 CLI + 真实 Runtime + 临时 `CODEESTRA_HOME` + **协议 stub provider**——stub 不是真实 Agent 集成，只复用 gate extension 说同一种 side channel）：7 个事件各自从 `events list --json` 读出并用契约 schema 解析；一个 takeover 的 aggregate version 严格递增；重复 `admit` 不产生第二条 `SessionHandoffCompleted`；构造一条旧设计名（`TaskRevisionAppended`）的历史行并读回，名字与 payload 原样。
- 手工端到端证据（真实 CLI + 真实 Runtime + `CODEESTRA_HOME=/tmp/ce-g1` + 临时仓库 `/tmp/ce-g1-repo` + 协议 stub provider）：

| 命令 | `events list --project … --json` 里的事件要点 |
|---|---|
| `task run <p> <t> 1` | `TerminalWriterLeaseChanged` ACQUIRED，takeoverId=null，after={holderKind:AUTOMATED_RPC}，aggregateVersion 1 |
| `session handoff admit <p> <s>`（无请求，exit 1） | `TakeoverFailed` stage=ADMIT reason=`HANDOFF_NOT_REQUESTED` takeoverId=null（aggregate 落在 sessionId 上，v1） |
| `session handoff request <p> <s> takeover` | `TakeoverRequested` kind=TAKEOVER targetMode=HUMAN_TUI incarnationId=<自动化 incarnation> v1 |
| stub 回 `fence_ack`+`agent_settled` ⇢ `session handoff status` 显示 `AT_SAFE_POINT / reached=true / missing=[]` | `TakeoverSafePointReached` reachedFrom=RPC_FENCE fenceAcknowledged=true settledAfterFenceAt=1789450745647 activeTools=0 missing=[] evidenceRef=`handoff:<id>#fence=…` v2 |
| `session handoff admit <p> <s>`（exit 0，successorMode=HUMAN_TUI terminalTransport=PTY predecessorObservation=STOPPED） | `SessionHandoffStarted` fromMode=AUTOMATED_RPC toMode=HUMAN_TUI predecessorObservation=STOPPED v3；`TerminalWriterLeaseChanged` RELEASED（before=AUTOMATED_RPC）+ ACQUIRED（after=TERMINAL_ATTACHMENT）；`SessionHandoffCompleted` successorIncarnationNumber=2 terminalId/providerPid 非空 v4 |
| 再次 `session handoff admit`（`replayed: true`, exit 0） | **没有**第二条 `SessionHandoffStarted`/`SessionHandoffCompleted`（幂等） |
| `session handoff release <p> <s> --no-resume`（exit 0，predecessorEntrySurvived=true） | `TakeoverRequested` kind=RETURN targetMode=AUTOMATED_RPC；`TakeoverSafePointReached` reachedFrom=TERMINAL_RELEASE fenceAcknowledged=false lastEntryRef=`g1-session` missing=[]；`TakeoverReleased` terminalId 非空 predecessorObservation=STOPPED sessionFile{entriesAtStart/Release=1, predecessorEntrySurvived:true, truncated:false} |
| `codeestra events tail --project … --since 19` | 同一订阅传输从游标重放：seq 20–32 中七个名字均可读到（含 `OperationProgressed`/`OperationSettled` 混杂） |

- 孤儿进程：完整 `check` 后**本工作树（`g1-event-model-alignment`）的 Runtime 进程为 0**；`ps` 中仍有 `/Users/loyage/Documents/codeestra`（main 稳定服务）与其它 worktree（h1/h2/h3）的 Runtime，**不属于本格**，未做任何处理。`/tmp/ce-g1*` 夹具经 `codeestra stop` 后确认无进程引用再删除。
- 本格**未** `push`、未提升 `main`、未重启稳定 Runtime、未碰 `/Users/loyage/Documents/codeestra`；无浏览器/桌面/键鼠自动化。

### 5. 未验证 / 边界

- **真实 Pi 的 TUI 交接在这些事件下的实时表现未验证**：所有端到端证据用的是协议 stub provider，它只证明 Runtime 自己的事件契约与编排，不证明真实模型行为。UI 观感（人工目视）未做。
- **「设计名 vs 实现名」是否还有本格判断不了的历史分歧**：只能根据本仓库代码与本基线数据库判定；无法确认某个被标为「未实现」的设计名是否曾在别的环境（早期分支/其他数据库）真实写入过。
- 未验证：`TakeoverFailed` 在真实 provider 下的触发路径（本格测的是编排层拒绝：无请求、无安全点、已开请求）；`TakeoverReleased` 在真实 Pi TUI 下的 session-file 事实（本格 stub 只写一条 entry）。
- **一个预先存在的 flake（与本格无关，已逐个证据确认，未修）**：`apps/runtime/test/cli-impact.test.ts` 末尾的 `task cancel <p> <t> '2'` 假定 Task 仍是 version 2；调度引擎的 5s 周期恢复 pass（ADR-0033 §4，`schedule-service.ts` 在禁改名单里）有时会在此之前把该 Task 置为 `PAUSED`/version 4，于是 cancel 以 `CONCURRENT_MODIFICATION: Task version did not match` 退出 1。证据：在本工作树上同一测试单独跑 3/3 通过、完整 `check` 第一次绿、第二次红；用**未修改的基线**（`git worktree add --detach /tmp/g1-base HEAD` + `bun install --frozen-lockfile`，OID `8058eb92`）跑 4 次同样在 `cli-impact.test.ts:376` 红 1 次（后来又复现一次）。未修：属调度/影响分析领域，不在本格范围。本格最终一次完整 `bun run check` 退出码 0（日志 `/tmp/ce-g1-check-final2.log`）。
- 未做（明确排除）：`ImpactAssessed`/`ConflictAssessed`、Execution 专名事件、`SessionGuidance*`；未新增确认/门禁/审批，未占 schema 版本（仍 v21，未改 `migration.ts`）。

### 6. 文档与决策

- 新增 `docs/decisions/0035-event-name-and-handoff-faces.md`（ADR-0035）：三条裁决 + 被否掉的选项（重命名代码 / 保留只读别名；补判定类事件 / Execution 专名事件 / Session Guidance；从设计里删掉两个能力字段）+ 后果与未验证清单。
- `docs/decisions/README.md` 表尾追加 ADR-0035 一行。
- `docs/architecture/event-model.md`：§2 目录、§2.2 命名规则、§2.3 已裁决差异表、§5 测试要求。
- `docs/architecture/agent-adapter-api.md`：§1 末尾那段「与实现契约不完全一致」改为**事实一致**，并说明两个维度的声明值与不改变行为。

## Wave H / G1 开发分支集成（H1 → H2 → H4 → H3 → G1）

状态：**五条开发分支已按用户指定顺序合入 `dev`，独立集成检查通过。** 未 push、未提升 `main`、未重启稳定 Runtime。

### 固定提交与合并顺序

| 顺序 | 分支 | lane commit | `dev` 结果 |
|---|---|---|---|
| H1 | `lane/h1-scheduling-ui` | `2db1514` | fast-forward |
| H2 | `lane/h2-snapshot-recheck` | `8ce269e` | merge `ad2573b` |
| H4 | `lane/h4-reclaim-batch` | `0d35b1c` | merge `afadd96` |
| H3 | `lane/h3-failure-retry` | `a0b7254` | merge `4ecc630` |
| G1 | `lane/g1-event-model-alignment` | `975fd15` | merge `c8755d4` |

### 集成处置

- `docs/tasks/README.md` 的冲突均来自各 lane 在同一 `## NEXT` 锚点前追加记录；全部保留并按 H1/H2/H3/H4/G1 内容合并。H1 已占 `FOUNDATION-059`，因此 G1 的任务记录在集成时顺延为 **FOUNDATION-063**；ADR-0035 不变，相关代码注释、测试与架构文档引用同步更新。
- `package.json` 的测试列表按并集合并：同时保留 `cli-snapshot-recheck`、`cli-reclaim-batch` 与 `cli-task-retry`。
- schema 合并后当前版本为 **v24**：v23 先执行 `taskRetryMigration`，v24 再执行 `unregisteredReclamationMigration`；两者都导出。修正 H3 单 lane 测试对「当前版本必须等于 23」的假设，改为断言 v23 列已落地且当前版本不低于 23。
- `packages/contracts` 同时保留 H3 的 `TaskRetryOutcomeView` 与 G1 的七类交接/终端事件 payload schema；CLI 同时导入 H2 的快照拒绝 detail 与 H3 的 retry 结果类型。
- 旧 migration 回归里的版本断言统一指向合并后的当前版本；没有删除历史 migration、没有占用永久空缺的 v16/v22。

### 独立集成验证

- 在合并后的 `dev@c8755d4` 上执行 `CODEESTRA_HOME=/tmp/codeestra-integration-c8755d4 bun run check`：退出码 **0**。
- 根/UI TypeScript、Vitest、Bun 全量测试与 UI 构建均通过；Bun 为 **622 pass / 0 fail（72 文件，4052 assertions）**，Vite 构建成功。
- 检查使用独立 `CODEESTRA_HOME`；结束后该目录不存在，未发现指向该 home 或 dev Runtime 入口的残留进程。稳定 `main` Runtime 未触碰。

### 仍未验证

- H1 的视觉、窄屏、主题与键盘体验仍需用户人工目视确认；自动化验收未获取电脑控制权。
- 真实 Pi/Codex 并发、真实 provider 失败后的 retry、真实 Pi TUI 下新增交接事件与跨平台未注册目录扫描仍未验证；协议 stub 与命令面测试不能替代这些验收。

## FOUNDATION-064 — 开发分支定向测试 / dev 提升前全量测试（ADR-0038）

状态：用户指示已固化为协作规则与 Accepted ADR；仅文档变更。Runtime 的验证/提升证据模型尚未自动实现该分层，不得声称产品已强制执行。

### 已同步

- `AGENTS.md`：所有 task/lane/feature/Self candidate branch/worktree 在创建时按开发方向写下少量具体测试；开发分支禁止 `bun run check`、`just check`、`just verify` 或等价全仓检查；全量测试只在 `dev` 上、准备 `dev → main` 前对精确候选 SHA 运行，候选变化即重跑。
- `PROJECT_SPEC.md` 与 `docs/architecture/repository-structure.md` / `git-workspace-api.md`：区分开发分支定向验证和稳定提升前 dev 全量验证。
- `README.md` / `Justfile`：不再把全量命令描述为普通开发循环或提交前门禁；保留其作为 dev 提升前命令。
- 新增 `docs/decisions/0038-branch-targeted-tests-and-dev-full-suite.md`，并在决策索引及 ADR-0006/0009/0018/0022 标明覆盖关系。

### 当前自动化缺口

- `.codeestra/policies/verification.json` 仍是固定项目级策略并执行 `bun run check`，无法表达“建分支时按开发方向挑选测试”；本轮没有用另一个固定宽命令伪装成定向计划，也没有静默改写人工策略。
- 当前 promotion 只消费 IntegrationBatch 的验证记录，没有单独的“精确 dev SHA 全量测试”证据。后续需要为 Task/branch 增加定向测试计划与结果绑定，并让 promotion 消费独立 dev 全量证据。
- 已经存在且未合入最新 `dev` 的分支不会自动得到新 `AGENTS.md`；合并/rebase 到包含 ADR-0038 的 dev 基线后才会在文件层面看到该规则。未获授权不逐分支强推或改写历史。

### 本次验证

- 未运行全量测试：本次仅改文档，且 ADR-0038 明确全量测试只在固定 dev 候选准备提升到 main 时执行。
- 仅执行文档关键词、链接、diff 与 Git 状态检查；结果以本次交付说明为准。

## FOUNDATION-065 — 分层验证证据：定向测试计划 + 精确 dev SHA 全量测试（ADR-0038 落地 / ADR-0039 / schema v25）

状态：**在 lane 分支上实现并定向验证通过。** 基线 `dev = fd3d99871a40e578105036bc6728213adf302c6a`（lane 分支 `lane/i1-verification-evidence`，未 rebase/merge/pull/push，未提升 `main`，未重启稳定 Runtime）。本格关闭 ADR-0038 D04 记录的自动化缺口：该 ADR 的分层现在由命令面自动执行。

### 决策（协调者已逐题裁决，全部按答复实现）

- 定向测试计划载体：仓库跟踪文件 `.codeestra/tests.json` **从被测 commit 读取**并快照成 append-only 记录（不采用「只存 DB」或「塞进 TaskRevision」）。
- dev 全量证据生产者：**Runtime** 在精确 dev SHA 的 detached 副本上运行并观察（**不采信客户端自报**）。
- 全量命令来源与绑定：命令来自项目 `main` ref 的固定策略；证据绑 `dev SHA + 该策略 digest + 候选 commit 处锁文件 digest`。
- 不修改本仓 `.codeestra/policies/verification.json`；UI 不在本格范围（未动 `apps/ui/**`）；占用 schema **v25**；新增稳定码 `DEV_FULL_SUITE_EVIDENCE_MISSING` / `..._NOT_PASSED` / `..._STALE`（均 exit 1），沿用既有 STALE 与批准失效语义；Task verification 默认 `AUTO` 并提供 `--policy auto|targeted|project`。

### 修改清单

- 新增 `packages/contracts/src/targeted-test-plan.ts`：`.codeestra/tests.json` 的 schema（`version`/`scope`/1–16 条带必填 `covers` 的 argv 命令）、路径与语义版本常量、`parseTargetedTestPlan` / `targetedTestPlanDigest` / `targetedTestPlanLabel` / `targetedTestPlanCommands`，以及锁文件路径常量。
- 新增 `packages/domain/src/verification-evidence.ts`（纯领域，无 Bun/DB/Git）：`selectTargetedTestPlan`（精确 subject 匹配 / 未记录 / revision 不合 / commit 不合）、`planTargetedTestPlanReplacement`（幂等重放 + 显式 CAS）、`judgeDevFullSuiteEvidence`（缺证据 / 最新非通过 / 三项绑定逐字段失效）。
- `packages/storage/src/migration.ts`：新增 `verificationLayeringMigration`（v25）——`targeted_test_plans`（append-only：唯一 `(project,task,revision,commit,digest)` 索引 + 拒绝 UPDATE/DELETE 的触发器）、`dev_full_suite_evidence`（每次运行一行，终态必须带 `ended_at`/`outcome_code`，`UNIQUE(project_id,command_id)`）、`verification_runs` 四个新列（`policy_source`/`plan_id`/`plan_version`/`plan_digest`）、`stable_promotions` 六个新列（三项绑定 + evidence id + 批准 evidence id）。`phase1SchemaVersion` → 25，runner 追加 `if (version < 25)`，未插入更早号段。
- `packages/storage/src/database.ts` / `index.ts`：`VerificationRunSummary` 增加来源字段；新增 `recordTargetedTestPlan` / `getLatestTargetedTestPlan` / `listTargetedTestPlans`、`getDevFullSuiteCandidates` / `beginDevFullSuiteRun` / `completeDevFullSuiteRun` / `reconcileDevFullSuiteEvidence` / `get·list·listForCommit(devFullSuiteEvidence)`；`beginStablePromotion` 固定全 suite 证据三元组，`approveStablePromotion` 记录 `approved_full_suite_evidence_id`，`startStablePromotion` 的 STRICT 检查逐字段核对 evidence id。
- `apps/runtime/src/verification-service.ts`：新增 `recordTargetedTestPlan` / `listTargetedTestPlanViews` / `latestTargetedTestPlanView`；`queueTaskVerification` 按 `policySource` 选择命令集并如实写入来源与 digest；响应带 `policySource`/`planId`/`planVersion`/`planDigest`（label 按来源生成）。
- 新增 `apps/runtime/src/promotion-evidence-service.ts`：`runDevFullSuite`（读 `main` ref 策略 + 候选锁文件、校验 `dev` ref、精确 SHA detached 副本内跑、记录观察结果）、`listFullSuiteEvidence`、`readDevFullSuiteBindings`、`checkDevFullSuiteEvidence`。
- `apps/runtime/src/promotion-service.ts`：`prepare` 要求全 suite 证据并固定三元组；`promote` 在**任何 ref 移动之前**重检三项绑定（不符即拒绝、标 `STALE`、不推进 ref）。
- `apps/runtime/src/main.ts`：新命令 `task.tests.record|show|history`、`promotion.fullSuite.run|list`，`task.verify` 透传 `policySource`，启动时 `reconcileDevFullSuiteEvidence` 把上个 Runtime 遗留的 `RUNNING` 收口为 `ERROR/RUNTIME_RESTARTED`。
- `apps/runtime/src/operation-service.ts`：`startVerification` 透传 `policySource`，`#report` 补全来源字段与按来源生成的 label。
- `packages/contracts/src/index.ts`：四个新命令 schema + `task.verify.policySource`。
- `apps/cli/src/main.ts`：`task tests record|show|history`、`task verify --policy auto|targeted|project`、`promotion full-suite run --dev-commit <full-sha>` / `list`，以及帮助文本与 ADR-0038 分层说明。
- 测试：新增 `packages/domain/test/verification-evidence.test.ts`、`packages/storage/test/verification-layering.test.ts`、`apps/runtime/test/cli-targeted-tests.test.ts`；扩展 `apps/runtime/test/promotion-service.test.ts`（+5 条）与 `apps/runtime/test/cli-promotion.test.ts`（+2 条）；`package.json` 的 `test:unit` 忽略列表与 `test:e2e` 列表登记新 e2e 文件（并集）。
- flake 修复：`apps/runtime/test/cli-impact.test.ts`、`apps/runtime/test/terminal-service.test.ts`、`apps/runtime/test/runtime-lifecycle.test.ts`（见下）。
- 共享 fixture：`apps/runtime/test/support/agent-fixture.ts` 与 `apps/runtime/test/cli-promotion.test.ts` 的临时仓库补上锁文件（后者用 `file:` 依赖离线生成真实 `bun.lock` + `.gitignore`，因为提升后置步骤会真的执行 `bun install --frozen-lockfile`）。
- 既有迁移断言去冻结：`revision-delivery.test.ts`、`verification-cancel.test.ts`（2 处）、`cli-reclaim-batch.test.ts`、`packages/storage/test/impact-analysis.test.ts` 的 `phase1SchemaVersion == 24` 改为 `>= 24`；`packages/storage/test/task-dependencies.test.ts` 的「已盖 14 的库」补执行 v13/v14 迁移（真实 v14 库本就有这两张表，否则 v25 的 `ALTER TABLE stable_promotions` 无表可改）。
- 文档：新增 `docs/decisions/0039-layered-verification-evidence.md`；`docs/decisions/README.md` 追加 ADR-0039 索引行并修订 ADR-0022/0038 与阶段表的相关行；`docs/decisions/0038-...md` 的 D04 加 **Amended by ADR-0039** 说明（保留历史文字）；`PROJECT_SPEC.md` §3 该段更新为「已由 ADR-0039 实现」。

### 实际运行的检查与结果

基线提示：按 ADR-0038，本 lane 分支**未运行** `bun run check` / `bun run check:fast` / `just check` / `just verify`，全量测试只在 `dev` 候选提升前运行。

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 退出码 0 |
| `bun test packages/domain/test/verification-evidence.test.ts` | 18 pass / 0 fail |
| `bun test packages/storage/test/verification-layering.test.ts` | 12 pass / 0 fail |
| `bun test apps/runtime/test/cli-targeted-tests.test.ts` | 2 pass / 0 fail |
| `bun test apps/runtime/test/promotion-service.test.ts` | 26 pass / 0 fail |
| `bun test apps/runtime/test/cli-promotion.test.ts` | 6 pass / 0 fail |
| `bun test packages/contracts/test packages/domain/test packages/storage/test` | 455 pass / 0 fail（18 文件） |
| `bun test apps/runtime/test/verification-service.test.ts apps/runtime/test/verification-cancel.test.ts apps/runtime/test/revision-delivery.test.ts apps/runtime/test/operation-service.test.ts` | 全绿（24 + 5 + 29 合并运行；均 0 fail） |
| `bun test apps/runtime/test/http-api.test.ts` | 6 pass / 0 fail |
| `bun test apps/runtime/test/cli-reclaim-batch.test.ts` | 12 pass / 0 fail |
| flake 1 `bun test apps/runtime/test/terminal-service.test.ts` ×5 | 5 次均 7 pass / 0 fail（15.12s / 14.61s / 14.67s / 14.76s / 15.38s） |
| flake 2 `bun test apps/runtime/test/runtime-lifecycle.test.ts` ×5 | 5 次均 10 pass / 0 fail（10.41s / 10.72s / 9.94s / 9.41s / 9.11s） |
| flake 3 `bun test apps/runtime/test/cli-impact.test.ts` ×5 | 5 次均 1 pass / 0 fail（4.51s / 4.75s / 4.55s / 4.57s / 4.78s） |

### 三个 flake 的处置（证据：每处连续 5 次全绿）

- `apps/runtime/test/cli-impact.test.ts:~376`：`task cancel <p> <t> '2'` 把 Task version 当常量。改为新增 `cancelWithCurrentVersion()`：从 `task status` 读真实 version，若仍遇 `CONCURRENT_MODIFICATION`（调度恢复 pass 的合法并发）则有界重读重试（≤5 次，间隔 250ms），断言「任务最终被取消」这个命令面承诺的结果，而不是断言调度器不并发。
- `apps/runtime/test/terminal-service.test.ts`：release 断言建立在两个时序假设上。(a) 只等 TUI banner 就发 Ctrl+D——banner 在 `stty raw` **之前**打印，满载时 release 字节可能被行规程当成 EOF，于是「provider 追加了一条 entry」等断言假红；现在 fake provider 在 `stty raw` 之后打印 `raw-mode=ready`，所有 release 相关用例先 `waitForRawMode()`。(b) 归属检查比对的是「provider 存活期间捕获的进程树」，启动竞态可能没记录到，release 会（正确地）以 `PREDECESSOR_UNVERIFIED` 拒绝；`startHarness` 增加有界等待，等 Runtime 自己的定时刷新把进程树记下来。
- `apps/runtime/test/runtime-lifecycle.test.ts:207`：`expect(rawStdout.trim()).toBe('raw 0')` 把「内联脚本自测耗时 0ms」当不变量，满载时得到 `'raw 1'`。改为断言事实：输出以 `raw` 开头且脚本内自测耗时 `< 1000ms`（即没有等那个 3s 定时器），外层「进程确实活满 grace」断言不变。

### 未验证 / 已知缺口

- **与 ADR-0038 D03 字面措辞的差异（需协调者知晓）**：D03 写「在 `dev` 工作树对精确候选 SHA 运行一次全量测试」，本实现改为在**该精确 SHA 的 detached 副本**（复用 ADR-0006/0027 的验证副本机制）中运行。实质要件（精确 SHA、固定策略、绑定候选/策略/锁文件）都满足，且不依赖 `dev` 是否被检出、不触碰用户工作树、运行不污染任何工作目录；但「在 dev 工作树内运行」这一字面要求未实现，已在该 ADR 的 Consequences 与本记录中如实标注。
- 锁文件绑定在同一不可变 SHA 上按构造不会漂移：它保证证据自我描述并在证据行与 Git 事实不符时拒绝提升；同一候选上真正会漂移的是位于 `main` ref 的策略 digest（已在 e2e 中验证该路径）。ADR-0039 明确记录了这一点，不夸大锁文件绑定的作用。
- 无 `promotion.full-suite run --background` / Operation 进度 / 取消：本格运行是同步命令（长命令期间只有 socket keepalive），`CANCELLED` 状态因此**没有**写进表的 CHECK，也不声称可取消；遗留的 `RUNNING` 行由启动 reconcile 收口为 `ERROR/RUNTIME_RESTARTED`。
- 未做（明确排除）：UI 投影（未动 `apps/ui/**`）；未改本仓 `.codeestra/policies/verification.json`；未改 `packages/agent-adapters/**`、`packages/git/**`、`schedule-service.ts`、`slot-reservation-service.ts`；未新增任何确认/门禁/审批（FULL 仍 0 步）；未 push、未提升 `main`、未重启稳定 Runtime；未触碰 `/Users/loyage/Documents/codeestra`。
- 已知残余 flake 风险（不在本格领地）：`pi-process.ts` 的 `captureProviderProcessTree` 可能把转瞬即逝的子进程（provider 的 `stty`）记为 `startToken: null`；该 PID 之后被复用时 `inspectProviderProcessOwnership` 会保守地返回 `UNVERIFIABLE`，release 于是拒绝。这是 `packages/agent-adapters` 的设计保守性而非测试时序假设，本格未改该包；测试已通过等待「已进入 raw mode」与「已记录进程树」两个事实把可确定的部分消除，5/5 全绿。
- 未运行：全仓 `bun run check`（ADR-0038 禁止在开发分支运行；本格只跑 typecheck 与上述定向文件）、真实 Pi/Codex provider 的任何验收、真实 `main` 提升与稳定 Runtime 重启。
- `AGENTS.md` 未改动：其「开发分支只跑定向测试」的既有措辞与本实现一致（定向计划现在由 `task tests record` 记录），为避免与其他 lane 的文档改动冲突本格未改人工规范文件。

### 领地声明

独占改动：`packages/domain/src/verification-evidence.ts`、`packages/domain/test/verification-evidence.test.ts`、`packages/contracts/src/targeted-test-plan.ts`、`packages/storage/test/verification-layering.test.ts`、`apps/runtime/src/promotion-evidence-service.ts`、`apps/runtime/src/verification-service.ts`、`apps/runtime/src/promotion-service.ts`、`apps/runtime/test/cli-targeted-tests.test.ts`。

纯追加/小改：`packages/storage/src/migration.ts`（v25 号段）、`packages/storage/src/database.ts`、`packages/storage/src/index.ts`、`packages/contracts/src/index.ts`、`apps/runtime/src/main.ts`、`apps/runtime/src/operation-service.ts`、`apps/cli/src/main.ts`、`package.json`（测试列表）、`packages/domain/src/index.ts`、`docs/**`。

为保持既有测试为绿的必要最小改动：`apps/runtime/test/{cli-impact,terminal-service,runtime-lifecycle,promotion-service,cli-promotion,revision-delivery,verification-cancel,cli-reclaim-batch}.test.ts`、`apps/runtime/test/support/agent-fixture.ts`、`packages/storage/test/{impact-analysis,task-dependencies}.test.ts`。未改 `.codeestra/policies/verification.json`、`apps/ui/**`、`packages/agent-adapters/**`、`packages/git/**`、`schedule-service.ts`、`slot-reservation-service.ts`。
## FOUNDATION-066 — 第三个真实 Adapter：Claude Code（ADR-0040，无 schema 变更）

状态：**完成（协议层交付 + 定向测试通过）**。基线 `dev = fd3d99871a40e578105036bc6728213adf302c6a`；lane 分支 `lane/i2-claude-code-adapter`；未 push、未提升 `main`、未触碰稳定工作树 `/Users/loyage/Documents/codeestra`。

**本格最重要的前提**：本机 `claude 2.1.268` **没有可用凭据**（`claude auth status` → `{"loggedIn":false,"authMethod":"none"}`，env 无 `ANTHROPIC_API_KEY`，无 `~/.claude/.credentials.json`），因此**没有任何一次真实模型调用**。所有实测证据到"发出真实模型请求之前"为止；凡需要模型产生的行为一律 `REQUIRES_VALIDATION`，不写成 `SUPPORTED`。真实模型验收是需要凭据与用户在场的独立后续项。

### 1. 交付内容

- **真实受控 spike**：`docs/spikes/claude-2.1.268.md`。逐项记录实测事实与未验证项：传输与 framing、`initialize` 往返与字段全集、`system/init`、终态 `result` 帧（含**鉴权失败以 `subtype:"success"` + `is_error:true` 到达**这一关键形状）、argv 接受性（STRICT/FULL 两套）、受控启动对比（`--safe-mode` / `--setting-sources ''` / `--restricted` / `--bare` 的实测差异与 `--bare` 被排除的理由）、transcript 派生规则（3 例）、`CLAUDE_CONFIG_DIR` 重定位、`--resume` 会话加载、permission mode 语义（含"`manual` = provider `default`，不是逐工具审批"）、以及来自 CLI 自带协议文档与它自己的 SDK 客户端代码的 control 协议形状。
- **Adapter 实现**：`packages/agent-adapters/src/claude-protocol.ts`（framing、argv、权限策略、帧解析、答案编码、facts、transcript 归属校验）、`src/claude-process.ts`（一个子进程的 stdio、控制请求路由、`withDeadline` 清理 timer 的停止流程）、`src/claude-adapter.ts`（`AgentAnswerAdapter` + `AgentProcessRelease`，`adapterId = "claude"`）。能力矩阵**全部 12 个字段**如实声明（`persistentSession`/`controlledConfiguration: SUPPORTED`；`nativePermissionRouting`/`structuredAttention`/`cooperativeStop`/`resumeAfterExit: REQUIRES_VALIDATION`；其余 `UNSUPPORTED`）。
- **Runtime registry 接线**：`apps/runtime/src/adapter-registry.ts` 注册 `ClaudeAdapter`（`CODEESTRA_CLAUDE_EXECUTABLE`、config home 取 `CLAUDE_CONFIG_DIR`/`~/.claude`）；`packages/agent-adapters/src/index.ts` 导出新模块；CLI usage 的 `--adapter` 列表加入 `claude`（`apps/cli/src/main.ts`）。
- **ADR-0012 配置解析与留痕**：`packages/contracts/src/index.ts` 增加 `claude` 作用域（`CODEESTRA_CLAUDE_MODEL`/`CODEESTRA_CLAUDE_THINKING`，**不含 provider**）；`apps/runtime/src/agent-config-service.ts` 新增 `agentConfigurationUnsupportedFields`，解析路径对不支持的字段报 `INVALID_AGENT_CONFIGURATION`；`apps/runtime/src/main.ts` 的 `agent.config.set` 在**写入前**拒绝并报同一码。`model` → `--model`，`thinkingLevel` → `--effort`（`off`/`minimal` 在 Adapter 边界以 `UNSUPPORTED_AGENT_CONFIGURATION` 明确拒绝，不静默降级），`provider` 在该 scope 拒收（first-party Claude Code 无 provider 启动参数）。
- **ADR**：`docs/decisions/0040-claude-code-adapter-transport-and-capabilities.md` + `docs/decisions/README.md` 索引行。
- **定向测试**：`packages/agent-adapters/test/claude-adapter.test.ts`（29 项）、`apps/runtime/test/cli-claude-adapter.test.ts`（5 项，真实 CLI + Runtime + 临时 `CODEESTRA_HOME`/仓库 + 协议 stub provider），并按 ADR-0038 登记进 `package.json` 的 `test:e2e` 列表与 `test:unit` 忽略列表（`cli-claude-adapter`）。

### 2. 实测与验证（实际运行的命令与逐条结果）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `bun run typecheck` | 0 | `tsc --noEmit` 无输出（含新增 3 个源文件、2 个测试文件与 contracts/runtime 改动） |
| `bun test packages/agent-adapters/test/claude-adapter.test.ts` | 0 | 29 pass / 0 fail，72 expect() 调用 |
| `bun test apps/runtime/test/cli-claude-adapter.test.ts` | 0 | 5 pass / 0 fail，67 expect() 调用 |
| `bun test apps/runtime/test/adapter-registry.test.ts apps/runtime/test/slot-reservation-service.test.ts apps/runtime/test/agent-config-service.test.ts` | 0 | 27 pass / 0 fail（含按新事实更新的断言） |
| `bun test apps/runtime/test/cli-capacity-slots.test.ts` | 0 | 6 pass / 0 fail |
| `bun test apps/runtime/test/cli-agent-config.test.ts` | 0 | 4 pass / 0 fail |

按 ADR-0038，**未运行** `bun run check` / `check:fast` / `just check` / `just verify`（开发分支禁止全量/聚合测试）。

spike 的真实 CLI 观测（脚本与原始输出在 `/tmp/ce-i2-spike/`，不入库）：

- 无 user turn 的本地探针（不发模型请求）：Adapter 实际使用的 **STRICT 与 FULL 两套 argv** 被真实 CLI 接受，`initialize` 往返成功并回读 `current_permission_mode`（`manual`→`default`、`bypassPermissions`→`bypassPermissions`），退出码 0。
- 3 次**无凭据** `--print` 尝试（协调者授权范围内）：每次都因 `account.tokenSource:"none"` 停在鉴权失败，`total_cost_usd: 0`、退出码 1，**未发出真实模型请求**；实测到鉴权失败帧形状、transcript 确实写在派生路径、`--resume <id>` 加载记录会话并保留同一 session id、`bypassPermissions` 不需要 danger flag 即生效。
- `--safe-mode` 抑制用户 `SessionStart` hook 与用户 agent（`initialize` 响应 agents 列表对比）；`--bare` 因禁用 OAuth/keychain 被排除。

测试卫生：新 e2e 测试使用 `apps/runtime/test/support/runtime-reclamation.ts`，每个用例内含 `codeestra stop`，teardown 走 `reclaimTestResources()`；跑完核对无 `claude-stub` 残留进程、无 `codeestra-claude-*` 残留夹具目录（本格未杀任何不属于本格的进程，未触碰 `~/Documents/codeestra` 的稳定 Runtime 与 `~/Documents/codeestra-dev` 的运行实例）。

### 3. 按新事实更新的既有断言（逐处）

三处断言的前提是"`claude` 未注册"，注册后必须改，改动限于探针 id，不改变测试意图：

1. `apps/runtime/test/adapter-registry.test.ts`：`expect(registry.ids()).toEqual(['pi','codex'])` → `['pi','codex','claude']`；未知 id 探针 `resolve('claude-code')` 保留（provider 产品名不是 adapter id），并从"`claude` 未注册"的隐含前提改为显式注释该理由。
2. `apps/runtime/test/slot-reservation-service.test.ts`：注入的 `knownAdapterIds: ['pi']` 下探测未知 adapter 的 id 由 `'claude'` 改为 `'claude-code'`（该用例断言的是"服务遵守注入的已知集合"，换成一个仍然未知的 id 才能保持原意）。
3. `apps/runtime/test/cli-capacity-slots.test.ts`：`scheduler capacity set --adapter claude` 期望 `UNKNOWN_ADAPTER` 的探针改为 `--adapter claude-code`。

### 4. 未验证与已知缺口

- **模型层全部未验证**（无凭据）：`can_use_tool` 的真实 fail-closed 往返、interrupt 后已在运行的工具是否停止、结构化提问（`AskUserQuestion`）的真实投递路径与答案编码、`--resume` 是否真的复述同一 conversation 内容、多工具批次、`set_permission_mode`、`--include-partial-messages`/`--include-hook-events`、Windows、CLI 版本升级后的协议兼容。因此对应能力报 `REQUIRES_VALIDATION`。
- **结构化提问本轮按工具级审批诚实降级**：所有 `can_use_tool`（含 `AskUserQuestion`）一律映射为既有 `PERMISSION`/`CONFIRM` Attention，不实现问卷编码；已知风险：用户批准 `AskUserQuestion` 后 provider 是否会在无人渲染的 dialog 上等待**未验证**（用户可取消/停止任务）。
- **`session.transcript` 仍是 Pi 专属**：Claude Session 上会以 `SESSION_FILE_NOT_OWNED` 明确失败，而不是显示执行过程；把它做成 provider-agnostic 需另立一格（本格未改 `apps/runtime/src/session-transcript-service.ts`）。
- **stub 只能证明编排**：`cli-claude-adapter.test.ts` 的 provider 是协议 stub，不是真实 Agent 集成验收。
- **既有的注册缺口（本格未改，如实记录）**：`apps/runtime/test/cli-codex-adapter.test.ts` 既不在 `test:e2e` 列表、也不在 `test:unit` 忽略列表中（ADR-0029 的 D2 格遗留），因此它当前运行在 `test:unit` 里；本格只登记自己的 e2e 文件，未顺带改动无关列表。
- **架构文档 doc-sync 仍未做**：`docs/architecture/agent-adapter-api.md` 的 `AdapterCapabilities` 清单仍写 9 项（沿用 ADR-0019/0027/0029 的先例，本格不改架构文档，已在 ADR-0040 显式记录）。

### 5. 领地

独占：`packages/agent-adapters/src/claude-*.ts`、`packages/agent-adapters/test/claude-adapter.test.ts`、`apps/runtime/src/adapter-registry.ts`、`apps/runtime/test/cli-claude-adapter.test.ts`、`docs/spikes/claude-2.1.268.md`。纯追加：`packages/contracts/src/index.ts`、`apps/runtime/src/agent-config-service.ts`、`apps/runtime/src/main.ts`、`apps/cli/src/main.ts`、`package.json`（测试列表）、`docs/**`。未改：`apps/ui/**`、`schedule-service.ts`、`verification-service.ts`、`promotion-service.ts`、`packages/git/**`、`migration.ts`（不占迁移号），也未改 Pi/Codex 的既有行为与能力声明。

## FOUNDATION-067 — Project Knowledge 第一小步：分层加载、Execution 绑定与 CLI 命令面（ADR-0041，schema v26）

状态：**已实现并已提交到 lane 分支 `lane/i3-project-knowledge`（未 push、未提升 main、未重启稳定 Runtime）**。基线固定 `dev@fd3d99871a40e578105036bc6728213adf302c6a`（`phase1SchemaVersion = 24`），未 rebase、未合并新 dev、未触碰 `/Users/loyage/Documents/codeestra`（main 稳定工作树）。语义未定的部分**全部先问协调者再动手**：三轮共 13 题（8 + 4 + 1），所有裁决见 ADR-0041。

### 本格解决什么

实现 `docs/roadmap/mvp.md` Phase 6 的第一小步。开工前的已核实缺口：仓库里**没有任何知识加载路径**（`packages/agent-adapters` 不消费 `AgentStartRequest.knowledgeSnapshotRefs`，`agent-start-service.ts` 与 `agent-runtime-service.ts` 都硬编码 `[]`），`.codeestra/` 下只有 `policies/verification.json`。

交付：知识分层与来源、人工层只从项目 `main` ref 加载、每个 Execution 绑定它**实际使用**的知识快照（digest + 来源 + revision/commit）、append-only 审计、机器生成只能写 Runtime 数据目录且写人工路径 fail-closed、`project knowledge validate|list|show|resolve` 命令面、Git 跟踪策略落为代码常量 + 文档事实。

### 修改清单

**新增（本格独占领地）**

| 文件 | 内容 |
|---|---|
| `packages/domain/src/knowledge.ts` | 纯领域：层常量与层序、窄 front-matter（顶层标量 `id`/`scope`，手写、无新依赖）、路径与层归属校验、条目解析与拒绝码、层序排序与重复 id/路径 fail-closed、`scope` 复用 `Task.kind`、逐条/分层/整体 digest、确定性上下文渲染、`knowledgeSnapshotRefs` |
| `packages/domain/test/knowledge.test.ts` | 23 项纯领域测试 |
| `apps/runtime/src/knowledge-service.ts` | Runtime 侧：从 `main` ref 列目录并读 blob（`ls-tree -r -z` + `cat-file blob`，`TextDecoder({fatal:true})`）、读 Runtime 生成层并校验 provenance、inspection/validate/list/show/resolve 报告、`assertMachineGeneratedWriteTarget`、`writeRuntimeKnowledgeFile`、`prepareExecutionKnowledge`、`knowledgeSnapshotId` |
| `packages/storage/test/knowledge.test.ts` | 13 项真实 SQLite 测试 |
| `apps/runtime/test/cli-knowledge.test.ts` | 5 项真实 CLI + Runtime + 临时 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider 的端到端测试 |
| `docs/decisions/0041-project-knowledge-layers-and-execution-binding.md` | ADR（D01–D10 + 后果 + 验证要求） |
| `docs/architecture/knowledge.md` | 知识层架构文档 |

**纯追加/机械修改（既有文件）**

| 文件 | 改了什么 |
|---|---|
| `packages/storage/src/migration.ts` | `phase1SchemaVersion` 24 → **26**；追加 `knowledgeLayerMigration`（两张 append-only 表 + 三个索引 + 四个触发器）。只追加 `if (version < 26)`，**没有插入任何更早号段**（v25 属并行 lane，v16 永久未使用） |
| `packages/storage/src/database.ts` | `migrate()` 追加 `if (version < 26)`；新增类型 `KnowledgeSnapshotInput/Record/Key`、`ExecutionKnowledgeSnapshotInput/Record`、`StoredKnowledgeEntry(Origin)`、`KnowledgeLayerName/KnowledgeScopeName`；新增方法 `recordKnowledgeSnapshot`/`findKnowledgeSnapshot`/`getKnowledgeSnapshot`/`listKnowledgeSnapshots`/`recordExecutionKnowledgeSnapshot`/`getExecutionKnowledgeSnapshot`/`listExecutionKnowledgeSnapshots`；`reserveExecution` 新增**可选** `knowledgeBinding` 并在同一事务内插入绑定行 |
| `packages/storage/src/index.ts` | 追加类型导出与 `knowledgeLayerMigration` |
| `packages/contracts/src/index.ts` | 追加 `project.knowledge.validate|list|show|resolve` 四个 request schema |
| `apps/runtime/src/main.ts` | 追加四个 command 分支（只读观察） |
| `apps/runtime/src/agent-runtime-service.ts` | **最小追加**：`#startPreparedExecution` 在 `reserveExecution` **之前**调用 `prepareExecutionKnowledge`（任务不存在时 `TASK_NOT_FOUND`）、把 `knowledge.binding` 传进保留事务、把 `knowledge.refs` 传给 `startReservedExecution`；successor 路径（原 `knowledgeSnapshotRefs: []`）改为读回该 Execution 已记录的 refs。**未改任何既有分支语义** |
| `apps/runtime/src/agent-start-service.ts` | **最小追加**：`startReservedExecution` 新增可选 `knowledgeSnapshotRefs`，`adapter.start` 处由硬编码 `[]` 改为 `input.knowledgeSnapshotRefs ?? []` |
| `apps/cli/src/main.ts` | 追加 `project knowledge validate|list|show|validate` 子命令分支、`--json` 视图类型、人类可读打印、usage 与 `project knowledge` 说明段 |
| `packages/domain/src/index.ts` | 追加一行 `export * from './knowledge.js';` |
| `.gitignore` | 追加 `.codeestra/generated/` 守卫规则（并注明它**不是**机器生成层的存放位置） |
| `PROJECT_SPEC.md` | §4 **显式规格修订**（见下「规格修订」） |
| `docs/architecture/README.md` | 导航追加 `knowledge.md` 一行 |
| `docs/architecture/sqlite-schema.md` | 状态行 21 → 26；第 8 节追加 v26 DDL 记录，并如实写明 v23/v24 的逐版本 DDL 记录尚未补齐（文档同步滞后） |
| `docs/decisions/README.md` | 追加 ADR-0041 索引行 |
| `package.json` | `cli-knowledge` 加入 `test:unit` 忽略列表与 `test:e2e` 列表 |
| `packages/storage/test/impact-analysis.test.ts`、`apps/runtime/test/revision-delivery.test.ts`、`apps/runtime/test/verification-cancel.test.ts`（2 处）、`apps/runtime/test/cli-reclaim-batch.test.ts` | 机械修正：`expect(phase1SchemaVersion).toBe(24)` → `toBeGreaterThanOrEqual(24)`（本格把常量推到 26 的必然影响；断言本意即「升级到达当前版本」，不是「本格是最后一步」） |

### 关键裁决（用户拍板，共 13 题）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | 格式与目录语义 | Markdown + 窄 YAML front-matter（`id`/`scope`），手写解析器**不加依赖**；`policies/*.json` 仍由既有机制独占 |
| 2 | 优先级与冲突 | **无覆盖语义**：全部可解析人工条目进快照、不丢弃；重复 id/路径 fail-closed；**不做任务级覆盖** |
| 3 | 「加载」落到哪一步 | 解析 + 快照绑定 + 审计 + CLI + 物化 + 填 `knowledgeSnapshotRefs`；**不改 agent-adapters**，provider 侧消费如实标注未验证 |
| 4 | 加载失败语义 | 人工层非法/超限/非 UTF-8 → **拒绝建立 Execution**（Execution 不落库）；`generated/` 缺失或为空属正常 |
| 5 | 写入者与元数据 | 只有 Runtime 可写；`<entry>.meta.json` 记 provenance；digest 粒度 = 每文件 + 整体 |
| 6 | Git 跟踪 | 机器生成不进 Git；人工层必进 Git；`.gitignore` 加守卫规则并落为代码常量 + 文档 |
| 7 | schema | v26 新建 `knowledge_snapshots` + `execution_knowledge_snapshots`，**不重建 `executions`**；断言用常量或 `>= 26` |
| 8 | 命令面 | `project knowledge list|show|validate` + `resolve <project> <task>`，`--json`、退出码 0/1/2、`project` 分组 |
| 9 | `scope` 取值 | `ALL`(缺省) / `DEVELOPMENT` / `SELF`，复用既有 `tasks.kind` |
| 10 | `generated/` 读位置 | Runtime 数据目录 `<CODEESTRA_HOME>/knowledge/<project-id>/generated/` |
| 11 | 领地 | 允许对 `agent-runtime-service.ts` / `agent-start-service.ts` 做**最小追加式**修改并逐处列出 |
| 12 | 是否需要机器写命令 | **不新增**；写入者是 Runtime，不是用户 |
| 13 | worktree 写入（见下） | 机器生成知识**读写都在 Runtime 数据目录，项目树里一个字节都不写** |

### 本格发现并修复的真实回归（协调者要求作为证据保留）

**现象**：把物化出的 `knowledge-context.md` 写进 Task worktree 的 `.codeestra/generated/` 后，`apps/runtime/test/cli-task-retry.test.ts` 的用例「a retry queues behind capacity instead of jumping the queue」失败：本应退出码 **3（容量等待）**，实际变成冲突拒绝。

**impact 报告原文（实测输出）**：

```
verdict CONFLICTING (SAME_FILE)
[CONFLICT] SAME_FILE against 99cf287d-2506-46d2-94d2-9153ae6d32d7 (SAME_FILE): 1 file(s) changed by both — paths .codeestra/generated/knowledge-context.md
```

**实测到的原因（不是推测）**：`packages/git/src/result-commit.ts` 的 change set 由 `git diff --name-status <base>` **加** `git ls-files --others --exclude-standard` 组成（该文件第 193–211 行），而 `stageResultChangeSet` 用 `git add --all`（第 251 行）。未 ignore 的未跟踪文件因此同时（a）进入每个 Task 的 change set，使任意两个并发 Task 都命中同一个路径被判 `SAME_FILE`/`CONFLICTING`，（b）会被成果 commit 提交并随 IntegrationBatch 进入 `dev`——违反「机器生成不得进提交」。本仓库的 `.gitignore` 只对本仓库生效，用户项目没有这条规则，所以这是产品缺陷而非夹具缺规则。

**修复**：按协调者裁决把物化上下文写到 `<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md`，**worktree 里一个字节都不写**；Runtime 从不写用户仓库的 Git 元数据（不做 `.git/info/exclude` —— 实测其为 common dir 作用域），也不改 impact 分析器与成果提交。新增定向测试「two concurrent Tasks never conflict because of machine-generated knowledge」：两个 Task 并发运行后，各自 worktree 的 `git status --porcelain -uall` 精确等于 `?? src/agent/<task-id>.ts`，`.codeestra/generated` 不存在，`project impact explain` 的 candidate files 只含 Agent 产物且 reasonCodes 不含 `SAME_FILE`。

**规格修订（必须显式，不得静默重新解释）**：`PROJECT_SPEC.md` §4 原先只写「`.codeestra/generated/` 机器生成」并把 Git 跟踪策略留作待明确。本格修订为：人工层在项目 `.codeestra/{instructions,skills}`（`policies/` 由既有 JSON 机制独占）；机器生成层的**读与写都在 Runtime 数据目录**；`.gitignore` 的 `.codeestra/generated/` 只是守卫规则、**不是**存放位置。修订文字已写进 `PROJECT_SPEC.md` §4 与 ADR-0041 D05。

### 实际运行的检查与逐条结果

全部命令在 `/Users/loyage/Documents/codeestra-wt/i3-project-knowledge` 下执行。**未运行** `bun run check`、`bun run check:fast`、`just check`、`just verify`（ADR-0038）。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `bun run typecheck` | 0 | 无错误 |
| `bun test packages/domain/test packages/storage/test` | 0 | **420 pass / 0 fail**，1264 expect，14 文件（含本格新增 23 + 13） |
| `bun test apps/runtime/test/cli-knowledge.test.ts` | 0 | **5 pass / 0 fail**，101 expect |
| `bun test apps/runtime/test/revision-delivery.test.ts apps/runtime/test/verification-cancel.test.ts apps/runtime/test/cli-reclaim-batch.test.ts apps/runtime/test/cli-reclaim.test.ts` | 0 | **42 pass / 0 fail**，396 expect（本格改了其中 4 处版本断言，故重跑） |
| `bun test apps/runtime/test/agent-runtime-service.test.ts apps/runtime/test/agent-observation-service.test.ts apps/runtime/test/workspace-service.test.ts` | 0 | **35 pass / 0 fail**，173 expect（ExecutionContext 建立路径受本格改动影响） |
| `bun test apps/runtime/test/cli-schedule.test.ts apps/runtime/test/schedule-service.test.ts apps/runtime/test/cli-task-control.test.ts apps/runtime/test/cli-task-retry.test.ts apps/runtime/test/cli-task-run-progress.test.ts` | 0 | **27 pass / 0 fail**，410 expect（调度/暂停恢复/重试/进度路径 + 上述回归） |

中间过程结果（如实记录，不隐藏）：

- `cli-task-retry.test.ts` 曾在修复前 **1 fail**（容量等待用例），失败输出见上一节；修复后重跑 0 fail。
- `cli-knowledge.test.ts` 在开发过程中多次失败并逐个修正：`validate` 报告缺 `state` 字段、`list` 报告缺 `valid`/`code`/`humanEntryCount`/`generatedEntryCount`、`show` 分支把 `--json` 误当 `snapshot-id`、断言用 `realpathSync(home)` 与 Runtime 实际使用的 `CODEESTRA_HOME` 字面量不一致、`git status` 未加 `-uall` 导致目录被折叠。
- 首次把夹具设为「`task submit` 后自动启动」超时：该仓库没有 `.codeestra/impact.json`，调度器的自动 pass 无法证明 SAFE，因此改为显式 `task run`（同一门禁、同一建立路径），并保留这一事实的注释。

**过程卫生**：所有 e2e 测试使用 `apps/runtime/test/support/runtime-reclamation.ts` 的 `runCli`/`registerTemporaryDirectory`/`reclaimTestResources`（`afterEach` 回收）；跑完后 `ps -Ao pid,command | grep codeestra-wt/i3-project-knowledge | wc -l` = **0**（无本格遗留 Runtime 或 provider 进程）；未修改 `.codeestra/policies/verification.json`；未 push、未提升 main、未重启稳定 Runtime、未触碰 `/Users/loyage/Documents/codeestra`。

### 未验证与已知缺口（不得读作已完成）

1. **Provider 侧消费未验证**。Agent Adapter 目前不消费 `knowledgeSnapshotRefs`，本格领地也不含 `packages/agent-adapters/**`。成立的是「解析、物化、绑定、可追溯、拒绝路径」；**不**成立「Agent 真的读到了知识」。adapter 侧注入属后续格。
2. **机器生成层的其它写入者未实现**。除每 Execution 的 `knowledge-context.md` 外，没有生成 `generated/` 条目的组件；`generated/` 的读取、provenance 校验与拒绝路径已实现并有存储/命令面测试。
3. **无 `tool result capture` / verification / integration 的端到端联验**：绑定只验证到 Execution 建立与可追溯查询，没有验证成果提交后 `dev` 侧的追溯读取。
4. **无 UI 投影**（`apps/ui/**` 不在本格领地）。
5. **不涉及**向量检索 / embedding / LLM 摘要；`policies/` 不进知识层。
6. 上限（每层 256 条、单条 64 KiB、整快照 1 MiB、front-matter 32 行）是常量而非项目配置。
7. `docs/architecture/sqlite-schema.md` 中 v23/v24 的逐版本 DDL 记录仍未补齐（既有文档同步滞后，本格未擅自代补）。
8. 真实模型 + 真实 provider 的端到端未跑（本格只用协议 stub provider，符合 ADR-0008 的命令面测试边界）。

### 领地

独占：`packages/domain/src/knowledge*.ts`、`apps/runtime/src/knowledge-service.ts`、本格新增的 3 个测试文件、`docs/architecture/knowledge.md`、`docs/decisions/0041-*.md`。
纯追加/机械修改：`packages/storage/src/{migration,database,index}.ts`、`packages/contracts/src/index.ts`、`apps/cli/src/main.ts`、`apps/runtime/src/main.ts`、`package.json`、`docs/**`、`.gitignore`、`PROJECT_SPEC.md` §4、以及上述 4 处版本断言。
经协调者显式授权的最小追加式修改：`apps/runtime/src/agent-runtime-service.ts`、`apps/runtime/src/agent-start-service.ts`。
**未改**：`packages/agent-adapters/**`、`apps/ui/**`、`verification-service.ts`、`promotion-service.ts`、`schedule-service.ts`、`.codeestra/policies/verification.json`。
## FOUNDATION-068 — 从 reclaim 保留的 task branch 重建 owned worktree（ADR-0042，无 schema 变更）

状态：lane 分支已提交（**未 push、未提升 `main`、未重启稳定 Runtime、未触碰 `/Users/loyage/Documents/codeestra`**）。
基线固定 `dev = fd3d99871a40e578105036bc6728213adf302c6a`（未 rebase、未 merge、未 pull）。ADR：**0042**（用户已拍板，全部 8 项按 A 执行）。schema：**不变**（未动 `packages/storage/src/migration.ts`，不占 v25/v26）。

任务来源：ADR-0036 / FOUNDATION-061 如实保留的缺口——“已被 reclaim 的 worktree 无法重试”。

### 缺口（提交前逐条实测，不是猜测）

- `packages/git/src/reclaim.ts` 明确**不删** task branch（`git worktree remove --force` + `prune`，只删目录与注册）。
- `prepareWorkspace` 在「`refs/heads/task/<taskId>` 已存在」时以 `REF_CONFLICT` 拒绝建 worktree（它只做“从基线新建分支”）。
- 于是 reclaimed 的 Task 跑不起来：`decideRetryWorkspace` 只能给 `WORKSPACE_RECLAIMED`，Execution 无法建立。
- 另一个与判据有关的事实（本格用**真实迁移链**在内存库实测 DDL 复核）：`workspaces` 表自 v7 重建后 **`path` 列没有
  表级 `UNIQUE`**，只有两个**部分**唯一索引 `one_live_workspace ON workspaces(task_id) WHERE state <> 'RELEASED'`
  与 `one_live_workspace_path ON workspaces(path) WHERE state <> 'RELEASED'`。一个 Task 同时**只能有一个 live
  workspace 行**；`RELEASED` 行是历史，不挡住同一路径上的后续工作。本格的重建选择**复用同一行**，理由是该行就是这个
  checkout 的描述（`path`/`branch_ref`/`base_commit`/`ownership_token`），而不是路径列唯一。
  （本节早期版本把 `workspaces.path` 写成列级 `UNIQUE` 并据此断言“同 Task 不可能有第二个 workspace 行”，那是**错误
  的代码推断**，已在 88e7cdc 之后的更正提交里按实测改正。）

### 已实现（无 schema 变更；不引入第二套 Git 逻辑）

- **`packages/git/src/rebuild.ts`（新，独占领地内）**：全部由既有原语组合而成（`inspectOwnedPath`、
  `inspectOwnedWorktreeRegistration`、`readLocalRefCommit`、`isAncestor`、`listCheckedOutRefs`），而 `reconcileWorkspace` 完全未改：
  - `inspectTaskBranch`：分支是否存在、commit、与账本 `base_commit` 的关系（`EQUAL`/`DESCENDANT`/`UNRELATED`/`UNKNOWN`，**不可读报 UNKNOWN 而不是猜 UNRELATED**）、该分支在哪些 worktree 被 checkout。
  - `inspectOwnedWorktreeRebuild`：一次读取给出 `OWNED`/`MISSING`/`FOREIGN`/`UNCERTAIN`（与 `reconcileWorkspace` 同分类）+ 路径存在/注册/分支事实；字段名与领域 `RetryRebuildEvidence` 对齐，调用方无需翻译层。
  - `rebuildOwnedWorktree`：在动作时**重新建立**全部不变式（路径必须是 `<ownedRoot>/<project>/<task>`、路径与 project 目录都不是 symlink、在 owned root 内、未注册目录一律拒绝不删、分支必须仍从 `base_commit` 生长、不得已在别处 checkout、无 held Execution/活跃预约），只跑 `git worktree add <path> <短分支名>`（**不带 `--force`**；带 `refs/heads/` 前缀会让 Git 检出 detached，所以用短名，并用 `symbolic-ref` 事后证明 attach 成功）。
  - 幂等/崩溃：已注册且事实一致 → `ADOPTED`（**不跑任何 Git 命令**）；`add` 失败后重新观测，**仅当事实完全一致**（并发 preparation 赢了）才采纳，否则 `FAILED`；事后核验失败 `REBUILD_UNCONFIRMED` 且**故意不删**新建的 worktree（删除是 reclaim 的职责）。
  - 稳定拒绝码（action 层，与 reclaim 的 reasonCode 同风格）：`BRANCH_ABSENT`/`BRANCH_DIVERGED`/`BRANCH_CHECKED_OUT_ELSEWHERE`/`UNREGISTERED_DIRECTORY`/`REGISTERED_WITHOUT_DIRECTORY`/`PATH_NOT_OWNED_LAYOUT`/`SYMLINK_ESCAPE`/`PATH_OUTSIDE_OWNED_ROOT`/`BRANCH_MISMATCH`/`HEAD_UNREADABLE`/`HEAD_MISMATCH`/`REBUILD_FAILED`/`REBUILD_UNCONFIRMED`。
- **`packages/domain/src/task-retry.ts`**：新增 `RetryRebuildEvidence`（`pathPresent`/`registered`/`branchExists`/`relationToBase`/`checkedOutElsewhere`）与 `RetryWorkspaceMode = 'REUSE_VERIFIED' | 'PREPARE_FRESH' | 'REBUILD_OWNED'`；`decideRetryWorkspace` 在 `RELEASED` + `FOREIGN` + 全部事实成立时给 `REBUILD_OWNED`，其余仍是 `WORKSPACE_RECLAIMED`（**不新增拒绝码**，具体事实写进证据串）或 `WORKSPACE_OWNERSHIP_UNVERIFIABLE`；拒绝时仍是 `mode: null`（不记一个不会执行计划的 mode）。
- **`packages/storage/src/database.ts`（仅最小纯追加）**：`TaskRetryWorkspaceMode` 加 `'REBUILD_OWNED'`（并改正已过时的“故意没有 rebuild 模式”注释）；新增 `markReclaimedWorkspaceRebuilt`：只接受 `RELEASED` 行，事务内重新核验 held Execution 与活跃预约，`RELEASED → READY` 与既有 `WorkspacePrepared` 事件（payload 带 `reattachedBranch: true`、`previousState: 'RELEASED'`、`rebuild: { outcome, reasonCode, detail, headCommit }`）同事务；行已是 `READY` 时返回 `changed: false`（两个并发 preparation 不会产生第二个 worktree）。既有方法语义与既有拒绝码一字未改。
- **`apps/runtime/src/workspace-service.ts`（独占）**：`prepareTaskWorkspace` 在 READY 复用之后、新准备之前插入 `rebuildReclaimedTaskWorkspace`：用**同一个** `decideRetryWorkspace` 与同一份事实判定；`PREPARE_FRESH` 落回既有路径（既有行为一字不变）；无 live claim（活跃预约 / held Execution）即拒绝；重建成功才记账本；返回的 plan 复用原 `workspace_id`/`path`/`branch_ref`/`base_commit`/`ownership_token`。
- **`apps/runtime/src/task-control-service.ts`（独占）**：retry 的观察改为 `inspectOwnedWorktreeRebuild`（不再调 `reconcileWorkspace`），并把分支事实交给领域判定；`retryFailedTask` 新增 `runtimeHome` 入参以定位 owned root；`retry` 仍然只 requeue（**真实重建在 preparation**），`--json` 里 `workspace.mode` 是“核验通过、待重建”，实际结果由 `WorkspacePrepared` 事件证明。
- **`apps/runtime/src/main.ts`（纯接线一行）**：`retryFailedTask({ …, runtimeHome: home, … })`。
- **`packages/contracts/src/index.ts`（纯追加）**：`TaskRetryOutcomeView.workspace.mode` 加 `'REBUILD_OWNED'`，并注明“这是经核验的计划，实际重建由 `WorkspacePrepared.payload.rebuild` 证明”。
- **`docs/**`**：新增 `docs/decisions/0042-rebuild-reclaimed-worktree.md`；`docs/decisions/README.md` 加索引行并给 ADR-0036 行加 “Amended by ADR-0042” 注明（原文一字未删）；`docs/decisions/0036-*.md` 追加“后续变更”一节（不改写上文 Decision）；`docs/architecture/event-model.md` 注明 `WorkspacePrepared` 的重建载荷（**未新增事件名**）。
- **`packages/git/src/reclaim.ts` 的一个小修正**：`pathExists` 对 `ENOTDIR`（祖先不是目录）也返回 false（之前会抛错）。这是本格重建路径上真实会遇到的形态（记录路径的 project 目录被换成文件），改成“不存在”比抛错更诚实，也不改变任何删除语义（该路径无论如何都不会被删）。

### 测试

- `packages/domain/test/task-retry.test.ts`（扩展）：`RELEASED + FOREIGN + EQUAL/DESCENDANT` → `REBUILD_OWNED`；分支缺失 / `UNRELATED` / `UNKNOWN` / 被别处 checkout / `pathPresent` / 已注册 / 事实未观察 → 全为 `WORKSPACE_RECLAIMED` 且 `mode: null`；`UNCERTAIN` 不因分支事实变绿。
- `packages/git/test/rebuild.test.ts`（新，真实临时仓库，11 项）：重建成功（失败尝试**已提交**的 commit 仍在，`b` 文件可读）、幂等 `ADOPTED`（不再跑 Git、注册数仍为 1）、陈旧注册无目录被拒、分支分叉/缺失被拒、分支在别的 worktree 被拒（且那个 worktree 原样）、未注册残留目录被拒且文件原样、注册在别的分支被拒、非本 Task 布局路径被拒、symlink 被拒、布局无法创建报 `FAILED` 且不留下注册。
- `apps/runtime/test/cli-task-retry.test.ts`（真实 CLI + Runtime + 临时 home/仓库 + 协议 stub，共 8 项）：替换原来“reclaimed 后拒绝”的用例为**重建成功**用例；新增**零写入拒绝**用例（分支分叉、记录路径被未注册目录占用）；新增 “starts a fresh worktree when a reclaimed worktree and its branch are both gone”（`RELEASED` 行 + 分支/目录都不存在 → `PREPARE_FRESH` 真的在同一路径重新准备 worktree，并由 `reclaim plan` 的两个不同 `resourceId` 证认第二个 workspace 行）。

### 实际运行的检查与逐条结果

只运行 `bun run typecheck` 与建分支时选定的定向测试（**未跑 `bun run check` / `check:fast` / `just check` / `just verify`**，按 ADR-0038）：

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | 退出码 0（根 tsc `--noEmit`，无输出） |
| `bun test packages/domain/test/task-retry.test.ts` | 8 pass / 0 fail / 51 expect() |
| `bun test packages/git/test/rebuild.test.ts` | 11 pass / 0 fail / 59 expect() |
| `bun test packages/git/test packages/domain/test packages/storage/test` | 18 文件，438 pass / 0 fail / 1375 expect() |
| `bun test apps/runtime/test/cli-task-retry.test.ts` | 8 pass / 0 fail / 124 expect()（含重建成功、分支已不存在时从 dev 重新开始、两类零写入拒绝） |
| `bun test apps/runtime/test/workspace-service.test.ts apps/runtime/test/task-control-service.test.ts` | 24 pass / 0 fail / 114 expect() |
| `bun test apps/runtime/test/cli-reclaim.test.ts` | 8 pass / 0 fail / 67 expect()（含回收 schema/reconcile） |
| `bun test apps/runtime/test/scheduler.test.ts apps/runtime/test/cli-task-control.test.ts` | 9 pass / 0 fail / 69 expect() |

测试卫生（FOUNDATION-057）：所有 CLI 类用例用 `apps/runtime/test/support/runtime-reclamation.ts` 的 `runCli`（强制临时
`CODEESTRA_HOME`）并在每个用例末尾 `codeestra stop`，teardown 调 `reclaimTestResources()`；交付后实测
`ps` 中没有任何命名本 worktree 的 Runtime 进程，`${TMPDIR}` 下也没有本格前缀（`codeestra-retry-*`、`codeestra-rebuild-*`）的残留夹具。

### 未验证（不得当成已成立）

- 真实 provider：全部重建/拒绝路径的 e2e 用**协议 stub provider**（`stopReason: 'error'` 模拟 Pi 失败轮次），不能证明真实 Pi/Codex 在重建出的 worktree 里的行为。
- 真实并发/压力：两个 preparation 同时抢同一路径只做了“事实一致才采纳”的逻辑覆盖，没有做并发压测。
- UI 投影：`apps/ui/**` 一行未动；`REBUILD_OWNED` 与 rebuild 事件在 Web UI 不可见。
- 跨平台：git 语义在 macOS 上实测（短分支名才 attach、带 `refs/heads/` 会 detached），未在其它平台复验。

### 实测更正（88e7cdc 之后的追加提交）

本节早期版本写了两处**基于代码阅读的错误推断**，协调者用真实迁移链实测指出后，本格用受控实验重新实测并改正：

- **错在哪里**：曾写“`workspaces.path` 有唯一约束，因此同 Task 无法再新建第二个 workspace 行；`PREPARE_FRESH` 会以
  数据库约束错误收场”，并据此立了一条“需独立决策”的剩余项。本文件更早的 schema 修复表（“`workspaces.path`
  无条件 UNIQUE → 失败一次就永久无法重试 → schema v7 改为部分唯一索引”）已经记过这件事，本次仍未查证就当成成立，
  属于本格自己的失误。实际 DDL（用 `Phase1Database` 真实迁移链在内存库
  `sqlite_master` 读出，`user_version=24`）是：
  ```sql
  CREATE TABLE "workspaces" (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), branch_ref TEXT NOT NULL,
    path TEXT NOT NULL,                          -- 没有 UNIQUE（v7 重建时移除）
    ownership_token TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL,
    state TEXT NOT NULL CHECK(...), created_at INTEGER NOT NULL CHECK(...),
    UNIQUE(task_id,id)) STRICT;
  CREATE UNIQUE INDEX one_live_workspace      ON workspaces(task_id) WHERE state <> 'RELEASED';
  CREATE UNIQUE INDEX one_live_workspace_path ON workspaces(path)     WHERE state <> 'RELEASED';
  ```
- **实测怎么做**：复用已登记的 `apps/runtime/test/cli-task-retry.test.ts`（真实 CLI + Runtime + 临时仓库 + 临时
  `CODEESTRA_HOME` + 协议 stub provider），新增 “starts a fresh worktree when a reclaimed worktree and its
  branch are both gone”：跑失败一次 → `reclaim apply`（worktree 目录消失、行 `RELEASED`）→ `git update-ref -d
  refs/heads/task/<taskId>`（分支也不存在）→ `task retry`。
- **实测结果（真实行为，无任何失败/约束冲突）**：`task retry` 退出码 **0**；`workspace.mode=PREPARE_FRESH`；
  `start.outcome=STARTED`、`attemptNumber=2`；记录路径上真的重新准备了 worktree，`HEAD` = `refs/heads/dev` 的
  commit（即“从固定 dev 基线重新开始”），`symbolic-ref` = 新建立的 `refs/heads/task/<taskId>`；第二次 stub 启动
  留下痕迹（日志恰好 1 行，证明旧尝试的未提交文件确实不在了）；`reclaim plan --json` 对同一路径列出 **两个**
  `TASK_WORKTREE` target（一个 `RELEASED`、一个非 `RELEASED`，`resourceId` 不同）——即**第二个 workspace 行确实
  被插入**，`ownership_token` 也没有冲突（新行用新的随机 token）。
- **改后的记录**：删掉那条假缺口；ADR-0042 的 Context/D03 也一并改正（“`path` 唯一约束决定只能复用同一行”改为
  “复用同一行是因为该行就是这个 checkout 的描述，而 `one_live_workspace_path` 限定一个路径只能有一个 live 行”）。
  `ownership_token` 的全局 `UNIQUE` 仍存在，但每次 prepare 都会生成新 token，所以不构成阻塞（实测 0 次冲突）。

### 已知缺口（如实记录，未静默绕过）

- 重建后的**首次启动**，impact/conflict 观察仍把该 Task 视为“尚无 workspace”（`getImpactCandidateTask` 过滤
  `state <> 'RELEASED'`），因此第一次启动的改动集观察为空。这是既有语义，本格不改 `slot-reservation-service`。
- 真实 `main` 提升、稳定 Runtime 重启、push 全部未做（本格明确不做）。
- （原“`RELEASED` + 分支不存在会撞约束”一条**不成立**，已按实测删除，见上一节。）

### 改动边界（领地）

独占：`packages/git/src/*`（新增 `rebuild.ts`、`index.ts` 追加导出、`reclaim.ts` 的 ENOTDIR 一行）、
`packages/domain/src/task-retry.ts`、`apps/runtime/src/{workspace-service,task-control-service}.ts`、本格测试文件。
纯追加：`packages/contracts/src/index.ts`、`packages/storage/src/database.ts`（类型取值 + 一个新方法，**无迁移**）、
`apps/runtime/src/main.ts`（一行接线）、`docs/**`。
**未改**：`packages/storage/src/migration.ts`、`packages/agent-adapters/**`、`apps/ui/**`、`schedule-service.ts`、
`slot-reservation-service.ts`、`verification-service.ts`、`agent-runtime-service.ts`、`.codeestra/policies/verification.json`、
`PROJECT_SPEC.md`、`AGENTS.md`、`package.json`（未新增 e2e 文件，故测试列表无需登记）；`## NEXT` 一字未动。

### 建议如何更新 `## NEXT`（本节不改写 `## NEXT`）

`## NEXT` 第 5 条只提到回收；ADR-0036/FOUNDATION-061 的缺口记在它自己的小节里。若要把本格的闭环写回
`## NEXT`，建议在第 5 条之后追加一句（而不是修改第 5 条本身）：

> 5b. ~~已被 `reclaim` 的 worktree 无法重建~~：已由 ADR-0042 / FOUNDATION-068 完成（`workspaceMode=REBUILD_OWNED` +
>     preparation 侧从保留的 task branch attach 重建、`WorkspacePrepared.rebuild` 记录 `REBUILT`/`ADOPTED`、无 schema 变更）。
>     `RELEASED` + 分支已不存在时走既有 `PREPARE_FRESH`，已被定向测试覆盖（同一路径上新增第二个 workspace 行）。
>     **剩余**：真实 provider 在重建 worktree 中的验收、重建的 UI 投影。
## FOUNDATION-069 — 散文提问升级为一等等待（ADR-0043，**无 schema 变更、不占迁移号**）

状态：**已实现，lane 分支 commit（未 push、未提升 `main`、未重启稳定 Runtime）。**
基线：`dev = fd3d99871a40e578105036bc6728213adf302c6a`。工作树：`/Users/loyage/Documents/codeestra-wt/i5-prose-question-attention`，分支 `lane/i5-prose-question-attention`。

本格补上 FOUNDATION-056 与 ADR-0004/0014 语义里**明确未做的那半截**：把「Agent 在散文里提问并结束轮次」
从只记录 note 升级为一等的等待/Attention 事实，同时保住误报不得静默破坏 Task。

### 用户已拍板的产品语义（8 问，逐条答复）

| 问题 | 裁决 |
|---|---|
| 默认是否自动升级 | **B：默认自动升级**（命中即 `Task → WAITING_FOR_USER` + 一条 Attention），降级开关不是默认 |
| 通道形状 | **A：复用 `attention_requests`**，`kind='QUESTION'` + `prompt.kind='codeestra.prose-question'`；零 schema 变更 |
| 恢复语义 | **A：只允许显式解除/降级**；回答文本只入审计与事件，**不投递给任何 provider** |
| schema 变更 | **A：不允许**（协调者另加：**不得自取迁移号**，v25 归 I1、v26 归 I3） |
| Codex 事实层 | **A：不在本格** |
| UI 投影 | **A：不在本格**（不动 `apps/ui/**`） |
| 开关形状 | **A：全局 Runtime 设置 + CLI 命令**；零确认、`--json`、稳定退出码；默认必须是 `auto` |
| 解除命令形状 | **A：新增 `attention resolve`**，与 `attention answer` 平行，拒绝把散文等待送进 provider 投递路径 |

### 修改

- **`packages/domain/src/prose-question-attention.ts`（新）**：唯一一处纯判定。升级策略 `decideProseQuestionEscalation(mode, note)`
  （`auto` / `record-only` / `off`，默认 `auto`）、prompt 构造与严格回读（`buildProseQuestionPrompt` / `readProseQuestionPrompt`）、
  派生 `provider_request_id`（`codeestra-prose-question:<providerEventId>`）、解除合法性判定
  `decideProseQuestionResolution(facts)` 与负载校验 `validateProseQuestionResolution`，含全部稳定拒绝码。无 Bun/DB/Git/模型依赖。
- **`packages/storage/src/database.ts`（纯追加）**：`recordAgentCompleted` 新增可选 `proseQuestion`，在**同一事务**内投影
  等待（`attention_requests` 行 + `tasks.state='WAITING_FOR_USER'` + `UserAttentionRequested` + `TaskStateChanged`）；
  新增按 command 幂等的 `resolveProseQuestionAttention`；`planAttentionAnswer` 对散文等待返回
  `PROSE_QUESTION_RESOLUTION_REQUIRED`（在既有 provider 投递路由之前拦截）；`StorageError` 码并集追加本格稳定码。
- **`packages/contracts/src/prose-question.ts`（新）+ `index.ts`（纯追加）**：`attention.resolve`、
  `settings.proseQuestionAttention.get|set` 三个请求，以及结果/设置/负载 schema。
- **`apps/runtime/src/agent-observation-service.ts`**：按模式在完成投影时决定是否升级（默认 `auto`）。
- **`apps/runtime/src/agent-runtime-service.ts`**：新增 `proseQuestionAttentionMode` 端口（Session 启动时读取，不重启即生效；
  读取失败时记日志并回落到产品默认，不让一个坏设置文件毁掉一次正常完成的观察流）。
- **`apps/runtime/src/prose-question-attention-settings.ts`（新）**：全局设置文件（`$CODEESTRA_HOME/prose-question-attention.json`，原子写，与 `permission-mode.ts` 同构）。
- **`apps/runtime/src/main.ts`（纯追加）**：`attention.resolve` 与两个 settings 命令的处理，以及启动时读取设置。
- **`apps/cli/src/main.ts`（纯追加）**：`attention resolve --dismiss|--answer <text> [--note <text>] [--json]`、
  `settings prose-question-attention [auto|record-only|off] [--json]`、用法文本，以及 `task status` 在存在 OPEN 散文等待时
  向 stderr 多打一行 `[waiting] …`（渲染既有事实，不改 stdout 的 JSON）。
- **`package.json`（测试列表）**：新 e2e 文件登记进 `test:unit` 忽略列表与 `test:e2e`。
- **`apps/runtime/test/cli-prose-question.test.ts`（既有文件的小改）**：FOUNDATION-056 的契约现在只在 `record-only` 下成立，
  因此该夹具显式降级到 `record-only`；默认路径由新 e2e 文件覆盖。
- **`apps/runtime/test/agent-observation-service.test.ts`（既有文件的小改）**：原「散文提问不产生 Attention、Task 仍 RUNNING」
  的断言改为默认 `auto` 行为，并新增 `record-only` / `off` 两项严格更少的对照。

关键设计取舍（详见 ADR-0043）：**只暂停该 Task**（`Session` 保持 `EXITED`、`Execution` 保持 `RUNNING`，进程真的退出了，
不把死会话伪装成活的 provider 会话）；解除**什么都不投递**（`deliveredToProvider: false`）、不新建 Execution、不 resume conversation；
回答**不是 TaskRevision**，`task amend` 语义一字未改；Task 不处于 `RUNNING` 时（例如并发停止）**跳过等待而不是让完成投影失败**。

### 实际运行的检查与逐条结果

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | **退出码 0**（在最后一次改动后复跑） |
| `bunx vitest run packages/domain/test/prose-question-attention.test.ts` | **8 passed (8)**，退出码 0（新文件） |
| `bun test packages/storage/test/prose-question-attention.test.ts` | **11 pass / 0 fail**（63 断言），退出码 0（新文件） |
| `bun test packages/contracts/test/request.test.ts` | **20 pass / 0 fail**，退出码 0（契约边界回归） |
| `bun test apps/runtime/test/agent-observation-service.test.ts` | **9 pass / 0 fail**（48 断言），退出码 0 |
| `bun test apps/runtime/test/agent-runtime-service.test.ts` | **7 pass / 0 fail**，退出码 0 |
| `bun test apps/runtime/test/session-handoff-service.test.ts` | **17 pass / 0 fail**（129 断言），退出码 0 |
| `bun test apps/runtime/test/cli-prose-question.test.ts` | **2 pass / 0 fail**，退出码 0 |
| `bun test apps/runtime/test/cli-prose-question-attention.test.ts` | **4 pass / 0 fail**（76 断言），退出码 0（新 e2e，真实 CLI + 真实 Runtime + 临时 home/仓库 + 协议 stub provider） |

新增覆盖的关键断言：升级与完成**同事务**（Session `EXITED` / Execution `RUNNING` / Task `WAITING_FOR_USER` 三事实一次写入）；
同一 provider event 重放**不产生第二条** Attention；同一 command 重放**不产生第二条**审计行；`attention answer` 对散文等待
以 `PROSE_QUESTION_RESOLUTION_REQUIRED` 拒绝且**零写入**（无 answer/operation/receipt）；`--dismiss` 与 `--answer` 各自留审计
并把 Task 还原；第二次解除以 `PROSE_QUESTION_ATTENTION_ALREADY_RESOLVED` 拒绝；`PROSE_QUESTION_SESSION_NOT_EXITED` /
`PROSE_QUESTION_TASK_NOT_WAITING` 等拒绝路径零写入；终态（`CANCELLED`）不被复活；Task 非 `RUNNING` 时 note 仍记录、等待跳过；
`settings` 三个取值端到端生效（`record-only` 下 `attention list` 为空、`off` 下 note 为 null）；用法错误 exit 2；
`task revision list` 仍只有 1 条 revision。

### 未验证与已知缺口（不得当成已成立）

- **真实模型未验收**：端到端用的是协议 stub provider，只证明 Runtime 自己的编排与命令面，**不证明真实模型行为**；本格给不出命中频率/误报率的任何统计。
- **Codex 侧事实层未做**：`codex-adapter.ts` 未改动，它仍不上报 completion facts，因此 Codex 的散文提问只漏报、不谎报。
- **回答后继续对话未做**：`--answer` 只记录文本，不新建 Execution、不 `--session` resume；「回答后回到同一 conversation 继续」是明确留给后续格的产品语义。
- **UI 投影未做**：`apps/ui/**` 一字未改，散文等待在 Web UI 里没有专门呈现（`attention list`/`task.status` 的事实已可在命令面读到）。
- **新聚合组合未在真实 provider 下复验**：`Task WAITING_FOR_USER` + `Execution RUNNING` + `Session EXITED` 是前所未有的组合，
  本格只在 storage/runtime 单元与 stub e2e 下验证；它与 `task pause`/`task cancel` 在真实 provider 进程上的交互未实测。
- **未运行全量/聚合检查**（ADR-0038）：没有跑 `bun run check`、`bun run check:fast`、`just check`、`just verify`，`bun run test`（vitest 全量）与 `bun run typecheck:ui` 也未运行；只跑了上表列出的定向文件。
- **一个与本格无关的既有失败**：`bun test apps/runtime/test/cli-attention.test.ts` 第三个用例
  （`workbench HTTP client reads tasks and answers while a task awaits user input`）报
  `TypeError: null is not an object (evaluating 'envelope.ok')`（`apps/ui/src/api.ts:45`）。已在**未修改的基线**上复现：
  `git stash push -u` 后同一文件仍 **2 pass / 1 fail**，随后 `git stash pop` 恢复本格改动。本格未修（属 UI/HTTP 面，不在领地）。

### 文档与决策

- 新增 `docs/decisions/0043-prose-question-attention-escalation.md`（ADR-0043）：8 条决策 + 被否掉的 7 个选项 + 后果 + 验证要求。
- `docs/decisions/README.md`：在 ADR-0038 行之后追加 ADR-0043 索引行。
- **未改写 `## NEXT`（按要求）**：其中第 6 条仍写着「仍未做……把它自动升级为 Attention / `WAITING_FOR_USER`」，
  这句在本格之后**已不准确**（默认 `auto` 已经做到）。本格按指令没有改动 `## NEXT`，把它作为待人工/集成时更新的一处已知文档不一致留在这里。

### 领地与未触碰

- 未改动 `apps/ui/**`、`packages/agent-adapters/**`、`schedule-service.ts`、`verification-service.ts`、`promotion-service.ts`、`packages/git/**`；
  **未改 `packages/storage/src/migration.ts`、未占任何迁移号（schema 仍 v24）**；未改 `.codeestra/policies/verification.json`。
- 未 push、未提升 `main`、未重启稳定 Runtime；`/Users/loyage/Documents/codeestra` 未被触碰；全程只用 CLI/命令面（无 computer-use / 桌面 / 浏览器自动化）。
- 本格夹具与进程已回收：`reclaimTestResources()` 在每个 e2e 的 `afterEach` 执行，各用例结束时 `codeestra stop`；
  跑完后核对本工作树无残留 Runtime 进程、`/tmp/codeestra-wait-*` 夹具目录已被回收。

## Wave I 开发分支集成（I1 → I3 → I4 → I5 → I2，5 格经 Orca 受监督编排）

状态：**五格已按用户指定顺序合入 `dev`，独立全量检查通过。** 未 push、未提升 `main`、未重启稳定 Runtime。

本次与 Wave A–H 的差别：分支/worktree/prompt 惯例不变（固定基线、`lane/` 前缀、`codeestra-wt/` 路径、`~/.pi/agent/prompts/i*.md`），但 worker 由 **Orca 编排层**以 `pi` 拉起并受监督（Run `run_7af71877c21f`，每个 lane 一个 Task，另有一个事实纠正 Task），协调者负责中继决策 `ask` 与收集 `worker_done`。

### 固定提交与合并顺序

| 顺序 | 分支 | lane commit | `dev` 合并 |
|---|---|---|---|
| I1 | `lane/i1-verification-evidence` | `38d7faf` | merge `d8a76ce` |
| I3 | `lane/i3-project-knowledge` | `fabf608` | merge `7bdff39` |
| I4 | `lane/i4-reclaim-worktree-rebuild` | `88e7cdc` + `f1da1a5` | merge `7173d7e` |
| I5 | `lane/i5-prose-question-attention` | `d8bc8d5` | merge `533e5a2` |
| I2 | `lane/i2-claude-code-adapter` | `3c6df9e` | merge `c1a72db` |

基线固定 `dev@fd3d99871a40e578105036bc6728213adf302c6a`（五格同基线，未 rebase）。schema 预分配按纪律执行：**I1 = v25、I3 = v26**，合并后 `phase1SchemaVersion = 26`；I2/I4/I5 未占迁移号。

### 冲突处置

- 冲突共 19 处，全部人工解决（不靠自动合并结果）：`migration.ts` 两段迁移按升序共存且版本 = 26；`database.ts` 两个步骤按升序执行；`package.json` 的 `test:unit` 忽略列表与 `test:e2e` 列表取并集（`cli-claude-adapter`、`cli-knowledge`、`cli-prose-question-attention`、`cli-targeted-tests`）；`docs/tasks/README.md` 按号段升序排序（064 → 065 → 066 → 067 → 068 → 069）；`docs/decisions/README.md` 的 ADR-0040 插到 0039 与 0041 之间；四个共享测试文件的 schema 版本断言（`cli-reclaim-batch`/`revision-delivery`/`verification-cancel`/`impact-analysis`）保留 `>= 24` 写法并统一注释（**Wave D/E 那两次「单格绿、合并后才爆」都出自写死版本号**）。
- `apps/runtime/src/agent-runtime-service.ts` 被 I3 与 I5 同时修改，git 自动合并成功；**逐行核对了两侧语义都在**（I3 的 `prepareExecutionKnowledge` + `knowledgeSnapshotRefs`，I5 的 `proseQuestionAttentionMode` 与升级路径），不是只信自动合并。

### 集成期发现并修掉的问题（各格单独跑时看不到）

1. **聚合测试红（真实集成缺陷）**：I1 的 `packages/domain/test/verification-evidence.test.ts` 与 I3 的 `packages/domain/test/knowledge.test.ts` 用 `bun:test`，而 `vitest.config.ts` 的 include 是 `packages/domain/**/*.test.ts`。各格单独用 `bun test` 跑是绿的，合并后 `bun run test`（vitest）直接报 `Cannot find package 'bun:test'` 而中止。已改为 `vitest` 导入并单独记录为本格发现的集成缺陷（**lane 内的定向测试无法发现它，只有 dev 上的聚合检查能**）。
2. **ADR 索引行残留被推翻的推断**：I4 的事实纠正（`f1da1a5`）改了 ADR-0042 正文与 FOUNDATION-068，但漏了 `docs/decisions/README.md` 的索引行，那里仍写着「`PREPARE_FRESH` 会撞 `workspaces.path` 唯一约束」。已在合并提交里按实测改正。
3. **I3 迁移注释与最终裁决不符**：`migration.ts` 里 `execution_knowledge_snapshots` 的注释仍写「物化进该 Execution 的 worktree」，而第三轮裁决已把机器生成上下文移出 worktree（写 Runtime 数据目录）。已在合并提交里改正。
4. **I4 原始记录的事实错误（本波自己踩的坑，已闭环）**：它把「RELEASED + 分支不存在时 `PREPARE_FRESH` 会以数据库约束错误收场」当成事实写进记录并立了一条「需独立决策」的 backlog 项。协调者用真实迁移链（v1→v24，`bun:sqlite` 内存库读 `sqlite_master`）证明 `workspaces.path` **没有**表级唯一约束（v7 重建表时已移除，只剩 `one_live_workspace_path … WHERE state <> 'RELEASED'`）；随后派了一个事实纠正 Task，由 I4 用受控实验实测该路径**可用**（`task retry` 退出 0、`PREPARE_FRESH`、attempt 2 STARTED、同一路径第二个 workspace 行、HEAD = `dev` commit），并在 `f1da1a5` 里逐处改正记录（含明写「这是本格自己的失误」）。
5. **ADR-0038 措辞对齐实现（用户裁决）**：D03 原写「在 `dev` 工作树」跑全量，I1 实现为由 Runtime 在**精确 SHA 的隔离副本**上跑。用户确认改 D03 措辞对齐实现（副本对「精确候选 SHA」保证更强，且与 ADR-0006 的 detached 副本惯例一致）；已在本波提交里改 D03 与决策索引行，并如实写明这是改规格而不是改实现。

### 用户裁决

五格共中继四轮决策（I1 8 题、I5 8 题、I3 8+4+1 题、I4 8 题、I2 5+2 题）。协调者未代答任何一题，全部由用户拍板后原样下发；其中两处协调者偏离了 worker 自身推荐并说明理由（I4 的稳定码粒度、I3 的 generated 读位置）。完整的决策清单与理由见 `codeestra-wt/PARALLEL-PLAN.md` 的「Wave I」与「Wave I：用户已拍板的语义」两节。

### 独立集成验证（ADR-0038 的 dev 全量证据）

- 在合并后的 `dev` 候选 **`e40156463a5fdfedb6ec82c40ebf482f58bb6cbc`** 上执行 `bun run check`：**退出码 0**。
- 根/UI TypeScript 均通过；**Vitest 10 文件 / 354 项全部通过**（本波前为 272）；`test:storage` **725 pass / 0 fail（81 文件，4753 断言）**（本波前为 622 / 72 文件 / 4052 断言）；UI `vite build` 成功。日志 `/tmp/iwave/dev-full-check2.log`；第一次同样候选前身的运行（退出码 1）与失败原因见 `/tmp/iwave/dev-full-check.log`。
- **记录提交在检查之后**：本节的提交只改文档（`docs/tasks/README.md` 的 NEXT 第 6 条与本记录），按 ADR-0038 D03 的既有条款，`dev` 上的文档编辑不触发重跑；但它确实让 `dev` HEAD 与上面那个被验证的候选 SHA 不再相同（仅文档差异）。**准备 `dev → main` 时必须以当时固定的精确 SHA 重跑全量并以其证据为准**，不得把本节引用为提升证据。

### 未验证 / 已知缺口（如实汇总，不得当成已成立）

- **真实 provider 全部未验收**：Claude 能力矩阵 4 项为 `REQUIRES_VALIDATION`（本机 `claude` 未登录、无 API key，全程无真实模型调用）；Pi/Codex/Claude 的并发、失败后重试、revision ACK、散文等待的真实模型行为都仍未验证。
- **provider 侧知识消费不成立**：Adapter 仍不消费 `knowledgeSnapshotRefs`，本波只做到「解析 + 绑定 + 审计 + 命令面 + 物化到 Runtime 数据目录」，adapter 侧注入属后续格。
- **`session.transcript` 仍只认 Pi 会话目录**，Claude 会话以 `SESSION_FILE_NOT_OWNED` 失败（已在 ADR-0040 与 I2 记录中标为缺口）。
- **UI 一行未改**：五格都明确把 UI 投影排除在外（本波 `apps/ui/**` diff 为空）。
- **`## NEXT` 仍有历史漂移**（例：第 7 条把已由 FOUNDATION-055/059 完成的调度引擎与 UI 投影写作「剩余」）。本波只如实更新了第 6 条，未做全面校准——那属于单独一次 doc-sync/NEXT 校准格。

## 第二次真实 `dev → main` 提升（`main` `fd3d998` → `54ff304`，14 个提交，Wave I）

状态：**已执行并成功**（用户显式授权）。这是 Wave I 五格（ADR-0039/0040/0041/0042/0043）进入稳定分支，也是**首次带上完整全量证据的提升**（ADR-0038 分层在本波才由命令面表达）。

| 项 | 值 |
|---|---|
| 提升前 `main` | `fd3d99871a40e578105036bc6728213adf302c6a` |
| 提升后 `main` | `54ff3049e7a4b3e85726210e39c71c6751403b37`（= 当时的 `dev`，也是被验证的精确候选） |
| 推进的提交数 | 14 |
| 方式 | 在已检出的 main 工作树内 `git merge --ff-only dev`（同时推进 ref/index/工作文件，退出码 0） |
| `main` 工作树 | 提升前 clean、提升后 clean；`phase1SchemaVersion = 26` |
| 稳定库 schema | 提升前 `user_version = 24` → 启动后 **26**（v25 分层验证证据、v26 知识分层）；新表 `targeted_test_plans`/`dev_full_suite_evidence`/`knowledge_snapshots`/`execution_knowledge_snapshots` 均已建立；`bun.lock` 本波未变 |

### 提升前全量证据（ADR-0038 D03）

在**精确候选 SHA `54ff3049e7a4b3e85726210e39c71c6751403b37`** 上执行 `bun run check`：**退出码 0**。根/UI TypeScript 通过；Vitest 10 文件 / 354 项通过；`test:storage` 725 pass / 0 fail（81 文件，4753 断言）；UI `vite build` 成功；运行后 `dev` 工作树 clean、无孤儿 Runtime。日志：`/tmp/iwave/promotion-candidate-check.log`。

（诚实说明：这个候选是 `e401564` 之后多了两个**仅文档**提交的 SHA；先前那次在 `e401564` 上的检查不引用为提升证据，本轮重跑了。检查后到提升之间 `dev` 无任何提交，被验证的 SHA 与被提升的 SHA 完全相同。）

### 重启序列与证据（AGENTS.md 「重启 main 稳定服务」规程）

在 `/Users/loyage/Documents/codeestra` 按顺序执行，每步退出码均 0：

1. `bun install --frozen-lockfile` → 退出码 0（`Checked 65 installs across 84 packages (no changes)`）。
2. `bun run build:ui` → 退出码 0（`index-CVUE8hYj.css` / `index-Bp4PpPZZ.js`）。
3. `bun run codeestra stop` → 退出码 0；lock 释放（`present:false`、`holderAlive:false`）。
4. `bun run codeestra status` → 退出码 0：`status: "READY"`、`permissionMode: "FULL"`、`adapters: ["pi","codex","claude"]`（Claude 适配器已注册）、`activeSessions: []`、`eventSubscribers: 0`、`ownership.verdict: "RUNNING"`。
5. `bun run codeestra ui --no-open` → 退出码 0；再次 `status` 得 `uiRunning: true`（AGENTS.md 要求 READY + uiRunning 两者同时成立）。带 token 的输出**未写入**任何文档/日志/提交（该临时日志已删除并核验其余日志无 token）。

| | boot id | pid |
|---|---|---|
| 提升前 | `54225778-6498-4f59-83b8-447a928537ca` | 24280 |
| 提升后 | `5cc84fdd-e843-42bb-9d37-03c91a4ea3a9` | 50758 |

boot 身份不同（ADR-0022 的重启判定），且新进程确实运行新代码（适配器列表已含 `claude`，库已迁到 v26）。

### 记录与诚实边界

- **仍然没有产生领域 `PromotionRecord` 行**：本次走 AGENTS.md 规定的「main 工作树内 `git merge --ff-only dev`」路径。产品命令 `promotion prepare` 需要 `batchId` + IntegrationBatch 的集成验证证据（`requireIntegrationEvidence`），而 Wave I 的五个 lane 是协调者手工解冲突合入 `dev` 的，**没有 IntegrationBatch**，因此产品路径对这个候选在语义上无法 prepare。提升的 traceability 只在 Git 历史 + 本节，`promotion list` 看不到这次提升——与第一次提升同一个缺口，本次仍未补。
- **未在 main 工作树额外跑全量**：`main` 此刻与被执行全量的精确候选 SHA 完全相同，树也相同（ff-only、两边 clean）；额外再跑一次不会增加信息。
- 本波新增的 `promotion.full-suite run` 证据机制**未在真实仓库上跑过**（它需要项目注册在一个运行新代码的 Runtime 里；稳定 Runtime 提升前跑的是旧代码）。这仍是未验收项。
## FOUNDATION-070 — 中文用户指南与 CLI 命令参考（Wave J / J1，纯文档，无 ADR）

状态：已完成（纯文档交付，未改动任何代码、规格、ADR 或 UI 资产）。用户原话是「开发指南文档，教用户如何使用软件，软件具有哪些功能」。
语言：中文（专有名词、命令、环境变量、错误码保留英文原文）。

### 交付物

| 文件 | 内容 |
|---|---|
| `docs/guides/README.md` | 指南索引与三条读者路径（第一次用 / 查功能 / 查命令） |
| `docs/guides/getting-started.md` | 依赖、`bun install --frozen-lockfile`、`bun run build:ui`、数据目录与单实例、`status`、`permission get/set`、`project inspect/policy/impact validate/trust`、`open`、`ui`、`stop` |
| `docs/guides/concepts.md` | Task-first 与「Agent/Terminal/Conversation/Worktree 不是调度主实体」；Project / Task / Revision / Execution / Session / Attention / Verification / IntegrationBatch / Promotion / Reclaim / Knowledge；Runtime 单实例与 `0700` home + `0600` socket；FULL/STRICT；`main`/`dev` 双分支与 Task worktree 基线；**Task verification ≠ Integration verification**；调度三态 SAFE/UNKNOWN/CONFLICTING |
| `docs/guides/workflow.md` | 端到端走查（每步给真实命令与预期输出形状）：创建 → submit（含同命令内调度 pass）→ `task run` 与自动 tick → Attention 回答 / 散文提问 `resolve` → 修订与投递 → 成果提交 → 验证与定向测试记录 → `task integrate` → `promotion full-suite` + `prepare/approve/promote` + 重启 → `reclaim` → `events`/transcript 观察 |
| `docs/guides/features.md` | **功能清单**（用户要的「软件具有哪些功能」）：一行一能力 = 能力名 → 能做什么 → CLI 入口 → UI 位置 → 相关 ADR；覆盖任务、修订、会话/transcript、原生终端接管、结构化提问与散文提问等待、权限模式、长命令 Operation、调度与容量/槽位、影响分析与冲突判定、依赖 DAG、成果提交、任务验证与分层测试证据、集成批次、稳定提升、资源回收、Project Knowledge、事件订阅、Agent 配置、设置、Web UI；文末列「明确的未实现与未验证」 |
| `docs/guides/ui.md` | 界面说明：布局、任务工作台（列表/详情/新建停靠条）、Attention Inbox、执行过程与事件流、终端面板、调度/影响/容量面板、依赖、提升、transcript、Agent 配置、项目、主题设置；并写清 UI 与 CLI 是**同一命令面**、以及当前「只有 CLI」的能力清单 |
| `docs/guides/cli-reference.md` | **完整命令参考**：按命令组覆盖 `status` / `open` / `ui` / `stop` / `permission` / `agent config` / `project`（含 `impact`、`knowledge`）/ `task`（含 `revision`、`result`、`verify`、`tests`、`verification`、`operation`、`integrate`、`integration`、`depends`、`schedule`）/ `session`（含 `handoff`）/ `events` / `attention` / `settings` / `reclaim` / `scheduler` / `promotion`；含 `--json`、退出码语义、每个命令的常见稳定错误码；另有 HTTP/SSE 面（`/api/command`、`/api/events`）与游标语义、主要 domain 事件名清单 |
| `docs/guides/troubleshooting.md` | 常见症状与稳定码速查表，覆盖 `UI_ASSETS_MISSING`、`INVALID_CURSOR`、`PROVIDER_VERSION_UNAVAILABLE`、`ATTACHMENT_BUSY`、`WORKSPACE_RECLAIMED`、`TASK_NOT_EXECUTED`、`CONCURRENT_MODIFICATION`、`VERIFICATION_POLICY_CHANGED`、`DEV_FULL_SUITE_EVIDENCE_MISSING/NOT_PASSED/STALE`、`RECOVERY_REQUIRED` 类状态等；另附**文档与实现不一致清单**与「未验证/未实现」清单 |
| `README.md` | 「文档」一节新增「用户指南」入口，链到 `docs/guides/README.md` |

### 核对方法（一切事实来自代码）

1. `apps/cli/src/main.ts`：完整读了 `usage()`（第 934–1232 行）与整段命令分派（第 1232–3426 行），据此写出每个命令、参数、flag 组合与退出码路径（`process.exit(2)` = 用法错误、`3` = 等待/无可回收、`1` = 拒绝）。
2. `packages/contracts/src/index.ts`：核对请求 schema（命令名字面量、`limit` 上下界与默认值：`maxEventReadLimit=500`、`maxTranscriptEntryReadLimit=200`、`defaultTranscriptEntryReadLimit=100`、`defaultConcurrencyLimit=2`、`maxConcurrencyLimit=16`）、`runtimePingResultSchema` / `runtimeStopResultSchema`、`sessionHandoffEventTypes`。
3. `apps/runtime/src/**`：逐服务抽取实际抛出的稳定码，命令为
   `for f in <service>.ts; do grep -rhoE "new [A-Za-z]*Error\('[A-Z_]+'" apps/runtime/src/$f.ts; done`，
   得到 `task-control-service`（`CONCURRENT_MODIFICATION`/`TASK_NOT_FAILED`/`RECONCILE_REQUIRED`/`UNKNOWN_ADAPTER`）、`verification-service`、`integration-service`、`result-commit-service`、`promotion-service`、`reclaim-service`、`schedule-service`、`capacity-service`、`slot-reservation-service`、`session-handoff-service`、`knowledge-service`、`impact-analysis-service`、`operation-service`、`workspace-service`、`terminal-service` 的码表；另用 `grep -oE "failure\(request.requestId, '[A-Z_]+'" apps/runtime/src/main.ts` 取 dispatch 层拒绝码（`REPOSITORY_CHANGED`/`DEV_REF_MISSING`/`VERIFICATION_POLICY_CHANGED`/`IMPACT_POLICY_CHANGED`/`FULL_PERMISSION_REQUIRED`/`INVALID_AGENT_CONFIGURATION`）。
4. `packages/storage/src/migration.ts`：核对 Task / Execution / Workspace / Attention / IntegrationBatch / Promotion / RevisionDelivery 等状态 union（`CHECK(state IN (...))`）与 `attention_requests.kind`（`PERMISSION`/`QUESTION`/`RECOVERY`）。
5. `packages/storage/src/database.ts`：用 `grep -oE "'[A-Z][A-Za-z]+',[0-9]+,'[A-Za-z]+'"` 抽取实际写入 `domain_events` 的事件名，另取 `taskScheduleEventTypes`。
6. `apps/runtime/src/http-api.ts` + `event-subscription-service.ts`：核对 HTTP 状态码与错误码（`UNAUTHORIZED`/`FOREIGN_ORIGIN`/`UNSUPPORTED_MEDIA_TYPE`/`INVALID_REQUEST`/`INVALID_JSON`/`NOT_AVAILABLE_OVER_HTTP`/`UI_ASSETS_MISSING`）与排他游标语义（未知游标发 `INVALID_CURSOR` 帧并结束订阅，**不静默裁剪**）。
7. `apps/ui/src/**`：核对标签页名（任务工作台/待处理/调度/运行事件/Agent 配置/项目）、各面板标题与「只读」标注、`RuntimeClient` 走 `POST /api/command` 与 `GET /api/events`。
8. `PROJECT_SPEC.md` §1.1/§2/§3/§4 与 `docs/decisions/README.md`：只作为术语与不变量的权威来源**阅读**，未修改一个字节。

### 实际验证结果（本格只跑定向检查，未跑任何全量/聚合检查，遵守 ADR-0038）

1. **文档内链接存在性检查** —— 命令与输出：

   ```sh
   for f in README.md docs/guides/*.md; do d=$(dirname "$f"); \
     grep -oE '\]\([^)]+\)' "$f" | sed -E 's/^\]\(//; s/\)$//' | sed -E 's/#.*$//' | grep -E '\.md$' \
     | while read -r l; do [ -e "$d/$l" ] || echo "MISSING: $f -> $l"; done; done; echo "--- link check done ---"
   ```

   结果：输出仅 `--- link check done ---`，**没有 MISSING**（覆盖 `README.md`、`docs/guides/README.md`、`getting-started.md`、`concepts.md`、`workflow.md`、`features.md`、`ui.md`、`cli-reference.md`、`troubleshooting.md` 里的全部本地 `.md` 链接，含 `../decisions/*.md`、`../../PROJECT_SPEC.md`、`../architecture/*.md`）。

2. **文中 `codeestra …` 命令在 CLI 源码中的存在性核对** —— 从 `README.md` 与 `docs/guides/*.md` 抽出命令路径（`grep -ohE 'codeestra [a-z][a-z0-9-]*( [a-z][a-z0-9-]*){0,3}'`，去重得 91 条），把 `usage()` 文本（`sed -n '934,1232p' apps/cli/src/main.ts`）作为判据，对每条取**最长可命中前缀**：

   - 91 条去重命令路径中，4 条是**只有 group 的命令**（`open` / `status` / `stop` / `ui`）命中长度 L=1，其余 **87 条 L≥2**（含全部三段式如 `task revision delivery resolve`、`session handoff writer acquire`、`promotion full-suite run`、`scheduler reservations prepare-workspace`，以及 4 段式 `task revision delivery list|get|resolve`、`session handoff terminal read|write`、`session handoff writer acquire|release`）。
   - 几条例外停在更短的**合法前缀**上，因为 `usage()` 用「或」的写法列出取值：`permission set <full|strict>` 与 `settings prose-question-attention [auto|record-only|off]`（分别命中 `permission set` 与 `settings prose-question-attention`）。
   - 只有一条需要单独指出：`scheduler reservations get` 的最长命中是 2（`scheduler reservations`）——该子命令**不在 `usage()`**，但 dispatch 里有 `reservationAction === 'get'`、契约里有 `scheduler.reservations.get`（见下「文档与实现不一致」第 8 项）。这是本检查的非空洞证据。
   - 另做一次交叉检查：文中每个命令的 group/action token 都能在 `apps/cli/src/main.ts` 中找到，无 `NO-GROUP` / `NO-ACTION-TOKEN`。

3. **稳定码存在性核对** —— 从全部指南文本抽出 412 个 `[A-Z][A-Z0-9_]{3,}` 形式 token，反查 `apps/` 与 `packages/` 的 `*.ts`：

   ```sh
   cat docs/guides/*.md | grep -oE '\b[A-Z][A-Z0-9_]{3,}\b' | sort -u \
     | while read -r c; do grep -rqF "$c" apps packages --include=*.ts || echo "UNKNOWN: $c"; done
   ```

   结果：只有两项未命中，且**都不是错误码**——`AGENTS`（来自 `AGENTS.md` 文件名）与 `PROBLEM`（占位符 `<PROBLEM>`，真实码是 `INVALID_QUESTIONNAIRE_ANSWER:<PROBLEM>`）。**没有任何一个编造的错误码**。

4. **`bun run typecheck`（即 `tsc --noEmit`，非聚合检查）** —— 已执行：

   ```sh
   bun run typecheck
   # $ tsc --noEmit
   # exit=0
   ```

   通过。本格 `git status` 无 `apps/**`、`packages/**` 改动，因此这一步只用于证明「没碰到代码」。

5. **明确未执行**：`bun run check`、`bun run check:fast`、`bun run test`、`bun run test:unit`、`just check`、`just verify`、`bun run build:ui` 一律**未运行**——本格是纯文档，按 ADR-0038 开发分支只跑定向检查，全量测试只在 `dev` 准备提升到 `main` 时对精确 SHA 执行一次。

### 文档与实现不一致（如实标注，未静默改写规格或 ADR）

完整清单在 `docs/guides/troubleshooting.md` §3，共 10 项。要点：

- `README.md`「当前状态」段仍把**已实现**的自动 Scheduler、长命令后台化与进度事件、Task cancel/pause、revision 投递确认、原生终端接管、Integration/main 提升写成「尚未实现」，并声称「现有 Phase 1 `task.run` 代码仍按项目 `mainRef` 创建 worktree」——而 `apps/runtime/src/workspace-service.ts` 实际用的是 `project.devRef`（ADR-0018）。
- `README.md`「下一步」仍把已完成的 Task cancel 写作下一小步。
- `PROJECT_SPEC.md` §1 前的状态段（「`dev → main` 提升、Runtime 重启……仍未实现」）与同一文件 §2 不变量 14、§3 已落地的 ADR-0038/0039 描述**互相冲突**；按任务要求 `PROJECT_SPEC.md` 与 `docs/decisions/**` 只读，本格**未修改、也未替用户裁决**。
- `apps/cli/src/main.ts` 的 `usage()` 缺 `scheduler reservations get`，且 `session handoff attach` 用法行未列出实际被接受的 `--observer`。
- `intents.kind` 的 DB CHECK 允许 `CHANGE_PRIORITY` / `ANSWER_AGENT` / `SELF_MODIFICATION`，但**没有任何命令产生它们**；`task create` 也不接受 priority，因而调度排序里的「优先级降序」当前无法由用户改变。

本格的处理原则：**指南写源码事实**（例如 §14 明确写出 `reservations get` 可用），同时把不一致逐条列出，而不是让文档迁就过时描述，也不是改 README 去掩盖。

### 未验证 / 限制

- 本格**没有执行任何命令的真实运行**：所有「预期输出形状」来自源码（contracts schema 与 CLI 渲染代码），未在本机实际启动 Runtime、未创建 Task、未跑验证或提升。
- 未做 UI 目视或自动化确认（ADR-0008 禁止用桌面/键鼠自动化验证 UI）；`ui.md` 的面板结构来自 `apps/ui/src/**` 源码。
- `apps/ui/dist` 在本工作树不存在（gitignore 本地状态），因此 `UI_ASSETS_MISSING` 路径与 `bun run build:ui` 是**按源码描述**，未实测。
- 未验证 pi/codex/claude 是否真正读取 `knowledge-context.md`（源码事实是 Adapter 不消费 `knowledgeSnapshotRefs`，已如实写入 `features.md` 与 `troubleshooting.md`）。
- 只提交到 `lane/j1-user-guide`，未 push、未 rebase、未触碰 `main` 稳定工作树或其它 lane 的工作树。
## FOUNDATION-071 — Agent 插件可定制与自动检测（ADR-0044，schema v27）

用户原话：「需要可以定制化 agent，比如开启哪些插件，不开启哪些插件，最好有自动检测功能，在 agent 设定页面，就可以通过选择配置 agent 可以选用的模型/思考深度/插件开启等等模块。」

本轮交付（wave J 的 J2 格，`lane/j2-agent-plugins`，基线 `dev@54ff3049e7a4b3e85726210e39c71c6751403b37`）：

- **契约**：`packages/contracts/src/agent-plugins.ts` —— 四类选择（`extensions`/`skills`/`promptTemplates`/`themes`）严格 schema（绝对路径、无 `..`、非空白、无 NUL、每类 ≤64、未知字段拒绝）、检测候选/检测结果 schema、稳定 reason 枚举、`agentPluginTraceSchema`（类别 + 路径 + 来源层 + `thirdPartyExtensionApprovalRisk`）、Adapters 能力新增 `pluginSelection`。
- **存储**：schema **v27**，只追加 `IF (version < 27)` 的 `ALTER TABLE agent_configurations ADD COLUMN plugin_selection_json`（**不重建表**）；`AgentConfigurationRecord.pluginSelection`、读写整体替换语义；`executions.agent_config_json` 记录 `plugins` 留痕。
- **Adapter argv**：新增 `packages/agent-adapters/src/pi-plugins.ts`（`buildPiPluginArguments` 单一实现 + `inspectPiPluginPath`/`assertPiPluginSelectionUsable` 核验）；`pi-rpc.ts` 与 `pi-pty.ts` 共用同一参数块，插在 `--no-context-files` 之后；**零选择逐字节等于改动前**，gate/question extension 仍最先加载。
- **只读检测**：`apps/runtime/src/agent-plugin-detection-service.ts` —— 只读 provider 用户配置目录（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）+ 该目录 `settings.json`；绝不扫描仓库内目录、不跟随符号链接进入 Git 工作树、零写入；每项给出 kind/name/path/source/provider 启用状态/可启用性 + 稳定 reason。
- **命令面**：`agent plugins list`（候选 + 当前选择 + adapter 支持情况，`--json`）与 `agent plugins select`（重复 flag 写整份选择 / `--clear`；零确认、幂等、退出码 0/1/2）；`agent.config.set` 新增 `pluginSelection`；`agent.config.get` payload 增加选择与来源层。
- **UI**：新增 `apps/ui/src/agent-settings.tsx`（adapter/作用域/provider/model/思考深度/四类插件勾选/生效值与来源层/两条提示）；`App.tsx` 仅四处纯追加（Tab 类型、标签、导航项、渲染分支）。
- **文档**：`docs/decisions/0044-agent-plugin-selection-and-detection.md`（含 gate 风险如实说明、v27、稳定码、实测证据与未验证清单）。

验证（定向，ADR-0038；未跑全量）：`bun run typecheck`、`bun run typecheck:ui` 均 0 错误；新增 `packages/agent-adapters/test/pi-plugin-arguments.test.ts`、`packages/storage/test/agent-plugin-selection.test.ts`、`apps/runtime/test/agent-plugin-detection-service.test.ts`、`apps/runtime/test/cli-agent-plugins.test.ts`（e2e，独立临时 `CODEESTRA_HOME`/`PI_CODING_AGENT_DIR`，使用 `runtime-reclamation.ts` 回收）；回归定向 `cli-agent-config`、`database`、`agent-runtime-service`、`terminal-service`、`session-handoff-service` 全绿；真实 `pi` RPC `get_commands` 探测证明「关发现 + 显式路径」对 extensions/skills/prompt templates 生效（themes 未单独实测，如实标注为同构代码路径推断）。

剩余问题：

- 未用真实模型跑一次带插件选择的 `task.run`，「模型确实使用了所选 skill/theme」只有 argv 与命令面证据；未做第三方 extension 是否真能绕过 gate 的对抗验证。
- themes 的显式路径加载未单独实测（理由与保守性论证见 ADR-0044 D06）。
- Codex / Claude 的插件选择本轮如实报告 `UNSUPPORTED`，未实现。
- 保存时的路径核验意味着「将来才会出现的路径」不能提前保存；需要时重新保存即可（未做延迟核验）。
- 检测上限 512 候选，超限由 Runtime 边界拒绝（未做真实压力验证）。
## FOUNDATION-072 — 固定 shell：标题栏与工作空间不随内容滚动（Wave J / J3，无 ADR，无迁移）

状态：**已实现并提交到 lane 分支**（未 push、未提升 `main`、未重启稳定 Runtime）。纯 `apps/ui/**` 改动：无 ADR、无 schema 变更、无后端改动（`apps/**` 除 `apps/ui/**` 与 `packages/**` 零改动）、未新增依赖、未改 `App.tsx`。
基线：`dev = 54ff3049e7a4b3e85726210e39c71c6751403b37`。工作树：`/Users/loyage/Documents/codeestra-wt/j3-fixed-shell-layout`，分支 `lane/j3-fixed-shell-layout`。

### 用户原话（验收标准，一字未改）

> UI：标题栏和工作空间必须牢牢占住自己的位置，不会因为任务列表过长，就会导致往下滑动的时候这些东西就到屏幕外去了，任务列表过长理当只影响自己这一部分的滑动。

### 根因

`apps/ui/src/styles.css` 的 `.app` 用 `min-height: 100vh`：整页随内容长高，`body` 成了滚动容器，于是 `header.app-header`（标题栏）与 `aside.sidebar`（其 `nav-caption` 原文就是「工作空间」）会随页面滚动一起被推出视口。FOUNDATION-058 把任务列表从短的嵌套滚动框改成了页面滚动；本格改回「该滚的是哪一层」——不是页面，而是工作区那一列。

### 改法（只动布局段）

- **`.app`**：`min-height: 100vh` → `height: 100vh; height: 100dvh` 加 `overflow: hidden`；第二行由 `1fr` 改成 `minmax(0, 1fr)`（`1fr` 的 auto 最小值会把行撑开，等于把内容撑破固定视口）。
- **`.workspace-shell`**：成为唯一滚动容器（`overflow: auto` + `min-height: 0`）。任务列表、任务详情、banner、页脚、新任务停靠栏都在这一列里滚动，页头与侧栏不在其中。
- **`.sidebar`**：`min-height: 0; overflow: hidden` —— 自己占住位置、整体不滚；侧栏内部的可滚区域是 `.sidebar > nav`（`flex: 1 1 auto; min-height: 0; overflow-y: auto`），`sidebar-bottom`（主题、权限模式、事件流状态）留在侧栏底部。
- **窄屏 `@media (max-width: 850px)`**：`.app` 保持 base 的固定高度与 `overflow: hidden`，只把方向改成纵向 flex；`.app-header`/`.sidebar` 为 `flex: none`，导航条 `overflow-x: auto`，`.workspace-shell` 为 `flex: 1 1 auto; min-height: 0`。`1100px` 与 `620px` 断点未改。
- **未改** `App.tsx`（现有 `.app` 的直接子元素已是 `header` / `aside` / `.workspace-shell`，不需包装层）、未改主题机制（`data-theme`）、类名、文案与任何业务逻辑。本工作树里不存在 `settings.tsx`/`agent-settings.tsx`（J2/J4 的领地），未创建也未改动。

### 实际运行的检查与逐条结果（定向，ADR-0038）

| 命令 | 结果 |
|---|---|
| `bunx vitest run apps/ui/test/shell-layout.test.ts` | **8 passed (8)**，退出码 0（新增定向测试） |
| `bunx vitest run apps/ui` | **2 files / 33 passed**，退出码 0（`apps/ui` 全部 vitest，含既有 `scheduling-labels.test.ts`，证明新文件确实被收集） |
| `bun run typecheck:ui` | **退出码 0**（`tsc --noEmit -p apps/ui/tsconfig.json`） |
| `bun run build:ui` | **退出码 0**（Vite 构建成功，29 modules transformed） |
| 反向验证（临时把 `.app` 改回 `min-height: 100vh`、去掉 `.workspace-shell` 的 `overflow` 与 `.sidebar > nav` 的可滚区域后重跑同一测试） | **4 failed / 4 passed**；随后用备份原样还原，`git diff --stat apps/ui/src/styles.css` 复核改动完整 |

**未跑、也不该在本分支跑**：`bun run check`、`just check`、`just verify`、`check:fast`（ADR-0038：全量只在 `dev` 的精确候选 SHA 上跑），以及任何后端/全仓测试——本次没有后端改动。**构建与类型检查通过不等于布局正确**，两者都不能被引用为观感证据。

**测试登记**：`package.json` 未改（也就无需改）。`test:unit`/`test:e2e` 登记的是 `apps/runtime/test/**` 的 `bun test` 文件，而本次新文件走 `vitest.config.ts` 既有的 `include: ['packages/domain/**/*.test.ts', 'apps/ui/**/*.test.ts']`，与既有 `apps/ui/test/scheduling-labels.test.ts` 同一条路径；`bun run test`（`vitest run`）已包含它，`package.json` 里没有需要追加的测试列表项。此结论已由上面的 `bunx vitest run apps/ui` 实证（两个文件都被收集并通过）。

### 新增测试的边界（必须与上面的结果一起读）

`apps/ui/test/shell-layout.test.ts` 只锁定两类**结构/样式契约**，不证明观感：

- **样式契约**：按断点（1440 / 1000 / 800 / 600）合并 base 与命中的 `@media` 规则后断言——`.app` 最后生效的 `height` 是 `100dvh` 且存在 `100vh` 回退、`.app` 没有任何 `min-height`、`overflow: hidden`、grid row 含 `minmax(0`；`.workspace-shell` 为 `overflow: auto` 且 `min-height: 0`；`.app-header` 不声明 overflow、`body`/`html` 不声明 overflow（页面不是滚动容器）；`.sidebar` 为 `min-height: 0` + `overflow: hidden`，`.sidebar > nav` 桌面 `overflow-y: auto`、窄屏 `overflow-x: auto` + `overflow-y: hidden`，窄屏 header/sidebar 为 `flex: none`。
- **结构契约**：用既有依赖 `react-dom/server` 的 `renderToStaticMarkup` 渲染真实 `<App />`（`initialToken` 非空、无选中项目；只 stub `window.location.origin` 以便构造客户端，不驱动任何请求、不跑 effect、不新增依赖），再用测试内自带的极简标签栈读取器断言：`.app` 是唯一外壳根；`header.app-header` / `aside.sidebar` / `div.workspace-shell` 都是 `.app` 的直接子元素；header 与 sidebar **不是** workspace 列的后代；`main#workspace`（skip-link 目标）与 `.page-heading` 在 workspace 列内；header/sidebar 里原有控件（品牌、项目选择、主导航、外观选择、权限模式文案、`跳转到工作区` 链接）仍在。另有一条「守门」用例喂入人为嵌套的标记，证明读取器确实能识别 header 落在滚动列内（否则上面的断言可能因读取器失效而恒真）。
- **它不证明**：真实浏览器里的布局与叠放、滚动手感（触控、PageDown/空格）、窄屏折行与横向导航条、焦点环是否被新滚动容器裁切、`position: sticky` 停靠栏在新滚动容器内的表现、深浅主题观感、`prefers-reduced-motion`。本格**没有**使用 computer-use、浏览器自动化、OS 级键鼠或截图（ADR-0008）。

### 未验证 / 需要用户人工确认

1. 桌面：任务列表很长时向下滚动，标题栏与「工作空间」侧栏始终留在原位，只有工作区那一列在动。
2. 任务详情页很长（会话、事件流、终端面板）时同上。
3. 窗口很矮（例如 500px）：侧栏内部导航是否自己出现滚动条、侧栏底部（主题/权限/事件流状态）是否仍在。
4. 窄屏 ≤850px：标题栏不滚走、横向导航条可左右滑动、工作区列独立滚动；≤620px 的单列排布未退化。
5. 键盘：Tab 顺序仍为 skip-link → 标题栏 → 侧栏 → 工作区；`跳转到工作区` 仍把焦点与视图带到 `<main id="workspace">`；焦点环未被新滚动容器裁切。
6. 新任务停靠栏仍贴在可见工作区底部、不遮住上方内容（它仍是 `position: sticky`，现在相对新的滚动容器）。
7. 深浅主题与 `prefers-reduced-motion: reduce` 下的表现未变；`.task-title` 的 2 行截断未变。

### 未做（边界声明）

- 未 push、未 rebase、未合并新的 `dev`、未提升 `main`、未触碰 `/Users/loyage/Documents/codeestra`（稳定工作树）与其上的稳定 Runtime；未运行任何 Runtime/CLI 命令，因此未使用 `CODEESTRA_HOME=/tmp/ce-j3`。
- 未改任何业务逻辑、状态管理、命令面调用、后端文件，也未顺手重构与本次目标无关的样式。
## FOUNDATION-073 — 全局设置（界面效果）：Runtime 持久化 + CLI 命令面 + 设置页（ADR-0045，**无 schema 变更、不占迁移号**）

状态：**已实现，lane 分支 commit（未 push、未提升 `main`、未重启稳定 Runtime）。**
基线：`dev = 54ff3049e7a4b3e85726210e39c71c6751403b37`（未 rebase）。工作树：`/Users/loyage/Documents/codeestra-wt/j4-global-settings`，分支 `lane/j4-global-settings`。

用户原话：「需要全局设置功能，可以在界面中调整界面效果。」用户裁决：**范围 = 界面效果类设置；持久化 = Runtime（`CODEESTRA_HOME`）；CLI 必须完备**。因此本格把界面偏好从「某一个浏览器的 `localStorage`」升级为「这个 Runtime home 的一份设置」，并让 CLI 成为它的完整命令面。

### 五个键（键名固定，取值封闭，默认固定）

| 键 | 取值 | 默认 | 生效方式 |
|---|---|---|---|
| `theme` | `system` / `light` / `dark` | `system` | `document.documentElement.dataset.theme`（ADR-0015 语义不变） |
| `density` | `comfortable` / `compact` | `comfortable` | `data-density` + 追加的紧凑间距规则 |
| `fontSize` | `medium` / `small` / `large` | `medium` | 根字号 100% / 87.5% / 112.5% + `body { font-size: 0.875rem }` |
| `motion` | `full` / `reduced` | `full` | `data-motion`；`reduced` 追加与既有 `prefers-reduced-motion` 同效的规则 |
| `timeDisplay` | `relative` / `absolute` | `relative` | 任务列表更新时间的渲染 |

默认值**故意没有对应 CSS 规则**，所以「没做任何选择」与「本格之前」渲染完全一致。

### 修改

- **`packages/contracts/src/ui-settings.ts`（新）+ `index.ts`（纯追加）**：键/取值/默认值清单与 `uiSettingEntrySchema`/`uiSettingsViewSchema`；四个请求变体 `settings.ui.list|get|set|reset`（键与取值在契约层就是枚举）。
- **`apps/runtime/src/ui-settings.ts`（新）**：`$CODEESTRA_HOME/ui-settings.json` 的版本化严格 schema 读写（`version: 1`）、未知键/非法值/未知版本/损坏 JSON 一律 `INVALID_UI_SETTING`、临时文件 `rename` 原子替换 + 失败删临时文件并报 `UI_SETTINGS_WRITE_FAILED`、`0600`/`0700`、**每次读取都落盘（磁盘即真相）**。
- **`apps/runtime/src/main.ts`（纯追加）**：四个命令的处理（`get` 返回单键，`list`/`set`/`reset` 返回完整设置面）。
- **`apps/cli/src/main.ts`（纯追加）**：用法文本（四条命令 + 一段说明）、CLI 侧键/值校验（退出码 2）、四条命令的处理。
- **`apps/ui/src/ui-settings.ts`（新）**：纯函数（主题解析、`documentAttributesFor`、时间措辞、标签、CLI 提示）+ 设置 Context/hook；DOM 面窄化为一个结构化 `DatasetTarget`，所以该模块能在 Node 下被类型检查与单测。
- **`apps/ui/src/settings.tsx`（新）**：`UiSettingsProvider`（加载设置、应用到 `document`、共享状态）+ 设置页（每个键显示当前值/默认值/是否显式设置/来源/可取值 + 等价 CLI 命令 + 真实文件路径 + 「存在 Runtime，换浏览器/清缓存依然生效」的说明）。
- **`apps/ui/src/theme.tsx`**：`ThemeSelector` 保留，存储由 `localStorage` 改为 Runtime 设置；登录前的 token 表单保留一个**什么都不写**的即时预览。
- **`apps/ui/src/task-list.tsx`**：相对时间措辞原样搬到 `ui-settings.ts`，渲染改由 `timeDisplay` 选择。
- **`apps/ui/src/App.tsx`（最小追加）**：一个导航项（`settings`）、一处渲染分支、一层 Provider 包裹（两行）；未触碰 `.app`/`app-header`/`sidebar`/`workspace-shell` 的样式与 shell 结构。
- **`apps/ui/src/styles.css`（追加块）**：只在文件末尾追加 `data-*` 生效规则与设置页样式，全部带 `FOUNDATION-073` 注释。
- **`package.json`**：把 `cli-ui-settings` 追加进 `test:unit` 忽略列表与 `test:e2e` 列表（按既有字母序插入同一行，未重排其它条目）。
- **文档**：新增 `docs/decisions/0045-global-ui-settings.md`；`docs/decisions/README.md` 在 ADR-0043 行之后追加 0045 索引行（0044 留给 J2，按号段升序）。

### 实际运行的检查与逐条结果

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | **退出码 0** |
| `bun run typecheck:ui` | **退出码 0** |
| `bun run build:ui` | **成功**（`dist/index.html` + css 21.09 kB + js 392.65 kB） |
| `bun test apps/runtime/test/ui-settings.test.ts` | **8 pass / 0 fail**（60 断言，新文件） |
| `bun test apps/runtime/test/cli-ui-settings.test.ts` | **5 pass / 0 fail**（81 断言，新 e2e：真实 CLI + 真实 Runtime + 临时 home） |
| `bun run test apps/ui/src/ui-settings.test.ts`（vitest） | **9 passed (9)**（新文件） |
| `bun test packages/contracts/test/request.test.ts` | **20 pass / 0 fail**（契约边界回归） |
| `bun test ... --path-ignore-patterns='**/{cli-ui-settings}.test.ts'` | 只运行 `ui-settings.test.ts`（8 pass），确认新 e2e 确实被 `test:unit` 忽略列表排除 |
| 一次性 SSR 渲染检查（**未提交**，脚本跑完即删） | 用 `react-dom/server` 静态渲染设置页成功：6 行（5 个真实键 + 1 个故意混入的未知键都被渲染）、每行一个 `<select>`，当前值/默认值/是否显式设置/等价 CLI 命令/文件路径都在输出里。**这不是测试**：它需要把脚本放进 `apps/ui/` 才能避免解析到两份 React（workspace 里 `react-dom` 与其 peer `react` 的解析路径不同），而且没有任何断言与回归保护，所以没有留在仓库里。 |

新增覆盖的关键断言：默认值全景与「读不建文件」；单键写入后的文件内容与 `0600`；重复写入 **stdout 与文件字节都不变**；`reset <key>` 只去掉一个显式选择、`reset` 去掉全部；权限受限目录下写入失败报 `UI_SETTINGS_WRITE_FAILED`、**旧文件逐字节不变、无临时文件残留**；损坏/未知版本/未知字段/非法值 **读取与写入都拒绝且零写入**；**跨 Runtime 重启保持**（`stop` 前后 `status` 的 `bootId` 不同，值仍为显式设置）；**HTTP 命令面**（`/api/command`）读到与 CLI **逐字节相同**的设置面、HTTP 写入后 CLI 能读到、未知键/非法值在边界被拒（`INVALID_REQUEST`，HTTP 400）、损坏文件经 HTTP 得 `INVALID_UI_SETTING` 并可被 `reset` 修复；UI 单测覆盖主题解析/属性映射/DOM 属性写入与移除（结构化 dataset 替身）/相对与绝对时间/标签与文案回退/未知 key 的 CLI 提示。

### 未验证与已知缺口（不得当成已成立）

- **视觉/窄屏/动效观感只能人工确认**：本格未使用 computer-use、浏览器自动化、截图或桌面会话（ADR-0008），因此紧凑密度、字号三档、`reduced` 动效的**观感**与设置页在窄屏下的排布均无机器断言，需用户目视确认。
- **实机 `system` 主题切换未验**：`theme=system` 跟随系统主题变化只由 `documentAttributesFor` 的纯函数断言覆盖，未在真实浏览器里切换系统外观复验。
- **多标签页不实时同步**（如实记录）：Provider 只在挂载时读取一次，另一个标签页的改动不会推送到已打开的页面；「重新读取」或刷新会看到。ADR-0045 把它列为已知边界。
- **`UNKNOWN_UI_SETTING` 目前不可经传输层到达**：请求契约本身枚举了键与取值，未知键在 HTTP 面上先得到边界拒绝 `INVALID_REQUEST`（HTTP 400），在 CLI 上是用法错误（退出码 2）；该稳定码保存在设置层供直接调用者使用，并由模块级单测钉住。**不声称它是网络可达的。**
- **跨进程并发写**未加锁：同进程内读写同步因此不可能交错，跨进程是「最后一次完整替换胜出」，不会产生半截文件，但会丢失一次写入。
- **本格未运行任何全量/聚合检查**（ADR-0038）：`bun run check`、`bun run check:fast`、`just check`、`just verify` 均未运行；`bun run test`（vitest 全量）与 `bun run test:unit`/`test:e2e` 全量也未运行，只跑了上表列出的定向文件与 `bun run test apps/ui/src/ui-settings.test.ts`。

### 领地与未触碰

- 未改动他人的工作树与 `/tmp/ce-j1|j2|j3`；未改 `.app`/`app-header`/`sidebar`/`workspace-shell` 的样式与 shell 结构（J3 领地）；未新建 `apps/ui/src/agent-settings.tsx`（J2 领地）。
- 未改 `packages/storage/**`（**schema 仍 v26，`migration.ts` 未被触碰，未占迁移号**）；未改 `packages/domain/**`、`packages/git/**`、`packages/agent-adapters/**`。
- 未 push、未提升 `main`、未触碰 `/Users/loyage/Documents/codeestra` 与其上的稳定 Runtime；全程只用 CLI/命令面（无 computer-use / 桌面 / 浏览器自动化）。
- 夹具与进程已回收：手工冒烟测试用独立 `CODEESTRA_HOME=/tmp/ce-j4`（结束后已删除 `/tmp/ce-j4`、`/tmp/ce-j4-assets` 与临时脚本目录）；**可复现的 e2e 用例不写死 `/tmp/ce-j4`**，而是用回收辅助自己登记的临时 home（前缀 `ce-j4-home-`）——因为 `normalizeRuntimeEnvironment` 的安全底线要求测试 home 必须位于 `os.tmpdir()` 内，否则泄漏的 Runtime 无法归属到本工作树；`/tmp/ce-j4` 不满足该检查（macOS 上 `/tmp` → `/private/tmp`，与 `tmpdir()` 不同根）。
- **孤儿 Runtime 已核验归属后回收**：手工冒烟测试留下了 3 个本工作树的 Runtime 进程（home 为 `/tmp/ce-j4`，其中 1 个仍持有 lock、2 个已成为 ppid=1 且 home 已删的不可达孤儿）。逐个用 `cwd == 本工作树` + `argv` 含本工作树的 `apps/runtime/src/main.ts` + `CODEESTRA_HOME=/tmp/ce-j4` 核验归属，持 lock 的那个另核对 `startToken` 匹配，全部 `SIGTERM` 后确认退出（未用 SIGKILL），且**未触碰** `/Users/loyage/Documents/codeestra` 上的稳定 Runtime（pid 50758 保持运行）。

## Wave J 开发分支集成（J1 → J3 → J4 → J2，4 格经 Orca 受监督编排）

状态：**四格已按用户指定顺序合入 `dev`，合并时定向验证通过。** 未 push、未提升 `main`、未重启稳定 Runtime。

本波对应用户四项要求：①开发指南文档（教用户使用、软件有哪些功能）；②可定制 Agent（插件开关 + 自动检测 + agent 设置页）；③标题栏与「工作空间」必须固定、任务列表只影响自己这部分滚动；④全局设置功能（界面调整）。用户选择「开多个分支分别解决」+「Orca 受监督编排，并行 worker」。

### 固定提交与合并顺序

| 顺序 | 分支 | lane commit | `dev` 合并 | FOUNDATION / ADR / schema |
|---|---|---|---|---|
| J1 | `lane/j1-user-guide` | `732dea2` | merge `5f4ba66` | 070 / 无 / 无 |
| J3 | `lane/j3-fixed-shell-layout` | `17c31d6` | merge `8c0370d` | 072 / 无 / 无 |
| J4 | `lane/j4-global-settings` | `e16c116` | merge `9431c74` | 073 / **0045** / **v28 未占用，已释放** |
| J2 | `lane/j2-agent-plugins` | `4d228a5` | merge `eab66ce` | 071 / **0044** / **v27** |

基线固定 `dev@54ff3049e7a4b3e85726210e39c71c6751403b37`（四格同基线，未 rebase）。合并后 `phase1SchemaVersion = 27`。

### 冲突处置（全部人工解决，不采信自动合并结果）

共 6 处冲突：`packages/contracts/src/index.ts`（两侧 `export *` 都保留）、`docs/decisions/README.md`（ADR-0044 插到 0045 之前）、`docs/tasks/README.md`（提升记录 + 070→073 按号段升序）、`package.json`（`test:unit` 忽略列表与 `test:e2e` 列表取并集，唯一新增项是 `cli-agent-plugins`，并逐条核对列出的测试文件真实存在）、`apps/cli/src/main.ts`（合并成**一条** `@codeestra/contracts` 导入列表 + 保留 `AgentConfigurationView` 接口）、`apps/ui/src/App.tsx`（两个 import 都留、`Tab` union 与导航数组取并集，使 `plugins` 与 `settings` 两个标签都可达）。`apps/ui/src/styles.css` 由 git 自动合并（J3 布局段与 J4 自有 class 不重叠），逐行核对确认 J3 的 `.app`/`.app-header`/`.sidebar`/`.workspace-shell` 规则未被动过。

### 集成期发现并修掉的问题（各 lane 单独跑时看不到）

1. **根 `bun run typecheck` 在合并后变红（真实集成缺陷，`750e834` 修复）**：J3 新增的 `apps/ui/test/shell-layout.test.ts` 里 `import { App } from '../src/App.js'` —— 根 `tsconfig.json` 没有 `jsx` 也没有 DOM lib，因此 `bun run typecheck` 直接报 `TS6142`；而 `apps/ui/tsconfig.json` 的 include 只有 `src/**`，`typecheck:ui` **从来没有看过 `test/**`**。净效果是那个新测试文件在两个 project 里都**不被检查**，同时仓库级类型检查是红的。任何单格都看不到它：J3 被要求跑的是 `typecheck:ui` + `build:ui`，而该文件恰好落在 `typecheck:ui` 的 include 之外。修复：根 tsconfig `exclude: ["apps/ui"]`（UI 是独立的 TS project），`apps/ui/tsconfig.json` include `test/**` 并设 `types: ["bun"]`（该测试用 `node:fs` 读 `styles.css`）。修复后根与 UI typecheck 均退出码 0，并用**注入类型错误**反向验证 `typecheck:ui` 现在会报错（exit 2）——修复前它静默忽略。
2. **J2 的第一次尝试被用户中止，第二次是限时续作**：第一轮 50 分钟里一直在做 provider 实测与源码取证（工作树零改动），用户中止了其中一条长时间运行的命令（本机没有 `timeout`）。协调者把该 task 如实标为 `failed`，复用同一 worker 终端下发**限时续作**任务（禁止再读打包源码、每条第 ≤8 秒且强制 `kill`、60 分钟预算），并在续作任务里带上第一轮已确认的结论。FOUNDATION-071 的记录与 ADR-0044 的证据表来自这**两次**尝试，第二轮才产出提交。
3. **CI/测试纪律**：本波四格均未跑全量/聚合检查（ADR-0038）；协调者在合并树上只跑定向集 + 迁移/版本断言敏感集。

### 独立集成验证（在合并后的 `dev@eab66ce` 上执行）

- 根 `bun run test`（vitest）：**371 passed（12 文件）**；`bunx vitest run apps/ui`：**42 passed（3 文件）**。
- J2 定向 5 文件：**27 pass / 0 fail**；J4 定向 2 文件：**13 pass / 0 fail**。
- `packages/storage/test`（迁移/表约束）：**145 pass / 0 fail（10 文件）** —— v27 是纯追加，无「写死当前版本号」类失败。
- 版本/迁移断言敏感的 runtime e2e 6 文件（`cli-reclaim-batch`/`revision-delivery`/`verification-cancel`/`cli-knowledge`/`cli-targeted-tests`/`cli-impact`）：**42 pass / 0 fail**。
- `bun run build:ui`：退出码 0（`index-C8FIklpL.css` / `index-m5vIT_CQ.js`）。
- **诚实边界**：`750e834` 只改两个 `tsconfig.json`（无运行时代码）；修复后重跑了根与 UI typecheck（均 0），**测试集本身没有在该提交上重跑**。按 ADR-0038，提升 `main` 前必须在当时固定的精确 dev SHA 上重跑全量并以其证据为准，本节的数字不得当作提升证据。

### 未验证 / 已知缺口（不得当成已成立）

- **人工确认项**（按 ADR-0008 未使用浏览器/桌面自动化）：J3 的观感、窄屏、键盘焦点、触控与停靠栏表现；J4 的视觉/动效观感、实机 `system` 主题切换与多标签页同步；J2 设置页的视觉与真实 provider 下的检测列表。
- **J2 的推断项**：prompt templates 的「关发现 + 显式路径」有实测，**themes 的同类行为是推断未单独实测**（ADR-0044 D06 已标注）；真实模型下加载第三方 extension 是否真的能影响/绕过 gate **未做对抗验证**（只记录了风险事实）；命令面证据取自本机 `pi` **0.85.1**，而仓库 FOUNDATION-003/011/013 的 pin 是 0.84.4，差异未评估。
- **UI 信息架构重复（待用户裁决）**：新增的「Agent 设置」（`plugins` 标签，含 provider / model / thinking level / 插件）与既有的「Agent 配置」（`agent` 标签）编辑的是同一组 provider/model/thinking，功能重叠、命名易混；本波保留两者未擅自收敛。
- **未提升 `main`**：本波没有 IntegrationBatch 与领域 `PromotionRecord`（四个 lane 由协调者手工解冲突合入 `dev`），提升需要用户显式授权，并按 ADR-0038 在精确 dev SHA 上跑全量后推进。

## 用户裁决后的收口：Agent 标签合并为一页（用户 2026-09-15 裁决）

状态：**已实现、已提交**。Wave J 合并后遗留的信息架构重复（新增「Agent 设置」与旧「Agent 配置」编辑同一组 provider/model/thinking）按用户裁决收口：**合并为一页，删除旧标签**。

- 删除 `apps/ui/src/App.tsx` 的 `AgentTab` 组件、`agent` 标签项与渲染分支，以及只被它使用的 `thinkingLevels` / `sourceLabel` / `AgentConfigurationResolutionView` 导入。
- 旧标签的独有能力**没有丢**，已补进 `apps/ui/src/agent-settings.tsx`：①`agent.config.clear`（「清除该范围的模型配置」，按作用域）；②环境变量覆盖提示。
- 顺带修正一处继承来的不精确：`config.environment` 是「环境作用域解析出的字段值」（`{provider,model,thinkingLevel}|null`），**不是** env 变量名表；类型声明与页面文案都改为如实描述（`sources` 才说明哪个字段来自 `ENVIRONMENT`）。
- 验证：`bun run typecheck` 0、`bun run typecheck:ui` 0、`bunx vitest run apps/ui` **42 passed**、`bun run build:ui` 0（bundle 从 401.19 kB 降到 397.02 kB，与删除旧面板一致）；`bun test apps/runtime/test/cli-agent-config.test.ts` **4 pass**（确认 `agent.config.clear` 的请求形状与新页面一致）。
- 未验证：设置页的视觉与交互仍需用户人工目视确认（ADR-0008，未使用浏览器/桌面自动化）。

## 第三次真实 `dev → main` 提升（`main` `54ff304` → `c50730f`，12 个提交，Wave J + Agent 标签收口）

状态：**已执行并成功**（用户显式授权）。这是 Wave J 四格（ADR-0044/0045）与用户裁决的 Agent 标签合并进入稳定分支，也是**第一次真正跑通产品路径的全量证据机制**（`promotion full-suite run`，ADR-0039）的提升。

| 项 | 值 |
|---|---|
| 提升前 `main` | `54ff3049e7a4b3e85726210e39c71c6751403b37` |
| 提升后 `main` | `c50730f14aaa35f402d01430051853eb69840e41`（= 被验证的精确 dev 候选） |
| 推进的提交数 | 12 |
| 方式 | 在已检出的 main 工作树内 `git merge --ff-only c50730f…`（ref/index/工作文件同时前进，退出码 0；提升前后 `git status --porcelain` 均为 0 行） |
| 提升后 `phase1SchemaVersion` | 27 |
| 稳定库 schema | 提升前 `user_version = 26` → 新 Runtime 启动后 **27**；新列 `agent_configurations.plugin_selection_json`；`PRAGMA foreign_key_check` 0 行违规 |

### 提升前全量证据（ADR-0038 D03 / ADR-0039，**产品命令面**）

在**精确候选 SHA** 上用产品命令跑：

```sh
CODEESTRA_HOME=/tmp/ce-j-promote bun run codeestra promotion full-suite run <project-id> \
  --dev-commit c50730f14aaa35f402d01430051853eb69840e41 --json
```

| 字段 | 值 |
|---|---|
| `evidenceId` | `db1c24d6-3b58-4806-b34b-98038648a77b` |
| `devCommit` / `testedTree` | `c50730f14aaa35f402d01430051853eb69840e41`（两者相同） |
| `state` / `outcomeCode` | `PASSED` / `PASSED` |
| `policyDigest` | `7d72c8222a06d1159ee3c099b3aba698dc9ed163987af52e73a13a2e2c28799b` |
| `lockfileDigest`（`bun.lock`） | `08f20225891ab97b42352780d64aa31214ed60b80a3e095bc646a19a64ea9df8` |
| 执行的命令 | `bun install --frozen-lockfile`（timeout 600s）、`bun run check`（timeout 1800s），argv 读自项目 main ref 的 `.codeestra/policies/verification.json` |
| 墙钟耗时 | 6 分 03 秒 |
| 副本 | `copyRemoved: true`（成功后由 Runtime 删除隔离副本） |

这是 `promotion full-suite run` 自 ADR-0039 落地以来**第一次在真实仓库上运行**（Wave I 的记录曾把它标为未验收项）。

### 重启序列与证据（AGENTS.md 「重启 main 稳定服务」规程）

在 `/Users/loyage/Documents/codeestra` 按顺序执行，每步退出码均 0：

1. `bun install --frozen-lockfile` → 0（`Checked 65 installs across 84 packages (no changes)`）。
2. `bun run build:ui` → 0（`index-C8FIklpL.css` / `index-DvlOvtCM.js`）。
3. `bun run codeestra stop` → 0（旧 Runtime 退出：`holderAlive: false`、`present: false`）。
4. `bun run codeestra status` → 0：`status: "READY"`、`permissionMode: "FULL"`、`adapters: ["pi","codex","claude"]`、`activeSessions: []`。
5. `bun run codeestra ui --no-open` → 0；再次 `status` 得 `uiRunning: true`（AGENTS.md 要求 READY 与 uiRunning 同时成立）。带 token 的输出**未写入**任何文档、日志或提交。

| | boot id | pid |
|---|---|---|
| 提升前 | `5cc84fdd-e843-42bb-9d37-03c91a4ea3a9` | 50758 |
| 提升后 | `f12ec062-fec1-4733-9cbb-6eee225f000e` | 61512 |

boot 身份不同，且新进程确实运行新代码（启动后稳定库已迁到 v27、并出现 `plugin_selection_json` 列）。

### 记录与诚实边界

- **仍然没有产生领域 `PromotionRecord` 行**：本次走 AGENTS.md 规定的人工路径（main 工作树内 `git merge --ff-only <固定候选>`）。产品命令 `promotion prepare` 需要 `batchId` + IntegrationBatch 的集成验证证据，而 Wave J 的四个 lane 是协调者手工解冲突合入 `dev` 的，**没有 IntegrationBatch**，因此产品路径对该候选在语义上无法 prepare。这与前两次提升是同一个缺口，本次仍未补。
- **证据绑定的 policy 来自 `refs/heads/dev`**：注册在隔离 Runtime 里的项目是 `~/Documents/codeestra-dev`（检出 `dev`），因此 `project inspect` 报的 `mainRef` 是 `refs/heads/dev`。Wave J 未改动 `.codeestra/policies/verification.json`，main 与 dev 的策略内容与 digest 相同，故对本候选没有实际差别；但下一次若要严格绑定 `refs/heads/main` 的策略，应在 main 工作树上注册项目再跑证据。
- **证据只保留元数据与 digest**：`full-suite run` 不保留原始输出日志，成功的副本按设计被删除，因此本次没有可贴出的原始日志文件；可复核的是上面那张表的字段与 `promotion full-suite list`。
- 本记录是**提升之后**在 `dev` 上新增的提交，因此 `main != dev`（main 停在 `c50730f`，dev 比 main 多这一条记录提交）。下一次提升会把它一起带上。
- 未在 `main` 工作树上额外跑全量：`main` 与被执行全量的精确候选 SHA 完全相同、两边工作树 clean，额外再跑不增加信息（沿用前两次的处置）。

## FOUNDATION-074 — 文档校准：NEXT / roadmap / 架构 doc-sync（Wave K / K1，纯文档 + usage 文本）

状态：**已完成（lane 分支 commit，未 push、未提升 `main`、未重启稳定 Runtime）。**
基线：`dev = fa27b795ce8b9efdaaefe7367b0b93d2a1b516f9`（未 rebase）。工作树：
`/Users/loyage/Documents/codeestra-wt/k1-docs-calibration`，分支 `lane/k1-docs-calibration`。

用户 2026-09-15 裁决：Wave I/J 之后文档与实现出现三类漂移——`## NEXT` 的历史漂移、roadmap 没有回填阶段状态、架构文档落后于
FOUNDATION-046/047/048/049 与 Wave I/J 的 schema v25/v26/v27 及新命令面——因此开一格全面校准，并把 J1 在
`docs/guides/troubleshooting.md` §3 如实列出的 10 项不一致逐条处置。本格**不是**改规格去迁就实现，也**不是**把未验证的东西
写成已完成；每一条「已完成」都只依据**已合入 `dev` 的代码/命令面/事件/表结构**，不依据任何任务记录里的说法。

### 处置结果

| 目标 | 结果 |
|---|---|
| `## NEXT` 只保留真正剩余的事项 | 已重写该节。原 0–7 编号全部保留并逐条给出当前状态与依据；文末列出「本次从 NEXT 移除的条目及依据」 |
| roadmap 回填真实完成度 | `docs/roadmap/mvp.md` 每个 Phase 加「当前状态（截至本格）」小节；「阶段草案」措辞改为如实描述；未做能力与未验证项逐条标注 |
| 架构文档对齐实现 | `sqlite-schema.md`（补 v23/v24/v25/v27 的 DDL 记录、`phase1SchemaVersion = 26` → `27`）、`event-model.md`（补 `ProseQuestionAttentionResolved` 与 `TaskRetryRequested`）、`state-machines.md`（补 promotion 的 full-suite 证据模型、`pluginSelection` 能力位与 `UNSUPPORTED` 的如实声明）、`agent-adapter-api.md`（补 `pluginSelection` 维度与三个 Adapter 的实测值）。另修 `scheduler.md` 的「本基线里没有调度引擎」与 `architecture/README.md` 的 `phase1SchemaVersion = 21` 两处与实现不符的陈旧陈述 |
| J1 的 10 项逐条处置 | 8 项已修（含唯一一处代码改动：`usage()` 文本），2 项保留为「待裁决」（`PROJECT_SPEC.md` §1/§3 前后不一致；`intents.kind` 有三个没有任何 CLI 产生路径的取值），理由见 `docs/guides/troubleshooting.md` §3 |
| `README.md` 状态段 | 「当前状态」与「下一步」两段已按实现重写（J1 第 1–6 条的根因） |

### 唯一一处代码改动

`apps/cli/src/main.ts` 的 `usage()` 文本，只补上**确实存在但未列出**的命令（J1 第 8/9 条），并在同一 `usage()` 里给
`reservations list` 的说明段补一句 `get` 的语义：

- 新增一行 `scheduler reservations get <project-id> <reservation-id> [--json]`——契约
  `scheduler.reservations.get` 在 `packages/contracts/src/index.ts:1859`，分派在 `apps/cli/src/main.ts` 的
  `reservationAction === 'get'` 分支（子命令**可用**，此前只是没有列进用法）。
- `session handoff attach` 用法行补上 `[--observer]`——解析器接受 `--observer`，且默认 attachment kind 就是 `OBSERVER`
  （`let attachmentKind: 'WRITER' | 'OBSERVER' = 'OBSERVER'`）。

`git diff --stat` 只有这一个代码文件；其余改动全在 `docs/**` 与 `README.md`。**没有**改 `PROJECT_SPEC.md`、
`docs/decisions/**`、`.codeestra/**`、`AGENTS.md`，没有新增依赖或测试基础设施。

### 一个超出交付清单但为了避免自相矛盾而做的文档改动

交付清单列出的文档是 `docs/tasks/README.md`、`docs/roadmap/mvp.md`、`docs/architecture/*.md`、`docs/guides/troubleshooting.md`
与 `README.md`。本格另外改了 **`docs/guides/cli-reference.md`** 的两处，因为它们直接描述**本格刚修好的**那一处不一致：
§14 的注写着「`scheduler reservations get` 没有出现在 `usage()` 里」、§21 的「其他只在源码里出现的东西」表里列着同一行。
修完 `usage()` 后这两处会变成假话；就此把它当作**文档同步的一部分**改掉，并在交付说明里显式列出（不是静默改动）。
如果协调者认为这超出范围，这两处可单独回滚而不影响其它改动。

### 状态声明 → 依据（逐条列出实际运行的核对命令）

| 声明 | 依据命令 | 结果 |
|---|---|---|
| dev 基线改造已完成（ADR-0018）：Task worktree 从 `project.devRef` 建立 | `grep -n "devRef" apps/runtime/src/workspace-service.ts` | 命中 `93,120,172,312`（`devRef: project.devRef`、`inspectBaseRef(project.repoRoot, project.devRef)`） |
| 自动调度引擎已实现（ADR-0033） | `grep -n "CODEESTRA_SCHEDULE_TICK_MS" apps/runtime/src/main.ts`；契约 `grep -n "z.literal('task.schedule.run')" packages/contracts/src/index.ts` | `main.ts:465`（默认 5000ms）；`index.ts:1935` |
| 长命令后台化与进度事件已实现（ADR-0019/0027） | `task.verify --background` 在 `usage()`；事件写入名单含 `OperationProgressed`/`OperationSettled` | 用法行存在；两个事件名出现在 `packages/storage/src/database.ts` 的 `INSERT INTO domain_events` 名单 |
| Task cancel / pause / resume / archive 已实现（ADR-0016） | `grep -n "z.literal('task.cancel')" packages/contracts/src/index.ts` | `index.ts:1126`（pause/resume/retry/archive/unarchive 同族均在） |
| IntegrationBatch 与 dev→main 提升已是产品能力（ADR-0018/0022/0038/0039） | `grep -n "z.literal('task.integrate')\|z.literal('promotion.prepare')\|z.literal('promotion.fullSuite.run')" packages/contracts/src/index.ts` | `1266` / `1471` / `1559` |
| 原生终端接管已实现（ADR-0026） | `grep -rn "PTY" apps/runtime/src/session-handoff-service.ts` | 命中（`ptyTransport: 'IMPLEMENTED' \| 'UNSUPPORTED'`、`ptyResize: 'UNSUPPORTED'`） |
| reclaim 的未注册目录与跨项目批量已完成（ADR-0037） | `usage()` 的 `reclaim plan/apply/records` 含 `--all-projects`、`--unregistered`；schema v24 | 用法行存在；`unregisteredReclamationMigration` 在 `packages/storage/src/migration.ts` |
| `scheduler reservations get` 可用 | `grep -n "reservationAction === 'get'" apps/cli/src/main.ts` | 命中（`scheduler.reservations.get`） |
| 散文提问已升级为一等等待（ADR-0043/FOUNDATION-069） | `grep -n "ProseQuestionAttentionResolved" packages/storage/src/database.ts`；契约 `attention.resolve` | 事件在 `domain_events` 写入名单；契约 `index.ts:1320` |
| settings 与 agent plugins 命令组已实现（ADR-0044/0045） | `grep -n "z.literal('settings.ui.set')\|z.literal('agent.plugins.list')\|z.literal('agent.config.clear')" packages/contracts/src/index.ts` | `1354` / `978` / `984` |
| schema 当前是 v27 | `grep -n "phase1SchemaVersion" packages/storage/src/migration.ts` | `1:export const phase1SchemaVersion = 27;`，且迁移链以 `if (version < 27)` 收尾 |
| 三个真实 Adapter 与能力如实声明 | `grep -rn "pluginSelection" packages/agent-adapters/src/*.ts` | `pi-adapter.ts:65`（Pi 支持）、`codex-adapter.ts:76` 与 `claude-adapter.ts:96`（`UNSUPPORTED`）、`index.ts:183`（fake 为 `UNSUPPORTED`） |

### 实际运行的检查

| 命令 | 结果 |
|---|---|
| 文档内本地链接存在性（脚本见下） | `checked 73 files, 229 local links; broken: 0` |
| `bun run typecheck` | **退出码 0**（`tsc --noEmit`，在 `usage()` 文本改动之后运行） |
| `CODEESTRA_HOME=/tmp/ce-k1 bun run codeestra`（无参数→usage） | **退出码 2**（符合设计）；输出含 `scheduler reservations get <project-id> <reservation-id> [--json]` 与 `[--writer\|--observer] [--since <cursor>]`，证明新增用法行确实出现在用户可见的用法里 |
| 上表的核对命令（`grep`） | 全部命中，结果如上 |

链检查用的可复现命令（在仓库根目录执行；脚本对每个 `*.md` 取出行内链接的目标，跳过 `http(s)`/`mailto`，对相对路径按文件所在目录
解析并检查存在性）：

```sh
python3 - "$(pwd)" <<'EOF'
import os,re,sys
root=sys.argv[1]; os.chdir(root)
targets=[t for t in ['README.md','PROJECT_SPEC.md']
         +[os.path.join(dp,f) for dp,_,fs in os.walk('docs') for f in fs if f.endswith('.md')]
         if os.path.exists(t)]
pat=re.compile(r'\]\(([^)\s]+)\)')
bad=[]; n=0
for t in targets:
    base=os.path.dirname(os.path.abspath(t))
    for m in pat.finditer(open(t,encoding='utf-8').read()):
        link=m.group(1).split('#')[0]
        if not link or link.startswith(('http://','https://','mailto:')): continue
        n+=1
        if not os.path.exists(os.path.normpath(os.path.join(base,link))): bad.append((t,link))
print(f'checked {len(targets)} files, {n} local links; broken: {len(bad)}')
for t,l in bad: print('BROKEN',t,'->',l)
EOF
```

**未运行**（ADR-0038，本格是 `lane/*` 开发分支）：`bun run check`、`bun run check:fast`、`just check`、`just verify`、
`bun run test`、`bun run typecheck:ui`。本格只有文档改动与一处 CLI usage 文本改动，没有触及 UI 与测试基础设施；全量只在
`dev → main` 前对精确 `dev` SHA 运行。

### 保留为「未验证」（本格没有改变它们的结论）

真实 provider 的并发运行、真实 provider 的 revision ACK、真实模型下的暂停/恢复复验、themes 的显式路径加载
（ADR-0044 D06 明确标注为同构代码路径推断）、Provider 是否真的读取 Project Knowledge 物化文件、设置页与固定 shell 的观感
（ADR-0008 下只能人工确认）。这些全部保留在 `docs/roadmap/mvp.md` 的对应「当前状态」与 `troubleshooting.md` §4，未因功能
已实现而被抹掉。

### 未核实与待裁决（不得当成已解决）

- **历史记录里三处未转义的表格竖线**留下未改：`docs/tasks/README.md` 的 FOUNDATION-067 记录（约 3712/3716/3737 行）与
  `docs/guides/cli-reference.md` §253 行以内联 `knowledge validate|list|show|resolve`、`CONFLICT|CAPACITY` 写法把一个单元格拆成多个，
  渲染错位但**事实无误**。它们是本格之前就存在的；历史记录章节只允许在事实被证实后补注，不允许改写，因此本格**未动**，只在此登记。
- **`PROJECT_SPEC.md` §1 前状态段与 §3 前后不一致**：规格文件在本格只读（用户裁决），因此**未改**，保留在
  `docs/guides/troubleshooting.md` §3 并标「待裁决」。
- **`intents.kind` 的三个取值没有任何 CLI 产生路径**（`CHANGE_PRIORITY`/`ANSWER_AGENT`/`SELF_MODIFICATION`）：缩小 CHECK
  或补命令都属代码/规格变更，本格只改文档不改代码，因此保留为待裁决。
- **本格未核实**：历史记录章节里各条「已完成」的声明本身（本格只核对被本格改动的状态声明与 J1 的 10 项），以及
  `docs/architecture/*.md` 第 2–6 节的逻辑设计（第 8 节的实现记录才是权威）。

## NEXT — 最小可用纵向切片

本节的「已完成」只依据**已合入 `dev` 的代码/命令面/事件/表结构**（核对命令与结果见 FOUNDATION-074 的「状态声明 → 依据」表），
不依据任何任务记录里的说法。原 0–7 的编号保留在下面的对照表里；从剩余列表中移出的条目在文末单列。

### 仍然剩余

1. **真实验证 ADR-0016 的暂停 / 恢复**（原第 1 条）：在一次性临时仓库中用真实 provider 跑「启动 → 暂停 → 恢复 → 终止」，
   核对 provider 进程确实退出、`--session` 确实续接同一 conversation、超时进入 `RECOVERY_REQUIRED`。当前只有脚本 Adapter
   覆盖该编排；真实模型未复验（`docs/guides/troubleshooting.md` §4 第 2 条）。
2. **交接与原生终端的剩余能力边界**（原第 3 条的剩余）：跨交接权限模式**完整矩阵**、并行工具批次的安全点、PTY resize、
   真实模型在 TUI 中键入后交还自动化再复验。`session handoff *` 与 PTY 传输本身已实现（ADR-0026/FOUNDATION-046），
   其中 `ptyResize` 在 `apps/runtime/src/session-handoff-service.ts` 里如实声明为 `'UNSUPPORTED'`。
3. **修订投递的 provider 侧与 UI 投影**（原第 4 条的剩余）：真实 provider 的结构化 ACK 行为（需 Adapter 先实现
   `applyRevision`）、真实模型对投递提示的理解、修订/投递的 UI 投影。台账、命令面与启动收敛已实现（ADR-0028）；
   `apps/ui/src/**` 没有 revision/delivery 的专用视图。
4. **散文提问（prose question）的剩余面**（原第 6 条的剩余）：Codex 侧的事实层（`codex-adapter.ts` 未改动、不上报
   completion facts，因此 Codex 只漏报不谎报）、真实 provider 下「`Task WAITING_FOR_USER` + `Execution RUNNING` +
   `Session EXITED`」组合的复验、散文等待的 UI 投影（UI 目前只把它当一条普通 Attention 显示）。升级与
   `attention resolve` 已实现（ADR-0043/FOUNDATION-069）。
5. **多成员 IntegrationBatch**（原第 0 条的剩余）：`integration_batch_items` 表存在，但 `task.integrate` 每次只集成一个
   Task；批级 `STALE`、批级 `CANCELLED`、任务集合级集成仍是后续合约（见 `docs/architecture/state-machines.md` §4）。
   三次真实的 `dev → main` 提升都走 AGENTS.md 的人工路径；产品命令 `promotion prepare` 需要 IntegrationBatch 的集成验证
   证据，而这些批次没有产生它。
6. **Phase 2 验收矩阵里「两个 SAFE 任务真的同时跑」**：调度引擎本体已实现（ADR-0033），但真实 provider 的并发运行
   未完成受控验收（`docs/guides/troubleshooting.md` §4 第 1 条）。在此之前该验收项仍算未成立。
7. **Phase 6 的 provider 消费**：`project knowledge *` 命令面与 Execution 绑定已实现（ADR-0041/schema v26），但 Adapter
   尚不消费 `knowledgeSnapshotRefs`，因此「Provider 是否真的读取物化上下文」未验证。
8. **插件选择的真实验证**（ADR-0044）：真实模型下「确实使用了所选 skill/theme」目前只有 argv 与命令面证据；themes 的显式
   路径加载未单独实测（ADR-0044 D06 标注为推断）；第三方 extension 能否绕过 gate 未做对抗验证；Codex/Claude 的
   `pluginSelection` 如实为 `UNSUPPORTED`（**未实现**，不是待做的小尾巴）。
9. **观感类验收（ADR-0008 下只能人工确认，没有机器断言）**：设置页与五个界面设置键的视觉效果、紧凑密度/字号/`reduced` 动效的
   观感、固定 shell 在窄屏与矮窗口的表现、Agent 设置页在窄屏下的排布。
10. **Phase 7 Self Evolution 全部未开始**：Self Task、Candidate、自托管测试、`PROMOTABLE`、用户 Promotion、独立 bootstrap
    与恢复演练；不可逆 migration 与 bootstrap 自身更新的策略仍是 Phase 7 的阻塞决策。
11. **两处待用户裁决的不一致**（J1 第 7、10 条，见 `docs/guides/troubleshooting.md` §3）：`PROJECT_SPEC.md` §1 前状态段与
    §3 的前后矛盾（规格只读，本格未改）；`intents.kind` 允许 `CHANGE_PRIORITY`/`ANSWER_AGENT`/`SELF_MODIFICATION`
    三个没有任何 CLI 产生路径的取值。

### 原 0–7 编号对照

- **0. dev 基线（ADR-0009）**：**已完成**——`projects.dev_ref` 固定为 `refs/heads/dev`（ADR-0018），仓库无 `dev` 时 trust
  以 `DEV_REF_MISSING` 拒绝，workspace 从该 ref 的 OID 建立。`dev → main` 提升与重启**已是产品能力**（ADR-0022/
  FOUNDATION-042）并已**真实执行三次**（见「第一次/第二次/第三次真实 `dev → main` 提升」各节）。**剩余**见上面第 5 条
  （多成员批次）。
- **1. 真实验证 ADR-0016**：**仍未完成**，见上面第 1 条。
- **2. 长命令后台化与进度事件**：**已完成**（FOUNDATION-039/ADR-0019；verification 的 `CANCELLED` 与
  `OperationProgressed`/`OperationSettled` 由 FOUNDATION-047/ADR-0027 完成）。其最后一项剩余——「架构文档的 doc-sync
  （`state-machines.md`、`event-model.md`、`sqlite-schema.md`、`agent-adapter.md` 落后于 FOUNDATION-046/047/048/049）」——
  **由本格（FOUNDATION-074）完成**。仍剩余的是 `task.run` 的 provider 事件级进度（ADR-0027 D05 明确排除 token 字节）。
- **3. ADR-0010 Phase 3 技术 spike / handoff / PTY**：**spike 已完成**（FOUNDATION-040）；**Runtime 侧契约、incarnation
  与单 writer lease 已完成**（ADR-0023/FOUNDATION-043）；**PTY transport、successor 启动与 attach/detach/release 已完成**
  （ADR-0026/FOUNDATION-046）；**UI 终端面板已完成**（FOUNDATION-050）。**剩余**见上面第 2 条。
- **4. revision 投递确认与启动收敛**：**已完成**（ADR-0028/FOUNDATION-048，schema v19）。**剩余**见上面第 3 条。
- **5. 验证副本与失败现场回收**：**已完成**（ADR-0021/FOUNDATION-041）；当年列为剩余的「未注册目录的人工处理与跨项目批量
  回收」**已由 ADR-0037/FOUNDATION-062 完成**（schema v24，`reclaim … --all-projects --unregistered`）。本条**无剩余**。
- **6. 散文提问**：**识别与显式记录已完成**（FOUNDATION-056：稳定码 `PROSE_QUESTION_NO_TOOL_USE`）；**自动升级为一等
  Attention 已完成**（ADR-0043/FOUNDATION-069）。**剩余**见上面第 4 条。
- **7. Phase 2 并行调度主体**：**规格、分析器与容量原语已完成**（ADR-0030/0031/0032）；**调度引擎本体已完成**
  （ADR-0033/FOUNDATION-055：自动 tick、候选顺序、等待语义、`--allow-unknown`、§4 越界处置），**其 UI 投影已完成**
  （FOUNDATION-059）。**剩余**只有上面第 6 条的真实 provider 并发验收。

### 本次从 NEXT 移除的条目及依据

以下声明曾是「剩余」，本格依据已合入 `dev` 的代码/命令面/表结构把它们移出剩余列表（依据命令见 FOUNDATION-074 的对照表）：

| 原声明 | 移除依据 |
|---|---|
| 「剩余：真实 `main` 提升与稳定 Runtime 重启的实测」 | 已真实执行**三次**（`docs/tasks/README.md` 的「第一次/第二次/第三次真实 `dev → main` 提升」记录，第三次带 `promotion full-suite run` 的产品路径证据）。真实执行是**历史事实**，不是代码事实，故同时以记录与契约（`promotion.prepare`）交叉确认 |
| 「剩余：`task.run` 的架构文档 doc-sync」 | **本格完成**（四份架构文档已对齐，见 FOUNDATION-074 的处置结果表） |
| 「剩余：未注册目录的人工处理与跨项目批量回收」 | ADR-0037/FOUNDATION-062（schema v24）：`reclaim plan/apply/records` 支持 `--all-projects`、`--unregistered`、`--scan-root`、`--remove-unregistered`，并写入 `reclamation_records.source` |
| 「剩余：PTY transport 与 successor 进程启动、detach/reattach 编排、CLI attach」 | ADR-0026/FOUNDATION-046：`session handoff attach/detach/release/admit/terminal read\|write` 均在 `usage()` 与契约中，`ptyTransport` 声明为 `'IMPLEMENTED'` |
| 「剩余：handoff Operation / Session incarnation / 单 writer lease」 | ADR-0023/FOUNDATION-043 + schema v14（`session_incarnations`、`session_writer_leases`、`session_permission_requests`） |
| 「剩余：调度引擎本体（自动 tick、候选排序 + 冲突/容量判定接入、实际 diff 超出预测的处置、`--allow-unknown` 命令形态）与它的 UI 投影」 | ADR-0033/FOUNDATION-055（`task.schedule status/plan/explain/run/clear-unknown`、`CODEESTRA_SCHEDULE_TICK_MS`、`TaskImpactPredictionRevoked`）+ FOUNDATION-059 的 UI 投影 |
| 「剩余：token 级实时进度事件、verification run 的独立 `CANCELLED` 状态、取消后验证副本的回收」 | ADR-0027/FOUNDATION-047（`CANCELLED` 一等终态、schema v17 重建 CHECK、被取消副本走 ADR-0021 `reclaim`） |
| 「剩余：识别『Agent 不用工具、在散文里提问并结束轮次』的形态」 | FOUNDATION-056（`PROSE_QUESTION_NO_TOOL_USE` + `task status` 的 `executions[].session.completion.note`）与 ADR-0043/FOUNDATION-069（升级为一等等待） |
| 「剩余：把它自动升级为 Attention / `WAITING_FOR_USER`」 | ADR-0043/FOUNDATION-069（默认 `auto`；`codeestra settings prose-question-attention record-only\|off` 降级） |
| 「`## NEXT` 仍有历史漂移，属于单独一次 doc-sync/NEXT 校准格」 | 本格（FOUNDATION-074） |
| 「剩余：真实 `main` 提升与稳定 Runtime 重启的实测（需用户显式同意）、多批次合并提升、UI 投影」中的**UI 投影**一项 | FOUNDATION-050（promotion/dependency/terminal 投影） |
| 「剩余：Phase 2 并行调度主体…未经引擎前，Phase 2 验收矩阵里『两个 SAFE 任务真的同时跑』仍然未成立」中的**前半**（引擎未实现） | ADR-0033/FOUNDATION-055：引擎已实现；**后半（真实并发验收）仍然成立**，保留在上面第 6 条 |

### 需要用户裁决（本格不得自行决定）

- `PROJECT_SPEC.md` §1 前状态段与 §3 的前后矛盾：规格只读，改它需要用户裁决（保留在 `troubleshooting.md` §3 第 7 条）。
- `intents.kind` 的三个无产生路径取值：缩小 schema CHECK 或补命令都可能是正确答案，属产品/规格决策
  （保留在 `troubleshooting.md` §3 第 10 条）。
