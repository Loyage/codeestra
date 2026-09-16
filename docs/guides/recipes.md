# 常见任务的做法（recipes）

> **适用版本** `dev@7425556` + 本格分支 `Loyage/task_auto`（2026-09-17） · **schema** v35 · **最后校对** 2026-09-17
> 版本会前进：`dev@7425556` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> recipe 1/2/3 的创建命令与 §「我想改一个 bug」后的修订示例由 **ADR-0065** 改写
> （必填 `--title`/`--name`；`--constraint`/`--kind` 已删除，限制写进详情）。
> 权限模式的命令拼写由 FOUNDATION-098 同步为 `settings permission get|set`（ADR-0064：顶层 `permission` 已移除；§19 另新增 `settings list` 总览）。
> recipe 3 与 recipe 4 由 FOUNDATION-091 按 ADR-0059 改写（默认不冲突、声明同一功能才互斥）；
> recipe 3 的容量命令由 **FOUNDATION-096** 同步（ADR-0061：上限是唯一的 Runtime 全局值，命令不带 project 参数；
> 同一值另有设置面拼写 `settings concurrency`，也在本 recipe 里给出）。
> recipe 12 补充「集成成功后自动回收」（ADR-0062）。

本文是**步骤化**的：每条 recipe 回答一个「我想做 X」，给出可以照抄的命令与**做完之后看什么**。

约定：

- `$PROJECT` = `project list` 返回的 Project ID；
- `$TASK` = `task create` 返回的 task id；
- `<version>` = 该 Task 当前的 `version`（乐观版本号）。**它每次改状态都会变**——用 `task status` 或
  上一条命令的输出重新取，不要凭记忆复用。
- 每条命令的完整参数与退出码见 [cli/README.md](./cli/README.md)（九篇索引）；
  报错怎么办见 [troubleshooting.md](./troubleshooting.md)。

---

## 0. 每条 recipe 都会用到的三句

```sh
bun run codeestra status                      # Runtime 在不在、什么权限模式
bun run codeestra task list $PROJECT          # 手上有哪些任务
bun run codeestra task status $PROJECT $TASK  # 这个任务现在到底是什么状态
```

**记住退出码的三分法**：`0` 成功（某些命令是「已受理」）、`1` 拒绝或失败、`2` 用法错误、
`3` 等待或没什么可做。`3` **从不表示 `BLOCKED`**。

---

## 1. 我想改一个 bug

**目标**：把一个具体的缺陷修掉，让改动经过验证并进入 `dev`。

```sh
# 1) 描述得具体一点：现象、期望、边界、验收方式。过去写作约束的限制直接写进正文。
#    （详情是一整段文本，双引号里直接写；需要多行时用 shell 的 $'…' 或 heredoc。）
#    另两个字段：--title 是任务列表显示的一句话；--name 是分支/目录名（小写短横线 slug）。
bun run codeestra task create $PROJECT \
  "修复 CRLF 输入被 parser 吞掉的缺陷：现象是含 CRLF 的输入末尾多出一个 token，期望与 LF 输入结果一致，验收方式是新增一个覆盖 CRLF 的用例；不得改动公开 API" \
  --title "修复 CRLF 输入被 parser 吞掉" --name "fix-parser-crlf"

# 2) 提交（这一步会顺手核对依赖并跑一次调度 pass）
bun run codeestra task submit $PROJECT $TASK <version>

# 3) 看它为什么还没跑（如果确实没跑）
bun run codeestra task schedule explain $PROJECT $TASK --json

# 4) 启动（如果调度还没轮到，也可以手动请求一次；退出码 3 = 在等）
bun run codeestra task run $PROJECT $TASK <version>

# 5) 盯着看（会话、日志、事件）
bun run codeestra task status $PROJECT $TASK
bun run codeestra task transcript $PROJECT $TASK

# 6) Agent 退出后提交成果
bun run codeestra task result capture $PROJECT $TASK

# 7) 验证 → 合入 dev
bun run codeestra task verify $PROJECT $TASK
bun run codeestra task integrate $PROJECT $TASK <version>
```

**做完看什么**：`task status` 里 `verifications[0].state` 是 `PASSED`，
`integrations[0].state` 是 `INTEGRATED`，Task 到 `SUCCEEDED`。

**别指望**：`SUCCEEDED` 只说明**已合入 dev**，不代表 `main` 已发布（见 recipe 10）。

---

## 2. 我想加一个小功能

**目标**：加一个不大但完整的能力，并控制它的影响范围。

```sh
bun run codeestra task create $PROJECT \
  "为 status 输出增加 adapters 列表：目标是 runtime.ping 已返回 adapters、CLI status 也打印它，范围只改 apps/cli 的输出，不改 packages/contracts 与 apps/runtime，验收是 status 输出里能看到三个 adapter id" \
  --title "status 输出增加 adapters 列表" --name "status-adapters-list"
```

其余步骤同 recipe 1。

**小功能与 bug 的区别**在于「影响范围」：加功能更容易碰到别人也在改的地方，所以更值得先看冲突判定：

```sh
bun run codeestra project impact validate /path/to/repo --json     # 映射存在且被确认吗？
bun run codeestra project impact explain  $PROJECT $TASK --json    # 和已声明同一功能的未完成任务有没有冲突
```

**别指望**：判定只看声明（ADR-0059）。同文件/同目录/共享依赖都不拦；两个都没声明功能的 Task 可以改同一个文件，
冲突到合入 `dev` 时才以 `CONFLICTED` 暴露。想让两件事互斥就给它们声明同一个功能（见 recipe 4）。

### 2.1（可选）顺手写下这个分支的定向测试

如果这个任务要开一个新的 `task/*`、`lane/*` 或 feature 分支，**在建分支时就**写下它自己的小测试计划：

```sh
bun run codeestra task tests record $PROJECT $TASK
bun run codeestra task tests show   $PROJECT $TASK
```

`.codeestra/tests.json` 是「一个 scope 说明 + 1–16 条带 `covers` 的 argv 命令」。
`task verify` 跑的是**已记录的计划**（不是文件本身），所以事后改文件不会悄悄改变判定命令。

---

## 3. 我想同时做两件互不相干的事

**目标**：两条工作同时推进。ADR-0059 之后这已经是**默认**行为：没有声明同一个功能的 Task 不再相互等待。

```sh
# 1) 两个任务都建好、都提交（提交就会在容量允许时自动开始）
bun run codeestra task create $PROJECT "把 A 模块的错误码补全；只改 A 模块" \
  --title "A 模块错误码补全" --name "module-a-error-codes"
bun run codeestra task submit $PROJECT $TASK_A <version-a>
bun run codeestra task create $PROJECT "把 B 模块的文档补全；只改 B 模块" \
  --title "B 模块文档补全" --name "module-b-docs"
bun run codeestra task submit $PROJECT $TASK_B <version-b>

# 2) 需要确认时再问一句「它们现在到底跑不跑」
bun run codeestra project impact explain $PROJECT $TASK_A --json   # 退出码 0 仅当 SAFE_TO_PARALLELIZE
bun run codeestra project impact explain $PROJECT $TASK_B --json

# 3) 没启动就显式请求一次（容量上限默认是 2）
bun run codeestra task run $PROJECT $TASK_A <version-a>
bun run codeestra task run $PROJECT $TASK_B <version-b>

# 4) 看谁占着槽位、谁在跑（容量是整个 Runtime 的，不按项目分）
bun run codeestra scheduler capacity get      --json
bun run codeestra scheduler reservations list $PROJECT
bun run codeestra task schedule status        $PROJECT
```

**必须知道的三件事**：

1. **冲突只看声明。** 判定比较两个 revision 是否声明了**同一个功能**（`--feature <module-id>`，取自
   `.codeestra/impact.json` 的 `modules[].id`），不用模型。**同文件/同目录/共享依赖都不再拦人**；
   两个都没声明功能的 Task 可以改同一个文件，冲突在合入 `dev` 时以 `CONFLICTED` 暴露。
2. **容量上限默认是 2，而且是整个 Runtime 的。** 它跨你接入的**所有项目**与 Adapter：两个项目各自跑一个任务就已经占满了。想让更多任务同时跑就显式提高上限（零确认）：
   ```sh
   bun run codeestra scheduler capacity set --limit 4      # 调度面拼写
   bun run codeestra settings concurrency set --limit 4    # 设置面拼写：同一条命令、同一个值
   bun run codeestra settings concurrency reset            # 回到默认 2
   ```
   改完**立刻生效**，不需要重启：提高上限后正等容量的任务会立即有机会启动。
   降低上限**不会**停掉已经跑着的任务（`get` 的 `used` 可能大于 `limit`），只阻止之后的新任务。
3. **想让两件事互斥，就给它们声明同一个功能**（见 recipe 4）。

**做完看什么**：`task schedule status` 的「活跃集合」里有两条；`scheduler capacity get` 的 `used` 为 2（这是**整个 Runtime** 的已用，不是你当前项目单独的）。

---

## 4. 两件事互相冲突怎么办

**目标**：知道冲突是什么、是「声明了同一功能」还是「没声明」，然后选一条**明确**的路。

```sh
# 1) 先问「它为什么不跑」
bun run codeestra task schedule explain $PROJECT $TASK --json
bun run codeestra project impact explain $PROJECT $TASK --json
```

退出码与含义：

| 退出码 / 判定 | 含义 | 你能做什么 |
|---|---|---|
| `0` / `SAFE_TO_PARALLELIZE` | 没有与未完成的任务声明同一个功能（默认） | 等调度，或 `task run` |
| `3` / `WAIT_CONFLICT` | 与某个未完成的任务**声明了同一个功能** | 等对方完成（`SUCCEEDED`/`CANCELLED`/归档），或改用互斥声明/改规格 |
| `3` / `WAIT_CAPACITY` | 容量满了 | 等槽位释放，或显式提高上限 |
| `1` / `BLOCKED` | **依赖未满足**（与冲突无关） | 见 recipe 5 |
| `1` / `CONFLICTING` | **声明了同一功能且对方未完成** | **永远不放行**。改成串行，或把声明改成不相干的功能 |

**如果是 `UNKNOWN`**（ADR-0059 之后当前规则**不再产生它**，只可能来自历史 assessment 行）——
你仍然可以用保留的显式单次放行；`CONFLICTING` 永远不放行：

```sh
# 路 A：等。什么都没变，这是默认行为。
bun run codeestra task schedule run $PROJECT      # 手动请求一次调度（不会改变判定规则）

# 路 B：显式单次放行（风险由你承担）
bun run codeestra task schedule clear-unknown $PROJECT $TASK
#   或者直接在启动时放行：
bun run codeestra task run $PROJECT $TASK <version> --allow-unknown

# 路 C：把功能声明理清楚（声明不相干的功能，或给对方腾出空间）
#   声明写在 revision 上，用 task revision create --feature 改写；
#   id 必须是 main ref 上 .codeestra/impact.json 的 modules[].id
bun run codeestra task revision create $PROJECT $TASK <version> --feature <module-id> --reason "把声明拆开"
bun run codeestra project impact validate /path/to/repo --json
```

**放行到底做了什么**（必须看清）：

- 它绑定 revision、基线与分析器/策略版本，写入审计台账，被**恰好一次**启动消费；
- 它**不改变已记录的判定**：那次 assessment 仍然是 `UNKNOWN`（不是 `SAFE`）；
- 放行后 Runtime **不做额外隔离**；若两者越界，责任在放行的人；
- 任务修订、基线变化、映射/分析器/策略版本变化、实际 diff 超出预测 → 放行**失效**。

---

## 5. 我想换一个 Agent 或模型

**目标**：让下一步用另一个 adapter 或另一组模型参数。

### 5.1 换 Adapter

```sh
# 方式 A：启动/继续/重试时指定（一次执行绑定一个 Agent）
bun run codeestra task run    $PROJECT $TASK <version>  --adapter claude
bun run codeestra task resume $PROJECT $TASK <version>  --adapter codex
bun run codeestra task retry  $PROJECT $TASK <version>  --adapter pi

# 方式 B：在界面上选（任务详情里的「Agent」下拉框）
# 方式 C：重试时换 Agent（任务详情 →「更多操作」→ 重试块的「这次使用的 Adapter」下拉框）
#   - 默认项是「沿用该任务上一次运行的 Adapter（<id>）」——这就是 CLI 不带 --adapter 的语义
#   - 其余选项来自 runtime.ping 报的已注册 adapter 列表；选一个才带 adapterId
#   - 上一次的 adapter 已不在注册表时，命令面会回退到默认 adapter（adapterSource: FALLBACK）
```

可用的 adapter 是 `pi`（默认）、`codex`、`claude`（用 `codeestra status` 的 `adapters` 字段确认）。

**关键语义**：**换 `--adapter` 是新建一次 Execution，不是在同一个 Execution 里换 Agent。**
原来那次执行的历史、失败与证据原样保留，不会被重写。

### 5.2 换模型 / Provider / 思考深度

```sh
# 看当前生效值与每一项的来源（环境变量 / 项目覆盖 / 全局默认 / 适配器默认）
bun run codeestra agent config get --project $PROJECT --adapter pi

# 全局默认
bun run codeestra agent config set --adapter pi --model <model-id> --thinking high

# 只对这个项目覆盖
bun run codeestra agent config set --project $PROJECT --adapter pi --model <model-id>

# 清掉某一项或整段
bun run codeestra agent config set   --project $PROJECT --adapter pi --unset model
bun run codeestra agent config clear --project $PROJECT --adapter pi
```

**两个必须知道的边界**：

1. **配置只影响此后新建的 Session**，不重启 Runtime、不需要确认。已经跑起来的那次执行不会改变。
2. **环境变量那一层优先级最高，而且只属于当前 Runtime 进程**：`CODEESTRA_PI_MODEL` 之类的变量会盖住你
   在这里保存的值，改它要重启 Runtime。`agent config get` 的 `sources` 会如实告诉你是哪一层在生效。

### 5.3 换插件（扩展 / 技能 / 提示词模板 / 主题）

```sh
bun run codeestra agent plugins list   --project $PROJECT --adapter pi --json
bun run codeestra agent plugins select --project $PROJECT --adapter pi \
  --skill /path/to/skill --clear
```

界面上的「Agent 设置」标签页做的是同一件事（勾选 = 整份选择替换）。
**如实告知**：勾选第三方 extension 可能影响或绕过 Pi 的 fail-closed 审批门禁（该事实会被记进 Execution）；
Codex 与 Claude 当前如实报告 `pluginSelection: UNSUPPORTED`。

---

## 6. 我想换一个已有任务继续

**目标**：不新建任务，而是在**同一个任务和工作树**上接着干。先分清四种情况：

| 现在的状态 | 用哪条命令 | 说明 |
|---|---|---|
| `PAUSED` | `task resume` | 在同一工作树新建一次执行，**复用已暂停会话的 provider conversation** |
| `FAILED` | `task retry` | 只对 `FAILED` 生效；重新入队，之后走**同一条调度门禁**（会排队，不插队） |
| `RUNNING` / `WAITING_FOR_USER` | `task pause` 然后 `task resume` | 暂停是协作停止，确认 provider 退出后才进 `PAUSED` |
| `CANCELLED` | — | **终态不会自动重开**：需要重做就新建任务 |

```sh
# 继续一个已暂停的任务
bun run codeestra task resume $PROJECT $TASK <version>

# 重试一个失败的任务（默认沿用上次的 adapter）
bun run codeestra task retry  $PROJECT $TASK <version>

# 先暂停再继续
bun run codeestra task pause  $PROJECT $TASK <version> && bun run codeestra task resume $PROJECT $TASK <version>
```

重试在界面上是任务详情 →「更多操作」→`重试（task retry）`。它显示当前版本（作为 CAS 的
`expected-version`）与将使用的 adapter，并且**区分三种结果**：真的启动了新执行（退出码 0）、
已重新入队但**在等待**（容量/冲突，退出码 3）、或者已重新入队但**启动被拒**（依赖未满足等，带稳定码）。
界面不做本地状态判断：任务不是 `FAILED` 时会如实显示 `TASK_NOT_FAILED`（同理
`TASK_CANCELLED` / `TASK_STILL_RUNNING` / `TASK_PAUSED` / `RECONCILE_REQUIRED` / `TASK_ARCHIVED`）。

**如果还要改任务详情**，用 revision（append-only，不被覆盖），而不是改文字：

```sh
bun run codeestra task revision create $PROJECT $TASK <version> \
  --specification "新的一句话要求" --reason "因为 …"
bun run codeestra task revision list   $PROJECT $TASK
```

修订进入**正在运行的**执行是一个独立过程（Revision Delivery），台账在：

```sh
bun run codeestra task revision delivery list $PROJECT $TASK
bun run codeestra task revision delivery resolve $PROJECT $TASK <delivery-id> <version> \
  --action stop-and-restart --adapter pi
```

**别指望**：对**不支持确认通道**的 Adapter（Pi 当前如此），投递会**如实保持未确认**，
唯一的处置是「协作停止 + 新建 Execution」（`--action stop-and-restart`）。
**旧 revision 的验证不能当作新 revision 的交付证据。**

---

## 7. Agent 停下来问我了

**目标**：回答 Agent 的请求，让它继续。

```sh
# 1) 看有哪些请求
bun run codeestra attention list $PROJECT

# 2) 按 kind + responseType 选一种回答方式
bun run codeestra attention answer $PROJECT <attention-id> confirm yes
bun run codeestra attention answer $PROJECT <attention-id> confirm no
bun run codeestra attention answer $PROJECT <attention-id> value "用现有 helper，不要新增依赖"
bun run codeestra attention answer $PROJECT <attention-id> --choose 1:2 --text 2="保持向后兼容"
bun run codeestra attention answer $PROJECT <attention-id> --cancel

# 3) 确认它被投递了
bun run codeestra attention list $PROJECT
```

- 题号与选项号都是 **1-based**，与界面显示一致；`--choose` 与 `--text` 都可以重复。
- 一道题只能答一次。
- **越界/重复/单选多选不符**会被拒绝为 `INVALID_QUESTIONNAIRE_ANSWER:*`，**请求保持 `OPEN`**，
  你已答的内容不会被吞掉——改对再提交即可。
- 回答提交后由 Runtime 投递给 Agent，**不需要你离开工作台**。

界面上等价的操作是「待处理」标签页里的那张卡（或者任务详情里就地嵌入的同一张卡）。

**只暂停对应的那个 Task**：其他合格任务继续跑。

---

## 8. Agent 在散文里提问（没有 dialog 可以回答）

**目标**：识别这种情况，用**正确**的通道结束等待。

症状：任务停在 `WAITING_FOR_USER`，但**没有任何 Agent 在跑**。

```sh
bun run codeestra task status $PROJECT $TASK     # stderr 会打印 [waiting] … 与 Agent 的问题原文
bun run codeestra attention list $PROJECT        # 找到 prompt.kind = codeestra.prose-question 的那条

# 两个退出方式，必须恰好给一个
bun run codeestra attention resolve $PROJECT <attention-id> --answer "这是我的回答"
bun run codeestra attention resolve $PROJECT <attention-id> --dismiss --note "是误报"
```

**为什么不能直接用 `attention answer`**：provider 进程**已经退出**，没有 dialog 可以写。
用 `attention answer` 去投递它会被以 `PROSE_QUESTION_RESOLUTION_REQUIRED` 拒绝——**这是故意的**，
因为那会声称投递了一个不存在的请求。

**这两条命令都做了什么**：记录一条关于**这一次等待**的陈述。它们**不会**恢复 provider 对话，
也**不是** TaskRevision（不是对规格的修改）。

不想每次都被这样打断：

```sh
bun run codeestra settings prose-question-attention record-only   # 只标注完成，不记等待
bun run codeestra settings prose-question-attention off           # 什么都不记
bun run codeestra settings prose-question-attention auto          # 回到默认
```

改开关零确认，也**不会改写已经记录下来的等待**。

---

## 9. 我想把成果合入 dev

**目标**：让成果进入开发分支。**前提是它已经通过任务验证。**

```sh
# 0) 先确认前置条件都成立
bun run codeestra task status $PROJECT $TASK       # 状态应为 EXECUTED，且有一次 PASSED 的验证
bun run codeestra task verification list $PROJECT $TASK

# 1) 没验证就先验证
bun run codeestra task verify $PROJECT $TASK

# 2) 合入
bun run codeestra task integrate $PROJECT $TASK <version>

# 3) 看结果
bun run codeestra task integration list $PROJECT $TASK
bun run codeestra task status $PROJECT $TASK
```

`task integrate` 内部是三步：在 detached integration worktree 里合并（能 ff 就 ff，否则 `--no-ff`）
→ 跑**独立的集成验证** → 集成验证 `PASSED` 之后才用 CAS 推进 `dev`。

**退出码**：只有 `state === "INTEGRATED"` 才是 `0`；`FAILED`/`CONFLICTED`/`STALE`/`CANCELLED` 等已记录的
非集成终态是 `1`；未收口、需要人先处理的批次（`RECOVERY_REQUIRED`）是 `3`；用法错误是 `2`。
它们都**不推进 `dev`**。

**想做一次合入多个任务**（多成员批次）：

```sh
bun run codeestra task integration create $PROJECT \
  --member $TASK_A:<version-a> --member $TASK_B:<version-b>
bun run codeestra task integration integrate $PROJECT <batch-id>
```

`create` 不碰 Git，只固定成员与 `dev` 基线；`integrate` 按 task-id 顺序逐个合并，然后对最终提交跑**一次**
独立验证，`PASSED` 才推进 `dev` 并把每个成员推到 `SUCCEEDED`。组成后成员或 `dev` 移动 → 批次落 `STALE`，
按当前事实重新 `create` 即可。改主意就 `task integration cancel`（未碰过 Git 的批次直接取消；已合并的会变成
`RECOVERY_REQUIRED` 并继续占用成员）。

常见拒绝与处理：

| 码 | 处理 |
|---|---|
| `TASK_VERIFICATION_NOT_PASSED` | 先让任务验证 `PASSED` |
| `NO_CAPTURED_RESULT` | 还没有成果 commit，先 `task result capture` |
| `DEV_REF_CHECKED_OUT` | `dev` 正被某个工作树检出 → 先把它切走 |
| `INTEGRATION_IN_PROGRESS` | 已有集成在进行，或某个成员被一个未结算的批次占用；先 `integrate`/`cancel` 那个批次 |
| `CONFLICTED`（状态） | 合并冲突，**现场已保留**，由你处理 |

**别指望**：合入 `dev` **不等于**发布到 `main`（见 recipe 10）；
**任务验证 ≠ 集成验证**，两者不能互相替代。

**也可以在界面上做**（「项目」标签页 → `集成批次 · dev`，与上面完全是同一命令面）：批次表与成员表是
只读的（成员按 task-id 排序）；`组批（task integration create）` 用项目里的任务选成员，每个成员旁边显示
要发送的 `expected-version`（CAS）；每个批次的 `集成` 与 `取消` 按钮不按本地状态隐藏——能不能做由 Runtime
判断，被拒时界面逐字显示稳定码。**取消不保证成功**：只有记录能证明无副作用时才会真的 `CANCELLED`，
否则变成 `RECOVERY_REQUIRED`（退出码 3）并继续占用成员。界面不提供删除批次或重试合并。

---

## 10. 我想发布到 main

**目标**：把已批准的开发分支内容推进稳定分支，并让稳定服务真正用上新代码。

**先看你在哪**：本机的 `main` 与 `dev` 是**两个分别 clone 的独立仓库**。
所以提升**必须经 GitHub 中转**，不能是本地的 `git merge`。

### 步骤（四步，全部照 `AGENTS.md` 的人工路径）

```sh
# ① 在 dev clone：push 固定候选到远端 dev，并读回核对
cd ~/Documents/codeestra-dev
git push origin <候选 SHA>:refs/heads/dev
git ls-remote --heads origin            # 核对 origin/dev == 候选 SHA

# ② 在 main clone：fetch 后 ff-only 拉取
cd ~/Documents/codeestra
git fetch origin
git merge --ff-only origin/dev

# ③ 在 main clone：重启稳定 Runtime（并拉起 Web UI）后核对
bun install --frozen-lockfile
bun run build:ui
bun run codeestra stop
bun run codeestra status                 # 拉起 Runtime
bun run codeestra ui --no-open           # 再拉起 Web UI 服务器，并打印带 token 的链接
bun run codeestra status                 # 必须看到 status: "READY" 且 uiRunning: true

# ④ 核对通过后，才把 main 推回远端
git push origin main
```

**为什么第 ③ 步要多一条 `codeestra ui --no-open`**：`stop` / `status` 不会把 Web UI 服务器带回来
（ADR-0007：UI 是按需客户端），实测重启后 `uiRunning` 为 `false`；而恢复判据要求 `uiRunning: true`，
不显式拉起就永远无法通过。

第 ②–④ 步的等价入口是 `just promote-main <候选SHA>`（在 dev clone 里跑，候选 SHA 必须显式给出）；
只重启、不提升的等价入口是 `just restart-main`。第 ① 步与提升前的全量测试证据仍需人工完成。

### 硬性约束（不是建议）

- **只 push 固定候选这一个 ref**；不 `--force`、不覆盖远端已有提交、不对已检出的 `main` 用 `update-ref`。
- **断网、SSH 认证失败或远端不可达时不推进任何 ref**；也不得把「本地等价」当作提升成功。
- `git merge --ff-only` 不成立就**停止并报告**，不改用 merge commit、reset 或强推。
- **重启核对通过之前不得报告提升完成**；失败时**不擅自回滚**，保留现场并如实报告。
- 提升前必须在**精确的 dev 候选 SHA** 上跑完全量测试；候选、测试配置或锁文件变化即证据失效。

### 关于产品命令（**重要**）

```sh
bun run codeestra promotion full-suite run $PROJECT --dev-commit <full-sha>   # 先拿到全量证据
bun run codeestra promotion prepare $PROJECT <batch-id> <expected-dev-commit> <expected-main-commit>
bun run codeestra promotion promote $PROJECT <promotion-id>                  # 一次只推进一步
```

`promotion prepare/approve/promote` 已经是**经 GitHub 中转**的路径（ADR-0047 / FOUNDATION-077、ADR-0052）：
`promote` 先把固定候选 push 到远端 `dev` 并 `git ls-remote` 读回核对，此时报
**「已推送、等待拉取」**（`state: PROMOTING`，`phase: AWAITING_PULL`，**退出码 3**）且**不记录任何重启步骤**；
你在 main 检出做完上面第 ② 步（`git fetch origin` + `git merge --ff-only origin/dev`）后**再调用一次**，
它才核对到 main 检出已在候选上、记录并执行重启序列（第 ③ 步的四条命令），最后把候选推回远端 `main`（第 ④ 步）。
**它不替你做第 ② 步**：那一步永远是你在 main 检出里执行的命令。

但**本仓库自身的提升仍一律走上面的四步人工路径**（`AGENTS.md`），不使用 `promotion promote`；
交付说明里要写明实际用了哪条路径、执行到了哪一步。

**界面上的投影**：「稳定提升记录 · dev → main」是**只读**的——它不 push、不拉取、不重启，
不发任何命令。它显示派生的 `phase`、读回的 `origin/dev` / `origin/main` SHA，并在
「已推送、等待拉取」阶段直接给出你需要在 main 检出执行的两条命令，
同时明写「**main 已移动不等于 Runtime 已完成重启**」、「已推送 ≠ 已提升」。

---

## 11. 我想保住失败现场，不清理

**目标**：出事了先别丢证据。

**默认行为就是对的选择**：`reclaim` **默认保留失败现场**——未提交改动、失败/取消的验证或集成
在没有 `--include-failure-scenes` 时都是 `RETAIN`。所以**什么都不要做**就是保住现场。

要确认它确实被保住：

```sh
bun run codeestra reclaim plan --project $PROJECT --json      # 只读试运行，看每个资源的动作
bun run codeestra reclaim records --project $PROJECT          # 审计账本
```

看 `plan` 的结果：`RETAIN`（保留）与 `RECLAIM`（回收）分开列，每个都带归属证据。
如果某个失败现场显示为 `RECLAIM`，那说明它不是失败现场（例如它成功了、或没有未提交改动）。

需要主动做的事只有一件——**不要加** `--include-failure-scenes`、**不要**用
`--remove-unregistered` 指名删除任何目录。

**配合的其他做法**：

```sh
bun run codeestra events tail                                        # 先把事实流抓下来
bun run codeestra task status $PROJECT $TASK > /tmp/task-status.json # 存一份状态投影
bun run codeestra task operation list $PROJECT $TASK                 # 长命令的步骤与结果
```

**看到 `RECOVERY_REQUIRED` 时**：它是「有事实无法被证明，需要一次带审计的对账」，
**不是**让你重试掩盖它。先看 `task status` 与 `events tail`。

Task/Execution 的 `RECOVERY_REQUIRED` 有**专门的命令**（ADR-0055）：

```sh
bun run codeestra task recover $PROJECT $TASK <expected-version> [--reason "…"]
```

它只读事实（记录的 provider 进程身份按真实进程表核对、记录的后代快照、workspace 是否还在磁盘）：
只有**能证明 provider 已消失**才收口（`Execution`/`Task` → `FAILED`、Session → `EXITED`、workspace → `RETAINED`），
其余（存活 / 后代存活 / 无法核验 / 无身份）一律拒绝并保持占用，退出码 `1`。它不发信号、不杀进程、不删工作树，
也不声称工作树已静止。收口后想继续就 `task retry`，想作废就 `task cancel`。

**如果它报 `RECOVERY_PROVIDER_ALIVE`**：那个进程不归 Codeestra 管（本机无受控句柄），自己去结束它再重跑这条命令。
**如果等待的理由是某个占用者不可观测**：见 [troubleshooting.md](./troubleshooting.md) §1 的「占用者无法被观测」一节。

---

## 12. 我想回收磁盘

**目标**：把 Runtime 数据目录下不再需要的资源清掉，**并且知道每一样为什么被清或被留**。

> 从 ADR-0062 起，**集成成功后会自动回收**该批成员里「clean + 已合并」的 Task worktree（默认开启）。
> 这一步不再需要你记得跑；要关掉用 `settings auto-reclaim off`。下面仍然是那个**带审计的手动路径**，
> 失败现场、未合并成果与任何手动选定都靠它。

```sh
# 1) 先看（plan 是只读试运行，返回的结构与 apply 完全相同）
bun run codeestra reclaim plan --project $PROJECT --json

# 2) 缩小范围（可选）
bun run codeestra reclaim plan --project $PROJECT --task $TASK
bun run codeestra reclaim plan --project $PROJECT --kind TASK_WORKTREE
bun run codeestra reclaim plan --project $PROJECT --kind VERIFICATION_COPY --kind INTEGRATION_WORKTREE

# 3) 确认无误后执行（同样的参数）
bun run codeestra reclaim apply --project $PROJECT --kind TASK_WORKTREE

# 4) 看审计记录
bun run codeestra reclaim records --project $PROJECT --limit 50
```

- 三类资源：`TASK_WORKTREE`、`VERIFICATION_COPY`、`INTEGRATION_WORKTREE`。
- 每个被考虑的资源都有动作：`RECLAIM / RETAIN / REFUSE / ALREADY_ABSENT / RECOVERY_REQUIRED`，带归属证据。
- **失败现场默认保留**；未注册目录**不会被删**，除非用 `--remove-unregistered <精确路径>` 指名。
- 跨项目批量：不带 `--project`（或加 `--all-projects`）覆盖**所有**已信任项目，结果按项目分组。
- **退出码**：`FAILED` → `1`；可回收数量为 0（plan）或实际回收数量为 0（apply）→ `3`
  （「没什么可回收」不是错误）；否则 `0`。

**回收了还能恢复吗**：被回收的**任务工作树**可以用 `task retry` 从保留的 Task 分支重建
（回收不会删 task branch）。但**这不是「撤销」**：如果重建被拒绝（分支不存在、与基线无关、
已被别处检出、路径被占用），`task retry` 会如实报 `WORKSPACE_RECLAIMED` 或
`WORKSPACE_OWNERSHIP_UNVERIFIABLE`，**不会替你删掉占路的目录**。

**这是唯一具有破坏性的命令面。** 不确定就先只跑 `plan`。

---

## 13. 通用：我从零该怎么开工

第一次用的时候按这个顺序走一遍：

```sh
cd /path/to/codeestra
bun install --frozen-lockfile
bun run build:ui                                   # 需要 Web UI 时
bun run codeestra status                           # 拉起 Runtime，看 READY

bun run codeestra open /path/to/your-repo --dev-repo /path/to/dev-clone --no-open \
  # 接入项目（FULL 零确认）并拿到界面地址；--dev-repo 可选（ADR-0060）：
  # 给了它才有 dev 基线与 dev → main 提升；不给（managed）时 Task 基线取该项目文件夹当前检出的分支，
  # 成果留在 task 分支由你自己合。上面这一行是“我想要 dev → main 提升”时用的写法。
bun run codeestra settings permission get                    # 确认权限模式

bun run codeestra task create $PROJECT "一项具体的改动" \
  --title "一项具体的改动" --name "a-concrete-change"
bun run codeestra task submit $PROJECT $TASK <version>
bun run codeestra task run    $PROJECT $TASK <version>
```

然后：

- 被问了 → recipe 7
- 用散文问了 → recipe 8
- 想改规格 → recipe 6
- 想让**跑着的** Agent 换个做法（不改验收标准）→ recipe 14
- 该提交成果了 → recipe 1 的第 6 步
- 冲突了 → recipe 4
- 出事了 → recipe 11；实在看不懂 → [troubleshooting.md](./troubleshooting.md)

---

## 14. 我想让跑着的 Agent 换个做法（Session Guidance）

**先分清两件事：**改「做到什么程度」= 规格变更 → 走 recipe 6（`task amend` / `task revision create`），它产生 revision
并使旧验证失效；改「怎么做」= 会话指导 → 用 `session guide`，它**不产生 TaskRevision、不动 revision、不使验证失效**。

```sh
# 1. 确认它真的在跑（RUNNING），并拿到当前 version
bun run codeestra task status $PROJECT $TASK

# 2. 给一句话。它交给运行中的 provider 通道（Pi 的 RPC steer）
bun run codeestra session guide $PROJECT $TASK --message "先用仓库的 .codeestra/instructions 里的约定，不要自创风格"
echo $?      # 0 = 已交给运行中的会话或（当时没会话可交付而）已记录；1 = 被问过但没交付；2 = 用法错误

# 3. 看台账：记录本身 + 尝试 + 每个 Execution 启动时带上它的产物
bun run codeestra session guidance list $PROJECT $TASK
bun run codeestra session guidance get  $PROJECT <guidance-id>
```

**做完看什么：**

- `--json` 里的 `guidance.state`：`RECORDED`（已记录，无活会话可交付）/ `DELIVERED`（provider 通道接受了，**即入队**）/
  `CHANNEL_UNSUPPORTED` / `TIMED_OUT` / `FAILED`；`attempts[]` 里有当时的 `capability` 与 `evidenceRef`。
- `modelAcknowledgement` **恒为** `UNSUPPORTED`：没有任何 provider 能证明「模型已读」，所以不要把 `DELIVERED` 读成「它已经照做了」。
- `launchedWith[]`：哪次 Execution 启动时带上了这条 guidance（artifact 在
  `<CODEESTRA_HOME>/guidance/$PROJECT/$TASK/guidance-context.md`，**不在** Task 工作树里）。
- 想确认它真的交给了 provider：`session guidance list` 的 `launchedWith[]` 会在下一次 Execution 启动后多一行；
  也可以在任务的 argv 里看到 `--append-system-prompt <那个 artifact 路径>`（Pi）。

**别做的事：**

- 想改验收标准却发 guidance：它不会改任何验收标准，也不会使旧验证失效——请用 recipe 6。
- 在 Codex / Claude Code 上指望它指导**正在运行**的一轮：两个 Adapter 都没有已验证的活会话通道
  （Codex `REQUIRES_VALIDATION`、Claude `UNSUPPORTED`），你会得到退出码 `1` 与 `CHANNEL_UNSUPPORTED`；
  消息仍然被耐久记录，并在下一次 Execution 启动时交给 provider。

---

## 15. 机器快扛不住了，或者我要它先别动

想**同时减少并发的任务数**时，改容量上限；想让**正在跑的 Agent 先别再发模型请求**时，用全局暂停。
两者都不需要重启 Runtime，也不需要任何确认。

```sh
# 1）先看现在到底什么状态（只读，安全）
bun run codeestra scheduler control status --json

# 2）暂停全部：先立屏障，再逐个核验并冻结 Provider 主进程
bun run codeestra scheduler control pause --json      # exit 0 = 已收口成 PAUSED；exit 1 = 有目标没核验成

# 3）（可选）只看事实、不发任何信号
bun run codeestra scheduler control reconcile --json

# 4）继续：只唤醒身份完全一致的那些主进程
bun run codeestra scheduler control resume --json
```

- **退 `1` 时不要当成「已经暂停了」**：看 `status` 的 `targets[]`，每个目标都有自己的 `state`、身份核验结论与
  进程状态。`RECOVERY_REQUIRED` 时屏障**保持**，这是设计（宁可保持，也不假装冻住了）。
- **Codex / Claude Code 的会话目前无法被全局冻结**（`providerProcessSuspension: REQUIRES_VALIDATION`）：
  它们会让本次 epoch 进入 `RECOVERY_REQUIRED`。想只停某一个 Task，用 `task pause`（协作停止，ADR-0016）。
- **工具不会被 Codeestra 停掉**：已经跑起来的工具/验证命令不会收到暂停信号（大输出工具可能因管道背压阻塞）；
  **已经发出的模型请求也不会被取消**（可能已在服务端完成并计费）。保证只是「屏障建立并核验冻结后，
  受控 Provider 主进程不会再发出下一次请求」。
- **重启不会自动继续**：`stop` 之后重启，屏障仍在；必须显式 `resume`。
- 暂停期间仍然可以：只读查询、`task cancel/recover/purge`、`runtime stop`、不调用模型的 Git/验证/集成操作。
  新的 Execution 与 answer/guidance 的实际投递会被延后（正文可以先记下来，恢复后按既有规则投递）。

## 相关阅读

- 从头读到尾的说明书：[manual.md](./manual.md)
- 端到端流程与预期输出：[workflow.md](./workflow.md)
- 逐屏 UI 走查（每个按钮做什么）：[ui.md](./ui.md)
- 每条命令的参数与退出码：[cli/README.md](./cli/README.md)
- 报错怎么办：[troubleshooting.md](./troubleshooting.md)
- 人工观感核对清单：[acceptance-checklist.md](./acceptance-checklist.md)
