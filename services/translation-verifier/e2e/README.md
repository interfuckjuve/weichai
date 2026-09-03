# translation-verifier E2E 验收脚本

本目录唯一验收入口:`run-smoke-e2e.ts`(**smoke 差分管线**)——单次 claude 自主会话黑盒。
旧 schema 管线/变体轨道脚本与对应夹具已随无关模块清理移除。

## 模式

脚本有两种显式模式,避免把诊断修复行为误用于生产:

| 模式 | 标志 | 语义 |
| --- | --- | --- |
| `diagnostic-repair` | (默认) | 样本 fixture(MimeUtility C#→Java);允许报告目标修复轮(`rounds>0`)供诊断实验 |
| `verify-only` | `--verify-only` | **生产语义**:完整本地依赖 fixture 根(source=C# 项目,target=Java 项目);宿主强制 `rounds===0`、`targetFiles` 为空、双侧 runnerFiles 与编译/运行执行证据齐全,否则退出码 1 |

## 生产 verify-only 校验不变量

- `rounds === 0`(目标实现从未被修改);
- `targetFiles.length === 0`;
- `cases` 非空;
- `runnerFiles` 同时包含 `source` 与 `target`;
- `executions` 非空(每条 `commandId` 都必须在 `commands.jsonl` 中可查到真实代理执行)。

## fixtures

| 文件 | 内容 |
| --- | --- |
| `fixtures/smoke-mime-util/requirement.txt` | 诊断样例需求原文 |
| `fixtures/samples/mime-util-source.cs` | C# 源侧样本 |
| `fixtures/samples/mime-util-target.java` | Java 目标侧样本 |
| `fixtures/dependencies/maven/**` | Maven reactor fixture(父 POM + `library`/`app` sibling 模块;app 依赖 `fixture:library`) |
| `fixtures/dependencies/dotnet/**` | .NET solution + `Library`/`App`(App 通过 `ProjectReference` 引用 Library) |

离线本地构建(验证命令代理能跑真实项目依赖,无需公网):

```bash
mvn -q -f services/translation-verifier/e2e/fixtures/dependencies/maven/pom.xml test
dotnet build services/translation-verifier/e2e/fixtures/dependencies/dotnet/DependencyFixture.sln --nologo -v q
```

## 用法(仅真实 claude 黑盒路径)

```bash
# 默认样例:diagnostic-repair(MimeUtility.DecodeText C# → Java)
DEEPSEEK_API_KEY=sk-xxx npx tsx services/translation-verifier/e2e/run-smoke-e2e.ts

# 显式指定 fixture 目录 / 加大超时
npx tsx services/translation-verifier/e2e/run-smoke-e2e.ts \
  --fixture-dir services/translation-verifier/e2e/fixtures/smoke-mime-util --timeout-ms 600000

# 生产 verify-only(完整依赖 fixture 根)
npx tsx services/translation-verifier/e2e/run-smoke-e2e.ts --verify-only --timeout-ms 600000

# 跳过真实 claude(自主模式无离线回放,仅打印说明后退出码 0)
npx tsx services/translation-verifier/e2e/run-smoke-e2e.ts --offline-only
```

## 参数表(smoke)

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--fixture-dir <path>` | 否 | `e2e/fixtures/smoke-mime-util` | 任务输入目录(requirement.txt;经 `..` 定位 samples) |
| `--api-key <key>` | 否 | `DEEPSEEK_API_KEY` | claude 自主会话 API Key |
| `--timeout-ms <ms>` | 否 | `300000` | 单次 claude 自主会话超时 |
| `--offline-only` | 否 | - | 跳过真实 claude(仅打印说明退出 0) |
| `--verify-only` | 否 | - | 生产 verify-only 模式(依赖 fixture 根 + 不变量校验) |
| `--json` | 否 | - | 输出完整 SmokeResult JSON(含 SmokeReport) |

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 策略报告生成成功(status 非 error;verify-only 模式下不变量满足) |
| `1` | status=error,或 verify-only 报告违反生产不变量 |
| `2` | 参数错误 / 缺 API key / runner 运行异常 |

## 已知限制

- 生产 smoke 始终把编译/运行经 `verifier-command` 代理执行并记录命令证据;代理之外不直接放行任意 Bash。
- 自主模式无离线回放路径(runner 由 claude 会话现写);`--offline-only` 仅用于 CI/无 key 环境确认入口可用。
- 诊断 fixture 的 runner 修复实验产物随 `report.json` 落盘,本管线不直接修改用户项目文件。
- 单次会话分钟级,default timeout 300s,复杂用例建议 `--timeout-ms` 放大。
