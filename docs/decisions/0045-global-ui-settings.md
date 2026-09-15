# ADR-0045 — 全局界面效果设置：Runtime 持久化 + CLI 命令面 + 设置页

状态：**Accepted**（用户就范围、持久化位置与「CLI 必须完备」逐条拍板；五个设置项的键名、取值与默认值由本 ADR 固定）。
任务：FOUNDATION-073。基线：`dev = 54ff3049e7a4b3e85726210e39c71c6751403b37`（Wave J / `lane/j4-global-settings`）。**无 schema 变更、不占迁移号。**

## 背景

用户原话：「需要全局设置功能，可以在界面中调整界面效果。」

用户裁决：**范围 = 界面效果类设置；持久化 = Runtime（`CODEESTRA_HOME`）；CLI 必须完备。**

现状（本格基线上实测）：

- `settings` 命令组只有一项 `settings prose-question-attention`（FOUNDATION-069 / ADR-0043），其存储是
  `$CODEESTRA_HOME/prose-question-attention.json` 的版本化 JSON（`version: 1`）+ 临时文件 `rename` 原子替换、
  文件 `0600` / 目录 `0700`，源码明确写了「故意不占数据库迁移」。
- UI 侧只有 `apps/ui/src/theme.tsx` 的 `ThemeSelector`（ADR-0015：跟随系统/浅色/深色），挂在 `App.tsx` 的
  `theme-corner`（登录前）与侧栏底部。它**只把选择写进 `window.localStorage`**，没有任何 Runtime 持久化：
  换浏览器、清缓存、换 Runtime home 都会丢，`codeestra` 也读不到它。
- 任务列表/详情已有相对时间渲染（FOUNDATION-058/059）。

因此这一格的实质是：把「界面效果」从**某一个浏览器的本地偏好**升级为**这个 Runtime home 的一份设置**，
并让 CLI 成为它的完整命令面；UI 只是同一命令面的便利前端（ADR-0008）。

## 决定

### D01 五个键、封闭取值、固定默认值

| 键（CLI / RPC / JSON 同一拼写） | 取值 | 默认 | 语义 |
|---|---|---|---|
| `theme` | `system` \| `light` \| `dark` | `system` | `system` 实时跟随操作系统浅色/深色（ADR-0015 语义**一字不改**），`light`/`dark` 钉住 |
| `density` | `comfortable` \| `compact` | `comfortable` | 内容面（卡片/列表/表格/问答选项/键值列表）的间距节奏 |
| `fontSize` | `medium` \| `small` \| `large` | `medium` | 根字号比例（`small`=87.5%、`large`=112.5%），`rem` 尺寸随之缩放（含 `pre`/终端） |
| `motion` | `full` \| `reduced` | `full` | `reduced` 在系统允许动效时也关掉界面动画；**只能减少动效，不能增加** |
| `timeDisplay` | `relative` \| `absolute` | `relative` | 任务更新时间的渲染（相对措辞 / 本地绝对时间） |

取值是**封闭集合、无自由文本**：同一份清单同时是 CLI 的用法文本、RPC 的枚举、`--json` 的 `values` 字段与 UI
下拉框的选项来源。键名在 CLI、RPC、JSON 文件与它驱动的 DOM 属性（`fontSize` → `data-font-size`）中**完全一致**，
不设别名——别名会让「这是哪个设置」重新变成一个问题。

默认值同时是**没有任何设置文件时**生效的值，因此一个全新的 Runtime home 渲染结果与本格之前**完全一致**
（默认值对应的 CSS 规则故意一条都不写，见 D05）。

### D02 存储：Runtime home 的版本化 JSON 文件，不占 schema

`$CODEESTRA_HOME/ui-settings.json`：

```json
{ "version": 1, "settings": { "theme": "dark", "fontSize": "large" } }
```

- **为什么是 Runtime 而不是浏览器**：用户要求 CLI 完备。`localStorage` 里的值 CLI 读不到、也写不了，
  换浏览器/清缓存即失效；而「全局」在这里的含义是「这个 Runtime 的全部 UI 会话共享一份值」。
  设置存在 Runtime home，`codeestra settings ui …` 与 UI 读写的是同一份值，重启 Runtime 后仍在。
- **为什么是 JSON 文件而不是表**：沿用 ADR-0043 的先例。它是几个词，Runtime 必须在任何迁移决策之前读到它，
  人手编辑是合理用法，进数据库要占一个迁移号而收益为零。因此**不占 schema v28**，`migration.ts` 未被触碰。
- **严格 schema、fail-closed**：版本字面量 + 每个键的枚举 + `strictObject`。未知键、非法值、未知版本、
  损坏 JSON **一律报错**（`INVALID_UI_SETTING`，报文里给出文件路径、具体哪个键错、以及恢复方式），
  **绝不**静默回退到默认值、绝不静默丢弃不认识的字段。一个我们看不懂的文件不得被悄悄改写成看得懂的。
- **原子替换**：先写同目录临时文件再 `rename`；任何写入失败（权限、磁盘满、目标是目录）报稳定码
  `UI_SETTINGS_WRITE_FAILED`、删掉自己的临时文件、**保持旧文件原样**。文件 `0600`、目录 `0700`（ADR-0004）。
- **磁盘即真相**：每次命令都读文件，不缓存。外部手改或第二个 home 都不会被陈旧副本掩盖；文件只有几百字节，
  这个代价可以忽略。

### D03 CLI 完备：`settings ui list|get|set|reset`，零确认

```
codeestra settings ui list [--json]                 # 全部键：当前值、默认值、是否显式设置、来源、可取值
codeestra settings ui get <key> [--json]            # 单键
codeestra settings ui set <key> <value> [--json]    # 单键写入，输出写入后的完整设置面
codeestra settings ui reset [<key>] [--json]        # 去掉一个显式选择；不带 key = 去掉全部（也是损坏文件的恢复路径）
```

- **零确认**：写入即一个命令、零等待（ADR-0008/0011）。设置不是门禁，不新增任何审批层。
- **退出码稳定**：`0` 成功 / `1` 运行时错误 / `2` 用法错误。
  - 未知键、非法值、缺参数、多余参数、未知 flag：**退出码 2**（命令行本身错了，脚本不该为此去连 Runtime）。
  - 文件不可读/不可信：**退出码 1** + `INVALID_UI_SETTING`。
  - 写入失败：**退出码 1** + `UI_SETTINGS_WRITE_FAILED`。
- **稳定错误码**：`INVALID_UI_SETTING`、`UNKNOWN_UI_SETTING`、`UI_SETTINGS_WRITE_FAILED`（均带恢复提示）。
- **既有 `settings prose-question-attention` 一字不改**：只新增子命令与用法段落。
- **已知边界（如实）**：RPC 请求契约本身已经枚举了键与取值（与其他命令的枚举一致），因此**通过传输层
  到达设置层的键/值一定是合法的**——未知键在 HTTP 命令面上得到的是边界拒绝 `INVALID_REQUEST`（HTTP 400），
  在 CLI 上是用法错误（退出码 2）。`UNKNOWN_UI_SETTING` 因此目前只对**直接调用设置层**的调用者可达；
  它保留为设置层自己的稳定码（单元测试钉住），不在本格里假装它是网络可达的。

### D04 UI 是同一命令面的前端

- 新增 `apps/ui/src/settings.tsx`：**设置页**（「界面效果」分区）+ `UiSettingsProvider`。Provider 加载
  `settings.ui.list`，把五个设置应用到 `document.documentElement`（因此每个标签页都生效，而不只是设置页），
  并向侧栏的 `ThemeSelector` 与设置页提供**同一份状态**。
- 每个键显示：当前值、默认值、是否被显式设置、来源（`RUNTIME` / `PRODUCT_DEFAULT`）、该键可取值，以及
  **等价 CLI 命令**（`codeestra settings ui set theme dark`）——UI 不新增 CLI 没有的能力。
- 设置页明写「设置存在 Runtime（`CODEESTRA_HOME`），换浏览器/清缓存后依然生效」，并显示真实的文件路径。
- **旧入口的处置**：侧栏底部的「外观」下拉框**保留**，但其读写改为 Runtime 设置（不再是 `localStorage`）；
  设置页也能改主题，两处写的是同一个值。**登录前**的 `theme-corner`（`App.tsx` 的 token 表单，此时没有
  client，够不到 Runtime）保留今天的能力：一个**只影响本次渲染、什么都不写**的即时预览，登录后被 Runtime
  的值覆盖——它不是存储，因此不违反「禁止只存浏览器」。
- `App.tsx` 只做最小追加：一个导航项（`settings`）、一处渲染分支、一层 Provider 包裹（两行），
  **不触碰** `.app`/`app-header`/`sidebar`/`workspace-shell` 的样式与 shell 结构（J3 领地）。

### D05 密度、字号、动效：默认值零规则，动效只能减少

- 三个键都通过 `data-*` 属性生效（`data-density`、`data-font-size`、`data-motion`），由设置模块**纯函数**
  `documentAttributesFor` 计算、`applyDocumentAttributes` 写入；读不到设置时**移除**属性，页面回到本格之前的渲染。
- **默认值没有对应规则**：`comfortable`/`medium`/`full` 不写任何 CSS，因此「没做任何选择」与「本格之前」
  渲染相同，不会有静默的视觉变更。
- `fontSize` 用百分比（`small` 87.5% / `large` 112.5%）与 `body { font-size: 0.875rem }`：标准 16px 默认下
  就是既有的 14px，但同时**跟随浏览器自身的默认字号**（这是既有的固定像素字号带来的无障碍缺口，随本设置一并
  修正）。`rem` 尺寸（含 `pre`、终端）随根字号一起缩放。
- `motion` 与既有 `@media (prefers-reduced-motion: reduce)` **协调**：`reduced` 追加与既有媒体查询同效的规则，
  `full` **不**新增「强制动效」规则。因此该设置只能减少动效、不能增加，系统偏好永远是上界。

### D06 时间显示：两种渲染，`auto` 被否掉

- `relative` = 工作台原有的措辞（「刚刚更新 / N 分钟前更新 / N 小时前更新 / N 天前更新」）。为免措辞漂移，
  该函数从 `task-list.tsx` **原样搬进** `apps/ui/src/ui-settings.ts`（`relativeUpdateLabel`），任务列表改为
  调用 `updateTimeLabel(timestamp, now, timeDisplay)`；两种模式都继续把完整时间写在 `<time title>` 里。
- `absolute` = `new Date(timestamp).toLocaleString('zh-CN')`（本地时区、本地化）。
- **不提供 `auto`**：`auto` 会让「CLI 报出的值」与「实际渲染」不再是一回事（它取决于运行环境），而 ADR-0008
  要求命令面能完整、确定地描述行为。默认 `relative` 已经是「不选就是原来的样子」。

### D07 非目标（明确否掉）

- **不做 per-project 作用域**：全局单份（用户裁决）。
- **不做行为类设置**（默认项目、每页条数等）：用户明确没有选那一项。
- **不做浏览器本地存储**：见 D02。
- 不新增确认、审批、门禁、沙箱、依赖；不改 Runtime 对任务/权限/Git 的任何行为。

## 被否掉的选项

| 选项 | 否决理由 |
|---|---|
| 只存 `localStorage`/`sessionStorage` | 用户明确否掉：CLI 读不到，换浏览器/清缓存即丢，不是「全局」。 |
| 存进数据库（占 schema v28） | 几个词、需要人手可编辑、必须在迁移前可读；占一个迁移号收益为零，且 ADR-0043 已有同构先例。 |
| 每个键一个文件 | 增加文件数与「哪些文件存在」这种新状态；一份版本化 JSON 一次原子替换即可。 |
| 损坏文件静默回退到默认值 | 会让用户的选择消失且无人知道；`INVALID_UI_SETTING` + 显式 `reset` 才诚实。 |
| 损坏文件上继续 `set`（合并可识别的部分） | 等于丢弃看不懂的字段，即静默重写用户的文件。 |
| 新增 `timeDisplay=auto` | 见 D06：会让 `--json` 报出的值不等于实际渲染。 |
| 键名用短横线（`font-size`）并接受两种拼写 | 别名会让「这是哪个设置」重新成为问题；JSON 字段与 CLI 键统一用同一拼写。 |
| 提供「色值/自定义主题」自由输入 | 需要校验、对比度与主题变量体系，属另一格；本格只做既有的三态主题。 |
| 把设置页的渲染逻辑也搬进 Runtime | 没有 Runtime 侧消费方；UI 是前端，Runtime 只负责可信存储与命令面。 |
| 因为「UI 才用得上」就把 CLI 做成 UI 的子集 | 违反 ADR-0008：UI 只是便利前端。 |

## 后果

- 新增公共命令面 `settings ui list|get|set|reset`（`--json`、退出码 0/1/2、零确认）。
- 新增契约模块 `packages/contracts/src/ui-settings.ts`（键/取值/默认值/视图 schema + 四个请求变体）、
  Runtime 模块 `apps/runtime/src/ui-settings.ts`、UI 模块 `apps/ui/src/ui-settings.ts` 与 `apps/ui/src/settings.tsx`。
  **无 schema 变更、无新迁移、`migration.ts` 未被触碰。**
- `apps/ui/src/theme.tsx` 的存储从 `localStorage` 改为 Runtime 设置；`data-theme` 机制与「跟随系统」语义不变
  （应用点从选择器移到 Provider，因为主题现在是全局持久化设置）。
- `apps/ui/src/task-list.tsx` 的相对时间渲染改由 `timeDisplay` 选择（措辞不变）。
- 新增文件 `$CODEESTRA_HOME/ui-settings.json`（只在第一次写入时出现，0600）。删掉它等于把全部键恢复默认。
- 不新增确认与门禁；FULL/STRICT 语义、任务状态机、Git 流程一字未改。

## 验证要求

已执行（命令面驱动，ADR-0038 的定向测试范围）：

- `bun run typecheck` 退出码 0；`bun run typecheck:ui` 退出码 0；`bun run build:ui` 成功。
- `apps/runtime/test/ui-settings.test.ts`（模块级，8 项通过）：默认值、读写、幂等、磁盘即真相、未知键
  （`UNKNOWN_UI_SETTING`）与非法值（`INVALID_UI_SETTING`）、损坏 JSON / 未知版本 / 未知字段 / 非法值
  fail-closed 且**零写入**、`reset` 单键与全量、原子替换（成功后目录里只有目标文件；写入失败时报
  `UI_SETTINGS_WRITE_FAILED`、旧文件逐字节不变、无临时文件残留）、`0600`/`0700`。
- `apps/runtime/test/cli-ui-settings.test.ts`（真实 CLI + 真实 Runtime + 临时 `CODEESTRA_HOME`，5 项通过）：
  `list`/`get`/`set`/`reset` 的 `--json` 与退出码 0/2/1、重复写入幂等（stdout 与文件字节都不变）、
  **跨 Runtime 重启保持**（`stop` 前后 `status` 的 `bootId` 不同，值仍为显式设置）、损坏文件报
  `INVALID_UI_SETTING` 且 `reset` 修复、以及**不经浏览器**的 HTTP 断言（`/api/command` 同一命令面：
  `settings.ui.list` 的 JSON 与 CLI 输出逐字节相同、HTTP 写入后 CLI 能读到、未知键/非法值在边界被拒、
  损坏文件经 HTTP 得到 `INVALID_UI_SETTING` 并可被 `reset` 修复）。
- `apps/ui/src/ui-settings.test.ts`（vitest，9 项通过）：主题解析（跟随系统/钉住/未知→无属性）、属性映射
  （含未知键、缺键、`timeDisplay` 不是属性）、属性写入与移除（结构化 dataset 替身，无 DOM）、相对/绝对时间
  渲染与未知模式回退、标签与 CLI 提示文案。

**未验证（不得当作已成立）**：

- **视觉/窄屏/动效观感只能人工确认**。本格不使用 computer-use、浏览器自动化、截图或桌面会话（ADR-0008），
  因此「紧凑密度是否舒服」「字号三档是否合适」「减少动效是否真的没有动画」以及设置页在窄屏下的排布
  **均未经机器断言**，需用户目视确认。
- 真实浏览器里 `theme=system` 跟随系统主题切换的实机行为（仅由 `documentAttributesFor` 的纯函数断言覆盖）。
- 多标签页同时打开时的相互刷新（Provider 只在挂载时读取一次；另一个标签页的改动不会推送到已打开的标签页，
  重新读取按钮 / 刷新页面会看到）。这是如实记录的已知边界，不是「已实时同步」。
- `settings ui` 与 UI 设置页的真实端到端点击路径（本格只验证了同一 `/api/command` 传输面）。
- 并发写入的不同 Runtime 进程之间的最后写入者（同一进程内因为读写同步而不可能交错；跨进程没有加锁，
  最后一次完整替换胜出，不会产生半截文件）。
