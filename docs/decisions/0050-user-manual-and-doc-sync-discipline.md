# ADR-0050 — 用户说明书单一主线与文档同步纪律

状态：**Accepted**（用户 2026-09-15 就形态裁决「单份主线说明书 + 现有文档为参考」，并明确要求四项配套全部做）。
任务：FOUNDATION-078（Wave L / L2，**纯文档**）。基线：`dev = 036cf681ec87127579c285bc51888c1f54d1f932`。
**无 schema 变更、不占迁移号。ADR 编号 0050 由协调者裁决归本格占用**（L3 若需新 ADR 用 0051）。

## 背景

用户原话：「我希望项目有使用指南，相当于一份写给用户的说明书。」

本格基线上的现状（实测）：

| 事实 | 值 | 核对方式 |
|---|---|---|
| `docs/guides/**` 篇数 / 行数 | 8 篇 / 2743 行 | `wc -l docs/guides/*.md` |
| 索引 | `docs/guides/README.md`（42 行，按「我想……」分流） | 读文件 |
| 已链入 | `README.md:59` | `sed -n '55,62p' README.md` |
| 命令面覆盖 | `cli-reference.md` 885 行，覆盖 `usage()` 的每个命令组 | 读文件 |
| 故障覆盖 | `troubleshooting.md` 508 行，含稳定码表与不一致清单 | 读文件 |

八篇分别解决「怎么装」「名词是什么」「完整流程」「有哪些功能」「命令怎么敲」「界面长什么样」「出错怎么办」。
它们**合起来**够用，但**没有一份可以按顺序读下去的入口**：新手必须先知道该按哪个顺序读八篇。同一件事
（例如「怎么把一个改动送到 main」）分散在 `workflow.md`、`concepts.md`、`cli-reference.md` 三处，
且**没有一篇**回答「我现在到底该敲哪一条」。

同时，四项配套**全都缺失**：

1. **没有更新纪律**：`AGENTS.md` 与 `docs/tasks/README.md` 都没有要求「功能变更必须同步用户文档」，
   于是文档会随实现漂移——FOUNDATION-074/075 的两次校准格就是为清理这种漂移而开的。
2. **没有人工观感核对清单**：ADR-0008 明确「UI 验证不使用浏览器/桌面自动化，只能人工确认」，
   但**没有任何一份可勾选的清单**告诉用户该看哪几项（窄屏、矮窗口、主题、密度、字号、动效、焦点顺序……）。
3. **没有插图位**：图是这一层唯一能一眼说清布局的东西，仓库里却没有任何「哪里该有一张图」的位置约定。
4. **没有版本/校对头**：读者无法判断「这篇文档说的是哪个代码」——`docs/guides/**` 里没有一处写明
   对应的 dev SHA、schema 版本或最后校对的日期。

本 ADR 固定这四件事的形态，并把「说明书是单一主线、八篇是参考」写进规范。

## 决定

### D01 单一主线：`docs/guides/manual.md` 是唯一可以「从头读到尾」的文档

- `manual.md` 承担**叙述**：这是什么 → 装好它 → 第一个项目 → 第一个任务 → 看它干活 → 审阅成果 →
  任务验证 → 合入 dev → 发布到 main → 日常使用 → 设置与权限 → 数据与备份 → 出问题怎么办 → 术语表。
- **每一节末尾用一行给出「想深入看哪篇」的链接**，指向既有的八篇参考文档。
- **不复制**：manual 不复述参数表、不复述完整错误码表、不复述状态机。它只回答「我该做什么、会发生什么、
  不能指望什么」，细节交回参考篇。判据是：如果一段话在参考篇里已经逐字存在，manual 里只留链接。
- 面向**用户**：读者不需要先读 ADR 才能用。凡是可能被误读的地方必须在正文里写清边界
  （例如「Task 显示 `RUNNING` 不等于 provider 此刻在跑」「合入 dev 不等于发布到 main」
  「`--background` 返回 0 不等于验证通过」）。
- `docs/guides/README.md` 的分流表保留，但把 `manual.md` 放在第一位，并写明「不确定从哪读就读它」。

### D02 版本与校对头：每篇顶部统一一行，且 SHA 永不单独出现

`docs/guides/**` 的**每一篇**（含 `README.md`、`manual.md` 与本 ADR 新增的三篇）在 H1 之后紧跟同一个块：

```text
> **适用版本** `dev@036cf68`（2026-09-15） · **schema** v28 · **最后校对** 2026-09-15
> 版本会前进：`dev@036cf68` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
```

- 三个字段固定：适用版本的 dev 短 SHA（含日期）、SQLite schema 版本、最后校对日期。
- **SHA 必须与「以 `docs/tasks/README.md` 的最新记录为准」同时出现**。写死一个会立刻过期的 SHA 而不说明
  它是基线，就是把「参考」伪装成「当前」。
- 最后校对日期只在**该篇内容被实际核对**时更新；只改链接不算。
- schema 版本取自 `packages/storage/src/migration.ts` 的 `phase1SchemaVersion`，不手抄 ADR。

### D03 更新纪律：功能变更必须同步 `docs/guides/` 的对应段落

这是本 ADR 唯一改变**未来行为**的一条，写入 `AGENTS.md`「实现与验证」小节与 `docs/tasks/README.md`
的交付要求：

- **新增/修改命令面**（命令、子命令、flag、退出码、稳定错误码）→ 同步 `cli-reference.md`；
  若它改变用户的日常做法 → 同时同步 `manual.md` 的相关节与 `recipes.md` 的相关条目。
- **UI 行为变化**（标签页、按钮、文案、只读/可写的分界）→ 同步 `ui.md`；改变日常做法时同步 `manual.md`。
- **设置键**（新增/删除/取值/默认值）→ 同步 `cli-reference.md` 的 `settings` 一节、`manual.md` 的
  「设置与权限」、必要时同步 `acceptance-checklist.md`。
- **权限语义**（FULL/STRICT 的差异）→ 同步 `concepts.md`、`manual.md` 与 `features.md` 的权限行。
- **交付说明必须写明改了哪一篇的哪一节**；如果这次变更确实不需要改文档，**要写明为什么不需要**。
  「没提到」与「确认无需修改」是两件不同的事。
- 纪律不新增任何机器门禁：它是人工规范，与既有「记录实际运行的检查」「不要把草案标为已实现」同级。

### D04 逐屏 UI 走查：只写渲染里真实存在的东西

`ui.md` 的逐屏走查必须**逐个对照 `apps/ui/src/**` 的组件与文案**（7 个标签页 + 常驻外壳），不得凭印象写。
每一屏必须分别说清三件事：

1. **能看到什么**（面板、表格列、信息字段）；
2. **每个按钮/输入做什么**（它发的是哪条命令）；
3. **哪些是只读投影、哪些真的改 Runtime 状态**。

只读投影（`project impact *`、`task depends list`、`task schedule explain`、`promotion list/get`、
`session handoff status`、`scheduler reservations list/get`、`session transcript` 等）必须显式标为只读，
因为它们**看起来**像操作面：`clear-unknown` 与 `reservations release` 是真正写审计的动作，而它们周围的数字不是。

### D05 人工观感核对清单：把「机器不能断言的事」变成可勾选的事

`docs/guides/acceptance-checklist.md` 是一份**逐项可勾选**的清单，覆盖窄屏（≤850px）、矮窗口、
三种主题、紧凑密度、字号三档、`reduced` 动效、键盘焦点顺序与 skip-link、长任务列表下标题栏与
「工作空间」是否稳住、停靠条、Attention 卡片、终端面板。

- 清单顶部必须写明**为什么它存在**：ADR-0008 禁止浏览器/桌面自动化，所以这些项**明确不能由机器断言**，
  只能由用户在场目视确认。
- 每一项给「怎么触发」（改哪个设置、把窗口缩到多窄）与「看什么」，而不是「是否满意」。
- 清单**不**声称任何一项已被机器验证过。

### D06 插图位：仓库只放位置与清单，图由用户提供

- `docs/guides/images/README.md` 给出建议插图清单：**文件名 + 该图要拍什么 + 图注文字**。
- `manual.md` 在对应位置放占位行：`> 图：<文件名> — <图注>`。
- **不自己造图**：不使用浏览器/桌面自动化截图、不生成示意图、不引入图片依赖。
  占位行是契约：图一旦放进 `docs/guides/images/<文件名>`，占位行就地生效。

### D07 非目标（明确否掉）

- **不改既有 8 篇的结构与结论**：新增 `manual.md`/`recipes.md`/`acceptance-checklist.md`/
  `images/README.md`，给全部篇目加头，并在 `ui.md` 内补逐屏走查；不改它们的既有判断。
- **不改 `PROJECT_SPEC.md`、既有 ADR 正文、`.codeestra/**`**。
- **不改任何代码**（`apps/**`、`packages/**` 一行都不动）。
- **不为文档建门禁**：不加链接检查的 CI、不加「文档必须与代码同提交」的钩子。纪律是人工的。
- **不把文档与实现的不一致静默改成迁就实现**：发现不一致写进 `troubleshooting.md` 的清单并如实标注。

## 被否掉的选项

| 选项 | 否决理由 |
|---|---|
| 把八篇合并成一篇巨型文档 | 用户裁决策略是「单份主线 + 现有文档为参考」；合并会把 2743 行命令参考塞进叙述流，两者都变难读。 |
| 只写 `manual.md`，不碰既有八篇 | 版本/校对头与逐屏走查是用户明确要求的两项配套，不落就没有交付。 |
| 版本头里只写「最新版」不写 SHA | 用户明确否掉：不写 SHA 就无法判断文档与代码的距离；只写 SHA 不写「以 tasks 记录为准」同样不行。 |
| 用 `git describe` 或自动注入版本 | 会在每次提交后自相矛盾（文档写的是「校对时的代码」而不是「当前 HEAD」），且需要构建期工具链参与文档。 |
| 更新纪律用 CI/钩子强制 | 违反 D07；且本仓库当前没有 CI 门禁，声称「已强制」会是假话。 |
| 用浏览器自动化生成插图或做观感验收 | ADR-0008 明确禁止（不获取用户电脑控制权）；用户在场目视是唯一合法路径。 |
| 在 `manual.md` 里复制 `cli-reference.md` 的参数表 | 复制两份表必然漂移；D01 的判据就是为此设的。 |
| 把 `manual.md` 写成「新手教程」而省略边界说明 | 用户明确要求「凡是可能误导的地方要写清边界」；说明书的第一职责是让读者不误判系统状态。 |

## 后果

- 新增四份文档：`docs/guides/manual.md`、`docs/guides/recipes.md`、
  `docs/guides/acceptance-checklist.md`、`docs/guides/images/README.md`（图本身由用户提供）。
- `docs/guides/**` 的**全部 12 个 Markdown 文件**加了统一版本/校对头（既有 8 篇 + 新增 4 篇 = 12/12）：
  `README.md`、`manual.md`、`getting-started.md`、`concepts.md`、`workflow.md`、`features.md`、`ui.md`、
  `cli-reference.md`、`recipes.md`、`acceptance-checklist.md`、`troubleshooting.md`、`images/README.md`。
- `docs/guides/ui.md` 重写为逐屏走查（7 个标签页 + 常驻外壳），并按 D04 标注只读/可写。
- `docs/guides/README.md` 的分流表首位加入 `manual.md`。
- `AGENTS.md` 的「实现与验证」小节新增一条文档同步纪律（**人工规范修改，用户已授权**）。
- `docs/tasks/README.md` 的 `## NEXT` 之前插入 `## FOUNDATION-078` 记录，并在文中写明同一纪律。
- **不新增文件类型之外的任何运行时行为**：无命令面变化、无 schema 变化、无 UI 变化、无确认变化。
- 已知代价（如实）：版本头里的 SHA 会在下一次提交后立即成为「历史基线」；这是刻意的——它记录的是
  「这篇文档被核对时的代码」，而「当前适用版本」永远由 `docs/tasks/README.md` 回答。

## 验证要求

本格为纯文档，验证限于两类可复现断言（ADR-0038 的定向范围，**不得跑全量**）：

1. **文档内链接存在性**：从 `docs/guides/**/*.md` 提取全部相对链接与图片占位文件名，逐个核对目标路径
   存在（含新增篇目、插图占位所指向的 `docs/guides/images/` 约定路径）。命令与结果写进 FOUNDATION-078。
2. **命令/标签页/按钮的核对证据**：说明书与走查里出现的每条命令、每个标签名、每处按钮文案，必须能对应到
   `apps/cli/src/main.ts`（`usage()` 与分派）、`packages/contracts/src/index.ts`、`apps/ui/src/**` 的具体位置；
   单列「无法核实」项。核对用的 `grep`/命令与结果写进 FOUNDATION-078。

**未验证（不得当作已成立）**：全部观感类结论（见 D05）只能由用户目视确认；本格不运行 `bun run typecheck`
（无代码改动）、不运行任何全量或聚合检查。图未提供，占位行未被替换。

## 关联文档

- `PROJECT_SPEC.md` §1.1（第一原则；本 ADR 完全从属于它，未改规格一字）
- [ADR-0008](0008-efficiency-first-service-form.md)（CLI 完备、测试仅限命令面、不获取电脑控制权）
- [ADR-0011](0011-default-full-permission-mode.md)（FULL/STRICT 的权限差异，说明书必须写清）
- [ADR-0038](0038-branch-targeted-tests-and-dev-full-suite.md)（定向测试与全量测试的时机；本格的验证范围）
- [ADR-0047](0047-github-mediated-promotion.md)（说明书里「发布到 main」一节必须以经 GitHub 中转的人工步骤为准）
- [ADR-0048](0048-dev-clone-and-separate-runtime-home.md) / [ADR-0049](0049-dev-ui-channel-marker.md)
  （两个独立 clone 与 dev UI 通道标记，说明书必须写出这两个新构造）
- `AGENTS.md`（本次修改的人工规范）、`docs/tasks/README.md` FOUNDATION-078
