# 安装与第一次运行

> **适用版本** `dev@6c7de03`（2026-09-17） · **schema** v36 · **最后校对** 2026-09-17
> 版本会前进：`dev@6c7de03` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 权限模式的命令拼写由 FOUNDATION-098 同步为 `settings permission get|set`（ADR-0064：顶层 `permission` 已移除；§19 另新增 `settings list` 总览）。
> §4.3 的影响映射含义提醒已按 ADR-0059 改写（FOUNDATION-091）；其余内容沿用原有校对基线。

本文带你从零把 Codeestra 跑起来：安装依赖 → 启动 Runtime → 用 CLI 接入第一个 Git 项目。

所有示例都可以照抄执行。涉及会改状态的命令（`trust` 等）都标注了**前提**与**影响**。

---

## 1. 依赖

Codeestra 用 Bun 运行，用 Node + Vitest 作为开发测试宿主。

| 工具 | 版本 | 用途 |
|---|---|---|
| Bun | 1.3.13 | 运行 Runtime 与 CLI，包管理（`packageManager` 字段固定） |
| Node | 24.19.0 | 测试宿主（Vitest） |
| TypeScript | 5.9.3 | 类型检查 |
| Git | 任意较新版本 | 项目接入、工作树、分支、成果 commit |

本机用 Nix 提供工具，不需要全局 npm 安装：

```sh
nix shell nixpkgs#bun nixpkgs#nodejs_24 nixpkgs#just
```

安装依赖（`--frozen-lockfile` 表示严格按 `bun.lock` 安装，不改锁文件）：

```sh
bun install --frozen-lockfile
```

> ADR-0067 起 Web UI 已暂停。默认安装、检查和运行流程不构建 `apps/ui`。

---

## 2. Runtime 与数据目录

Runtime 是**每用户单实例**的本地服务：一个 `CODEESTRA_HOME` 对应一个 Runtime，通过该目录下的 Unix socket
`runtime.sock` 通信。

数据目录解析顺序（与 `apps/runtime/src/paths.ts` 一致）：

1. 环境变量 `CODEESTRA_HOME`（若设置）
2. 否则 `$XDG_STATE_HOME/codeestra`
3. 否则 `~/.local/state/codeestra`

安全属性（源码核对）：

- `CODEESTRA_HOME` 目录会被 `chmod 0700`。
- `runtime.sock` 会被 `chmod 0600`。

想试跑而不污染日常数据，换一个数据目录即可：

```sh
export CODEESTRA_HOME=/tmp/codeestra-demo
```

> **单实例注意**：CLI 客户端只按 `CODEESTRA_HOME` 找 socket。如果某个工作树里已经有稳定 Runtime 在跑，
> 你在另一个工作树执行 `bun run codeestra …` 会打到**那个** Runtime（即那份代码），不会启动你当前工作树的构建。
> 要验证另一份代码请换 `CODEESTRA_HOME`。

---

## 3. 第一次运行：`codeestra status`

```sh
bun run codeestra status
```

CLI 会自动寻找 Runtime；**没有在跑就自动拉起它**，然后打印 `runtime.ping` 结果与一份 ownership 报告。
输出是 JSON，字段如下（`runtimePingResultSchema` + `ownershipSummary`）：

```jsonc
{
  "pid": 12345,
  "bootId": "…",
  "startedAt": 1730000000000,
  "status": "READY",
  "permissionMode": "FULL",          // 当前权限模式
  "adapters": ["pi", "codex", "claude"],
  "activeSessions": [],
  "eventSubscribers": 0,
  "ownership": {
    "home": "/tmp/codeestra-demo",
    "socketPath": "/tmp/codeestra-demo/runtime.sock",
    "socketPresent": true,
    "endpointAnswers": true,
    "verdict": "…",                  // 从生命周期记录推出的结论
    "lock": { /* 该 home 的锁记录：pid / bootId / startToken */ },
    "traces": [ /* 启动轨迹 */ ],
    "unreadableRecords": []
  }
}
```

要点：

- `status` 是**只读**的：它会启动 Runtime（若不在跑），但不会替换或杀掉一个「进程在、socket 不应答」的 Runtime，
  而是把事实报告出来（`status: "UNAVAILABLE"`）。
- 退出码：`0` 表示 Runtime 可用；`1` 表示连不上也起不来。

看一眼当前权限模式：

```sh
bun run codeestra settings permission get
# {"mode":"FULL","default":"FULL"}
```

`FULL` 是产品默认。切到 `STRICT` 无需确认，随时可切回：

```sh
bun run codeestra settings permission set strict
bun run codeestra settings permission set full
```

| 模式 | 行为差异（源码核对） |
|---|---|
| `FULL`（默认） | 项目接入不确认；工具调用自动允许；成果 commit 可单步 `task result capture`；验证策略变化不确认 |
| `STRICT` | 项目接入需输入 `TRUST`（脚本用 `--yes`）；工具调用经 gate 逐次审批；成果 commit 分两步（先 `prepare` 拿授权，再 `commit … --confirm`）；验证策略变化需确认 |

> 注意：Runtime 内部对「未显式传模式」的调用默认按 `STRICT` 处理；CLI 会显式传入当前模式。

---

## 4. 接入第一个项目

假设你的仓库在 `/path/to/repo`。第一件事是**看看 Codeestra 读到了什么**。

### 4.1 `project inspect`：看清仓库身份

```sh
bun run codeestra project inspect /path/to/repo
```

打印仓库身份，关键是这几项：

- `repoRoot`：Git 工作树根。
- `mainRef` / `objectFormat`：主分支 ref 名与对象格式（sha1 / sha256）。
- `headCommit`：当前 HEAD。
- `devRef` / `devCommit`：`dev` 分支是否存在及其 commit。

Codeestra 要求项目**长期保留 `main` 与 `dev` 两个分支**（ADR-0009）。若 `dev` 缺失，`open`/`trust` 的提示会明确
写「必须先创建 dev 分支」，`project.trust` 会以 `DEV_REF_MISSING` 拒绝。

### 4.2 `project policy`：谁将来判定你的成果

```sh
bun run codeestra project policy /path/to/repo
```

它读取**项目 `main` ref 上**的 `.codeestra/policies/verification.json` 并打印策略状态与 digest。这个文件是
**人工维护**的：Task 分支改不动判定它自己的命令（这是安全不变量，不是配置细节）。

如果策略不存在，`task verify` 会拒绝，直到该 ref 上有这个文件。

### 4.3 `project impact validate`：冲突判定映射

```sh
bun run codeestra project impact validate /path/to/repo --json
```

读取 `main` ref 上的 `.codeestra/impact.json`。这张映射只被 `--feature` 的**写入校验**与快照证据用到；
**判定不再读映射**，所以没有映射不会让任务互相等待（ADR-0059）。退出码 `0` 仅当映射存在**且**是已确认的那一份
（`OK` / `OK_UNTRUSTED`）；否则 `1`。

### 4.4 `project trust`：正式接入

```sh
# FULL（默认）：无确认
bun run codeestra project trust /path/to/repo

# STRICT：需要确认，交互输入 TRUST，或脚本传 --yes
bun run codeestra settings permission set strict
bun run codeestra project trust /path/to/repo --yes
```

**前提**：仓库是合法 Git 仓库；`main` ref 可读；并且**不要停在 detached HEAD**（`project trust` 要在这里读检出分支来建立
integration ref；那之后建 Task 只需要这条 ref，缺了它才以 `TASK_BASE_REF_UNRESOLVED` 拒绝）。

**Task 基线只有一种**（ADR-0074）：**这个项目受管的 integration ref**（`refs/codeestra/integration`）当时的 commit。
`project trust` 用本文件夹当时检出的分支把它建出来；ref 与 commit 会一起固定，之后你切分支或集成推进都不会移动已建
Task 的基线。产品不再有 dev clone、长期 `dev` 集成分支或 `dev → main` 提升，所以 trust **没有 `--dev-repo`**、
也不会返回 `DEV_REPO_*`。成果先停在 `refs/heads/task/<task-id>`，再经 `project integration request` / `run`
进入 integration ref；**推到你自己的分支仍没有命令**。

**影响**：一旦 trust，Agent 工具、验证命令与 Git hooks 会**以你的用户权限**运行。STRICT 下文本明确写着：
这**不**授权 commit、更新 main、push 或使用未知工具。

**幂等性与防漂移**（源码核对）：`trust` 会把「你刚刚看过的那份身份 + 验证策略 digest + 影响映射 digest」
一起提交。若在你查看与确认之间这些文件动了，Runtime 以 `VERIFICATION_POLICY_CHANGED` 或
`IMPACT_POLICY_CHANGED` 拒绝，而不是静默按新的内容确认。仓库身份变了则以 `REPOSITORY_CHANGED` 拒绝。
同一个项目可以有多份工作树（稳定 `main` 树与开发树）：Runtime 按 **Git common dir** 识别一个 Project，
所以再打开另一个工作树是幂等的。

信任成功后的投影：

```jsonc
{
  "trusted": true,
  "permissionMode": "FULL",
  "repository": { /* inspect 的身份 */ },
  "devRef": "refs/heads/dev",
  "devCommit": "…",
  "verificationPolicy": { "state": "PRESENT", "mainRef": "...", "mainCommit": "...", "digest": "..." },
  "impactPolicy": { /* 映射状态与确认情况 */ }
}
```

列出已接入的项目：

```sh
bun run codeestra project list
```

### 4.5 Web UI 入口已删除

ADR-0067 起 `open` 与 `ui` 都是未知命令。日常接入流程就是上面的显式 CLI 命令：

```sh
bun run codeestra project inspect /path/to/repo
bun run codeestra project policy /path/to/repo
bun run codeestra project impact validate /path/to/repo --json
bun run codeestra project trust /path/to/repo       # STRICT 脚本可加 --yes
bun run codeestra project list
```

保留的 `apps/ui` 与 HTTP 源码不代表可用入口。详情见 [ADR-0067](../decisions/0067-pause-web-ui-and-cli-focus.md)。

---

## 6. 停止 Runtime

```sh
bun run codeestra stop                # 默认等待 10 秒
bun run codeestra stop --wait 30      # 最多等 30 秒（0–600）
```

`stop` 是两阶段且**只报事实**的：

- 它先问「拥有这个 `CODEESTRA_HOME` 的 Runtime」自己是谁，然后**轮询那个进程**是否真的消失；
- `STOPPED`（退出码 0）/ `NOT_EXITED`（1，进程还在）/ `NOT_RUNNING`（没有 Runtime 拥有该 home）/
  `UNREACHABLE_PROCESS`（1，进程在但 socket 不应答，**不会被猜着杀掉**）。

它**不会**为了让 `stop` 成功而启动一个 Runtime，也不会信号化一个它无法识别的进程。

---

## 7. 这个环境下最常踩的三件事

1. **`ui` / `open` 报用法错误** → Web UI 已按 ADR-0067 暂停；使用 `project trust` 与其它 CLI 命令。
2. **CLI 打到了别的 Runtime** → 检查 `CODEESTRA_HOME`；一个 home 只跑一个 Runtime。
3. **`project trust` 报 `REPOSITORY_CHANGED` / `VERIFICATION_POLICY_CHANGED`** → 你查看身份/策略与确认之间，
   它们变了。重新 `project inspect` 看一遍再信任。（`DEV_REPO_*` 系列稳定码已随 ADR-0066 删除。）

更多报错见 [troubleshooting.md](./troubleshooting.md)。

---

## 下一步

- 概念与边界：[concepts.md](./concepts.md)
- 端到端流程：[workflow.md](./workflow.md)
- 功能清单：[features.md](./features.md)
