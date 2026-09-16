# ADR-0063：CLI 命令参考按功能拆为九篇（`docs/guides/cli/`），旧编号保留、由索引当对照表

Status：Accepted（用户 2026-09-16 就形态裁决：按功能组拆 9 篇到 `docs/guides/cli/`；保留 `cli-reference.md`
作为索引 + 旧 §N 对照表；新文件内部**沿用拆分前的章节号**；落地方式为当前 dev clone 的 lane 分支）。
**纯文档：无代码、无 schema、无命令面、无 UI 行为变化。** Amends ADR-0050 的**文件集合（D02）**与
**D03 的映射目标**，不改 ADR-0050 D01/D04/D05/D06/D07 的任何结论。

## Context

- 事实：拆分前 `docs/guides/cli-reference.md` **1322 行**，章节号已到 §21（`wc -l`、`grep -n '^## '`）。
  它是 ADR-0050 D03 写死的「命令面同步目标」，也是本目录里最长的一篇。
- 用户的原始要求：「cli-reference.md 太长了，我需要你按功能分别存放」。
- 现状约束：**约 50 处外部引用写的是「`cli-reference.md` §N」**——`docs/decisions/**` 9 处、
  `docs/tasks/README.md` 30 余处（FOUNDATION 记录里的交付说明）、`docs/guides/**` 20 余处、
  `docs/architecture/**` 与 `docs/notes/**` 各 1–3 处。其中 **ADR 与 `docs/tasks/README.md` 是历史记录，
  按仓库纪律（「修改既有决策一律新增 ADR，不重写历史」）不得改写**，它们里面的 §N 引用必须仍然能查到落点。
- 该文件**没有被任何代码或工具引用**：`grep -rn "cli-reference" apps packages scripts Justfile` 为 0 命中。
- ADR-0050 D02 要求「`docs/guides/**` 的每一篇」带统一版本/校对头；新目录自然落在同一条规则的覆盖内。

## Options

| 选项 | 否决理由 |
|---|---|
| 不拆，保持单篇 1322 行 | 用户明确要求拆分；查一条命令要在一整篇里滚动，且「`task` 生命周期」与「`promotion`」之间没有任何关系。 |
| 每个 `usage()` 命令组一篇（约 19 篇） | 目录过碎（最短一篇只有 14 行）；跨命令的说明（退出码三分法、§5 与 §6.1 的分界、§15 与 §16 的先后）必须挑落点，反而更难维护。 |
| 粗分 5 篇 | `task` 一篇仍有 421 行，`integration` 一篇 384 行，没有解决用户抱怨的那个问题。 |
| 删掉 `cli-reference.md`，全量改写所有引用 | ADR 与 `docs/tasks/README.md` 里的 §N 引用会指向不存在的文件；这些是历史记录，不能重写，等于**永久制造 40 处死引用**。 |
| 新文件内部重新从 §1 编号 | 阅读顺序更顺，但所有现存 §N 引用（含历史记录）都要改，收益仅是「编号连续」；且历史记录仍无法兼顾。 |
| 对照表里用带锚点的链接（`…/runtime.md#14-scheduler`） | 章节标题含中文与全角标点，锚点规则由渲染器决定，本仓库没有任何东西能验证锚点是否正确（链接检查只比对文件是否存在）。**宁愿少一点便利，也不要写不可验证的断链**：对照表给「文件 + §N」。 |
| 保留 `troubleshooting.md` 里的历史同步记录一并改写 | 那是「某一格当时同步了什么」的记录，属于历史，与 ADR 同理不动。 |

## Decision

### D01 九篇的文件集合与职责

| 文件 | 覆盖（沿用拆分前的章节号） | 行数 |
|---|---|---|
| `docs/guides/cli/README.md` | 索引（九篇一览）+ §0 通用约定（连接 / 自动启动 / 退出码 / 环境变量）+ 相关阅读 | 93 |
| `docs/guides/cli/runtime.md` | §1 `status`/`stop`/`permission`/`ui`/`open`、§2 `agent config`、§19 `settings` | 169 |
| `docs/guides/cli/project.md` | §3 `project`（`inspect`/`policy`/`trust`/`list`、`project impact *`、`project knowledge *`） | 136 |
| `docs/guides/cli/task-lifecycle.md` | §4 `task` 生命周期（`create` 到 `purge`/`status`）与 `--feature` | 195 |
| `docs/guides/cli/task-revision-session.md` | §5 `task revision` 与投递、§6 `task transcript`/`session transcript`、§6.1 `session guide`、§7 `session handoff` | 165 |
| `docs/guides/cli/task-result-verify.md` | §8 `task result`、§9 `task verify`/`task verification`/`task tests`、§10 `task operation` | 100 |
| `docs/guides/cli/integration-dag-scheduler.md` | §11 `task integrate`/`task integration`、§12 `task depends`、§13 `task schedule`、§14 `scheduler`、§16 `reclaim` | 302 |
| `docs/guides/cli/promotion.md` | §15 `promotion`（含 `full-suite`） | 106 |
| `docs/guides/cli/interface.md` | §17 `events`、§18 `attention`、§20 HTTP/SSE 面、§21 其他只在源码里出现的东西 | 155 |

切分依据是**用户在做的事**，不是命令名字的字母序：§19 `settings` 跟着 Runtime/权限走（第 2 篇），
§16 `reclaim` 跟着集成与调度走（第 7 篇），§15 `promotion` 独立成篇（它是「送到 main」这一件事的全部）。

### D02 `cli-reference.md` 保留为索引，并是**唯一保留的旧 §N 对照表**

- 它不再包含命令参考正文，只包含：`旧 §N → 现在在哪一篇` 的 24 行对照表、拆分理由、以及指向
  `cli/README.md` 的入口。因此历史记录里的「`cli-reference.md` §N」仍然可解析（查到文件后按号检索）。
- **不复制正文**：索引里不重复任何命令、参数、退出码或稳定码（ADR-0050 D01 的判据照旧适用于新文件）。

### D03 各篇内部沿用拆分前的章节号，允许编号不连续

- 标题原样保留（如 `## 14. scheduler`、`## 6.1 session guide`），因此 §N 的**含义**在拆分前后完全一致，
  跨节引用（§4 提到 §7、§15 提到 §16）不需要重新推导。
- 代价是有些篇内部编号跳过（第 7 篇有 §11–§14 然后 §16；第 9 篇有 §17–§18 然后 §20–§21）。每篇头部写明
  本文件覆盖哪些号、缺的号在哪一篇，读者不会以为丢了一节。

### D04 ADR-0050 D03 的映射目标改为「`docs/guides/cli/` 下的对应篇目」

- 此后「新增/修改命令面（命令、子命令、flag、退出码、稳定错误码）→ 同步文档」的落点，由
  「`cli-reference.md`」改为 **`docs/guides/cli/` 里覆盖该命令的那一篇**（命令组与篇的对应见 D01／索引表）；
  设置键仍然走 §19 `settings`，即 `cli/runtime.md`。
- ADR-0050 D02 的版本/校对头规则**原样适用**于新目录：九篇每篇第一屏都有同一块头。
- **不修改 ADR-0050 正文**（不重写历史），只在其索引行标注 `Amended by ADR-0063`。

### D05 正文搬移、不改写、不重新核对

- 章节正文**逐行搬移，一句未改写**；唯一未搬移的一行是原文件头部第 17 行——它与第 6 行是同一句
  （只有句末标点不同），只保留一份。
- 因为这次**没有重新核对任何命令面事实**，九篇的 `最后校对` 日期保持 `2026-09-16` 不变，并在头部写明
  「内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码」。ADR-0050 D02 的规则是
  「只改链接不算校对」，本条与它一致：**搬运不是校对**。
- 唯一被改写的字节是相对链接：新文件深了一层，篇内的 `./ui.md` 等写成 `../…`，指向旧文件的链接写成 `../cli-reference.md`。

### D06 逐节校对注随各节搬到对应文件

- 原文件头部第 6–20 行是一串逐节校对注（哪一节由哪个 FOUNDATION/user task 校对、依据哪条 ADR）。
  它们**按涉及的小节搬到对应篇**，不在索引里重复堆一遍，也不丢弃。
- 一条注释涉及多篇时（例如「§3 的 X、§1 的 Y、§4 的 Z 由 FOUNDATION-093 同步」），它**在每篇都保留一份**：
  读者在自己的文件里就能看到来源，不必回到索引。代价是将来这条注释要改时得改多处；本 ADR 接受该代价，
  因为「来源就在眼前」比「注释不重复」对读者更重要。

### D07 非目标

- **不拆 `manual.md`（1374 行）与 `ui.md`（1148 行）**：本次用户只要求拆命令参考；那两篇是叙述与走查，
  拆分判据不同，需另行裁决。
- **不改 `docs/guides/**` 其他篇的既有结论**：只把指向 `cli-reference.md` 的链接改为指向对应新篇。
- **不改历史记录**：`docs/decisions/NNNN-*.md` 正文与 `docs/tasks/README.md` 里的 §N 引用一字不动。
- **不加机器门禁**：不为链接检查加 CI、不加「文档必须与代码同提交」的钩子（沿用 ADR-0050 D07）。
- **不改 `PROJECT_SPEC.md`、`AGENTS.md`、`.codeestra/**`**：`AGENTS.md` 的实现规范写的是「按 ADR-0050 D01 的映射
  同步 `docs/guides/` 对应段落」，没有点名具体文件，因此 D04 的目标变更不需要改它。

## Consequences

- **好处**：单篇从 1322 行降到 93–302 行；「查一条命令」的检索面变成一份文件；命令组与文件一一对应后，
  未来做「命令面变更 → 同步哪一篇」的判断更快。
- **代价 1（读者）**：跨越命令组的跳转多了一次点击（例如从 §4 的 `task integrate` 提示到第 7 篇）。
- **代价 2（维护）**：文件多了，索引表与各篇头部的「覆盖哪些号」需要在**下一次**拆分/合并时同步维护。
- **代价 3（可发现性）**：旧路径 `cli-reference.md` 仍在，但它现在只是一张表；不看头部的人可能以为里面是正文。
  已用第一行标题（「CLI 命令参考（索引）」）与第一段说明处理。
- **代价 4（相对链接）**：新目录深一层，未来在该目录内写链接要注意 `../`；搬运时唯一改动的字节就是这个。
- **代价 5（跨篇 § 引用）**：正文里另有 **7 处**「见 §N」现在落在**别的篇**里（`integration-dag-scheduler.md` 的 §0/§1/§19、`task-revision-session.md` 的 §17、`cli/README.md` 的 §14、`project.md` 的 `manual.md` §3.4、`task-lifecycle.md` 的 `ui.md` §2.2）。按 D05 未改写它们；因此每篇头部写明「正文里提到本文件没有的号时，到索引表查它在哪一篇」。这是「不重写正文」换来的代价，如实记录。
- **不改变的**：命令面本身、退出码、稳定码、`usage()`、`--json` 语义、文档的结论与边界说明。

## Verification

纯文档改动，按 ADR-0038 只跑定向检查，**未跑任何全量或聚合检查**（无代码改动）：

1. **搬移完整性（逐行）**：脚本按「原文件行号区间 → 目标文件」的映射逐行比对——
   原文件第 35–1322 行（§0–§21 与「相关阅读」，共 1288 行）**逐行、按原顺序**落在九篇里；
   每篇的搬运行数与正文行数完全相等，无丢失、无重复、无插入。唯一被规范化处理的字节是相对链接的 `../` 前缀。
2. **头部校对注无丢失**：原第 6–20 行 15 行注释逐行反查，14 行至少出现一次；唯一未出现的是第 17 行
   （与第 6 行同句，只保留一份，见 D05）。
3. **链接存在性**：沿用 ADR-0050 验证要求 1 的命令（`docs/guides/**`，含新的 `cli/` 子目录）——
   除本 ADR 自身当时尚未落盘的那一条外无 `MISSING`。
4. **命令面覆盖未缩小**：从九篇抽 `codeestra <group> <action>` 命令路径并集，与拆分前**完全相同**
   （各 93 条，`diff` 无差异）；`task purge` 原第 9 行那条注释已补回到 `task-lifecycle.md`（第一轮自检发现后修复）。
5. **跨篇 § 引用盘点**：正文里共 7 处「见 §N」落在别的篇里（清单见「后果」的代价 5），未改写，靠各篇头部的指引 + 索引表解析。
6. **未验证（不得当作已成立）**：任何**渲染效果**——中文/全角标题的锚点是否可用、目录阅读体验、Web UI 与
   GitHub 上的显示——本仓库没有渲染器，**不能断言**；这些属于人工目视项。本次也**未**拆 `manual.md`/`ui.md`。

## Related

- [ADR-0050](0050-user-manual-and-doc-sync-discipline.md)（被本 ADR 修订文件集合与 D03 映射目标；D02 头规则不变）
- [ADR-0008](0008-efficiency-first-service-form.md)（CLI 完备；文档是命令面的说明，不是命令面本身）
- `docs/guides/cli-reference.md`（索引 + 旧 §N 对照表）、`docs/guides/cli/README.md`（新入口）
- `docs/guides/README.md`（分流表）、`docs/tasks/README.md`（本次交付记录）
