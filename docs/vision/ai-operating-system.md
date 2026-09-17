# Codeestra 愿景：AI 的操作系统

状态：产品愿景与设计直觉；规范性边界以 `PROJECT_SPEC.md` 与 ADR-0068 为准。本文不声明任何命令已经实现。

## 1. “AI 的操作系统”是什么意思

Codeestra 不是“AI 时代的 Windows/Linux”，也不尝试接管宿主电脑。它的目标是在 AI 软件领域承担操作系统在程序世界里的基础角色：

- 把一次次孤立的模型调用变成可持续运行、可调度、可恢复的工作系统；
- 把用户从输入/输出搬运工变成目标与优先级的管理者；
- 把长期稳定服务与短期、不稳定、会阻塞的 Agent 执行隔离；
- 统一意图、状态、进程、信号、Attention、工程资源与结果交付；
- 即使某个 Agent 正在等待网络、工具或用户，系统其它部分仍然流畅响应。

长期判断不以今天的 API 单价、延迟与模型能力为常数。默认假设模型会趋向免费、极速，并具备一个聪明应届工程师的通用能力；产品应围绕那时用户真正需要的工作方式设计。

## 2. 从打孔纸带到 AI Service Kernel

### 2.1 打孔纸带：Chat 时代

程序与运行分离：准备输入，送去运行，取回输出，发现问题，再人工搬回去修改。Chat 编程也类似：用户在编辑器、终端与对话之间来回复制，自己维护状态与上下文。

主要成本不是单次推理，而是人的上下文切换和搬运。

### 2.2 键盘、显示器与内存：Agent 时代

程序、输入和输出进入一个可交互循环。Agent 能自己调用工具、观察结果、修改代码并继续工作，用户不再亲手搬运每一步。

但今天的 Agent 常像早期裸机：一次长时间运行占据用户注意力；结果出来之前，用户不知道该继续做什么，也难以同时管理多个目标。

### 2.3 分时操作系统：Codeestra 当前最关键的跃迁

分时的核心不是“同时跑得更多”，而是：

- 多个目标都有独立状态和上下文；
- 等待模型、网络、工具或用户的 Process 不应阻塞其它 Process；
- 输入、状态刷新、Attention 等直接影响体验的路径优先保持响应；
- Scheduler 在有限资源下决定谁先运行，用户不必守着一个 Agent；
- 长期 Service 持续可用，短期 Process 完成目标后结束。

对应到 Codeestra：

```text
Service  = 长期、稳定、持久状态、随时接收 Signal
Process  = 短期、目标有界、允许阻塞、监督一个 Agent
Agent    = Process 中执行复杂认知工作的智能体
Signal   = 用户/程序/Agent 在 Service 间传递的可靠输入
Task     = 用户可见且由 Scheduler 调度的一类 Service
Attention = 系统需要用户输入时的统一待办
```

这解释了为什么“一个 Agent 等用户”不能让整个 Runtime 停住，也解释了为什么 Service 不能直接绑定一个长期 Agent。

### 2.4 个人电脑操作系统：从专用机到每个人的持续 AI 环境

个人电脑的跃迁不只是算力变小，而是：用户拥有一个长期存在、随时可用、可以安装程序和积累状态的个人计算环境。

Codeestra 对应的长期方向是：

- 每个用户有自己的本地 0 号 Service；
- Project Service 长期保存项目状态、知识、接口与 Task 子树；
- 用户可以随手从 root、project、task 等任何合适层级表达 intention；
- Agent/程序不需要知道底层数据库和进程细节，只调用 Service contract；
- 多种前端可以重连同一内核，但 CLI 始终是完备、可脚本化的权威入口；
- 关闭客户端不等于关闭工作，正如关闭终端窗口不应杀死系统服务。

这不是当前一次改造就全部实现的承诺，而是 Service Kernel、intention 路由、项目知识与 Self Evolution 的共同方向。

## 3. 操作系统真正改善了什么

### 3.1 操作随手度与思维流畅度

用户应该能在想法出现时立刻表达，不先判断“该开哪个 Agent、在哪个 worktree、要不要等上一个结束”。系统负责路由、排队、隔离和恢复。

### 3.2 长期服务与消息协作

把系统拆成多个长期 Service 后，状态、权限、知识与 API 有稳定归属；复杂工作由短期 Process 完成。Service 之间通过持久 Signal 协作，比让一个超长 Agent conversation 承担所有职责更可靠。

### 3.3 调度与资源利用率

模型请求、网络、Git、测试、用户决策的资源特征不同。等待 I/O 的 Process 不占用全部执行机会；Scheduler 保障 root/Attention/状态查询持续响应，并按 Task priority 与全局容量启动工作。

### 3.4 代价：切换与内核复杂度

Service/Process 切换会带来状态保存、上下文物化、Signal 投递与恢复成本。即使未来 token 便宜，这些成本也不会完全消失。因此：

- 不为极小工作无意义拆 Task；
- Service context 只交付最小必要信息；
- Signal 使用结构化 payload 与 correlation，不反复让模型重新理解全部历史；
- 只有 Agent 工作才建立 Process，普通程序保持 Service API + Operation。

原则仍是：保证用户流畅体验的价值，通常高于节省少量 token。

## 4. 程序与 Agent 如何统一，又在哪里保持不同

强行把所有东西叫“Agent”或“Process”会损失确定性。Codeestra 统一的是**访问系统的接口**，不是执行机制。

### 4.1 纯函数程序

输入决定输出，不修改状态。例如解析策略、计算冲突结论、格式化投影。

- 作为 domain/service handler 内的纯函数；
- 由 `SIG_A` 调用；
- 不创建 Process；
- 可重复执行并做属性测试。

### 4.2 有状态的确定性程序

读取/修改 Service state，或执行 Git、验证、回收等明确副作用。

- 通过类型化 Service command；
- 状态写入用事务/CAS；
- 外部副作用用 Operation + ownership/ref/process identity 核对；
- 长时间运行可以后台 Operation 化，但仍不是 Process。

### 4.3 Agent 工作

目标明确，但路径需要理解、规划、工具使用与判断。

- Service 收到 `SIG_P` 后创建 Process；
- Process 固定任务书、上下文、Agent 配置与预算；
- Agent 只能通过 Service 提供的 API 影响系统；
- 遇到问题建立 Attention，完成后向 parent Service 发 Signal；
- Process 结束，Service 继续存在。

因此二者的统一点是 `Service contract + Signal + audit`；区别是确定性程序不需要 Agent supervisor，而 Agent 必须被 Process 监督。

## 5. 为什么 Service 与 OS service 不完全相同

相似处：

- 长期存在、可寻址、有父子管理关系；
- 等待输入，按接口执行工作；
- 根 Service 管理系统级服务与项目服务；
- 故障后按持久状态恢复。

不同处：

- Codeestra Service 由 Runtime 管理，不是宿主 OS 进程；
- Service 与 Process 是不同领域概念，不是“服务也是一个进程”；
- Service 可处理明确 API，也可创建 Process 让 Agent 解释复杂 prompt；
- Service 主要服务 Agent 和用户意图，为它们准备状态、知识、接口与工程资源。

## 6. 目标体验

用户通常只做三件事：

1. 表达 intention；
2. 调整优先级或回答 Attention；
3. 查看过程、结果与异常。

理论上，用户可以通过 CLI 介入任意 Service / Process / Signal；日常路径则应尽量只需要自然语言 intention 和少量明确选择。

目标输出不是一条聊天回复，而是持续更新的系统事实：

- 哪些 Task 在排队、运行、等待用户、验证、等待集成或已合并；
- 每个 Process 的 Agent 状态、成本、最近进度与阻塞原因；
- 哪些 Attention 真的需要用户处理；
- 哪个 commit/verification/integration ref 构成交付证据；
- Runtime 崩溃后哪些工作已经恢复、哪些必须人工处置。

## 7. 当前实现与下一步

当前 schema v36 已有独立 Runtime、Task/Execution/Session、Scheduler、Attention、Operation、outbox、Agent adapters、worktree 与 verification，但还不是上述完整内核。

下一步按 `docs/roadmap/mvp.md` 的 S0–S10 增量演进。任何文档或界面必须区分“愿景/目标设计”与“当前可用能力”。
