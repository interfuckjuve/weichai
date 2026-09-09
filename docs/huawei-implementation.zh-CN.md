# huawei 实现与验证记录

基线为 `chiparon/weichai` 的 `9-8-v` 分支、`c3f09d3`。本分支将计划书中可以直接接入现有服务的机制实现为可运行代码，并重写第四至第八章。大仓历史数据仍归属于原实验，不算作本次测试结果。

## 已接通的机制

| 环节 | 实现与输入约束 | 验证 |
| --- | --- | --- |
| 目标语言 | Tree-sitter 接入 C、C++、Kotlin 及 ArkTS 的 TypeScript 兼容语法；原有七种语言保留 | 声明、名称、导入、源码位置；扩展打包后的独立解析进程 |
| 跨语言关系 | JNI 短导出名；由模块注册、初始化函数和属性描述符共同确定的 N-API 回调；同模块源集的 KMP expect/actual | 正确端点、缺少注册、模块错配、重载/多平台歧义、注册变更后的增量等价 |
| 解析资源 | 默认最多两个解析进程、16 MiB 在途源码；每个进程按文件数/字节量回收；解析结果落盘 | 两个进程受单文件字节预算限制时不会同时处理源码，放宽预算后并行结果一致 |
| 模块建模 | 默认三个同级决策并行，父级校验后展开子级；预算提前预留、结果按队列顺序组装 | 并发峰值、顺序一致性、模型调用上限、合法归属 |
| 分支恢复 | 请求身份关联固定范围、分析哈希、候选和源码证据；校验后的决策写入模块产物；恢复时重新校验并复用 | 重建协调器后无需重复模型调用；强制重分析绕过旧缓存；超时回复不写有效检查点 |
| 任务检索 | 三类召回通道并行；同一请求的查询向量共用一个在途请求；仍按固定版本和粒度查询 | 原有检索、HTTP/MCP 和历史版本测试；新增向量请求合并测试 |
| 上下文 | 保留主实现，按需求词项、证据角色和命中实体计算新增覆盖；重叠范围惩罚与估算 token 成本用于排序，最终文本精确验预算 | 互补异常处理优先于重复校验；相同源码不同位置不被误删；token、行数与文件数约束 |
| 观测 | `ContextPacket.usage.retrieval` 返回源码读取/交付字节、载荷放大率、片段数、检索扩展及编译耗时 | 指标按实际返回正文计算，零交付时放大率为 null |
| 行为验收 | 宿主配置命令和只读验收文件；测试前要求最新源码已编译；记录源码快照与计划哈希；最后一次写入使旧结果失效 | 真实命令拒绝行为错误、修复后通过、禁止改验收文件、重启回滚与鉴权 HTTP 路由 |

在途字节预算允许单个超限文件独占运行，避免永远等不到空位；这种情况下观测值记录实际文件大小。`peakCombinedRss` 是进程采样估计，不能代替全系统峰值测量。

## 行为测试配置

沿用工作区翻译服务的原有启用开关、目标目录、鉴权令牌与编译命令配置。新增 `ADAPTATION_WORKSPACE_VERIFICATION`，值为 JSON：

```json
{
  "command": {
    "executable": "node",
    "args": ["tests/behavior.mjs"],
    "timeoutMs": 120000
  },
  "protectedFiles": ["tests/behavior.mjs", "tests/expected.json"]
}
```

`protectedFiles` 应列出宿主验收脚本、断言数据及其相关配置；它们必须预先存在，不能同时进入任务的 `writeFiles`。命令与验收文件哈希写入运行记录，恢复时核对配置是否改变。模型只能调用无参数的 `run_tests`，无法通过工具参数替换命令或判定标准。

`POST /v1/workspace-translations` 创建任务；`GET /v1/workspace-translations/:id` 查看计划、改动和验证记录；原有 cancel、resume、rollback 路由保留。只有最新源码的编译与固定测试都通过，完成结果才标记 `behavior-verified`。没有配置固定测试的运行仍标记 `compilation-only`；通过固定用例不等于证明所有输入上的行为等价。

## 测试与构建

2026-09-09，在 Windows、Node.js 24.16.0、npm 11.13.0 下验证。为避免混入另一个目录迁移，将基线源码和本次改动组合成干净验证副本；`npm ci --no-audit --no-fund` 成功，语言依赖统一使用兼容的 Tree-sitter 0.21.1，Kotlin 语法固定为 1.0.1，无需强制忽略 peer dependency。

| 工作区 | 通过 | 跳过 |
| --- | ---: | ---: |
| workspace-adapters | 2 | 0 |
| workflow-core | 35 | 0 |
| code-indexer | 48 | 0 |
| seekdb-adapter | 3 | 0 |
| adaptation-http-adapter | 5 | 0 |
| retrieval-service | 50 | 0 |
| code-intelligence-service | 157 | 0 |
| adaptation-service | 192 | 1 |
| adaptation-mcp-server | 7 | 0 |
| semantic-index-mcp-server | 16 | 0 |
| workflow-web | 4 | 0 |
| vscode-extension | 135 | 0 |
| 合计 | 654 | 1 |

跳过项是原有 `RUN_DOTNET_INTEGRATION=1` 开关控制的 .NET 集成测试。测试中同时修正了三个与机器或随机身份有关的夹具问题：明确召回同名顶层函数而非随机选到类方法；固定临时 Git 仓库的换行转换；将 Windows 临时短路径转为规范路径。产品断言未被删除。

构建通过：code-indexer、code-intelligence-service、adaptation-service，VS Code 扩展及 Webview 类型检查，以及根目录 `npm run build`。另以真实 IPC 启动打包后的解析进程，分别解析 C、C++、Kotlin 和 ArkTS 文件，确认新增原生依赖被包含。构建器原有的 CJS `import.meta` 静态警告仍存在；打包路径使用随扩展提供的 worker，烟雾测试验证了这条实际路径。

核心复现命令：

```powershell
npm ci --no-audit --no-fund
npm test
npm run build:code-intelligence
npm run build:adaptation
npm run typecheck --workspace forexplore-vscode
npm run build
```

端到端固定任务位于 `services/adaptation-service/src/workspace-translation-runtime.test.ts`：从真实 Java 源文件建库、检索固定版本证据，执行两个目标文件的生成，运行真实语法检查与行为断言，再回滚。模型工具调用是确定性脚本；没有用这一测试宣称远程大模型的泛化能力。

## 仍需工程扩展和独立验收的部分

当前结果是与现有服务接通的实现增量。以下内容仍属于计划书后续工程或实验目标：

- 完整 ArkUI 语法、JNI 动态注册及重载长名称、任意 N-API 注册表达式、SDK/编译宏/构建目标语义；当前缺证据时保留未解析，不猜测目标。
- 结构事实与检索投影分片，以及按变化类型仅重建受影响的模块产物。当前基础索引复用已有解析事实，跨语言绑定重新构建，并验证全量/增量一致；决策缓存用于同一输入的恢复，不跨源码版本复用。
- 跨多个宿主的租约与原子任务抢占。当前协调器在单宿主内串行发布项目产物，分支并行及超时隔离不等同于分布式调度。
- 工作区翻译 HTTP 服务与现有迁移审阅界面的完整联调；已有检索 UI 和 MCP 入口保留。
- 使用真实数据库、远程模型、完整 SDK 和大仓任务集评测召回质量、行为通过率与时延。源码载荷指标不包含数据库物理 I/O 或网络协议开销，不能据此宣称吞吐/准确率目标达标。

第四至第八章主稿、可编辑 TeX 及 PDF 构建方式见 `docs/guochuang-revision-notes.zh-CN.md`。
