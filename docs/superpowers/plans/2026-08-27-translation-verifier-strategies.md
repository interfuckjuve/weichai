# translation-verifier 四方向模块化 + 统一策略入口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 translation-verifier 四个测试方向归入独立文件夹,新增统一策略入口(`createTestStrategy`),支持生成物保留控制、策略目录隔离、单次耗时统计与 claude 子进程沙箱(只读参考目录 + 可写结果目录)。

**Architecture:** 纯重构 + 门面层。四个方向模块(`smoke/`/`distinct/`/`aid/`/`mitgen/`)调用关系不变,只移动文件与修 import;新增 `strategies/` 门面层把 `TestStrategyJob` 转换为各方向输入并归一化报告;executor 与 claude-client 各加最小选项增强。

**Tech Stack:** TypeScript + vitest + node child_process spawn + git mv。

**Spec:** `docs/superpowers/specs/2026-08-27-translation-verifier-strategies-design.md`

## Global Constraints

- 不得破坏现有测试:`npm run test --workspace @forexplore/translation-verifier` 必须全绿(基线约 532 tests)。
- 代码注释/文档用中文;提交信息用英文 conventional commits。
- `index.ts` 现有导出签名全部不变(仅内部路径),`adaptation-service` 等消费方零改动。
- 默认行为不变:无沙箱配置时 claude 子进程参数与现状完全一致;`keepGeneratedTests` 默认 false(现状删除)。
- vitest glob 按文件名发现测试,移动后测试仍会被收集,无需改 vitest 配置。
- 本计划在普通分支 `feat/translation-verifier-optimize` 上执行(非 worktree)。

---

### Task 1: 目录重组 + import 路径修复 + 回归

**Files:**
- Move: `services/translation-verifier/src/smoke-{types,proto,tools,prompts,agent,cli}.ts` → `src/smoke/`(同目录内 4 个 `.test.ts` 随迁)
- Move: `src/{analyzer,validator,consistency-verifier}.ts` → `src/distinct/`(同目录 2 个 `.test.ts` 随迁)
- Move: `src/variant/` → `src/aid/`
- Modify: `src/quality/adapters/{smoke,distinct,aid}.ts`、`src/quality/types.ts`、`src/quality/metrics.ts`、`src/index.ts`、`e2e/run-e2e.ts`、`e2e/run-e2e-aid.ts`、`e2e/run-smoke-e2e.ts`(import 路径)

**Interfaces:**
- Consumes: 无(纯移动)
- Produces: 新目录布局 `src/{smoke,distinct,aid,mitgen,quality,strategies}/`;所有既有导出保持原符号名

- [ ] **Step 1: 记录基线测试结果**

Run: `cd services/translation-verifier && npm run test --workspace @forexplore/translation-verifier 2>&1 | tail -5`
Expected: 全部通过(记录 test 数量,后续对比)

- [ ] **Step 2: git mv 移动文件**

```bash
cd services/translation-verifier/src
mkdir -p smoke distinct aid
git mv smoke-types.ts smoke-types.test.ts smoke-proto.ts smoke-proto.test.ts smoke-tools.ts smoke-tools.test.ts smoke-prompts.ts smoke-prompts.test.ts smoke-agent.ts smoke-agent.test.ts smoke-cli.ts smoke/ 2>/dev/null
# 若单文件 git mv 失败逐个执行,测试文件与实现文件分开移
for f in smoke-types smoke-proto smoke-tools smoke-prompts smoke-agent smoke-cli; do
  git mv "$f.ts" smoke/ 2>/dev/null || true
  git mv "$f.test.ts" smoke/ 2>/dev/null || true
done
git mv analyzer.ts analyzer.test.ts validator.ts validator.test.ts consistency-verifier.ts distinct/
git mv variant aid
```

- [ ] **Step 3: 更新 quality 目录 import 路径**

```bash
cd services/translation-verifier
# adapters/smoke.ts: ../../smoke-*.js → ../../smoke/*.js
sed -i '' 's|from "\.\./\.\./smoke-agent\.js"|from "../../smoke/smoke-agent.js"|; s|from "\.\./\.\./smoke-types\.js"|from "../../smoke/smoke-types.js"|; s|from "\.\./\.\./smoke-tools\.js"|from "../../smoke/smoke-tools.js"|' src/quality/adapters/smoke.ts
# adapters/distinct.ts: ../../analyzer.js → ../../distinct/analyzer.js
sed -i '' 's|from "\.\./\.\./analyzer\.js"|from "../../distinct/analyzer.js"|; s|from "\.\./\.\./consistency-verifier\.js"|from "../../distinct/consistency-verifier.js"|' src/quality/adapters/distinct.ts
# adapters/aid.ts: ../../variant/ → ../../aid/
sed -i '' 's|\.\./\.\./variant/|../../aid/|g' src/quality/adapters/aid.ts
# types.ts / metrics.ts: ../smoke-*.js → ../smoke/*.js
sed -i '' 's|from "\.\./smoke-types\.js"|from "../smoke/smoke-types.js"|' src/quality/types.ts
sed -i '' 's|from "\.\./smoke-tools\.js"|from "../smoke/smoke-tools.js"|' src/quality/metrics.ts
```

- [ ] **Step 4: 更新 index.ts 与 e2e import 路径**

```bash
cd services/translation-verifier
# index.ts
sed -i '' 's|from "\./smoke-agent\.js"|from "./smoke/smoke-agent.js"|; s|from "\./smoke-types\.js"|from "./smoke/smoke-types.js"|; s|from "\./analyzer\.js"|from "./distinct/analyzer.js"|; s|from "\./validator\.js"|from "./distinct/validator.js"|; s|from "\./consistency-verifier\.js"|from "./distinct/consistency-verifier.js"|; s|from "\./variant/index\.js"|from "./aid/index.js"|' src/index.ts
# e2e
sed -i '' 's|\.\./src/analyzer\.js|../src/distinct/analyzer.js|; s|\.\./src/consistency-verifier\.js|../src/distinct/consistency-verifier.js|' e2e/run-e2e.ts
sed -i '' 's|\.\./src/variant/|../src/aid/|g' e2e/run-e2e-aid.ts
sed -i '' 's|\.\./src/smoke-agent\.js|../src/smoke/smoke-agent.js|; s|\.\./src/smoke-types\.js|../src/smoke/smoke-types.js|' e2e/run-smoke-e2e.ts
# 检查是否还有漏网 import(期望无输出)
grep -rn 'from "[^"]*\.\./\(smoke-[a-z]*\|analyzer\|validator\|consistency-verifier\|variant\)' src e2e --include="*.ts" | grep -v node_modules || echo "OK: 无遗漏"
```

- [ ] **Step 5: 类型检查 + 全量测试 + 提交**

```bash
cd services/translation-verifier
npx tsc --noEmit
npm run test --workspace @forexplore/translation-verifier 2>&1 | tail -5
cd /Users/zen/Studio/projects/active/weichai
git add -A services/translation-verifier
git commit -m "refactor(translation-verifier): 四方向模块归入 smoke/distinct/aid 独立目录"
```
Expected: tsc 无错,test 数量与 Step 1 基线一致(全绿)。

---

### Task 2: executor 工作目录与保留控制

**Files:**
- Modify: `services/translation-verifier/src/executor.ts`
- Test: `services/translation-verifier/src/executor.test.ts`(追加)

**Interfaces:**
- Consumes: 现有 `RealDriverExecutor` 内部 mkdtemp 分支
- Produces: `RealExecutorOptions.workspaceDir?: string`、`RealExecutorOptions.keepTempDir?: boolean`;`workspaceDir` 指定时不再自建随机目录,`keepTempDir` false(默认)才 `rmSync`

- [ ] **Step 1: 写失败测试**(追加到 `executor.test.ts`)

```ts
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("workspaceDir 指定时使用该目录且 keepTempDir=false 删除", async () => {
  const base = mkdtempSync(join(tmpdir(), "fx-exec-test-"));
  const executor = new RealDriverExecutor({ workspaceDir: base, keepTempDir: false });
  const side: SideSpec = {
    language: "Java",
    sourceFiles: [{ path: "A.java", content: "public class A { public static int f(int x) { return x + 1; } }" }],
    driverSource: generateDriverSource({ language: "Java", className: "A", method: "f", isStatic: true, entrypoints: [{ id: "c1", params: [{ type: "int", value: 1 }] }] }),
    driverFile: "Driver.java",
  };
  await executor.run(side);
  expect(existsSync(base)).toBe(false); // 默认删除
});

test("keepTempDir=true 保留目录且生成物存在", async () => {
  const base = mkdtempSync(join(tmpdir(), "fx-exec-test-"));
  const executor = new RealDriverExecutor({ workspaceDir: base, keepTempDir: true });
  const side: SideSpec = { /* 同上侧 */ language: "Java", sourceFiles: [{ path: "A.java", content: "public class A { public static int f(int x) { return x + 1; } }" }], driverSource: generateDriverSource({ language: "Java", className: "A", method: "f", isStatic: true, entrypoints: [{ id: "c1", params: [{ type: "int", value: 1 }] }] }), driverFile: "Driver.java" };
  await executor.run(side);
  expect(existsSync(base)).toBe(true);
  expect(existsSync(join(base, "A.java"))).toBe(true);
  // 清理
  rmSync(base, { recursive: true, force: true });
});
```
(先查 `executor.test.ts` 现有 fake/辅助构造 `SideSpec` 的方式,复用其既有写法;若 `generateDriverSource` 已在测试中 import 则直接用)

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/translation-verifier && npx vitest run src/executor.test.ts -t workspaceDir`
Expected: FAIL(`workspaceDir` 属性不存在)

- [ ] **Step 3: 实现 executor 增强**

```ts
// RealExecutorOptions 增加:
export interface RealExecutorOptions {
  // ...现有字段
  /** 指定工作目录(默认 null = mkdtemp 随机目录);指定后复用该目录,不自建随机目录。 */
  workspaceDir?: string;
  /** 结束后不删除工作目录(默认 false = 现状 rmSync 清理)。 */
  keepTempDir?: boolean;
}
```

```ts
// RealDriverExecutor 内新增私有方法,替代 4 处 mkdtempSync + rmSync 模式:
#makeDir(label: string): string {
  if (this.#options.workspaceDir) {
    mkdirSync(this.#options.workspaceDir, { recursive: true });
    return this.#options.workspaceDir;
  }
  return mkdtempSync(join(tmpdir(), label));
}
#cleanupDir(dir: string): void {
  if (!this.#options.keepTempDir) rmSync(dir, { recursive: true, force: true });
}
```
将 4 处 `const dir = mkdtempSync(...)` 改为 `const dir = this.#makeDir("forexplore-verifier-")`(project 分支用 `"forexplore-verifier-project-"`),对应 `rmSync(dir, ...)` 改为 `this.#cleanupDir(dir)`。注意:`#options` 当前类型是 `Required<Omit<RealExecutorOptions, "logger">>`,需在默认值构造中补 `workspaceDir: options.workspaceDir ?? null`、`keepTempDir: options.keepTempDir ?? false`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd services/translation-verifier && npx vitest run src/executor.test.ts`
Expected: PASS(新旧用例全过)

- [ ] **Step 5: 提交**

```bash
cd /Users/zen/Studio/projects/active/weichai
git add services/translation-verifier/src/executor.ts services/translation-verifier/src/executor.test.ts
git commit -m "feat(translation-verifier): executor 支持 workspaceDir 与 keepTempDir"
```

---

### Task 3: claude-client 沙箱参数(cwd/addDirs/readOnlyDirs/permissionMode)

**Files:**
- Modify: `services/translation-verifier/src/claude-client.ts`
- Test: `services/translation-verifier/src/claude-client.test.ts`(追加)

**Interfaces:**
- Consumes: 现有 `ClaudeClientOptions` / `spawnClaudeProcess`
- Produces: `ClaudeClientOptions.cwd?`、`addDirs?: string[]`、`readOnlyDirs?: string[]`、`permissionMode?: "manual" | "acceptEdits"`;`spawnClaudeProcess` 组装对应 CLI 参数;无配置时行为与现状完全一致

- [ ] **Step 1: 写失败测试**(追加到 `claude-client.test.ts`,用 fake spawnClaude 捕获 args)

```ts
test("spawnClaudeProcess 组装沙箱参数", async () => {
  const captured: { args: string[]; opts: { cwd?: string } }[] = [];
  const fakeSpawn = async (args: string[], env: NodeJS.ProcessEnv, _t: number, opts?: { cwd?: string }) => {
    captured.push({ args, opts: opts ?? {} });
    return { stdout: "{}", exitCode: 0 };
  };
  const out = await spawnClaudeProcess(
    ["-p", "hello", "--output-format", "text"],
    { ANTHROPIC_AUTH_TOKEN: "k" } as NodeJS.ProcessEnv,
    1000,
    { cwd: "/tmp/w", addDirs: ["/repoA", "/repoB", "/tmp/w"], readOnlyDirs: ["/repoA", "/repoB"], permissionMode: "acceptEdits", spawn: fakeSpawn },
  );
  const args = captured[0].args;
  expect(args).toContain("--add-dir");
  expect(args).toContain("/repoA");
  expect(args).toContain("Edit(//repoA/**)");
  expect(args).toContain("Edit(//repoB/**)");
  expect(args).toContain("--permission-mode");
  expect(args).toContain("acceptEdits");
  expect(captured[0].opts.cwd).toBe("/tmp/w");
});
```
(若 `claude-client.test.ts` 现有结构不同,沿用其 fake 注入风格;`SpawnClaude` 类型签名需扩展以携带 options —— 见 Step 3)

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/translation-verifier && npx vitest run src/claude-client.test.ts -t 沙箱`
Expected: FAIL

- [ ] **Step 3: 实现 claude-client 增强**

```ts
// SpawnClaude 签名扩展(向后兼容:options 可选):
export type SpawnClaude = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options?: { cwd?: string; spawn?: typeof spawn },
) => Promise<{ stdout: string; exitCode: number }>;

export interface ClaudeClientOptions {
  // ...现有字段
  cwd?: string;
  addDirs?: string[];
  readOnlyDirs?: string[];
  permissionMode?: "manual" | "acceptEdits";
}
```

```ts
// spawnClaudeProcess 内组装 args 与 spawn options:
export async function spawnClaudeProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options: { cwd?: string; spawn?: typeof spawn } = {},
): Promise<{ stdout: string; exitCode: number }> {
  const fullArgs = [...args];
  const addDirs = options.addDirs ?? [];          // 经 runClaude 传入(见下)
  const readOnlyDirs = options.readOnlyDirs ?? [];
  const permissionMode = options.permissionMode;
  if (addDirs.length > 0) fullArgs.push("--add-dir", ...addDirs);
  if (readOnlyDirs.length > 0) {
    fullArgs.push("--disallowedTools", ...readOnlyDirs.map((d) => `Edit(//${resolve(d)}/**)`));
  }
  if (permissionMode === "acceptEdits") fullArgs.push("--permission-mode", "acceptEdits");
  return new Promise((resolve2, reject) => {
    const child = (options.spawn ?? spawn)("claude", fullArgs, { env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    // ...其余逻辑与现状相同
  });
}

// runClaude 透传新选项:
export async function runClaude(prompt: string, options: ClaudeClientOptions = {}): Promise<string> {
  // ...apiKey/model 校验同现状
  const spawnOptions = {
    cwd: options.cwd,
    addDirs: options.addDirs,
    readOnlyDirs: options.readOnlyDirs,
    permissionMode: options.permissionMode,
  };
  const result = await spawnClaude(["-p", prompt, "--output-format", "text"], env, timeoutMs, spawnOptions);
  // ...其余同现状
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd services/translation-verifier && npx vitest run src/claude-client.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/zen/Studio/projects/active/weichai
git add services/translation-verifier/src/claude-client.ts services/translation-verifier/src/claude-client.test.ts
git commit -m "feat(translation-verifier): claude 子进程沙箱参数(add-dir/只读目录/权限模式)"
```

---

### Task 4: strategies 类型 + 工作目录管理

**Files:**
- Create: `services/translation-verifier/src/strategies/types.ts`
- Create: `services/translation-verifier/src/strategies/workspace.ts`
- Create: `services/translation-verifier/src/strategies/types.test.ts`、`workspace.test.ts`

**Interfaces:**
- Consumes: `VerifierLanguage` / `SideFile`(from `../description.js`、`../executor.js`)
- Produces:
  - `TestStrategy = "smoke" | "distinct" | "aid" | "mitgen"`
  - `TestStrategyJob { requirement; source: { language; files?; root? }; target: { language; className; method; isStatic; root?; file? } }`
  - `StrategyRunOptions { keepGeneratedTests?; workspaceRoot?; claudeSandbox?: { readOnlyDirs: string[]; writableDir?: string }; [k: string]: unknown }`
  - `TestStrategyReport { strategy; status: "pass"|"fail"|"unverified"|"error"; passRate?; summary; durationMs; generatedTestsKept; keptDir?; detail: SmokeReport | ConsistencyResult | AIDVerificationReport | MitGenResult }`
  - `TestStrategyRunner { run(job, signal?): Promise<TestStrategyReport> }`
  - `WorkspaceHandle { dir: string; cleanup(): void }`、`createWorkspace(root, strategy): WorkspaceHandle`(目录 `root/<strategy>-<YYYYMMDD-HHmmss>-<rand>`,keep=false 时 cleanup 递归删除)

- [ ] **Step 1: 写失败测试**

`strategies/workspace.test.ts`:

```ts
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace } from "./workspace.js";

test("createWorkspace 按策略前缀建目录,cleanup 删除", () => {
  const base = mkdtempSync(join(tmpdir(), "fx-ws-"));
  const ws = createWorkspace(base, "aid");
  expect(existsSync(ws.dir)).toBe(true);
  expect(ws.dir).toContain("aid-");
  ws.cleanup();
  expect(existsSync(ws.dir)).toBe(false);
});
```

`strategies/types.test.ts`:

```ts
import type { TestStrategyReport } from "./types.js";

test("TestStrategyReport 判别联合可携带各方向 detail", () => {
  const smoke: TestStrategyReport = { strategy: "smoke", status: "pass", summary: "s", durationMs: 10, generatedTestsKept: false, detail: { converged: true, steps: 1, rounds: 0, cases: [], targetFiles: [], sourceIssues: [], summary: "" } };
  expect(smoke.detail.converged).toBe(true);
  const aid: TestStrategyReport = { strategy: "aid", status: "fail", passRate: 0.5, durationMs: 10, generatedTestsKept: true, keptDir: "/x", summary: "s", detail: { schemaVersion: "1.1", variants: [], oracleSummary: { consensusCount: 0, disputedCount: 0 }, comparisons: [], passRate: 0.5, totalCases: 2, passedCases: 1, failedCases: 1, disputedCases: 0, consensusExpectedConflicts: [], baseline: { description: {} as never, batchDescription: {} as never, variants: [], oracle: [], consensusOptions: {}, cleanTarget: { usable: true }, cleanFailedCaseIds: [] } } };
  expect(aid.passRate).toBe(0.5);
});
```
(若 `AIDReplayBaseline` 字段复杂,改用 `detail` 的最小类型断言 `satisfies TestStrategyReport` 替代完整构造)

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/translation-verifier && npx vitest run src/strategies`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 types.ts 与 workspace.ts**

`strategies/types.ts`(类型定义见 Interfaces,直接落地;`TestStrategyReport.detail` 用判别联合 `SmokeReport | ConsistencyResult | AIDVerificationReport | MitGenResult`)。

`strategies/workspace.ts`:

```ts
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestStrategy } from "./types.js";

export interface WorkspaceHandle {
  dir: string;
  cleanup(): void;
}

export function createWorkspace(root: string, strategy: TestStrategy): WorkspaceHandle {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 6);
  const dir = resolve(root, `${strategy}-${stamp}-${rand}`);
  mkdirSync(dir, { recursive: true });
  let cleaned = false;
  return {
    dir,
    cleanup() {
      if (!cleaned) { rmSync(dir, { recursive: true, force: true }); cleaned = true; }
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd services/translation-verifier && npx vitest run src/strategies`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/zen/Studio/projects/active/weichai
git add services/translation-verifier/src/strategies
git commit -m "feat(translation-verifier): strategies 类型与工作目录管理"
```

---

### Task 5: 四个策略 runner + 工厂

**Files:**
- Create: `src/strategies/{smoke-runner,distinct-runner,aid-runner,mitgen-runner,index,helpers}.ts`
- Test: `src/strategies/{smoke-runner,distinct-runner,aid-runner,mitgen-runner,index}.test.ts`
- Modify: `src/strategies/types.ts`(如需 `LlmOptions` 别名)

**Interfaces:**
- Consumes: Task 4 的类型;`SmokeAgent`(构造 `SmokeAgentOptions`,`.run(): Promise<SmokeReport>`);`runConsistencyVerification(job, executor, analyzer, options)`;`verifyWithVariants(job, executor, agents, logger)`;`MitGenMigratorAgent.generate(input, executor, signal)`;`RealDriverExecutor`(Task 2 增强);`runClaude`(Task 3 增强)
- Produces: `createTestStrategy(strategy, options: StrategyRunOptions & { executor: DriverExecutor; llm: ClaudeClientOptions }): TestStrategyRunner`;`helpers.ts` 导出 `makeLlmClient(llmOptions, sandbox): ClaudeClientOptions`(组装 cwd/addDirs/readOnlyDirs/permissionMode)与 `mapStatus/reportDuration` 工具

- [ ] **Step 1: 写失败测试**(以 smoke-runner 为主,其余三个 runner 测试同构)

`strategies/smoke-runner.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestStrategy } from "./index.js";
import type { TestStrategyJob } from "./types.js";

const job: TestStrategyJob = {
  requirement: "对输入加一",
  source: { language: "Java", files: [{ path: "A.java", content: "public class A { public static int f(int x) { return x + 1; } }" }] },
  target: { language: "C#", className: "A", method: "f", isStatic: true },
};

test("smoke 策略 run 返回归一化报告并计时", async () => {
  const base = mkdtempSync(join(tmpdir(), "fx-strat-"));
  const runner = createTestStrategy("smoke", {
    executor: { run: async () => ({}) } as never,   // fake executor(不真正编译)
    llm: { apiKey: "k", spawnClaude: async () => ({ stdout: JSON.stringify({ action: "finish", params: { summary: "ok" } }), exitCode: 0 }) },
    workspaceRoot: base,
  });
  const report = await runner.run(job);
  expect(report.strategy).toBe("smoke");
  expect(typeof report.durationMs).toBe("number");
  expect(report.durationMs).toBeGreaterThanOrEqual(0);
  expect(report.generatedTestsKept).toBe(false);
});
```
(各 runner 内部需把 `TestStrategyJob` 转成各自输入;测试用 fake LLM 序列驱动 SmokeAgent 快速走到 finish,具体 fake 序列参考 `smoke-agent.test.ts` 现有用例的 `parseAction` 兼容输出)

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/translation-verifier && npx vitest run src/strategies`
Expected: FAIL(`createTestStrategy` 不存在)

- [ ] **Step 3: 实现 helpers.ts 与四个 runner**

`strategies/helpers.ts`:

```ts
import { resolve } from "node:path";
import type { ClaudeClientOptions } from "../claude-client.js";
import type { StrategyRunOptions, TestStrategyJob } from "./types.js";

export function makeLlmClient(
  llm: ClaudeClientOptions,
  sandbox: { readOnlyDirs: string[]; writableDir: string },
): ClaudeClientOptions {
  const addDirs = [...new Set([...sandbox.readOnlyDirs, sandbox.writableDir].map((d) => resolve(d)))];
  return {
    ...llm,
    cwd: sandbox.writableDir,
    addDirs,
    readOnlyDirs: sandbox.readOnlyDirs.map((d) => resolve(d)),
    permissionMode: "acceptEdits",
  };
}

export function defaultSandbox(job: TestStrategyJob, writableDir: string): { readOnlyDirs: string[]; writableDir: string } {
  return {
    readOnlyDirs: [job.source.root, job.target.root].filter((d): d is string => Boolean(d)),
    writableDir,
  };
}
```

`strategies/smoke-runner.ts`(其余 runner 同构,差异见接口注释):

```ts
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import { SmokeAgent } from "../smoke/smoke-agent.js";
import type { SmokeReport } from "../smoke/smoke-types.js";
import { createWorkspace } from "./workspace.js";
import { defaultSandbox, makeLlmClient } from "./helpers.js";
import type { StrategyRunOptions, TestStrategyRunner, TestStrategyReport } from "./types.js";

export function createSmokeRunner(options: StrategyRunOptions & { executor: any; llm: any }): TestStrategyRunner {
  return {
    async run(job, signal) {
      const started = performance.now();
      const ws = createWorkspace(options.workspaceRoot ?? process.cwd(), "smoke");
      const sandbox = options.claudeSandbox ?? defaultSandbox(job, ws.dir);
      const llm = makeLlmClient(options.llm, sandbox);
      try {
        const agent = new SmokeAgent({
          requirement: job.requirement,
          sourceDir: job.source.root ?? (job.source.files?.[0] ? dirname(job.source.files[0].path) : undefined),
          targetDir: job.target.root ?? (job.target.file ? dirname(job.target.file) : undefined),
          spawnClaude: llm.spawnClaude,
          executor: options.executor,
        });
        const report = await agent.run();
        const durationMs = performance.now() - started;
        return { strategy: "smoke", status: report.converged ? "pass" : "fail", passRate: passRateFromSmoke(report), summary: report.summary, durationMs, generatedTestsKept: options.keepGeneratedTests ?? false, keptDir: options.keepGeneratedTests ? ws.dir : undefined, detail: report };
      } finally {
        if (!(options.keepGeneratedTests ?? false)) ws.cleanup();
      }
    },
  };
}

function passRateFromSmoke(report: SmokeReport): number | undefined {
  if (report.cases.length === 0) return undefined;
  const pass = report.cases.filter((c) => c.mechanical === "pass").length;
  return pass / report.cases.length;
}
```
`SmokeCaseVerdict.mechanical` 的枚举名以 `smoke-types.ts` 实际为准(查 `SmokeMechanicalVerdict` 定义,可能是 "pass" | "fail" | "divergent" 之类),runner 里统一用 `c.mechanical === "pass"` 判 pass;若枚举值不同按实际调整。

`strategies/distinct-runner.ts`:构造 `LlmAnalyzer`(需 sourceCode 与 requirement,`LlmAnalyzerOptions` 含 spawnClaude/executor)→ `runConsistencyVerification`;`status = report.failedCases === 0 ? "pass" : "fail"`;`passRate = report.report.passRate`;detail = ConsistencyResult。
`strategies/aid-runner.ts`:构造 `VariantGeneratorAgent`/`InputGeneratorAgent` → `verifyWithVariants`;`status = failedCases === 0 ? "pass" : "fail"`(cleanTarget.usable === false 时 "unverified");detail = AIDVerificationReport。
`strategies/mitgen-runner.ts`:构造 `MitGenMigratorAgent` → `.generate(MigrationInput, executor)`;`status = "pass"`(生成成功即成功);passRate = undefined;detail = MitGenResult。

`strategies/index.ts`:

```ts
export { createSmokeRunner } from "./smoke-runner.js";
export { createDistinctRunner } from "./distinct-runner.js";
export { createAidRunner } from "./aid-runner.js";
export { createMitgenRunner } from "./mitgen-runner.js";
export type { TestStrategy, TestStrategyJob, TestStrategyReport, TestStrategyRunner, StrategyRunOptions } from "./types.js";

export function createTestStrategy(strategy: TestStrategy, options: any): TestStrategyRunner {
  switch (strategy) {
    case "smoke": return createSmokeRunner(options);
    case "distinct": return createDistinctRunner(options);
    case "aid": return createAidRunner(options);
    case "mitgen": return createMitgenRunner(options);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd services/translation-verifier && npx vitest run src/strategies && npm run test --workspace @forexplore/translation-verifier 2>&1 | tail -3`
Expected: strategies 全绿 + 全量回归绿

- [ ] **Step 5: 提交**

```bash
cd /Users/zen/Studio/projects/active/weichai
git add services/translation-verifier/src/strategies
git commit -m "feat(translation-verifier): 统一策略入口 createTestStrategy 与四方向 runner"
```

---

### Task 6: index.ts 导出新 API + test-results 目录 + 回归

**Files:**
- Modify: `services/translation-verifier/src/index.ts`
- Modify: `.gitignore`
- Test: `services/translation-verifier/src/index.test.ts`(追加)

**Interfaces:**
- Consumes: Task 5 的 `strategies/index.ts`
- Produces: 从包入口可 `import { createTestStrategy, type TestStrategy, type TestStrategyReport } from "@forexplore/translation-verifier"`;`.gitignore` 忽略 `test-results/`

- [ ] **Step 1: 写失败测试**(追加到 `index.test.ts`)

```ts
import { createTestStrategy } from "./index.js";

test("index 导出统一策略入口", () => {
  expect(typeof createTestStrategy).toBe("function");
  const runner = createTestStrategy("mitgen", { executor: {} as never, llm: { apiKey: "k" } });
  expect(typeof runner.run).toBe("function");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd services/translation-verifier && npx vitest run src/index.test.ts -t 统一策略`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// index.ts 追加:
export { createTestStrategy } from "./strategies/index.js";
export type {
  TestStrategy,
  TestStrategyJob,
  TestStrategyReport,
  TestStrategyRunner,
  StrategyRunOptions,
} from "./strategies/index.js";
```

```bash
# .gitignore 追加一行:
echo "test-results/" >> .gitignore
```

- [ ] **Step 4: 全量回归 + e2e + 提交**

```bash
cd services/translation-verifier
npm run test --workspace @forexplore/translation-verifier 2>&1 | tail -3
npx tsx e2e/run-smoke-e2e.ts --offline; echo "smoke-e2e EXIT=$?"
cd /Users/zen/Studio/projects/active/weichai
git add .gitignore services/translation-verifier/src/index.ts services/translation-verifier/src/index.test.ts
git commit -m "feat(translation-verifier): 包入口导出统一策略 API,忽略 test-results 目录"
```
Expected: 单测全绿;`run-smoke-e2e.ts` 离线路径退出码 0(其余 e2e 需真实工具链,可在 CI/本地按需跑)。

---

## Self-Review 记录

- **Spec 覆盖**:§2 目录结构 → Task 1;§3 类型/工厂 → Task 4/5;§4 保留控制 + 目录隔离 → Task 2(executor)+ Task 4(workspace)+ Task 5(runner);§5 claude 沙箱 → Task 3 + Task 5(helpers.makeLlmClient);§6 导出兼容 → Task 1 + Task 6;§8 测试 → 各任务 Step 4;§9 风险 → 手工冒烟验证 Edit deny 规则。
- **类型一致性**:`TestStrategyReport` 字段在 Task 4 定义、Task 5/6 消费,字段名一致(`durationMs`/`generatedTestsKept`/`keptDir`/`detail`);`createTestStrategy(strategy, options)` 签名在 Task 5 产出、Task 6 验证。
- **已知依赖细节**:`SmokeCaseVerdict.mechanical` 枚举值、`SmokeAgentOptions` 字段名、`AIDReplayBaseline` 结构以现有源码为准,实施时若与计划中的示例写法不一致,按实际类型调整并保持接口签名不变。
