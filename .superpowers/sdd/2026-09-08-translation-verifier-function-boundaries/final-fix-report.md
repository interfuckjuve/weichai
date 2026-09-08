# 最终 P2 修复报告

## 范围与结论

- 基线：`2afe071d505f543a0f86f627e15c74f74ee888c5`；分支保持 `refactor/translation-verifier-clarity`。
- 只修复原最终审查的 P2：策略归一化之后、最终报告首次构造之前的晚到 Host interruption（主机中断）窗口。
- 原始 `final-integration-review.md` 未修改。没有新增依赖、子代理、worktree、分支或付费模型调用。
- 本报告与修复代码一同局部提交；提交 SHA 由交付消息提供。

## 最小实现

1. 从 `workflow/run-strategy.ts` 提取既有中断归一化逻辑为 `normalizeStrategyInterruption`。基线没有该命名 helper（辅助函数）；现在策略检查与最终 Host 检查复用同一实现，不引入通用层。
2. `workflow/run-verification.ts` 保留 combined signal（组合信号），在最后一次 `await withStepContext(...)` 之后、首次 `createVerificationResult` / `createFailureResult` 之前同步重新归一化。
3. 从权威中断检查到最终 materialization/hash（构造与散列）之间不新增 `await`，不构造后重建报告。receipt validation（回执校验）原有重建不变。
4. 输出分支保留可信的 source/target assessments（两侧评估）、issues（问题）、证据引用与 strategyReport（策略报告）。调用方即使使用 `TimeoutError` 也归类为 `cancelled`；仅 Host timeout 将完成输出降为 `partial`。
5. 失败分支更新调用方取消原因，但保留原 `discardArtifacts`。持久化失败仍是 `failed` / `artifact_persistence_failed`、无伪造 canonical artifact（规范制品）、丢弃本次制品；普通错误遇晚到取消则保留已有可用制品并持久化取消报告。
6. 未改 `waitForStrategy` 的 250 ms cooperative finalization（协作式收尾）、迟到拒绝消费、关闭后写入拒绝、清理或持久化重试策略。

## TDD 复现与回归

新增 verifier 服务测试 14 项：microtask（微任务）3/4 分别覆盖四组 source/target `no_bug_observed` / `bug_found` 组合、普通失败、持久化失败与 Host timeout。新增 adaptation 测试 2 项：通过真实 `VerificationService`、自定义无模型 provider（提供器）、真实磁盘持久化和公开回执校验，再调用真实 `verificationResultEvidence`。

- `now()` 只观察取消状态，不触发取消；断言取消已在最终构造前发生。
- spy（调用监视）按 Host 的 `now` 参数计数，断言最终构造一次；区分原有回执校验内部的重建。
- 校验磁盘报告与返回值完全一致、正式 receipt hash（回执散列）绑定成立、证据内容与引用保留、临时 workspace（工作区）清理完成。
- Red（失败阶段）中 microtask 3/4 报告仍为 `completed`、遗漏取消 problem；adaptation 消费合法磁盘回执得到 `pass`，确认原审查复现。
- Green（通过阶段）中同一回执变为 `cancelled`，下游为 `unverified`。不据此声称完整 adaptation 自动回填存在绕过或已验证业务语义。

## 本轮执行结果

所有命令在当前 worktree 执行，使用 Node `spawnSync` 保留子进程退出码并缩减输出；未依据历史日志判定。

| 检查 | 命令 | 本次结果 |
| --- | --- | --- |
| verifier 定向 Red | `npm exec --workspace=@forexplore/translation-verifier -- vitest run src/verification-service.test.ts src/schemas --reporter=dot` | 最终 Red 执行 exit 1；14 失败、148 通过，4 文件。此前初始 10 项新增回归也已失败；补齐 4 项失败制品交互回归后重跑该定向集。 |
| adaptation 定向 Red | `npm exec --workspace=@forexplore/adaptation-service -- vitest run src/adaptation-adapter-v2.test.ts --reporter=dot` | exit 1；2 失败、33 通过，1 文件。 |
| verifier 定向 Green | 同 verifier 定向命令 | exit 0；162 通过，4 文件。 |
| adaptation 定向 Green | 同 adaptation 定向命令 | exit 0；35 通过，1 文件。 |
| verifier build（构建） | `npm run build --workspace=@forexplore/translation-verifier` | exit 0；包括 schema-types freshness（生成类型新鲜度）检查与 TypeScript 编译。 |
| adaptation build | `npm run build --workspace=@forexplore/adaptation-service` | exit 0。 |
| verifier 全套，仅一次 | `npm test --workspace=@forexplore/translation-verifier -- --reporter=dot` | exit 0；27 文件、519 项全部通过，无跳过；包含既有 250 ms、超时、取消优先级、持久化、迟到清理回归。 |
| 差异检查 | `git diff --check` | exit 0。 |

全套 stderr 中的无凭证/非零注入退出码、target-only source execution denied（禁止源执行）、非法命令参数与 baseline mismatch（基线不匹配）来自通过的负向测试，不是构建或测试失败。

## 审查与交接

- 已完整自审本次 4 个代码/测试文件的 diff（差异），检查最终同步边界、schema（模式）约束、调用方优先级、制品丢弃标记和测试对真实 public API（公开接口）的使用；未发现新增可执行问题。
- adaptation 仅新增测试对既有公开 verifier API 的调用；verifier 无反向 production dependency（生产依赖），无共享契约或公开导出变更。
- 本轮编辑工具自动返回全部受影响 TypeScript 文件 clean（无错误）；本子代理没有显式 `lsp_diagnostics` / `lens_diagnostics` 工具，因此不宣称完成主代理的 LSP 或全会话诊断检查。
- 待主代理完成 LSP 与 focused review（定点审查）。未重开整体架构审查，未重复运行 verifier 全套，也未额外运行 adaptation 全套或付费模型 E2E（端到端测试）。

## 文件

- `services/translation-verifier/src/workflow/run-strategy.ts`
- `services/translation-verifier/src/workflow/run-verification.ts`
- `services/translation-verifier/src/verification-service.test.ts`
- `services/adaptation-service/src/adaptation-adapter-v2.test.ts`
- `.superpowers/sdd/2026-09-08-translation-verifier-function-boundaries/final-fix-report.md`
