# 多语言代码智能索引与 Agent 解析 SDD（PR29 修订版）

## 1. 目标与完成标准

用户通过 VS Code Webview 管理多个历史代码库路径，系统从这些路径发现项目，建立符号和依赖索引，由 Agent 解释模块边界，并将解析结果与 Summary 存入 SeekDB。用户随后选择目标工程，系统执行相同的解析流程，前端展示该工程对应的结果。

本 SDD 定义应交付的行为，不代表 PR29 已经实现。接口、存储类或单元测试分别存在，只能证明对应组件可用；完成标准是用户能从界面走通以下流程：

~~~text
添加或更新多个历史库路径
  → 路径校验、仓库注册
  → 项目发现、结构与符号索引、依赖分析
  → 按项目调度 Agent 模块解析
  → Host 校验解析结果
  → SeekDB 保存模块结果和 Summary、更新检索投影
  → 前端展示历史项目及其解析状态和内容

选择目标仓库中的目标项目
  → 检查索引和模块解析是否仍有效
  → 复用有效结果，或执行上述相同解析流程
  → 前端切换到该目标项目的符号、依赖、模块和 Summary
~~~

代码理解与迁移执行是两个阶段。生成代码理解 Summary 不以用户批准迁移计划为前置条件；修改源码、执行迁移或写回代码仍遵守迁移流程的审批规则。

## 2. v1 范围

### 2.1 支持语言

首批结构索引支持已注册 grammar 的 Java、C#、TypeScript、JavaScript、Python、Go 和 Rust。LanguageRegistry 管理扩展名、grammar、版本和能力等级，并允许后续扩展。

结构索引输出文件、项目归属、声明、容器、符号、import/export、源码范围、解析诊断和证据标识。未注册 grammar 的源码文件记录为 unsupported 或 skipped；manifest 等配置文件仍可由项目发现器处理。

Tree-sitter 提供结构证据。Java/C# 可以使用现有专用分析器或 LSP 增强 definition、references 和 diagnostics；其他语言在没有 semantic provider 时展示结构能力。v1 不要求完整调用图、动态依赖求值、反射分析或宏展开。

### 2.2 项目与依赖

ProjectDiscovery 根据显式 manifest 发现项目，包括 Maven、Gradle、.NET、Node、Python、Go 和 Cargo 工程。一个仓库可以包含多个 ProjectRecord。无 manifest 的源码目录必须有明确的兜底归属和说明，避免文件从分析范围中消失。

SyntacticDependencyResolver 处理显式 import/export、project reference 和受支持的 manifest 项目依赖。关系保留 resolved、unresolved 或 ambiguous 状态及来源证据。依赖分析不等同于完整调用图。

### 2.3 界面与存储

产品入口是 apps/vscode-extension 的 Webview，独立 web/ 原型不属于本次交付要求。生产模式使用 SeekDB 持久化；内存实现仅用于开发和测试，界面应明确其非持久性质。

文件监听可在后续增加。v1 必须支持保存配置后处理变更、手动刷新、失败重试和重新打开面板后的状态恢复，不要求用户重启扩展才能更新路径。

## 3. 架构与职责

~~~text
Webview 用户意图
  → VS Code Host
    → RepositoryRegistry
    → AnalysisCoordinator
      → RepositoryScanner
      → ProjectDiscovery + TreeSitterStructuralIndexer
      → SyntacticDependencyResolver + 可选 SemanticProvider
      → IndexStore（SeekDB）
    → 项目模块解析调度
      → ArchitectAgent ↔ SemanticQueryPort
      → Host 校验与发布
      → IndexStore + SeekDbProjection
    → 带仓库、项目和版本范围的展示模型
  → Webview
~~~

| 模块 | 职责 |
| --- | --- |
| RepositoryRegistry | 规范化路径，管理稳定 repositoryId、显示名、注册关系和仓库状态；绝对路径保留在 Host 侧 |
| AnalysisCoordinator | 调度结构扫描，复用未变文件，决定是否生成新 revision，完成索引后切换活动版本 |
| LanguageRegistry / TreeSitterStructuralIndexer | 管理语言能力，解析结构并输出可追溯证据 |
| ProjectDiscovery / SyntacticDependencyResolver | 识别项目边界、文件归属及显式依赖 |
| SemanticProvider | 提供真实 LSP 或专用分析器证据，并声明能力和来源 |
| IndexStore | 持久化版本化项目、文件、符号、依赖、诊断、模块解析任务和产物 |
| SeekDbProjection | 将符号、源码片段和有效 Summary 转成可重建的检索文档 |
| SemanticQueryPort | 提供受 repositoryId、analysisRevision 和适用 projectId 约束的只读查询 |
| ArchitectAgent | 按需取证，提出模块划分、用途、核心 API、模块依赖和 Summary |
| VS Code Host | 保存配置、调度项目解析、处理选择、校验产物、发布结果和组装展示模型 |
| semantic-index-mcp-server | 代理只读查询；不拥有扫描器、数据库或索引生命周期 |

历史库与目标库复用上述实现，角色只影响展示和后续迁移权限。同一路径同时作为历史库和目标工作区时应复用仓库身份和索引，角色或选择变化本身不触发内容失效。

现有 RepositoryStaticAnalysis 可继续用于迁移执行兼容。前端需要的形状转换可以保留，但必须转换统一索引的内容，不能重新扫描并形成第二份分析事实。

## 4. 前端操作与调度

### 4.1 多历史库路径配置

界面提供多个路径字段，支持添加、编辑、删除、保存和查看每个路径的处理结果。用户点击保存后，Host 必须：

1. 规范化路径、解析文件系统别名并去重，校验目录是否存在且可读。
2. 为新增路径注册仓库，为已有路径复用 repositoryId；标签或角色变化保留身份。
3. 将路径替换解释为移除旧注册关系并添加新路径；v1 不自动猜测两者是否为仓库搬迁。
4. 对新增仓库及需要刷新的仓库执行结构索引，随后为发现的各项目调度模块解析。
5. 对移除的历史路径停止后续历史库任务，并从当前历史列表和检索范围中移除；若仍是目标工作区，可保留其目标角色。
6. 逐仓库返回成功、失败、等待服务或需要重试的状态。一个路径失败不阻塞其他仓库。

保存配置成功与解析完成是两个状态。界面应在保存后立即确认配置已保存，再持续展示各仓库的处理状态。

扫描期间再次保存配置时，新请求必须进入后续处理，不能直接返回正在执行的旧请求并丢失更新。允许合并尚未执行的请求，以最新配置为准；已经移除的路径不能因旧任务稍后结束而重新进入当前列表。

移除配置不要求物理删除全部历史数据。保留的数据必须退出当前列表和默认检索范围，不能因保留归档而继续表现为活动历史库。

### 4.2 历史项目解析

历史库结构索引就绪后，Host 为其中每个项目创建或复用模块解析任务。默认解析目标是说明该项目的功能模块、用途、核心 API 和依赖，用户无需输入迁移目标或把历史库打开为当前工作区。

Agent 或查询服务不可用时，符号和依赖结果仍可浏览，模块解析状态应显示等待服务或失败原因，并提供重试入口。结构索引 ready 不代表模块解析已完成。

### 4.3 选择目标工程

前端从可用目标仓库的 ProjectRecord 中列出项目，显示名称、相对路径、所属仓库、索引状态和语言能力。v1 的目标路径来自已打开的本地 VS Code 工作区；多根工作区中的项目都应可选择。

选择以 repositoryId + projectId 表达，Host 解析其当前活动 analysisRevision，并执行以下操作：

1. 将该项目设为当前目标，更新页面标题和数据范围。
2. 确认结构索引可用，必要时执行统一索引流程。
3. 复用有效模块解析结果；缺失、失败或过期时启动同一项目解析流程。
4. 展示该项目的符号、依赖、模块、Summary 和处理进度。

选择不是仅保存下拉框状态，也不能依赖用户另外执行“模块迁移计划审阅”命令。当前编辑器所在文件夹不得覆盖显式选择。文件、类和方法选择属于目标项目内的进一步定位。

快速切换项目时，旧请求可以继续完成并缓存，但其返回结果不得覆盖新目标视图。对已移除或不再存在的项目，应清除选择并提示重新选择。

### 4.4 刷新与历史版本浏览

界面区分刷新当前项目、刷新单个历史库和刷新全部历史库。修改一个仓库不应无条件重新解析其他仓库。Host 必须保证同一仓库的结构发布顺序，并合并重复的项目解析任务。

结构 revision 以仓库为单位；刷新当前项目时仍由所属仓库的统一扫描器检查结构变化，Agent 模块解析按项目调度。发现其他项目结果因版本更新而失效时，按第 5.3 节处理。

历史 revision 是独立的只读浏览选择。切换历史版本不改变活动版本，不启动当前版本解析，也不把历史 Summary 标记为当前结果。页面需展示正在浏览的版本。

## 5. 索引版本与模块状态

### 5.1 分开表达处理状态

仓库结构索引状态：

~~~text
registered → indexing → ready | degraded | failed
~~~

项目模块解析状态：

~~~text
missing | stale | failed → queued → analyzing → validating → ready
                                             ↘ failed
~~~

ready 表示该项目有效的模块结果已持久化且可读取；检索投影的同步状态单独记录。degraded 索引可以支持有证据的部分解析，Summary 必须保留相关覆盖范围和诊断，不能声称分析了缺失文件。

### 5.2 无变更刷新

扫描完成后比较影响分析结果的内容指纹，包括文件内容、相关 manifest、解析配置和解析器版本。analysisHash 不应包含随机 revision、扫描时间等无关字段。

内容指纹未变化时：

- 保持 activeRevision 不变，复用结构索引和已发布 Summary。
- 可更新扫描时间和诊断状态，不使 Summary 过期。
- 不重复调用 Agent，不删除有效 Summary 检索投影。

全量扫描只表示重新检查全部文件，不表示必须创建不同的事实版本。需要重新执行 Agent 时使用明确的“重新解析模块”操作，不能把普通刷新当作该操作。

### 5.3 有变更刷新

内容或解析配置变化时，创建新 revision，增量重解析受影响的文件和依赖。构建期间继续提供旧版本的完整结果，并显示正在更新；新结构索引及其基础检索投影完成后才切换 activeRevision。

切换后，旧 revision 的 Summary 退出当前结果和默认检索，作为历史产物保留。Host 为新版本中缺少有效 Summary 的项目安排 Agent 解析。v1 允许仓库内各项目重新解析，不要求跨 revision 复用项目 Summary。

Agent 运行期间若活动版本变化，旧任务的结果不得发布成新版本 Summary。Host 应保留可解释的任务状态，并确保最新版本仍有任务可执行。

## 6. 数据模型与事实来源

SeekDB 保存以下独立表或等价集合：

~~~text
repositories
analysis_revisions
projects
files
symbols
dependency_edges
diagnostics
module_analysis_jobs
module_artifacts
search_documents
~~~

结构记录由 repositoryId + analysisRevision 定位，项目内数据另外携带 projectId。symbolKey 使用限定名、签名和声明特征等稳定信息，行号只用于定位。

模块解析任务至少保存范围、解析配置标识、状态、错误摘要和对应产物标识。扩展重启后可恢复状态；中断的任务应转为可重试，不得永久显示 analyzing。

每份项目模块产物至少包含：

| 字段 | 含义 |
| --- | --- |
| repositoryId、analysisRevision、projectId | 产物所属的仓库、不可变版本和项目 |
| analysisHash | 该版本结构分析的内容指纹 |
| analysisProfile | 模块解析的目标、提示词或策略版本等可判定复用条件 |
| planHash | 对规范化模块提案计算的哈希，绑定提案内容 |
| status、createdAt、updatedAt | 有效性和生成时间 |
| modules、dependencies、summary | 模块边界、模块关系和项目摘要 |
| evidenceIds、coverage、diagnostics | 来源证据、分析覆盖范围和限制 |

同一仓库、版本、项目和解析配置下，只能有一个被选为当前结果的产物。重新解析成功时替换当前指向，旧产物可留存；不同项目的产物不得相互覆盖。

analysisHash 与 planHash 分别描述索引和提案，不要求两者相等。发布时分别验证索引绑定和提案哈希。

IndexStore 是解析事实来源，search_documents 和已有 code_symbols 是可重建的检索投影。单库或单项目更新只能影响对应范围，禁止全库 clear()。投影失败时保留已保存产物，记录同步失败并支持重试，不因重建检索索引而重复调用 Agent。

.forexplore/module-summary.json 仅作为显式兼容导出。它的缺失、陈旧或被用户修改，均不得改变 SeekDB 中的当前结果或前端模块划分。

## 7. Agent 与查询接口

### 7.1 查询范围

SemanticQueryPort 提供以下只读能力，可由独立 MCP server 代理：

~~~text
list_repositories
get_repository_overview
list_projects
get_file_structure
search_symbols
get_symbol
find_definition
find_references
get_dependencies
get_diagnostics
read_source_excerpt
~~~

list_repositories 返回仓库目录和可查询版本，不要求调用方事先提供 revision。其余仓库内查询必须提供 repositoryId + analysisRevision；项目查询另携带 projectId 或等价过滤条件。

结果返回范围信息和 evidenceId。provider、evidenceLevel、relativePath、sourceRange 按实际证据类型提供：项目或仓库汇总不伪造源码范围，manifest 发现结果不伪装成 LSP 证据。

源码证据的能力等级必须准确：Tree-sitter 为 structural，真实 LSP 或 Java/C# 专用语义分析器可为 semantic。unresolved 和 ambiguous 依赖保留原始状态。

### 7.2 模块解析

ArchitectAgent 接收固定的 repositoryId、analysisRevision、projectId、解析目标和配置，通过工具循环取证。项目内文件构成主要解析范围；跨项目依赖可作为上下文查询，但不得未经说明将外部文件归入本项目模块。

提案应包括模块名称、用途、所属文件和符号、核心 API、模块依赖、项目 Summary、证据标识和覆盖说明。未分析或无法归属的文件必须明确列出，不能通过静默排除制造完整解析的表象。

同一提案只能引用同一仓库 revision 的证据。跨仓库代码检索属于后续复用或迁移功能，不混入本次项目解析的事实范围。

Agent 不接收任意绝对路径，不扫描文件系统，不启动 LSP，不访问 SeekDB，不修改活动版本或写入产物。adaptation-service 负责模型调用与取证循环，解析器、存储和生命周期仍由代码智能服务及 Host 管理。

## 8. 校验、发布与审批

### 8.1 代码理解结果发布

Host 在发布前必须验证：

1. 请求范围仍注册且版本仍可作为当前结果；项目在该 revision 中存在。
2. analysisHash 与该 revision 的结构索引一致。
3. 提案符合 schema，planHash 根据实际提案重新计算并核对。
4. 引用的 evidenceId、文件、符号和依赖属于固定范围，模块归属和覆盖声明一致。
5. 当前项目、解析配置与待发布任务匹配，没有被后续任务替代。

校验通过后，Host 将产物写入 module_artifacts，更新该项目当前产物指向，随后更新检索投影并通知前端。活动版本校验和当前产物发布需具备事务或等价条件写入保护，避免校验后版本已切换仍发布旧结果。

代码理解 Summary 自动发布，不要求用户批准迁移计划。校验失败时显示失败原因和重试入口，不把 Agent 原始回答当作有效结果。

### 8.2 迁移执行审批

迁移计划可以引用已发布的模块解析结果，但必须单独记录目标、约束、审批和执行状态。Summary ready 不表示用户批准了迁移，用户批准迁移也不能补偿无效的索引证据。

原有 reviewModuleMigrationPlan 等命令继续服务于迁移流程。它们不得成为历史库解析、Summary 保存或前端展示的必经入口。

## 9. 前端结果展示

Host 从统一索引和模块产物组装展示模型，至少提供：

- 历史仓库及其项目列表、路径配置状态、结构索引与模块解析状态。
- 当前目标项目、所查看 revision、语言能力和更新时间。
- 项目范围内的符号树、依赖及诊断，包括未解析关系。
- Agent 模块划分、模块用途、核心 API、模块依赖和项目 Summary 正文。
- 缺失、处理中、失败、过期和历史版本状态，以及刷新或重试入口。

Summary 状态徽标不能替代 Summary 正文。结构索引就绪、模块解析就绪和检索投影同步状态应分别可见。

模块树必须读取同一范围的 SeekDB 产物。没有有效模块解析时，可以展示明确标注的文件或项目树，不得将目录分组标成 Agent 模块。浏览历史版本时，符号、依赖和 Summary 必须全部属于所选版本。

前端结果须携带 repositoryId、analysisRevision、projectId 和适用的证据或产物标识，以便验证一致性。普通界面使用名称、路径和状态表达，内部 ID 放在详情中。数据库凭据不进入 Webview。

## 10. 代码落点与交付顺序

复用 PR29 已有模块，按以下顺序补齐调用链：

| 顺序 | 代码落点 | 交付结果 |
| --- | --- | --- |
| 1 | packages/contracts/src/code-intelligence.ts；services/code-intelligence-service/src/index-store.ts、seekdb-index-store.ts | 项目级模块产物范围、任务状态和当前结果约束 |
| 2 | services/code-intelligence-service/src/analysis-coordinator.ts；apps/vscode-extension/src/code-intelligence-host.ts | 无变更复用、配置更新不丢失、最新版本解析调度 |
| 3 | services/adaptation-service/src/tool-calling-architect-runtime.ts；apps/vscode-extension/src/module-plan-client.ts | 可供历史库和目标项目共用的模块解析请求、证据与覆盖校验 |
| 4 | apps/vscode-extension/src/extension.ts、protocol/messages.ts | 保存路径、项目选择、重试与解析发布的完整调用链 |
| 5 | apps/vscode-extension/src/module-explorer.ts、Webview 组件；services/code-intelligence-service/src/seekdb-projection.ts | 按项目和版本读取产物、展示 Summary 正文并同步检索投影 |

前端读取模块产物所需的只读查询应由统一服务提供，返回完整范围和正文，不让 Webview 直接访问数据库。

SemanticQuery HTTP server 必须有实际启动和可用性检查路径。缺少模型或 SeekDB 配置时，界面应指出失败环节，不能仅返回笼统的 ready 状态。v1 不以新增 MCP 工具数量或扩大 LSP 支持范围作为完成依据。

## 11. 验收场景

### 11.1 用户流程

| 编号 | 操作 | 通过条件 |
| --- | --- | --- |
| A1 | 通过界面添加两个历史库，其中一个含两个项目 | 两库独立注册和索引，各项目进入 Agent 解析，SeekDB 保存结果，前端可浏览模块与 Summary 正文 |
| A2 | 编辑、添加或删除路径并保存 | 无需重启即可处理最新配置；已移除路径退出当前列表和检索范围；其他仓库结果保留 |
| A3 | 扫描中再次更新路径列表 | 最新配置最终生效，没有丢失请求或旧任务复活已移除仓库 |
| A4 | 在多项目工作区选择目标项目，再切换另一个项目 | 复用或执行统一解析；符号、依赖和 Summary 随选择切换；迟到响应不覆盖新视图 |
| A5 | 只配置历史路径，不将历史库打开为工作区 | 可以完成 Agent 解析和 Summary 发布，无需执行迁移命令或迁移审批 |

### 11.2 一致性与恢复

| 编号 | 操作 | 通过条件 |
| --- | --- | --- |
| B1 | Summary 发布后，在源码未变时刷新、重新打开面板或重启扩展 | 活动 revision 和有效 Summary 保留，不重复调用 Agent，正文仍可读取 |
| B2 | 修改单个仓库文件后刷新 | 受影响结构和依赖更新；其他仓库不重建；旧 Summary 过期，新项目解析任务可完成并发布 |
| B3 | Agent 运行时修改源码并产生新 revision | 旧任务不能成为当前结果，最新版本仍能被解析；不会跨版本混用证据 |
| B4 | 删除或篡改本地 module-summary.json，再打开模块树 | 展示仍与 SeekDB 产物一致，本地文件不覆盖或替代当前事实 |
| B5 | 切换到历史 revision | 符号、依赖和 Summary 属于所选版本，并明确为历史结果，不改变活动版本 |
| B6 | 让一个仓库路径无效，或使 Agent、检索投影暂时失败后重试 | 其他仓库可继续；失败阶段可识别；投影重试不重复调用 Agent，任务不会永久停留在运行中 |
| B7 | 同一仓库的两个项目分别完成解析，随后重新解析其中一个 | 两项目 Summary 均可读取，更新范围相互隔离，每个范围只有一个当前结果 |

### 11.3 能力与边界

- 七种已注册 grammar 使用真实源码验证声明、范围和诊断；适用的 import/export 语法得到正确结构证据。
- 支持的 manifest 得到项目记录和显式引用；无法确定的依赖保持 unresolved 或 ambiguous。
- 未注册 grammar 的文件有可见状态，不伪造符号或完整覆盖结论。
- semantic 等级仅来自实际可用的 LSP 或专用分析器。
- 发布校验拒绝错误项目、错误 revision、未知证据、不一致哈希和错误覆盖声明。
- Summary 自动发布不授予源码修改权限，迁移写回仍执行独立审批。

验收证据至少包括：状态与边界单元测试、真实扫描器的双仓库集成测试，以及 Webview → Host → 查询服务 → Agent → SeekDB → Webview 的端到端验证。持久化验收使用真实 SeekDB；模型故障场景可用可控替身，完整成功流程需至少一次真实 Agent 工具调用。纯内存测试或手工写入 Summary 不能替代持久化与发布链路验收。

## 12. PR29 对照与待补齐项

以下为 PR29 提交 a1a4196 的审查基线，用于区分已有基础设施与本 SDD 的目标行为：

| 已有实现 | 待补齐要求 |
| --- | --- |
| 多路径配置、仓库注册、项目发现、结构索引和基础依赖分析 | 索引完成后按历史项目调度 Agent，提供可恢复的项目解析状态 |
| revision-scoped Agent 接口，目标工作区迁移审阅命令可调用 | 提供独立代码理解流程，历史库解析不依赖工作区选择和迁移审批 |
| SeekDB 结构存储及审批后 Summary 发布能力 | 按项目发布代码理解产物，保留无变更刷新的有效结果，并处理真实变更后的重解析 |
| ProjectRecord 下拉选择 | 选择驱动目标范围、解析任务和模块结果视图，避免只更新状态 |
| 新结构索引可供模块树使用 | 模块划分和 Summary 正文改读 SeekDB，移除本地 JSON 作为展示事实来源 |

已复现的回归场景：源码无变化、24 个文件复用且 analysisHash 相同，普通增量刷新仍生成新 revision，将旧 Summary 标记 stale，当前 revision 的 Summary 数量变为 0。B1 必须覆盖并修复这一行为。

PR29 在上述连接补齐并通过验收前，应描述为“多语言结构索引、语义查询和部分 Agent 接入”，不能标记为用户配置历史库到目标项目展示的完整交付。
