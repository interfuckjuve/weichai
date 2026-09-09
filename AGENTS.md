# ForeXplore 后续协作指南

本文件适用于整个仓库，用于约束后续关于 ForeXplore 的分析、设计、实现和评审。除非用户明确改变项目方向，否则应以这里记录的产品定位和工程原则为默认共识。

## 一、项目核心定位

ForeXplore 不是通用代码生成器，也不只是代码搜索或代码翻译工具。它是一套：

> 以企业已有实现为证据、以目标工程契约和独立验证为闸门、以人工审批为控制点的跨技术栈代码迁移工作流。

项目要解决的核心问题是：企业开发新功能时，该功能可能已经由其他语言或技术栈实现。系统应先找到并理解已有实现，再完成受约束的跨语言迁移和工程适配，而不是让 Agent 仅根据需求从零自由生成代码。

已有代码是高价值证据，不是绝对真理。候选实现仍需评估版本、测试覆盖、生产使用情况、依赖、安全、许可证、所有者和适用上下文。

## 二、目标工作流

后续设计应逐步收敛到以下链路：

```text
选择目标符号并采集目标工程上下文
    ↓
专用检索模块召回实现切片
    ↓
候选证据展示与人工明确选择
    ↓
提取源行为、目标约束和迁移风险
    ↓
生成结构化迁移计划并由人审阅
    ↓
实现 Agent 生成目标代码和补丁
    ↓
独立验证器执行编译、测试、契约及工程检查
    ↓
基于明确失败证据进行有限次数修复
    ↓
人工审阅最终差异和剩余风险
    ↓
事务化回填、检查点记录和可恢复操作
```

这里的重点不是简单增加 Agent 数量，而是建立清晰的制品边界、权限边界和独立验证依据。实现 Agent 不得通过修改验证策略或仅依赖自己生成的测试来证明实现正确。

## 三、当前已经具备的骨架

仓库目前已经具备：

- React/Vite 工作流界面和目标模块树。
- `target → requirement → candidates → adaptation → patch → complete` 工作流状态机。
- 可替换的检索、适配和回填端口。
- SeekDB 向量与全文混合检索服务。
- Top-K 候选展示、人工备注、候选选择和补丁确认界面。
- 以 Java → C# 为历史实验基线的模型翻译、独立编译、临时目标工程集成编译和有限次数编译修复；当前工程方向已经转为由显式能力注册驱动的全面多语言迁移。
- 文件补丁预览以及 HTTP 回填边界。
- 覆盖各 workspace 的单元、契约和组件测试。

截至 2026-07-30 的检查基线为：84 项测试通过、1 项跳过；Web、检索服务和适配服务均可构建。后续不得把这个历史基线当成当前结果，涉及状态声明时仍应重新运行相应验证。

## 四、必须如实描述的能力边界

当前实现仍是原型，不能把以下能力描述为已经完整实现：

1. **语义正确性验证**
   - 当前适配主链路主要验证 C# 独立编译和目标 skeleton 集成编译。
   - 编译通过不能证明业务行为、并发、顺序、超时、取消、幂等和错误语义正确。

2. **独立验证闭环**
   - 当前翻译和编译错误修复由同一模型链路完成。
   - 尚未形成基于独立 acceptance test、属性测试、差分执行或行为不变量的完整校验。

3. **完整迁移上下文**
   - 当前模型主要读取候选 `preview`、目标签名和需求文本。
   - 它尚未稳定获得候选完整源码、辅助符号、测试、调用关系，以及目标文件上下文、调用方、工程依赖和编码规约。

4. **真实结构与契约匹配**
   - 当前 `structure` 主要是全文检索加符号类型过滤。
   - 当前 `contract` 分数主要来自符号类型、语言和依赖数量等启发式。
   - UI 中的分数属于排序分，不应表述为经过校准的正确率或兼容概率。

5. **多策略和多语言适配**
   - Java → C# 只是历史实验基线，不再是产品方向、默认语言对或施工范围上限。
   - 当前 `translate` 提示和编译骨架已覆盖多种语言，但目标上下文、补丁构造、独立验证和工程集成的成熟度并不相同；任一具体 source × target × strategy 路线必须由能力注册表和验证策略如实判定。
   - `bridge`、`wrap`、`reuse` 以及缺少完整验证闭环的语言路线仍不能描述为生产可用。

6. **事务化回填**
   - 当前真实回填会逐文件写入，检查点主要是标识符。
   - 尚未具备完整的多文件原子提交、真实快照、失败回滚和工作区恢复能力。

## 五、后续实现优先级

### P0：先让验证和写回可信

- 将验证状态扩展为至少 `pass`、`warn`、`fail`、`unverified`。
- 为检查项增加 `required`、执行命令、输出摘要、制品位置和失败原因。
- 任一必需检查为 `fail` 或 `unverified` 时，默认禁止回填。
- 修复回填路径越界风险，增加原始文件哈希和并发修改检测。
- 使用临时区、Git 分支/commit 或真实快照实现多文件原子应用与回滚。
- 候选选择必须由用户明确完成，不应默认把第一名等同于人工确认。

### P1：补齐迁移输入和计划阶段

- 引入 `SourceImplementationBundle`，至少包含主符号、辅助符号、完整源码、依赖、相关测试、来源版本和内容哈希。
- 引入 `TargetContextSnapshot`，至少包含目标文件、所在类型、调用方、接口、可用依赖、测试、工程规则和允许修改范围。
- 将自由文本约束补充为结构化的不可变契约、风险接受项和人工决策记录。
- 在生成代码前产生结构化行为说明、接口映射和迁移计划，并增加人工差异审阅节点。
- 不再以截断的候选预览作为正式翻译输入。

### P1：建立独立行为验证

- 优先运行目标工程已有的 acceptance、unit 和 integration tests。
- 从源实现和人工确认的行为契约中建立独立测试依据，但不得只依赖实现 Agent 同时生成的测试。
- 对适合的语言对增加差分执行、属性测试、边界测试和并发不变量检查。
- 增加架构边界、依赖、格式、静态分析、安全和许可证验证。
- 修复循环必须有次数上限，并保留每轮失败证据和补丁差异。

### P2：提升检索真实性和企业能力

- 将检索对象从孤立符号升级为“最小可迁移实现切片”，包含协作符号、类型、测试、配置和调用关系。
- 使用 AST、Tree-sitter、编译器 API 或 LSP 提升结构和类型契约分析。
- 使用独立、未参与调参的多语言和跨领域 holdout 评估检索。
- 区分排序分、证据覆盖度和风险，不展示虚假的概率式精度。
- 在索引、检索、候选展示和模型调用各层实现仓库 ACL、租户隔离、代码数据边界和审计。

## 六、关键制品建议

后续扩展共享契约时，优先考虑以下正式制品，而不是继续增加无结构文本：

- `SourceImplementationBundle`
- `TargetContextSnapshot`
- `BehaviorContract`
- `MigrationPlan`
- `ValidationRecord`
- `MigrationRunManifest`
- `WorkspaceCheckpoint`

`MigrationRunManifest` 应能够追踪：

- 检索请求、索引版本和候选排名。
- 来源仓库、commit、符号位置和内容哈希。
- 人工选择、约束、风险接受和审批身份。
- 模型、提示模板、工具和适配策略版本。
- 每项验证的命令、状态、输出摘要和制品。
- 每轮修复原因及差异。
- 最终补丁哈希、回填事务和恢复点。

## 七、评估口径

不能只用“编译通过率”衡量项目价值。至少应分别评估：

- **检索质量**：Recall@K、MRR、nDCG、未标注候选比例、跨语言/中文查询表现、延迟和成本。
- **迁移质量**：独立行为测试通过率、接口一致性、回归数量、编译通过但行为错误的假阳性率。
- **人工成本**：候选接受率、人工修改比例、迁移计划修改次数、最终补丁接受率。
- **工程安全**：越权检索、依赖与许可证风险、回填失败率、回滚成功率和审计完整度。

合成 benchmark 适合验证原型，但不能单独证明企业泛化能力。进入生产声明前，需要使用未参与开发调参的真实或匿名化历史迁移任务进行评估。

## 八、修改仓库时的协作约束

- 保持 `packages/contracts` 为稳定共享边界，`workflow-core` 不直接依赖具体模型、数据库或 UI。
- 修改工作流或共享类型时，同步检查 contracts、workflow-core、HTTP adapters、Mock adapters、Web UI、服务端校验、测试和文档。
- 不得因新增真实实现而静默回退到 Mock，也不得在 UI 中把真实端口错误标记为 Mock。
- 不得把编译成功、模型自评或启发式分数描述为业务正确性证明。
- 新增自动回填能力前，必须先实现验证门禁、路径安全、并发修改检测和恢复机制。
- Java → C# 仅作为历史回归基线；不得在 contracts、workflow-core、Host、UI 或提示词中把它硬编码为默认方向或能力上限。新增语言应通过 adapter/route 注册完成，不得要求修改中央语言联合类型或语言分支。
- 全面多语言开发不等于所有语言路线已经同等可用。每条路线必须分别报告分析、上下文、生成、补丁、编译、独立验证和写回能力，缺少必需能力时失败关闭。
- 优先产出可审阅、可重放、可追踪的结构化制品；Agent 的自然语言说明只能作为辅助证据。

## 九、关键代码入口

- 项目定位：`docs/project-introduction.md`
- 共享契约：`packages/contracts/src`
- 工作流状态机：`packages/workflow-core/src/workflow.ts`
- Web 组合入口：`apps/workflow-web/src/main.tsx`
- 候选与补丁交互：`apps/workflow-web/src/features`
- 代码索引：`services/code-indexer/src`
- SeekDB 检索：`services/retrieval-service/src`
- 多语言迁移适配：`services/adaptation-service/src/adaptation-adapter.ts`
- 编译验证：`services/adaptation-service/src/compiler.ts`
- 回填实现：`services/adaptation-service/src/backfill-adapter.ts`

## Agent skills

### Issue tracker

Before reading or publishing specs and tickets, read `docs/agents/issue-tracker.md`. This repo uses local Markdown.

### Triage labels

Before assigning triage status, read `docs/agents/triage-labels.md`. This repo uses the five default role names.

### Domain docs

Before exploring domain behavior, read `docs/agents/domain.md`. This repo uses a single root context and shared ADRs.
