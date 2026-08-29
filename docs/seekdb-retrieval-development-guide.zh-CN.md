# 工作区、代码索引、SeekDB 检索与适配开发总览

本文档以 2026-07-25 的最新 `upstream/main`（`851df04`）为准，覆盖 SeekDB
检索、工作区目标、独立代码索引器和 Java→C# 适配流水线的实现与后续集成，
面向需要继续开发、调试或替换实现的同事。

主要变更来源：

- [chiparon/weichai#2](https://github.com/chiparon/weichai/pull/2)：SeekDB 检索、真实 TypeScript 模块树和方法级索引。
- `13f0fd2`：将运行时目标切换为 C# workspace 与 `ModuleSymbolPort`。
- `851df04`：拆出独立 code-indexer，并加入 Java→C# adaptation pipeline。

## 1. 改动目标

当前代码在不破坏原有 Mock 工作流的前提下，提供四块可替换能力：

1. 通过 `ModuleSymbolPort` 加载 C# 目标工作区和可选择符号。
2. 通过独立 `@forexplore/code-indexer` 发现语料仓库并提取方法级文档。
3. 使用 SeekDB 保存代码符号，通过向量、全文和混合检索返回真实候选实现。
4. 提供 Java→C# LLM 翻译、独立编译、自动修复和回填 Adapter。

Web 运行时的适配和回填仍默认使用 Mock Adapter。`adaptation-service` 已提供真实
Adapter，但尚未在 `web/src/main.tsx` 组合。只有配置了
`VITE_RETRIEVAL_API_URL`，前端才会把 `CodeSearchPort` 替换为 SeekDB HTTP
Adapter；未配置时行为与原项目一致。

## 2. 必须先理解的两个数据域

### 2.1 目标工程

目标工程是“准备被补全或修改的项目”。当前运行时目标为：

```text
fixtures/target-system/forexplore-csharp-workspace
```

`packages/workspace-adapters` 通过 `ModuleSymbolPort` 暴露一棵 C# 静态符号树。
树中的 `SettlementOrchestrationService.SettleBatchAsync` 属于目标符号，用于构造
检索请求。仓库仍保留 TypeScript Vite 扫描器，但它不再是当前 Web 运行时的数据源。

### 2.2 复用语料库

复用语料库是“用于寻找参考实现的项目集合”。默认索引：

```text
fixtures/code-corpus
```

检索候选只来自已经写入 SeekDB 的语料。目标工程中的
`SettlementOrchestrationService` 不会因为出现在左侧模块树中，就自动出现在右侧候选列表。
如果确实需要“搜索本项目已有实现”，需要为目标工程添加 manifest，并把它作为
`index:corpus` 的输入。

这两个数据域的关系是：

```text
目标工作区 Adapter
  -> ModuleSymbolPort
  -> 选择目标 class/function（当前为 C#）
  -> SearchRequest
     + candidateLanguages（可选硬过滤）
  -> SeekDB 复用语料库
  -> 候选实现
  -> AdaptationPort（当前 Web 默认 Mock；真实 Adapter 仅支持 Java -> C#）
  -> BackfillPort
```

## 3. 总体架构

```text
fixtures/target-system/forexplore-csharp-workspace
            |
            | workspace-adapters
            v
ModuleSymbolPort
            |
            v
web
  |  未配置 VITE_RETRIEVAL_API_URL -> Mock CodeSearchPort
  |
  +-- 已配置 VITE_RETRIEVAL_API_URL
            |
            v
packages/seekdb-adapter
            |
            | POST /v1/search
            v
services/retrieval-service
  | query expansion
  | embedding
  | vector/full-text retrieval
  | fusion and reranking
            |
            v
          SeekDB
            ^
            |
fixtures/code-corpus
            |
            | @forexplore/code-indexer
            +-----------------------

候选 Java 实现
  -> @forexplore/adaptation-service
  -> DeepSeek Java→C# 翻译
  -> dotnet/csc 独立编译与最多 3 轮修复
  -> FilePatch / BackfillAdapter
```

依赖边界保持为：

```text
workflow-web -> workflow-core -> contracts
workflow-web -> workspace-adapters -> workflow-core
workflow-web -> mock-adapters
workflow-web -> seekdb-adapter -> contracts
code-indexer -> contracts
retrieval-service -> code-indexer + contracts + SeekDB
adaptation-service -> workflow-core + contracts + DeepSeek/.NET
```

生产代码没有反向依赖 Mock Adapter。前端的运行时组合入口只有
`web/src/main.tsx`。

## 4. 代码目录与职责

### 4.1 共享契约

| 文件 | 改动 |
| --- | --- |
| `packages/contracts/src/module.ts` | 统一 TypeScript/Python/Java/C#/Rust/Go、模块种类、行号和实现状态 |
| `packages/contracts/src/indexing.ts` | 定义 code-indexer 与 retrieval-service 共用的 `IndexedCodeDocument` |
| `packages/contracts/src/retrieval.ts` | 定义检索模式、候选和可选 `candidateLanguages` 硬约束 |
| `packages/workflow-core/src/module-target.ts` | 将可选择的模块节点转换为 `ModuleTarget`，保留行号和实现状态 |

`ImplementationStatus` 有两个值：

```ts
type ImplementationStatus = 'implemented' | 'unimplemented';
```

模块树还允许 `record` 和 `interface` 作为展示节点，但当前只有 `class` 和
`function` 可以转换为工作流目标。文件夹、文件、record 和 interface 只负责组织和导航。

### 4.2 目标工作区与模块树

| 文件 | 职责 |
| --- | --- |
| `packages/workspace-adapters/src/csharp-workspace.ts` | 当前 C# fixture 的静态工作区树 |
| `packages/workspace-adapters/src/static-module-symbol.adapter.ts` | 实现 `ModuleSymbolPort.loadTree/resolveTarget` |
| `packages/workspace-adapters/src/index.ts` | 导出当前 workspace ID 与 Adapter 实例 |
| `web/build/target-module-tree.ts` | 扫描 TypeScript 文件，通过 Babel AST 提取 class、方法和顶层 function |
| `web/build/target-module-tree.test.ts` | 验证符号、签名、行号和未实现状态 |
| `web/vite.config.ts` | 注册 `virtual:target-module-tree`，监听目标工程源码变化并触发页面重载 |
| `web/src/main.tsx` | 通过 `workspaceModuleSymbols.loadTree()` 加载 C# 树并注入 `App` |
| `web/src/features/target-selection/ModuleTree.tsx` | 展示真实目录和符号节点，只允许选择 class/function |

当前运行时流程：

```ts
const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
```

这棵 C# 树目前是手工维护的静态元数据，不会自动跟随 `.cs` 源码变化。修改 C#
fixture 的声明、路径或行号后，需要同步更新 `csharp-workspace.ts`。

仓库同时保留 Vite TypeScript 扫描器，供后续动态 workspace 集成使用。它的扫描规则是：

- 扫描 `.ts` 和 `.tsx`。
- 跳过 `node_modules`、隐藏目录和 `dist`。
- 使用 `@babel/parser` 的 TypeScript/JSX 插件。
- 提取顶层 class、class method 和顶层 function。
- 保存真实相对路径、声明签名和源码行号。
- 方法体抛出 `NotImplementedError` 或 `Error("Not implemented...")` 时标记为
  `unimplemented`。
- Windows 路径统一转换为 `/` 后再做监听范围判断。

要切换当前运行时目标，应提供新的 `ModuleSymbolPort` Adapter，并在
`web/src/main.tsx` 替换：

```ts
const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
```

不要把新工作区继续硬编码到 UI 组件；应保持 `ModuleSymbolPort` 边界，后续可换成
IDE、LSP、文件系统或远程 Workspace Service。

### 4.3 浏览器 SeekDB Adapter

| 文件 | 职责 |
| --- | --- |
| `packages/seekdb-adapter/src/seekdb-code-search.ts` | 实现 `CodeSearchPort`，将浏览器请求发送到检索服务 |
| `packages/seekdb-adapter/src/seekdb-code-search.test.ts` | 验证请求、响应、AbortSignal 和错误处理 |
| `packages/seekdb-adapter/src/index.ts` | 包公共导出 |

`withSeekDbSearch()` 只替换 `WorkflowPorts.search`：

```ts
const workflowPorts = retrievalApiUrl
  ? withSeekDbSearch(mockWorkflowPorts, { baseUrl: retrievalApiUrl })
  : mockWorkflowPorts;
```

因此当前状态是：

| Port | 实现 |
| --- | --- |
| `CodeSearchPort` | SeekDB 或 Mock，取决于前端环境变量 |
| `CodeAdaptationPort` | Web 默认 Mock；`adaptation-service` 另有 Java→C# 实现 |
| `CodeBackfillPort` | Web 默认 Mock；`adaptation-service` 另有文件系统实现 |

### 4.4 检索服务

| 文件 | 职责 |
| --- | --- |
| `src/config.ts` | 读取并校验环境变量 |
| `src/runtime.ts` | 创建 Store、EmbeddingProvider 和 SearchEngine |
| `src/server.ts` | 服务启动和优雅关闭 |
| `src/http-server.ts` | `/health`、`/v1/search`、CORS、请求校验 |
| `src/types.ts` | 服务内部文档、Store、Embedding 和 Engine 接口 |
| `src/seekdb-store.ts` | 建表、批量写入、向量检索、全文检索 |
| `src/embedding.ts` | 离线 Hash Embedding 和 OpenAI-compatible Embedding |
| `src/text-analysis.ts` | 标识符拆词、查询扩展和词项重叠计算 |
| `src/search-engine.ts` | 检索模式、候选融合、契约评分和最终排序 |
| `src/corpus-indexer.ts` | 向后兼容的薄封装，实际调用 `@forexplore/code-indexer` |
| `src/corpus-index-cli.ts` | 从源码语料建立索引 |
| `src/index-cli.ts` | 从 JSONL 文档建立索引 |
| `src/schema-cli.ts` | 单独初始化数据库结构 |

对应测试都放在同目录的 `*.test.ts` 中。

### 4.5 独立 Code Indexer

| 文件 | 职责 |
| --- | --- |
| `services/code-indexer/src/discover.ts` | 发现 manifest、校验元数据和 `sourceRoot` |
| `services/code-indexer/src/extractor.ts` | 多语言声明提取、签名、摘要和源码片段 |
| `services/code-indexer/src/index.ts` | 扫描仓库并输出 `IndexedCodeDocument[]` |
| `services/code-indexer/src/cli.ts` | 将提取结果输出为 JSON Lines |

`retrieval-service` 通过 workspace 依赖调用这个包，索引职责不再复制在数据库服务中。

### 4.6 Adaptation Service

| 文件 | 职责 |
| --- | --- |
| `services/adaptation-service/src/translator.ts` | 独立 Translator Agent 调用 DeepSeek 做 Java→C# 翻译和编译错误修复 |
| `services/adaptation-service/src/compiler.ts` | 使用 .NET SDK 或 csc 做独立编译 |
| `services/adaptation-service/src/adaptation-adapter.ts` | 编排翻译、最多 3 轮修复、映射和 FilePatch |
| `services/adaptation-service/src/backfill-adapter.ts` | 将 FilePatch 写回指定项目根目录 |

真实 Adapter 当前只接受：

```text
strategy = translate
candidate.language = Java
target.language = C#
```

`compileIntegrated()` 目前仍是返回成功的占位实现；Web 组合入口也尚未启用这些
Adapter。因此它们是可调用的服务模块，不等于 Web 已经完成生产级端到端接入。

## 5. SearchRequest 与 HTTP API

共享请求结构：

```ts
interface SearchRequest {
  target: ModuleTarget;
  requirement: string;
  topK: number;
  repositoryScopes?: string[];
  candidateLanguages?: Language[];
}
```

服务端限制：

- `requirement` 必须为非空字符串。
- `topK` 必须是 `1` 到 `50` 的整数。
- `target.kind` 只能是 `class` 或 `function`。
- `candidateLanguages` 如存在必须是非空、已支持语言数组。
- 所有检索都必须命中服务端 `RETRIEVAL_ALLOWED_REPOSITORIES`；未配置允许仓库时，服务以 `503` 拒绝检索而不是搜索全库。
- 客户端若显式传递 `repositoryScopes`，必须是非空、格式合法且完全属于该服务端允许列表；否则返回 `400` 或 `403`。
- 请求体最大 1 MiB。
- 无效 JSON 返回 `400`。
- 超大请求返回 `413`。
- 检索或数据库异常返回 `503`。

### 5.1 健康检查

```http
GET /health
```

成功响应：

```json
{
  "status": "ok",
  "storage": "seekdb"
}
```

这个接口会实际执行 SeekDB `SELECT 1`，不是仅检查 Node.js 进程。

### 5.2 检索

```http
POST /v1/search
Content-Type: application/json
```

成功响应：

```json
{
  "candidates": []
}
```

浏览器 Adapter 会验证响应至少包含合法的候选数组、候选 ID、标题和评分对象。

## 6. 语料索引

### 6.1 默认输入

`index:corpus` 默认扫描：

```text
fixtures/code-corpus
```

原 Java 翻译参考工程已经移动到
`fixtures/code-corpus/forexplore-reference-java`，因此默认单个根目录仍覆盖全部
复用语料。C# skeleton 已移动到 `fixtures/target-system/forexplore-csharp-workspace`，
不会被默认当成候选实现索引。

### 6.2 Manifest

每个待索引仓库需要 `manifest.json` 或 `dataset-manifest.json`：

```json
{
  "repository": "example-repository",
  "language": "TypeScript",
  "sourceRoot": "src",
  "license": "MIT",
  "dependencies": [],
  "synthetic": false
}
```

必要字段：

- `repository`：非空字符串。
- `language`：契约支持 `TypeScript`、`Python`、`Java`、`C#`、`Rust`、`Go`。

可选字段：

- `sourceRoot`：相对仓库根目录的源码路径，不允许逃逸到仓库外。
- `license`：缺省时写入 `Unknown`。
- `dependencies`：字符串数组。
- `synthetic`：为 `true` 时给候选增加“合成评估语料”风险标签。

Manifest 存在但 JSON 或元数据错误时会直接中止索引，不再静默跳过。

### 6.3 扫描与提取规则

索引器会：

- 跳过 `node_modules`、`target`、`build`、`__pycache__` 和隐藏目录。
- 跳过常见测试目录及 `*.test.ts`、`*_test.go`、`test_*.py` 等测试文件。
- 按 manifest 声明的语言过滤文件。
- 提取 class/type、方法和函数。
- 为每个符号保留签名、注释摘要、源码片段、路径和行号。
- 将 camelCase、路径词和正文一起写入全文搜索字段。

`fileExtensions` 已注册 `.cs -> C#`，并由索引器单元测试覆盖。C# 语料会和其他
manifest 声明的语言一样进入扫描；声明提取仍基于正则，复杂 C# 语法需要额外验证。

符号 ID 格式：

```text
repository:relative/path:line:symbolName
```

当前源码索引器以正则和作用域深度为主，不是所有语言的完整 AST。大规模接入真实
企业仓库时，建议按语言替换为 Tree-sitter、语言编译器 API 或 LSP 索引。

### 6.4 添加一个新仓库

假设仓库目录为 `D:\Corpus\payment-service`：

1. 在仓库根目录添加合法 manifest。
2. 确认 `sourceRoot` 指向真实源码。
3. 执行：

```powershell
npm run index:corpus --workspace @forexplore/retrieval-service -- `
  D:\Corpus\payment-service
```

传入多个根目录时可一次索引多个仓库。默认是增量 upsert；加 `--replace` 会先清空
`code_symbols` 表，生产环境使用前应确认影响范围。

## 7. Embedding

### 7.1 Hash Embedding

默认配置：

```text
SEEKDB_EMBEDDING_PROVIDER=hash
SEEKDB_VECTOR_DIMENSION=384
```

它使用单词和字符 trigram 做确定性 feature hashing：

- 不下载模型。
- 不需要网络和 API key。
- 适合本地联调、CI 和功能冒烟测试。
- 不能替代生产级语义模型。

### 7.2 OpenAI-compatible Embedding

配置示例：

```text
SEEKDB_EMBEDDING_PROVIDER=openai
SEEKDB_EMBEDDING_URL=https://api.openai.com/v1/embeddings
SEEKDB_EMBEDDING_API_KEY=...
SEEKDB_EMBEDDING_MODEL=text-embedding-3-small
SEEKDB_VECTOR_DIMENSION=1536
```

实现包含：

- 30 秒请求超时。
- HTTP 和 JSON 错误处理。
- 向量数量、index 唯一性、维度和有限数值校验。
- 按响应 `index` 恢复输入顺序。

改变模型或向量维度后不能直接复用旧表。应使用新表名，或者明确删除并重建专用索引表，再重新索引全部文档。

## 8. SeekDB 表结构

默认数据库与表：

```text
forexplore.code_symbols
```

关键字段：

| 字段 | 内容 |
| --- | --- |
| `id` | 稳定符号 ID，主键 |
| `title` | class/function/method 名称 |
| `repository` | 语料仓库标识 |
| `language`、`kind` | 结构过滤字段 |
| `path`、`signature` | 源码定位和契约 |
| `summary`、`preview` | 展示与排序内容 |
| `dependencies`、`compatibility`、`risks` | JSON 元数据 |
| `search_text` | 扩展后的全文检索文本 |
| `embedding` | `VECTOR(n)` |

索引：

- `FULLTEXT INDEX idx_code_text`：全文检索。
- `VECTOR INDEX idx_code_embedding`：HNSW cosine 检索。

所有普通查询值和过滤条件都使用参数化 SQL。数据库名和表名只允许字母、数字和下划线。

## 9. 检索和排序逻辑

### 9.1 查询文本

检索文本由以下内容组成：

- 目标名称。
- 目标签名。
- 目标 kind 和 language。
- 目标路径。
- 用户自然语言需求。
- camelCase、snake_case、路径和常见领域词的扩展结果。

因此搜索 `SettleBatchAsync` 时，也会检索 `settle`、`batch`、`async`、
`settlement` 等词。

### 9.2 Repository Scope

仓库范围是服务端授权边界，不是 UI 标签。`RETRIEVAL_ALLOWED_REPOSITORIES`
以逗号分隔、精确匹配索引中的 repository ID，例如：

```text
RETRIEVAL_ALLOWED_REPOSITORIES=forexplore-reference-java,settlement-queue-py
```

UI 客户端通常省略 `repositoryScopes`，服务端会注入上述允许列表。若调用方
需要请求其子集，则只能传递该列表中的非空精确 ID；`repo:` 前缀、UI 标签、
通配符和未授权 ID 都会被拒绝，绝不会降级为无仓库过滤。

### 9.3 Candidate Language

`candidateLanguages` 是硬过滤，不是排序偏好。服务会：

1. 去重合法语言。
2. 将 `language IN (...)` 下推到 SeekDB。
3. 在返回前再次过滤，防止 Store 实现不遵守约束。

Java→C# adaptation pipeline 应发送：

```json
{
  "candidateLanguages": ["Java"]
}
```

若省略该字段，检索可以返回任意索引语言。

### 9.4 三种模式

| 模式 | 行为 |
| --- | --- |
| `semantic` | 只执行向量检索，再做符号和契约重排 |
| `structure` | 只执行全文检索，并限制候选 kind 与目标一致 |
| `hybrid` | 并行执行向量与全文检索，通过 RRF 融合后重排 |

Hybrid 的 RRF 权重：

```text
semantic: 0.65
full text: 0.35
```

最终综合评分包含：

- `semantic`：向量或需求文本相似度。
- `text`：全文检索分数与本地词项重叠。
- `symbol`：目标名称、签名和路径上下文的相似度。
- `contract`：kind、language 和依赖复杂度的兼容性。

为适配大型索引，系统不会只读取 `topK * 3` 个初始结果。重排池大小为：

```ts
Math.min(250, Math.max(50, topK * 5))
```

最终仍只返回请求中的 `topK`。

## 10. 本地启动

### 10.1 前置条件

- Node.js 与 npm。
- Docker Desktop。
- Windows 上应使用 Docker 或远程 SeekDB；SeekDB embedded 不能直接作为原生 Windows 库运行。

### 10.2 安装依赖

```powershell
cd D:\CodeProjects\Weichai
npm install
```

### 10.3 启动 SeekDB

```powershell
docker compose -f services/retrieval-service/docker-compose.yml up -d
docker compose -f services/retrieval-service/docker-compose.yml ps
```

默认映射：

- SQL：`127.0.0.1:2881`
- 额外服务端口：`2886`
- 容器名：`forexplore-seekdb`
- 持久卷：`seekdb-data`

### 10.4 配置

```powershell
Copy-Item services/retrieval-service/.env.example `
  services/retrieval-service/.env
Copy-Item web/.env.example `
  web/.env
```

默认前端配置：

```text
VITE_RETRIEVAL_API_URL=http://127.0.0.1:8787
```

删除或留空该变量，前端就会回退到原 Mock 检索。

### 10.5 建表和索引

服务默认 `SEEKDB_AUTO_MIGRATE=true`，启动时会自动建表。也可以显式执行：

```powershell
npm run schema --workspace @forexplore/retrieval-service
```

重建默认语料：

```powershell
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
```

### 10.6 启动后端和前端

终端一：

```powershell
npm run dev:retrieval
```

终端二：

```powershell
npm run dev
```

访问：

```text
http://localhost:4173/
```

## 11. 调试方法

### 11.1 检查 Docker

```powershell
docker compose -f services/retrieval-service/docker-compose.yml ps
docker logs forexplore-seekdb
```

容器状态应为 `healthy`。

### 11.2 检查检索服务

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

如果前端显示 `Mock Search Port`，优先检查：

1. `web/.env` 是否存在。
2. `VITE_RETRIEVAL_API_URL` 是否正确。
3. 修改 `.env` 后是否重启了 Vite。
4. 检索服务是否监听 `8787`。
5. `RETRIEVAL_CORS_ORIGIN` 是否与浏览器地址一致。

### 11.3 手工调用检索

```powershell
$body = @{
  target = @{
    id = "settle-batch-async-function"
    name = "SettleBatchAsync"
    kind = "function"
    path = "src/Application/SettlementOrchestrationService.cs"
    language = "C#"
    signature = "Task<IReadOnlyList<SettlementOutcome>> SettleBatchAsync(...)"
  }
  requirement = "批量结算，保证幂等并处理失败重试"
  topK = 5
  candidateLanguages = @("Java")
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/v1/search `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

### 11.4 “结果还是固定预设”

通常表示前端仍在使用 Mock Adapter。查看页面右侧 Port 信息或状态栏：

- 显示 `Mock`：检查前端环境变量并重启 Vite。
- 显示 `SeekDB`：请求已经进入真实后端，应检查索引是否完成。

### 11.5 “模块树找不到真实方法”

确认：

- 方法已经登记在 `packages/workspace-adapters/src/csharp-workspace.ts`。
- 节点 kind 是 `class` 或 `function`；record/interface 当前不能作为工作流目标。
- 静态树中的 path、signature 和 line 与 C# fixture 同步。
- `workspaceModuleSymbols.loadTree(csharpWorkspaceId)` 成功。

如果改用保留的 TypeScript 动态扫描器，再检查 `.ts/.tsx`、Babel 语法支持和 Vite
重新加载。

### 11.6 “检索不到刚索引的数据”

索引 CLI 在完成 upsert 后会调用：

```sql
CALL dbms_index_manager.refresh()
```

如果进程中途退出，先重新运行索引。还需确认索引 CLI 和检索服务使用了相同的
`SEEKDB_DATABASE`、`SEEKDB_TABLE`、Embedding Provider 和向量维度。

### 11.7 调试真实 Java→C# 适配

真实 Adapter 没有由 Web 默认启用。单独调试时需要：

- `DEEPSEEK_API_KEY` 或构造 `AdaptationAdapter` 时传入的 API key。
- Java 候选、C# 目标和 `translate` 策略。
- .NET 8 SDK 或可用的 `csc.exe`。

如果返回“集成编译成功”，注意检查 detail：
`compileIntegrated()` 当前是占位实现，不代表已经把生成代码放进完整目标项目编译。
`BackfillAdapter` 会直接修改磁盘文件，只应把经过校验的明确项目根目录传给它。

## 12. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RETRIEVAL_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `RETRIEVAL_PORT` | `8787` | HTTP 端口 |
| `RETRIEVAL_CORS_ORIGIN` | `http://localhost:4173` | 前端 Origin |
| `SEEKDB_HOST` | `127.0.0.1` | SeekDB 地址 |
| `SEEKDB_PORT` | `2881` | SeekDB SQL 端口 |
| `SEEKDB_USER` | `root` | 数据库用户 |
| `SEEKDB_PASSWORD` | 空 | 数据库密码 |
| `SEEKDB_DATABASE` | `forexplore` | 数据库名 |
| `SEEKDB_TABLE` | `code_symbols` | 专用符号表 |
| `SEEKDB_AUTO_MIGRATE` | `true` | 服务启动时建库建表 |
| `SEEKDB_VECTOR_DIMENSION` | `384` | 向量维度 |
| `SEEKDB_EMBEDDING_PROVIDER` | `hash` | `hash` 或 `openai` |
| `SEEKDB_EMBEDDING_URL` | OpenAI embeddings URL | 兼容接口地址 |
| `SEEKDB_EMBEDDING_API_KEY` | 空 | OpenAI 模式必填 |
| `SEEKDB_EMBEDDING_MODEL` | `text-embedding-3-small` | 模型名 |
| `VITE_RETRIEVAL_API_URL` | 未设置 | 设置后启用真实检索 |

## 13. 测试与交付检查

根目录完整验证：

```powershell
npm test
npm run build
npm run build:retrieval
git diff --check
```

根脚本当前会运行 workspace-adapters、workflow-core、seekdb-adapter、
retrieval-service 和 workflow-web 测试，但不会自动运行新拆出的 code-indexer 与
adaptation-service。提交涉及这两个模块的修改时还要执行：

```powershell
npm test --workspace @forexplore/code-indexer
npm run build --workspace @forexplore/code-indexer
npm test --workspace @forexplore/adaptation-service
```

当前测试覆盖：

- C# workspace 加载、目标解析和不可选择节点。
- 工作流核心目标转换。
- 浏览器 Adapter 成功、失败和中止。
- Hash/OpenAI-compatible Embedding。
- code-indexer 多语言符号提取和 manifest 边界。
- SeekDB SQL 辅助逻辑。
- 三种检索模式、语言约束、查询扩展、候选池和融合。
- HTTP 健康检查、正常搜索、非法 JSON、无效请求和超大请求。
- C# 工作区与 React 工作流交互，以及保留的 TypeScript 模块树生成器。
- Java→C# adaptation 的语言/策略入口校验。

涉及索引器或搜索排序时，还应执行：

```powershell
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
Invoke-RestMethod http://127.0.0.1:8787/health
```

并至少用一个目标符号做浏览器或 HTTP 端到端搜索。

## 14. 已知限制与建议演进

### 14.1 当前限制

- 运行时 C# 目标工作区仍是手工静态树，源码变化不会自动同步元数据。
- Web 只接入了真实检索；真实 adaptation/backfill 模块尚未组合进 UI。
- adaptation 使用 DeepSeek 跨语言翻译；Claude Code 通过 DeepSeek 的 Anthropic 兼容端点作为外层 MCP Agent Host。
- 集成编译仍是占位实现，BackfillAdapter 也只适合受信任的本地 POC。
- 源码索引器不是完整语法解析器，复杂多行声明、嵌套声明和部分语言特性可能漏检。
- 动态模块树扫描器目前只解析 TypeScript/TSX，且不是当前 C# runtime 数据源。
- 索引是全量目录扫描和逐符号 upsert，没有 Git 增量索引。
- HTTP API 没有鉴权、租户隔离、速率限制和结构化日志。
- 仓库过滤只支持精确 repository 值，不支持通配符。
- Hash Embedding 主要反映词法接近度。
- `CREATE TABLE IF NOT EXISTS` 不会自动迁移已有表的向量维度或字段结构。

### 14.2 推荐开发顺序

面向巨大项目继续开发时，建议按以下顺序推进：

1. 将目标工作区和语料仓库改成显式项目配置。
2. 使用 Git commit/file hash 实现增量索引和删除同步。
3. 用 Tree-sitter/LSP 替换正则符号提取，并保存调用关系、类型和引用。
4. 增加 chunk、类级上下文和调用图检索，避免只靠函数文本。
5. 使用生产 Embedding，并建立离线 relevance benchmark。
6. 增加 reranker 或学习排序，保留当前混合检索作为召回层。
7. 实现真实集成编译、受控 Patch Apply，再把 Adaptation/Backfill 组合进 Web。
8. 增加鉴权、租户/仓库 ACL、审计和可观测性。

## 15. 核心改动文件索引

本节列出需要维护的代码和配置。大量 fixture Java/C# 文件在后续集成中发生目录移动，
它们是语料或目标数据，不逐个重复列出。

### 根目录和文档

```text
README.md
package.json
package-lock.json
docs/architecture/repository-structure.md
```

### 共享契约和工作流

```text
packages/contracts/src/module.ts
packages/contracts/src/indexing.ts
packages/contracts/src/retrieval.ts
packages/workflow-core/src/module-target.ts
```

### Workspace Adapters

```text
packages/workspace-adapters/package.json
packages/workspace-adapters/src/csharp-workspace.ts
packages/workspace-adapters/src/static-module-symbol.adapter.ts
packages/workspace-adapters/src/workspace-adapters.test.ts
packages/workspace-adapters/src/index.ts
```

### SeekDB 浏览器 Adapter

```text
packages/seekdb-adapter/package.json
packages/seekdb-adapter/src/index.ts
packages/seekdb-adapter/src/seekdb-code-search.ts
packages/seekdb-adapter/src/seekdb-code-search.test.ts
```

### Web 和工作区模块树

```text
web/.env.example
web/build/target-module-tree.ts
web/build/target-module-tree.test.ts
web/package.json
web/src/App.tsx
web/src/App.test.tsx
web/src/main.tsx
web/src/styles.css
web/src/vite-env.d.ts
web/src/features/candidate-selection/CandidateBrowser.tsx
web/src/features/target-selection/ModuleTree.tsx
web/tsconfig.node.json
web/vite.config.ts
```

### Code Indexer

```text
services/code-indexer/package.json
services/code-indexer/README.md
services/code-indexer/tsconfig.json
services/code-indexer/src/cli.ts
services/code-indexer/src/discover.ts
services/code-indexer/src/discover.test.ts
services/code-indexer/src/extractor.ts
services/code-indexer/src/index.ts
```

### Retrieval Service

```text
services/retrieval-service/.env.example
services/retrieval-service/README.md
services/retrieval-service/docker-compose.yml
services/retrieval-service/examples/code-symbols.jsonl
services/retrieval-service/package.json
services/retrieval-service/tsconfig.json
services/retrieval-service/src/config.ts
services/retrieval-service/src/corpus-index-cli.ts
services/retrieval-service/src/corpus-indexer.ts
services/retrieval-service/src/corpus-indexer.test.ts
services/retrieval-service/src/embedding.ts
services/retrieval-service/src/embedding.test.ts
services/retrieval-service/src/http-server.ts
services/retrieval-service/src/http-server.test.ts
services/retrieval-service/src/index-cli.ts
services/retrieval-service/src/runtime.ts
services/retrieval-service/src/schema-cli.ts
services/retrieval-service/src/search-engine.ts
services/retrieval-service/src/search-engine.test.ts
services/retrieval-service/src/seekdb-store.ts
services/retrieval-service/src/seekdb-store.test.ts
services/retrieval-service/src/server.ts
services/retrieval-service/src/text-analysis.ts
services/retrieval-service/src/types.ts
```

### Adaptation Service

```text
services/adaptation-service/package.json
services/adaptation-service/README.md
services/adaptation-service/tsconfig.json
services/adaptation-service/src/index.ts
services/adaptation-service/src/translator.ts
services/adaptation-service/src/compiler.ts
services/adaptation-service/src/adaptation-adapter.ts
services/adaptation-service/src/adaptation-adapter.test.ts
services/adaptation-service/src/backfill-adapter.ts
services/adaptation-service/poc/
```

## 16. 本次实现的提交

```text
9b23b3b feat: add SeekDB-backed code retrieval
8a1ffe0 feat: index methods and translation fixtures
c3b7ed6 fix: harden retrieval service for large corpora
13f0fd2 feat: integrate workspace target with retrieval service
851df04 feat: add code indexer and adaptation pipeline (#3)
```

继续修改时请保持现有边界：共享数据放 `contracts`，工作流时序放
`workflow-core`，工作区发现放 `workspace-adapters`，源码解析放 `code-indexer`，
存储和排序放 `retrieval-service`，翻译、编译和回填放 `adaptation-service`，不要让
UI 直接访问 SeekDB 或文件系统。
