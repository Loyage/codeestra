# 插图清单（图由用户提供）

> **适用版本** `dev@036cf68`（2026-09-15） · **schema** v28 · **最后校对** 2026-09-15
> 版本会前进：`dev@036cf68` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。

---

## 这份文件是什么

说明书 [manual.md](../manual.md) 与逐屏走查 [ui.md](../ui.md) 里放了**插图占位行**，形如：

```text
> 图：`03-task-workbench.png` — 任务工作台：……
```

占位行是**契约**：把对应文件放到本目录（`docs/guides/images/`），占位行就地生效，不需要改文档结构。

**仓库里不放自造的图**：不使用浏览器或桌面自动化截图，不生成示意图，也不引入任何图片处理依赖
（ADR-0008：开发与验收不获取用户电脑控制权）。**图由用户提供。**

### 命名约定

- `docs/guides/images/<文件名>`，全部小写 + 短横线 + `.png`；
- 文件名与占位行里写的名字**逐字一致**（本文件 §2 就是这张表）；
- 建议宽度 1200–1600px（2 倍图更清楚），深色与浅色各拍一次时用 `-dark` 后缀另存，
  并在对应条目里注明它替换的是哪一张。

### 拍图的通用建议

- **只拍界面本身**，不要包含 token、终端提示符里的用户名、账单信息或任何密钥；
  token 在 URL fragment 里、不会出现在页面内容里，但**地址栏也请不要入镜**。
- **用真实数据但可公开的数据**：Project 名、任务规格用示例仓库；不要用你的私有仓库内容。
- 需要展示「有内容」的状态时，先按 [acceptance-checklist.md](../acceptance-checklist.md) §1 准备一个样例项目。
- 拍「只读投影」类图时，顺便把界面上的只读提示文字一起拍进去（那是它们最该被记住的部分）。

---

## 建议插图清单

### 概述

| 文件名 | 该图要拍什么 | 图注文字 | 用在 |
|---|---|---|---|
| `00-overview.png` | 一张概念图：用户意图 → Task → 依赖/冲突判定 → 调度 → 独立工作树 → Coding Agent → Task 验证 → 合入 dev → 集成验证 → 稳定提升 → 重启 Runtime。可以是流程条，不要求是界面截图 | Codeestra 的总流水线：你管理产品意图，Runtime 管理软件工程 | [manual.md](../manual.md) §1 |

### 装好它

| 文件名 | 该图要拍什么 | 图注文字 | 用在 |
|---|---|---|---|
| `00-token-form.png` | 无令牌时的连接表单：「Codeestra」标题、说明文字（请再次运行 `codeestra ui` 并打开所显示的地址…）、令牌输入框与「连接」按钮。**不要拍到地址栏** | 没有令牌时的连接表单：界面只要求你粘贴 Runtime 输出的令牌 | [ui.md](../ui.md) §0 |
| `01-first-run.png` | 终端里 `bun run codeestra status` 的输出，能看清 `pid`、`bootId`、`status: READY`、`permissionMode`、`adapters` 与 `ownership` 一段 | `codeestra status`：它会自己把 Runtime 拉起来，然后只报事实 | [manual.md](../manual.md) §2.2 |
| `14-dev-banner.png` | dev 构建的界面顶部：整宽橙色横幅（`开发版 DEV` / `非稳定代码…`）+ 品牌区的 `Codeestra DEV` | dev 构建的通道标记来自构建期变量；不加它就没有标记 | [manual.md](../manual.md) §2.5 |

### 第一个项目与第一个任务

| 文件名 | 该图要拍什么 | 图注文字 | 用在 |
|---|---|---|---|
| `02-project-trust.png` | 「项目」标签页的「添加本地项目」区块：路径输入 + `检查项目`、仓库身份表（仓库根目录 / main 引用 / 对象格式 / HEAD）、验证策略命令表，以及底部的添加（或信任 + TRUST 输入）区块 | 接入项目：先看清 Runtime 读到了什么，再确认 | [manual.md](../manual.md) §3.3、[ui.md](../ui.md) §5.1 |
| `12-new-task-dock.png` | 停靠条**展开**状态：多行规格文本域、约束列表（含 `＋ 添加约束`）、任务类型下拉框、`＋ 创建草稿` 与 `收起 ⌄` | 底部停靠条：收起时一行输入，展开后是完整设定 | [manual.md](../manual.md) §4.1 |
| `03-task-workbench.png` | 任务工作台列表：顶部四个计数卡（全部任务 / 执行中 / 需要你处理 / 成果已提交）、搜索与筛选行、几行任务（`#编号`、规格摘要、元信息、状态徽标与提示、「查看详情 →」） | 任务工作台：概况筛选 + 搜索 + 状态徽标；`RUNNING` 不代表进程心跳 | [manual.md](../manual.md) §4.5、[ui.md](../ui.md) §2.2 |
| `04-task-detail.png` | 任务详情上半部分：`← 返回任务列表`、`任务 #N` 与状态徽标、`下一步` 提示行、任务操作按钮组，以及规格正文与约束列表 | 任务详情：「下一步」那一行按状态告诉你该做什么 | [manual.md](../manual.md) §6、[ui.md](../ui.md) §2.3 |

### 看它干活

| 文件名 | 该图要拍什么 | 图注文字 | 用在 |
|---|---|---|---|
| `05-attention.png` | 「待处理」标签页的一张问卷卡片：标题 `需要你的回答` 与数量角标、题号与题干、单选/多选选项与说明、`自定义回答` 输入框，底部 `发送 N 个回答` 与 `拒绝回答` | 待处理：回答提交后由 Runtime 投递给 Agent，不需要离开工作台 | [manual.md](../manual.md) §5.1、[ui.md](../ui.md) §3 |
| `06-transcript.png` | `Agent 会话与执行过程` 区块里的执行过程子面板：`排列` 下拉框、单行时间线条目（类型标签 + 摘要 + 时间）、展开后的分段正文与「展开全文」按钮 | 执行过程来自 Provider 自己的会话文件：只读展示，不改任务状态 | [manual.md](../manual.md) §5.3、[ui.md](../ui.md) §2.3(k) |
| `07-terminal.png` | 「原生终端与会话交接」面板：会话/incarnation/写入租约/side channel 键值表、`安全点与 fence` 四条事实、四个按钮、原生终端投影区与写入行 | 终端是 Runtime 自己持有的真实 PTY；写入终端**不是**审批通道 | [manual.md](../manual.md) §5.4、[ui.md](../ui.md) §2.3(k) |
| `09-events.png` | 「运行事件」标签页：状态指示（实时/正在重连）与游标、`停止跟随`/`清空`，以及几帧带 `sequence`、`eventType`、`aggregateType` 与 payload 的事件 | 运行事件：与 CLI 同一个订阅，游标是排他语义 | [manual.md](../manual.md) §5.5、[ui.md](../ui.md) §7 |

### 验证与发布

| 文件名 | 该图要拍什么 | 图注文字 | 用在 |
|---|---|---|---|
| `15-promotion-record.png` | 「稳定提升记录 · dev → main」表格与打开后的详情卡，含 `Runtime 重启` 的步骤表（步骤 / 命令 / 退出码 / 耗时 / 输出） | 提升记录是只读的：main 已移动不等于 Runtime 已完成重启 | [manual.md](../manual.md) §9.2 |

### 日常使用

| 文件名 | 该图要拍什么 | 图注文字 | 用在 |
|---|---|---|---|
| `08-schedule.png` | 「调度」标签页：调度引擎（adapter / 调度循环 / draining / 最近一次 tick / 容量一行）、活跃集合表、候选顺序卡片（含等待块与命中路径）、容量与槽位预留表 | 调度：冲突等待与容量等待都不是 BLOCKED；BLOCKED 只表示依赖未满足 | [manual.md](../manual.md) §10.4、[ui.md](../ui.md) §4 |

### 设置

| 文件名 | 该图要拍什么 | 图注文字 | 用在 |
|---|---|---|---|
| `10-agent-settings.png` | 「Agent 设置」标签页：adapter 与作用域下拉框、`当前生效值` 表（字段/值/来源）、插件候选勾选列表、`编辑并保存` 区与三个按钮 | Agent 设置：只对新建 Session 生效，生效值会写进 Execution 记录 | [manual.md](../manual.md) §11.3、[ui.md](../ui.md) §6 |
| `11-settings.png` | 「设置」标签页的「界面效果」：五个键各一行（中文名 + 键名 + 说明 + 下拉框 + 当前/默认/是否显式设置 + `恢复默认`）与每行下方的等价 CLI 命令 | 设置存在 Runtime 里，CLI 与界面读写同一份值 | [manual.md](../manual.md) §11.2、[ui.md](../ui.md) §8 |

### 观感类（配合人工核对清单）

| 文件名 | 该图要拍什么 | 图注文字 | 用在 |
|---|---|---|---|
| `13-narrow-layout.png` | 窗口宽度 ≤850px 时的界面：标题栏保持不动、导航变成横向一条、侧栏底部三个指示折行显示。**建议同时拍一张深色版**（`13-narrow-layout-dark.png`） | 窄屏下外壳仍然稳住：标题栏与导航不随内容滚动，只有工作区滚动 | [ui.md](../ui.md) §1.4；核对条目见 [acceptance-checklist.md](../acceptance-checklist.md) §3.B |

---

## 加图时的做法

1. 把文件按上面的名字放进 `docs/guides/images/`。
2. **不要改占位行**——它的文件名已经和这张表对上。若确实需要改名：同时改占位行与这张表，两处必须一致。
3. 若某一节还没有占位行，就在该节末尾加一行 `> 图：` 格式的占位行，并在这张表里登记。
4. **不要**把图提交进 `.codeestra/**`、不要放进 `apps/ui/dist`、不要新增图片处理工具或脚本。

---

## 相关阅读

- 从头读到尾的说明书：[manual.md](../manual.md)
- 逐屏 UI 走查（占位行的上下文）：[ui.md](../ui.md)
- 人工观感核对清单（图和清单是一对）：[acceptance-checklist.md](../acceptance-checklist.md)
- 为什么不用自动化截图：[ADR-0008](../../decisions/0008-efficiency-first-service-form.md)、
  [ADR-0050](../../decisions/0050-user-manual-and-doc-sync-discipline.md) D06
