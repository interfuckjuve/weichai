# Task 3 Report: Adaptation-Service Verifier Adapter

## 状态

已完成 Task 3 范围内的 adapter、port 返回类型、依赖、导出和测试 fake 同步。

## TDD 证据

### RED

先新增 `services/adaptation-service/src/translation-verifier-v2-adapter.test.ts`，断言：

- provider identity 为 `forexplore.translation-verifier.differential@1.0.0`。
- `request`、`analysisReport`、`migrationPlan`、`translation.generatedContent`、`round`、`files`、`patchHash` 完整映射。
- `AbortSignal` 原样转发。
- `VerificationService.verify()` 第二个参数精确为 `{}`，不跨 adapter 边界传 `strategyId`。

RED 命令：

```bash
cd /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework
npx vitest run services/adaptation-service/src/translation-verifier-v2-adapter.test.ts
```

RED 结果：失败，原因是 `Cannot find module './translation-verifier-v2-adapter'`，符合 adapter 尚未实现的预期失败。

### GREEN

实现后执行：

```bash
cd /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework
npx vitest run services/adaptation-service/src/translation-verifier-v2-adapter.test.ts services/adaptation-service/src/adaptation-adapter-v2.test.ts services/adaptation-service/src/http-server.test.ts
```

结果：3 个 test files 通过，21 个 tests 通过。

执行 build：

```bash
cd /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework
npm run build --workspace @forexplore/adaptation-service
```

结果：通过。

## 实现摘要

- 新增 `TranslationVerifierV2Adapter`，实现 `MigrationBehaviorVerifierV2`。
- adapter 调用 `VerificationService.verify()`，构造 stable `VerificationInput`，并固定 options 为 `{}`。
- `MigrationBehaviorVerifierV2.verify()` 改为返回完整 `VerificationResult`。
- 新增 `MigrationBehaviorVerificationInputV2`，包含 `translation`、`round`、`files`、`patchHash`。
- `AdaptationAdapterV2` 将完整 `VerificationResult` 投影回现有 `ValidationRecord` 字段，不实现 repair decision。
- 同步 `adaptation-adapter-v2.test.ts` 和 `http-server.test.ts` 的 verifier fake，使其返回合法 `VerificationResult` envelope。
- 在 `@forexplore/adaptation-service` 增加 `@forexplore/translation-verifier` workspace dependency，并导出 adapter。

## 自审

- 未实现 repair loop、repair decision、server composition 或 verifier strategy selection。
- adapter provider identity 保持 `forexplore.translation-verifier.differential@1.0.0`。
- adapter service call options 为 `{}`，没有传 `strategyId`。
- 修改范围保持在 Task 3 相关 adapter、port、dependency、export、测试 fake 和 lockfile。

## 剩余关注

- `VerificationResult` 到 `ValidationRecord` 当前只投影 status、summary、第一个 artifact path、第一个 issue kind；完整 repair consumption 留给后续任务使用 stable result。

## Important Finding 修复证据

### RED

新增 `AdaptationAdapterV2` malformed verifier result table test，覆盖：

- stale `subjectHash`。
- wrong `round`。
- invalid `contentHash`。

RED 命令：

```bash
cd /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework
npx vitest run services/adaptation-service/src/adaptation-adapter-v2.test.ts
```

RED 结果：3 个新增 case 失败；behavior `ValidationRecord` 仍为 `pass`，说明旧实现会接受 malformed full result。

### GREEN

修复后在 consumption boundary 重建 exact `VerificationInput`，并调用 `assertVerificationResult`。验证失败只转为当前 patch 的 `unverified` evidence，`failureReason` 固定为 `invalid-verifier-result`；verifier call 本身的异常不在该边界 catch。

最终验证：

```bash
cd /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework
npx vitest run services/adaptation-service/src/translation-verifier-v2-adapter.test.ts services/adaptation-service/src/adaptation-adapter-v2.test.ts services/adaptation-service/src/http-server.test.ts
npm run build --workspace @forexplore/adaptation-service
```

结果：focused tests 为 3 个 test files、24 个 tests 通过；adaptation-service build 通过。

## Fix Round 2 证据

### RED

新增 table-driven cases，生成内部 contentHash 自洽但 controller 期望不匹配的 verifier result：

- wrong `strategyId`。
- wrong `strategyVersion`。

RED 命令：

```bash
cd /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework
npx vitest run services/adaptation-service/src/adaptation-adapter-v2.test.ts
```

RED 结果：2 个新增 case 失败；behavior `ValidationRecord` 仍为 `pass`，说明旧实现从 result 自身派生 descriptor，允许 wrong strategy identity 自证。

### GREEN

修复后 `MigrationBehaviorVerifierV2` 显式暴露 `strategyDescriptor`，`AdaptationAdapterV2` 将该 expected descriptor 传给 `assertVerificationResult`，不再从 `VerificationResult.strategyId/version` 派生。`TranslationVerifierV2Adapter` 暴露 frozen clone 的 `DIFFERENTIAL_SMOKE_STRATEGY` descriptor；测试 fakes 同步声明自己的 expected descriptor。

最终验证：

```bash
cd /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework
npx vitest run services/adaptation-service/src/translation-verifier-v2-adapter.test.ts services/adaptation-service/src/adaptation-adapter-v2.test.ts services/adaptation-service/src/http-server.test.ts
npm run build --workspace @forexplore/adaptation-service
```

结果：focused tests 为 3 个 test files、26 个 tests 通过；adaptation-service build 通过。
