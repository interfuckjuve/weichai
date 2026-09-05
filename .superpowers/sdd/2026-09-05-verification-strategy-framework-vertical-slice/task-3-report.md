# Task 3 Report: Workspace and Unified Verification Service

## 实现范围

- 新增 `services/translation-verifier/src/verification-workspace.ts`
  - 创建 caller-owned `VerificationStrategyContext`。
  - 使用 `mkdtempSync` 创建临时 workspace。
  - 将 `sourceBundle.files` staging 到 `<workspace>/source/project`。
  - 将 `targetContext.sourceFiles` staging 到 `<workspace>/target/project`。
  - 将 `strategyRoot` 与 `evidenceRoot` 都映射到 `<workspace>/agent`。
  - 创建 `<workspace>/source/.forexplore-tests` 和 `<workspace>/target/.forexplore-tests`。
  - 对 modified patch 校验 staged target 文件 SHA-256 后用 `applyHunksStrict` 应用。
  - 对 created patch 用 `newFileContent`，并要求目标文件不存在。
  - `writeArtifact` 从 evidence root 读取相对路径 artifact，写入 artifactRoot 下同名相对路径，重新计算 SHA-256，通过临时文件加 `renameSync` 完成原子替换。
  - `cleanup()` 默认删除 workspace；`keepWorkspace` 时保留并暴露 `keptDir`。

- 新增 `services/translation-verifier/src/verification-service.ts`
  - 新增 `VerificationService.verify(input, options, signal)`。
  - 在创建 workspace 前先执行 input 校验与 strategy 解析。
  - 使用 Task 2 `VerificationStrategyFactory` 选择默认或显式 strategy。
  - 使用 Node 24 `AbortSignal.timeout` 与 `AbortSignal.any` 组合 timeout/caller signal。
  - 将 `deadlineAt` 写入 strategy context。
  - 用 `assertVerificationResult` 校验 strategy 返回结果身份与 contentHash envelope。
  - 普通 strategy exception、workspace/patch staging failure、result identity mismatch、TimeoutError 均 materialize 为 `unverified`，并附带 `framework-error` issue。
  - caller-originated `AbortError` 原样 rethrow。
  - `finally` 中执行 cleanup，除非调用方请求 `keepWorkspace`。

- 新增测试
  - `verification-workspace.test.ts`
  - `verification-service.test.ts`

- 额外最小类型修正
  - `verification-types.ts`: 为 `requireVerificationArray` 增加 overload，保留调用处元素类型；runtime 行为仍是 array 校验和 shallow clone。
  - `verification-types.test.ts`: 将 created patch 的 `expectedAbsent` 收窄为 literal `true`，满足 `CreatedFilePatch` 类型。

## TDD 记录

1. 先写 `verification-workspace.test.ts`，运行失败，失败原因为缺少 `./verification-workspace.js`。
2. 先写 `verification-service.test.ts`，运行失败，失败原因为缺少 `./verification-service.js`。
3. 实现 workspace 最小逻辑后，focused tests 通过。
4. 实现 service 最小 orchestration 后，focused tests 通过。
5. build 暴露既有 Task 1 类型收窄问题，做最小类型修正后 build 通过。

## 验证结果

- `npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run test --workspace @forexplore/translation-verifier -- src/verification-workspace.test.ts src/verification-service.test.ts`
  - 17 test files passed
  - 153 tests passed

- `npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run test --workspace @forexplore/translation-verifier`
  - 17 test files passed
  - 153 tests passed

- `npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run build --workspace @forexplore/translation-verifier`
  - passed

- `git -C /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework diff --check`
  - passed, no output

## 自审

- 未修改 differential strategy、CLI、adaptation service、package root exports。
- generic `VerificationStrategyContext` 未加入 command runner。
- 未加入 smoke-specific command、evidence schema 或 baseline 分支。
- artifact 路径拒绝 absolute、Windows drive-like、反斜杠、traversal 和非 normalized 相对路径。
- strategyRoot/evidenceRoot 兼容映射到同一个 `<workspace>/agent` physical directory。
- timeout 使用 Node 24 原生 `AbortSignal.timeout`/`AbortSignal.any`。

## Concerns

- package tests 仍会打印既有 `verifier-command` stderr 诊断，包括 intentionally invalid side/phase、ENOENT 和 baseline mismatch；测试结果是 pass，本任务未修改这些既有测试输出。
- 本任务没有导出新 service/workspace 到 package root，符合 brief 的 “do not modify package root exports”；后续 Task 需要公开入口时应在对应任务处理。

## Fix Round 1 - Review Findings

### 修复内容

1. `verification-workspace.ts`
   - `writeArtifact` destination 不再只做 lexical containment。
   - 对 artifactRoot 下的 path components 使用 `lstatSync`，拒绝 symlink path component，包括 dangling symlink。
   - 写入前、写入临时文件后、rename 前使用 `realpathSync` 验证 physical path 仍在 artifactRoot realpath 下。
   - artifact source 也通过 `lstatSync` 拒绝 symlink path component，避免 evidence symlink 读出 workspace 外内容。

2. `verification-service.ts`
   - strategy result 通过 `assertVerificationResult` 后，继续要求 `result.artifacts` 与当前 workspace 的 `writtenArtifacts()` 按 id、kind、path、contentHash、mediaType 完全一致。
   - missing、extra、altered metadata 都归一化为 `unverified` framework error。
   - `throw new Error("")` 与 `throw ""` 归一化为非空 `Unknown verification error`。
   - `TimeoutError` 归一化为稳定非空 `Verification strategy timed out`。
   - pre-aborted caller signal 在 try 内、workspace 创建前处理；AbortError rethrow，非 AbortError materialize 为 `unverified`，且不创建 workspace、不执行 strategy。

3. Regression tests
   - `verification-workspace.test.ts`: symlinked artifact parent、dangling symlink artifact parent。
   - `verification-service.test.ts`: empty error fallback、pre-aborted non-AbortError、artifact result/persistence mismatch、timeout identity/summary。

### RED 验证输出

Command:

```bash
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run test --workspace @forexplore/translation-verifier -- src/verification-workspace.test.ts
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run test --workspace @forexplore/translation-verifier -- src/verification-service.test.ts
```

Observed output summary before fixes:

```text
Test Files  2 failed | 15 passed (17)
Tests       5 failed | 152 passed (157)

Failed tests:
- rejects symlinked and dangling artifact path components
  AssertionError: expected [Function] to throw an error
- normalizes empty strategy errors to a nonempty framework issue
  Error: Verification issue message must be a nonempty string.
- normalizes a pre-aborted non-AbortError without executing the strategy
  Error: caller stopped
- turns result identity mismatches and timeouts into unverified framework errors
  Expected: Verification framework could not complete: Verification strategy timed out
  Received: Verification framework could not complete: The operation was aborted due to timeout
- requires result artifacts to match artifacts written through the workspace
  Expected: unverified
  Received: pass
```

### GREEN 验证输出

Command:

```bash
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run test --workspace @forexplore/translation-verifier -- src/verification-workspace.test.ts
```

Output:

```text
Test Files  17 passed (17)
Tests       157 passed (157)
```

Command:

```bash
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run test --workspace @forexplore/translation-verifier -- src/verification-service.test.ts
```

Output:

```text
Test Files  17 passed (17)
Tests       157 passed (157)
```

Command:

```bash
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run build --workspace @forexplore/translation-verifier
```

Output:

```text
> @forexplore/translation-verifier@0.1.0 build
> tsc -p tsconfig.json
```

Command:

```bash
git -C /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework diff --check
```

Output:

```text
(no output)
```

### 自审

- 未 dispatch subagents。
- 未修改 differential strategy、CLI、adaptation service、package root exports。
- generic context 仍无 command runner。
- 新逻辑没有 smoke-specific command/evidence/schema 分支。
- 当前 artifact write 仍不是跨进程完全 race-free 的 openat/O_NOFOLLOW transaction；Node portable fs API 下已加入本任务要求的 lstat/realpath containment 与 symlink/dangling symlink 拒绝。
- package/focused test 命令仍因 package script 形态运行 `vitest run src ...`，所以输出显示 17 files；这是现有 script 行为。

## Whole-slice timeout fix

### RED

Command:

```bash
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework test --workspace @forexplore/translation-verifier -- src/verification-service.test.ts src/verification-workspace.test.ts
```

Observed output summary before fixes:

```text
Test Files  2 failed | 17 passed (19)
Tests       3 failed | 181 passed (184)

Failed tests:
- returns promptly on a non-cooperative strategy timeout and cleans the workspace
  Error: Test timed out in 5000ms.
- rejects late artifact writes after a timed-out strategy returns to the caller
  Error: Test timed out in 5000ms.
- rejects artifact writes after cleanup even when the workspace is kept
  AssertionError: promise resolved instead of rejecting
```

### GREEN

Focused command:

```bash
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework exec --workspace @forexplore/translation-verifier -- vitest run src/verification-service.test.ts src/verification-workspace.test.ts
```

Output:

```text
Test Files  2 passed (2)
Tests       15 passed (15)
```

Full package command:

```bash
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework test --workspace @forexplore/translation-verifier
```

Output:

```text
Test Files  19 passed (19)
Tests       184 passed (184)
```

Build command:

```bash
npm --prefix /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework run build --workspace @forexplore/translation-verifier
```

Output:

```text
> @forexplore/translation-verifier@0.1.0 build
> tsc -p tsconfig.json
```

Diff check:

```bash
git -C /Users/zen/Studio/projects/client/weichai/.worktrees/verification-strategy-framework diff --check
```

Output:

```text
(no output)
```

### 修复内容

- `VerificationService` 继续使用 Node 24 `AbortSignal.timeout` / `AbortSignal.any`，但不再直接 await strategy；改为 service-owned race，deadline 到期时 materialize `unverified` result，并在 settle 后移除 abort listener。
- caller signal 产生的原始 `AbortError` 对象仍原样 rethrow；pre-aborted 非 AbortError 仍 materialize 为 `unverified` 且不创建 workspace。
- timeout issue 归一化为稳定 `strategy-timeout` id/kind/message 和 `TimeoutError` report detail。
- `VerificationWorkspace` 在 `cleanup()` 后关闭 `writeArtifact`，即使 `keepWorkspace` 保留诊断目录，late writer 也不能持久化 artifact。

### 自审

- 未 dispatch subagents。
- 未处理 durable per-round namespacing、JSON/input validation、issue-kind taxonomy、adaptation-service 或 repair。
- 改动仅限 `services/translation-verifier` 的 service/workspace 及测试。
- 现有 package tests 仍打印既有 `verifier-command` stderr 诊断；结果为 pass，本轮未修改这些既有测试输出。
