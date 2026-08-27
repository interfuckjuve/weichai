# translation-verifier 四方向模块化 + claude 自主模式 实施计划(细致版)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四个测试方向归入独立文件夹;smoke/distinct/aid/mitgen 全部改为 claude 自主模式(一次 claude 调用,claude 自己用内部工具读写/编译/运行/修复/写 report.json);统一策略入口 + 沙箱(只读参考/可写工作目录)+ hook 步骤日志;删除 ReAct 遗留代码,保留核心算法方法。

**Architecture:** 分层:①`claude-client.ts` 增强(自主会话参数封装)→ ②`strategies/` 门面(workspace 管理 + 报告解析 + 策略提示词 + runner 归一化)→ ③删除 ReAct 遗留、目录重组 → ④quality 适配器切到统一入口。

**Tech Stack:** TypeScript + vitest + node child_process spawn + git mv。

**Spec:** `docs/superpowers/specs/2026-08-27-translation-verifier-strategies-design.md`(rev.3,四方向 claude 自主模式)

## Global Constraints

- 基线 ~549 tests 全绿;不得破坏保留模块的现有测试。
- 代码注释/文档中文;提交信息英文 conventional commits。
- `index.ts` 保留的导出签名不变;被删模块导出移除;`adaptation-service` 零改动。
- 默认行为不变:无沙箱配置时 claude 参数与现状一致;`keepGeneratedTests` 默认 false。
- 单测全部 fake spawnClaude(捕获 args / 预设 report.json),不触网、不跑真实 claude。
- 已实测(2026-08-27):`claude -p` 自主工具循环 ✅、`--allowedTools "Bash(javac *)"` ✅、`acceptEdits` ✅、`--add-dir` + `Edit(//ref/**)` 只读 ✅、`--settings` 注入 PostToolUse hook ✅。
- 已知环境坑:claude 子进程可能找不到 JDK(`Unable to locate a Java Runtime`)——提示词要求用全路径(`$JAVA_HOME/bin/javac`),统一入口注入 `JAVA_HOME` 环境变量。
- 本分支已修复 sdkman `current` 符号链接指向(基线验证通过)。

---

### Task 1: claude-client 增强(自主会话参数 + hooks 日志)

**目标:** `runClaude`/`spawnClaudeProcess` 支持 cwd、add-dirs、read-only dirs、permission-mode、max-turns、hooks 日志文件,参数组装全部可注入可断言。

**Files:**
- Modify: `services/translation-verifier/src/claude-client.ts`
- Test: `services/translation-verifier/src/claude-client.test.ts`(追加,不破坏现有 8 个用例)

**Interfaces(产出,后续 Task 3 依赖):**

```ts
// claude-client.ts
export interface ClaudeClientOptions {
  apiKey?: string; model?: string; spawnClaude?: SpawnClaude; timeoutMs?: number; logger?: Logger;
  // ★ 新增:
  cwd?: string;                        // 子进程工作目录(默认继承父进程)
  addDirs?: string[];                  // --add-dir <dir> ...(可读写目录)
  readOnlyDirs?: string[];             // --disallowedTools "Edit(//<resolve(dir)>/**)" ...(只读参考)
  permissionMode?: "manual" | "acceptEdits";
  maxTurns?: number;                   // --max-turns <N>
  hooksLogPath?: string;               // 生成临时 settings 文件,PostToolUse hook 追加该路径
}

export type SpawnClaude = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options?: { cwd?: string; spawn?: typeof spawn; settingsFile?: string },
) => Promise<{ stdout: string; exitCode: number }>;

/** 写临时 hooks settings 文件(PostToolUse hook 把每次工具调用 JSON 行追加到 logPath),返回 settings 文件路径。 */
export function buildHooksSettings(settingsPath: string, logPath: string): string;
```

**步骤:**

- [ ] **Step 1: 追加失败测试**(`claude-client.test.ts`,import 增加 `spawnClaudeProcess, buildHooksSettings, type ClaudeClientOptions`)

```ts
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude, spawnClaudeProcess, buildHooksSettings, type SpawnClaude } from "./claude-client.js";

describe("spawnClaudeProcess 自主会话参数", () => {
  it("组装 add-dir/disallowedTools/permission-mode/max-turns/settings 并透传 cwd", async () => {
    const captured: { args: string[]; opts: { cwd?: string; settingsFile?: string } }[] = [];
    const fake: SpawnClaude = async (args, _env, _t, o) => {
      captured.push({ args, opts: o ?? {} });
      return { stdout: "ok", exitCode: 0 };
    };
    await spawnClaudeProcess(
      ["-p", "hello", "--output-format", "text"],
      { ANTHROPIC_AUTH_TOKEN: "k" } as NodeJS.ProcessEnv,
      1000,
      { cwd: "/tmp/fx", addDirs: ["/refA", "/tmp/fx"], readOnlyDirs: ["/refA"], permissionMode: "acceptEdits", maxTurns: 50, settingsFile: "/tmp/fx/settings.json", spawn: fake },
    );
    const a = captured[0].args;
    expect(a).toContain("--add-dir"); expect(a).toContain("/refA"); expect(a).toContain("/tmp/fx");
    expect(a).toContain("--disallowedTools"); expect(a.some((x) => x.includes("Edit(//refA/**)"))).toBe(true);
    expect(a).toContain("--permission-mode"); expect(a).toContain("acceptEdits");
    expect(a).toContain("--max-turns"); expect(a).toContain("50");
    expect(a).toContain("--settings"); expect(a).toContain("/tmp/fx/settings.json");
    expect(captured[0].opts.cwd).toBe("/tmp/fx");
  });

  it("无自主选项时 args 与现状一致(不加任何新参数)", async () => {
    const captured: string[][] = [];
    const fake: SpawnClaude = async (args) => { captured.push(args); return { stdout: "ok", exitCode: 0 }; };
    await spawnClaudeProcess(["-p", "x", "--output-format", "text"], {} as NodeJS.ProcessEnv, 1000, { spawn: fake });
    expect(captured[0]).toEqual(["-p", "x", "--output-format", "text"]);
  });
});

describe("buildHooksSettings", () => {
  it("生成含 PostToolUse hook 的 settings 文件,命令追加到 logPath", () => {
    const base = mkdtempSync(join(tmpdir(), "fx-hooks-"));
    const settingsPath = join(base, "settings.json"); const logPath = join(base, "steps.jsonl");
    const out = buildHooksSettings(settingsPath, logPath);
    expect(out).toBe(settingsPath);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const hook = parsed.hooks.PostToolUse[0].hooks[0];
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("*");
    expect(hook.type).toBe("command");
    expect(hook.command).toContain(logPath);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("runClaude 透传自主选项", () => {
  it("cwd/addDirs/readOnlyDirs/permissionMode/maxTurns/hooksLogPath 传给 spawnClaude 第四参数", async () => {
    const captured: { args: string[]; opts?: Record<string, unknown> }[] = [];
    const fake: SpawnClaude = async (args, _env, _t, o) => { captured.push({ args, opts: o }); return { stdout: "ok", exitCode: 0 }; };
    const settingsPath = "/tmp/fx/settings.json";
    await runClaude("p", { apiKey: "k", spawnClaude: fake, cwd: "/tmp/fx", addDirs: ["/refA"], readOnlyDirs: ["/refA"], permissionMode: "acceptEdits", maxTurns: 50, hooksLogPath: "/tmp/fx/steps.jsonl" });
    expect(captured[0].opts?.cwd).toBe("/tmp/fx");
    expect(captured[0].opts?.settingsFile).toContain("hooks");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd services/translation-verifier && npx vitest run src/claude-client.test.ts`
Expected: FAIL(spawnClaudeProcess/buildHooksSettings 未导出或签名不符)

- [ ] **Step 3: 实现**(`claude-client.ts`)

```ts
// 1) SpawnClaude 签名扩展(见 Interfaces)。
// 2) runClaude 内,在 spawnClaudeProcess 调用处组装:
export async function runClaude(prompt: string, options: ClaudeClientOptions = {}): Promise<string> {
  // ...apiKey/model/timeout 校验与 env 组装保持现状...
  const spawnOptions: { cwd?: string; settingsFile?: string } = {};
  let settingsFile: string | undefined;
  if (options.cwd) spawnOptions.cwd = options.cwd;
  if (options.hooksLogPath) {
    settingsFile = join(tmpdir(), `fx-hooks-${process.pid}-${Date.now()}.json`);
    buildHooksSettings(settingsFile, options.hooksLogPath);
    spawnOptions.settingsFile = settingsFile;
  }
  try {
    const result = await spawnClaude(["-p", prompt, "--output-format", "text"], env, timeoutMs, {
      ...spawnOptions,
      addDirs: options.addDirs,
      readOnlyDirs: options.readOnlyDirs,
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns,
    });
    // ...退出码处理保持现状...
  } finally {
    if (settingsFile) rmSync(settingsFile, { force: true }); // 临时 settings 用完即删
  }
}

// 3) spawnClaudeProcess 参数组装:
export async function spawnClaudeProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options: { cwd?: string; spawn?: typeof spawn; settingsFile?: string; addDirs?: string[]; readOnlyDirs?: string[]; permissionMode?: "manual" | "acceptEdits"; maxTurns?: number } = {},
): Promise<{ stdout: string; exitCode: number }> {
  const fullArgs = [...args];
  const addDirs = options.addDirs ?? [];
  const readOnlyDirs = (options.readOnlyDirs ?? []).map((d) => resolve(d));
  if (addDirs.length > 0) fullArgs.push("--add-dir", ...addDirs);
  if (readOnlyDirs.length > 0) fullArgs.push("--disallowedTools", ...readOnlyDirs.map((d) => `Edit(//${d}/**)`));
  if (options.permissionMode === "acceptEdits") fullArgs.push("--permission-mode", "acceptEdits");
  if (options.maxTurns !== undefined) fullArgs.push("--max-turns", String(options.maxTurns));
  if (options.settingsFile) fullArgs.push("--settings", options.settingsFile);
  // ...其余逻辑与现状相同,仅 spawn options 增加 cwd、spawn 可注入...
}

// 4) buildHooksSettings 实现(见 Interfaces;命令用 JSON.stringify 包裹 logPath 防空格)。
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `cd services/translation-verifier && npx vitest run src/claude-client.test.ts && npm run test --workspace @forexplore/translation-verifier 2>&1 | tail -3`
Expected: claude-client 全绿;全量 549 全绿

- [ ] **Step 5: 提交**

```bash
cd /Users/zen/Studio/projects/active/weichai
git add services/translation-verifier/src/claude-client.ts services/translation-verifier/src/claude-client.test.ts
git commit -m "feat(translation-verifier): claude 自主会话参数与 hooks 步骤日志"
```

---

### Task 2: strategies 基础设施(types + workspace + 报告读取)

**目标:** 定义统一入口的类型契约、工作目录布局、report.json 读取与校验。

**Files:**
- Create: `services/translation-verifier/src/strategies/types.ts`
- Create: `services/translation-verifier/src/strategies/workspace.ts`
- Create: `services/translation-verifier/src/strategies/report.ts`
- Test: 上述各 `.test.ts`

**Interfaces(产出,Task 3 依赖):**

```ts
// types.ts —— 完整契约(与 spec §5.1 一致)
import type { VerifierLanguage } from "../description.js";
import type { SideFile } from "../executor.js";
import type { SmokeReport } from "../smoke/smoke-types.js";
import type { ConsistencyResult } from "../distinct/consistency-verifier-types.js"; // 类型剪出后位置
import type { AIDVerificationReport } from "../aid/aid-verifier.js";
import type { MitGenResult } from "../mitgen/types.js";

export type TestStrategy = "smoke" | "distinct" | "aid" | "mitgen";

export interface StrategySide {
  language: VerifierLanguage;
  files?: SideFile[];
  root?: string;          // 仓库/项目根目录(默认注入为只读参考目录)
}

export interface TestStrategyJob {
  requirement: string;
  source: StrategySide;
  target: StrategySide & { className: string; method: string; isStatic: boolean; file?: string };
}

export interface StrategyRunOptions {
  keepGeneratedTests?: boolean;         // 默认 false
  workspaceRoot?: string;               // 默认 <repoRoot>/test-results
  claudeSandbox?: { readOnlyDirs: string[]; writableDir?: string };
  maxTurns?: number;                    // 默认 50
  apiKey?: string; model?: string; timeoutMs?: number;
}

export type StrategyStatus = "pass" | "fail" | "unverified" | "error";

export interface TestStrategyReport {
  strategy: TestStrategy;
  status: StrategyStatus;
  passRate?: number;
  summary: string;
  durationMs: number;
  generatedTestsKept: boolean;
  keptDir?: string;
  detail: SmokeReport | ConsistencyResult | AIDVerificationReport | MitGenResult;
}

export interface TestStrategyRunner {
  run(job: TestStrategyJob, signal?: AbortSignal): Promise<TestStrategyReport>;
}
```

```ts
// workspace.ts
export interface WorkspaceHandle {
  dir: string;                 // 工作目录绝对路径
  reportPath: string;          // dir/report.json
  stepsLogPath: string;        // dir/claude-steps.jsonl
  cleanup(): void;             // keep=false 时删除整个目录
}
export function createWorkspace(root: string, strategy: TestStrategy): WorkspaceHandle;
// 目录名:<strategy>-<YYYYMMDDHHmmss>-<rand>
```

```ts
// report.ts
/** 读 dir/report.json,缺失/非法 JSON 抛带上下文的错误;可传校验函数(解析后校验)。 */
export async function readReport<T>(dir: string, validate?: (raw: unknown) => asserts raw is T): Promise<T>;
/** 把任意错误(含 readReport 错误)归一化为 { status: "error", summary }。 */
export function errorSummary(error: unknown): string;
```

**步骤:**

- [ ] **Step 1: 写失败测试**(workspace 创建/清理/保留;report 读取/校验/错误归一化;types 判别联合编译检查)
- [ ] **Step 2: 运行确认失败**(vitest run src/strategies)
- [ ] **Step 3: 实现**三个文件(代码见 Interfaces;`createWorkspace` 用 `mkdirSync(dir, { recursive: true })` 与 `rmSync` 惰性清理;`readReport` 用 `readFileSync(reportPath, "utf-8")` + `JSON.parse`,validate 可选)
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**(`git add services/translation-verifier/src/strategies && git commit -m "feat(translation-verifier): strategies 类型/工作目录/报告读取"`)

---

### Task 3: 策略提示词 + 四方向 runner + 工厂

**目标:** 四个策略各一个自主任务提示词(内嵌报告 schema);四个 runner 走统一自主流程;`createTestStrategy` 工厂。

**Files:**
- Create: `src/strategies/prompts/smoke-task.ts`、`distinct-task.ts`、`aid-task.ts`、`mitgen-task.ts`
- Create: `src/strategies/helpers.ts`
- Create: `src/strategies/smoke-runner.ts`、`distinct-runner.ts`、`aid-runner.ts`、`mitgen-runner.ts`
- Create: `src/strategies/index.ts`
- Test: `src/strategies/prompts/*.test.ts`、`src/strategies/*-runner.test.ts`、`src/strategies/index.test.ts`

**Interfaces(产出,Task 4/5 依赖):**

```ts
// prompts/smoke-task.ts
export interface SmokeTaskInput {
  requirement: string;
  source: { language: VerifierLanguage; root?: string; files?: SideFile[] };
  target: { language: VerifierLanguage; className: string; method: string; isStatic: boolean; root?: string; file?: string };
}
export function buildSmokeTaskPrompt(input: SmokeTaskInput): string;
// 提示词内容:任务(读源→写 runner→双侧编译运行→差分比较→judge→必要时修复)+ 沙箱约束(只读参考目录、仅在工作目录写)
// + 工具说明(可用 Bash 命令清单:javac/java/dotnet/python3/tsx,提示用 $JAVA_HOME/bin 全路径)
// + 报告契约(内嵌 SmokeReport schema 字段表与示例;要求把 JSON 写入 report.json,写完即结束)

// 其余三策略同构:buildDistinctTaskPrompt → ConsistencyResult schema;buildAidTaskPrompt → AIDVerificationReport schema;buildMitgenTaskPrompt → MitGenResult schema。
```

```ts
// helpers.ts
export function defaultSandbox(job: TestStrategyJob, writableDir: string): { readOnlyDirs: string[]; writableDir: string };
// readOnlyDirs = [job.source.root, job.target.root].filter(Boolean) 去重后 resolve
export function makeClaudeOptions(
  llm: { apiKey?: string; model?: string; timeoutMs?: number },
  sandbox: { readOnlyDirs: string[]; writableDir: string },
  stepsLogPath: string,
  maxTurns: number,
): ClaudeClientOptions;
// → { apiKey, model, timeoutMs, cwd: writableDir, addDirs: [...readOnlyDirs, writableDir], readOnlyDirs, permissionMode: "acceptEdits", maxTurns, hooksLogPath: stepsLogPath, env: { JAVA_HOME } }
```

```ts
// smoke-runner.ts(其余三策略同构,差异在提示词构建与报告校验/归一化)
export function createSmokeRunner(options: StrategyRunOptions & { llm: { apiKey?: string; model?: string; timeoutMs?: number } }): TestStrategyRunner;
// run(job, signal):
//   1. const started = performance.now();
//   2. const ws = createWorkspace(options.workspaceRoot ?? join(repoRoot, "test-results"), "smoke");
//   3. const sandbox = options.claudeSandbox ?? defaultSandbox(job, ws.dir);
//   4. const llm = makeClaudeOptions(options.llm, sandbox, ws.stepsLogPath, options.maxTurns ?? 50);
//   5. const prompt = buildSmokeTaskPrompt(job);
//   6. await runClaude(prompt, llm);
//   7. const detail = await readReport<SmokeReport>(ws.dir);  // 解析失败 → catch → errorSummary
//   8. 归一化 status/passRate/summary(映射表见 spec §3.3/3.4):
//      status = detail.converged ? "pass" : "fail"; passRate = cases 机械 pass 占比(空数组 undefined);summary = detail.summary
//   9. keep = options.keepGeneratedTests ?? false;!keep && ws.cleanup();
//   10. return { strategy, status, passRate, summary, durationMs: performance.now() - started, generatedTestsKept: keep, keptDir: keep ? ws.dir : undefined, detail };
```

```ts
// aid-runner.ts 差异:
//   预处理器:VariantGeneratorAgent({ ...llm 基础选项 }).generateVariants(...) → 变体文件写入 ws.dir/variants/;
//   提示词 buildAidTaskPrompt(job, { variantsDir: ws.dir/variants });
//   归一化:status = cleanTarget.usable === false ? "unverified" : failedCases === 0 ? "pass" : "fail";passRate = detail.passRate
// mitgen-runner.ts 差异:
//   预处理器:extractFragments(sourceCode) → 片段清单传入 buildMitgenTaskPrompt;
//   归一化:status = "pass"(生成成功);passRate = undefined
```

```ts
// index.ts
export function createTestStrategy(
  strategy: TestStrategy,
  options: StrategyRunOptions & { llm: { apiKey?: string; model?: string; timeoutMs?: number } },
): TestStrategyRunner;
// switch 分发到四个 runner;非法策略 throw
export type { TestStrategy, TestStrategyJob, TestStrategyReport, TestStrategyRunner, StrategyRunOptions, StrategyStatus };
```

**步骤:**

- [ ] **Step 1: 写失败测试**
  - `prompts/*.test.ts`:断言提示词包含任务指令、`report.json`、报告 schema 关键字段名(如 smoke 含 `converged`/`cases`,aid 含 `passRate`/`variants`)、`$JAVA_HOME`、只读目录约束、Bash 白名单说明;
  - `smoke-runner.test.ts`:fake spawnClaude 捕获调用(断言 cwd/addDirs/readOnlyDirs/hooksLogPath 透传)+ 预写 `report.json`(合法 SmokeReport)→ 断言返回报告归一化正确、durationMs ≥ 0、keep=true 时 keptDir 存在且目录未删、keep=false 时目录已删;
  - 其余 runner 测试同构(各自报告 schema + 预处理器:aid 测变体预生成、mitgen 测片段预提取);
  - `index.test.ts`:工厂分发与非法策略抛错。
- [ ] **Step 2: 运行确认失败**(vitest run src/strategies)
- [ ] **Step 3: 实现**(见 Interfaces;提示词用模板字符串,报告 schema 以注释形式嵌入精确字段,示例 JSON 精简)
- [ ] **Step 4: 运行确认通过 + 全量回归**(vitest run src/strategies + npm run test workspace)
- [ ] **Step 5: 提交**(`git commit -m "feat(translation-verifier): 策略提示词与四方向自主 runner + 工厂"`)

---

### Task 4: 删除 ReAct 遗留 + 目录移动 + import 修复 + quality 适配器切换

**目标:** 物理重组目录;删除不再需要的 ReAct 代码;quality 四适配器切到统一入口;编译与全量测试通过。

**Files:**

| 动作 | 路径 |
| --- | --- |
| 删除 | `src/smoke-tools.ts` `src/smoke-proto.ts` `src/smoke-agent.ts`(+3 test) |
| 删除 | `src/validator.ts`(+test) `src/consistency-verifier.ts`(+test) |
| 剪裁 | `src/analyzer.ts` → 仅保留类型/常量(`BranchInfo/BranchInventory/CaseConsistency/ConsistencyReport/CoverageProvider` 等),删除 `LlmAnalyzer` 与 LLM 方法 |
| 移动 | `src/smoke-types.ts` `src/smoke-prompts.ts`(+test 如需)→ `src/smoke/` |
| 移动 | `src/analyzer.ts`(剪裁后)→ `src/distinct/` |
| 改名 | `src/variant/` → `src/aid/`(全部保留,含 6 实现 + 6 test) |
| 保留 | `src/mitgen/` 全部 |
| 修改 | `src/quality/adapters/{smoke,distinct,aid,mitgen}.ts`(改调 createTestStrategy) |
| 修改 | `src/quality/types.ts` `src/quality/metrics.ts`(smoke 路径 `../smoke-types.js`→`../smoke/smoke-types.js`、`../smoke-tools.js`→删引用) |
| 修改 | `src/index.ts`(导出调整,见 Task 5 前的中间态:保留既有导出中仍存在的,移除被删) |
| 修改 | `e2e/run-e2e.ts` `run-e2e-aid.ts` `run-smoke-e2e.ts`(import 路径;自主模式下 fixture 机制失效,e2e 改为黑盒或标记需真实 claude) |

**quality 适配器改造要点**(产出 `GeneratedTest` 契约不变,供 `metrics.ts`/`evaluate.ts` 消费):

```ts
// quality/adapters/smoke.ts(示意;其余三适配器同构)
import { createTestStrategy } from "../../strategies/index.js";
// generateTest(task):
//   1. const runner = createTestStrategy("smoke", { llm: { apiKey, model }, keepGeneratedTests: false, maxTurns });
//   2. const report = await runner.run({ requirement, source: { language, files }, target: { language, className, method, isStatic } });
//   3. 组装 GeneratedTest:kind "runner";runner.files = 从 report.detail.targetFiles(或 keptDir 读取);report 字段挂 runner.report;
//      meta.durationMs = report.durationMs;失败/error → 按适配器既有失败语义记录(不中断评估)。
// 注意:适配器单测原先用 fake spawnClaude + FakeDriverExecutor 全离线,现在 smoke/distinct/aid/mitgen 适配器测试改为:
//   - 注入预设 report.json 的离线夹具(fake spawnClaude 返回固定 stdout,runner 读预写 report.json);
//   - 或标记为集成测试(需要真实 claude),从 vitest 默认排除。
```

**步骤:**

- [ ] **Step 1: 先改 quality/adapters/{smoke,distinct,aid,mitgen}.ts 走 createTestStrategy**(否则删除 SmokeAgent 后编译失败);同步改适配器测试
- [ ] **Step 2: git mv + 删除 + 剪裁**(命令见上表;`git mv src/variant src/aid`;剪裁 analyzer.ts 用编辑而非 mv 后剪)
- [ ] **Step 3: 修其余 import**(quality/types、metrics、index.ts、e2e 三脚本;`grep -rn 'from "[^"]*\.\./\(smoke-[a-z]*\|analyzer\|validator\|consistency-verifier\|variant\)' src e2e` 确认无遗漏)
- [ ] **Step 4: tsc + 全量测试**(被删模块测试随文件删除;如某保留模块引用被删符号,修之)
- [ ] **Step 5: 提交**(`git commit -m "refactor(translation-verifier): 删除 ReAct 遗留,四方向归入独立目录,quality 适配器切换统一入口"`)

---

### Task 5: index.ts 导出 + .gitignore + 黑盒冒烟 + 回归

**目标:** 包入口导出统一策略 API 与保留模块;忽略 test-results;真实 claude 黑盒冒烟验证全链路。

**Files:**
- Modify: `src/index.ts`、`.gitignore`、`e2e/README.md`、`services/translation-verifier/README.md`

**index.ts 导出调整:**

```ts
// 移除(被删模块):SmokeAgent/SmokeAgentOptions/runConsistencyVerification/ConsistencyResult 相关/DescriptionValidator/buildValidatorFeedbackPrompt/filterDriverErrors/ConsistencyVerifierOptions/LlmAnalyzer(视剪裁结果)
// 保留(移动后路径):smoke-types(SmokeReport 等,from "./smoke/smoke-types.js")、analyzer 类型(from "./distinct/analyzer.js")、variant→aid(export * from "./aid/index.js")、mitgen(路径不变)
// 新增:
export { createTestStrategy } from "./strategies/index.js";
export type { TestStrategy, TestStrategyJob, TestStrategyReport, TestStrategyRunner, StrategyRunOptions, StrategyStatus } from "./strategies/index.js";
```

**步骤:**

- [ ] **Step 1: index.ts 调整导出;确认 `services/adaptation-service` 等消费方编译通过**(`npx tsc --noEmit` 于 adaptation-service)
- [ ] **Step 2: `.gitignore` 追加 `test-results/`**
- [ ] **Step 3: 全量回归 + tsc**(translation-verifier 全绿;adaptation-service/adaptation-mcp-server tsc 无错)
- [ ] **Step 4: 真实 claude 黑盒冒烟(有 key 时)**:写最小脚本 `npx tsx -e` 调 `createTestStrategy("smoke")` 跑一个最小 Java→C# 任务;断言:exit 正常、`keptDir` 下存在 `report.json` 与 `claude-steps.jsonl`(hook 有 ≥1 行工具调用记录)、报告 status 非 "error"
- [ ] **Step 5: README 更新(e2e 说明黑盒运行;自主模式架构一节)+ 提交**(`git commit -m "feat(translation-verifier): 包入口导出统一策略 API,忽略 test-results"`)

---

## Self-Review 记录

- **Spec 覆盖:** §4 claude-client → Task 1;§5.1/5.2 → Task 2;§5.3/5.4(四策略提示词+报告 schema)→ Task 3;§3 目录/删除/保留 → Task 4;§6 quality(四适配器)→ Task 4;§7 兼容 → Task 4/5;§8 测试 → 各 Task;§9 风险(JDK 全路径、报告解析失败兜底)→ Task 1 env、Task 3 readReport、Task 5 冒烟。
- **类型一致性:** `TestStrategyReport` 字段 Task 2 定义、Task 3/5 消费一致(`durationMs`/`generatedTestsKept`/`keptDir`/`detail`);`createTestStrategy(strategy, options)` Task 3 产出、Task 4/5 消费;`buildSmokeTaskPrompt` 等命名全策略一致。
- **依赖顺序:** Task 4 删除前 quality 适配器必须先切到 strategies(Task 3 完成)——Step 1 强制;剪裁 analyzer.ts 前确认 e2e/run-e2e.ts 的引用先改。
- **待实施时核对:** `smoke-prompts.ts` 现有 `SMOKE_SYSTEM_PROMPT`/`buildTurnPrompt` 等是否被 quality/metrics 或 e2e 引用(仅保留需要的,其余随剪裁删除);`claude-client.ts` 现有 `import { join }` 需补 `resolve`、`tmpdir`、`writeFileSync`、`rmSync`。
