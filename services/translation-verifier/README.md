# translation-verifier(差分翻译验证器)

自动化评估代码翻译的**行为一致性**,并在不一致时通过反馈修复闭环自动收敛。

核心定位:差分验证是**差异探测器而非裁判**——两侧行为不一致不等于目标侧错(可能是源侧历史缺陷),
判定以**用户需求**为准。

## 架构

```
用户需求 ──► 候选检索(上游混合检索服务 /v1/search) ──► 语言无关测试描述(JSON)
              │                                                │
              ▼                                                ▼
        源侧驱动执行(A)  ◄── 描述 ──►  目标侧驱动执行(B)
              │                       (Java/C# 生成器 + javac/dotnet)
              ▼                       │
         ┌────────────────────────────┘
         ▼
    差分一致性检查器(差异探测器)
     ├─ 两侧一致 → PASS
     └─ 不一致 → 需求裁决(requirementVerdict):
         ├─ 目标侧符合需求 → target-conforms(源侧偏离需求,记录后放行)
         └─ 目标侧也偏离 → target-diverges(进入修复闭环)
              │
              ▼
        反馈修复 Agent(claude 子进程)──► 重新翻译 ──► 重新验证(≤3 轮)
```

- **检索与迁移分离**:候选检索由上游混合检索服务 `POST /v1/search` 完成(向量+全文+RRF+rerank);
  agent 按 path 从语料读完整方法体;**测试自寻**(测试不在索引)由 agent 在同仓库内文件搜索。
  本模块只接收整理好的纯输入,不做任何检索/提取。
- **需求第一**:用户需求是最高优先级;源码/测试仅作参考实现,冲突以需求为准,不继承源码缺陷。
- **LLM 调度统一 claude 子进程**("Claude Code + DeepSeek" 架构,与 `scripts/run-claude-deepseek.sh` 一致),
  不直接调用 DeepSeek HTTP API。

## 模块清单

| 模块 | 职责 |
| --- | --- |
| `description.ts` | 语言无关测试描述类型 + 校验 + canonical 规范化 |
| `driver/` | Java / C# 目标驱动，以及 Python / TypeScript 源侧驱动(确定性 JSON 输出) |
| `executor.ts` | javac / dotnet / python3 / tsc+tsx 编译 + 运行(可注入 fake) |
| `comparator.ts` | 差分比较器(数值容差 / 跨语言异常等价类 / 语义集合比较) |
| `verifier.ts` | 双轨道验证编排 + 量化报告 + 需求裁决(`requirementVerdict`) |
| `test-migrator.ts` | 测试迁移 Agent(需求第一,生成语言无关描述) |
| `mitgen/` | MitGen 微观测试生成(片段级):片段划分/排序/定向输入生成/插桩可达性验证/目标侧对应检查 |
| `code-utils.ts` | 轻量源码词法工具(matchingBrace/skipQuoted/escapeRegExp,零依赖) |
| `llm-json.ts` | LLM 输出 JSON 解析(stripFences/extractJson/coerceTypedValue) |
| `repair-loop.ts` | 反馈修复闭环(诊断携带需求判据,≤3 轮) |
| `claude-client.ts` | claude 子进程 LLM 封装(可注入 `spawnClaude`) |
| `logger.ts` | 零依赖日志系统(文件 DEBUG 全量 + 控制台分级;默认写 monorepo 根 `logs/`) |
| `cli.ts` | CLI 编排入口 |
| `quality/` | **统一测试质量评估框架**(接口 + 五维指标 + 五个生成器适配器 + CLI,见下文) |
| `strategies/` | **四方向 claude 自主会话统一入口**(工厂 + runner + 工作区 + 提示词,见下) |
| `e2e/` | E2E 验收脚本 + fixtures(验证机制 / 注入 bug / 修复闭环演示) |

## 四方向自主策略(统一入口 `strategies/`)

spec §5:四个测试方向(smoke / distinct / aid / mitgen)全部改为 **claude 自主会话(黑盒)**——
单次 claude 调用,由 claude 在隔离工作目录内自行完成读写代码、编译运行、差分分析、修复与
报告落地,控制器不再逐轮编排(ReAct 遗留代码 Task 4 已删除)。

```
createTestStrategy(strategy, { llm, keepGeneratedTests, workspaceRoot, claudeSandbox, maxTurns })
  └─ runner.run(job) → TestStrategyReport
        ├─ workspace: <packageRoot>/test-results/<strategy>-<ts>-<rand>/(report.json + claude-steps.jsonl)
        ├─ 沙箱: 参考目录只读(readOnlyDirs)、工作目录可写(cwd)
        ├─ hooks: PostToolUse 逐行追加工具调用日志 → claude-steps.jsonl
        └─ 归一化: status = pass / fail / unverified / error(报告缺失/非法 → error + summary 原因);
           keepGeneratedTests=true 时保留工作目录(keptDir),否则 cleanup 删除
```

| 方向 | 报告 detail | 说明 |
| --- | --- | --- |
| smoke | `SmokeReport` | 冒烟用例 + 机械差分 + LLM 语义裁决 + 目标修复闭环 |
| distinct | `ConsistencyResult` | 分支清单 + case 级 NLD 三态裁决(augmentation 并入重验) |
| aid | `AIDVerificationReport` | 变体参考组 + 共识 oracle + 目标差分 |
| mitgen | `MitGenResult` | 片段级微观测试(打分 + 定向输入 + 源侧实跑验证) |

- 入口 `createTestStrategy`(src/strategies/index.ts)与类型(`TestStrategyJob` / `TestStrategyReport` /
  `StrategyRunOptions` / `StrategyStatus`)经 `src/index.ts` 统一导出;`ConsistencyResult` 类型保留于
  `src/distinct/consistency-verifier-types.ts` 并同样从包入口导出;
- quality 五个生成器适配器已切换到该入口(smoke/distinct/aid/mitgen 四适配器,见下;baseline 保留
  TestMigratorAgent);真实黑盒验证见 `e2e/README.md`(smoke 管线一节,2026-08-27 冒烟实测);
- `test-results/` 已加入 .gitignore(默认工作区根 `<packageRoot>/test-results`)。

## AID 变体轨道(方向 3,LLM + 差分测试)

> 对应论文 *LLM-Powered Test Case Generation for Detecting Tricky Bugs*(AID / TrickCatcher,ACL 2025)。
> 设计文档:`.superpowers/sdd/4-test-methods/test-aid/design.md`。

现有 `verify` 双轨是「源侧 A vs 目标侧 B」单参考差分(依赖 description 手写/LLM 列举的固定输入与
`expected` 黄金值)。**变体轨道**在此基础上叠加一条平行验证线:oracle 从**行为差异**派生,不依赖
LLM 单点推理生成的 expected。三步法(论文核心):

1. **PUT-guided 变体生成**:LLM 基于「需求 + 源方法 + 目标契约」生成 N 个源语言替代实现
   (`variantCount`,默认 3);用基础输入集做**同语言差分**过滤(与源方法行为一致才保留);
2. **Generator-based 输入生成**:LLM 写 TS 输入生成器脚本(把逻辑与计算分离),批量产出
   `TypedValue` 输入(默认 50),与 description 基础 cases 合成为「扩展 description」一次编译一次运行;
3. **多样性优先差分**:参考组 `{源} ∪ {保留变体}` vs C# 目标,oracle 由规则 R0 构造
   (不采用多数投票 —— 相似缺陷会污染多数):参考组全一致 → 共识比较;参考组分歧且目标 ∉ 参考输出集
   → fail(高置信);目标 ∈ 参考输出集 → disputed(低置信,复用 divergent 枚举 + details 标注);
   k-共识辅助(≥2 参考一致且与目标相悖 → fail,对应论文 DFP 触发)。

### 模块清单(`src/aid/`)

| 模块 | 职责 |
| --- | --- |
| `prompts.ts` | 三个提示词模板(变体生成 / 输入生成器;借鉴 TrickCatcher PromptTemplates) |
| `variant-generator.ts` | `VariantGeneratorAgent`:生成 N 个源语言变体(类名改写 `Variant_<k>`、package 剥离、重试 ≤2) |
| `variant-filter.ts` | `filterVariants`:基础输入集 + 同语言差分过滤(编译失败/行为不一致剔除) |
| `input-generator.ts` | `InputGeneratorAgent` + `runInputGenerator`(TS 脚本执行 / 校验 / 去重 / 多样性采样)+ `toBatchDescription` |
| `consensus.ts` | `buildConsensus` / `compareAgainstConsensus`:规则 R0(含相似缺陷污染反例测试) |
| `aid-verifier.ts` | `verifyWithVariants`:变体 → 过滤 → 输入 → 差分 → `AIDVerificationReport` |

与现有双轨的关系:`verifier.ts` 仅提取了 `executeSide` 公共辅助(行为不变,现有测试全绿);
`verify` 语义零改动。`AIDVerificationReport` 独立于 `VerificationReport`,含变体清单、oracle
置信度、consensus-vs-expected 冲突标注。

### AID E2E 用法

```bash
# 离线验收(无 key:fixture 变体 + fixture 输入生成器,真实 javac/dotnet)
DEEPSEEK_API_KEY= npx tsx services/translation-verifier/e2e/run-e2e-aid.ts \
  --requirement "解码 MIME 编码文本,非编码文本原样返回" \
  --source-method services/translation-verifier/e2e/fixtures/samples/mime-util-source.cs \
  --target-file services/translation-verifier/e2e/fixtures/samples/mime-util-target.java

# 有 key:追加阶段 C 真实 LLM 变体 + 输入生成器(演示,不影响退出码)
npx tsx services/translation-verifier/e2e/run-e2e-aid.ts --requirement "..." --source-method ... --target-file ...
```

退出码:0=确定性验收全 PASS(阶段 A 干净目标无 fail、阶段 B off-by-one 注入被 AID 检出);
1=阶段 A/B 验收 FAIL;2=参数/运行错误。阶段 B 输出检出率指标矩阵
(`baselineDetectionRate` / `aidDetectionRate` / `detectionGain` / `falsePositiveRate` /
`oracleAgreement` / `variantPassRate`,见设计文档 5.3)。

### 已知限制(变体轨道)

- 仅适合**纯函数式方法**(与现有验证器一致);`entryKind: "constructor"` 场景本期不支持(设计 R6);
- 一期不做严格输入有效性校验(EvalPlus 式 contract 校验;设计 R4),非法输入可能让参考组与目标
  「一致地异常」或「一致地错」;
- 真实 LLM 变体可能趋同(设计 R1)或继承源缺陷(设计 R5):AID 报告中的 consensus-vs-expected
  冲突列表供人工复核;二期可与方向 2(DISTINCT)的 NLD 锚定协作;
- 跨语言异常别名表缺 Java `IllegalCharsetNameException`(真实 LLM 输入含非法字符集名时会产生
  跨语言噪声 fail)—— 记录待二期补全别名表。

## 快速开始

```bash
# 单元测试
npm run test --workspace @forexplore/translation-verifier

# E2E 验收(无 key:fixture 描述 + 真实 javac/dotnet 验证机制)
DEEPSEEK_API_KEY= npx tsx services/translation-verifier/e2e/run-e2e.ts \
  --requirement "解码 MIME 编码文本,非编码文本原样返回" \
  --source-method services/translation-verifier/e2e/fixtures/samples/mime-util-source.cs \
  --target-file services/translation-verifier/e2e/fixtures/samples/mime-util-target.java \
  --source-lang C# \
  --target-class org.apache.commons.fileupload.util.mime.MimeUtility \
  --target-method decodeText

# E2E 验收(有 key:真实 TestMigrator 生成描述 + 修复闭环)
npx tsx services/translation-verifier/e2e/run-e2e.ts --requirement "..." \
  --source-method ... --target-file ... --source-lang C# \
  --target-class ... --target-method ... --timeout-ms 300000
```

E2E 三阶段:①验证翻译产物(差分 + 需求黄金校验)→ ②注入 bug 演示检出 FAIL → ③修复闭环
(RepairLoop + RepairAgent)收敛。退出码:全部 PASS=0;有 FAIL=1;参数/运行错误=2。

## MitGen(片段级微观测试生成)

`--generator mitgen` 切换描述生成器为 `MitGenMigratorAgent`(与 `TestMigratorAgent` 平级,
输出 schema 兼容 `TestDescription`,verifier/comparator/driver/executor 零改动):

- **片段划分**(`mitgen/fragment-extractor.ts`):把源方法轻量词法分解为 guard/分支/循环/switch-case/return
  等片段(零依赖,Java/C# 优先,Python/TS best-effort),每个片段带 `pathCondition`(通往该片段的路径条件)
  与启发式特征;直线方法/定位失败退化为整方法单片段。
- **片段选择**(`mitgen/fragment-prioritizer.ts`):启发式预筛 + LLM 单次批量打分(CamPri 简化版),
  排序键 = w1·风险 + w2·可修复性 + w3·启发式分(默认 0.5/0.3/0.2,可注入),选 Top-K。
- **片段级生成 + 回射**(`mitgen/mitgen-migrator.ts` + `mitgen/splicer.ts`):对每个选中片段,
  LLM 受 pathCondition 引导生成整方法输入(不需推理输出)→ 在源方法副本的片段位置前插桩 marker
  (`mitgen/splicer.ts` 纯字符串操作,单语句分支自动包块保持语义)→ 用现有 source driver 实跑,
  解析 marker 序列验证可达性并**录制 expected(源侧实跑即 ground truth,规避 LLM 写 expected 不可靠)**;
  不可达输入反馈 LLM 重试 1 次,仍失败丢弃。最后做目标侧片段对应检查(correspondence,只进报告不进 verdict)。
- 预期成本:每方法 LLM 调用 ≈ 1 次打分 + F 次输入生成 + 重试 + 1 次对应检查(F=选中片段数)。

```bash
# MitGen 端到端(需 DEEPSEEK_API_KEY);--branch-bug 追加「分支级 bug 注入 + MitGen 检出」演示
npx tsx services/translation-verifier/e2e/run-e2e.ts --requirement "..." \
  --source-method ... --target-file ... --source-lang C# \
  --target-class ... --target-method ... --generator mitgen --branch-bug --timeout-ms 300000
```

已知限制:片段级 expected 由源侧实跑录制,若源侧实现自身偏离需求(如字符集支持差异),
录制结果会固化源侧行为——与现有管线一致,由 `requirementVerdict` 黄金校验兜底改判;
correspondence 仅进报告,差分结果仍是权威裁判。

## CLI 用法

```bash
npx tsx services/translation-verifier/src/cli.ts \
  --description <描述.json> --source <源目录> --target <目标目录> \
  [--method-file <目标类型相对路径>] [--max-rounds 3] [--json] \
  [--requirement <需求文本>] [--api-key <key>] \
  [--source-module <Python模块或TS相对路径>] [--source-class <类名>] \
  [--source-method <方法名>] [--source-instance]
```

- `--description` / `--source` / `--target` 必填;`--requirement` 缺失时描述须自带(需求第一)。
- 源目录只含一种 `.java`、`.cs`、`.py` 或 `.ts` 时自动识别语言；Python/TypeScript 必须提供
  `--source-module`，类方法再提供 `--source-class`，模块级函数可省略类名。
- `TestDescription.target.language` 仍只支持 Java/C#；Python/TypeScript 是源侧执行适配器，不会改变目标翻译契约。
- 翻译由 agent 在调度时完成,CLI 不做 LLM 调用。

## 统一测试质量评估框架(`src/quality/`)

> 接口规范:`/.superpowers/sdd/4-test-methods/quality/quality-spec.md`。

对五个测试生成器(baseline / smoke / distinct / aid / mitgen)在同一数据集上做**统一五维评估**:

| 指标 | 定义 | 度量方式 |
| --- | --- | --- |
| **CSR 编译通过率** | 生成测试能否编译 | 描述型:描述→驱动→`executor.compile`;runner 型:runner 文件→compile |
| **Conformance** | expected 与**需求**一致(而非检索代码) | LLM 三态评审 `conforms/diverges/unverified`(需求+差异标注+检索代码+测试) |
| **检出率** | 注入 bug 后能否检出 | 复用 `bug-injection.ts` 四策略;描述型=目标偏离需求黄金值;runner 型=机械差分。报告同时列出 attempted / eligible / injection-failed / unverified，rate 只以 eligible 为分母 |
| **误报率** | 干净翻译不误报 | 同检出流程但不注入(描述型以 `requirementVerdict=target-diverges` 为准) |
| **成本** | 每方法 LLM 调用次数 | 计数 spawnClaude 包装统计(含重试) |

### 模块与适配器

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `QualityTask` / `GeneratedTest` / `GeneratorAdapter` / `QualityMetrics` / `DatasetEntry`(接口规范 2.1/2.2) |
| `dataset.ts` | 数据集加载校验 + `buildTask`(Java 源侧自动收集 maven 项目全部源文件) |
| `adapters.ts` | 适配器注册表 + `countedClaude`(成本统计) |
| `adapters/baseline.ts` | `TestMigratorAgent` → 描述 |
| `adapters/smoke.ts` | `createTestStrategy("smoke")` 自主会话(读码→runner→差分→裁决→修复)→ SmokeReport;产出 runner(取自 detail.targetFiles / keptDir) |
| `adapters/distinct.ts` | baseline 描述 + `createTestStrategy("distinct")` 分支一致性 → ConsistencyResult → flag-fail 信号 |
| `adapters/aid.ts` | `verifyWithVariants` 变体轨道 → 冻结 clean oracle；`detectOnTarget` 仅重放注入目标，避免随机变体或输入污染检出率 |
| `adapters/mitgen.ts` | `MitGenMigratorAgent` 片段级微观生成(源侧实跑录制 expected) |
| `metrics.ts` | CSR / conformance 三态评审 / 检出率 / 误报率 / 成本 |
| `evaluate.ts` | 编排(quick=抽样+1 策略 / full=全部+4 策略)+ 聚合 |
| `cli.ts` | CLI 入口 |

### CLI 用法

```bash
# 真实运行(需 DEEPSEEK_API_KEY 或 --api-key;javac/dotnet 工具链)
npx tsx services/translation-verifier/src/quality/cli.ts \
  --dataset services/translation-verifier/src/quality/dataset/sample.json \
  --adapters baseline,smoke,distinct,aid,mitgen --quick

# JSON 输出 / 跳过 conformance 评审(离线跑 CSR/检出率/误报率)
npx tsx services/translation-verifier/src/quality/cli.ts \
  --dataset <数据集.json> --adapters baseline,distinct --full --json --skip-conformance
```

- `--quick`(默认):等距抽样 `--sample-size N`(默认 5)个 entry + 1 个注入策略(默认 off-by-one);
  `--full`:全部 entry + 4 策略(fixed-value / off-by-one / condition-flip / constant-wrong);
- 缺 `DEEPSEEK_API_KEY` 时 CLI 明确报错退出(不静默崩溃);单测/离线验证注入 fake spawnClaude + FakeDriverExecutor;
- 描述型适配器在评估前会把描述 target 对齐到数据集 entry 的签名(类/方法/静态/构造参数);
- smoke 适配器需要磁盘上的源/目标文件(`--root` 解析 entry 文件路径,默认自动探测仓库根)。

### 语义要点(数据集「需求 R ≠ 检索代码 S」设计)

差分 fail 本身不等于检出——正确实现需求的翻译在 R/S 分歧点上**合法偏离**检索代码。因此描述型
检出/误报以「目标是否偏离需求黄金值(expected)」为信号(`requirementVerdict=target-diverges` 或黄金
改判 fail),而非原始差分 fail;smoke runner 型以「干净目标 vs 注入目标」的机械差分隔离注入 bug。

## 语言无关测试描述(schema v1.0)

```jsonc
{
  "schemaVersion": "1.0",
  "requirement": "解码 MIME 编码文本(=?charset?B?..?= 与 =?charset?Q?..?= 形式),非编码文本原样返回",
  "target": {
    "language": "Java",
    "className": "org.apache.commons.fileupload.util.mime.MimeUtility",
    "method": "decodeText",
    "isStatic": true,
    "constructorArgs": []
  },
  "cases": [
    {
      "id": "encoded-b",
      "description": "B 编码 base64 解码",
      "inputs": [{ "type": "string", "value": "=?UTF-8?B?aGVsbG8=?=" }],
      "expected": { "kind": "return", "value": { "type": "string", "value": "hello" } }
    },
    {
      "id": "invalid-input",
      "inputs": [{ "type": "string", "value": "invalid" }],
      "expected": { "kind": "exception", "type": "IllegalArgumentException", "messageContains": "..." }
    }
  ]
}
```

`TypedValue` 支持 `string | number | boolean | null | list | map`(带 `type` 标签,驱动生成确定性字面量)。

## 日志

零依赖(仿 ReCodeAgent):文件 `logs/translation-verifier.log`(DEBUG 全量,追加)+ 控制台按
`VERIFIER_LOG_LEVEL`(默认 INFO)。级别分层:info=阶段/生命周期,debug=prompt 全文/输出,error=异常。
环境变量:`VERIFIER_LOG_DIR`(默认 monorepo 根 `logs/`,与 cwd 无关)、`VERIFIER_LOG_LEVEL`。

## 已知限制

- 真实分支覆盖率(需要 JaCoCo / dotnet-coverage 插桩)尚未接入,报告 `coverage` 字段预留。
- 状态路径(state path)深度支持受限:本期 expected 支持 return / exception;对象内部状态可通过
  getter 以 return 形式断言。
- Java/C# 源侧默认沿用描述中的类名/方法名；Python/TypeScript 可通过源侧参数显式指定模块、类和方法。
- 修复闭环面向 Java 目标方向;无 `DEEPSEEK_API_KEY` 时跳过修复演示。
- `ignoreMessageSubstrings` 当前为预留选项(默认不比较异常消息)。
