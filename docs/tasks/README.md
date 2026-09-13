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

## NEXT — 最小可用纵向切片

1. 接入 outbox 长连接/事件订阅，使 CLI 或后续客户端能持续观察 Runtime 事件，并让长命令（含验证）可见进度。
2. 继续验证允许工具集、取消超时、真实事件重投与孤儿进程 reconcile；真实 Pi 与 fake 分别验收。
3. Phase 1 剩余交互面：Task cancel/pause、revision 投递确认，以及 Runtime 重启后对 stale ACTIVE Session 的启动 reconcile。
4. 验证副本与失败现场的回收：明确的 `prune`/归属校验与可追溯记录，避免长期堆积。
