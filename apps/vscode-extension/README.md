# ForeXplore VS Code 扩展

ForeXplore 将企业已有实现作为迁移证据：导入历史仓与目标代码，输入需求文档，通过全自动项目流水线完成检索、代码生成与验证，并展示差异和受保护的回填结果。

单模块兼容 `translate` 策略的既有验收边界是 Java → C#。整个项目入口使用下述 Codex 流水线，实际目标语言能力取决于模型、编译器和 Verifier；候选排序分不代表正确率。

## 需求驱动流水线

工作台默认执行“整个项目”：导入历史仓和目标骨架，从左侧选择目标项目，再输入完整需求文档即可启动，无需逐个选择模块。需求可直接输入、粘贴，或导入 UTF-8 TXT / Markdown，最多 8000 字；过长文件会报错并保留原文。“单模块调试”保留原有模块、类或方法的独立执行方式。

- **全自动流水线**：固定索引和独立输出副本，执行 Integration Plan、自动选择 1～3 份参考、Codex Analyzer / Translator、模块 Verifier 与修复、主动项目 Integration、最终快照验证和交付报告。

项目任务在扩展全局存储中的独立输出副本执行，不改写源骨架；普通目录和已有 Git 项目均可输入。宿主创建快照基线，在最后一次验证的文件哈希仍一致时，才将产物发布为输出副本中的一个 Git 提交。测试文件、配置文件和范围外文件发生改动会阻止发布。符号链接、超过 30000 文件 / 512 MiB 的骨架，以及单次生成单元超过 128 个生产文件时，会给出明确原因。

运行记录与 Markdown 验收报告持续落盘。输出区可打开生成项目、查看差异、查看报告，或导出 Markdown / JSON。报告包含需求原文、模块追溯、历史版本、生成计划、真实编译与测试输出、审阅决定和运行事件。未采集覆盖率时明确标为未采集；最终模块 Verifier 或已配置固定测试尚未完整通过时，只声明编译通过。扩展重启后运行标为中断，保留输出和报告。点击“继续任务”可复用原运行和独立输出；“重试此模块”会重跑该模块及受影响的后续模块，保留无关的已完成模块，最终联合验证仍会重新执行。恢复前检查文件快照，拒绝复用已被外部修改的输出；重新开始则创建新的独立副本。

项目全自动生成直接调用现有 Codex Runtime；检索与建模沿用本机后端。模型配置和 API Key 使用右上角设置，Codex CLI 及所选模型接口需要在本机可用。可通过 ADAPTATION_CODEX_COMMAND / ADAPTATION_CODEX_HOME 指定运行时。编译与固定验收只取用户级设置。完整链路、验收边界和验证方式见 [项目流水线说明](../../docs/project-pipeline-validation.md)。

固定高度的运行日志窗口显示检索、审阅、生成、修复和验收的实际状态。项目运行由宿主推送进度；单模块调试每 1.5 秒读取运行状态。上翻日志暂停自动跟随，点击“跟随最新”恢复。运行期间锁定输入和工程导航，可取消整个项目任务；失败时输出与报告保留以便检查。打开设置再返回会保留需求正文。

“执行完成”表示该运行已结束，业务验收结论以实际行为测试记录为准；仅编译通过时，输出仍明确显示尚无行为验收通过记录。

## 版本化代码智能索引

在插件右上角打开 **设置 → AI 服务**，选择服务商并直接填写 API Key（默认为“无”），点击保存设置或按 Ctrl+S，一并保存并启用服务商。密钥以密码形式暂存在表单中，仅保存时传给宿主并写入 VS Code SecretStorage，不写入工作区设置或日志。已配置的 Key 显示固定掩码和“已配置”状态，宿主不会把保存的密钥回传前端；修改其他设置会保留原密钥，输入新 Key 可替换，清除操作在保存后生效。更换服务商或地址会重新显示对应配置状态；后端已有 `.env` 配置仍可作为备用。

目标工程和参考工程共用主工作区顶部的导入任务面板，展示源码解析、索引、模块建模、真实计数、耗时及过程记录。参考仓库串行解析，每个仓库的所有子项目及检索信息均就绪后才完成；建模失败可直接重试，复用已完成的索引。两种任务分别保存最近 30 条历史，每条保留最多 200 条过程记录，关闭 Webview 后宿主仍记录进度。右侧 × 只收起面板，后台任务继续运行；点击“显示…导入任务”重新打开，新任务会自动显示。恢复旧制品而缺少原始计时记录时，明确显示“历史耗时未记录”。

此配置仅用于本机 AI 后端，按 `forexplore.adaptationApiUrl` 配置地址（默认 `http://127.0.0.1:8788`）保存；更换配置地址后需要为新地址配置。自动启动的自有后端使用系统分配的实际端口，宿主只向验证过的实际地址发送凭据，端口变化不要求重新填 Key。后端需更新到支持请求凭据的版本，可在没有 `DEEPSEEK_API_KEY` 的情况下启动。远程后端仍在服务端配置密钥。密钥保存成功不等于模型鉴权成功；保存后可重试项目模块分析。

模块分析给模型使用短文件组和证据编号，校验后恢复真实索引 ID。遗漏、重复或未知文件组会产生具体修正反馈；修正后仍不合法时，项目显示校验原因并保留失败状态，不将结构性降级结果冒充已完成的模型分析。

索引写入事务的单条 SQL 超时预算至少为 60 秒，包含提交阶段；若连接原值更大则保留原值，事务结束后恢复连接设置。此设置不修改数据库全局配置。`[forexplore:performance]` 的 `seekdb-transaction` 日志分别记录事务总耗时和 `commitMs`，便于区分批量写入与提交等待。

项目 Agent 首轮预载目标工程元数据、文件清单、静态依赖和符号信息，先依据这些证据划分模块，再按需查询源码或更多索引信息。初始依赖最多读取 200 条，符号最多读取 100 条，各清单按字符预算保留完整记录，并附带省略数量和分页信息。信息充分时可直接输出；未解析依赖仍保留原状态。其他项目的文件清单不会进入首轮上下文。

扩展宿主将 `forexplore.repositoryPaths` 中的参考工程和当前本地工作区目标工程注册到同一个版本化索引链路：`RepositoryRegistry → AnalysisCoordinator → Tree-sitter structural index → revision store → SemanticQueryPort`。运行 **ForeXplore: 刷新代码智能索引** 可增量复用未变文件；**ForeXplore: 重新索引参考工程** 会重新检查全部文件；内容和解析器版本未变时保留原 revision。索引构建完成前，读者继续看到上一个 active revision。

设置面板展示仓库、项目、索引状态、语言能力等级和项目解析状态，已移除内部 revision 标识和切换控件；不会接收索引数据库连接、源码或 `localPath`。后台继续用不可变 revision 绑定索引和模型，过期 Summary 不能当作当前结果。扩展宿主保留现有 Java/C# `RepositoryStaticAnalysis` 作为模块迁移兼容制品，不能把旧快照 Summary 强行标记为新结构索引 revision 的当前 Summary。新鲜的 Java/C# 编译器探测快照只有在其 Java/C# 文件哈希与 active structural revision 完全相符时，才由宿主绑定为该 revision 的专用语义证据；绑定失败不会影响旧迁移流程。

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

工作台固定使用复用迁移流程：左侧选择目标工程和参考工程模块，填写需求后召回候选模块，再进入分析、翻译和回填。


返回内容复用证据列表与源码预览，显示快照、部分结果和证据缺口。页面只需填写需求并选择范围与粒度，不提供 token 预算控件或用量计数；Host 使用内部默认预算。复制与下载默认使用服务端生成的同一份 Markdown；手动筛选证据后标记“已筛选”。修改需求、范围、粒度或取消检索都会撤销当前请求，迟到响应不会覆盖新结果。“复用迁移”携带开发需求进入原有流程，尚不向翻译后端传递选定证据。

模块建模继续发布现有 `ProjectAnalysisRecord`，因此离线分组结果直接进入原有模块树、Summary、覆盖与依赖视图。界面分别标明“离线结构分析”或“Agent 分析”来源；基础源码检索可在模块说明发布前使用。

大仓模块树初始只传模块摘要，展开后通过当前工程、项目和版本的节点 ID 每次读取 80 个子节点，可继续分页到最后一项。左侧搜索覆盖宿主的完整节点索引，包括未展开的符号；统计保留全量值。依赖、诊断和未归属文件的展示明细最多 200 条，页面同时标明展示数量与总量。函数和类粒度仅在当前检索范围已有对应符号时启用。

### 本机 Agent 查询

首次打开工作台（或首次语义规划请求）后提供本机查询服务，默认由操作系统分配空闲的 loopback 端口；实际地址记录在 RECAST 输出中并自动传给本窗口的适配后端，不复用另一窗口的查询服务。外部 MCP 客户端应使用该实际地址；如需固定 8790，请先设置 `FOREXPLORE_SEMANTIC_QUERY_PORT=8790` 再启动扩展，然后运行：

```bash
SEMANTIC_QUERY_PORT_URL=http://127.0.0.1:8790 npm run start --workspace @forexplore/semantic-index-mcp-server
```


新增任务 HTTP 适配器仅接受 `http://127.0.0.1` 或 `http://[::1]`，不接受远端主机、DNS 名称、URL 凭据或重定向；MCP 不注册或扫描工程。Host 在每次查询中核验窗口可见工程及可读版本。配置 `SEMANTIC_QUERY_PORT_TOKEN` 时，扩展和 MCP 使用相同本机 token。

## 运行方式

1. 在仓库根目录运行 `npm run dev:extension`。脚本启动 SeekDB、embedding 和 rerank，完成 SQL / 模型健康检查后再打开 Extension Development Host；适配后端仅由扩展启动，不再由脚本重复抢占端口。
2. 点击活动栏的 **RECAST** 图标打开工作台（等价于命令面板中的 **RECAST: 打开智能开发工作台**）。该活动栏容器只作为启动入口：点击后工作台在编辑器区域打开，并自动收起随之弹出的侧边栏；只有在工作台已经是当前编辑器时（例如用 Ctrl+B 主动展开侧边栏），侧边栏才保留并显示「打开工作台 / 重新索引参考工程」两个入口。
3. 在面板左侧“目标工程”的选择器中选择目标目录；已打开的 VS Code 工作区仅作为候选，不会自动作为目标工程。
4. 从目标工程的模块树中选择待实现的类或方法，输入需求并检索全部语料候选。任意已支持语言的候选均可继续生成目标语言补丁。

插件只调用真实的 SeekDB 检索服务和语言无关的适配服务。任一服务不可用时，插件会报错，不会回退到本地样例。

按目标语言安装对应的 VS Code 语言扩展即可；ForeXplore 本身不依赖某个语言扩展。

## 服务要求

运行插件需要一台具备以下条件的机器：

- SeekDB、embedding 和 rerank 已就绪；启动器会检查数据库和模型健康状态；
- 在面板设置中配置模型 Key，并安装目标语言的编译器；
- 默认由扩展启动适配后端，自动绑定当前目标工程、语义查询地址和翻译令牌。

默认工作流从仓库根目录启动，无需另外运行 `dev:adaptation`：

```bash
npm run dev:extension
```

如果需要直接打开已经写入 SeekDB 的企业资产升级语料，可以使用预置入口：

```bash
npm run dev:extension:preloaded
```

它会读取 `experiments/enterprise-asset-upgrade/AssetUpgradeGateway.code-workspace`，将其中的一个目标工程和七个参考工程绑定到当前数据库
`forexplore_asset_upgrade_20261004`，只加载已有 revision 和模块产物，不重新扫描或建模。预置入口使用被忽略的独立 VS Code 数据目录，因此不会改动普通
`npm run dev:extension` 的工作区状态；需要换数据库或工作区时分别使用 `--database <name>` 和 `--workspace <file.code-workspace>`。默认 DeepSeek
模型可以直接使用启动 VS Code 进程继承的 `DEEPSEEK_API_KEY`；其他服务商在预置窗口的设置中保存一次 Key 即可。

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

## Runtime requirements

The bundled module Verifier runs on LangChain, whose packages require Node.js 20
or newer. The declared minimum host, VS Code 1.90, ships Electron 29.4 with
Node.js 20.9, so `engines.vscode` stays at `^1.90.0` and the extension bundles
are compiled with esbuild `target: node20`. Raising either value would drop
supported hosts; lowering the target below node20 would claim Node 18 support the
framework does not provide.

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



共享类型和状态机在 monorepo 的 `@forexplore/contracts`、`@forexplore/workflow-core` 中维护；打包时 Webview 与扩展宿主会将所需代码纳入 VSIX 构建产物。

## 参考工程与目标工程解析

运行 **ForeXplore: 打开翻译面板** 即可配置仓库，无需先选择方法。添加多个参考工程路径并保存后，各项目自动进入模块解析；左侧“目标工程 / 参考工程”各自的项目选择器切换当前项目，右侧展示模块树对应的 Summary、覆盖范围、依赖和诊断。选择方法后才进入后续代码翻译流程。

目标选择器菜单提供已打开工作区、浏览目录和输入路径三个入口。选择保存在 `forexplore.targetRepositoryPaths`；只有明确选择且位于当前 VS Code 工作区的目录会作为目标工程。一个目录包含多个子项目时，结构索引完成后等待用户选择具体项目，再启动该项目的 Agent 解析。面板会逐仓库显示已完成结果。

选定目录后的每一步都会反馈：`TARGET_WORKSPACE_PROGRESS` 按 `selecting → resolving → attaching → indexing` 报告阶段，同时以 VS Code 通知显示进度；`TARGET_WORKSPACE_RESULT` 区分取消、已加入、完成和失败，失败时在选择器与空态中就地显示原因并提供重试。索引中的仓库由 `analysisStatus` 呈现（面板重建后仍可恢复该状态），索引失败的首次扫描会标记为 `failed` 而不是停留在“正在建立索引”。同一目录的路径比较同时按解析路径与真实路径（real path）匹配，因此通过符号链接/联接（junction）打开的目录仍会被识别为目标工程。

大仓库索引会显示快照、源码解析、结构合并、数据库写入、检索向量等阶段及已完成数量，索引通知支持取消。结构合并在后台进程执行，分块把结果交回扩展。文档向量请求每次等待最多 30 秒，瞬态失败最多重试两次；交互查询仍使用 8 秒且不重试。重开后失败目标保留重试入口，直接重试已登记目录。若失败发生在结构完整落库之后的检索投影阶段，重试先重新采集并核对当前源码，再复用未变化文件的解析结果与已缓存向量；不会直接激活旧快照。旧版失败记录没有阶段信息时按正常扫描处理，显式全量重建也不复用失败记录。

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

扩展自动启动的适配后端会收到本窗口实际的语义查询地址，无需手填 `SEMANTIC_QUERY_PORT_URL`。手动部署后端时，先在 VS Code 用户设置中设 `forexplore.backend.autoStart=false`；启动扩展前设置固定 `FOREXPLORE_SEMANTIC_QUERY_PORT`，后端设置 `ADAPTATION_SEMANTIC_INDEX_ENABLED=true`，并将 `SEMANTIC_QUERY_PORT_URL` 指向该端口（实际地址可在 RECAST 输出核对）。两个进程必须配置相同的 `ADAPTATION_WORKSPACE_TRANSLATION_TOKEN` 和可选 `SEMANTIC_QUERY_PORT_TOKEN`，后端的 `ADAPTATION_PROJECT_ROOT` 与 `ADAPTATION_SKELETON_PROJECT_PATH` 必须绑定插件选中的目标根目录，再运行 `npm run dev:adaptation`。模型凭据通过面板 SecretStorage 或服务端 `DEEPSEEK_API_KEY` 配置；后端启动成功不代表模型已鉴权。兼容服务可通过 `DEEPSEEK_API_BASE` 和 `DEEPSEEK_MODEL` 指定。

模块任务使用 module_artifacts 中独立的 job 记录持久化，Summary 使用按项目和解析配置稳定定位的另一条记录。任务失败不删除上一份有效结果；扩展重启后中断任务可重试。Summary 的自动发布只代表代码理解完成，不批准代码迁移或写回。

真实服务验收使用一个没有已注册仓库的专用 SeekDB 数据库：

~~~powershell
$env:CODE_INTELLIGENCE_SEEKDB_DATABASE = 'forexplore_analysis_acceptance'
# 另行配置 DEEPSEEK_API_KEY，以及需要时的 DEEPSEEK_API_BASE / DEEPSEEK_MODEL。
npm run test:project-analysis:live
~~~

该脚本建立两个参考工程和一个目标工程，通过实际 HTTP 查询与 Agent 工具调用发布 Summary，验证无变更刷新与重开宿主复用，最后移除本次测试仓库记录。单元和 Webview 链路测试运行 npm test；VS Code 集成测试运行 npm run test:integration --workspace forexplore-vscode。

## AI 服务与输出预算

在 RECAST 面板右上角打开“设置”，选择 DeepSeek、OpenAI、Anthropic / Claude、Google Gemini、通义千问或自定义 OpenAI 兼容接口。预设会填入 API Base URL 与模型名称；模型可按账号实际开通权限修改。Claude 使用原生 `/messages` 和工具调用协议，其余使用 `/chat/completions`。

1. 在同一张 AI 服务卡片中选择服务商、填写模型名称并配置 API Key。常用服务使用内置地址；仅自定义接口或已有的非默认地址显示 URL 输入框。
2. 选择“每次最大输出 Token”：1,024 / 2,048 / 4,096 / 8,192 / 16,384 / 32,768，默认 8,192。它限制每次模型请求的输出；输入 Token 和多步骤任务的累计用量不计入此限制。所选模型必须支持相应上限，输出截断会提示提高上限。
3. 直接填写 API Key 后保存，服务商与密钥一起生效。密钥按服务商、API Base URL 与本地后端地址分别保存在 SecretStorage；切换服务商或地址会清空尚未保存的密钥草稿。

普通模型设置存入用户级 `forexplore.llm`，不读取仓库提供的同名设置。模型请求携带当次配置快照，经本地 IDE 后端独立路由。只有默认 DeepSeek 服务可以继续使用后端 `DEEPSEEK_API_KEY`；其他服务和自定义地址缺少对应 Key 时会明确报错。自定义兼容服务即使不验证鉴权，也需要填写非空占位 Key。

参考工程路径可通过“浏览文件夹（可多选）”调用系统文件夹选择器，仍可手动输入。选择仅更新当前草稿，保存后才登记与索引；取消选择保留草稿。支持最多 20 个工程，并对 Windows 路径的大小写和斜杠差异去重。

Logo 源文件为 `media/recast-logo.svg`，扩展列表使用 `media/recast-logo.png`，活动栏使用同一图形的单色版本 `media/forexplore.svg`。

设置页的保存操作固定在右下角，可随时点击或按 Ctrl+S（macOS：⌘S）。快捷键仅在 RECAST 设置打开时接管保存，并使用与按钮相同的表单校验流程；保存中和目录选择中不会重复提交。
