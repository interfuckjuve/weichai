# 模块迁移 Agent 交付说明

> 适用范围：本分支的模块迁移规划能力。本文描述当前已接通的实现和约束，不将规划结果表述为代码迁移或业务语义正确性的证明。

## 1. 交付目标与职责边界

本分支新增的 Agent 是 `ArchitectAgent`（别名 `Agenticodex`）。它的唯一职责是：根据已固化的仓库静态分析快照，提出**功能模块边界、模块依赖和风险**。

它不是具备写入权限的代码实现 Agent：

| 事项 | 责任方 | 当前行为 |
| --- | --- | --- |
| 生成仓库静态证据 | VS Code 扩展 + code-indexer | 通过开放语言 adapter registry 分析仓库，生成不可变快照 |
| 提出功能模块 | `ArchitectAgent` | 只读模型调用，返回非可信 `ModuleMigrationProposal` |
| 校验模块图、依赖与排程 | `workflow-core` | 确定性规则，不信任模型自行排程 |
| 计划/波次审批 | 人工 + VS Code 宿主 | 审批分别绑定计划哈希和准备结果哈希 |
| 应用补丁与提交 | 本地补丁包 + 隔离 Git worktree | 通过已配置验证后，以 Git 事务提交 |

因此，当前能力应准确称为“**Agent 辅助的模块迁移规划与受控波次执行**”。已接通的执行路径需要人工导入本地 patch bundle；没有按模块自动生成或自动导入补丁的实现 Agent。

## 2. 总体链路与信任边界

```text
LanguageId 开放的仓库
  │
  ▼
本地静态分析 ──> 不可变 RepositoryStaticAnalysis 快照
  │                    │ snapshotId / contentHash / repository revision
  │                    ▼
  │              HTTP/MCP 仅提交 snapshotId、目标和约束
  │                    │
  │                    ▼
  │              ArchitectAgent（只读、非可信提案）
  │                    │ ModuleMigrationProposal
  ▼                    ▼
VS Code 宿主 ──> 确定性校验、SCC 分组和 wave 排程
                         │ ModuleMigrationPlan / planHash
                         ▼
                    人工审批计划
                         │
                         ▼
                    导入本地 patch bundle
                         │
                         ▼
             disposable worktree 中范围检查与联合验证
                         │ preparedHash
                         ▼
                    人工审批波次
                         │
                         ▼
             受管 Git 分支上的单次事务提交
```

信任边界的核心是：模型只能提出方案；静态证据、排程、验证状态和 Git 写入均由模型之外的代码或人工控制。HTTP/MCP 接口只接收 `snapshotId`、`objective` 和 `immutableConstraints`，服务端按 ID 从自己的快照存储读取制品，不接受调用方上传源码、路径或分析图。

## 3. Agent 的模块划分逻辑

### 3.1 输入：可复验的静态证据快照

仓库分析器通过开放 `LanguageId` 和可注册 adapter 工作；当前内置 adapter 覆盖 Java、C#、TypeScript、Python、Go 和 Rust，并按各自可证明的深度收集项目、声明、引用、调用、测试和构建事实。新增语言不修改中央语言 union。文件统一划分为 `source`、`test`、`generated`、`configuration` 或 `other`；快照包含文件、实体、依赖边、诊断、仓库 revision、`snapshotId` 和 `contentHash`，其制品默认写在：

```text
.forexplore/analysis/<snapshotId>.json
```

依赖边具有 `semantic`、`syntactic`、`ambiguous`、`unresolved` 等证据等级。可选的编译器探针只能提升已精确匹配的语法边，不能补全为完整的编译器级调用图。

Agent 看到的是上述快照中的元数据和证据 ID，不是完整源码、完整调用方、完整测试、运行时轨迹或业务行为证据。

### 3.2 Agent 产出的“候选模块图”

`ArchitectAgent` 以迁移目标和静态快照为输入，要求模型输出一个严格 JSON 的 `ModuleMigrationProposal`。每个 `FunctionalModule` 包含：

| 字段 | 划分含义 |
| --- | --- |
| `id`、`name`、`kind`、`description` | 模块的稳定标识、职责和类别 |
| `sourceFiles`、`testFiles`、`generatedFiles` | 模块拥有或关联的文件集合 |
| `symbolIds` | 用于解释模块边界的静态符号证据 |
| `dependsOn` | 前置模块；`A.dependsOn = [B]` 表示 B 必须先完成 |
| `writeSet`、`resourceLocks` | 波次执行时允许修改的范围和互斥资源 |
| `evidenceIds` | 支撑边界与依赖判断的快照依赖边 |
| `risks` | 模型无法消除的不确定性，供人工审阅 |

同时，`fileAssignments` 对快照中的每个文件明确记账，归属只能是 `module`、`test`、`generated` 或 `excluded`。每个 source 文件至多属于一个模块；所有快照文件必须恰好有一次归属记录。`excluded` 并不表示系统已证明该文件不重要，仍需要人工审阅其原因和风险。

Agent 提示词明确禁止它输出 wave、并行度、补丁、命令、验证结论、审批或 Git 操作。模型响应会先经过严格 JSON/schema 校验；无法通过时最多进行两次修复性重试，仍失败则终止规划。

### 3.3 确定性校验：把提案变成可审阅计划

`ModuleMigrationProposal` 始终是不可信输入。VS Code 宿主通过 `workflow-core` 的 `buildModuleMigrationPlan()` 执行机械校验后，才生成带 `planHash` 的 `ModuleMigrationPlan`。主要规则如下：

| 规则 | 处理方式 |
| --- | --- |
| 模块 ID 与图结构 | ID 必须符合受限字符集且唯一；内部 tuple key 使用长度前缀，避免分隔符导致的键碰撞 |
| 文件归属 | 文件角色必须与快照一致；所有文件都有 assignment；source 和 symbol 不可跨模块重叠 |
| 证据与依赖 | `symbolIds`、`evidenceIds`、依赖端点必须存在于本快照；已解析的内部静态依赖必须映射为模块依赖 |
| 写入范围 | `writeSet` 默认只能覆盖本模块拥有的 source/test/generated 文件；配置文件只能由具备明确理由和资源锁的 `shared-contract` 模块处理 |
| 不确定依赖 | `ambiguous`、`unresolved` 内部边不被当作“无依赖”；保留为风险并阻止相关模块不安全并行 |
| 计划完整性 | 每个 module、execution group 与 execution wave 都必须恰好出现一次；缺失或重复会使计划无效 |

`immutableConstraints` 当前会传入 Agent 提示词，但尚未写入 `ModuleMigrationPlan`、`planHash` 或运行清单，也没有独立的机械执行器。因此它们是当前规划的提示约束，不能视为已端到端强制的策略门禁。

### 3.4 SCC、冲突与 wave 排程

模型不决定执行顺序。宿主对通过校验的模块图做确定性排程：

1. 用 Tarjan 算法将循环依赖收缩为强连通分量（SCC）。SCC 是不可拆分、串行处理的原子 execution group。
2. `shared-contract` 相关 group 同样按原子组处理，避免共享契约被拆分到独立事务中。
3. 将模块依赖转换为 group 级依赖，保证前置 group 在后置 group 之前完成。
4. 根据写集重叠、资源锁重叠和不确定内部依赖建立冲突关系。
5. 只有普通 group、前置依赖已满足且不存在上述冲突时，才可被放在同一 wave 中并行**准备**；扩展当前将最大准备并行度固定为 4。
6. wave 的审批和提交仍按整个 wave 执行，并不是每个并行任务各自发布。`parallelismBlockedBy` 会保留不能并行的原因。

该设计把“模型对功能边界的建议”与“宿主对依赖和并发安全的判定”分离：模型可被替换，排程规则可测试、可重放。

## 4. 制品、绑定关系与审计

| 制品 | 生成者 | 绑定关系与用途 |
| --- | --- | --- |
| `RepositoryStaticAnalysis` | code-indexer / VS Code 扩展 | 由 `snapshotId`、内容哈希和仓库信息标识的静态证据 |
| `ModuleMigrationProposal` | `ArchitectAgent` | 非可信模块提案；只允许引用对应快照中的路径、符号和边 |
| `ModuleMigrationPlan` | `workflow-core` | 校验、分组和排程后的计划；`planHash` 覆盖计划内容 |
| `PlanDecision` | 人工 / 扩展宿主 | 计划审批、风险接受、波次审批和备注；计划审批绑定 `snapshotId + planHash` |
| `preparedHash` 与 wave 结果 | worktree 执行协调器 | 将精确补丁、验证结果和待审批波次绑定 |
| `.forexplore/module-summary.json` | Git 波次事务 | 随代码一起提交的模块迁移摘要 |
| `.forexplore/runs/<runId>.json` | Git 波次事务 | 运行、验证、审批和事务记录 |

源仓库重新分析后，新的快照会改变 `snapshotId` 或内容哈希；旧计划和已作出的审批不应再用于后续执行。

## 5. 审批、验证与提交门禁

模块划分完成后，执行需依次经过下列人工控制点：

1. 人工审阅模块边界、依赖、风险、`writeSet` 与 wave，批准时绑定当前 `snapshotId + planHash`。
2. 仅当前置 wave 已提交后，才允许准备下一 wave。
3. 人工从本机选择严格的 patch-only bundle。补丁包声明的验证结论不被信任，也不会直接作为通过依据。
4. 系统在 disposable Git worktree 中再次检查补丁范围与批准写集，并运行本机配置的联合验证命令。
5. 任一必需检查为 `fail` 或 `unverified` 时，波次不得审批。没有配置联合验证命令时，必要检查会是 required `unverified`，默认阻断提交。
6. 人工只可批准精确的 `preparedHash`；批准后，代码、模块摘要与运行清单作为单一 Git 提交写入受管分支。

这里的 `actor` 是宿主记录的审批信息，不代表已经具备外部身份认证、租户 ACL 或不可抵赖签名能力。

## 6. 部署与运行前提

| 项目 | 要求 |
| --- | --- |
| 模型服务 | 配置 `DEEPSEEK_API_KEY`；可选 `DEEPSEEK_MODEL`、`DEEPSEEK_API_BASE` |
| 快照共享 | `ADAPTATION_ANALYSIS_ROOT` 必须能读取 VS Code 写入的 `.forexplore/analysis`。当前是本地/共享挂载 MVP，不是快照自动上传或远程制品分发协议 |
| 扩展服务地址 | 配置 `forexplore.adaptationApiUrl` 指向 adaptation service |
| 工程验证 | 机器级配置 `forexplore.moduleWaveValidationCommands`；命令以 `shell: false` 在隔离 worktree 运行 |
| Git 事务 | 系统需要 Git worktree；实际准备 wave 前应具备干净的 tracked worktree。规划阶段可显式允许 dirty worktree，但这不等于可安全执行 |

## 7. 当前能力边界与后续注意项

| 已具备 | 尚未具备或不能据此宣称 |
| --- | --- |
| 开放语言 adapter 的静态快照、模型模块提案、确定性校验、SCC/wave 排程、哈希绑定审批和 worktree 事务 | 所有语言达到相同语义深度、完整源码级理解、完整调用图、运行时行为理解或模块边界的语义证明 |
| 通过导入 patch bundle 的受控准备与联合验证门禁 | Agent 自动生成/导入多模块补丁 |
| 编译、测试、静态检查等由管理员配置的工程验证 | 并发、顺序、超时、取消、幂等、错误语义和业务结果的独立正确性证明 |
| 本地快照路径约束、范围检查和 Git 提交流程 | 多租户 ACL、远程制品分发、已认证审批身份或全局恢复协议 |
| 不确定静态依赖的保守串行化 | 不确定依赖已经被精确解析或业务影响已被消除 |

后续扩展时应优先将约束、风险接受、验证证据和审批身份纳入可哈希、可持久化的 `MigrationRunManifest`，并补足独立行为验证，而不是扩大 Agent 的写入权限。

## 8. 关键实现入口

- 共享制品契约：`packages/contracts/src/module-migration.ts`
- 模型模块提案：`services/adaptation-service/src/architect-agent.ts`
- 服务端快照读取：`services/adaptation-service/src/analysis-snapshot-store.ts`
- 静态分析与快照：`services/code-indexer/src/repository-analysis.ts`
- 提案校验与计划生成：`packages/workflow-core/src/module-plan-validator.ts`、`packages/workflow-core/src/module-migration-workflow.ts`
- SCC 与 wave 排程：`packages/workflow-core/src/module-scheduler.ts`
- VS Code 规划与审批入口：`apps/vscode-extension/src/module-migration-host.ts`
- 补丁包与 wave 执行：`apps/vscode-extension/src/module-wave-patch-bundle.ts`、`apps/vscode-extension/src/module-wave-execution-host.ts`
- Git worktree 事务：`services/adaptation-service/src/git-wave-transaction.ts`
