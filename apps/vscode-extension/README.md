# ForeXplore VS Code 扩展

ForeXplore 将企业已有实现作为迁移证据：从已审目标工作区选择可调用实体，检索历史候选，并且只在存在精确的源语言 × 目标语言 × 策略路线时生成补丁。

项目已经进入语言无关的全面开发阶段，不再把 Java → C# 当作产品边界。实际可执行范围由运行时 `MigrationRouteDescriptor` 和其验证策略决定；没有能力快照时必须 fail closed。

## 01B 目标工作区模块划分

01B 对当前待处理的目标工程复用 01A 的静态分析、开放语言 adapter registry、统一 IR、Module Discovery Agent 和第一道模块边界人审。接受边界后，宿主再对每个 callable 生成静态实现状态，并确定性聚合到 class、file、module 和 workspace：

- `implemented`：检测到非占位实现体；不代表业务行为正确。
- `unimplemented`：检测到高确定性的显式 stub。
- `partial`：检测到 TODO、占位返回等不完整迹象。
- `unknown`：证据不足或当前语言没有实现状态 detector。
- `not-applicable`：接口、abstract/extern 声明或明确排除对象，不进入完成率分母。

使用顺序：

1. **ForeXplore: 初始化 01B 目标工作区**：固定分析快照并生成模块边界提案；证据不足时停止，不会把目标骨架发布为来源知识。
2. **ForeXplore: 审阅 01B 目标模块边界**：接受 Gate 1 后才建立内容寻址的实现状态目录。
3. **ForeXplore: 打开 01B 目标工作区**：浏览 module → file → native container/entity → callable，按五态搜索/筛选；未知实现状态或没有可执行路线的 callable 不可进入迁移。
4. 在树中先选择目标实体核对证据、lineage 和路线能力，再显式点击“开始迁移”。Top-1 候选仍不会被自动选择。
5. 若仅实现体变化，刷新会进入 `body-only-compatible`。运行 **ForeXplore: 重映射 01B 实现体兼容变更** 只会生成绑定新 IR 的边界提案；仍需再次 Gate 1 人审并重新检测状态。结构变化则必须重新发现和人审。

若 Gate 1 已接受但 detector 临时失败，运行 **ForeXplore: 重试 01B 实现状态检测**。宿主会先重新校验工作区仍是同一快照；只重试状态清单，不重新伪造审批。01B 记录保存在扩展的 Host-owned 本地存储中，扩展重启后仍会在打开/启动时重新扫描并验证 freshness。

写回或恢复文件后，旧 01B 快照立即失效，后续检索、适配和再次写回都会由宿主复验并拒绝旧 snapshot/hash/entity。01B 不运行 Summary Agent、第二道人审、SQLite knowledge registry、SeekDB module active head、发布补偿或显式撤销；这些只属于 01A 存量仓知识生命周期。

## 存量仓模块知识入库

仓库分析采用开放 `LanguageId` 和可注册 adapter；这使入库契约可扩展，但不代表每种语言都有相同的语义深度。迁移可执行性另由精确路线和必需验证能力判定。完整入库和撤销按五个受信任命令推进：

- **ForeXplore: 索引模块迁移仓库**：固定工作区快照，生成 profile、analysis shards、统一 IR 和 Module Discovery proposal；证据不足时进入 `partial`，充分时停在 `awaiting-module-review`。
- **ForeXplore: 审阅仓库模块边界**：第一道人审，只批准文件/实体/API/依赖的模块归属；接受后自动启动证据收集和 Summary Agent，不能直接发布。
- **ForeXplore: 生成模块知识摘要提案**：重试 Summary Agent 阶段；每模块提案必须绑定有界 EvidenceBundle，完成后停在 `awaiting-summary-review`。
- **ForeXplore: 审阅并发布模块知识**：第二道人审，逐模块 accept/revise/reject。全部接受后才写本地不可变知识、SQLite publication registry，并向独立 SeekDB 模块表 stage/validate/CAS activate；修订只重跑相应模块。
- **ForeXplore: 撤销当前模块知识发布**：只对 `ready` 发布执行逻辑撤销；先从正式模块索引移除当前代，再同步本地 SQLite 和不可变 manifest，存在前代时恢复前代。历史制品不物理删除。

模块索引写入默认关闭。检索服务与扩展宿主必须分别拥有同一令牌：

```powershell
$env:RETRIEVAL_MODULE_INDEX_TOKEN = '<random-secret>'
$env:FOREXPLORE_MODULE_INDEX_WRITER_TOKEN = $env:RETRIEVAL_MODULE_INDEX_TOKEN
```

令牌只从进程环境读取，不接受工作区设置，以免仓库内容为自己授予发布权限。正式查询还受服务端 `RETRIEVAL_ALLOWED_REPOSITORIES` 限制。发布作用域是 `(repositoryId, channel)`；默认 channel 为 `branch:main`，发布前仍会要求人工确认。

## 已审模块映射与执行 Overlay

新主链把 01A 与 01B 各自通过 Gate 1 的 `RepositoryModuleCatalog` 作为唯一模块边界事实。任务目标不得重新生成模块所有权；跨仓库对应关系由独立的 `ModuleMappingProposal → ModuleMappingReview → MigrationExecutionOverlay` 制品表达，并允许 1:1、1:N 与 N:1：

- **ForeXplore: 导入跨目录模块映射提案**：选择不同的历史源仓和目标仓，从本机 JSON 导入只含已审 module/entity ID 引用的映射与执行分组。workflow-core 会对两侧当前 IR/catalog/review head 做确定性校验，未知引用立即拒绝。
- **ForeXplore: 审阅模块映射并物化执行 Overlay**：在只读预览中接受、要求修订或拒绝。只有接受决定和已物化的 runtime route capability snapshot 同时存在时才产生 Overlay；没有能力快照时 fail closed。
- 目标实体启动迁移前，Host 必须找到唯一覆盖它的 current Overlay。active run 与 Webview 协议保留两侧 catalog ref、proposal/review/overlay hash 及精确 route/runtime/policy lineage；任一 head 或能力快照变化都会使绑定 stale。

旧 `FunctionalModule` 计划不是新运行默认入口，也不能覆盖已审目录。它只保留在命令标题和 ID 都显式带 **Legacy** 的兼容路径中，用于已有运行的审阅、准备、审批和恢复。

### 可信本地波次执行

整份计划已经对当前静态快照审批后，按以下顺序执行每个依赖波次：

1. 运行 **ForeXplore: 审阅下一迁移波次**，确认要准备的依赖已满足波次及其证据。
2. 运行 **ForeXplore: 导入并准备下一迁移波次**，从本机文件选择器导入补丁包。扩展先显示只读补丁包预览；确认后才在隔离 Git worktree 中应用补丁、执行宿主范围检查和本地联合验证，并生成精确的 `preparedHash`。
3. 审阅已准备波次中的补丁、验证记录和 `preparedHash`。运行 **ForeXplore: 审批并提交已准备迁移波次**，输入审批人后，扩展把审批绑定到该精确哈希，再发布单个原子 Git 提交到受管分支 `codex/forexplore-migration/<runId>`。当前工作区不会被直接部分写入。

补丁包只能从本地文件选择器导入，不能由 Webview、浏览器或 HTTP 请求提交。它是非可信的补丁输入，不得包含验证结论；验证必须由本地 VS Code 宿主在隔离 worktree 中重新执行。扩展重启会使内存中的已准备补丁失效。运行 **ForeXplore: 恢复模块迁移审阅状态** 后，放弃旧制品并重新准备、验证和审批该波次。

### 本地补丁包格式

导入文件必须是严格的 JSON 对象，且顶层只能含有 `schemaVersion`、`snapshotId`、`planId`、`planHash`、`waveId` 和 `modules`。`schemaVersion` 固定为 `forexplore-module-wave-patch-bundle/v1`；`snapshotId`、`planId`、`waveId` 和 `moduleId` 是安全标识符。`planHash` 可写为 `sha256:<64 个小写十六进制字符>` 或不带前缀的 64 个小写十六进制字符，宿主会规范化为带前缀的计划哈希；文件的 `expectedOriginalSha256` 可使用两种输入形式，但内部会规范化为裸 SHA-256 摘要以匹配受保护回填契约。

```json
{
  "schemaVersion": "forexplore-module-wave-patch-bundle/v1",
  "snapshotId": "snapshot-20260827",
  "planId": "plan-20260827",
  "planHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "waveId": "wave-01",
  "modules": [
    {
      "moduleId": "orders",
      "files": [
        {
          "path": "src/Orders/OrderService.cs",
          "status": "modified",
          "expectedOriginalSha256": "0000000000000000000000000000000000000000000000000000000000000000",
          "additions": 1,
          "deletions": 1,
          "hunks": [
            {
              "header": "@@ -1 +1 @@",
              "lines": [
                { "type": "remove", "content": "old implementation" },
                { "type": "add", "content": "new implementation" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

每个 `files` 项只能是 `modified` 或 `created`。`modified` 需要 `expectedOriginalSha256`；`created` 必须使用 `expectedAbsent: true` 替代它。两种形式都需要 `path`、`status`、`additions`、`deletions` 和非空 `hunks`。每个 hunk 仅含 `header` 和 `lines`，每行仅含 `type`（`context`、`add` 或 `remove`）及单行 `content`；`additions`、`deletions` 必须与 hunk 行数一致。v1 不支持删除文件。

路径必须是正斜杠的规范仓库相对路径，不能使用绝对路径、`..`、空段或反斜杠。模块和写入路径不能重复，补丁包必须精确覆盖当前下一波次的所有模块，并且每个补丁路径都必须属于相应模块已经审批的源码、测试、生成文件或写集。写集本身只能引用快照中由该模块显式拥有的文件；唯一的例外是具备资源锁、显式排属的 `shared-contract` 模块配置文件。`.forexplore/` 下的摘要和运行制品由协调器生成，补丁包不能写入。未知字段会被拒绝，尤其不能提供 `validation`、`contentHash`、源码全文或任何执行指令；宿主会自行计算内容哈希并产生验证证据。

### 波次联合验证配置

`forexplore.moduleWaveValidationCommands` 是本机用户级 VS Code 配置，不从补丁包、Webview 或工作区 `.vscode/settings.json` 读取。工作区尝试覆盖该值会被拒绝，避免仓库内容变成可执行宿主配置。配置的命令只在隔离波次 worktree 中执行，使用 `shell: false`，因此不能依赖 `&&`、管道、重定向或 shell 变量展开。没有配置时，扩展会产生必需的 `unverified` 记录并阻止波次准备。

```json
{
  "forexplore.moduleWaveValidationCommands": [
    {
      "id": "dotnet-test",
      "label": "Target tests",
      "executable": "dotnet",
      "args": ["test", "tests/Target.Tests/Target.Tests.csproj"],
      "cwd": ".",
      "required": true,
      "timeoutMs": 600000
    }
  ]
}
```

每项只允许 `id`、`label`、`executable`、`args`、`cwd`、`required` 和 `timeoutMs`。`id`、`label`、`executable` 必填；其余分别默认为空数组、`.`、`true` 和 10 分钟。最多配置 32 条命令，`timeoutMs` 必须在 1 秒到 30 分钟之间。`cwd` 必须是 worktree 内的相对路径；`executable` 可以是受 PATH 解析的简单命令名，或使用正斜杠的 worktree 内相对可执行文件，不能是绝对路径或使用反斜杠。任何必需检查失败或未验证都会阻止准备和后续审批提交。

## 运行方式

1. 在仓库根目录运行 `npm run dev:extension`。脚本会启动 SeekDB、两个本地服务，并打开 Extension Development Host。
2. 在开发宿主中打开要处理的任意受支持目标工作区；`fixtures/target-system/commons-fileupload-java-skeleton` 只是在需要复跑历史回归时使用的夹具，不是默认产品目标。
3. 若要使用 01B，依次运行初始化、模块边界人审和打开目标工作区命令，再从目标树中显式启动某个可调用实体。
4. 输入需求并检索语料候选。只有运行时 route capability snapshot 精确支持的源/目标语言与策略组合才能继续生成补丁。

插件只调用真实的 SeekDB 检索服务和语言无关的适配服务。任一服务不可用时，插件会报错，不会回退到本地样例。

按目标语言安装对应的 VS Code 语言扩展即可；ForeXplore 本身不依赖某个语言扩展。

## 服务要求

运行插件需要一台具备以下条件的机器：

- SeekDB 检索服务已经建立并加载完整的多语言 `code-corpus` 索引；
- 适配服务具备 `DEEPSEEK_API_KEY`、精确 route 所需的目标工程 adapter/编译器和外部隔离行为 verifier；
- V2 部署提供权威 request artifact store，并允许 Host 只组合 source/target analysis 与 workspace apply/rollback 四个宿主阶段；
- `ADAPTATION_PROJECT_ROOT`、`ADAPTATION_SKELETON_PROJECT_PATH` 只服务 deprecated V1 集成编译，不授权 V2 路线。

历史 V1 回归环境示例：

```bash
# 服务端环境；密钥只保留在这里
export DEEPSEEK_API_KEY='…'
export ADAPTATION_PROJECT_ROOT='/absolute/path/to/commons-fileupload-java-skeleton'
export ADAPTATION_SKELETON_PROJECT_PATH="$ADAPTATION_PROJECT_ROOT"
npm run dev:adaptation
```

插件默认使用以下 VS Code 配置：

```json
{
  "forexplore.executionMode": "real",
  "forexplore.retrievalApiUrl": "http://127.0.0.1:8787",
  "forexplore.adaptationApiUrl": "http://127.0.0.1:8788",
  "forexplore.repositoryKnowledgeChannel": "branch:main",
  "forexplore.repositoryPaths": [
    "E:/CS/devsys/weichai/fixtures/code-corpus"
  ]
}
```

该目录包含 `fixtures/code-corpus` 下的全部语料仓库。`forexplore.repositoryPaths` 仅检查本地目录是否可读；它不等于服务端“已经索引”。真实检索范围由检索服务的已授权索引决定。

## 写回保护

- Webview 只能发送“检索、选择候选、生成、应用”的意图，不能提交路径、候选对象或补丁。
- 扩展宿主保存当前运行的目标语言、候选、原始文件 SHA-256 和适配结果；候选必须由用户明确选择。
- 仅接受 route-owned allowed write set 内的非重复相对路径；路径遍历、绝对路径和经符号链接逃逸都会被拒绝。
- 所有文件在任何写入前统一完成原始 SHA-256、缺失前置条件、dirty buffer、realpath 和 hunk 预检。
- 多文件写入使用单次 `WorkspaceEdit`，并持久化 prepared/committing/committed/rolled-back 事务 journal、不可变 V2 manifest 和恢复点。启动时会先恢复可证明的中断事务；出现未知文件 hash 时停止并要求人工处理。
- 可使用 **ForeXplore: 恢复最近一次回填** 恢复；若文件随后又被编辑，恢复会拒绝覆盖该编辑。
- HTTP `POST /v1/backfill` 已禁用。写回只能由经过用户确认的 VS Code 宿主执行。

编译或集成编译通过仅代表相应工程检查通过；它不证明业务行为、并发、超时、取消或幂等语义正确。

## 开发与验证

```bash
npm ci
npm run typecheck --workspace forexplore-vscode
npm run test --workspace forexplore-vscode
npm run build:extension
npm run package:extension
```

集成测试需要图形界面 VS Code 运行时：

```bash
npm run test:integration --workspace forexplore-vscode
```

## 消息协议

Webview → 宿主：`READY`、`REFRESH_TARGET_WORKSPACE`、`SELECT_TARGET_ENTITY`、`START_TARGET_TRANSLATION`、`START_SEARCH`、`SELECT_CANDIDATE`、`START_ADAPT`、`APPLY_CURRENT_RUN`、`CHECK_REPOSITORIES`、`OPEN_TARGET`。

宿主 → Webview：`INIT`、`TARGET_WORKSPACE_SNAPSHOT`、`TARGET_WORKSPACE_REFRESHING`、`TARGET_WORKSPACE_INVALIDATED`、`TARGET_ENTITY_SELECTED`、`SEARCH_RESULT`、`ADAPT_RESULT`、`APPLY_RESULT`、`REPOSITORY_STATUS`、`SERVICE_STATUS`、`ERROR`。

共享类型和状态机在 monorepo 的 `@forexplore/contracts`、`@forexplore/workflow-core` 中维护；打包时 Webview 与扩展宿主会将所需代码纳入 VSIX 构建产物。
