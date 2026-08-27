# translation-verifier 四方向模块化 + claude 自主模式 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四方向归入独立文件夹;smoke/distinct 改为 claude 自主模式(一次调用,claude 自己读写/编译/运行/修复/写 report.json);统一策略入口 + 沙箱 + hook 步骤日志;删除 ReAct 遗留代码。

**Architecture:** claude 自主会话封装(claude-client 增强:add-dir/readOnlyDirs/acceptEdits/max-turns/hooks)→ strategies 门面(workspace + 提示词 + 报告解析 + 归一化)→ 删除 smoke-tools/smoke-proto/smoke-agent/validator/consistency-verifier → quality 适配器切换调用。

**Tech Stack:** TypeScript + vitest + node child_process spawn + git mv。

**Spec:** `docs/superpowers/specs/2026-08-27-translation-verifier-strategies-design.md`(rev.2,claude 自主模式)

## Global Constraints

- 不得破坏现有测试:基线 ~532 tests 全绿(除被删除模块的测试)。
- 代码注释/文档中文;提交信息英文 conventional commits。
- `index.ts` 保留的导出签名不变;被删模块导出移除;`adaptation-service` 零改动。
- 默认行为不变:无沙箱配置时 claude 参数与现状一致;`keepGeneratedTests` 默认 false。
- claude 自主模式需真实 claude + API key;单测全部 fake spawnClaude(捕获 args / 预设 report.json),不触网。
- 已实测(2026-08-27):`claude -p` 自主工具循环 ✅、`--allowedTools "Bash(javac *)"` ✅、`acceptEdits` ✅、`--add-dir` + `Edit(//ref/**)` 只读 ✅、`--settings` 注入 PostToolUse hook ✅。

---

### Task 1: claude-client 增强(沙箱 + max-turns + hooks)

**Files:**
- Modify: `services/translation-verifier/src/claude-client.ts`
- Test: `services/translation-verifier/src/claude-client.test.ts`(追加)

**Interfaces:**
- Produces: `ClaudeClientOptions` 新增 `cwd?`、`addDirs?: string[]`、`readOnlyDirs?: string[]`、`permissionMode?: "manual" | "acceptEdits"`、`maxTurns?: number`、`hooksLogPath?: string`;`SpawnClaude` 签名扩展携带 `{ cwd?, spawn?, settingsFile? }`;`buildHooksSettings(logPath): string`(返回临时 settings 文件路径);`spawnClaudeProcess` 组装全部参数

- [ ] **Step 1: 写失败测试**(claude-client.test.ts 追加)

```ts
test("spawnClaudeProcess 组装沙箱/maxTurns/hooks 参数", async () => {
  const captured: { args: string[]; opts: { cwd?: string; settingsFile?: string } }[] = [];
  const fake = async (args: string[], _env: NodeJS.ProcessEnv, _t: number, o?: any) => {
    captured.push({ args, opts: o ?? {} });
    return { stdout: "ok", exitCode: 0 };
  };
  const sf = buildHooksSettings("/tmp/fx/hooks.json", "/tmp/fx/steps.jsonl");
  await spawnClaudeProcess(["-p", "x"], { AUTH: "k" } as any, 1000, {
    cwd: "/tmp/fx", addDirs: ["/refA", "/tmp/fx"], readOnlyDirs: ["/refA"],
    permissionMode: "acceptEdits", maxTurns: 50, settingsFile: sf, spawn: fake,
  });
  const a = captured[0].args;
  expect(a).toContain("--add-dir"); expect(a).toContain("/refA");
  expect(a).toContain("--disallowedTools"); expect(a.some((x) => x.includes("Edit(//refA/**)"))).toBe(true);
  expect(a).toContain("--permission-mode"); expect(a).toContain("acceptEdits");
  expect(a).toContain("--max-turns"); expect(a).toContain("50");
  expect(a).toContain("--settings"); expect(a).toContain(sf);
  expect(captured[0].opts.cwd).toBe("/tmp/fx");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd services/translation-verifier && npx vitest run src/claude-client.test.ts -t spawnClaudeProcess`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// claude-client.ts
export interface ClaudeClientOptions {
  // ...现有
  cwd?: string; addDirs?: string[]; readOnlyDirs?: string[];
  permissionMode?: "manual" | "acceptEdits"; maxTurns?: number; hooksLogPath?: string;
}
export type SpawnClaude = (args: string[], env: NodeJS.ProcessEnv, timeoutMs: number,
  options?: { cwd?: string; spawn?: typeof spawn; settingsFile?: string }) => Promise<{ stdout: string; exitCode: number }>;

export function buildHooksSettings(settingsPath: string, logPath: string): string {
  const content = JSON.stringify({
    hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `cat >> ${JSON.stringify(logPath)}` }] }] },
  }, null, 2);
  writeFileSync(settingsPath, content, "utf-8");
  return settingsPath;
}
// spawnClaudeProcess:args 组装见 spec §4.2;opts 透传 { cwd, settingsFile, spawn };runClaude 透传新选项。
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `cd services/translation-verifier && npx vitest run src/claude-client.test.ts && npm run test --workspace @forexplore/translation-verifier 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add services/translation-verifier/src/claude-client.ts services/translation-verifier/src/claude-client.test.ts
git commit -m "feat(translation-verifier): claude 自主会话参数(add-dir/只读/max-turns/hooks 日志)"
```

---

### Task 2: strategies 基础设施(types + workspace + 报告解析)

**Files:**
- Create: `src/strategies/types.ts`、`src/strategies/workspace.ts`、`src/strategies/report.ts`(+ 3 个 test)

**Interfaces:**
- Produces: `TestStrategy/TestStrategyJob/StrategyRunOptions/TestStrategyReport/TestStrategyRunner`(见 spec §5.1);`createWorkspace(root, strategy): { dir, cleanup, reportPath, stepsLogPath }`;`readReport<T>(dir): T`(读 report.json,缺失/非法抛带上下文错误);`parseSmokeReport/parseConsistencyResult`(复用现有校验函数)

- [ ] **Step 1: 写失败测试**(workspace + report 解析)

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**(spec §5.1/§5.2;`readReport` 支持 schema 校验可选)

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add services/translation-verifier/src/strategies
git commit -m "feat(translation-verifier): strategies 类型/工作目录/报告读取"
```

---

### Task 3: strategies 提示词 + 四方向 runner + 工厂

**Files:**
- Create: `src/strategies/prompts/{smoke-task,distinct-task}.ts`、`src/strategies/{smoke-runner,distinct-runner,aid-runner,mitgen-runner,index,helpers}.ts`(+ 5 个 test)

**Interfaces:**
- Consumes: Task 1(claude-client 增强)、Task 2(types/workspace/report)、现有 aid/mitgen 模块
- Produces: `createTestStrategy(strategy, options)`(spec §5.3);smoke/distinct runner 流程:workspace → sandbox 默认注入(source.root+target.root 只读)→ 提示词 → runClaude(hooksLogPath=stepsLogPath)→ readReport → 归一化;aid/mitgen runner 包装现有 `verifyWithVariants`/`MitGenMigratorAgent.generate`(计时/目录/报告归一化)

- [ ] **Step 1: 写失败测试**(smoke-runner:fake spawnClaude + 预设 report.json 文件断言归一化输出与 durationMs/keptDir)

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**(提示词内嵌报告 schema + 沙箱约束 + 终止条件;report.json 写入路径通过提示词告知 claude)

- [ ] **Step 4: 运行确认通过 + 回归**

- [ ] **Step 5: 提交**

```bash
git add services/translation-verifier/src/strategies
git commit -m "feat(translation-verifier): 统一策略入口与四方向 runner(自主模式)"
```

---

### Task 4: 删除 ReAct 遗留 + 目录移动 + import 修复 + quality 适配器切换

**Files:**
- Delete: `src/smoke-tools.ts` `src/smoke-proto.ts` `src/smoke-agent.ts`(+test)、`src/validator.ts` `src/consistency-verifier.ts`(+test)、`src/analyzer.ts` 中 LlmAnalyzer 方法(保留类型,剪为 `src/distinct/analyzer.ts`)
- Move: `src/smoke-types.ts` `src/smoke-prompts.ts` → `src/smoke/`;`src/analyzer.ts` → `src/distinct/`;`src/variant/` → `src/aid/`
- Modify: `src/quality/adapters/{smoke,distinct}.ts`(改调 createTestStrategy)、`src/quality/adapters/aid.ts`(variant→aid 路径)、`src/quality/types.ts` `src/quality/metrics.ts`(smoke 路径)、`src/index.ts`、`e2e/*.ts`

**Interfaces:**
- Consumes: Task 3 的 strategies 完整导出
- Produces: 新目录布局;`quality/adapters/smoke.ts` 产出 `GeneratedTest`(契约不变);`e2e` 改用新入口或删除

- [ ] **Step 1: 先改 quality/adapters/smoke.ts、distinct.ts 调用 createTestStrategy(否则删 SmokeAgent 后编译失败)**
- [ ] **Step 2: git mv + 删除遗留文件**
- [ ] **Step 3: 修其余 import(quality/types、metrics、index.ts、e2e)**
- [ ] **Step 4: tsc + 全量测试(被删模块的测试随文件删除)**
- [ ] **Step 5: 提交**

```bash
git add -A services/translation-verifier
git commit -m "refactor(translation-verifier): 删除 ReAct 遗留,四方向归入独立目录,quality 适配器切换统一入口"
```

---

### Task 5: index.ts 导出 + .gitignore + 黑盒冒烟 + 回归

**Files:**
- Modify: `src/index.ts`、`.gitignore`、`e2e/README.md`

**Interfaces:**
- Produces: 包入口导出 `createTestStrategy` 与策略类型;`test-results/` 入 .gitignore;e2e README 说明自主模式与黑盒运行方式

- [ ] **Step 1: index.ts 追加 strategies 导出,移除被删导出**
- [ ] **Step 2: .gitignore 追加 `test-results/`**
- [ ] **Step 3: 全量回归 + tsc**
- [ ] **Step 4: 真实 claude 黑盒冒烟(可选,有 key):** `npx tsx` 调 createTestStrategy("smoke") 跑一个最小任务,确认 report.json 生成、claude-steps.jsonl 有 hook 记录、报告归一化正确
- [ ] **Step 5: 提交**

```bash
git add .gitignore services/translation-verifier/src/index.ts services/translation-verifier/e2e/README.md
git commit -m "feat(translation-verifier): 包入口导出统一策略 API,忽略 test-results"
```

---

## Self-Review 记录

- Spec 覆盖:§4 claude-client → Task 1;§5.1/5.2 → Task 2;§5.3/5.4 → Task 3;§3 目录/删除 → Task 4;§6 quality → Task 4;§7 兼容 → Task 4/5;§8 测试 → 各 Task;§9 风险 → Task 5 黑盒冒烟(JDK 路径、报告解析失败兜底)。
- 类型一致性:`TestStrategyReport` 字段 Task 2 定义、Task 3/5 消费一致;`createTestStrategy(strategy, options)` Task 3 产出、Task 4/5 消费。
- 依赖顺序:Task 4 删除前,quality adapters 必须已切到 strategies(Task 3 完成后),否则编译失败——已在 Task 4 Step 1 强制顺序。
