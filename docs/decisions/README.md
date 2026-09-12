# 架构决策记录

## 已接受

- [ADR-0001](0001-runtime-safety-baseline.md)：运行修订先暂停、依赖上游进入 main、每批 main 提升用户批准、独立本地 Runtime。
- [ADR-0002](0002-execution-and-promotion-policy.md)：首个 Adapter 为 Pi、保留原生审批、协作取消与不抢占、Stable 切换等待排空。

这八项由用户明确答复。用户给定的硬性原则见 `PROJECT_SPEC.md`，无需重复确认。

## 阶段准入与待决项

| 阶段 | 尚需确认/验证 | 当前处理 |
|---|---|---|
| Phase 0 纯领域工程 | 无影响该小步的未决产品语义 | 可实现 revision、Execution FSM 和测试骨架，不实现副作用 |
| Phase 1 | Pi 真实审批/交互/暂停/恢复能力与接入协议 | 先做文档和真实 spike；不虚构权限审批能力 |
| Phase 1 | Runtime 自动创建成果 commit 的授权、身份、hooks 策略 | 未确认前不自动提交任何用户项目文件 |
| Phase 1 | 本地 IPC、进程托管与首次项目信任入口 | 技术方案需验证；涉及用户权限行为的部分再询问 |
| Phase 2 | 上游被修订时依赖锁定 revision 怎样更新 | 未明确前暂停该边调度并请求澄清，不自行跟随或固定旧需求 |
| Phase 4 | merge 形态、失败批次拆分、main 已 checkout 的安全交接 | 不自动部分提升；不更新用户工作目录；实现前确认 |
| Phase 7 | migration/备份兼容策略、bootstrap 自身更新授权 | 禁止自动实现不可逆升级；实现前确认 |

Phase 0 不要求 Phase 7 所有发布细节已决定；Phase 1 不能以“未来会解决”绕过影响真实执行与 Git 安全的待决项。

## ADR 规则

命名 `NNNN-short-title.md`；包含 Status（Proposed/Accepted/Superseded）、Context、Options、Decision、Consequences、Verification 与关联文档。只有明确决定后才能标 Accepted。提案、技术假设和未验证能力必须分别标明。
