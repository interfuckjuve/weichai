# ForeXplore VS Code 扩展

ForeXplore 将企业已有实现作为迁移证据：在任意受支持语言的目标方法或类上检索候选、由人明确选择候选、生成目标语言补丁，再展示独立验证证据和受保护的回填结果。

当前真实自动迁移能力边界是 **`translate` 策略下的 Java → C#**。它不是通用代码生成器；候选排序分也不是正确率或兼容概率。

## 版本化代码智能索引

索引写入事务的单条 SQL 超时预算至少为 60 秒，包含提交阶段；若连接原值更大则保留原值，事务结束后恢复连接设置。此设置不修改数据库全局配置。`[forexplore:performance]` 的 `seekdb-transaction` 日志分别记录事务总耗时和 `commitMs`，便于区分批量写入与提交等待。

项目 Agent 首轮预载目标工程元数据、文件清单、静态依赖和符号信息，先依据这些证据划分模块，再按需查询源码或更多索引信息。初始依赖最多读取 200 条，符号最多读取 100 条，各清单按字符预算保留完整记录，并附带省略数量和分页信息。信息充分时可直接输出；未解析依赖仍保留原状态。其他项目的文件清单不会进入首轮上下文。

扩展宿主将 `forexplore.repositoryPaths` 中的参考工程和当前本地工作区目标工程注册到同一个版本化索引链路：`RepositoryRegistry → AnalysisCoordinator → Tree-sitter structural index → revision store → SemanticQueryPort`。运行 **ForeXplore: 刷新代码智能索引** 可增量复用未变文件；**ForeXplore: 重新索引参考工程** 会重新检查全部文件；内容和解析器版本未变时保留原 revision。索引构建完成前，读者继续看到上一个 active revision。

设置面板展示仓库、项目、索引状态、active revision、语言能力等级和项目解析状态；不会接收索引数据库连接、源码或 `localPath`。它可切换查看宿主验证过的历史 revision，但此操作严格只读，绝不会改写 `activeRevision`；历史 Summary 会明确标为过期，不能当作当前结果。扩展宿主保留现有 Java/C# `RepositoryStaticAnalysis` 作为模块迁移兼容制品，不能把旧快照 Summary 强行标记为新结构索引 revision 的当前 Summary。新鲜的 Java/C# 编译器探测快照只有在其 Java/C# 文件哈希与 active structural revision 完全相符时，才由宿主绑定为该 revision 的专用语义证据；绑定失败不会影响旧迁移流程。

生产环境将以下变量设置在启动 VS Code 的本机环境中，以让宿主使用 SeekDB 持久化独立的 `repositories`、`analysis_revisions`、`projects`、`files`、`symbols`、`dependency_edges`、`module_artifacts` 和 `search_documents` 表：

```bash
export CODE_INTELLIGENCE_SEEKDB_DATABASE='forexplore'
export CODE_INTELLIGENCE_SEEKDB_HOST='127.0.0.1'       # optional; default shown
export CODE_INTELLIGENCE_SEEKDB_PORT='2881'            # optional; default shown
export CODE_INTELLIGENCE_SEEKDB_USER='root'            # optional; default shown
export CODE_INTELLIGENCE_SEEKDB_PASSWORD='…'
export CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION='384' # optional; default shown
```

没有 `CODE_INTELLIGENCE_SEEKDB_DATABASE` 时，只有 VS Code 开发/测试宿主会明确显示“内存开发存储”；它仅适用于本地试用，不提供跨重启持久性。已打包的生产扩展会报告配置错误并要求 SeekDB。Agent/MCP 只能使用宿主提供的只读 `SemanticQueryPort`，不能传入绝对路径、启动 LSP 或直接访问 SeekDB。

## 模块迁移计划

模块级迁移计划由 VS Code 扩展宿主负责，不经 Webview 提交源码、计划或写入请求。当前提供六个受信任命令：

- **ForeXplore: 索引模块迁移仓库**：对本地工作区执行 Java/C# 静态分析，并把不可变快照写入 `.forexplore/analysis/<snapshotId>.json`。默认收集可复现的语法证据；只有受信任的 JDK/Roslyn 绑定适配器明确确认的精确边才会标记为语义证据，编译器可用性探测不会提升证据等级。
- **ForeXplore: 审阅模块迁移计划**：向适配服务发送仓库 revision、所选项目、迁移目标和不可变约束，通过 SemanticQueryPort 按需取证。扩展宿主验证 Agenticodex 提案、确定性生成波次，并在只读文档中展示计划和证据；人工批准后写入 `.forexplore/module-summary.json`。
- **ForeXplore: 审阅下一迁移波次**：只有整份计划已对同一快照审批后才会展示依赖已提交的下一波次。该命令只显示调度、静态证据和可供后续补丁审阅的范围；它不创建波次审批、不准备补丁，也不提交代码。
- **ForeXplore: 导入并准备下一迁移波次**：从本机文件选择器读取严格的仅补丁 JSON，在隔离 worktree 中运行宿主范围检查和本地联合验证，并生成待审阅的 `preparedHash`。
- **ForeXplore: 审批并提交已准备迁移波次**：把人工审批绑定到已审阅的 `preparedHash`，然后将该波次发布为受管迁移分支上的单个原子 Git 提交。
- **ForeXplore: 恢复模块迁移审阅状态**：从扩展受信任存储和不可变快照恢复审阅状态；它不写入源码，也不把仓库中的摘要当作审批授权。

计划审批绑定快照和计划哈希，并把模块摘要写入 `.forexplore/module-summary.json`，供 01A/01B 模块视图复用。执行协调器仍必须先在隔离 worktree 中生成精确补丁、完成波次联合验证并计算 `preparedHash`；人对该制品审批后，协调器才会把代码和运行清单放入同一个原子 Git 事务。模块计划服务必须将 `ADAPTATION_ANALYSIS_ROOT` 指向当前工作区的 `.forexplore/analysis`，以便 `/v1/module-plan` 只按快照标识读取服务端制品。

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

## 术语

界面统一使用“目标工程”表示待开发或适配的工程，“参考工程”表示提供可借鉴实现的工程。检索结果称为“候选模块”，选定后用于分析与翻译的模块称为“参考模块”。“工作区”用于 VS Code 编辑环境，“代码仓库”用于仓库身份和版本管理。内部 `target` / `history` 角色值及配置键保持兼容。

## 工作台入口

顶部提供“任务检索 / 复用迁移”切换，左侧共用工程选择器与模块树，解析详情位于主操作区下方。复用迁移沿用已有需求、候选、翻译和回填流程。

任务检索页已通过 Host 消息通道连接真实 `TaskRetrievalPort`，直接查询当前选中工程、项目和代码版本，不等待整个项目的 Agent 分析。支持“自动、函数 / 方法、类 / 接口、功能模块、子系统”五种粒度；尚未发布模块索引时模块选项禁用，当前子系统选项显示未建索引。显式粒度不会静默切换成其他粒度。历史 `ready/superseded` 快照可只读查询，参考范围由 Host 限定为本窗口可见工程。

返回内容复用证据列表与源码预览，显示快照、部分结果和证据缺口。页面只需填写需求并选择范围与粒度，不提供 token 预算控件或用量计数；Host 使用内部默认预算。复制与下载默认使用服务端生成的同一份 Markdown；手动筛选证据后标记“已筛选”。修改需求、范围、粒度或取消检索都会撤销当前请求，迟到响应不会覆盖新结果。“复用迁移”携带开发需求进入原有流程，尚不向翻译后端传递选定证据。

模块建模继续发布现有 `ProjectAnalysisRecord`，因此离线分组结果直接进入原有模块树、Summary、覆盖与依赖视图。界面分别标明“离线结构分析”或“Agent 分析”来源；基础源码检索可在模块说明发布前使用。

大仓模块树初始只传模块摘要，展开后通过当前工程、项目和版本的节点 ID 每次读取 80 个子节点，可继续分页到最后一项。左侧搜索覆盖宿主的完整节点索引，包括未展开的符号；统计保留全量值。依赖、诊断和未归属文件的展示明细最多 200 条，页面同时标明展示数量与总量。函数和类粒度仅在当前检索范围已有对应符号时启用。

在仓库根目录运行 `node scripts/preview-workbench.mjs`，生成可直接打开的 `logs/workbench-preview.html`。预览使用独立的示例消息桥和本地 FileUpload 源码片段，可体验检索、选择、预算、下载及工作流切换，不调用模型或数据库。`FOREXPLORE_UI_TOOLS` 可指向含本机可用 esbuild 的工具目录。

### 本机 Agent 查询

扩展启动后提供本机查询服务，默认 `http://127.0.0.1:8790`，可通过 `FOREXPLORE_SEMANTIC_QUERY_PORT` 调整。MCP 进程使用同一个服务：

```bash
SEMANTIC_QUERY_PORT_URL=http://127.0.0.1:8790 npm run start --workspace @forexplore/semantic-index-mcp-server
```

`search_task_context` 接收 `requestId`、`requirement`、`granularity`、固定 `scopes` 和 `budget.maxTokens`。Agent 先用已有 `list_repositories`、`list_projects` 获取身份，再调用任务检索；补查仍可使用 `get_symbol`、`get_dependencies`、`read_source_excerpt` 等原有工具。任务工具只返回一次已计量的 Markdown，不重复传输包含相同源码的 JSON。HTTP `POST /v1/task-search` 则返回完整 `ContextPacket`，`usage.tokens` 计量其 `markdown`，不是整个 HTTP 信封。

新增任务 HTTP 适配器仅接受 `http://127.0.0.1` 或 `http://[::1]`，不接受远端主机、DNS 名称、URL 凭据或重定向；MCP 不注册或扫描工程。Host 在每次查询中核验窗口可见工程及可读版本。配置 `SEMANTIC_QUERY_PORT_TOKEN` 时，扩展和 MCP 使用相同本机 token。

## 运行方式

1. 在仓库根目录运行 `npm run dev:extension`。脚本会启动 SeekDB、两个本地服务，并打开 Extension Development Host。
2. 在面板左侧“目标工程”的选择器中选择目标目录；已打开的 VS Code 工作区仅作为候选，不会自动作为目标工程。
3. 运行 **ForeXplore: 打开翻译面板**，从目标工程的模块树中选择待实现的类或方法。
4. 输入需求并检索全部语料候选。任意已支持语言的候选均可继续生成目标语言补丁。

插件只调用真实的 SeekDB 检索服务和语言无关的适配服务。任一服务不可用时，插件会报错，不会回退到本地样例。

按目标语言安装对应的 VS Code 语言扩展即可；ForeXplore 本身不依赖某个语言扩展。

## 服务要求

运行插件需要一台具备以下条件的机器：

- SeekDB 检索服务已经建立并加载完整的多语言 `code-corpus` 索引；
- 适配服务具备 `DEEPSEEK_API_KEY` 和目标语言的编译器；
- `ADAPTATION_PROJECT_ROOT` 指向与插件选中目标**相同内容**的工程；
- `ADAPTATION_SKELETON_PROJECT_PATH` 对应同一目标工程，用于临时集成编译。

适配服务环境示例：

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
  "forexplore.adaptationApiUrl": "http://127.0.0.1:8788",
  "forexplore.topK": 4,
  "forexplore.repositoryPaths": []
}
```

翻译面板右上角的“设置”界面可调整每次检索的候选方案数量，并添加或删除多个本地参考工程路径。首次使用且路径为空时，面板会提示进入该设置界面。每个已保存路径作为一个可切换的 01A 参考工程；未配置时不会使用机器相关的示例默认路径。`forexplore.repositoryPaths` 保存后会注册参考工程并执行统一结构索引及按项目的 Agent 模块解析。代码理解结果存入 SeekDB；检索先选择相关模块，再只在这些模块拥有的符号中返回候选。

## 写回保护

- Webview 只能发送“检索、选择候选、生成、应用”的意图，不能提交路径、候选对象或补丁。
- 扩展宿主保存当前运行的目标语言、候选、原始文件 SHA-256 和适配结果；候选必须由用户明确选择。
- 仅接受工作区内、当前选中目标对应的一个相对路径修改补丁；路径遍历、绝对路径和经符号链接逃逸都会被拒绝。
- 应用前和应用时都会重新校验 SHA-256，hunk 必须精确匹配原始内容。
- 写入建立持久恢复点。可使用 **ForeXplore: 恢复最近一次回填** 恢复；若文件随后又被编辑，恢复会拒绝覆盖该编辑。
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

Webview → 宿主：`READY`、`START_TASK_SEARCH`、`CANCEL_TASK_SEARCH`、`START_SEARCH`、`SELECT_CANDIDATE`、`START_ADAPT`、`APPLY_CURRENT_RUN`、`CHECK_REPOSITORIES`、`REFRESH_MODULE_EXPLORER`、`SAVE_SETTINGS`、`SELECT_CODE_INTELLIGENCE_REVISION`、`SELECT_WORKSPACE_TARGET`、`OPEN_TARGET`。任务检索携带请求 ID、需求、粒度、预算及 Host 已发布的工程/版本/项目 ID；模块树目标切换和 revision 查看只提交受限 ID，不提交路径或源码；设置保存只提交经过严格数量与长度校验的 Top K 和本地仓库路径列表。

宿主 → Webview：`INIT`、`MODULE_EXPLORER`、`TARGET_SELECTED`、`SETTINGS_UPDATED`、`TASK_SEARCH_RESULT`、`TASK_SEARCH_ERROR`、`SEARCH_RESULT`、`ADAPT_RESULT`、`APPLY_RESULT`、`REPOSITORY_STATUS`、`CODE_INTELLIGENCE_STATUS`、`SERVICE_STATUS`、`ERROR`。任务响应按请求 ID 配对。

共享类型和状态机在 monorepo 的 `@forexplore/contracts`、`@forexplore/workflow-core` 中维护；打包时 Webview 与扩展宿主会将所需代码纳入 VSIX 构建产物。

## 参考工程与目标工程解析

运行 **ForeXplore: 打开翻译面板** 即可配置仓库，无需先选择方法。添加多个参考工程路径并保存后，各项目自动进入模块解析；左侧“目标工程 / 参考工程”各自的项目选择器切换当前项目，右侧展示模块树对应的 Summary、覆盖范围、依赖和诊断。选择方法后才进入后续代码翻译流程。

目标选择器菜单提供已打开工作区、浏览目录和输入路径三个入口。选择保存在 `forexplore.targetRepositoryPaths`；只有明确选择且位于当前 VS Code 工作区的目录会作为目标工程。一个目录包含多个子项目时，结构索引完成后等待用户选择具体项目，再启动该项目的 Agent 解析。面板会逐仓库显示已完成结果。

保存设置时只扫描新添加的仓库，已有仓库通过“刷新此仓库”检查变化。普通刷新在内容未变化时复用原 revision 和 Summary。“重新解析模块”按当前策略重新建模；小项目可使用已配置 Agent，大项目使用离线结构分组。“重试解析 / 同步”在仅投影失败时不重复建模。历史版本展示保持只读。本地 .forexplore/module-summary.json 不参与当前模块树构建。

SeekDB 按行数和数据大小分批写入，项目 Summary 只替换自身的模块检索文档。宿主控制台中的 `[forexplore:performance]` 日志记录源码扫描、结构解析、数据库写入、检索投影和 Agent 分析耗时，以及文件、符号、依赖数量和 INSERT 次数。数据库写入验收可在仓库根目录运行 `npx tsx scripts/verify-indexing-performance.ts`，它使用本机 SeekDB 连接配置，创建独立临时数据库，验证索引一致性、Summary 更新范围及逐条/批量写入耗时，结束后删除测试数据库。

扩展宿主启动前配置 SeekDB：

~~~powershell
$env:CODE_INTELLIGENCE_SEEKDB_HOST = '127.0.0.1'
$env:CODE_INTELLIGENCE_SEEKDB_PORT = '2881'
$env:CODE_INTELLIGENCE_SEEKDB_USER = 'root'
$env:CODE_INTELLIGENCE_SEEKDB_DATABASE = 'forexplore_code_intelligence'
# 如需密码，在宿主环境中配置 CODE_INTELLIGENCE_SEEKDB_PASSWORD。
~~~

适配服务需要 DEEPSEEK_API_KEY，以及 ADAPTATION_SEMANTIC_INDEX_ENABLED=true、SEMANTIC_QUERY_PORT_URL=http://127.0.0.1:8790。兼容服务可通过 DEEPSEEK_API_BASE 和 DEEPSEEK_MODEL 指定。查询服务随扩展宿主启动，不依赖 Agent 模块解析；端口可通过 FOREXPLORE_SEMANTIC_QUERY_PORT 调整，并同步修改适配服务地址。可选 SEMANTIC_QUERY_PORT_TOKEN 在两个进程中应一致。凭据仅保留在本地服务或宿主环境。

模块任务使用 module_artifacts 中独立的 job 记录持久化，Summary 使用按项目和解析配置稳定定位的另一条记录。任务失败不删除上一份有效结果；扩展重启后中断任务可重试。Summary 的自动发布只代表代码理解完成，不批准代码迁移或写回。

真实服务验收使用一个没有已注册仓库的专用 SeekDB 数据库：

~~~powershell
$env:CODE_INTELLIGENCE_SEEKDB_DATABASE = 'forexplore_analysis_acceptance'
# 另行配置 DEEPSEEK_API_KEY，以及需要时的 DEEPSEEK_API_BASE / DEEPSEEK_MODEL。
npm run test:project-analysis:live
~~~

该脚本建立两个参考工程和一个目标工程，通过实际 HTTP 查询与 Agent 工具调用发布 Summary，验证无变更刷新与重开宿主复用，最后移除本次测试仓库记录。单元和 Webview 链路测试运行 npm test；VS Code 集成测试运行 npm run test:integration --workspace forexplore-vscode。
