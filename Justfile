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

# UI 类型检查
ui-typecheck:
    bun run --cwd apps/ui typecheck

# 构建 UI 静态资产（Runtime 从 apps/ui/dist 托管）
ui-build:
    bun run --cwd apps/ui build

# 类型检查、测试与 UI 构建
check:
    bun run check

# 检查依赖漏洞
audit:
    bun audit

# 执行完整的本地验证
verify:
    bun run check
    bun audit
