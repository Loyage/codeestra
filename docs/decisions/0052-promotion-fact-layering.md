# ADR-0052：经 GitHub 中转提升的命令面事实分层（拒绝可重试 vs 记录 STALE、`AWAITING_PULL` 的退出码 3）

Status：Accepted（实现随 FOUNDATION-077 落地，schema v29）。
**它是 ADR-0047 的实现细则**：ADR-0047 只规定了「唯一路径、远端即事实来源、拉取是显式人工步骤」；
本 ADR 记录落地时必须新增、而 ADR-0047 未写明的分类与命令面事实。

## Context

ADR-0047 D05 要求 `promotion promote` 变成「push + 远端核对 + 等待拉取 + 收口」，并要求
「『已推送』不得被报告成『已提升』」。落地时出现三类 ADR-0047 没有回答、但写进数据库与退出码就会长期生效的问题：

1. **push 失败与远端被移动不是同一件事**。远端不可达、认证失败、`pre-receive` 钩子拒绝：promotion 记录本身
   （固定三元组、dev clone、全量证据）**仍然完全正确**，只是这一次网络操作没成功；而远端 `dev` 已经被别人移到
   非候选 SHA：记录里那份「候选就是远端状态」的前提已经不成立。若两者都写 `FAILED` 或都写 `STALE`，要么让用户
   为一次断网重新 prepare/approve，要么让一份已失效的记录看起来还能重试。
2. **「等待拉取」需要一个可脚本化的信号**。ADR-0047 只说它与 `SUCCEEDED` 不同，没说不同在哪里。自动化（本仓库
   自己的提升脚本、CI、Agent）必须能不解析自然语言就区分「已推送待拉取」「已完成」「失败」，否则它只能靠
   grep 判断，那等于没有命令面（违反 ADR-0008）。
3. **重启已记录但推回远端 `main` 失败时的状态**。ADR-0047 D01 把推回放在重启核对之后，但没有规定推回失败后
   记录处于什么状态。若写 `FAILED`，用户重跑只能得到一个终态回放，只能手工 `git push origin main`；若重新走一遍
   重启序列，会再停一次正在正常运行的稳定 Runtime——而它其实已经拉起并检查过了。

## Options

1. 失败分类：(a) 一律 `FAILED`；(b) 一律 `STALE`（重新 prepare）；(c) 按「记录是否仍然正确」分：可达性/被拒
   保持记录可重试，远端被移动标 `STALE`。
2. 「等待拉取」的表达：(a) 只用文字；(b) 新增状态值；(c) 复用现有状态 + 派生的 `phase` 字段 + 专用退出码。
3. 推回失败后的收口：(a) 终态 `FAILED`；(b) 保持可续状态，只重试推回这一步。
4. dev clone 的核验口径：(a) 只要求是 Git 仓库；(b) 要求「另一个 clone、同 `origin`、HEAD 在项目 `dev` 分支、
   该分支存在」，不可核验即拒绝并给出稳定码。

## Decision

选择 1(c)、2(c)、3(b)、4(b)。具体事实分层：

### D01：可重试的拒绝 vs 记录失效

- `REMOTE_DEV_UNREACHABLE`、`DEV_PUSH_REFUSED`：**不改状态**，只在记录上写 `outcome_code`/`detail`（新的
  `PromotionPushRefused` 事件），记录保持 `CREATED`/`AWAITING_APPROVAL`，同一命令可重试。**不标 `STALE`**，
  因为记录仍然正确，且断网是环境事实而不是候选事实。
- `REMOTE_DEV_MOVED`（读回的 `origin/dev` 不是候选、也不是它的祖先）：标记记录 `STALE` 并拒绝，
  `prepare`/`approve`/`promote` 三个入口都拒绝且**不移动任何 ref**。远端 `dev` 是提升的事实来源，
  它一旦移位，记录里「候选即远端」的前提就失效了。
- `REMOTE_DEV_READBACK_MISMATCH` / `REMOTE_MAIN_READBACK_MISMATCH`：push 退出码 0 但读回不是候选。
  **不写**读回列、不记已推送/已完成；前者保持记录可重试，后者让记录停在 `MAIN_PUSH_PENDING`。

### D02：「已推送」用状态 + 派生 `phase` + 退出码 3 表达

- `PROMOTING` 的含义被收窄为「已 push 到远端 `dev` 且读回核对通过、main 检出尚未拉取」（此前它是
  「Runtime 可能已移动 main」）。`RESTARTING` 的含义是「已观察到 main 检出在候选上」。
- 新增**派生**字段 `phase ∈ {READY_TO_PUSH, AWAITING_PULL, RESTART_PENDING, MAIN_PUSH_PENDING,
  COMPLETE, REFUSED}`：从 `state` + `restart_result_json` 推导，**不落列**——同一事实只有一个来源，
  不会出现状态机与派生字段互相矛盾。
- CLI：`promotion promote` 在 `AWAITING_PULL` 时退 **3**（0 成功 / 1 拒绝或失败 / 2 用法错误 / 3 已推送待拉取），
  并在 stderr 打印用户在 main 检出要执行的两条命令。该状态下**不执行也不记录任何重启步骤**。

### D03：推回失败保持可续，只重试推回

- 重启记录成功（不同 boot + `READY` + 全部步骤退 0）后立刻推回远端 `main` 并读回；
- 推回失败或读回不等：记录**保持 `RESTARTING`**（`phase: MAIN_PUSH_PENDING`），写入
  `MAIN_PUSH_REFUSED`/`REMOTE_MAIN_READBACK_MISMATCH` 与观察值，**不**写 `completed_at`；
- 再次调用 `promotion promote` 在「重启已记录」的分支上**只重试推回**，不重复停 Runtime、不重复记账；
- `SUCCEEDED` 的必要条件因此是：main 检出在候选上 + 重启已记录且被核对 + 读回的远端 `main` 等于候选。

### D04：dev clone 的核验口径与稳定码

`project trust --dev-repo <path>` 与 `project inspect [--dev-repo <path>]` 用同一套核验（`apps/runtime/src/dev-repo-service.ts`），
任一条不成立即拒绝且**不写入空值**：`DEV_REPO_NOT_A_REPOSITORY`、`DEV_REPO_NOT_SEPARATE`（它是 main 检出自身或
其 worktree：同一个 Git common dir）、`DEV_REPO_ORIGIN_UNKNOWN`、`DEV_REPO_ORIGIN_MISMATCH`、
`DEV_REPO_BRANCH_MISMATCH`、`DEV_REPO_DEV_REF_MISSING`；push 前另核 `DEV_REPO_CANDIDATE_MISSING`
（候选对象不在该 clone 里，推不了）。`--dev-repo none` 是显式清除；省略该 flag 时保留已记录值。

### D05：只在测试里模拟远端

push/读回的实现（`packages/git/src/promotion.ts` 的 `pushCommitToRemote`/`readRemoteRef`）对所有远端一致工作，
测试一律用 `git init --bare` 的临时裸仓库与被 `pre-receive`/`post-receive` 钩子操纵的远端；**任何测试与验收都不对
真实 GitHub 仓库做写操作**。

## Consequences

- 「已推送」「已拉取」「已发布」「已完成」现在都是可读、可断言的记录事实，`--json` 与 `promotion get` 直接给出
  `phase`/`remoteDevCommit`/`remoteMainCommit`/`pushedAt`/`mainPushedAt`；退出码 3 让脚本不再需要解析文字。
- 断网不会再让用户重做 prepare/approve；代价是记录可能在 `CREATED` 状态下带着一个 `outcome_code`，
  因此**不能**把「有 `outcome_code`」当作「已失败」——状态与 `phase` 才是判据。
- `STALE` 现在也可从 `PROMOTING` 进入（此前只允许 `CREATED`/`AWAITING_APPROVAL`），因为推送到远端是发生在
  「拉取之前」的副作用，而它的前提也可能失效。
- 稳定提升的完成判据更严：远端 `main` 被移动/不可读时提升不算完成，即使本机 main 检出已经在候选上并已重启。
- 未声称：GitHub 侧分支保护/必经评审/CI 门禁；系统外手动更新 `main` 的监控；真实 GitHub 上的提升（本格只做
  临时裸仓库验证，本仓库自身的提升仍按 `AGENTS.md` 的人工四步）。

## Verification

FOUNDATION-077 已断言（`apps/runtime/test/promotion-service.test.ts`、`apps/runtime/test/cli-promotion.test.ts`、
`apps/runtime/test/dev-repo-service.test.ts`、`packages/git/test/promotion.test.ts`、
`packages/storage/test/dev-clone-promotion.test.ts`）：

- push 成功后读回等于候选才进入 `PROMOTING`/`AWAITING_PULL`（CLI 退出码 3），且此时没有任何重启记账；
- `post-receive` 钩子把远端 `dev` 移到别处 → `REMOTE_DEV_READBACK_MISMATCH`，不记已推送、不移动 refs；
- `pre-receive` 钩子拒绝 push → `DEV_PUSH_REFUSED`，记录仍在 `CREATED` 可重试，远端与本地 refs 均未移动；
- 远端 `dev` 被移到非候选 SHA → `prepare`/`approve`/`promote` 均拒绝、记录 `STALE`、不移动任何 ref；
- 非 fast-forward（远端领先/分叉）→ 拒绝而不是 `--force`；
- 远端目录被删除（不可达）→ `REMOTE_DEV_UNREACHABLE`，记录**不**变 `STALE`；
- 拉取后再调用 → 记录重启计划并执行序列，重启记录成功后才推回 `main`（读回等于候选）→ `SUCCEEDED`；
- 推回被拒 → 记录保持 `RESTARTING`/`MAIN_PUSH_PENDING`，重启证据保留，重试只推回；
- dev clone 的核验：合法/同一 clone/非 Git 目录/`origin` 不符/分支不符/候选缺失各有断言与稳定码。

## Related

- ADR-0047（被本 ADR 细化：唯一提升路径、远端即事实来源、拉取是人工步骤）
- ADR-0048（两个独立 clone 是本 ADR 的物理前提）
- ADR-0008/0011（CLI 完备性与零确认）
- ADR-0009 D03（重启序列与记账）、ADR-0038/0039（提升前全量证据）
- `docs/architecture/git-workspace-api.md` §3、`state-machines.md` §4、`sqlite-schema.md` §8、
  `docs/guides/cli-reference.md` §3 与 §15
