# ADR-0001：运行修订、依赖、集成授权与 Runtime 生命周期

Status：Accepted（用户明确选择 D01=B、D02=A、D03=A、D04=A）

## Context

活动修订、依赖代码可见性、main 更新权限与 Session 生命周期决定状态机、数据库与进程边界。

## Options / Decision

### D01：运行修订

选项：A 继续运行并设交付门禁；B 暂停、确认后恢复；C 每次终止并重启。

选择 B。追加规格/约束时先持久化 revision，使旧验证证据失效，并请求暂停。收到暂停确认后投递/确认新规格，满足恢复条件后继续。无法可靠暂停或确认应用时保留现场并重新执行；不得假装已暂停。修订暂停与 Agent 等待用户是不同原因，不能混为 BLOCKED。

### D02：依赖满足

选项：A 上游集成并进入 main；B 已验证 integration candidate；C Task verification 通过。

选择 A。下游必须从包含所需上游集成结果的 main commit 建立基线。Task verification 成功不足以满足依赖。Phase 4 前上游可产出待集成结果，但依赖下游保持 BLOCKED。

### D03：main 提升

选项：A 每批用户批准；B 项目预授权；C 用户手动更新。

选择 A。用户批准必须绑定固定候选 SHA 与预期 main SHA；main 变化使批准失效。禁止隐式 push、覆盖用户改动或破坏性修复。无法安全提升时停止并报告。

### D04：进程生命周期

选项：A 独立本地 Runtime；B 应用后台主进程；C 随窗口停止。

选择 A。桌面是可重连客户端，关闭窗口不终止任务或 Session。Runtime 独立管理执行资源、持久化与恢复。IPC 仅面向受控本地客户端，不因独立进程而引入分布式基础设施。

## Consequences

- Execution 需要暂停请求、暂停确认、修订投递/确认与恢复记录。
- Phase 2 不提前实现候选基线组合；依赖链端到端演示需要 Phase 4。
- IntegrationBatch 需要明确的审批对象和 SHA guard。
- Phase 1 以独立 Runtime 入口验证生命周期，桌面界面可后置。

## Verification

- Agent 未确认暂停时不能标记 PAUSED；未确认新 revision 时不能按新 revision 交付。
- 仅 Task verification 成功不释放依赖。
- 批准后 main 移动，提升必须拒绝并使批准失效。
- 关闭或重连客户端不能杀死运行任务；Runtime 重启必须核对实际进程身份。
