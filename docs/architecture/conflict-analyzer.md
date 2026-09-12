# 第一版 Conflict Analyzer

## 1. 目标与限制

优先低误判安全率，而不是最大并发。分析是保守预测，不是锁系统、更不是安全沙箱。LLM 可辅助预测影响，但“没有提到同文件”不能作为 SAFE 的唯一依据。

## 2. 输入

每份 ImpactSnapshot：taskId、revisionId、baseCommit、analyzerVersion、policyVersion、complete、files、importantDirectories、modules、globalResources、evidence。

路径相对仓库根，统一分隔符并尊重实际文件系统大小写行为；拒绝 `..`、绝对路径与 symlink 逃逸；rename 同时计入 old/new path。目录比较按路径组件，不能把 `src/map` 误匹配 `src/mapping`。

重要目录/模块来源于明确的项目配置及可解释静态映射；尚无可靠映射则 complete=false。公共 API、依赖锁文件、schema migration、构建/测试基础配置通常属于 globalResources。

## 3. 纯判断规则

```text
if wrong project/base/policy/revision or invalid scope:
  UNKNOWN(reason: stale_or_invalid)
else if overlap(files) or directoryAncestorOverlap(importantDirectories)
     or fileInsideOtherImportantDirectory
     or overlap(modules) or overlap(globalResources):
  CONFLICTING(reason + intersecting scope)
else if either incomplete or unbounded impact or uncertain global effects:
  UNKNOWN(reason: incomplete_impact)
else:
  SAFE_TO_PARALLELIZE(evidence references)
```

全局资源影响不能只与同名 globalResources 对比：某任务修改共享构建/依赖/schema 时，如果另一个任务依赖该资源，即使未计划修改，也必须纳入读写冲突；无法获得可靠读依赖时视作整个项目范围 UNKNOWN/CONFLICTING，不错误返回 SAFE。

文件删除/创建、配置生成、代码生成器输出、测试 fixture 和包公共接口都是影响。运行时共享数据库、端口、开发服务器等非 Git 资源由 resource claims 单独管理；不同文件不能证明这些资源可共享。

## 4. 失效与解释

任务修订、基线变化、模块映射/分析器/策略版本变化、实际 diff 超范围都使旧 assessment 不再适用。保留旧记录做审计，新建新版本。

结果提供稳定 reason codes，例如 SAME_FILE、IMPORTANT_DIRECTORY_OVERLAP、SAME_MODULE、GLOBAL_RESOURCE、INCOMPLETE_IMPACT、STALE_BASE。UI 展示具体冲突范围，不只显示红色状态。

第一版没有“用户强制忽略 UNKNOWN 并发”的隐藏 override；若未来增加需单独授权与风险审计决策。

## 5. 测试

同文件、目录祖先关系、相邻但不重叠目录、rename、大小写不敏感仓库、symlink、公共配置、读写冲突、未知模块、空但完整性不足的文件集合、修订后缓存失效，以及已知完全不相交范围的 SAFE 正例。
