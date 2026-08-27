# translation-verifier 四方向模块化 + claude 自主模式 设计文档

- 日期：2026-08-27(rev.3：四方向全部 claude 自主模式，保留核心算法方法)
- 分支：feat/translation-verifier-optimize
- 范围：`services/translation-verifier/`（npm workspace `@forexplore/translation-verifier`）

## 1. 背景与目标

当前 `src/` 根目录混放四个方向的测试模块，且 smoke/distinct 采用"LLM 每轮决策 + 代码执行工具"（ReAct 循环）模式：claude 只输出动作 JSON，读写/编译/运行/比较由我们的 `SmokeTools`/`analyzer` 代码完成。问题：逻辑分散、`maxSteps` 轮次内多次 LLM 调用、架构复杂。

目标（rev.2）：

1. 四个方向各自归入独立文件夹，公共基础留在 `src/` 根；
2. **四方向全部改为 claude 自主模式**：一次 claude 调用，claude 自己用内部工具（Read/Write/Edit/Bash）在指定目录内完成看文件→写测试/改代码→编译→运行→比较→修复→写报告；不同策略只配置不同提示词与沙箱；
3. **保留核心算法方法为代码模块**：aid 的变体生成/共识计算/输入生成器执行、mitgen 的 AST 解析/片段提取/插桩等纯代码与确定性逻辑保留（不删除）；作为预处理器或可复用工具接入自主流程；
4. 新增统一策略入口（`src/strategies/`），`TestStrategy` 枚举 + 工厂，报告归一化 + 单次耗时；
5. claude 沙箱：只读参考目录（索引仓库/翻译仓库）+ 可写工作目录（测试结果）；
6. **日志系统**：hook 记录 claude 每一步工具调用（工具名/输入/输出/耗时）；
7. 报告经 `report.json` 文件产出，删除遗留 ReAct 代码。

## 2. 已验证的技术前提（2026-08-27 实测）

| 能力 | 验证结果 |
| --- | --- |
| `claude -p` 自主多步工具循环 | ✅ claude 自主规划并依次调用 Write/Bash/Read |
| `--allowedTools "Bash(javac *)" "Bash(java *)"` 白名单 | ✅ 放行编译/运行命令 |
| `--permission-mode acceptEdits` 放行文件编辑 | ✅ |
| `--add-dir` + `--disallowedTools "Edit(//ref/**)"` 只读参考目录 | ✅ |
| `--settings <临时文件>` 注入 PostToolUse hook | ✅ 每次工具调用输出结构化 JSON 行（tool_name/tool_input/tool_response/duration_ms） |

## 3. 目录结构（rev.3：四方向自主模式）

```
src/
├── smoke/        ← 方向1：仅保留 smoke-types.ts（报告契约）+ smoke-prompts.ts（自主任务提示词）
├── distinct/     ← 方向2：仅保留 analyzer 的类型定义（BranchInventory/ConsistencyReport 等）
├── aid/          ← 方向3：由 variant/ 改名；保留核心（变体生成/共识/输入生成器/过滤），自主编排
├── mitgen/       ← 方向4：保留核心（片段提取/打分/插桩），自主编排
├── quality/      ← 阶段2 评估框架（适配器改调用方式，指标计算不变）
├── strategies/   ← ★ 新增：统一入口层（types/workspace/prompts/runners/claude 会话封装）
└── 根保留公共基础：description.ts / test-migrator.ts / verifier.ts / comparator.ts /
    executor.ts / driver/ / repair-loop.ts / claude-client.ts / logger.ts /
    code-utils.ts / llm-json.ts / bug-injection.ts / result-capture.ts / cli.ts / cli-helpers.ts
```

**删除**（用户确认）：`smoke-tools.ts`、`smoke-proto.ts`、`smoke-agent.ts`（ReAct 循环）及其测试；`analyzer.ts` 中 LlmAnalyzer 的 LLM 方法、`validator.ts`、`consistency-verifier.ts` 及其测试。
**保留类型与核心方法**：
- `smoke-types.ts` 的 `SmokeReport`（报告契约）；`analyzer.ts` 的 `BranchInventory`/`ConsistencyReport` 等类型；
- aid：`VariantGeneratorAgent`（变体生成，LLM 单次调用保留）、`variant-filter.ts`（同语言差分过滤）、`consensus.ts`（共识计算纯函数）、`input-generator.ts`（输入生成器脚本执行）——保留，供 claude 自主流程预生成/校验复用；
- mitgen：`fragment-extractor.ts`（AST/文本级片段提取，纯函数，作为预处理器）、`fragment-prioritizer.ts`（打分排序）、`splicer.ts`（插桩回射）——保留。

## 4. claude 自主会话封装（`claude-client.ts` 增强）

### 4.1 `ClaudeClientOptions` 新增

```ts
cwd?: string;                          // 子进程工作目录
addDirs?: string[];                    // --add-dir（可读写目录）
readOnlyDirs?: string[];               // --disallowedTools "Edit(//dir/**)"（只读参考）
permissionMode?: "manual" | "acceptEdits";
maxTurns?: number;                     // --max-turns 轮次上限
hooksLogPath?: string;                 // PostToolUse hook 追加日志文件路径
```

### 4.2 `spawnClaudeProcess` 参数组装

```
args = [-p, prompt, --output-format, text]
     + (addDirs)            --add-dir <...>
     + (readOnlyDirs)       --disallowedTools Edit(//<resolve(dir)>/**) ...
     + (permissionMode==="acceptEdits")  --permission-mode acceptEdits
     + (maxTurns)           --max-turns <N>
     + (hooksLogPath)       --settings <临时settings文件>
opts = { cwd, env, stdio }
```

### 4.3 hooks 日志（`hooksLogPath`）

调用方（strategies）创建临时 settings 文件：

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "cat >> <hooksLogPath>" } ] }
    ]
  }
}
```

每次工具调用追加一行 JSON：`{ session_id, cwd, hook_event_name, tool_name, tool_input, tool_response, duration_ms, ... }`。
日志文件位于工作目录内（`<workspace>/claude-steps.jsonl`），与 report.json 一起随保留策略保留/删除。

## 5. 统一策略入口（`src/strategies/`）

### 5.1 类型

```ts
export type TestStrategy = "smoke" | "distinct" | "aid" | "mitgen";

export interface TestStrategyJob {
  requirement: string;
  source: { language: VerifierLanguage; files?: SideFile[]; root?: string };
  target: { language: VerifierLanguage; className: string; method: string; isStatic: boolean; root?: string; file?: string };
}

export interface StrategyRunOptions {
  keepGeneratedTests?: boolean;        // 默认 false
  workspaceRoot?: string;              // 默认 <项目根>/test-results
  claudeSandbox?: { readOnlyDirs: string[]; writableDir?: string };
  maxTurns?: number;                   // 默认 50
  apiKey?: string; model?: string; timeoutMs?: number;
}

export interface TestStrategyReport {
  strategy: TestStrategy;
  status: "pass" | "fail" | "unverified" | "error";
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

### 5.2 工作目录布局（`strategies/workspace.ts`）

```
<workspaceRoot>/<strategy>-<YYYYMMDD-HHmmss>-<rand>/
├── report.json           ← claude 写的最终报告（读取解析）
├── claude-steps.jsonl    ← hook 记录的每步工具调用日志
└── ...（claude 自主生成/修改的源码/测试/编译产物）
```

- `createWorkspace(root, strategy)` → `{ dir, cleanup }`；`keepGeneratedTests=false` 时 cleanup 递归删除。

### 5.3 runner（四个全部 claude 自主模式）

**统一流程**（`smoke-runner.ts` / `distinct-runner.ts` / `aid-runner.ts` / `mitgen-runner.ts`）：

1. `createWorkspace` → 工作目录（作为 `writableDir`）；
2. **预处理器（可选，按策略）**：
   - mitgen：代码先 `extractFragments(sourceCode)` → 片段清单写入提示词（claude 基于片段定向生成测试）；
   - aid：代码预生成变体文件（`VariantGeneratorAgent`，保留）写入工作目录 `variants/`（claude 在其上编译/差分/共识）；
3. 组装 `claudeSandbox`：`readOnlyDirs` = job.source.root + job.target.root（默认注入），`writableDir` = 工作目录；
4. 构建自主任务提示词（策略专用：任务说明 + 约束 + 报告 schema + "把结果 JSON 写入 report.json" + 保留工具的用法说明）；
5. 调用 `runClaude(prompt, { cwd: writableDir, addDirs: [readOnlyDirs..., writableDir], readOnlyDirs, permissionMode: "acceptEdits", maxTurns, hooksLogPath })`；
6. 读取 `<workspace>/report.json` → 解析校验 → 归一化 `status/passRate/summary/durationMs`；
7. `keepGeneratedTests=false` → cleanup。

**保留的代码方法定位**：预处理器（mitgen 片段提取、aid 变体生成）在调用 claude 前由我们的代码运行，产物进入工作目录/提示词；共识计算、片段打分等纯函数保留为代码库导出（供校验/未来复用），不删除。claude 自主负责：读写文件、编译运行、差分比较、修复、写报告。

### 5.4 提示词（`strategies/prompts/`）

- `smoke-task.md`：冒烟验证任务（读源→写 runner→双侧编译运行→差分比较→judge→必要时修复→写 report.json）；
- `distinct-task.md`：分支一致性任务（生成测试→试编译修复→分支分析→按需求修正断言→写 report.json）；
- 每个提示词内嵌：报告 JSON schema（SmokeReport / ConsistencyResult）+ 沙箱约束声明（只读参考目录、仅在工作目录写）+ 工具白名单说明（可用的 Bash 命令）+ 终止条件（写完 report.json 即结束）。

## 6. quality 评估框架适配

- 机制确认（混合）：**生成**走各适配器；**Conformance 一维是 LLM 三态评审**（`judgeConformance`，单次调用）；**Detection/CSR/误报率是纯代码计算**（差分）。
- 四个方向适配器（`smoke`/`distinct`/`aid`/`mitgen`）全部改为调用统一策略入口（自主模式），产出契约不变（SmokeReport / ConsistencyResult / AIDVerificationReport / MitGenResult）；
- `quality/adapters/baseline.ts`、`quality/metrics.ts`、`quality/evaluate.ts`：**不改**（baseline 用 TestMigratorAgent 单次 LLM 生成描述，非自主循环）。

## 7. 兼容与删除清单

| 动作 | 文件 |
| --- | --- |
| 移动 | `smoke-*` → `src/smoke/`（仅 types/prompts 保留） |
| 移动 | `analyzer.ts`（类型部分）→ `src/distinct/` |
| 改名 | `src/variant/` → `src/aid/` |
| 删除 | `smoke-tools.ts` / `smoke-proto.ts` / `smoke-agent.ts`（+ 对应 test）；`validator.ts` / `consistency-verifier.ts`（+ test）；`analyzer.ts` 的 LlmAnalyzer 方法 |
| import 更新 | `src/quality/adapters/{smoke,distinct,aid}.ts`、`src/quality/types.ts`、`src/quality/metrics.ts`、`src/index.ts`、`e2e/*.ts` |
| 新增导出 | `TestStrategy` / `TestStrategyJob` / `TestStrategyReport` / `TestStrategyRunner` / `createTestStrategy` |
| 新增 | `.gitignore` 忽略 `test-results/` |

`index.ts` 现有导出签名保持（消费方 `adaptation-service` 零改动）；被删除模块的导出（`SmokeAgent`/`runConsistencyVerification`/`DescriptionValidator` 等）从 index.ts 移除。

## 8. 测试与验证

- 单测（vitest，fake spawnClaude 捕获 args/输出）：
  - claude-client：沙箱参数组装（add-dirs/readOnlyDirs/maxTurns/hooks settings 生成）；
  - strategies：提示词构建（断言任务/约束/report schema 出现）、report.json 解析校验、归一化（status/passRate/durationMs）、workspace 创建/清理/保留；
  - quality 适配器：fake 模式（自主模式黑盒，注入预设 report.json）。
- e2e：真实 claude 黑盒集成（手动/可选，`npx tsx e2e/run-<strategy>-e2e.ts --strategy smoke` 等）；
- 回归：`npm run test --workspace @forexplore/translation-verifier` 全绿。

## 9. 风险与开放问题

- **成本/不稳定**：claude 自主循环 token 消耗大、行为不可枚举；以 `--max-turns` + 超时兜底，失败按 `status: "error"` 记录。
- **JDK 定位**：实测 claude 子进程报 "Unable to locate a Java Runtime"（父进程 PATH 有 javac）——实施时在提示词中要求使用全路径（`/usr/bin/javac` 或 `$JAVA_HOME/bin/javac`）并注入 `JAVA_HOME` 环境变量。
- **报告解析失败**：report.json 缺失/非法时按 `status: "error"` + summary 记录原因，不抛未捕获异常。
- **离线测试**：fixture 应答序列机制失效，改为黑盒 + 预设 report.json 注入。
- **hooks settings 合并**：`--settings` 与用户级 settings 合并行为以实测为准（已验证可注入 hook）。
- **不做**（YAGNI）：CLI 统一入口；目录级读写分离持久化（每次会话 CLI 注入）。
