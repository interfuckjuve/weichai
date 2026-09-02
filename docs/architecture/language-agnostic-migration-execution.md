# 语言无关迁移执行：工程规划与验收门禁

_施工基线，2026-09-02。本文承接 01A 存量仓模块知识和 01B 目标工作区主体建设，定义后续迁移执行层的唯一方向。_

## 1. 方向声明

Java → C# 是历史实验和回归基线，不是产品方向、默认路线或工程范围上限。ForeXplore 当前进入全面多语言开发阶段，但“全面开发”不等于声称所有语言组合已经同等可用。

任一迁移能力必须精确描述为：

```text
source LanguageId
  × target LanguageId
  × strategy
  × route/provider/version
  × stage capabilities
  × required validation policy
```

仓库分析支持不能推导迁移支持；模型能生成文本不能推导补丁可应用；编译通过不能推导业务行为正确。

## 2. 四类独立注册表

```text
AnalysisAdapterRegistry
  → profile / analysis shards / UnifiedRepositoryIR

ImplementationDetectorRegistry
  → declaration/body identity / implementation assessment

TargetEngineeringAdapterRegistry
  → TargetContextSnapshot / patch construction / target engineering checks

MigrationRouteRegistry
  → source × target × strategy / translator / behavior verifier / validation policy
```

四类注册表必须保持独立。Host 可以把它们组合成一次运行使用的内容寻址能力快照，但不得以某一类能力代替另一类能力。

`LanguageId` 是规范化后的开放字符串。alias 只允许在系统边界归一化；持久化制品、路由 key、哈希和比较必须使用 canonical ID。新增语言不得要求扩展 contracts 的中央语言 union，也不得要求在 workflow-core 增加语言分支。

## 3. 唯一模块事实与迁移制品

每个 repository snapshot 只能有一份经过 Gate 1 的 `RepositoryModuleCatalog` 作为模块边界事实。任务目标、Agent 提案、执行 wave 和补丁计划不得重新定义文件、实体或 API 的模块所有权。

迁移执行层使用以下制品：

```text
reviewed source RepositoryModuleCatalog
reviewed target RepositoryModuleCatalog
        ↓
ModuleMappingProposal
  - source/target catalog lineage
  - 1:1、1:N、N:1 映射
  - 证据、覆盖缺口、风险与人工决定
        ↓ Gate
MigrationExecutionOverlay
  - 只引用 canonical module/entity IDs
  - wave、write set、resource lock、strategy、route
  - 不重写 catalog ownership
        ↓
MigrationRunManifest
  - route/capability/validation snapshot
  - source/target/patch/checkpoint lineage
```

任一 catalog active head、IR、文件内容或能力策略发生变化，依赖它的 mapping、overlay、target context 和 run 都必须变为 stale，不能静默 rebase。

## 4. 语言中立的目标交接

生产主链不得把 01B 的 reviewed IR entity 降级成只含路径、签名和旧闭集语言的 `ModuleTarget`。正式目标引用至少绑定：

- workspace、repository、snapshot 和 IR 的 ID/hash；
- target catalog ID/hash、module ID、entity ID 和 file ID/hash；
- canonical `languageId`、公共 entity kind 与 adapter-owned native kind；
- declaration/body/semantic-shape identity；
- allowed write set 和选定 route snapshot。

`TargetContextSnapshot` 使用 declarations、containers、imports/dependencies、references/callers、tests、build facts 和 allowed modifications 等中性角色。`namespace`、`usings`、`constructor`、`containingType` 等语言形状只能作为 adapter-owned attributes，不得成为中央必填结构。

workflow-core 不解析源码语法，不使用 `{`、`=>`、缩进、关键字、文件扩展名或字符串字面量推断 declaration/body 边界。相关 range/hash 必须由对应语言 adapter 提供；缺少可信 identity 时状态只能是 `unverified` 或 `stale`。

## 5. 能力协商和失败关闭

UI 和 Host 展示同一份结构化 route capability，不允许各自推导“可翻译”布尔值。至少分别报告：

- analysis；
- implementation detection；
- source bundle；
- target context；
- generation/strategy；
- patch construction；
- compile/static checks；
- independent behavior validation；
- transactional apply/recovery。

`unknown` 可以浏览，但默认不可执行。unsupported、unavailable、degraded 和 unverified 必须保留原因、provider 和版本，不得退化为 Mock，也不得用自然语言乐观推断补足。

验证门禁从 route 的 `ValidationPolicySnapshot` 推导预期检查，而不是信任实现 Agent 自报的 `required` 列表。缺少任一必需检查、provider/version 不匹配、subject/patch hash 不匹配，均自动形成 required `unverified` 并阻止写回。

## 6. 施工包

| 编号 | 范围 | 完成定义 |
|---|---|---|
| LA-01 | 开放 v2 migration contracts | 正式主链使用 `LanguageId` 和不可变 lineage；旧 `Language/ModuleTarget` 仅在明确兼容层存在 |
| LA-02 | MigrationRouteRegistry | 精确 route、阶段能力、availability 和 validation policy 可注册、解析、快照化 |
| LA-03 | 01B Host/Webview | 无 C#/Java 硬门；显示真实语言、route 和能力缺口；unknown fail closed |
| LA-04 | 模块唯一事实 | source/target reviewed catalog → mapping → overlay，不再生成第三套模块边界 |
| LA-05 | 迁移运行 lineage | search/adaptation/validation/manifest 全程保留 catalog/module/entity/route lineage |
| LA-06 | 产品入口收敛 | 独立 Web 接入同一可信 Host/BFF，或明确退役；静态 C# workspace 只能是 fixture |
| LA-07 | 语言工程 adapter | detector/context/patch/validator 的语法处理下沉；生产组合可注入 registry |
| LA-08 | 通用目标树 | container/callable/native kind 投影；不把所有实体称作 class/method |
| LA-09 | 多文件安全写回 | route-owned allowed write set、每文件原始 hash、原子应用和恢复证据 |
| LA-10 | 跨范式验收 | 至少一条非 OO、非 Java/C# 路线完成分析→选择→生成→独立验证→门禁 |

## 7. 达标门禁

完成声明必须同时有以下证据：

1. 新增一种语言仅注册 adapter/route，不修改 contracts 中的语言 union或 workflow-core 的语言分支。
2. 任意 source-target-strategy 请求得到结构化 supported/unsupported/unavailable 结论和原因。
3. 迁移运行同时绑定 source/target reviewed catalogs；不存在任务 Agent 生成的第三套模块所有权。
4. workflow-core 不包含源码语法解析或语言关键字分支。
5. 缺少 route 任一必需 verifier 时，写回确定性被阻止。
6. Python 顶层函数或同等级非 OO fixture 不伪造 class，并通过真实工具链差分执行。
7. Java → C# 历史 fixture 继续作为回归，而不是默认能力声明。
8. 全仓单元、契约、组件和跨 workspace 测试通过；Extension、Retrieval、Adaptation 和 Translation Verifier 构建通过。
9. 所有跳过项按工具链缺失或显式环境条件说明，不能用 skip 隐藏受支持 route 的失败。
10. 最终 `MigrationRunManifest` 能重放并核对 route、provider、validator、patch、修复轮次和恢复点。

在以上门禁全部有当前证据以前，只能报告阶段性能力，不能宣布迁移执行已经完全语言无关。
