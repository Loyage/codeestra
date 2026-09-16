# ADR-0064：`settings` 成为设置的唯一入口 —— `settings list` 总览 + 权限模式移入 `settings permission`

Status：Accepted（用户 2026-09-16 逐项裁决）。**已实现**（用户任务 FOUNDATION-098；无 schema 变更、不占迁移号）。
基线：`dev = 28255d41d3b4f54b01741ef02c1cc8a7856cf3f1`（本格开头先 fast-forward 到当时本地 `dev`，因为 `settings auto-reclaim`（ADR-0062）与 CLI 参考拆分（ADR-0063）都直接影响本任务）。

## Context

用户原话：「把 `bun run codeestra permission` 指令放入 `bun run codeestra settings` 里面，`bun run codeestra settings` 需要指令可以查看有哪些设置，以及这些设置处于什么状态。」

本格基线实测（命令面与源码）：

- 设置分散在**五种**拼写下，其中两种还互为别名，没有任何一处回答「一共有哪些设置」：
  | 设置 | 命令 | 存储 |
  |---|---|---|
  | 权限模式 | **顶层** `permission get` / `permission set <full\|strict>` | `$CODEESTRA_HOME/permission-mode.json` |
  | 散文提问开关 | `settings prose-question-attention [mode]` | `$CODEESTRA_HOME/prose-question-attention.json` |
  | 集成后自动回收 | `settings auto-reclaim [on\|off]`（ADR-0062） | `$CODEESTRA_HOME/auto-reclaim.json` |
  | 五个界面效果键 | `settings ui list/get/set/reset`（ADR-0045） | `$CODEESTRA_HOME/ui-settings.json` |
  | 全局并发上限 | `settings concurrency get/set/reset`（= `scheduler capacity`，ADR-0061 D02） | 数据库 `runtime_capacity_settings` |
- 后果一：`settings` 命令组**名不副实**——最像「全局开关」的权限模式不在里面，用户按「找设置」的习惯路径找不到它。
- 后果二：新增一个设置（例如刚刚落地的 `auto-reclaim`）只会在文档里出现，命令面没有一个地方能让人**枚举**已有设置；用户必须已经知道名字才能查看状态。
- 本仓库已有的先例是 ADR-0061 D02：同一个事实允许有两个命令面拼写，但**必须发同一条 Runtime 命令**，不允许出现第二个状态源。本 ADR 沿用该先例，而不是发明新机制。

## Options

用户本轮 A/B/C 的实际答复（未答复项不作批准）：

1. 顶层 `permission` 的去向：
   - A. 保留为薄别名（与 `scheduler capacity`↔`settings concurrency` 同形）；
   - **B. 删除，只留 `settings permission`（用户选 B）**；
   - C. 保留但打印「已迁移」提示。
2. `settings` 下的命令形状：
   - **A. `settings permission get` / `settings permission set <full|strict>`（用户选 A）**；
   - B. `settings permission [full|strict]`（不给值就是读，与 `settings prose-question-attention` 同形）。
3. 「查看有哪些设置及状态」的数据来源：
   - **A. 新增 Runtime 命令 `settings.list`（用户选 A）**；
   - B. CLI 侧组合现有命令拼装（不改契约，但「有哪些设置」的知识落在客户端）。
4. 总览列出哪些设置：
   - **A. 权限模式 + 散文开关 + 五个界面键 + 并发上限（用户选 A）**；
   - B. 再加上 Agent 配置的全局默认（用户未选：agent config 是全局/项目/Adapter 三层作用域，与「一个 home 一份值」的设置语义不同）；
   - C. 不含并发上限。
   - **本格补充说明**：选项 A 是在旧基线上给出的；本格开头 fast-forward 后，同属「Runtime 级、一个 home 一份值、零确认」的 `settings auto-reclaim`（ADR-0062）已存在，因此按**同一判据**一并纳入总览，共**九项**。这不是新增用户未答复的产品语义，而是把用户已选的「列出全部设置」判据应用到基线上实际存在的设置；Agent 配置仍按 B 项被排除。

## Decision

### D01 权限模式是一项设置：只保留 `settings permission`

- CLI 拼写为 `settings permission get` 与 `settings permission set <full|strict>`（大小写不敏感，零确认，其他取值是用法错误/退出码 2）。
- **顶层 `permission get|set` 被移除**：它现在是用法错误（退出码 2）。这是本 ADR 唯一的破坏性变更。
- Runtime 命令面、存储与语义**一字未改**：仍然是 `permission.get` / `permission.set`，仍然是
  `<CODEESTRA_HOME>/permission-mode.json`（`{"version":1,"mode":…}`，0600、原子替换），仍然「影响后续操作与新 Agent Session，
  已在跑的 Session 沿用启动时模式」。`settings permission` 发的是**同一条命令**（沿用 ADR-0061 D02 的先例）。
- 值、默认值与枚举只有一处声明：`packages/contracts/src/settings.ts` 的 `permissionModes` / `permissionModeSchema` /
  `defaultPermissionMode`，Runtime 的 `permission-mode.ts` 与 `permission.get` 的 `default` 字段都从这里取。

### D02 新增 Runtime 命令 `settings.list`：一条只读命令枚举全部设置

每条条目固定给出：`key`、`value`、`default`、`values`（闭集）**或** `range`（数值区间，二者恰有其一）、
`explicit`、`source`（`PRODUCT_DEFAULT` / `RUNTIME`）、`store`（`RUNTIME_FILE` / `RUNTIME_DATABASE`）、`file`、`appliesTo`。
顶层给出 `home` 与 `appliesTo`。

- **键名 = 命令路径加一个点**：`permission.mode`、`attention.proseQuestion`、`reclaim.auto`、`ui.theme`（及另外四个 ui 键）、
  `capacity.globalLimit`。
- **布尔开关按它自己命令的词汇报**：`reclaim.auto` 的取值是 `on`/`off`（不是 `true`/`false`），因为这个列表就是给敲这些命令的人看的，
  同一个设置不允许有两套词汇。
- **契约强制完备性**：`settingKeys` 是全部键的闭集，视图 schema 要求「每个键恰好出现一次」。新增设置却忘了加进总览 = Runtime 报错，
  而不是悄悄少一行。
- **每一项都由它自己那条命令的同一次读取填充**（见 D03），因此总览与专命令不可能读出不一致。

### D03 每项的值从哪来（不得引入第二状态源）

| 键 | 值来源 | 「是否显式设置」的判据 |
|---|---|---|
| `permission.mode` | Runtime 启动时读入并保存在内存中的模式（与 `permission.get` 同源） | 启动时该文件是否存在；Runtime 自己执行 `permission.set` 后即为真 |
| `attention.proseQuestion` | 同上（与 `settings prose-question-attention` 同源） | 同上 |
| `reclaim.auto` | 同上（与 `settings auto-reclaim` 同源） | 同上 |
| `ui.*` | `inspectUiSettings(home)`（每次读文件） | 文件里该键是否有值（与 `settings ui list` 的 `explicit` 同一个值） |
| `capacity.globalLimit` | `storage.getRuntimeCapacity()`（与 `scheduler capacity get` 同一次读取） | `limitSource === 'EXPLICIT'` |

「值」和「是否显式设置」必须来自**同一次读取**：把内存里的值和磁盘上的存在性分开取，会在「有人手改了文件而 Runtime 还在跑」
时给出自相矛盾的一行。

### D04 CLI 形态：`settings list [--json]`，默认人读

- 默认输出是**人读列表**（键、生效值、`set`/`default`、可取值、默认值、存储位置），符合「查看有哪些设置及状态」这个提问方式。
- `--json` 打印 Runtime 载荷原文（完整记录，含每个条目的 `appliesTo`）。多余参数、未知 flag 是用法错误（退出码 2）。
- 其余 `settings` 子命令不变，`--json` 一律被接受（它们本来就打印 JSON）。

### D05 这不是门禁

读总览不写任何文件、不改变任何值；九项设置在 FULL 与 STRICT 下都是零确认可读可写。本 ADR 不新增任何审批层或确认步骤（ADR-0008/0011）。

### D06 文档落点

按 ADR-0050 D03（其间由 ADR-0063 修订落点）：命令面变化同步到 [`docs/guides/cli/runtime.md`](../guides/cli/runtime.md) §1/§19；
设置键变化同步同篇 §19 与 [`docs/guides/manual.md`](../guides/manual.md) 的「设置与权限」；权限语义行同步
[`docs/guides/features.md`](../guides/features.md)。UI 行为**未变**，`docs/guides/ui.md` 只改「切换用哪条命令」的措辞。

## Consequences

- **破坏性变更**：`permission get` / `permission set` 立即失效（退出码 2）。本仓库内一次改完：`apps/runtime/test/` 五个用例文件、
  `docs/guides/**`、`README.md`、`docs/notes/real-provider-acceptance-runbook.md`。没有保留别名的理由是用户明确选择 B：
  两个拼写意味着两份文档、两种脚本习惯，而这两个命令本来就是同一条 Runtime 命令，别名带来的只是「到底该用哪个」的再次提问。
- 新增设置的成本变成一个动作而不是两个：把它加进 `settingKeys` 并在 `inspectSettings` 里补一行；忘记补会被契约拒绝。
- 「有哪些设置」从此是 Runtime 的事实，而不是文档或客户端里的清单；但**列表只覆盖 Runtime 级、一个 home 一份值的设置**，
  刻意不含 Agent 配置（三层作用域，见 Options 4.B）与项目级事实（`dev_repo_path`、验证策略、影响映射）。
- 无迁移、无 schema 变更：九项里五类存储都不变，总览是纯读。

## Verification

只用 CLI / Runtime 命令面与临时 `CODEESTRA_HOME` 验证（ADR-0008，不使用桌面/键鼠自动化）：

1. `apps/runtime/test/cli-settings.test.ts`（新增）：
   - 全新 home 上 `settings list --json` 报出**九项**且全部为产品默认、`explicit: false`，并且**不创建**任何设置文件；
   - 每项的 `values`/`range` 恰有其一（`permission.mode` 的 `FULL|STRICT`、`capacity.globalLimit` 的 `1–16`、
     `reclaim.auto` 的 `on|off`）；
   - 人读输出含各项键名、`--json` 输出为原文；多余参数/未知 flag 退出码 2；
   - `settings permission get|set` 读写 `permission-mode.json`（0600、版本化）并零确认；**顶层 `permission get|set` 退出码 2**；
   - 总览与 `settings permission get`、`settings prose-question-attention`、`settings auto-reclaim`、`settings ui get <key>`、
     `scheduler capacity get` 逐项相等；重启 Runtime 后「显式设置」仍如实（含「值等于默认但确实设置过」）。
2. 回归（因顶层 `permission` 拼写变化而同步的用例）：`cli-open`、`cli-promotion`、`cli-session-attach`、
   `cli-codex-adapter`、`cli-claude-adapter`。
3. 相关既有用例保持通过：`permission-mode`、`ui-settings`、`cli-ui-settings`、`cli-auto-reclaim`、
   `cli-prose-question-attention`。
4. 未验证：真实 provider 长跑下的总览一致性；Windows；UI 使用总览（本 ADR 不改 UI，Web 界面仍只读 `permission.get` 显示模式）。

## Related

- ADR-0008（CLI 完备 / 效率优先）、ADR-0011（默认 FULL，CLI 开关；本 ADR 只改其 CLI 拼写，语义不变）
- ADR-0043（散文提问开关）、ADR-0045（五个界面键）、ADR-0061 D02（`settings concurrency` 的别名先例）、
  ADR-0062（`settings auto-reclaim`，纳入总览）
- ADR-0050 D03 + ADR-0063（文档落点）、ADR-0038（开发分支只跑定向测试）
- `packages/contracts/src/settings.ts`、`apps/runtime/src/settings-view.ts`、`apps/runtime/src/main.ts`、
  `apps/runtime/src/permission-mode.ts`、`apps/cli/src/main.ts`
