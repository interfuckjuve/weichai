# 校验报告重设计：会话交接

## 2026-09-08 本轮完成记录

本节取代下面的历史状态，记录分类提交前的最终验证结果。对应改动按验证器、adaptation 接收兼容、E2E 和交接文档四类提交；未运行付费模型 E2E。

### 模块范围

- adaptation-service 的生产改动已收窄到 `adaptation-adapter-v2.ts` 的报告接收/兼容映射：验证回执后展示新维度，取消报告映射为 `unverified`，只将关联到已验证失败记录的问题用于修复，并过滤 `source-bug`。另保留少量类型断言说明注释。
- `adaptation-v2-runtime.ts`、`translation-verifier-v2-adapter.ts` 已恢复原状；撤出 policy callback、runtime options、逐轮 policy 透传及新增修复/取消循环分支。分析、计划、翻译、编译、修复次数和上游取消流程未改变。
- 5 个 adaptation 测试/支持文件只消费新报告契约并验证接收边界。未将未知参考决策提升为 accepted。
- 未主动编辑或回滚原先 4 个 C# obj 生成文件；末次 `git status` 已不再列出它们，本轮未保留启动前字节快照，因此不对其内容保留作断言。已批准的 E2E fixtures 删除、六函数任务和 Disk 控制代码均保留。

### 修复与审查

- 已修复原待办 1-10，并完成一次覆盖两服务完整差异及新增文件的集成审查；审查后针对修复补测。
- E2E policy 覆盖按实际变异重新生成预期；拒绝孤立/空白 policy 参数；预检变体只有未覆盖有效依据时才能无 key 执行。
- `missing-policy` 真正省略可选字段，避免 `undefined` 被正式 JSON 输入校验拒绝。所有 9 种请求均经正式输入校验回归。
- 源变异 anchor 必须恰好出现一次；目标单侧计数变异及非 read-body helper 保护已补齐。
- E2E mock 使用 `createVerificationResult`，生成有效 inputHash/contentHash；测试自行登记并清理结果目录。README 已修正数量、target-only 描述和外层 timing 布局。
- 服务取消/超时后有 250ms 有界报告收尾窗口；合作策略可以保存已验证发现，非合作策略仍有界返回。原生 TimeoutError、Error/字符串取消原因均有正式服务回归。
- 缺/坏报告不再掩盖基线损坏、命令超时等独立问题。Host 强制取消结论；`completed` 不允许未解决问题，`cancelled` 问题不能伪装为其他执行状态。
- runner 编译失败后，后续已声明的成功编译可以消除该历史编译错误对最终完成状态的影响；原失败执行记录仍保留。未恢复编译失败、运行失败和超时仍为 problems。

### 本轮实际验证

- translation-verifier：25 个测试文件，**406 项通过**。
- adaptation-service：24 个测试文件，**223 项通过、1 项跳过**。
- `test:e2e-data`：E2E TypeScript 检查通过，**38 项 Vitest + 6 项 node:test 通过**；包含 Maven 控制测试，本轮未跳过。
- 两服务正式 build（包含 schema-types 新鲜度检查）通过。
- 受影响文件 LSP 无类型错误；`lens_diagnostics mode=all` 最终检查的 34 个会话文件无 error。它不是全仓库安全审计。旧 `parseJson` 行号告警经单文件主动检查确认为缓存问题，未因此改变业务解析流程。
- 两服务 `git diff --check` 通过。
- 实际无 API key 调正式 CLI：`missing-policy`、`missing-test-basis` 均生成完整报告且固定字段匹配，未调用模型。
- 预检报告：`test-results/verification-57e1f9fc-fe58-4e0f-8c2b-40c763debefa/report.json`、`test-results/verification-19ffe81d-8b9d-4ff0-af72-fca1581054ff/report.json`。

### 明确保留的边界

- 本轮不替 adaptation 上游注入 Host policy。现有请求若没有独立依据，默认 smoke 保持 `unverified`，不得自动放行；后续接入由该模块所有者完成。
- 集成审查提出强制所有通用策略填写 `verificationPolicy.testBasis` 的建议未实施：通用注册策略是受信任 Host 代码，可使用固定 acceptance tests 等自身独立依据；将 smoke 的输入文本字段变成所有策略的强制前提会扩大共享契约与上游模块改动。默认 smoke 两种模式的 basis 门禁已实际验证；任何策略若明确报告 `insufficient_test_basis`，不能同时确认代码结论。通用报告结构与哈希校验不证明自定义策略真的执行了有意义的测试，此信任边界已写入 README。
- 250ms 之外的迟到恢复结果不保证保留，尤其底层进程树清理较慢时。不能宣称任意取消/超时都能完整恢复。
- expected/expectedBySide 仍由验证 Agent 基于 Host 文本推导，需人工复核。此次无真实模型会话，不能据此宣称模型能稳定定位所有预期缺陷。

## 上一会话状态（以下为历史记录）

- 工作区：`/Users/zen/Studio/projects/client/weichai/.worktrees/translation-verifier-refactor`。
- 所有改动未提交。实施大部分已完成，但**尚未完成最终集成审查，不应直接宣布完成或合并**。
- 用户要求暂停并新开会话。本文件记录实际状态，不是新的实施批准。
- 子代理因 API 配额不足退出；其修改已写入工作区。后续由主代理接手，无需重启这些代理。

## 用户最新范围限制（最高优先级）

用户明确：`services/adaptation-service` 不是其负责模块。尽量不破坏原有功能，**只修改翻译模块收到测试模块报告的那部分接口**。

当前 adaptation-service 改动超出此范围。新会话第一项任务应是收窄这些改动，而不是继续扩展 Host 注入、运行时或修复循环。

- 优先保留必要的新报告类型消费、报告校验与旧验证门禁映射。
- 重新评估并移除本轮新增的 `AdaptationAdapterV2Options.verificationPolicy` 回调、runtime options 透传和遍及修复轮次的方法签名变更，除非证明确实是报告接收接口所必需。
- 恢复已有取消/修复业务流程，避免为了测试模块设计顺手改变其他团队模块。
- 不要把“未知参考可靠性”自动改成 accepted 来维持旧测试。
- 注意本轮部分文件遭自动 formatter 整文件重排，diff 体积远大于业务改动。收窄时先逐项辨认，不可直接 `git checkout` 或整文件覆盖，避免覆盖用户/其他会话改动。

## 已确认的需求

数据集模拟上游翻译模块发送的真实 `VerificationInput`，预期输出是测试模块应产生的校验报告，而不是翻译代码。

E2E 调正式 `VerificationService.verifyWithReceipt()`，保存完整报告，只自动比较稳定结构字段；是否真正定位到预期 bug，由用户人工审查，不做 LLM 自动评分。

报告拆分：

- `mode`: `differential` / `target_only`。
- `referenceDecision`: `accepted` / `rejected` / `undetermined`；`referenceReason` 说明原因。
- `executionStatus`: `completed` / `partial` / `failed` / `cancelled`。
- `sourceAssessment`, `targetAssessment`: `bug_found` / `no_bug_observed` / `suspected_bug` / `inconclusive` / `not_checked`。
- `problems[]`: 分类的执行/报告问题。
- 四种双侧情况独立表达：均未发现 bug、仅源有 bug、仅目标有 bug、双侧有 bug。
- target_only 的源结论必须是 not_checked。
- 缺少可信测试依据不能通过；差分相等也不能证明两侧都正确。

旧 `status` 暂保留为兼容投影，不作为主要报告/E2E 口径：目标 bug -> fail；完成且目标未发现 bug、差分时源侧也有结论 -> pass；其余 unverified。warn 不产生。此兼容决定此前已告知用户，但新会话仍需按最新模块边界检查落点。

## 测试模块已实现

### 契约与宿主报告

主要文件：

- `services/translation-verifier/src/schemas/verification-input.schema.json`
- `services/translation-verifier/src/schemas/verification-output.schema.json`
- `services/translation-verifier/src/schemas/verification-schema-types.d.ts`
- `services/translation-verifier/src/schemas/verification-types.ts`
- 新增 `src/schemas/verification-assessment.ts`、`.test.ts`
- `src/run-output/create-verification-result.ts`
- `src/schemas/validate-verification-result.ts`
- `src/workflow/run-verification.ts`
- `src/workflow/prepare-strategy-workspace.ts`

输入新增可选 Host-owned `verificationPolicy`：

```ts
{
  referenceDecision: "accepted" | "rejected" | "undetermined",
  reason: string,
  testBasis?: string
}
```

缺省 -> target_only / undetermined，不授权源代码运行。两种模式都要求独立 testBasis，否则 smoke preflight 返回 insufficient_test_basis。

新字段在正式策略输出和最终报告中必填。`inputHash` 绑定完整 canonical input，包括策略依据、源/目标快照；`subjectHash` 仍绑定翻译补丁。不能用同一个补丁哈希复用不同验证依据下的报告。

宿主会对有效请求的工作区失败、策略失败、取消生成报告；输入本身不合法或策略不存在仍抛错。落盘失败返回明确结果，不伪造 artifact 路径。

目标单侧模式不暂存源文件。注意源码目录目前可能为空目录，不代表源文件可访问。

### Smoke 策略

改动范围：`src/strategies/smoke-differential/`。

- 根据 Host policy 生成双侧或仅目标 prompt、addDirs、只读目录和 runner 区。
- target_only 不把源路径/分析内容放入 prompt；命令代理通过 `VERIFIER_MODE` 拒绝 source 运行及 source cwd。
- 每个报告 case 新增 sourceAssessment/targetAssessment、`commandIds`、`requirement: { basis, expected }`。
- basis 必须匹配 Host testBasis；实际 CaseResult 必须与对应真实 run stdout 的 JSON 观测一致。
- 不再把旧 decision/sourceIssues 自述当成确诊依据。
- 报告缺失、非法 JSON、schema 不合格、证据无效、超时、基线损坏等分类到 problems。
- 后续超时可以保留已验证发现为 partial。
- 主代理最后补充：报告中显式列出的失败命令也可以与此前有效发现共存，不再一律清空结论。
- 主代理最后补充：`requirement.expectedBySide?: {source?,target?}` 用于需求明确允许的语言表示差异，例如异常类型不同；仍要人工复查 Agent 对期望的推导。
- 主代理最后补充：正式报告要求 runnerFiles；命令证据结构检查更严格。

## E2E 已实现

旧 `services/translation-verifier/e2e/fixtures` 已按用户前一轮要求删除，不要恢复。

真实项目：

- `fixtures/code-corpus/commons-fileupload-python`
- `fixtures/target-system/commons-fileupload-java-skeleton`

六个真实 TODO 函数仍保留为任务目录：MultipartStream.readBodyData/skipPreamble，DiskFileItem.getInputStream/get/write/getOutputStream。

主要文件：

- `e2e/fileupload-benchmark-fixture.ts`：请求构建、参考策略、预期字段。
- `e2e/fileupload-datasets.json`：原 14 项 Host-only 手工场景 + 新 executableCases。
- `e2e/run-smoke-e2e.ts`：正式服务调用、report.json、comparison.json。
- `e2e/run-fileupload-benchmark.ts`：同步新版请求。
- `e2e/fileupload-benchmark-fixture.test.ts`、`smoke-e2e-timing.test.ts`。
- `e2e/tsconfig.json`，package script `test:e2e-data`。

当前 variant 共 9 种：correct、count-plus-one、drop-output、source-count-plus-one、both-count-plus-one、target-only-correct、target-only-count-plus-one、missing-test-basis、missing-policy。

翻译补丁仍是上游 Apache 1.5 控制样本或注入缺陷，非本次真实模型翻译。预期答案不得传给 Agent。

## adaptation-service 原始改动（已收窄）

8 个文件被修改：

- `src/adaptation-adapter-v2.ts`：增加 policy 回调和逐轮透传、导出统一 `behaviorVerificationInput()`、摘要记录新维度、修复按 targetAssessment 判断、cancelled 分支。
- `src/adaptation-v2-runtime.ts`：新增 policy option 透传。
- `src/translation-verifier-v2-adapter.ts`：复用 request 转换和新报告校验。
- 5 个测试/支持文件：adaptation-adapter-v2.test.ts、adaptation-v2-runtime.test.ts、adaptation-v2-test-support.ts、http-server.test.ts、translation-verifier-v2-adapter.test.ts。

用户最新要求仅修改报告接收接口。因此 policy callback/runtime/修复循环业务扩展应优先撤出或收窄，不要以“测试已通过”为理由保留超范围设计。

## 上一会话验证结果（历史）

- translation-verifier：**382 项测试通过**（最新运行，含超时 partial 和语言差异新增用例）。
- adaptation-service：**225 项通过，1 项跳过**。
- E2E 数据/封装：**24 项 Vitest + 6 项 node:test 通过**。这是上一轮执行，最后的 expectedBySide/证据检查修改后尚未重跑。
- translation-verifier build：通过，但最后 expectedBySide/证据检查修改后尚未重跑 build。
- adaptation-service build：通过。
- `git diff --check -- services/translation-verifier services/adaptation-service`：通过。
- 没有运行真实 Claude/DeepSeek E2E 模型会话。
- schema-types 曾被自动 formatter 改写而 stale；已重新运行 generate:schema-types，并随后测试通过。不要手动格式化生成的 d.ts。

pi-lens 当前残留 adaptation-v2-test-support.ts 的 3 条旧类型诊断（导出不存在、verificationPolicy 不在 keyof）。真实 tsc/build 已通过，多次 LSP 查询仍有旧缓存。最后 lens_diagnostics mode=all 显示这 3 条 stale，不能在交接中声称全部诊断清零；新会话刷新或结合 tsc 标记误报，不要为了缓存问题改坏正式类型。

## 原交接待办（处理结果见本轮记录）

1. **先收窄 adaptation-service 范围**，只保留必要报告消费接口兼容，恢复其他业务流程和无关格式化。
2. `repairIssues()` 当前在目标有 bug 时会传递整份 issues，包含可能的 `source-bug`；若保留这里的修改，必须避免把源侧问题变成目标修复指令。更优先按用户要求把映射放在报告适配边界。
3. E2E `expectedForOptions()` 对 `target-only-correct --reference-decision accepted` 等覆盖组合会继承 not_checked 源预期，造成矛盾；missing-basis variant 覆盖了有效依据后仍可能期望失败。应修正或明确拒绝这些不受支持的组合。
4. E2E CLI 目前 missing-policy/missing-test-basis（本应无需模型调用）也提前要求 API key；可允许这些 preflight 用例无 key 运行，不要把 --offline-only 当验证。
5. `sourceFilesFor()` 只检查 core.py 唯一，未检查 `return len(body)` 替换 anchor 唯一；应在变异时失败关闭。
6. `fileUploadInput()` 的非 read-body 缺陷保护应同步涵盖 target-only-count-plus-one；CLI 有保护，但直接 helper 调用需复核。
7. E2E README 仍写“eight executable request cases”，实际有 9 种；目录图仍把 timing 文件画在内部 Agent workspace，实际是在外层 resultsRoot；仍有“both runners”措辞未区分 target_only。
8. E2E tests 的 mock VerificationResult 是双重类型断言，缺少真实 inputHash/contentHash，部分运行产生临时结果目录未登记清理。应使用 createVerificationResult 构造合法 mock，并清理本测试产生目录。
9. 框架 `waitForStrategy()` 在外层取消/超时立即返回，可能比 smoke 恢复 partial 报告早；目前直接 runSmoke 可恢复部分结果，但服务层超时可能丢失它。必须诚实区分；若修复要有界等待并保持非合作策略按时返回，不破坏上游取消语义。
10. 缺报告时 evaluateEvidence 先返回 report_missing，可能没同时记录 command_timeout/baseline 错误；设计允许多个 problems，当前覆盖尚不完整。
11. expected/expectedBySide 是独立验证 Agent 基于 Host 文本推导，并非机器证明其来源正确；人工检查仍必要。不能宣传为完整语义正确性证明。
12. 尚未做完整最终集成审查；完成收窄/修复后重跑两服务 tests/build、test:e2e-data、诊断和差异检查。

## 原有工作区改动保护

本任务最初就有 `fixtures/code-corpus/commons-fileupload-csharp/obj/Debug/net8.0/` 下 4 个生成文件处于修改状态，不是本任务源码改动，不要回滚。

上一轮删除 fixtures、六函数 E2E 数据集和 Disk 控制代码均为用户已要求的改动，需要保留。不要用 HEAD 一键恢复整个 E2E 目录。

## 新会话建议开场

“请先读 services/translation-verifier/docs/verification-report-redesign-handoff.zh.md。继续校验报告重设计，但先收窄 adaptation-service 修改到报告接收接口，不改其原有翻译/修复/取消业务流程。完成剩余风险修复和集成验证，不运行付费模型 E2E。”
