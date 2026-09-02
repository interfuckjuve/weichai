# 语言无关的代码仓入库与模块知识架构

本文说明 ForeXplore 在“存量代码仓处理”范围内的语言无关性。完整的模块划分、双审、发布、追溯和下游边界见 [存量代码仓模块划分与知识发布：工程边界](./repository-module-processing-boundary.md)。

## 结论

仓库处理主链现在不是 Java/C# 白名单：语言身份是开放字符串 `LanguageId`，分析能力由运行时 `RepositoryLanguageRegistry` 注册，adapter 结果归一为同一种 `UnifiedRepositoryIR`。新增语言可以通过注册 adapter 进入相同的证据校验和模块发现流程。

这不代表所有语言能力相同，也不代表迁移已经语言无关：

- Java、C# 目前有较深的结构/依赖分析。
- TypeScript、Python、Rust、Go 内置通用分析的深度较低。
- 未注册或证据不足的源码会保留 inventory，并以 `partial` 失败关闭，Module Agent 不得猜测。
- 分析支持与迁移支持是两套能力；真实迁移边界仍按项目定位保持 Java → C# MVP。

## 为什么旧实现看起来像白名单

原仓库并不存在一个总开关，而是在多个层次分别存在闭集：

| 层 | 旧约束 | 当前处理 |
| --- | --- | --- |
| 文件/语言识别 | 扩展名映射或 `Language` 联合类型 | 仓库分析改为开放 `LanguageId`；未知文件仍进入 inventory |
| 静态分析 | Java/C# 专用路径 | 引入可注册 adapter 和能力描述；深分析仍可作为专用实现 |
| 模块 Agent 输入 | 依赖具体分析结构 | 统一消费 `UnifiedRepositoryIR` |
| 旧符号检索 | 候选语言枚举、class/function 粒度 | 保留原契约，避免为“语言无关”破坏现有搜索 |
| 迁移/编译 | 真实 Java → C# 能力 | 继续显式授权，不从“可分析”推导“可迁移” |

因此正确演进不是删除所有语言门禁，而是把仓库理解层开放，把迁移执行层继续按真实 provider/compiler/validator 能力授权。

## Adapter 契约

每个 adapter 需要声明稳定身份、版本、支持语言、能力和配置指纹，并生成内容寻址的 `AnalysisShard`。统一 IR 至少容纳：

- 文件、项目与 manifest；
- 实体/符号和结构化 API surface；
- 依赖边与证据引用；
- per-language/per-shard coverage；
- diagnostics 与未完成能力。

宿主不允许 adapter 或 Agent 把 `private/internal/unknown` 接口自行提升成公开 API，也不允许通过自然语言叙述补造缺失实体、文件或依赖。

## 当前动态初始化流程

一次 `ForeXplore: 索引模块迁移仓库` 会保存固定静态快照，然后创建 ingestion：

```text
profile
→ registered adapters produce shards
→ merge/validate UnifiedRepositoryIR
→ readiness policy
→ Module Discovery Agent proposal
→ host materializes draft catalog
→ awaiting-module-review
```

若必需的 `file-inventory`、`symbol-index`、`api-surface` 等证据不够，流程进入 `partial`，不会调用 Agent。依赖、语义或测试关联等非必需能力缺口保留为可见 coverage/diagnostics，不能被解释为“仓库中不存在”。

第一道人审接受后，系统不会直接进入 `ready`，而是继续：

```text
active catalog + RepositoryModuleBundle
→ bounded EvidenceBundle per module
→ Summary Agent WikiProposal
→ awaiting-summary-review
→ explicit per-module review
→ immutable publication + separate module index
→ dual CAS activation
→ ready
```

这修正了早期“边界 accept 就把 Agent 叙述视为 reviewed”的混合信任问题。

## 模块知识的事实与叙述

每个模块知识页保持分层：

- `raw`：由 accepted catalog 和 IR 确定性重建的文件、实体、API、依赖、语言、coverage 等事实。
- `wiki`：Summary Agent 生成的摘要、架构、数据流、运维、复用建议、限制与风险；每项声明必须引用 EvidenceBundle。
- `review`：独立人工对当前 EvidenceBundle/WikiProposal ID/hash 的 accept/revise/reject。

Wiki 修订不覆盖历史。`revise` 只重跑被要求修订的模块，并把前一 proposal 和修订 review 作为签名输入；其他已接受模块沿用原 proposal/review。

## 存储与检索投影

经全部摘要审阅后，系统产生：

- 每模块 reviewed JSON 和 Markdown；
- 目录、JSONL、说明 schema 和 Draft 2020-12 JSON Schema；
- 不可变 `RepositoryKnowledgePublication` 状态修订；
- 本地 SQLite publication/head registry；
- 独立 SeekDB module documents/generations/heads；
- `RepositoryModuleIndexReceipt` 和 active head。

只有 active head 指向的 reviewed publication 可被 `/v1/module-knowledge/search` 查询。原 class/method/function 符号索引保持独立；两类召回的融合交给下游目标匹配层。

## 状态语义

| 状态 | 含义 | 正式模块搜索可见 |
| --- | --- | --- |
| `partial` | 分析能力/证据不足 | 否 |
| `awaiting-module-review` | 等待边界审批 | 否 |
| `summarizing-modules` | 收集证据或生成/修订 Wiki proposal | 否 |
| `awaiting-summary-review` | 等待独立摘要审批 | 否 |
| `publishing-knowledge` | 已全部接受，正在不可变 stage/validate/activate | 否，直到 active head 成功 |
| `ready` | 本地与远端头一致且激活 | 是 |
| `superseded` | 边界/摘要拒绝，或旧运行被关闭 | 否 |

## 能力证明与限制

实现的证明依赖契约/拒绝路径测试：开放语言 ID、自定义 adapter、unknown-only `partial`、IR 证据闭包、Agent 伪造引用拒绝、双人审状态、修订 lineage、SQLite/SeekDB CAS、ACL、未激活代不可见和补偿撤销。

这些测试不证明：

- 通用 adapter 与编译器级分析等价；
- Agent 在所有真实仓上都能划出业务正确模块；
- 编译通过能证明迁移行为正确；
- 本地 mock/SQL 单测能替代真实 SeekDB 的容量与故障恢复验证。

生产评估仍需要未参与调参的历史仓黄金集、人工一致性、模块检索 Recall@K/MRR/nDCG、错误边界案例、延迟、成本和真实 SeekDB 集成测试。

## 关键代码入口

| 责任 | 入口 |
| --- | --- |
| 开放语言与 ingestion 契约 | `packages/contracts/src/language-id.ts`、`repository-ingestion.ts` |
| Adapter registry 和静态分析 | `services/code-indexer/src/repository-analysis.ts` |
| 统一 IR bridge | `services/code-indexer/src/repository-ingestion-bridge.ts` |
| Module Discovery / Summary Agent | `services/adaptation-service/src/module-discovery-agent.ts`、`module-summary-agent.ts` |
| 双门禁状态机与知识物化 | `packages/workflow-core/src/repository-ingestion.ts`、`repository-knowledge*.ts` |
| VS Code 入库宿主 | `apps/vscode-extension/src/module-migration-host.ts` |
| 独立模块索引 | `services/retrieval-service/src/module-knowledge-*.ts` |
