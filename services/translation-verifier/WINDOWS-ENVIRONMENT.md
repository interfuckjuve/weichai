# Windows 环境与现有资产实测

在 Windows 对应工作区执行以下命令。先运行 `npm run workspace:check`；不要在映射的 WSL 目录使用 Windows 依赖。整个仓库的依赖用 `npm ci` 安装，推理和多语言测试工具放在仓库外。

## 当前环境

本机 runtime 目录为 `$env:LOCALAPPDATA\translation-verifier-runtime`。

| 组件 | 已安装版本 / 位置 |
| --- | --- |
| Node / npm | 24.18.0 / 11.16.0 |
| Java / Maven | Microsoft JDK 21.0.12.1 / Maven 3.9.11 |
| Gradle | 8.14.3 |
| Python | 3.14；独立 venv 内 pytest 9.1.1、pytest-cov 7.1.0 |
| JavaScript runner | 独立 node 目录内 Jest 30.2.0、Vitest 4.1.10、同版 coverage-v8 |
| .NET | SDK 10.0.401，runtime 8.0.28、10.0.12 |
| Go / Rust | Go 1.27.3，Rust 1.99.1 GNU、Cargo 1.99.1 |
| C/C++ | MSYS2 UCRT64 GCC；Rust GNU linker 使用同一工具链 |
| 索引推理 | 独立 `$env:LOCALAPPDATA\recast\embed-tools`，transformers 3.8.1、tokenizers 0.23.2 |

```powershell
npm run workspace:check
. .\services\translation-verifier\environment.ps1
```

`-Persist` 可持久化无凭据的 runtime PATH 与服务配置；不会保存 API key 或模型选择。启动真实模型服务时使用 `-LiveModel`，仅在当前进程未指定模型时选择已实测可用的 `deepseek-flash`。普通单元测试使用默认环境，避免全局 `DEEPSEEK_MODEL` 覆盖默认值断言。

## 新机器安装

使用 Windows 包管理器安装 Node LTS、Microsoft OpenJDK 21、Python 3.14、.NET SDK 10、.NET runtime 8、Git、Docker Desktop、VS Code 和 MSYS2。可用 `winget search` 核对对应包 ID；本机系统工具已经安装，无需重复安装。把 JDK 的 `bin` 和 MSYS2 的 `ucrt64\bin` 加到用户 PATH。

从 Apache、Gradle、Go 官方发行站下载 Maven 3.9.11、Gradle 8.14.3、Go 1.27.3 的 Windows 压缩包，先核对官方发布的 SHA512 / SHA256，再解压为 runtime 下 `apache-maven-3.9.11`、`gradle-8.14.3`、`go`。不能通过本脚本的目录检查表示依赖尚未安装；脚本负责加载环境，不会隐式下载工具。

其余依赖在仓库外安装：

```powershell
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'translation-verifier-runtime'
New-Item -ItemType Directory -Force $runtimeRoot | Out-Null
python -m venv (Join-Path $runtimeRoot 'python')
& (Join-Path $runtimeRoot 'python\Scripts\python.exe') -m pip install pytest==9.1.1 pytest-cov==7.1.0
npm install --prefix (Join-Path $runtimeRoot 'node') --no-audit --no-fund jest@30.2.0 vitest@4.1.10 @vitest/coverage-v8@4.1.10
$env:RUSTUP_HOME = Join-Path $runtimeRoot 'rustup'
$env:CARGO_HOME = Join-Path $runtimeRoot 'cargo'
# 将官方 rustup-init.exe 下载并校验后，在这个环境中运行：
& (Join-Path $runtimeRoot 'rustup-init.exe') -y --no-modify-path --profile minimal --default-host x86_64-pc-windows-gnu --default-toolchain 1.99.1
. .\services\translation-verifier\environment.ps1 -Persist
```

项目依赖准备完成后运行 `npm run services:up`，启动器会准备独立推理 runtime。Docker SeekDB 按仓库 `infra/` 配置启动，保留现有数据卷。初次模型下载需要较长时间；模型缓存位于 `$env:USERPROFILE\.cache\forexplore-model-cache`。本机下载与校验的详细证据在 runtime 的 `runtime-services-status.md`。

## 启动项目

```powershell
. .\services\translation-verifier\environment.ps1 -LiveModel
npm run services:up
npm run dev:extension
```

基础服务端口为 SeekDB 2881、embedding 4021、rerank 4022。`services:up` 已验证可复用兼容的现有服务；端口被不同模型占用时会报错，不能据此清理其他进程或数据库。正式 rerank 地址是 `/v1/rerank`。

本机 embedding 固定为 CPU/q8，模型 identity 与384维保持不变，variant 为 `cpu-q8`。DirectML/fp16 在持续大仓推理时出现 GPU device suspended，不能继续作为稳定环境。当前数据库为 `forexplore_asset_verifier_cpu_20261023`；旧 `forexplore_asset_verifier_20261022` 保留诊断及可校验的结构/建模成果。不同 variant 的向量必须在独立配置数据库重新生成，不能仅改 config hash。环境脚本会一并迁移本任务旧默认数据库、variant、DirectML 设备和 fp16 精度；独立的自定义配置保留。CPU 数据库或 `cpu-q8` 标记与实际设备/精度不一致时会明确拒绝，避免身份与向量混用。

扩展拥有 semantic query server 的生命周期；MCP 仅连接它提供的地址。独立调用 stdio MCP 时，必须显式向 `StdioClientTransport` 传入所需环境，不能假设 SDK 继承全部当前变量。8790 在后台建模任务等待下一仓时可能没有监听；此时应由调用方创建自己的 `CodeIntelligenceHost` 并使用其返回的 query endpoint，不能把连接失败写成 MCP 已验收。

8788 是未选择目标时的规划 bootstrap，可能关闭 module generation 和 workspace translation。导入目标后扩展通过 `BackendProcess` 启动独立的鉴权后端，才提供这两项能力。`e2e/backend-capabilities.ts` 直接验证这个真实入口：DeepSeek 工具调用、Codex 实际改写、编译和受保护测试的内部行为验收；完整命令见 README 的 Extension Backend Capability Probe。该探针需要当前工作区已构建的扩展 backend bundle，不可用另一个目录中的 health 响应代替验收。

`-LiveModel` 在未显式配置时为聊天和Codex同时选择已实测的deepseek-flash；自定义 `DEEPSEEK_MODEL` 或 `ADAPTATION_CODEX_MODEL` 保留。普通环境加载不设置模型默认值，模型选择也不写入用户持久环境。

## 回归验证

```powershell
. .\services\translation-verifier\environment.ps1
npm run workspace:check
node node_modules/vitest/vitest.mjs run services/translation-verifier/src services/translation-verifier/e2e/translation-verifier.e2e.test.ts scripts/startup.test.ts --maxWorkers=2
$env:TRANSLATION_VERIFIER_RUNNER_E2E = '1'
node node_modules/vitest/vitest.mjs run services/translation-verifier/e2e/runner-coverage.e2e.test.ts --maxWorkers=1
```

覆盖率套件会真实运行 Maven、Gradle、pytest、Jest、Vitest、dotnet，并检查目标执行、断言失败、未执行目标和 skip。Maven 路径包含在离线 E2E 中；其他五种 runner 在第二条命令中。Windows 文件符号链接权限缺失时有一个明确的能力 skip；目录 junction 和硬链接边界仍被验证。

## 使用 experiments 现有材料

不再创建数据集。材料位置均相对于项目根目录：

| 材料 | 位置 |
| --- | --- |
| Java 目标、需求 | `experiments/asset-upgrade-test-materials-20261014/java/target-project` |
| C# 目标、需求 | `experiments/asset-upgrade-test-materials-20261014/csharp/target-project` |
| 独立验收测试 | 同一材料目录下的 `java/hidden-tests`、`csharp/hidden-tests` |
| 七参考仓库 | `experiments/enterprise-asset-upgrade/reference-sources` |
| 需求与参考映射 | `experiments/enterprise-asset-upgrade/tasks/coverage-matrix.json` |

完整工程驱动分别覆盖 Java 250 文件/19 模块和 C# 27 文件/12 模块，按依赖顺序执行真实翻译、编译和模块验证。它们将完整原骨架记录为外部 Git seed，再创建 detached worktree；模型只能修改当前模块声明的生产文件。所有测试生成结束后，Host 对完整测试集和全部目标统一采集新鲜覆盖率，再运行本地装配和独立冻结验收。Java 35 条、C# 24 条隐藏用例及其反馈不进入模型上下文。实际是否通过以报告为准。

首次运行完整 Java 工程：

```powershell
npm run workspace:check
. .\services\translation-verifier\environment.ps1 -LiveModel
$env:TRANSLATION_VERIFIER_ASSETS_ROOT = Join-Path (Get-Location) 'experiments'
$env:TRANSLATION_VERIFIER_EXPERIMENT_DIR = Join-Path $env:TRANSLATION_VERIFIER_RUNNER_DEPS 'experiments/full-java-new-run'
node --import tsx services/translation-verifier/e2e/full-project-workflow.ts --prepare-only
$env:TRANSLATION_VERIFIER_FULL_PROJECT_E2E = '1'
node --import tsx services/translation-verifier/e2e/full-project-workflow.ts --credential-stdin
```

C# 使用 `full-csharp-workflow.ts` 和独立的 `experiments/full-csharp-new-run` 运行目录。只在终端显示 `Credential input ready (echo disabled).` 后输入凭据，或沿用当前进程中的 `DEEPSEEK_API_KEY`。恢复时保持实验目录、原资产根、输入内容和模型不变；不要对同一目录同时启动两个驱动。Windows 主工作区与实施 worktree 的材料可能仅行尾不同，也必须保留原输入 hash 校验。

完整报告为运行目录内的 `full-project-report.json`，包含逐模块轮次、公开编译/验证反馈、逐函数覆盖率、最终统一观察和独立验收。历史失败轮次保留；分组共享测试目录，不能相加各组测试数，也不能以早期覆盖快照代替最终统一复验。`passed=false` 或退出1保留未通过证据。

早期附件边界驱动 `existing-assets-workflow.ts` 仅针对 Java 的 `AttachmentIntakeHandler.intake/release/execute`，只有声明的一个生产文件允许模型修改。以下命令复现该有界探针，不代替完整工程运行：

```powershell
. .\services\translation-verifier\environment.ps1 -LiveModel
$env:TRANSLATION_VERIFIER_ASSETS_ROOT = Join-Path (Get-Location) 'experiments'
$env:TRANSLATION_VERIFIER_EXPERIMENT_DIR = Join-Path $env:TRANSLATION_VERIFIER_RUNNER_DEPS ('experiments/existing-java-' + [guid]::NewGuid().ToString('N'))
node --import tsx services/translation-verifier/e2e/existing-assets-workflow.ts --prepare-only
# 通过当前进程的安全凭据注入方式设置 DEEPSEEK_API_KEY；不要写入脚本或配置。
$env:TRANSLATION_VERIFIER_LIVE_E2E = '1'
node --import tsx services/translation-verifier/e2e/existing-assets-workflow.ts
```

报告默认在 runtime 的 `experiments/existing-java/report.json`，翻译响应与脱敏 verifier 日志在其 `traces/` 中。首次复现请通过 `TRANSLATION_VERIFIER_EXPERIMENT_DIR` 指定新的隔离运行目录，避免与已保留的历史实验混用；原输入、模型、准备协议或参考代码 hash 改变时恢复会拒绝继续。隐藏测试从未提供给翻译和 verifier 模型，也不用于修复反馈。最新真实结果见 [实测报告](REAL-WORKFLOW-RESULTS.md)。

七仓索引与建模状态保存在外部 `experiments/existing-assets` 目录。原 DirectML 队列的 `EXISTING-ASSETS-STATUS.md`、`index-queue-state.json`、`model-queue-state.json` 及每仓日志均作为历史保留。CPU 恢复队列已结束：七仓索引完成，前六仓建模完成，Camel建模failed。见同目录 `CPU-RECOVERY-STATUS.md`、`cpu-recovery-state.json`、`cpu-model-queue-state.json` 和 `cpu-recovery-snapshot.json`；具体结论应核对有效 revision、模块摘要和真实检索文档。不要删除缓存、状态或数据卷来重试。

`SeekDbIndexStore` 当前配置 hash/cache key 在 `config.embedding` 路径遗漏 variant，因此仅修改环境中的 variant 不足以防止混用旧向量。此环境固定使用独立 CPU 数据库并重算全部向量；切换其他设备或精度时需新数据库，不可复用旧向量缓存。

环境可用与检索质量分别验收。当前真实检索发现长指令 query 会使“指数退避”误排到缓存过期模块之前，类级需求检索相关性也不足；精确函数名查询可命中。证据保留在 runtime 报告中，尚未修改检索业务逻辑。
