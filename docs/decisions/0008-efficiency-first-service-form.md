# ADR-0008：效率优先、服务形态（CLI 完备命令面）与测试边界

Status：Accepted（用户本轮明确答复四个问题：保留现有门禁只改优先级、新增本 ADR 并 supersede 相关条目、CLI 与 UI 共用同一 Runtime 命令面、测试只用 CLI/命令面且不引入电脑控制）

## Context

用户本轮提出三条产品原则，并要求写入相关规格与协作文件：

1. 软件聚焦效率，用户效率至上；安全性属于次要问题，权限管理暂时不管。
2. 软件本体是一个服务，拥有完备的 CLI 交互能力；Web UI 之类只是方便交互的前端，底层走同一套命令接口。
3. Agent 的自动化测试暂时仅限于 CLI 交互，不要动用户的电脑控制权。

这三条与既有 Accepted 决策存在张力，必须显式声明覆盖关系而不是静默重新解释：

- ADR-0004 已确认项目显式一次信任、Pi `write/edit/bash/powershell` 逐次审批、未知工具 fail-closed；ADR-0003/0006/0001 分别确认成果 commit 确认、验证策略一次性确认与 main 提升批准。这些门禁已经实现并有测试与验收证据。
- ADR-0002 要求保留 Pi 原生审批、不抢占；ADR-0007 把 Web UI 记为与 CLI 复用同一 dispatch 的入口，但未把"CLI 必须完备"写成硬约束。
- FOUNDATION-018/019 的验收曾使用 computer-use 做真实浏览器验证；用户本轮明确不再接受这种测试方式。

本轮答复选择了最保守的落地方式：门禁不删除，只调整优先级表述；覆盖关系用新 ADR 记录并可追溯。

## Options

1. 效率优先的落地范围：(a) 保留现有门禁、只把效率写成第一原则并冻结新增安全机制；(b) 解除执行期工具审批、只保留 Git 破坏性确认；(c) 只保留 worktree 归属约束；(d) 取消全部确认。
2. 覆盖关系的记录方式：(a) 新增 ADR-0008 并显式 supersede/amend 相关条目；(b) 直接改写既有 ADR；(c) 只改规格不动 ADR。
3. CLI 与 UI 的实现方式：(a) CLI 与 UI 共用同一 Runtime versioned command/query/event 面，CLI 必须完备；(b) UI 通过 spawn 调用 `codeestra` CLI 子进程；(c) 读走命令面、写走 CLI。
4. 测试与电脑控制边界：(a) 测试只用 CLI/命令面，且不引入电脑控制工具；(b) 测试只用 CLI，产品内 Agent 未来可含电脑控制；(c) 允许 Playwright 浏览器自动化，禁止 OS 级输入控制。

## Decision

用户选择 1(a)、2(a)、3(a)、4(a)。

### D01：效率优先，门禁冻结、权限管理移出当前范围

- **效率是最高优化目标**：从用户意图到可用结果的等待时间与操作步数优先于其他考虑。安全性、隔离性、可审计性都是服务于该目标的约束，不能成为常态路径上的额外负担。
- **成本预算**：任何门禁在常态路径上最多引入一次显式确认，不得引入第二道确认、重复确认或需要用户常驻监视的流程。已实现的门禁（`PROJECT_SPEC.md` §2 第 12/13 条与 ADR-0001 D03、ADR-0003、ADR-0004、ADR-0006）保持现状且继续有效。
- **冻结新增**：不再新增任何权限门禁、审批层、信任流程或沙箱。今后若提出新的安全机制，必须先证明它不降低吞吐、不增加常态步数，否则不实现。
- **权限管理移出范围**：RBAC/多用户/租户隔离、密钥管理与托管、路径沙箱、网络策略、发布签名与供应链等"权限管理"议题，当前既不是待决项也不是待实现项，不为其预留门禁。本机单用户模型（ADR-0001 D04）与"Git worktree 不是 OS 权限沙箱"的既有表述不变。
- 安全类失败仍然 fail-closed（例如未知工具不执行）——这是正确性问题而非效率取舍；效率优先不允许把"未知即放行"当作提速手段。

### D02：覆盖关系记录为新增 ADR

- 本 ADR amend ADR-0002、ADR-0004、ADR-0007 的**优先级与入口定位**表述；三者其余内容继续有效，不作为整体 supersede。
- 本 ADR **不修改** ADR-0001 D03（main 提升批准）、ADR-0003（成果 commit 确认）、ADR-0006（验证策略确认）的实体要求，只把它们置于 D01 的优先原则之下。
- 既有 Acceptance 证据（FOUNDATION-018/019）保留，不追改历史；被本 ADR 取代的是**今后的做法**，不是过去的记录。

### D03：CLI 是完备命令面，UI 只是便利层

- **软件本体是服务**：独立本地 Runtime（ADR-0001 D04）是软件本体；CLI、Web UI、未来桌面都是它的客户端。关闭任何客户端都不终止服务、Task 或 Session。
- **接口定义**：这里所说的"CLI 接口"指 Runtime 的 versioned command/query/event 面（`packages/contracts` 的 Zod 边界 + `apps/cli` 的命令语法）。CLI 是这层接口的权威、完备、可脚本化的表达。
- **完备性要求**：每个能力都必须能只靠 CLI 完成，包括项目接入、Task 全生命周期、Attention 回答、成果 commit、验证、事件订阅与观察。提供机器可读输出（`--json`）与稳定退出码，使 CLI 可被脚本、CI 与 Agent 直接驱动。
- **"只有 UI 能做"是缺陷**：出现任何仅 UI 可用的能力即视为待修复缺陷，而不是设计选择。
- **UI 定位**：Web UI（ADR-0007）与未来桌面不新增业务语义、不绕过任何门禁、不直接访问 SQLite，只是同一命令面的另一种前端；不采用 spawn CLI 子进程的实现方式（避免每动作一进程、SSE 事件流需要额外转发、确认交互复杂化）。
- **优先级含义**：当 CLI 完备性与 UI 便利性冲突时，先做 CLI；UI 的功能是 CLI 能力的子集投影。

### D04：自动化测试仅限 CLI/命令面，不获取电脑控制权

- **测试边界**：项目内自动化测试与验收断言的驱动方式仅限 CLI 命令与 Runtime 命令面（含承载它的 HTTP/SSE 传输路径）。可以断言事件流、退出码、stdout/JSON 与数据库投影。
- **禁止电脑控制**：不引入 computer-use、OS 级键鼠或窗口自动化、桌面应用操作、真实用户桌面会话作为测试手段。开发 Agent 不得为了验证而取得用户电脑控制权。
- **UI 验证方式**：改为 headless 断言（资产可获取、HTTP 边界与命令行为一致、SSE 帧语义）加用户在场时的人工确认；不再由 Agent 驱动真实浏览器/桌面。
- **产品内 Agent 边界**：不新增屏幕读取、桌面应用操作、键鼠控制类工具。Agent 能力保持为仓库读写、命令执行、Git 与验证编排。
- FOUNDATION-018 记录的 computer-use 浏览器验证属于历史证据，今后不再采用该方式复现。

## Consequences

- 文档层面：`PROJECT_SPEC.md` §1.1 新增第一原则，§2 新增不变量，§6/§8 补充服务形态与测试边界；`AGENTS.md` 增加对应协作规则（含"开发 Agent 不取得电脑控制权"）。
- 工程层面：所有新增能力必须先评估"CLI 是否完备"，UI 变化不得先于或超出 CLI 能力。门禁代码不因本 ADR 被删除，现有测试不失效。
- 效率诉求的落地载体仍是既有 NEXT 项（Task cancel、长命令后台化与进度事件、revision 投递确认）——它们才是当前最影响用户等待时间的问题，本 ADR 不改变其优先级排序，只要求后续设计不新增常态确认步骤。
- 代价：缺少多用户/租户/沙箱意味着无法支持多人共享 Runtime 或不可信仓库。此为本机单用户开发编排的有意取舍，若将来需要，必须重开决策而不是悄悄补门禁。
- 现有"未知工具 fail-closed"与"取消超时转人工"等行为保持不变，避免把效率优先误读为降低正确性。

## Verification

- `PROJECT_SPEC.md`、`AGENTS.md`、`README.md`、架构索引与 roadmap 中都能检索到三条原则；ADR 索引标注 ADR-0002/0004/0007 被 ADR-0008 amend。
- 抽查 CLI 命令面：对 `PROJECT_SPEC.md` §2 第 12/13 条与 ADR-0003/0006 描述的每个能力，存在对应的 CLI 命令（当前核查项：`project inspect/trust/list`、`task create/list/submit/run/status/result prepare|commit/verify`、`attention list`/回答、`events list/tail`、`ui`、`stop`）。若发现仅 UI 可用能力，开缺陷任务。
- 仓库内不存在 computer-use、桌面自动化或键鼠控制的测试代码/脚本；`just verify` 不依赖真实桌面会话。可用关键词检索（`computer-use`、`osascript`、`playwright`、`screencapture`）无命中（文档中的历史记录除外）。
- 新增门禁需在本 ADR 或后继 ADR 中说明其效率成本；未说明即视为违反 D01。
- 现有门禁的既有测试（gate 审批、成果 commit 确认、验证策略确认）继续通过，证明本 ADR 未意外削弱已实现行为。

## Related

- `PROJECT_SPEC.md` §1.1 / §2 / §6 / §8
- `AGENTS.md`（效率优先与测试边界）
- `docs/architecture/README.md`、`docs/architecture/repository-structure.md`
- ADR-0001（D03/D04 继续有效）、ADR-0002、ADR-0003、ADR-0004、ADR-0006、ADR-0007
- `docs/tasks/README.md` FOUNDATION-020
