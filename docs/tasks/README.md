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

- **占用了 schema v17**。本次先于预留 v16 的 C2 schema 改动合入，因此当前 dev 是 `phase1SchemaVersion = 17` 且没有 v16 迁移。数据库现在可能已被标记为 17，后续不得再插入 `if (version < 16)`（它会被既有 v17 数据库跳过）；C2 若需要 schema 变更必须使用下一个高于 17 的版本并提供相应升级测试。v16 保持未使用。
- **领地外的最小改动（需在交付说明中保留）**：`apps/runtime/src/reclaim-service.ts`（加 `CANCELLED` 到 failure scene，1 处分支）、`packages/storage/src/index.ts`（导出新迁移）、`packages/storage/src/database.ts` 的既有 `completeOperation`（对发布过进度的 Operation 追加 settle 事件，见 ADR-0027 D04）、`apps/ui/src/styles.css`（1 条 `.state-cancelled`）、`package.json`（测试分层清单）、以及 3 个既有测试文件的断言更新（其中 `task-dependencies.test.ts` 的字面量版本断言在 C2 的 v16 合入后必然失败）。
- **剩余（不得声称已完成）**：
  - `task.run` 的进度是步骤级 + settle，不含 provider 事件级进度；provider token/PTY 字节按 event-model §4 与 ADR-0013 永不进入 domain event（细粒度通道仍是只读的 `session.transcript`）。要加 provider 事件级进度需要 `agent-runtime-service.ts`/`agent-observation-service.ts`（C4 槽位），本格未改。
  - `integration_verification_runs` 没有 `CANCELLED` 状态（其 Operation kind 不可经 `task.operation.cancel` 触达）。
  - 重启时仍 `RUNNING` 的 run（含取消未确认）记 `ERROR/RUNTIME_RESTARTED`，不是 `CANCELLED`——重启无法证明静止。
  - 默认 100ms 合并会丢弃部分输出块观测（活跃度事实，不是完整输出日志）。
  - **`docs/architecture/state-machines.md` §1 的 Task Verification 状态列表与 `docs/architecture/event-model.md` §2 的事件目录尚未同步 `CANCELLED` 与 `OperationProgressed`/`OperationSettled`**；按 ADR-0019 的先例本格不动架构文档，已在 ADR-0027 显式记录该不一致，需一次 doc-sync。
  - 事件量未做并发/压力测量；未测多客户端同时订阅同一长命令的负载。

## NEXT — 最小可用纵向切片

0. ~~落实 ADR-0009 的 dev 基线~~：已由 ADR-0018 完成（`projects.dev_ref` 固定为 `refs/heads/dev`，仓库无 dev 时 trust 拒绝，workspace 从该 ref 的 OID 建立；已有 workspace 不回改）。~~剩余：`dev → main` 提升与重启~~：已由 ADR-0022/FOUNDATION-042 完成为产品能力（`promotion prepare/approve/promote`、fast-forward 已检出的 `main`、CLI 客户端执行 stop/status 重启序列、STRICT 批准失效、崩溃按 ref 事实 reconcile）。剩余：真实 `main` 提升与稳定 Runtime 重启的实测（需用户显式同意）、多批次合并提升、UI 投影。
1. 真实验证 ADR-0016：在一次性临时仓库中用真实 Pi 跑「启动 → 暂停 → 恢复 → 终止」，核对 provider 进程确实退出、`--session` 确实续接同一 conversation、超时进入 `RECOVERY_REQUIRED`；脚本 Adapter 不能替代该验收。
2. ~~长命令后台化与进度事件~~：已由 FOUNDATION-039 / ADR-0019 完成持久 Operation、步骤级进度、`--background` 与 `task.operation.cancel`（CLI + 同一命令面 + UI）。~~剩余：token 级实时进度事件、verification run 的独立 `CANCELLED` 状态、取消后验证副本的回收~~：已由 FOUNDATION-047 / ADR-0027 完成（`CANCELLED` 一等终态 + 重建表、被取消副本仍走 ADR-0021 `reclaim`、进度改为 `OperationProgressed`/`OperationSettled` 领域事件并经 `events list/tail` 与 UI 实时可见）。剩余：`task.run` 的 provider 事件级进度（PTY/token 字节不进事件，见 ADR-0027 D05）、架构文档的 doc-sync。
3. ~~ADR-0010 Phase 3 技术 spike~~：已由 FOUNDATION-040 完成（真实 Pi session-file 双向 RPC↔TUI 恢复、PTY 生命周期、safe-point fence 与权限模式 side channel，见 `docs/spikes/pi-session-handoff.md`）。~~handoff Operation / Session incarnation~~：Runtime 侧契约与状态已由 ADR-0023 / FOUNDATION-043 完成（STRICT 权限转既有 Attention、incarnation 绑定 + 原子拒绝过期决议、单 writer lease 的 `ATTACHMENT_BUSY`、安全点与 predecessor 归属核验、重启按事实 reconcile），并已合入 `dev`；`session handoff status/request/cancel/writer/admit` 的 `--json` 退出码稳定。剩余：**PTY transport 与 successor 进程启动、detach/reattach 编排、跨交接模式保持、并行工具批次安全点、CLI attach 与 UI 终端**（`session handoff admit` 目前只判定不启动，能力投影写 `terminalTransport: UNIMPLEMENTED`）。
4. revision 投递确认，以及 Runtime 重启后对 stale ACTIVE Session 的启动 reconcile。
5. ~~验证副本与失败现场的回收~~：已由 ADR-0021/FOUNDATION-041 完成（`reclaim plan/apply/records`、归属校验、append-only 账本、启动 reconcile、默认保留失败现场、不新增确认）；同轮决定 Attention 工具参数继续原样入库。剩余：未注册目录的人工处理与跨项目批量回收。
6. 识别「Agent 不用工具、在散文里提问并结束轮次」的形态（FOUNDATION-030 剩余的一半）：要么把它变成 Attention，要么至少不得记为未加说明的 `SUCCESS`。
