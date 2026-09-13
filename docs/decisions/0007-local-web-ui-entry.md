# ADR-0007：本地 Web UI 入口（`codeestra ui`）

Status：Accepted（用户本轮明确选择"本地 Web UI"，并要求首版包含运行任务/成果 commit/验证按钮）；**Amended by ADR-0008**：UI 定位为便利层——CLI 必须完备且优先，出现“仅 UI 可用”的能力视为缺陷；UI 仍走同一命令面、不绕过任何门禁。

## Context

`PROJECT_SPEC.md` §6 记录"首个可用入口为自动启动该后台 Runtime 的 CLI，后续桌面作为可重连客户端"，§8 记录本轮"不实现完整桌面交互"。用户本轮要求"可以运行的、有 UI 界面的软件"，并选择本地 Web UI、首版含运行 Agent 的按钮。这是对既有阶段范围的显式推进，因此记录为决策而不是实现细节。

既有约束仍然有效：Runtime 只服务本机单用户；不监听公网；项目首次接入需显式信任；成果 commit 与 main 提升需要用户确认；Agent 敏感操作逐次审批；关闭客户端不终止任务与 Session。

当前已具备的前置件：本用户 0600 Unix socket、一次性命令 dispatch、只读事件订阅长连接（`events.subscribe`，排他游标）、Attention typed answer、`task.run`/`task.result.*`/`task.verify` 应用服务。

## Options

1. 本地 Web UI：Runtime 惰性启动一个只绑定 `127.0.0.1` 的 HTTP + SSE 服务，托管 Vite 构建的静态资产；`codeestra ui` 打印带一次性 token 的地址。
2. Tauri 2 桌面壳：Rust 侧直接连 Unix socket，不开放 HTTP 端口。
3. 终端 TUI：在 CLI 内用事件订阅渲染可操作面板。

## Decision

选择方案 1。

- 新增 `apps/ui`（React + Vite，规格 §6 指定的前端方向），构建产物由 Runtime 托管。选择同一套 Web 资产而非先做 Tauri，是因为它可以被后续桌面壳直接复用，而 Tauri 需要额外的工具链与打包流程，会推迟"有可操作界面"这一目标。
- Runtime 新增 `runtime.ui` 命令：**按需启动**本机 HTTP 服务（缺省绑定 `127.0.0.1`，端口由系统分配），不在 Runtime 启动时默认开端口。
- token 每次启动随机生成，**只存在于 Runtime 内存**，经既有 0600 socket 由 `codeestra ui` 取得，不写入磁盘、不写入事件或日志。`codeestra ui` 打印的地址把 token 放在 URL fragment（`#token=…`）里，fragment 不会发送给服务器；前端把它移到 `sessionStorage` 并立即清除地址栏 fragment。
- 数据接口一律要求 `Authorization: Bearer <token>`（常量时间比较）。事件流使用 `fetch` + 流式读取（SSE 帧格式）而不是 `EventSource`，因此 token 从不进入 URL 或服务器访问日志路径。静态资产（HTML/JS/CSS）不含业务数据，可不带 token 获取。
- 不发送任何 CORS 头；对非 GET 请求要求 `application/json`，并对存在的 `Origin` 做同源校验。所有响应 `Cache-Control: no-store`。
- UI 与 CLI 复用同一 `dispatch` 与同一事件订阅 Hub：UI 不引入新的业务语义、不绕过任何确认（trust、成果 commit、验证仍需用户显式确认），也不新增可以绕过门禁的旁路。
- 首版 UI 提供：项目 inspect/trust（两步确认与策略展示）、任务 create/list/submit/status、Attention Inbox（confirm/value/cancel）、`task run`、`task result prepare`/`commit --confirm`、`task verify`、实时事件流。
- 运行任务按钮触发的是既有同步 `task.run`：界面用事件流展示进度，请求本身在 Agent 结束前保持打开；长命令后台化与 Task cancel 仍未实现，界面必须显式说明这一点而不是伪装可暂停。

## Consequences

- Runtime 首次在本地开放 HTTP 监听。边界是 `127.0.0.1` + token + 同源校验；token 泄漏等价于本机同用户权限，因此不写入磁盘、不记日志，并且只在用户显式运行 `codeestra ui` 后存在。
- 关闭浏览器不终止 Runtime、Task 或 Session；重新打开需要重新运行 `codeestra ui` 取新 token（旧 token 在 Runtime 停止后失效）。
- UI 无法在核心能力之外制造事实：真实 Agent 工具执行、权限门禁、取消超时仍未验收，界面只是触发器与观察面；失败与 `RECOVERY_REQUIRED` 必须原样展示。
- 没有 cancel/pause 按钮：`Task cancel` 仍是 NEXT 项。用户当前的停止手段只有关闭 Runtime（会释放自有 provider 进程，但不证明工具已静止）。
- `apps/ui` 需要前端依赖与构建步骤：`just verify` 包含 UI 类型检查与构建，避免"未构建却被当成可用入口"。
- 静态资产缺失（未构建）时 `codeestra ui` 明确报错并提示构建命令，不回退到伪界面。

## Verification

- HTTP 边界测试：缺失/错误 token 拒绝；`Origin` 不同源拒绝；非 JSON 的 POST 拒绝；只绑定 `127.0.0.1`；shutdown 后端口释放。
- 事件流：SSE 帧复用 `events.subscribe` 的排他游标语义，重连带 `Last-Event-Id`/cursor 不重复不丢失；Hub 关闭时流结束。
- UI 构建产物可被 Runtime 托管并通过 HTTP 取得；`codeestra ui` 打印的地址可直接打开。
- `runtime.ui` 幂等：重复调用返回同一地址与同一 token；未显式调用时不监听任何端口。
- UI 中每个写操作都对应一次既有 IPC 命令，且与 CLI 行为一致（同一 dispatch 路径）。
- 真实 Agent 端到端验收仍按 `docs/tasks/` 记录单独执行，UI 的存在不改变其验收状态。
- 本 ADR 记录的"真实浏览器验证"方式自 ADR-0008 起不再使用：验收改为 headless 命令面/HTTP 断言加用户在场人工确认，不获取电脑控制权。

## Related

- `PROJECT_SPEC.md` §6 / §8
- `docs/architecture/event-model.md` §3.1（订阅传输）
- ADR-0004（CLI 入口、自动启动 Runtime、项目信任）
- ADR-0003 / ADR-0006（成果 commit 与 Task verification 的确认要求）
