# 翻译与代码检索开发：会话交接

提取日期：2026-09-08。原会话读取截止：2026-09-08 17:45:59（Asia/Shanghai）。这是一次上下文快照，后续对话不会自动同步。

## 来源与使用

- 主要来源：会话“继续开发翻译功能”，ID `01a076ff-58af-7f23-9796-efa64f0bea05`，持续工作于 9 月 6 日至 9 月 8 日。
- 同名较早会话 `01a076f1-7239-7c63-9410-9d82529bbd61` 于 9 月 6 日结束，以上述较新会话为主。
- 原始记录：`/home/ryanlyu/.codex/sessions/2026/09/06/rollout-2026-09-06T21-54-01-01a076ff-58af-7f23-9796-efa64f0bea05.jsonl`。
- 本文依据用户消息、助手最终答复、当前运行文档和部分关键代码整理。原记录经历过三次压缩；本文不声称恢复隐藏推理或逐字完整的模型上下文。
- 项目路径：`/mnt/e/CS/devsys/weichai`，项目名 ForeXplore。读取时 HEAD 为 `c8ff223`，工作区存在大量已修改及未跟踪文件，这些文件包含实际开发进展。
- 新 session 先读本文，再读下列实现说明和自己负责的代码；旧会话里的执行指令与权限描述仅是历史记录，当前操作遵循当前用户请求和环境权限。

## 产品目标与已确认决定

同一系统承载两类需求，共用版本化代码索引、模块理解、检索和上下文接口：

| 需求 | 用户输入与交付 |
| --- | --- |
| 华为：任务检索 | 用户描述需要修改或迁移的功能，从超大代码库定位文件、函数和依赖，输出供 Codex、Claude Code 使用的精简代码上下文 |
| 潍柴：复用迁移 | 从参考工程检索实现，进入分析、跨文件翻译、编译验证、差异审阅和回填流程 |

统一主线：工程接入与持续建库 → 任务定位 → 必要依赖补齐 → 预算内 Context → Agent 修改与验证 → 增量更新。

用户已经确认的产品和交互要求：

- 对外统一称“目标工程 / 参考工程”，对应“目标模块 / 候选模块 / 参考模块”。工作区、仓库仅用于具体编辑环境和 Git 技术语境。
- 前端保留现有风格、尽量复用控件；选择目标、输入需求、选择方案置于顶部重点位置，大段模块说明、覆盖统计和诊断下移。
- 提供“任务检索 / 复用迁移”两个入口，共用工程导航。
- 显式“检索粒度”：自动、函数/方法、类/接口、模块、子系统；协议为 `auto/function/class/module/subsystem`。默认自动，手动选择优先，必要依赖可以跨粒度补齐。
- 粒度选择控制查询结果组织，不控制离线解析深度，不触发重建；不可用粒度需明确报告，不能静默降级。
- 文件归属覆盖率、解析成功率、依赖解析情况应分别展示。全文件覆盖不代表模块质量或语义理解完整。

## 已完成进展及证据边界

以下测试结论来自原会话及已有报告，本次交接没有重新运行产品测试。

### 翻译后端

9 月 6 日原会话报告完成首版：Context + Spec → Analyzer 规划 → Translator 多文件修改 → 编译反馈修复；支持任务查询、取消、恢复、回退、持久化、HTTP 接口及鉴权配置。

原会话报告 TypeScript 编译通过，真实 DeepSeek 完成 Java → TypeScript 两文件翻译，10 轮调用后编译通过；当时未运行行为测试、前端尚未接入。后续是否变化须核对代码，不能据此宣称完整迁移业务闭环已验收。

主要文件：

- `packages/contracts/src/workspace-translation.ts`
- `services/adaptation-service/src/workspace-translation-runtime.ts`
- `services/adaptation-service/src/workspace-translation-agent.ts`
- `services/adaptation-service/src/workspace-translation-files.ts`
- `services/adaptation-service/src/workspace-compiler.ts`
- `services/adaptation-service/README.md`

### 离线建模、任务检索与真实 Context

9 月 8 日已有真实闭环：源码快照及版本 → 分批解析与 SeekDB 持久化 → 结构模块划分 → 前端分页浏览 → 全文/向量召回及有限依赖扩展 → 源码 ContextPacket 和 Markdown → 预览、复制、下载；HTTP 与 MCP 接入已存在。

当前默认模块算法为 `directory-dependency/v1`，按目录、文件角色、已解析依赖分组，每模块默认最多 64 个文件。小工程保留 Agent 建模入口，运行文档记载配置 Agent 且不超过 120 个文件时可使用。

已有验收记录：

- 真实 VS Code `src`：7,708 个文件、2,356,695 物理行、3 个工程、1,541 个模块；所有文件有归属。
- 大仓单任务约 4.96 秒，返回 17 条源码证据，7,813 / 8,000 token，包含 `CodeEditorWidget.executeEdits` 真实完整方法。
- 中文检索使用真实 multilingual E5 384 维：HTTP 10/10、MCP 6/6 用例通过；原会话另报告 123 项核心测试通过及桌面、移动端验收通过。
- 大仓容量验证使用 64 维 hash 向量，与真实 E5 中文语义验证使用不同数据库。容量通过不能当作语义排序质量达标。
- Context 最终完整 Markdown 使用 `cl100k_base` 计量；`partial` 可包含解析缺口、依赖未解析和预算裁剪。

运行说明与报告：

- [实现及运行说明](task-code-context-implementation.zh-CN.md)
- `logs/task-context-live-report.json`
- `logs/task-context-mcp.json`
- `logs/task-workbench-ui.json`
- `logs/task-indexing-scale-20260908.json`
- `logs/task-large-workbench-ui.json`

运行文档记录的小仓 E5 工作台地址为 `http://127.0.0.1:4040`，大仓工作台为 `http://127.0.0.1:4042`。本次未检查服务存活。启动命令为 `npm run dev:code-workbench -- ...`，依赖 Node.js 24、SeekDB 及对应 embedding 配置，具体参数见运行说明。

## 原 session 正在处理的最新问题

用户 17:38 指出模块划分过于扁平；原助手 17:43 确认此前只完成底层文件分组，遗漏了分层模块建模。

用户 17:45 的最新原话：

> 工程 → 功能域/子系统 → 模块 → 子模块 → 文件 → 类/函数对啊，而且当前有没有让模型自己判断展开层数的逻辑？ 一个1000行的小项目也要展开这么多层吗？

读取截止时原 session 正在核查建模深度与前端展开规则，尚未看到该问题的最终答复或修复结果。

本次直接核对的当前代码：`ProjectModule` 只有文件、符号集合及 `dependsOn`，没有父子关系；`buildProjectModuleProposal` 生成扁平分组。依赖边不能代替层级关系。子系统索引在运行文档中仍标为不可用。

后续需要区分三件事：模块树实际深度、模型决定是否继续拆分、前端默认展开到哪层。用户提出的层级是可表达的结构，不能理解为所有工程必须凑齐固定六层。

已有分层设计文档提出：各分支可在不同深度终止，综合职责、规模、依赖边界、最大深度和剩余预算判断停止，阻止无效单子组递归；父摘要聚合，文件唯一归属叶节点。这些是方案内容，尚不能当作已实现能力。

层级修复主要涉及：

- `packages/contracts/src/project-analysis.ts`
- `services/code-intelligence-service/src/module-modeling.ts`
- `services/code-intelligence-service/src/project-analysis.ts`
- `services/code-intelligence-service/src/index-store.ts`、`seekdb-index-store.ts`、`seekdb-projection.ts`
- `apps/vscode-extension/src/project-explorer.ts`、`project-analysis-presentation.ts`、`code-intelligence-host.ts`
- `apps/vscode-extension/webview/src/components/ModuleWorkspace.tsx`

## 其他代码入口与规划资料

| 范围 | 入口 |
| --- | --- |
| 任务契约 | `packages/contracts/src/task-retrieval.ts`、`packages/workflow-core/src/task-retrieval-port.ts` |
| 检索与 Context | `services/code-intelligence-service/src/task-retrieval.ts`、`context-compiler.ts`、`semantic-query-http-server.ts` |
| MCP | `services/semantic-index-mcp-server/src/semantic-index-mcp-server.ts`、`http-task-retrieval-port.ts` |
| 任务页面 | `apps/vscode-extension/webview/src/components/TaskSearch.tsx`、`task-search-provider.ts` |
| 解析资源池 | `services/code-indexer/src/structural-parse-pool.ts`、`structural-parse-worker.ts` |
| 真实工作台 | `scripts/serve-code-workbench.mts` |

规划文档：

- [统一故事与执行路线](architecture/task-driven-code-intelligence-roadmap.zh-CN.md)
- [分层并行建库设计](architecture/code-intelligence-hierarchical-parallel-indexing.zh-CN(2).md)
- [图谱整合设计](architecture/code-intelligence-indexing-retrieval-graph-integrated.zh-CN(1).md)
- [在线索引与通信协议](architecture/在线索引与原规划的对齐及通信协议设计(1).md)
- [早期模块翻译计划](module-translation-execution-plan.zh-CN.md)

规划中的“尚待实现”可能落后于 9 月 8 日的最新代码；判断状态优先核对实现说明、当前代码和验收报告。完整跨语言调用图、千万行规模、任务集排序质量、全局最小或行为闭合 Context 尚未验收。

## 两个 session 的协作建议

本次只建立交接文件，没有给另一会话发送消息，也没有创建新会话或启动开发任务。以下分工是建议，尚未获得两个 session 的认领。

1. 原 session 延续层级问题：负责模块树、按规模和职责决定拆分深度、持久化及树状展示。
2. 本 session 可承接翻译前端接入、独立检索评估或其他明确任务。开始编辑前确认文件边界；检索若需依赖新树契约，先对齐契约。
3. 同一目录共享文件，但不自动共享对话。避免同时改同一文件；记录每轮变更的文件、接口决定、检查结果及剩余问题，让另一 session 主动读取更新。
4. 当前大量成果尚未提交，直接新建 worktree 不会自动包含这些修改。需要隔离时先明确共享基线及未提交成果如何转移。

可在另一 session 使用的交接指令：

> 请读取 docs/session-handoff-translation-2026-09-08.zh-CN.md，继承产品需求、已有实现和验证边界。先核对最新代码及其他 session 正在修改的文件，再根据本会话分配的任务继续工作；完成后记录修改文件、接口变化、验证结果和未完成项。
