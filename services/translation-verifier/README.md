# translation-verifier(smoke 差分翻译验证)

单次 **claude 自主会话** 的跨语言代码翻译差分验证:claude 会话读源/目标项目、设计冒烟用例、
写双侧 runner、**只经受控命令代理**(`verifier-command`——基线复查/工具白名单/最小化环境/
命令证据)真实编译运行、做机械差分 + LLM 语义裁决,最终把 `report.json`(SmokeReport)写入
agent 工作目录;宿主复查基线、读有界命令证据并做深度校验,产出 `pass/fail/unverified`。

核心定位:差分验证是**差异探测器而非绝对正确性证明**。默认模式为 **verify-only**:
- 源/目标项目快照只读,**绝不修改目标实现**(`rounds===0`、`targetFiles` 为空);
- smoke 只负责报告 `translation-bug` case,目标修复由外部工作流负责;
- 宿主验证命令执行、退出状态、工作区基线和报告结构;case 的语义 `decision` 仍由 Agent 给出;
- `AbortError`(运行中取消)原样上抛,不是可验证失败。

旧实验修复行为需要显式 `mode:"diagnostic-repair"`(仅供诊断 E2E)。

> 当前集成状态:本包提供独立 `runSmoke` API,但尚未实现并注册上游 V2
> `MigrationBehaviorVerifierV2` provider。adaptation runtime 仍如实声明 behavior verification
> disabled,因此本包当前不是 V2 生产写回门禁的一部分。

## 模块数据流

```text
runSmoke(job, { mode:"verify-only", ... }, signal)
  1. 准备或接收 caller-owned 的 source/target 快照、runner 根、agent 目录与 baseline
  2. claude cwd = agent 目录;Bash 只允许精确的 verifier-command 形态
  3. claude 写双侧 runner → 经代理编译/运行 → 写 report.json
  4. 宿主复查 baseline → assertSmokeReport 深校验 → 读取 commands.jsonl
     → evaluateSmokeReport → pass/fail/unverified
  5. 内部工作区按 keepGeneratedTests 策略清理;caller-owned 工作区由调用方管理
```

非生产小 fixture/单测输入(无 caller 工作区集)由 `runSmoke` 内部暂存到
`<workspaceRoot>/smoke-*`(同样布局 + 基线),仍只经命令代理,不保留旧的直连 Bash 路径。

## 模块清单

| 模块 | 职责 |
| --- | --- |
| `strategies/smoke-runner.ts` | `runSmoke` verify-only 编排(布局/命令代理 env/深校验/证据评估/AbortError) |
| `strategies/prompts/smoke-task.ts` | `buildSmokeTaskPrompt(input, mode)`:verify-only 与 diagnostic 模式简报 |
| `strategies/helpers.ts` | `VERIFIER_COMMAND_ENTRY`、默认目录与工具约束常量 |
| `strategies/workspace.ts` | 内部暂存工作目录(cleanup 幂等) |
| `strategies/report.ts` + `report-schema.ts` | report.json 读取 + SmokeReport 深校验(含 verify-only 约束) |
| `workspace-baseline.ts` | 请求级工作区文件基线(create/write/assert,runner 根与产物区白名单) |
| `verifier-command.ts` | 受控命令代理 CLI(cwd/基线/白名单/最小化 env/证据 JSONL/进程树回收) |
| `process-tree.ts` | `runManagedProcess` + `terminateProcessTree` + `sanitizedBuildEnvironment` |
| `smoke-evaluation.ts` | `evaluateSmokeReport` 纯判定策略(pass/fail/unverified) |
| `claude-client.ts` | claude 子进程封装(print 模式 + signal/deadline + hooks 步骤日志) |
| `logger.ts` | 零依赖日志(文件默认 INFO、content 通道默认关闭、脱敏、轮转保留 maxFiles) |

## 快速开始

```bash
# 单元测试(src 下全部 *.test.ts,含 fake-spawn 注入,不触网)
npm run test --workspace @forexplore/translation-verifier

# 类型检查/构建
npm run build --workspace @forexplore/translation-verifier

# 离线依赖 fixture 本地构建(验证命令代理能跑真实项目依赖)
mvn -q -f services/translation-verifier/e2e/fixtures/dependencies/maven/pom.xml test
dotnet build services/translation-verifier/e2e/fixtures/dependencies/dotnet/DependencyFixture.sln --nologo -v q

# smoke E2E:离线路径(自主模式无离线回放,仅打印说明退出 0)
npm run e2e --workspace @forexplore/translation-verifier -- --offline-only

# smoke E2E:真实 claude 自主会话(diagnostic-repair,需 DEEPSEEK_API_KEY 或 --api-key)
DEEPSEEK_API_KEY=sk-xxx npm run e2e --workspace @forexplore/translation-verifier -- --timeout-ms 600000

# smoke E2E:生产 verify-only(完整本地依赖 fixture 根,校验 rounds/targetFiles/runnerFiles/executions)
DEEPSEEK_API_KEY=sk-xxx npm run e2e --workspace @forexplore/translation-verifier -- --verify-only --timeout-ms 600000
```

详见 `e2e/README.md`。

## API

```ts
runSmoke(job: SmokeTaskInput, options?: SmokeRunOptions, signal?: AbortSignal): Promise<SmokeResult>
```

- `SmokeTaskInput`: `{ requirement, analysisReport?, source:{language, root?, candidatePath?, files?}, target:{language, className, method, isStatic, root?, file?} }`。
- `SmokeRunOptions`: `mode?`(默认 `"verify-only"`)/ 生产工作区集 `workspaceDir`+`executionRoot`+
  `baselinePath`+`commandEvidencePath`+`runnerRoots`(一套齐备,提供后本模块不创建/清理)/ 兼容 `workspaceRoot?`/`keepGeneratedTests?`/`maxTurns?`(50)/`apiKey?`/`model?`/`timeoutMs?`(300s)/`spawnClaude?`(测试注入)。
- `SmokeResult`: `{ status:"pass"|"fail"|"error", passRate?, summary, durationMs, report, evaluation?, errorReason? }`。
- 归一化:evaluation pass/fail → status 同值;evaluation unverified → `status:"error"` 且保留
  `evaluation`(advisory 语义);报告/证据硬失败带 `errorReason`(`invalid-report`/`invalid-evidence`/`timeout`/`toolchain`/`internal`);`AbortError` 原样上抛。

## 日志与失败产物

- 日志:文件默认 INFO(不落 prompt/源码/原始输出);`content()` 通道默认关闭,开启方式
  `VERIFIER_LOG_CONTENT=1`;写前脱敏(`redactSecrets`);超过 `maxFileBytes`(默认 10 MiB)
  轮转并只保留 `maxFiles`(默认 3)份。
- `runSmoke` 内部创建的工作区由 `keepGeneratedTests` 控制是否保留;caller-owned 工作区
  始终由调用方负责生命周期。

## 已知限制

- **可信代码本机执行**:本机执行边界不是安全沙箱;若输入信任边界改变,必须升级容器/远程隔离。
- **同命令“改-恢复”残余**:命令代理在 spawn 前/后各做一次基线复查,运行期间改动受保护
  文件的命令会被留下 `baselineValid:false` 证据并使 CLI 以非零失败——但**同一命令内先改受
  保护文件、退出前再恢复原内容**的情形无法被哈希复查发现(命令与宿主同 OS 用户运行,无
  内核级写入拦截)。
- **构建工具可访问外部依赖仓库**:结果受网络与缓存影响;失败归 unverified 并保留证据。
- **Agent 语义裁决**:宿主确认命令真实成功并校验报告/基线,但目前不会从 stdout
  独立重算每个 case 的机械差分;`decision` 仍由 Agent 产生,不能作为绝对正确性证明。
- **runner 质量依赖 LLM**:编译失败/caseId 不一致由 claude 在会话内自查修复(仅 runner)。
- 单次自主会话耗时分钟级,`timeoutMs` 请按需放大(默认 300s)。
