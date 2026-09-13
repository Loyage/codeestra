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

# 单次运行测试（Vitest domain）
test:
    bun run test

# 开发循环快速检查：类型检查、Vitest 与快速 Bun 单测（不含进程级 e2e）
check-fast:
    bun run check:fast

# 进程级 e2e 测试（Runtime/CLI 命令面）
test-e2e:
    bun run test:e2e

# UI 类型检查
ui-typecheck:
    bun run --cwd apps/ui typecheck

# 构建 UI 静态资产（Runtime 从 apps/ui/dist 托管）
ui-build:
    bun run --cwd apps/ui build

# 类型检查、Vitest、全部 Bun 测试与 UI 构建（成果提交/验证用的完整门禁）
check:
    bun run check

# 检查依赖漏洞（需要网络，与本次代码改动无关，按需运行）
audit:
    bun audit

# 执行完整的本地验证（依赖漏洞检查见 just audit）
verify:
    bun run check
