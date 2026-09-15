# 界面说明

Web UI 是**本地 Runtime 的便利前端**，不是另一个产品。

> **最重要的一条**：UI 与 CLI 是**同一个命令面**。界面向 `POST /api/command` 发送的请求体，与 CLI 通过 Unix socket
> 发送的是**同一个 Zod schema**；事件走 `GET /api/events` 的 SSE 流，与 `events tail` 是同一个订阅。
> 界面**不新增业务语义、不绕过门禁、不直接访问 SQLite**。

启动方式与地址见 [getting-started.md](./getting-started.md) 的「5. 打开 Web UI」一节（`bun run codeestra ui`）。

---

## 打开与令牌

- 地址形如 `http://127.0.0.1:<port>/#token=<32字节hex>`。token 放在 **fragment** 里——fragment 不会发给服务器，
  所以它不会进入任何服务端日志。
- 浏览器把它存进 **sessionStorage**（key 与本次 Runtime 启动绑定）。没有 token 时会显示一个只要求粘贴令牌的
  连接表单（「请再次运行 `codeestra ui` 并打开所显示的地址」）。
- **Runtime 重启会更换内存 token**：旧的带 token 链接会立刻失效，需要重新执行 `bun run codeestra ui`。
- 关闭页面**不会**停止 Runtime 或任何 Task。页面顶部会明确显示这一点（「本地运行 · 关闭页面不影响任务」）。

---

## 布局总览

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ 头部：品牌 · 当前项目选择器 · 刷新                                          │
├──────────────┬────────────────────────────────────────────────────────────┤
│ 侧边导航      │ 页面标题（项目名 eyebrow + 当前视图名）                      │
│ 任务工作台    │ 错误/提示横幅（有错才出现）                                  │
│ 待处理 (N)    │ ┌────────────────────── 主工作区 ──────────────────────┐    │
│ 调度          │ │  当前标签页的内容                                    │    │
│ 项目          │ │                                                     │    │
│ Agent 配置    │ │                                                     │    │
│ 运行事件      │ └─────────────────────────────────────────────────────┘    │
│ ─────────    │                                                            │
│ 主题选择器    │                                                            │
│ 权限模式      │                                                            │
│ 事件流状态 ●  │                                                            │
└──────────────┴────────────────────────────────────────────────────────────┘
```

侧边栏底部三个只读指示：

- **主题选择器**：亮/暗主题（纯前端偏好，**不进入命令面**、不改任何业务语义）。
- **权限模式**：`FULL · 全权限，零确认` 或 `STRICT · 严格模式`。
- **事件流**：`事件流 · live` / `reconnecting (n)`。断线自动重连，并用上次的**排他游标**续订，所以不会重复也不会漏。

「待处理」标签在有待回答请求时显示一个数字角标。

---

## 任务工作台

任务相关的一切都在这里；左侧列表 + 右侧详情。

### 任务列表

- 顶部是**任务概况**与快捷筛选（不含归档）。
- 搜索（按任务内容或 `#编号`）、按状态筛选、排序。
- 列表项显示状态徽标（中文），例如「草稿」「就绪」「运行中」「等待用户」「已阻塞」「失败」「已合入 dev」。

### 任务详情

标题是「任务 #<编号>」。详情按以下区块组织：

| 区块 | 内容 |
|---|---|
| 任务操作 | 提交 / 运行任务 / 暂停 / 恢复 / 重试 / 取消 / 归档 / 提交成果 / 验证任务 等（按当前状态启用；STRICT 下才出现旧的二次确认与 TRUST 输入） |
| 长命令进度 | Runtime 记录的**事实步骤**，含每步状态、观察到的输出块，以及「结果详情」折叠区；进度与取消说明 |
| 成果提交授权 | STRICT 下的 prepare/confirm 投影（FULL 不出现） |
| 执行、验证与集成记录 | 可折叠：执行记录（含 Session 状态）、验证记录、**集成记录 · dev** |
| Agent 会话与执行过程 | 选定一次 Execution，内含**原生终端与会话交接**面板 + **Agent 执行过程**（transcript）面板；没有 Session 时明确说明「没有执行过程可显示」 |
| 会话结束注记 | 被 Runtime 标注过的完成形态（例如 `PROSE_QUESTION_NO_TOOL_USE`）；它解释一次本来无法解释的 `SUCCESS`，**不**声称 Agent 在等你回答 |
| 依赖与 BLOCKED 原因 | **只读投影**，不写任务状态；逐条显示满足/未满足、要求的 revision、上游合入的 dev commit |
| 稳定提升记录 · dev → main | **只读**：promotion 列表与详情（含重启步骤与退出码） |
| 调度判定 | `task schedule explain` 的只读投影：依赖判定、与每个活跃/预留 Task 的冲突判定（含交叉路径）、容量数字 |
| 影响与冲突判定 | `project impact show` / `explain` 的只读投影（含 `UNKNOWN` 的说明） |
| 「更多操作」 | 低频率动作折叠在此，避免主线被噪声淹没 |

### 新建任务停靠条

底部常驻的**停靠条**：折叠时是一行输入（「新建任务内容」），展开后是详细设定（约束列表等）。
从任何标签页都可以创建草稿；创建成功后界面自动切回任务工作台，让新草稿立刻可见。

---

## Attention Inbox（待处理）

标题「需要你的回答」，右侧是未处理数量。**只暂停对应任务**。

按请求类型渲染不同控件（`kind` / `responseType`）：

| 请求 | 界面 |
|---|---|
| 结构化问卷（`QUESTION` + 问卷形态） | 逐题显示 `[题头] 题干`，单选/多选按钮 + 「自定义回答」文本框；底部可整体取消 |
| 确认类（`responseType = CONFIRM`） | 「允许」/「拒绝」两个按钮 |
| 文本类（`responseType = VALUE`） | 输入框 + 「发送」 |
| 任何类别 | 「拒绝回答此请求」（发送 `CANCEL`） |

已处理的部分收在「N 个已回答或已关闭」的折叠区里。回答提交后由 Runtime 投递给 Agent，**不需要离开工作台**。

> 被拒绝的问卷回答（越界选项、重复题号）会作为错误横幅显示，请求**保持 OPEN**——已答内容不会被吞掉。

---

## 执行过程、终端与事件流

### Agent 执行过程（transcript）

- 面板标题「Agent 执行过程」。内容来自 **Provider 自己的会话文件**，只读展示；
  不写数据库、不改任务状态。
- 显示工具调用与工具返回、助手文本、thinking、token 与成本。
- 长内容默认折叠，可展开；展开某项时可取回完整块。
- 运行中的 Session 由界面**自动增量轮询**。

### 原生终端与会话交接

- 面板标题「原生终端与会话交接」，与 **同一 CLI 命令面**（`session handoff …`）。
- 显示交接合同：provider incarnation 历史、单一 writer lease、安全点/围栏、准入决策。
- 终端投影区域按**不可信文本**渲染；写入是「输入」，不是「审批」。
- 与 CLI 一致：第二个 writer 会被拒绝（`ATTACHMENT_BUSY`），不会静默排队。

### 运行事件

- 标题「Runtime 事件流 · 全部项目」。
- 状态指示（`live` / 重连中）、当前**游标**、跟随开关、清空。
- 每帧显示 `sequence`、`eventType`、`aggregateType` 与 payload；调度类事件额外显示一句人读摘要。
- 界面明确写着：帧来自 CLI 使用的**同一订阅**，游标是**排他**语义，所以用它重连「既不会重复也不会遗漏事件」。

---

## 调度、影响与容量

「调度」标签页由两个面板组成，都是**只读投影 + 一次显式 tick**：

### 调度引擎

- **活跃集合**：占用槽位或正在运行的 Task；明确说明「不会因心跳过期或 UI 关闭而释放」。
- **候选顺序**：优先级降序，其次创建时间；并说明「提优先级不抢占」。
- **实际影响超出预测**：记录增长并请求安全暂停。
- **最近一次显式 tick**：`task schedule run` 的结果。

### 容量与槽位预留

- **显式设置上限**：项目级并发上限与每 Adapter 覆写；只有显式设置过的 Adapter 覆写才能清除。
- **当前占用者**：谁持有槽位及其证据。
- **槽位预留**：活跃预留 + 「--include-released 保留的审计行」；释放需要明确填写**原因**。
- **reconcile 观测**：`scheduler reservations reconcile` 的结论（boot 身份、释放/保留/`RECOVERY_REQUIRED`）。
- 预留详情展开后有**审计历史**。

### 任务详情里的相关面板

- **调度判定**：`task schedule explain`（只读，不启动任何东西）。
- **UNKNOWN 的显式单次放行**：`task schedule clear-unknown`（ADR-0030 D05）。
- **影响与冲突判定**：`project impact show / explain`；`project impact validate` 的映射状态在「项目」标签页。

---

## 项目

- **添加本地项目**：输入 Git 仓库绝对路径；FULL 下按钮直接是「添加此项目」，STRICT 下是「信任此项目」
  并要求输入 `TRUST`。
- **验证策略**：展示 `main` ref 上 `.codeestra/policies/verification.json` 的状态与逐条命令。
- **影响映射 · impact.json**：`project impact validate` 的只读投影（ADR-0031）。
- 项目级（不绑定某个任务）的**依赖**与**稳定提升记录**也投影在这里。

---

## Agent 配置

- 显示**当前生效**的 provider / model / thinking 及每一项的**来源**（环境变量 / 项目覆盖 / 全局默认 / 适配器默认）。
- **编辑范围**：全局默认 或 某个项目覆盖。
- 写入走 `agent.config.set/clear`（同一命令面）。配置**只影响此后新建的 Session**，并把当时生效的值记录在 Execution 上
  （`task status` 同样可以看到）。

---

## 界面 vs CLI：哪些只在一边

界面是 CLI 的**子集**（按第一原则，「只有 UI 能做」的能力才算缺陷；反过来「只有 CLI 能做」是明确允许的，
因为 CLI 必须完备）。以下能力当前**只有 CLI**：

| 能力 | 只有 CLI 的原因 / 现状 |
|---|---|
| `attention resolve`（散文提问等待的回应） | 界面尚无该控件；等待会以 `WAITING_FOR_USER` + 会话结束注记显示，退出方式在 CLI |
| `settings prose-question-attention` | 全局开关，界面未提供 |
| `reclaim plan/apply/records` | 破坏性命令面，界面未提供 |
| `promotion prepare/approve/promote/abandon` | 界面上的稳定提升记录是**只读**的 |
| `task tests record/show/history` | 界面只显示验证结果与策略来源 |
| `project knowledge validate/list/show/resolve` | 界面未提供 |
| `session handoff` 的 writer/admit/release 等控制命令 | 界面终端面板提供挂载/输入/交接的主要动作，完整控制面在 CLI |
| `scheduler reservations acquire/release/prepare-workspace` | 界面提供容量设置、预留查看与 reconcile；预留的获取/释放控制面在 CLI |
| `stop` / `permission set` | 界面显示权限模式但不改它；停止 Runtime 用 CLI |

`events.subscribe` 与 `runtime.ui` 这两个命令在 HTTP 上会被明确拒绝（`NOT_AVAILABLE_OVER_HTTP`）：
界面用 `/api/events` 做事件，用启动时的地址做 UI 端点，而不是通过命令面。

---

## 相关阅读

- 功能清单：[features.md](./features.md)
- CLI 完整命令参考（含 `/api/command`、`/api/events`）：[cli-reference.md](./cli-reference.md)
- UI 相关的 ADR：[0007](../decisions/0007-local-web-ui-entry.md)、
  [0013](../decisions/0013-read-only-agent-transcript-view.md)、
  [0015](../decisions/0015-task-workbench-and-themes.md)、
  [0017](../decisions/0017-new-task-dock.md)、
  [0031](../decisions/0031-impact-snapshot-and-deterministic-conflict-analyzer.md)、
  [0034](../decisions/0034-compact-task-workbench.md)
