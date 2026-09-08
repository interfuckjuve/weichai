# 离线模块建模与任务 Context：运行说明

当前实现复用同一份版本化代码索引支撑任务检索和复用迁移。浏览器工作台与 VS Code 扩展共用页面、Host、模块产物和检索服务。

## 启动真实工作台

需要 Node.js 24、已安装的 workspace 依赖、SeekDB，以及与数据库向量维度一致的 embedding 服务。基础索引和源码检索不要求配置生成模型；新建功能模块需要可用的 Agent 分析服务，已有有效的 Agent 产物可以直接读取。以下命令在项目根目录执行。

已有兼容 `/v1/embeddings` 的本机模型服务时：

```bash
export CODE_INTELLIGENCE_SEEKDB_HOST=127.0.0.1
export CODE_INTELLIGENCE_SEEKDB_PORT=2881
export CODE_INTELLIGENCE_SEEKDB_USER=root
export CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION=384
export CODE_INTELLIGENCE_EMBEDDING_URL=http://127.0.0.1:4021/v1/embeddings
export CODE_INTELLIGENCE_EMBEDDING_MODEL=Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78
export CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX='query: '
export CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX='passage: '
npm run dev:code-workbench -- --target /path/to/target --reference /path/to/reference --database forexplore_code_workbench
```

`--target` 和 `--reference` 可重复指定。默认页面端口为 4040，查询端口为 4041，端口占用时会自动递增并输出实际地址。服务只监听本机回环地址。工程范围由启动参数确定；在浏览器中展开模块、切换工程、检索和导出均读取真实服务。

已有基础索引时可用 `--rebuild-modules` 重新构建模块树和对应投影，不重新解析源码。`--hierarchy-url` 与扩展环境变量 `FOREXPLORE_MODULE_HIERARCHY_URL` 指向层级决策服务；该服务必须已经注入可用的 planner。默认 adaptation server 没有外部 planner 绑定，层级接口会返回 503，单独设置 URL 不会自动启用模型判断。

小工程可通过 `--adaptation-url` 接入已有整项目 Agent 分析接口，大工程通过层级 planner 分支判断功能边界。没有可用分析服务时，功能模块会提示服务缺失，基础索引和源码检索仍可使用。仅在容量测试需要目录结构基线时显式添加 `--structural-baseline`；该模式不代表业务模块语义效果。已有库可使用 `--register-only` 读取已发布结果。

扩展的层级 planner 默认复用 `adaptationApiUrl`。小工程的原 Agent 分析路径还要求适配服务设置 `ADAPTATION_SEMANTIC_INDEX_ENABLED=true`，并将 `SEMANTIC_QUERY_PORT_URL` 指向实际取证端口；本次浏览器服务使用 4051，VS Code 扩展默认使用 8790，可通过 `FOREXPLORE_SEMANTIC_QUERY_PORT` 调整。仅启动仍关闭语义索引的默认配置，不能完成小工程的自动规划。

SeekDB 密码使用 `CODE_INTELLIGENCE_SEEKDB_PASSWORD`。未显式设置的连接参数可从已有 `services/retrieval-service/.env` 的 `SEEKDB_HOST/PORT/USER/PASSWORD` 读取。默认使用独立数据库 `forexplore_code_workbench`；更换 embedding 模型或维度时使用另一个数据库并重新建库。

项目提供 `scripts/serve-local-embeddings.mjs` 用于本机 E5 推理，需要在独立工具目录安装 `@huggingface/transformers` 并准备对应模型缓存：

```bash
FOREXPLORE_EMBEDDING_TOOLS=/path/to/model-tools \
FOREXPLORE_MODEL_CACHE=/path/to/model-cache \
node scripts/serve-local-embeddings.mjs
```

未配置 embedding 时，底层 store 使用确定性 hash 向量，只适合容量和接口测试，不能据此判断中文语义检索质量。浏览器不接收模型密钥。

## 数据闭环

1. 注册工程并捕获源码快照，保留文件哈希、相对路径、项目归属和解析诊断；后续查询读取固定版本的源码。
2. 解析声明及依赖，大仓采用可回收解析子进程，每批最多 64 个文件或 8 MiB 输入，避免 Tree-sitter 原生内存随全仓累积。结构事实统一绑定后按批次写入 SeekDB 的构建中版本，完成后才发布为可检索版本。
3. 以项目、目录和已解析依赖构造有界候选组，再按职责与规模逐分支细化模块。模型输入默认最多包含 64 个候选组，这不是每模块 64 个文件的切分规则，也不同于解析批次大小。最终树允许不同分支在不同深度停止，预算耗尽的范围保留为待细化节点。模块文件归属、符号引用和依赖证据通过校验后持久化，并生成模块检索投影。
4. 前端展示已发布的模块结果、文件及符号、完整覆盖统计和解析来源；节点展开与搜索按当前工程版本每页读取 80 项，解析缺口位于下方诊断区域。
5. 自然语言任务在指定工程版本内进行全文及向量混合召回，从命中的声明和源码块出发有限扩展依赖，再读取实际源码并编译 Context。
6. 返回结构化 `ContextPacket` 和可直接交给编程 Agent 的 Markdown；前端支持预览、选择、复制和下载，MCP 仅输出一次 Markdown。

生产流程优先读取已有有效的 Agent 产物，并使用已配置的 Agent 服务生成新功能模块。未配置服务时不会自动发布纯结构结果冒充功能模块；确定性的目录和 API 分组仅在显式启用结构基线时提供。已有整项目 Agent 提案和旧扁平模块产物继续兼容。

## 自适应模块层级

模块仍以 `ProjectModule[]` 持久化，通过 `parentId` 表示包含关系：根节点为 `null`，其余节点引用父模块。`nodeKind` 独立表达 `module` 或 `subsystem`，不能用目录深度或固定层号推断子系统。旧产物缺少这些字段时按顶层模块处理，不凭空补充子系统或细化完成状态。

每次局部判断可以停止或拆分，发布节点分别记录以下 `refinement` 状态及原因：

| 状态 | 含义 |
| --- | --- |
| `leaf` | 当前范围停止拆分，成为直接拥有文件的叶模块 |
| `split` | 形成至少两个有效子模块，父节点仅聚合后代 |
| `deferred` | 因预算、深度上限或其他明确原因暂未继续细化，保留可检索范围 |

`decisionSource` 区分 `model`、`structural` 和 `budget`，界面分别显示模型判断、结构分析和预算限制。达到预算上限不会被标记为完整细化。节点的语义类型、树深度和细化状态是三个独立字段。

小项目可以直接成为一个叶模块；多职责项目可以形成多个浅层分支；大分支可以继续拆分。各分支不要求等深，不为凑齐“子系统、模块、子模块”而生成空节点或重复单子节点。类、函数和代码块仍由基础索引独立提供，浅模块树不会省略这些符号索引。

建模器的 `maxDepth` 预算按允许的模块层数计数；展示中的节点 `depth` 和层级汇总 `maxDepth` 则从根节点 `0` 开始。比如允许最多 4 层时，实际节点最大深度不超过 3。模块深度不计入目录、文件和符号的展示层级。

只有没有子模块的终端节点（`leaf` 或 `deferred`）直接保存 `sourceFiles`；拆分后的父节点该字段为空，通过子节点汇总后代文件。Host 校验父节点存在、无环、兄弟文件归属互斥及范围覆盖，避免父子重复拥有文件。父模块的文件统计和检索范围来自后代聚合，不把父层、子层的文件数重复相加。文件覆盖率与待细化节点数量分别报告。

前端只把真正的根模块放在顶层，并保留“子模块 → 目录 → 文件 → 类或函数”的实际路径。展开仍按每页 80 个子节点读取；完整树保留在 Host 的版本化索引中，首屏只发送浅层页面及完整统计。参考模块目录区分顶层范围数与全树节点数，选中节点可查看细化状态、原因和判断来源。子系统粒度仅在已发布产物确有 `nodeKind: subsystem` 且对应检索投影就绪时启用。

已接入层级模型决策接口与显式结构基线路径。前一轮未获源码外发授权时，自适应层级验收使用本机结构基线，功能模块展示复用此前真实 Agent 产物。用户现已授权本轮 DeepSeek 请求，新推理产物需独立核验模型来源、计划哈希、发布时间与检索投影，不能沿用旧产物的验收结论。模型接口的可调用性、协议测试与真实模型的业务边界判断质量分别记录。

## 查询契约

`POST /v1/task-search` 接收以下请求。工程 ID 和版本从当前 Host 的工程展示或只读查询端口获得，不能填本地文件路径：

```json
{
  "requestId": "upload-size-change",
  "requirement": "修改文件上传总大小限制和单个文件大小限制",
  "granularity": "function",
  "scopes": [{ "repositoryId": "REGISTERED_ID", "analysisRevision": "READY_REVISION", "projectId": "PROJECT_ID" }],
  "budget": { "maxTokens": 8000, "maxLatencyMs": 10000, "maxFiles": 12, "maxSourceLines": 800 }
}
```

粒度为 `auto/function/class/module/subsystem`，默认自动。手动选择决定主结果层级，支持性依赖可跨层级。当前范围没有实际子系统产物或投影尚未就绪时，界面禁用子系统选项，API 返回能力缺口，不替换成其他粒度。旧版本支持固定源码查询，已失效的模块检索投影会报告不可用。

返回包包括固定版本与分析哈希、主结果、带行列范围及哈希的源码证据、依赖关系、证据缺口和服务端预算用量。行列从 1 开始，结束位置不包含在片段内。`usage.tokens` 使用 `cl100k_base` 对最终完整 Markdown 计量，不是字符估算，也不是 JSON 响应体的大小。前端不提供 token 控制或用量计数，需求请求只包含需求、范围和粒度；Host 采用内部默认预算，手动筛选导出仅标记“已筛选”。上述 HTTP/MCP API 保留内部预算协议。

工作台默认允许一次任务查询等待最多 30 秒，HTTP/MCP 调用者通过 `budget.maxLatencyMs` 指定自己的上限。等待上限与实测延迟分别记录，不代表查询能在该时间内必然完成。

`knownEvidence` 可传已持有的证据 ID 和内容哈希，避免重复源码。预算不足、部分解析或未解析依赖会在 `gaps` 中说明；结果有缺口时为 `partial`。取消会传递到查询和模型请求。

MCP 的 `search_task_context` 接入方法见 [扩展说明](../apps/vscode-extension/README.md)。任务 MCP adapter 只连接本机数值回环地址，并校验 Host 可见工程及已发布版本。

## 验收与边界

可复现脚本：

- `scripts/verify-task-context-live.mts`：真实 HTTP 查询、中文需求、各粒度、取消、源码范围及哈希、精确 token 预算。
- `scripts/verify-task-context-mcp.mts`：真实 MCP 客户端启动服务，验证原查询工具与任务工具、源码去重及范围校验。
- `scripts/verify-task-workbench-ui.mjs`：真实页面桌面与移动端截图、模块展示、查询、复制和下载一致性。
- `scripts/verify-task-search-controls-ui.mjs`：真实页面没有 token 控件、计数或高级设置；请求仅包含需求、范围和粒度，返回的 Context 可下载。`TASK_CONTROLS_EXPECT_SEMANTIC=1` 对照原始恢复报告核验旧功能模块；`TASK_CONTROLS_EXPECT_FRESH_MODEL=1` 要求当前产物来源为 Agent、分析及投影就绪、计划哈希不同于旧产物且等于本次模型运行的产物哈希，并将中文模块卡片与当前服务数据逐项比较。新模型模式必须通过 `TASK_CONTROLS_EXPECTED_PLAN_HASH` 和 `TASK_CONTROLS_FRESH_AFTER` 指定真实模型运行报告中的产物哈希和开始时间。可用 `TASK_CONTROLS_MODEL_REPOSITORY`、`TASK_CONTROLS_MODEL_PROJECT` 选择参考工程，用 `TASK_CONTROLS_PREVIOUS_PLAN_HASH` 覆盖默认读取的旧产物哈希。
- `scripts/verify-fresh-target-model-ui.mjs`：对目标工程独立验证新模型产物哈希、Agent 来源、投影就绪及桌面/手机上的模块树、功能摘要和项目总结，使用相同的哈希与时间环境参数；不将目标工程临时改为参考工程。
- `scripts/verify-task-indexing-scale.mts`：真实大型源码库的容量、建库、模块覆盖和局部查询；使用 hash 向量的容量结果与模型语义质量分开记录。
- `scripts/verify-task-large-workbench-ui.mjs`：大仓初始响应大小、根模块及子节点分页、未展开节点搜索、完整统计与桌面/移动端展示。
- `scripts/verify-adaptive-hierarchy-ui.mjs`：真实层级产物的父子关系、全量模块遍历、父节点聚合计数、逐分支细化状态，以及桌面/手机的模块到源码展开。通过 `ADAPTIVE_UI_PROFILE=small` 和 `ADAPTIVE_UI_EXPECT_MAX_DEPTH=0` 可核验小项目直接停在叶模块；模型与异深断言分别由 `ADAPTIVE_UI_EXPECT_MODEL=1`、`ADAPTIVE_UI_EXPECT_UNEVEN=1` 显式启用。

验收报告写入 `logs/task-context-live-report.json`、`logs/task-workbench-ui.json` 和 `logs/task-indexing-scale-20260908.json`。报告中的 `passed`、规模、耗时和资源峰值是本机实测结果，失败尝试也会保留。

当前依赖图基于实际解析证据；语法解析不能代替编译器的完整类型解析、动态调用分析或跨语言接口绑定。结构元数据仍需驻留内存。Context 是预算内的候选实现和有限依赖证据，不保证全局最小或行为闭合；未匹配任务的拒答能力、排序质量和千万行规模需要独立基准验收。

## DeepSeek 大仓实测（2026-09-08）

用户授权后，本轮对 VS Code 主工程执行了新的 DeepSeek 层级判断并发布检索投影，复用原有 7,702 个文件的固定源码索引。模型运行开始于 `2026-09-08T14:05:37.586Z`，新计划哈希为 `sha256:18c9895fa845ef4068aa0249682bfe8debcc7745b4c4420f5fa479575e0958cf`。页面展示来源为 Agent 分析，模型与结构判断的节点来源分别保留。

| 项目 | 本轮真实结果 |
| --- | --- |
| 模块层级 | 72 个节点、4 个根范围，其中 66 个模块、6 个子系统；终端节点深度覆盖 0 至 3，最多 4 层 |
| 细化状态 | 14 个已拆分节点、1 个叶节点、57 个待细化节点；文件覆盖 7,702 / 7,702 不代表所有功能边界已完成细化 |
| 模型判断 | 服务日志记录 `deepseek-v4-flash` 完成 24 次层级请求，产物采纳 16 个模型决策；树节点中 15 个标记模型来源、57 个保留结构来源，完成响应、有效决策和节点数分别统计 |
| 发布耗时 | 本轮模块建模 73,842 ms，检索投影 24,139 ms；没有重新解析全部源码 |
| 完整性 | 遍历全部 72 个模块节点，父子文件、类型与方法聚合计数一致，无重复文件计数 |
| 首屏 | 114,516 字节，初始仅 4 个根节点；选择主工程 6,986 ms，后续 READY 7 ms |
| 子系统检索 | 手动 `subsystem` 实际命中“会话”，7,917 ms，6 个文件的源码证据，状态为 `partial` |
| 模块检索 | 手动 `module` 实际命中“CLI入口”，15,537 ms，6 个文件的源码证据，状态为 `partial` |
| 自动检索 | `auto` 查询返回“会话”等结果，8,231 ms，5 个文件的源码证据，状态为 `partial` |

在 1440×1000 桌面和 390×844 手机完成真实路径“启动引导 → 客户端引导 → CLI入口 → 主进程启动 → main.ts → configureCommandlineSwitchesSync”展开。选中模块后，中文功能说明、待细化状态和原因均保留，文件声明列表不被选择动作改变；子系统选项与 6 个真实子系统产物一致。两个视口无页面横向溢出或浏览器错误，截图已实际查看。页面仍只有需求、检索范围和粒度，没有 token 控制或用量计数。

本轮大仓检索仍使用 64 维 hash 向量，需求包含模块名和真实 API 标识符。三项查询通过版本、范围及真实源码证据检查，验证模型模块已接入检索和 Context 交付；该单次结果不代表自然语言任务集的语义排序质量。57 个范围因模型决策失败、输入或运行预算限制等原因仍待细化，未解析依赖与有界源码截取也继续记录在结果缺口中。

页面报告及截图位于 `logs/agent-hierarchy-live/adaptive-hierarchy-large-ui.json` 和同目录 `adaptive-hierarchy-large-*.png`；检索报告为 `logs/agent-hierarchy-live/adaptive-hierarchy-retrieval.json`，实际 Context 为同目录 `adaptive-hierarchy-context.md`。模型完成记录来自 `logs/agent-model-service-20260908.log` 中本次开始时间至 `14:07:04.790Z` 的层级请求，建模和投影耗时来自 `logs/agent-workbench-scale-live.log`。当前大仓工作台入口为 `http://127.0.0.1:4042`。

## DeepSeek 小工程实测（2026-09-08）

Java 目标工程 `commons-fileupload-java-skeleton` 的本次运行开始于 `2026-09-08T14:06:17.098Z`，已发布新的 Agent 功能模块提案。计划哈希为 `sha256:309411a1d166ec0485dbba11208c586b1ca42efdde502fd56cc326dfb9dda04c`，不同于原始恢复产物；`modeling.strategy=agent`、分析和检索投影均为 `ready`。本次仍为 8 个浅层功能模块，没有为小工程补充子系统或固定层数。模块分别为核心上传 API 与解析框架、磁盘文件条目实现、Servlet 容器集成、Portlet 容器集成、通用工具基础设施、MIME 编码解码、已废弃的旧版 API、测试支持与测试用例。

新产物分配了 58 / 61 个文件，另 3 个文件逐项说明原因：`pom.xml` 为不支持解析的配置文件，`FileUploadBase.java` 和 `MultipartStream.java` 在原始结构索引中解析失败。因此本次模型没有将缺少直接结构证据的文件强行归属到模块。新覆盖结果与此前恢复产物的 60 / 61 分开记录，相关解析限制继续展示。

真实 UI 验收独立读取当前产物与投影元数据，在 1440×1000 桌面和 390×844 手机逐项核对模块名称、选中模块的中文职责和项目总结；新哈希与本次完成结果完全一致，更新时间晚于本次运行开始时间。页面没有横向溢出或浏览器错误，截图已实际查看。检索、筛选和完整 Context 下载另行通过，桌面和手机查询各返回 4 条源码证据，服务耗时 967 ms 和 817 ms；需求请求无预算字段，控件、结果计数及设置中均无 token 配置。查询仍使用 hash 向量，仅作为真实接口回归。

Rust 参考工程 `account-stream-rs` 的首次新提案因文件归属校验失败而未发布，继续保留原先 10 个功能模块；当前任务状态为 `failed`、投影为 `pending`。归属修复与相关测试已经完成；重新调用 DeepSeek 被自动审批拒绝，审批要求明确 `account-stream-rs` 的索引和源码片段发送至 DeepSeek 的授权，已向用户请求具体确认，当前暂停该重跑。本段不把保留的旧模块记为新的模型结果。

工作台入口为 `http://127.0.0.1:4044`，当前查询端口为 4051。目标工程报告为 `logs/agent-semantic-live/fresh-target-model-ui.json`，对应截图为同目录 `fresh-target-model-*.png`；完整检索控件回归为同目录 `task-search-controls-ui.json`。上述 UI 验收只读取已发布结果，没有触发额外模型调用。

## 功能模块恢复与界面简化（2026-09-08）

本轮页面保留需求、检索范围和检索粒度，删除全部 token 输入、滑条、上限配置及结果计数，没有把这些设置移入高级面板。浏览器发送的 `TaskSearchIntent` 只有 `requirement`、`scope` 和 `granularity`，协议校验拒绝额外预算字段；Host 使用内部默认值。筛选后的导出区域仅标记“已筛选”，复制和下载继续交付实际 Context。

原始功能模块从 `forexplore_code_intelligence` 只读复制到独立库 `forexplore_agent_restore_20260908`。恢复保留原始源码快照、分析版本、模块名称、职责说明、`planHash` 和产物 `contentHash`，原始 payload 深比较一致；原库恢复前后检查一致。旧产物本来没有 `modeling` 字段，本次没有补造模型来源或新的层级元数据。

| 工程 | 恢复结果 |
| --- | --- |
| `account-stream-rs` 参考工程 | 10 个原始功能模块，覆盖 15 / 16 文件；16 个文件磁盘哈希与快照一致；未归属项为配置文件 `Cargo.toml` |
| `commons-fileupload-java-skeleton` 目标工程 | 8 个原始功能模块，覆盖 60 / 61 文件；59 个文件磁盘哈希一致，另 2 个测试文件仅工作区换行差异，使用原始快照验证并保留工作区；未归属项为 `pom.xml` |

该次恢复只在副本库重建检索投影，使用 384 维 hash 向量，没有执行新的生成模型或 embedding 模型请求。恢复发生于本轮新源码外发授权之前，仅证明旧功能分析结果和真实页面恢复，不作为新的模型推理效果或中文检索质量评测。此前 Java 产物中的解析失败与未解析依赖仍按原始诊断保留。

该次恢复验收的工作台入口为 `http://127.0.0.1:4044`，历史查询端口为 4045；当前新模型实测的查询端口已改为 4051，因为 Fetch 禁用 4045，导致模型无法通过该端口读取证据。在 1440×1000 桌面和 390×844 手机完成真实查询、完整 Context 下载、筛选状态和设置检查，无浏览器错误或页面横向溢出。两次查询各返回 4 条源码证据，服务耗时分别为 1,102 ms 和 874 ms；这些观测仅用于接口验收。复用迁移中的 10 张参考模块卡片按顺序逐项对照原产物，中文功能名称、职责摘要和选中详情均一致，截图已实际查看。

回归分批执行：核心批次 143 个测试通过，后续补充批次 32 个测试通过；token 控件改动的 4 个聚焦测试文件、31 个测试也通过。各批次范围存在重叠，不把数字相加作为独立测试总数。扩展与 webview 类型检查、核心构建及 webview 构建通过。

恢复证据见 `logs/agent-module-restore.json`；真实页面报告见 `logs/task-search-controls-ui.json`，卡片截图为 `logs/task-search-controls-semantic-catalog-desktop.png` 和 `logs/task-search-controls-semantic-catalog-mobile.png`。前一轮结构树与旧扁平容量数据仍在下方分别保留。

## 自适应层级结构基线（2026-09-08）

以下保留调用 DeepSeek 之前的本机结构基线。该轮复用固定源码版本，只重建模块树及检索投影，`modelDecisionCount=0`，没有把目录层级标为模型识别的业务子系统；这些统计不代表上方新模型产物。

| 项目 | 新层级实测 |
| --- | --- |
| 小工程 | TypeScript Commons FileUpload 目标工程，5 个文件形成 1 个根叶模块；展示深度为 0，产物记录 1 层，不强行增加子系统 |
| 大工程 | VS Code 主工程 7,702 个文件形成 4 个顶层范围、1,277 个模块树节点，生成 3,831 条模块摘要视图 |
| 细化状态 | 936 个叶模块、197 个已拆分节点、144 个待细化节点；终端节点实际深度覆盖 0 至 7，最多 8 层 |
| 完整统计 | 全量遍历 1,277 个模块节点，父节点文件、类型及方法统计等于其直接子节点聚合；顶层文件总数仍为 7,702 |
| 首屏规模 | 大工程初始响应 114,712 字节，初始渲染 4 个根节点；本轮主工程选择 7,087 ms，后续 READY 7 ms；每次子节点读取仍不超过 80 项 |
| 深层模块检索 | `module` 查询实际命中深度 6 的 `inlineEdits`，往返 8,668 ms，3,995 / 4,000 tokens，包含 9 个文件的有界源码证据 |
| 自动粒度 | 同需求自动检索往返 7,508 ms，3,908 / 4,000 tokens，5 个文件，主结果包含模块、函数及类 |
| 子系统能力 | 结构基线没有子系统节点，显式请求返回 `unavailable`，151 tokens、5,030 ms，未替换为其他粒度 |
| 中文语义回归 | 独立 384 维 E5 数据库的真实 HTTP 10 个用例通过；默认 4,000 token 下自动查询为 3,956 tokens、1,440 ms，函数查询为 3,971 tokens、969 ms，实际上传限制正文断言通过 |

小工程桌面及手机已验证 `package → src → compatibility.ts → Base64Decoder → decode` 的真实导航。选择模块后再次读取文件声明列表，节点 ID 保持不变，不把模块插入文件成为伪方法。界面同时显示节点的细化状态、原因和判断来源。

大工程在 1440×1000 桌面和 390×844 手机验证了 `vs → base → browser → Local files` 四级真实模块分支，再展开原始目录、`animatedValue.ts`、`AnimatedValue` 及其方法。该终端模块为 `deferred`，选中后保留细化原因和结构判断来源；Host 确认选择不会清空深层节点详情。两个视口均无页面横向溢出或浏览器错误，截图已实际查看。目录与模块使用不同图标；保留原始目录路径会出现相同名称的模块和目录层，它们分别表示归属范围与源码位置。

大仓任务检索继续使用 64 维 hash 向量，以上两次模块和自动查询均为 `partial`，包含代表性源码而非模块全部后代内容。目录边界、当前未解析依赖和 144 个待细化范围仍是结构基线的实际限制。真实 E5 回归的结果不能代替大仓自然语言质量评测。

报告见 `logs/adaptive-hierarchy-small-ui.json`、`logs/adaptive-hierarchy-large-ui.json`、`logs/adaptive-hierarchy-retrieval.json` 及 `logs/adaptive-context-live/task-context-live-report.json`；实际模块 Context 保存于 `logs/adaptive-hierarchy-context.md`。下方保留改造前基线，避免把新树节点数与旧扁平模块数混用。

## 本机验证记录（2026-09-08，扁平模块旧基线）

以下模块数量、投影数量、建模耗时与根节点分页来自自适应层级改造之前的扁平模块基线。源码快照与任务 Context 的实测记录保留；这些模块数不是新树的叶节点数，新的父子层级及页面结果需单独重新验收。

容量语料为真实 VS Code `src`，提交 `c5f02db50896ef310d3c909628e651675644fcef`，没有复制文件或生成新源码来扩充规模。

| 项目 | 实测结果 |
| --- | --- |
| 文件与行数 | 7,708 个文件，2,356,695 物理行；其中 source 角色 1,696,036 行，test 角色 649,069 行，其余为已有生成文件和配置等 |
| 结构事实 | 287,471 个符号、117,420 条语法依赖；7,691 个文件解析成功，10 个部分解析，7 个不支持 |
| 模块划分 | 3 个工程、1,541 个模块，全部 7,708 个文件有归属；最大工程为 7,702 个文件、1,537 个模块 |
| 检索投影 | 287,471 条符号、300,121 条源码片段、4,623 条模块摘要投影 |
| 解析资源 | 121 个可回收子进程；解析期间父子进程合计采样峰值约 376 MiB，全流程主进程峰值约 1.39 GiB；不含数据库和模型进程 |
| 建模耗时 | 扫描解析约 385 秒，模块划分与持久化约 24 秒；结构写入与投影分别约 869 秒和 784 秒，受本机数据库日志配额影响 |
| 中文任务检索 | 真实 Commons FileUpload Java 源码与 TypeScript 工程，384 维 multilingual E5；HTTP 10/10 用例通过，MCP 6/6 用例通过 |
| 默认 Context 预算 | 4,000 token 内返回真实 `parseRequest` 实现，包含总上传量和单文件大小的检查及异常分支；服务端对最终 Markdown 精确计量 |
| 大仓任务 Context | 在最大工程查询 `CodeEditorWidget executeEdits editor text model`，约 4.96 秒返回 17 条源码证据，合计 7,813 / 8,000 token；包含 `CodeEditorWidget.executeEdits` 第 1282:2 至 1314:3 行列的完整实现 |
| 大仓页面 | 首次返回 80 个根模块，初始响应约 260 KiB；主工程全部 1,537 个模块可分 20 页读取，未展开的 `executeEdits` 搜索约 87 ms |

容量数据库使用 64 维 hash 向量；上表的中文语义检索使用另一个数据库及真实 E5 模型，两组结果不能互相替代。构建记录保留第一次误选小工程的查询数据，并明确将其排除出大仓任务检索验收。

大仓 Context 验收将整仓读取接口替换为抛错保护，确认任务检索仅使用有界查询，并独立核对磁盘文件哈希、源码范围、完整方法正文及最终 token 数。返回状态为 `partial`，原因包含未解析依赖和预算裁剪。该次结果验证真实源码返回和单任务延迟，不代表自然语言任务集的召回率。

全文召回的工程过滤由相关 `IN` 子查询改为等价的显式关联，并在候选 ID 融合后才读取入选文档正文。同一个大仓需求的任务耗时从约 19.2 秒降至 4.96 秒，未改变查询文本、候选数量或 embedding。页面概览也改用数据库聚合；主工程首次选择从约 22.8 秒降至 6.7 秒，后续节点页为毫秒级。浏览器导航经过预热，不计作冷启动测量。

最终页面验收在 1440×1000 桌面和 390×844 手机视口通过。工作台中的同一大仓任务往返约 5.09 秒，服务耗时约 4.92 秒，返回 7,843 / 8,000 token；目标方法的源码预览与快照一致。页面使用的文件及行数预算与容量脚本不同，因此两次 Context 内容和 token 数不要求相同。结果见 `logs/task-large-workbench-ui.json`，截图位于同目录。MCP 默认启动也已验证 stdout 只输出协议消息，启动日志写入 stderr。

本次保留的本机入口为 `http://127.0.0.1:4040`（真实 E5 中文检索）和 `http://127.0.0.1:4042`（百万行结构建模及标识符任务检索）。两者使用独立数据库，可在服务重启后通过 `--register-only` 读取已发布结果。

本机 SeekDB 曾因日志配额触发写入等待。在核对 Docker 数据盘位于 E 盘且空间充足后，将在线 `log_disk_size` 从 8G 经 12G 调整为 24G，并执行一次 minor freeze。提交等待恢复正常，但没有据此认定检查点回收问题已经解决。上述构建耗时是带此环境影响的单次观测，不作为稳定吞吐指标；启动脚本不会自动修改这些数据库参数。
