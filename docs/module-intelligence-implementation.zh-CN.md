# 模块智能适配实施记录

回退基线：`c701acb`，实施分支：`main`。验收定义见 [验收标准](module-intelligence-acceptance.zh-CN.md)。本记录随本次限时实施更新；未完成项不视为验收通过。

## 已实现

1. **模块到模块检索**：实际项目树中的模块可作为目标，候选具有仓库、revision、project、module 身份，保留完整文件清单、接口、依赖及证据 ID。三个检索视图按同一模块归并，不将函数冒充模块。
2. **真实多语言表示**：复用已有 OpenAI 兼容 embedding 客户端，接入本地 multilingual-e5-small。职责、接口和依赖三个视图进入全文及 HNSW 召回；跨仓库排序使用原始相关性，不直接比较各仓库的局部名次。
3. **模型隔离与持久复用**：数据库绑定模型、端点、维度、query/document 指令身份。不同模型禁止共用旧向量。精确输入内容哈希缓存支持跨 revision、跨进程复用，读取批次最多 128、编码批次最多 16。
4. **有界模块读取**：最多 32 个历史仓库，仓库并发 4，Top-K 最多 10；仅按召回 ID 读取模块产物和项目，不加载完整 StructuralIndex，也不在空结果后遍历全库。预览最多 3 文件，每文件数据库端截断为 4000 字符。
5. **快照与取消校验**：检索校验 revision、analysisHash、proposal 的 planHash，返回前再次校验活动 revision。10 秒检索预算传播到 embedding、SQL、连接池等待及源码预览，取消时销毁执行中的连接。
6. **产品边界**：候选详情显示完整模块文件、接口匹配与未知行为。多文件生成尚未接通，界面禁用相应按钮，Host 同时拦截模块进入单文件写回。

这是一阶段工程适配，不是 SOTA 效果认证。当前模型是可复现的轻量基线，排序仍含启发式权重，接口名称匹配不构成行为覆盖证明。

## 实际发现并修复的问题

- SeekDB 1.3 默认异步维护新建 HNSW 索引。原代码提交写入后立即标记就绪，真实 ANN 却返回空集；同样向量的精确距离查询有结果。现在在支持该配置的版本显式建立 `SYNC_MODE=immediate`，已有异步索引要求使用独立库重建。依据：[SeekDB 1.3 发布说明](https://github.com/oceanbase/seekdb/releases/tag/v1.3.0)。同步写入成本增加，未来如恢复异步索引，必须实现与 commit 水位绑定的发布屏障。
- 每个仓库只含一个模块时，局部第一名无法用于全局比较；现在保留向量原始相似度及全文原始分数。
- 窄窗口的长源码路径曾被裁切；增加文件清单换行，并用浏览器检测清单本身的溢出。

## 验证证据

真实集成脚本：`scripts/verify-module-matching.ts`。使用隔离且自动删除的 SeekDB 数据库、本地真实模型、真实结构索引与 CodeIntelligenceHost。模块分析提案为脚本明确标记的合成夹具，不是大模型分析结果。

- 3 个独立职责模块、9 个合成文件；3 条中文需求对应英文模块描述，目标语言 Java，来源 TypeScript。
- 3 条需求均 Top-1 命中；这是小样本语义冒烟测试，Top-3 包含整个候选集，不能作为召回率结论。
- 新存储实例重投影 27 份未变检索文档：持久缓存命中 27，向量提供方新文档请求 0。
- 同维度但不同模型配置被拒绝；检索期间完整 StructuralIndex 读取被显式替换为抛错，实际主链路仍通过。
- 代码智能服务：9 文件 / 40 测试通过，包含空召回、过期版本、篡改 proposal hash、预览上限、取消连接池等待和活动 SQL。
- 扩展此前完整套件 25 文件 / 102 测试通过；新增/重点入口与候选界面 2 文件 / 8 测试通过。服务、扩展和 Webview 的独立类型检查通过。
- `verify-indexing-performance.ts --project-job-only` 通过真实 SQL 存取一致性、产物发布、重新打开与失败状态持久化检查。
- `verify-module-matching-ui.mjs` 对实际候选组件执行选择操作，检查 1100x780、390x844 两种视口和文件清单溢出，截图已人工检查。它不等同于启动完整 VS Code Extension Host。

原始结果与截图位于 `logs/module-matching-acceptance.json`、`logs/module-matching-desktop.png`、`logs/module-matching-narrow.png`。日志保留在本机，不纳入源码提交。硬件 Intel i7-14650HX、环境可用内存约 16.6 GB；数据库 `5.7.25-OceanBase seekdb-v1.3.0.0`；模型固定为 `Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78`，384 维、q8 CPU、mean pooling、normalize，query/document 前缀分别为 `query: ` 与 `passage: `。

## 启动与复现

模型运行时是可选工具，不打包进扩展。Linux 验证工具安装在 `/tmp/forexplore-linux-tools`，模型运行时在 `/tmp/forexplore-embedding-tools`。仓库的 Windows node_modules 不可直接作为 Linux 编译工具使用。

```bash
npm install --prefix /tmp/forexplore-embedding-tools --ignore-scripts @huggingface/transformers@3.8.1
FOREXPLORE_EMBEDDING_TOOLS=/tmp/forexplore-embedding-tools FOREXPLORE_MODEL_HOST=https://hf-mirror.com FOREXPLORE_EMBEDDING_PORT=4021 node scripts/serve-local-embeddings.mjs
```

服务仅监听 `127.0.0.1:4021`；`GET /health` 查看就绪与模型身份。模型镜像用于下载公开模型权重，源码推理留在本地。首次需要下载权重，之后使用 `/tmp/forexplore-model-cache`。

在另一终端运行本地集成验收：

```bash
/tmp/forexplore-linux-tools/node_modules/.bin/tsx scripts/verify-module-matching.ts --report logs/module-matching-acceptance.json
```

启动扩展前，在其父进程环境设置下列变量。模型变更时选择新数据库；不要将旧 hash 投影直接当成模型向量。

```dotenv
CODE_INTELLIGENCE_SEEKDB_DATABASE=forexplore_module_e5_v1
CODE_INTELLIGENCE_SEEKDB_HOST=127.0.0.1
CODE_INTELLIGENCE_SEEKDB_PORT=2881
CODE_INTELLIGENCE_SEEKDB_USER=root
CODE_INTELLIGENCE_SEEKDB_PASSWORD=
CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION=384
CODE_INTELLIGENCE_EMBEDDING_URL=http://127.0.0.1:4021/v1/embeddings
CODE_INTELLIGENCE_EMBEDDING_MODEL=Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78
CODE_INTELLIGENCE_EMBEDDING_API_KEY=
CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS=false
CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX="query: "
CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX="passage: "
```

引号属于 dotenv 表示法；直接配置环境变量时保留前缀末尾空格，不把引号作为值的一部分。缺少模型配置时仍为既有 hash 基线。

## 未通过的完整验收门槛

| 门槛 | 当前结论 | 剩余工作 |
| --- | --- | --- |
| G1 模块全流程 | failed | 检索、选择和预览通过；完整模块包到生成、编译、Spec 测试及写回未贯通 |
| G2 表示与证据 | failed | 真实 embedding 和三视图通过；能力要求的证据判定、强重排与校准未实现 |
| G3 语言与桥接 | not-run | 未新增 ArkTS、C/C++、Kotlin/KMP 语义分析；JNI、Node-API、expect/actual 和回调桥接尚未实现 |
| G4 增量与有界查询 | failed | 模块读取有界、取消和向量复用通过；语义影响传播、完整增量等价矩阵和其他 SemanticQuery 的全量读取仍待完成 |
| G5 企业效果与时延 | blocked | 缺少冻结的独立企业标注集；合成样例不支撑 >=90% 的业务准确率 |
| G6 规模与 Spec | blocked | 缺少真实 10 万/100 万/1000 万行验收工程及冻结 Spec；尚未实测容量和业务完整度 |

当前结构解析仍由已有 Tree-sitter 的 Java、TypeScript/JavaScript、Python、C#、Go、Rust 支撑。现有 Java/C# 专用语义与 LSP 扩展口保留，但本轮未把它们扩展为企业所需跨语言依赖系统。

其他限制：同步 HNSW 与 JSON 向量缓存的磁盘和写入成本尚未做大工程测量；缓存尚无回收策略；完整投影仍加载所有待写文档；产品 `startSearch` 仍会等待项目分析完成，故服务内部 10 秒预算不能冒充产品端到端 SLA。未知语言会明确报错，不用目标语言伪装来源语言。

外部真实生成模型的测试此前被自动审批拒绝，原因为可能向外部端点发送仓库内容。已单独请求只发送合成测试数据的授权；在授权到达前不执行依赖该许可的测试。
