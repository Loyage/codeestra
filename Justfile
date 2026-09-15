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

# 聚合快速检查（仍非开发分支默认；开发分支按 ADR-0038 运行选定的窄测试）
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

# 全量检查：仅在 dev 上、dev→main 前对精确候选 SHA 运行
check:
    bun run check

# 检查依赖漏洞（需要网络，与本次代码改动无关，按需运行）
audit:
    bun audit

# dev→main 前的完整本地验证（仅在 dev；依赖漏洞检查见 just audit）
verify:
    bun run check
