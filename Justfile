set shell := ["bash", "-euo", "pipefail", "-c"]

# 列出可用命令
default:
    @just --list

# 按锁文件安装依赖
install:
    bun install --frozen-lockfile

# TypeScript 类型检查
typecheck:
    bun run typecheck

# 单次运行测试
test:
    bun run test

# 类型检查与测试
check:
    bun run check

# 检查依赖漏洞
audit:
    bun audit

# 执行完整的本地验证
verify:
    bun run check
    bun audit
