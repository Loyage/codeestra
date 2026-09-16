# 安装与第一次运行

> **适用版本** `dev@17b4dd6`（2026-09-16） · **schema** v32 · **最后校对** 2026-09-16
> 版本会前进：`dev@17b4dd6` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> §4.3 的影响映射含义提醒已按 ADR-0059 改写（FOUNDATION-091）；其余内容沿用原有校对基线。

本文带你从零把 Codeestra 跑起来：安装依赖 → 启动 Runtime → 接入第一个 Git 项目 → 打开 Web UI。

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

如果要使用 Web UI，还需要**构建前端资产**（`apps/ui/dist` 是 gitignore 的本地状态，每个工作树各自构建）：

```sh
bun run build:ui
```

> 没构建 UI 资产就请求界面时，Runtime 会以稳定码 `UI_ASSETS_MISSING` 拒绝，提示信息里给出上面这条构建命令。

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
- HTTP 界面只绑定 `127.0.0.1`，并且每个 Runtime 进程启动时生成一次性内存 bearer token；token 只放在
  打开地址的 URL **fragment**（`#token=…`）里，fragment 不会发给服务器。

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
  "uiRunning": false,
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
bun run codeestra permission get
# {"mode":"FULL","default":"FULL"}
```

`FULL` 是产品默认。切到 `STRICT` 无需确认，随时可切回：

```sh
bun run codeestra permission set strict
bun run codeestra permission set full
```

| 模式 | 行为差异（源码核对） |
|---|---|
| `FULL`（默认） | 项目接入不确认；工具调用自动允许；成果 commit 可单步 `task result capture`；验证策略变化不确认 |
| `STRICT` | 项目接入需输入 `TRUST`（脚本用 `--yes`）；工具调用经 gate 逐次审批；成果 commit 分两步（先 `prepare` 拿授权，再 `commit … --confirm`）；验证策略变化需确认 |

> 注意：Runtime 内部对「未显式传模式」的调用默认按 `STRICT` 处理；CLI 与 UI 都会显式传入当前模式。

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
bun run codeestra project trust /path/to/repo --dev-repo /path/to/dev-clone

# STRICT：需要确认，交互输入 TRUST，或脚本传 --yes
bun run codeestra permission set strict
bun run codeestra project trust /path/to/repo --dev-repo /path/to/dev-clone --yes
```

**前提**：仓库是合法 Git 仓库；`main` ref 可读；**另有一个同 origin 的 dev clone 检出 `dev`**
（ADR-0056：`--dev-repo` 必需，它是全部 dev 事实的唯一来源；省略该 flag 以 `DEV_REPO_REQUIRED` 拒绝且不写入任何东西）。

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

### 4.5 一条命令搞定：`open`

日常最快路径是 `open`：它把 inspect → 策略展示 →（必要时）确认 →（UI 实例）打开界面串起来。

```sh
bun run codeestra open /path/to/repo            # 接入并打开 Web UI，pre-select 该项目
bun run codeestra open /path/to/repo --no-open  # 同上，只打印带 token 的地址
bun run codeestra open /path/to/repo --yes      # STRICT 下的非交互确认
```

`open` 会明确打印：`dev baseline`、验证策略命令清单、影响映射状态，以及**是否需要再次确认**。已经确认过且
策略 digest 未变时会直接跳过确认（正常路径**一次项目一次确认**；FULL 下连这一次都没有）。

---

## 5. 打开 Web UI

```sh
bun run codeestra ui            # 启动 HTTP/SSE 并按需打开浏览器
bun run codeestra ui --no-open  # 只打印地址
```

输出的是界面 URL，token 在 fragment 里。两点提示（CLI 自己会打印）：

- token 只留在你的终端与浏览器会话中；
- 关掉浏览器**不会**停止 Runtime 或任何 Task。

如果只想从 `open` 拿到链接，用 `bun run codeestra open . --no-open`。

UI 与 CLI 是**同一个命令面**：界面通过 `POST /api/command` 发送与 CLI 完全相同的请求结构，事件通过
`GET /api/events` 的 SSE 流获取。详情见 [ui.md](./ui.md) 与 [cli-reference.md](./cli-reference.md) 的
「HTTP / SSE 面」一节。

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

1. **UI 打不开、报 `UI_ASSETS_MISSING`** → 先 `bun run build:ui`。
2. **CLI 打到了别的 Runtime** → 检查 `CODEESTRA_HOME`；一个 home 只跑一个 Runtime。
3. **`project trust` 报 `DEV_REPO_REQUIRED`** → 没有给出（或没记录）dev clone。先 clone 一份同 origin 的
   检出并 `git checkout dev`，再 `project trust <repo> --dev-repo <dev-clone>`（ADR-0056）。
   dev clone 上没有 `dev` 分支时报 `DEV_REPO_DEV_REF_MISSING`。

更多报错见 [troubleshooting.md](./troubleshooting.md)。

---

## 下一步

- 概念与边界：[concepts.md](./concepts.md)
- 端到端流程：[workflow.md](./workflow.md)
- 功能清单：[features.md](./features.md)
