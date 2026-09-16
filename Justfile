set shell := ["bash", "-euo", "pipefail", "-c"]

# 本机双 clone 布局（ADR-0048）。默认值就是本机路径，可用环境变量覆盖，
# 便于用临时路径试跑而不改变默认语义。
main_clone := env_var_or_default("CODEESTRA_MAIN_CLONE", "/Users/loyage/Documents/codeestra")
dev_clone := env_var_or_default("CODEESTRA_DEV_CLONE", "/Users/loyage/Documents/codeestra-dev")
dev_home := env_var_or_default("CODEESTRA_DEV_HOME", "$HOME/.local/state/codeestra-dev")

# 列出可用命令
default:
    @just --list

# 按锁文件安装依赖
install:
    bun install --frozen-lockfile

# TypeScript 类型检查
typecheck:
    bun run typecheck

# 单次运行测试（Vitest domain）
test:
    bun run test

# 聚合快速检查（仍非开发分支默认；开发分支按 ADR-0038 运行选定的窄测试）
check-fast:
    bun run check:fast

# 进程级 e2e 测试（Runtime/CLI 命令面）
test-e2e:
    bun run test:e2e

# 全量检查：仅在 dev 上、dev→main 前对精确候选 SHA 运行
check:
    bun run check

# 检查依赖漏洞（需要网络，与本次代码改动无关，按需运行）
audit:
    bun audit

# dev→main 前的完整本地验证（仅在 dev；依赖漏洞检查见 just audit）
verify:
    bun run check

# ===== 服务重启与稳定提升（本机双 clone；ADR-0047 / ADR-0048）=====
#
# 下面三个 recipe 都用 shebang 让整段跑在同一个 shell 里：just 默认「每行一个 shell」，
# 普通写法里的 cd 不会保留到下一行（`cd X` 后 `pwd` 仍打印 justfile 所在目录）。
#
# 分工是刻意的：restart-* 只让检出里现成的代码生效，不移动任何 ref；
# 唯一会写远端 ref 的动作是 promote-main，且候选 SHA 必须显式给出。

# restart-main 只让 main 检出里现成的代码生效。提升（git fetch / merge --ff-only /
# push origin main）刻意不在这里 —— 把授权推送绑进日常重启，会让随手一条命令就推进
# origin/main；那条路径是 promote-main，且候选 SHA 必须显式给出。
# 重启 main 稳定服务：install → stop → status（不移动任何 ref、不推送）
restart-main:
    #!/usr/bin/env bash
    set -euo pipefail
    clone={{main_clone}}
    cd "$clone"

    branch="$(git rev-parse --abbrev-ref HEAD)"
    printf '== main clone：%s（%s %s）\n' "$PWD" "$branch" "$(git rev-parse --short HEAD)"
    if [ "$branch" != "main" ]; then
        printf 'restart-main：main clone 当前分支是 %s，不是 main，停止\n' "$branch" >&2
        exit 1
    fi

    bun install --frozen-lockfile
    bun run codeestra stop
    bun run codeestra status >/dev/null   # 按固定序列拉起 Runtime；输出略，末尾统一核对
    status_out="$(bun run codeestra status)"
    printf '%s\n' "$status_out"

    # 只有 Runtime 自己报告 READY，才算稳定服务已恢复。
    printf '%s\n' "$status_out" | grep -q '"status": "READY"' || {
        printf 'restart-main：status 不是 READY，稳定服务未确认恢复\n' >&2
        exit 1
    }
    printf 'restart-main：main 稳定服务已恢复 READY\n'

# dev 实例与稳定实例的区别只有 CODEESTRA_HOME 与所在 clone（ADR-0064 删除了 ADR-0049 的 dev 通道标记）。
# 重启 dev 服务：install → stop → status
restart-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    clone={{dev_clone}}
    home={{dev_home}}
    cd "$clone"

    printf '== dev clone：%s（%s %s）\n' "$PWD" "$(git rev-parse --abbrev-ref HEAD)" "$(git rev-parse --short HEAD)"
    printf '== CODEESTRA_HOME=%s\n' "$home"

    bun install --frozen-lockfile

    CODEESTRA_HOME="$home" bun run codeestra stop
    CODEESTRA_HOME="$home" bun run codeestra status >/dev/null   # 拉起 Runtime；输出略
    status_out="$(CODEESTRA_HOME="$home" bun run codeestra status)"
    printf '%s\n' "$status_out"
    printf '%s\n' "$status_out" | grep -q '"status": "READY"' || {
        printf 'restart-dev：status 不是 READY，dev 服务未确认恢复\n' >&2
        exit 1
    }
    printf 'restart-dev：dev 服务已恢复 READY\n'

# 这是唯一会写远端 ref 的动作：只 push 这一个固定候选，不 --force、不覆盖远端已有提交、
# 不对已检出的 main 用 update-ref。任一步失败即停止，不推进任何 ref 并保留现场。
# 前置（本 recipe 不代跑）：该候选上已有一份提升前全量测试证据（ADR-0038），且操作者已把
# 固定候选 push 到 origin/dev。刻意不调用产品 `codeestra promotion`：AGENTS.md 规定本仓库
# 自身的提升不得使用它。
# 提升 dev → main（ADR-0047 人工四步；候选 SHA 必须显式给出）
promote-main SHA:
    #!/usr/bin/env bash
    set -euo pipefail
    raw={{SHA}}
    clone={{main_clone}}
    cd "$clone"

    # 0) 前置：位置、分支与工作区必须干净，避免把未提交改动带进提升
    branch="$(git rev-parse --abbrev-ref HEAD)"
    if [ "$branch" != "main" ]; then
        printf 'promote-main：main clone 当前分支是 %s，不是 main，停止\n' "$branch" >&2
        exit 1
    fi
    if [ -n "$(git status --porcelain)" ]; then
        printf 'promote-main：main 检出有未提交改动，停止（不清理、不覆盖）\n' >&2
        exit 1
    fi

    # 只接受十六进制 SHA 文本，不接受任意 ref 名，避免把「提升」变成一次模糊的 ref 猜测
    case "$raw" in
        *[!0-9a-fA-F]*|'')
            printf 'promote-main：候选 SHA 只能是非空十六进制字符串，收到 %s\n' "$raw" >&2
            exit 1
            ;;
    esac

    # 1) 读回远端 dev，核对候选就是远端 dev 现在指向的提交（exit 0 的 push 不算证据）
    git fetch origin
    sha="$(git rev-parse --verify "${raw}^{commit}")"
    origin_dev="$(git rev-parse origin/dev)"
    printf 'origin/dev = %s\n候选 SHA   = %s\n' "$origin_dev" "$sha"
    if [ "$origin_dev" != "$sha" ]; then
        printf 'promote-main：候选不是当前 origin/dev，停止（不推进任何 ref）\n' >&2
        exit 1
    fi

    # 2) 只允许 fast-forward；不成立就停，不改用 merge commit、reset 或强推
    git merge --ff-only "$sha"
    main_now="$(git rev-parse HEAD)"
    printf 'main HEAD  = %s\n' "$main_now"

    # 3) 在 main 检出按固定序列重启并核对
    bun install --frozen-lockfile
    bun run codeestra stop
    bun run codeestra status >/dev/null   # 按固定序列拉起 Runtime；输出略
    status_out="$(bun run codeestra status)"
    printf '%s\n' "$status_out"
    printf '%s\n' "$status_out" | grep -q '"status": "READY"' || {
        printf 'promote-main：status 不是 READY，不推回 origin/main，保留现场\n' >&2
        exit 1
    }
    # 4) 只有上面全部通过才推回 origin/main，并读回核对（推回也必须是 fast-forward）
    git push origin main
    git fetch origin
    if [ "$(git rev-parse origin/main)" != "$main_now" ]; then
        printf 'promote-main：推回后 origin/main 与本地 main 不一致，如实报告并停止\n' >&2
        exit 1
    fi
    printf 'promote-main：origin/main 已推进到 %s（四步全部核对通过）\n' "$main_now"
