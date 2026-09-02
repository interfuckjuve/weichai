# ForeXplore 01B 目标工作区模块划分与实现状态

_工程边界与验收基线，2026-09-02。本文描述目标工作区（01B），不改变存量代码仓入库（01A）的发布语义。_

## 结论

01B 复用 01A 的“代码事实与模块边界”链路，但不复用 01A 的“知识摘要与检索发布”链路：

```text
目标工作区快照
  → 01A 静态分析与语言 adapter registry
  → UnifiedRepositoryIR
  → Module Discovery Agent
  → 宿主确定性校验
  → Gate 1 模块边界人审
  → active RepositoryModuleCatalog
  → 语言实现状态 detector
  → class / file / module 确定性聚合
  → TargetWorkspaceModuleSnapshot
  → 01B 目标树与精确 callable 选择
  → V2 符号/实现制品与 exact-route 迁移流程
```

目标工作区只产生供本次迁移使用的内容寻址目录。它不会生成模块 Wiki，不进入第二道人审，不写 SQLite knowledge registry，不创建 SeekDB module generation/active head，也没有“发布/撤销”动作。

## 01A 复用矩阵

| 01A 能力 | 01B 是否复用 | 01B 约束 |
| --- | --- | --- |
| 工作区文件快照与哈希 | 是 | 分析后读取方法体前再次校验文件哈希 |
| 语言 adapter registry | 是 | “可分析”不等于“可迁移”或“可判定实现状态” |
| `RepositoryStaticAnalysis` | 是 | Java/C# 深分析；其他语言能力按已注册 adapter 如实报告 |
| `UnifiedRepositoryIR` | 是 | 保持实体 ID、文件 ID、容器关系和 API evidence |
| Module Discovery Agent | 是 | 提案不可信，不能自行批准模块边界 |
| 宿主确定性 catalog materialization | 是 | 必须绑定当前 IR ID/hash |
| Gate 1 模块边界人审 | 是 | accept 后才允许构建 01B 模块快照 |
| Summary Agent 与模块 Wiki | 否 | 目标骨架不需要被包装成企业存量知识 |
| Gate 2 模块叙述人审 | 否 | 01B 没有 Agent 叙述发布 |
| SQLite publication registry | 否 | 不创建 generation/head/CAS 记录 |
| SeekDB module active head | 否 | 目标骨架不是可复用来源模块 |
| 发布补偿与显式撤销 | 否 | 目标快照通过刷新和 stale 生命周期管理 |

## 正式制品

### 叶子事实

`EntityImplementationAssessment` 是独立于模块边界的静态证据投影。每个 IR callable 必须恰有一条记录，语言 detector 不存在时必须记录 `unknown`，不得省略或默认成 `implemented`。

状态为：

- `implemented`：检测到非空语法实现体；不是业务正确性证明。
- `unimplemented`：检测到高确定性的显式 stub。
- `partial`：检测到 TODO、占位返回等不完整迹象。
- `unknown`：证据不足、空体含义不明、语言 detector 不可用或范围不完整。
- `not-applicable`：接口/abstract/extern 声明、测试、generated 等不进入完成率分母的对象。

每条记录绑定 repository/IR lineage、entity/file ID、可用时的精确 body hash、detector ID/version、reason codes 和 evidence refs。

### 聚合事实

`TargetWorkspaceModuleSnapshot` 只接受 active 且带 Gate 1 review lineage 的 `RepositoryModuleCatalog`。它包含 class、file、module rollup 和 workspace 总计，并满足：

```text
eligible = implemented + unimplemented + partial + unknown
```

test、generated、excluded、unassigned、non-source 和 `not-applicable` 显式进入排除清单。shared 文件中的 callable 必须有唯一模块 owner，避免重复计数。

### 三条正交状态轴

01B 页面不得把三种状态混成一个“完成”布尔值：

1. 静态实现状态：本文件定义的五态。
2. 翻译/迁移运行状态：尚未开始、检索中、生成中、待写回、已写回等。
3. 独立验证状态：`pass | warn | fail | unverified`。

静态 `implemented` 不能跳过编译、测试、契约或人工补丁审阅。

## 生命周期与 stale 规则

选择目标 callable 时必须提交并由 Host 复验：

```text
target snapshot ID/hash
+ module catalog ID/hash
+ entity ID
+ file hash
+ body hash（可用时）
```

- 完全相同 lineage：`current`。
- 只有方法体内容变化且声明、API、文件/项目和 IR dependency projection 均不变：旧 assessment 已过期；可在显式兼容 rebase 后复用已审模块边界，重算 assessment 与祖先 rollup。方法体引起的新调用/依赖边会按结构变化处理，避免沿用旧模块依赖图。
- 签名、类型、文件、项目、API 或模块边界变化：`stale`，必须重新执行模块发现/人审。
- 写回成功：立即使当前目标快照失效，并重扫受影响闭包；当前 Host record 在 rebase/重审期间保留旧 accepted snapshot，但不得继续显示为 current。跨多轮的历史快照归档/浏览器尚未实现，应由后续 `MigrationRunManifest` 或独立审计存储承接。

## Host 与 Webview 权限边界

Webview 只发送 ID/hash 意图，不发送或控制文件系统路径：

- `REFRESH_TARGET_WORKSPACE`
- `SELECT_TARGET_ENTITY`
- `START_TARGET_TRANSLATION`

Host 才能：

- 选择真实 workspace root；
- 运行分析和 Agent client；
- 读取/校验本地文件；
- 记录 Gate 1 reviewer；
- 为 V2 构造并校验开放 `LanguageId` 的目标引用与 `TargetContextSnapshotV2`；仅 deprecated V1 兼容路径才转换为旧 `ModuleTarget`；
- 在启动检索、翻译和写回前复验当前 snapshot/entity/file/body hash；
- 打开目标文件或触发快照失效。

Host record 使用扩展本地 Host-owned 文件存储；workspace ID 只映射为哈希文件名，记录以临时文件 + fsync + 原子 rename 写入。同一进程内按 workspace 串行修改，跨扩展窗口用文件锁和完整 expected-record CAS 拒绝覆盖。扩展重启恢复记录后，打开目录或显式启动翻译前仍会重新分析工作区；持久化记录本身不是 freshness 授权。

前端视图必须显示 module → file → type → callable、搜索、五态筛选、分母统计、原因/evidence、shared/unassigned 与 stale 状态。只有 Host 可解析且当前的 concrete callable，并且其完整 `sourceLanguageId × targetLanguageId × strategy` 路线及必需阶段实时可用，才可以进入正式 V2 迁移流程。

## 当前工作包范围

### 必须完成

1. 稳定共享契约和确定性聚合器。
2. 默认 registry 为 Java、C#、TypeScript、Python、Go 和 Rust 提供语言感知的词法 detector；第三方 detector 可注册，未注册、边界无法可靠隔离或证据不足时显式 `unknown`。
3. 01B Host 生命周期：分析、发现、Gate 1、状态快照、刷新、失效和目标上下文选择。
4. VS Code 命令、Host/Webview 协议和真实目标树接线。
5. 选中 callable 后由 Host 构造正式 V2 目标上下文和内容寻址引用，并按已物化的 exact route capability 决定是否允许检索后的迁移执行；V1 `ModuleTarget` 只是 deprecated 兼容面。
6. 写回后失效旧目标快照。
7. 单元、协议、Host、UI 和跨层构建验证。

### 明确不做

- 不把目标骨架发布到 SeekDB。
- 不在本工作包实现目标模块与存量模块的匹配排序。
- 不实现 module/class 批量翻译。
- 不从非空方法体推断业务语义正确。
- 不把“全面多语言开发”表述为所有语言组合均已可用；Java → C# 仅是历史回归基线，当前执行权由 exact route capability、验证策略和必需阶段共同决定，缺路线、adapter 或必需验证一律失败关闭。
- 不用聚合状态替代编译、测试、独立验证或最终人工 diff 审阅。
- 不用任务目标重新划分已通过 Gate 1 的目标模块；后续 Architect 只能在 immutable catalog 上生成执行 overlay。
- 不在本工作包实现 01B 多轮历史快照浏览器或保留策略；本地 Store 持久化并 CAS 保护当前 record，不等同于完整审计账本。

## 验收证明

1. 同一输入快照重复运行得到相同 structure、assessment 与 module snapshot hash。
2. 每个 IR callable 恰有一条 assessment；不支持语言为显式 `unknown`。
3. 每个 rollup 守恒，shared callable 不重复计数，排除项不从审计记录中消失。
4. C# fixture 覆盖普通实现、显式 stub、空体、TODO、占位返回、合法异常、expression body、constructor、interface/abstract 和字符串/注释误判负例。
5. 分析后修改文件会在 assessment 前失败关闭。
6. 目标模式不会调用 Summary、Gate 2、SQLite knowledge registry 或 SeekDB publisher。
7. objective 改变不会触发第二套目标模块边界。
8. body-only 改动只允许显式兼容 rebase；结构改动使 catalog/snapshot stale。
9. Webview 的路径伪造无效；Host 用 snapshot/hash/node/entity 重新解析。
10. 写回后旧快照被标记失效，不能继续启动翻译。
11. contracts、workflow-core、code-indexer、VS Code extension 的测试、typecheck 与 build 全部通过。
12. Gate 1 已接受但 detector 失败时可显式重试；重试前必须证明工作区仍绑定同一分析快照。
