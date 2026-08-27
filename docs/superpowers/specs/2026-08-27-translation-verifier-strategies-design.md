# translation-verifier 四方向模块化 + 统一策略入口 设计文档

- 日期：2026-08-27
- 分支：feat/translation-verifier-optimize
- 范围：`services/translation-verifier/`（npm workspace `@forexplore/translation-verifier`）

## 1. 背景与目标

当前 `src/` 根目录混放了四个方向的测试模块：

| 方向 | 现状 |
| --- | --- |
| 方向1 smoke（Agent 冒烟测试 + 自修复） | `smoke-*.ts` 散在 `src/` 根 |
| 方向2 distinct（描述引导分支一致性） | `analyzer.ts` / `validator.ts` / `consistency-verifier.ts` 散在 `src/` 根 |
| 方向3 aid（变体差分） | 已独立在 `src/variant/` |
| 方向4 mitgen（片段级测试生成） | 已独立在 `src/mitgen/` |

痛点：代码混在一起不方便维护；调用方（quality 适配器、e2e、上层服务）各自对接不同报告结构。

目标：

1. 四个方向各自归入独立文件夹，公共基础留在 `src/` 根；
2. 新增统一策略入口（`src/strategies/`），通过 `TestStrategy` 枚举 + 工厂函数访问，返回归一化报告；
3. 接口控制生成测试的保留/删除，不同策略产物隔离在不同文件夹；
4. 报告记录单次请求总耗时；
5. claude 子进程沙箱：只读参考目录（索引仓库、翻译仓库）+ 可写测试结果目录。

## 2. 目录结构

```
src/
├── smoke/        ← 方向1：types/proto/tools/prompts/agent/cli 共 6 实现 + 4 test
├── distinct/     ← 方向2：analyzer/validator/consistency-verifier 共 3 实现 + 2 test
├── aid/          ← 方向3：由 variant/ 改名（6 实现 + 6 test，类名不变）
├── mitgen/       ← 方向4：保持现状（6 实现 + 5 test）
├── quality/      ← 阶段2 评估框架（文件不动，适配器 import 路径更新）
├── strategies/   ← ★ 新增：统一入口层（types/runner/factory/claude-sandbox 参数组装）
└── 根保留公共基础：description.ts / test-migrator.ts / verifier.ts / comparator.ts /
    executor.ts / driver/ / repair-loop.ts / claude-client.ts / logger.ts /
    code-utils.ts / llm-json.ts / bug-injection.ts / result-capture.ts / cli.ts / cli-helpers.ts
```

移动方式：`git mv`（保留历史）。

## 3. 统一策略入口（`src/strategies/`）

### 3.1 类型（`strategies/types.ts`）

```ts
export type TestStrategy = "smoke" | "distinct" | "aid" | "mitgen";

export interface TestStrategyJob {
  requirement: string;
  source: { language: VerifierLanguage; files?: SideFile[]; root?: string };
  target: { language: VerifierLanguage; className: string; method: string; isStatic: boolean; root?: string; file?: string };
}

export interface StrategyRunOptions {
  /** 生成测试是否保留；默认 false = 用完删除（现状）。 */
  keepGeneratedTests?: boolean;
  /** 保留目录的放置根；默认 <项目根>/test-results。 */
  workspaceRoot?: string;
  /** claude 子进程沙箱：只读参考目录 + 可写目录。 */
  claudeSandbox?: { readOnlyDirs: string[]; writableDir?: string };
  /** 策略参数透传（smoke maxRounds、aid variantCount 等）。 */
  [key: string]: unknown;
}

export interface TestStrategyReport {
  strategy: TestStrategy;
  status: "pass" | "fail" | "unverified" | "error";
  passRate?: number;                 // smoke/distinct/aid 映射；mitgen 无（生成型）
  summary: string;
  durationMs: number;                // ★ 本次请求总耗时
  generatedTestsKept: boolean;       // ★ 是否保留生成物
  keptDir?: string;                  // ★ 保留时的目录路径
  detail: SmokeReport | ConsistencyResult | AIDVerificationReport | MitGenResult; // 判别联合保真
}

export interface TestStrategyRunner {
  run(job: TestStrategyJob, signal?: AbortSignal): Promise<TestStrategyReport>;
}
```

### 3.2 工厂（`strategies/index.ts`）

```ts
export function createTestStrategy(
  strategy: TestStrategy,
  options: StrategyRunOptions & { executor: DriverExecutor; llm: LlmLike },
): TestStrategyRunner;
```

- 每个策略一个 runner 实现（`smoke-runner.ts` / `distinct-runner.ts` / `aid-runner.ts` / `mitgen-runner.ts`），内部把 `TestStrategyJob` 转换为各方向自己的输入，调用现有底层（`SmokeAgent` / `runConsistencyVerification` / `verifyWithVariants` / `MitGenMigratorAgent`）。
- runner 负责：
  - 计时（`performance.now()`）→ `durationMs`；
  - 归一化 `status` / `passRate` / `summary`；
  - 工作目录创建与清理（见 §4）。
- `LlmLike`：`runClaude(prompt, opts)` 的最小接口（复用 `claude-client.ts` 的 `runClaude`）。

### 3.3 status 映射规则

| 策略 | pass | fail | unverified | error |
| --- | --- | --- | --- | --- |
| smoke | `converged && 无 fail verdict` | `!converged` 或存在 fail | — | 异常 |
| distinct | `report.failedCases === 0 && strictNld 通过` | `failedCases > 0` | — | 异常 |
| aid | `failedCases === 0` | `failedCases > 0` | `cleanTarget.usable === false` | 异常 |
| mitgen | 生成成功 | — | — | 生成失败/无 key |

### 3.4 passRate 映射

- smoke：由 `cases[].mechanical` 计算 `pass / total`；
- distinct：`report.passRate`；
- aid：`passRate`（已有字段）；
- mitgen：无（`undefined`）。

## 4. 保留/删除控制 + 策略独立文件夹

### 4.1 executor 增强（`executor.ts`）

`RealExecutorOptions` 增加：

```ts
/** 指定工作目录（默认 null = mkdtemp 随机目录）；指定后不再自建临时目录。 */
workspaceDir?: string;
/** 结束后不删除工作目录（默认 false = 现状 rmSync）。 */
keepTempDir?: boolean;
```

`RealDriverExecutor` 内部所有 `mkdtempSync` 分支改为：`workspaceDir` 存在则使用之（先 `mkdirSync recursive`），否则维持 mkdtemp；清理时 `keepTempDir` 为 false 才 `rmSync`。

### 4.2 统一入口工作目录管理（`strategies/`）

- 每次 `run(job)` 创建 `workspaceRoot/<strategy>-<YYYYMMDD-HHmmss>-<rand>/`；
- 传入 runner → executor（`workspaceDir`）；
- `keepGeneratedTests === false` → 结束后递归删除；
- `keepGeneratedTests === true` → 保留，路径写入 `report.keptDir`，`generatedTestsKept = true`。
- `workspaceRoot` 默认 `<项目根>/test-results/`（monorepo 根下的新目录，加入 .gitignore）。

## 5. claude 子进程沙箱（`claude-client.ts`）

### 5.1 `ClaudeClientOptions` 增强

```ts
/** 子进程工作目录（默认继承父进程）。 */
cwd?: string;
/** --add-dir 列表：解锁这些目录的读写访问。 */
addDirs?: string[];
/** 只读目录 → --disallowedTools "Edit(//<dir>/**)"：禁止编辑但允许读取。 */
readOnlyDirs?: string[];
/** 权限模式；默认 manual（保持现状），传入 "acceptEdits" 时写操作自动批准。 */
permissionMode?: "manual" | "acceptEdits";
```

### 5.2 `spawnClaudeProcess` 参数组装

```ts
const args = ["-p", prompt, "--output-format", "text"];
if (addDirs.length) args.push("--add-dir", ...addDirs);
if (readOnlyDirs.length) args.push(
  "--disallowedTools",
  ...readOnlyDirs.map((d) => `Edit(//${d}/**)`),
);
if (permissionMode === "acceptEdits") args.push("--permission-mode", "acceptEdits");
const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
```

- 默认（无沙箱配置）行为与现状完全一致：无 `--add-dir`、无 `--disallowedTools`、manual 模式。
- 绝对路径规范化：`readOnlyDirs` 统一 `resolve()` 后拼 `//` 前缀。

### 5.3 统一入口注入

`StrategyRunOptions.claudeSandbox` 缺省时，runner 自动注入：

- `readOnlyDirs` = `job.source.root` + `job.target.root`（索引仓库、翻译仓库）；
- `writableDir` = 本次工作目录；
- 通过 `LlmLike` 的实现（`claudeClient({ cwd: writableDir, addDirs: [...readOnlyDirs, writableDir], readOnlyDirs, permissionMode: "acceptEdits" })`）传给各策略内部。

## 6. index.ts 导出兼容

- 现有导出签名全部不变（只改内部 import 路径）：
  - `smoke-*` → `./smoke/*.js`；
  - `analyzer/validator/consistency-verifier` → `./distinct/*.js`；
  - `export * from "./variant/index.js"` → `./aid/index.js`；
  - mitgen 路径不变；
- 新增导出：`TestStrategy` / `TestStrategyJob` / `TestStrategyReport` / `TestStrategyRunner` / `createTestStrategy`。
- 消费方验证：`services/adaptation-service/src/verification-adapter.ts`（`@forexplore/translation-verifier`）无需改动。

## 7. 需要同步更新的 import 路径

| 文件 | 变更 |
| --- | --- |
| `src/quality/adapters/smoke.ts` | `../../smoke-*.js` → `../../smoke/*.js` |
| `src/quality/adapters/distinct.ts` | `../../analyzer.js` → `../../distinct/analyzer.js` |
| `src/quality/adapters/aid.ts` | `../../variant/*.js` → `../../aid/*.js` |
| `src/quality/types.ts` / `metrics.ts` | `../smoke-*.js` → `../smoke/*.js` |
| `src/index.ts` | 全部改路径（§6） |
| `e2e/run-e2e.ts` / `run-e2e-aid.ts` / `run-smoke-e2e.ts` / `bug-injection.ts` | 对应路径更新 |
| `src/consistency-verifier.ts`（distinct 内） | `./analyzer.js`（同目录不变） |

`variant/` 目录改名 `aid/`：`git mv src/variant src/aid`，内部 `index.ts` 导出不变。

## 8. 测试与验证

1. 单测：`npm run test --workspace @forexplore/translation-verifier` 全绿（既有 ~532 tests 不得破坏）。
2. 新增单测：`strategies/*.test.ts`
   - 工厂按策略分发正确；
   - 每个 runner 的 status/passRate/durationMs/keptDir 归一化（fake LLM + FakeDriverExecutor）；
   - `keepGeneratedTests` true/false 的目录清理行为（用临时 workspaceRoot）；
   - claude 参数组装：`addDirs`/`readOnlyDirs`/`permissionMode` → 正确的 args（fake spawnClaude 捕获）。
3. e2e 回归：三个 e2e 脚本退出码 0（`run-e2e.ts` / `run-e2e-aid.ts` / `run-smoke-e2e.ts`）。
4. 类型检查：`tsc --noEmit`（workspace 内）。

## 9. 风险与开放问题

- **风险**：`git mv` 后 vitest 引用路径、tsconfig 无碍（vitest 按文件 glob，无显式路径白名单）；`dist/` 产物由构建刷新。
- **风险**：`--disallowedTools Edit(//path/**)` 的 glob 语法依赖 Claude Code 版本（2.1.231 实测 `--add-dir` + `acceptEdits` 组合有效；Edit deny 规则为文档确认，实施后用手工冒烟验证一次）。
- **开放**：`permissionMode: "acceptEdits"` 是否会误写参考目录——已由 `readOnlyDirs` 的 Edit deny 规则兜底；实施后 e2e 验证。
- **不做**（YAGNI）：CLI 统一入口（用户选择仅 API 门面）；报告字段穿透到 detail 内部（耗时仅记统一层）；目录级读写分离的原生设置持久化（用 CLI flags 每次注入）。
