# ADR-0005：Task 首入口与 Worktree 位置

Status：Accepted（用户明确选择三项）

## Context

Phase 1 的下一纵向小步需要定义 Task CLI 的项目选择、创建后的初始状态及 owned worktree 的落盘位置。测试确认将 worktree 放在仓库根目录 `.codeestra/worktrees` 会让用户主工作区出现未跟踪改动，与“不修改用户现有工作目录来腾出执行空间”的安全原则冲突。

## Options

1. CLI 项目选择：稳定 Project ID / 仓库路径 / 单项目隐式默认。
2. 新 Task 状态：DRAFT / 直接 READY。
3. Worktree：Runtime 数据目录 / Git common dir / 仓库根目录 `.codeestra/worktrees`。

## Decision

- `task create` 与 `task list` 首版显式使用 `project list` 返回的稳定 Project UUID。
- 新 Task 以 `DRAFT` 创建；创建只记录原始意图、首个不可变 revision 与事实事件，不等于已提交调度。后续显式 submit 才可依据依赖进入 READY。
- owned worktree 放在 Runtime 管理的数据目录：`CODEESTRA_HOME/worktrees/<project-id>/<task-id>`。项目与任务目录只使用经过 UUID 校验的内部 ID。
- worktree 路径不放入仓库根目录，也不放入 Git common dir。Git branch 仍为仓库内的 `refs/heads/task/<task-id>`，并绑定固定 base commit。

## Consequences

CLI 在多项目环境中不会凭当前目录静默选择项目。用户需先查询 Project ID；后续可增加安全的路径解析便利命令，但不能改变权威身份。

DRAFT 与执行之间还需 Task submit command/state transition。Runtime 数据目录成为 worktree 资源归属的一部分，迁移、恢复与清理都必须核对 Project/Task/ownership token；取消或失败不自动删除。

## Verification

- Task create 同事务写入 Intent、Task、首 Revision、IntentRecorded、TaskCreated 与 command receipt；重复 command ID 同 payload 返回原结果，异 payload 拒绝。
- Task list 只接受存在 ACTIVE trust 的 Project ID。
- 临时仓库 prepare 在固定 main/base SHA 创建唯一 branch/worktree；main 工作区保持 clean。
- stale base、既有 branch、外来路径或 symlink escape 在副作用前尽量拒绝；部分失败通过 Operation reconcile，不盲目重试。

## Related

- `PROJECT_SPEC.md`
- `docs/architecture/state-machines.md`
- `docs/architecture/git-workspace-api.md`
- ADR-0004
