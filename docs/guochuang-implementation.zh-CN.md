# guochuang 计划书实现与验收

## 基线与范围

依据 `guochuang-technical-revised.pdf` 第四至第八章。2026-09-09 已执行 `git fetch --all --prune`，核对三个远程：`origin/main` 为 `d732249`，`upstream/main` 为 `c8ff223`，`darkstars/main` 为 `92c8084`。`origin/huawei` 的 `f7c3136` 已包含这些主线提交，并包含计划书所述的实现，因此 `guochuang` 从该提交继续开发。开发期间 `origin/huawei` 更新为 `2ee7278`（包含 `a02e903` 的 RECAST 界面），本分支在最终提交前也合并该更新并复验。

本次使用独立 worktree，原工作区的未提交修改不进入本分支。PDF 的既有实验记录是需求背景，不作为本次实测结果。

| 计划书环节 | 本分支代码与验证 |
| --- | --- |
| 4、5：版本化建库、资源背压、模块分层、增量更新 | 保留最新基线的源码快照、分批解析、进程及在途字节限制、同级模块并行、检查点恢复和全量/增量等价回归 |
| 5.4：跨语言连接 | 保留 C/C++、Kotlin、ArkTS 前端和 JNI/N-API/KMP 保守绑定；新增 JNI 重载长名称、基本类型和数组参数描述符；短导出名冲突和无法确定的类型保持未解析 |
| 6：任务检索、上下文编译 | 保留多视图召回、版本/粒度约束、依赖补充、覆盖选择及最终文本预算；新增互不重叠的阶段耗时 |
| 7：证据交接与开发协同 | 浏览器工作台和 VS Code 使用相同宿主交接；所选证据、来源快照、关系、缺口进入多文件翻译；展示计划、差异、编译/测试结果，支持取消、继续、按编号恢复和回滚 |
| 8：评测 | 新增带人工标注的 HTTP 评测命令，输出 Recall@K、MRR、nDCG@K、必要证据覆盖、任务成功率、平均/P95 延迟、源码行重复率和源码读取放大率 |

## 生成与验收配置

后端沿用现有配置：

- `ADAPTATION_PROJECT_ROOT`：实际写入工作区。
- `ADAPTATION_WORKSPACE_TRANSLATION_ENABLED=true`。
- `ADAPTATION_WORKSPACE_TRANSLATION_TOKEN`：至少 32 字符的鉴权令牌。
- `ADAPTATION_WORKSPACE_COMPILE_COMMAND`：宿主编译命令 JSON。
- `ADAPTATION_WORKSPACE_VERIFICATION`：行为测试命令及只读验收文件，格式见 `huawei-implementation.zh-CN.md`。
- 远程模型沿用 `DEEPSEEK_API_KEY` 等服务配置。

启动扩展或浏览器工作台的进程设置同一 `ADAPTATION_WORKSPACE_TRANSLATION_TOKEN`，并设置 `FOREXPLORE_TRANSLATION_PROFILE` 为以下格式的 JSON。示例路径需要替换为实际工作区；建议使用用于审阅的独立 worktree：

```json
{
  "workspaceRoot": "D:/CodeProjects/translation-review",
  "sourceLanguage": "Java",
  "targetLanguage": "TypeScript",
  "workspaceFiles": ["src/upload.ts", "src/errors.ts", "tests/upload.test.ts"],
  "writeFiles": ["src/upload.ts", "src/errors.ts"]
}
```

扩展读取已有的 `forexplore.adaptationApiUrl` 设置；浏览器使用 `--adaptation-url`。例如：

```powershell
npm run dev:code-workbench -- --target D:/CodeProjects/translation-review --reference D:/CodeProjects/reference --adaptation-url http://127.0.0.1:8788
```

检索并勾选证据后，点击“生成与验收”。面板先显示实际写入目录、允许修改的文件及是否配置行为测试，再由用户点击“使用所选证据生成代码”。这是现有服务的原地修改流程；审阅标记只保存在当前页面，不会另行提交 Git。运行编号可用于刷新页面或重启宿主后的读取、继续与回滚。

宿主缓存最多 16 个上下文包，页面只发送包编号、证据编号和操作意图，不发送源码、写入路径、命令或令牌。新鉴权接口 `GET /v1/workspace-translations/configuration` 用于检查工作区；配置指纹确保提交时仍与预览一致。同一宿主会话内，相同包与证据的重复启动复用同一次操作。收到不确定的启动响应时保留该操作，不自动重试写入。

运行仍由后端执行源码快照核验、只读测试文件保护、单写入者约束及冲突回滚检查。只有编译和固定行为测试都通过才显示 `behavior-verified`；仅编译通过不能代替行为验收。

## 检索观测与评测

`ContextPacket.usage.retrieval.stages` 包含 `snapshotMs`、`recallMs`、`candidateResolutionMs`、`expansionMs`、`compilationMs`。三条召回通道的并行部分按墙钟计时，不累加重叠耗时。查询向量编码发生在存储适配器内，包含在 `recallMs` 中。原有字段保持兼容。

评测输入为 JSON 数组，每项包含独立任务编号、完整 `TaskRetrievalRequest`、相关结果标注 `relevant` 和必要源码标注 `requiredEvidence`：

```json
[
  {
    "id": "upload-limit",
    "request": {
      "requestId": "eval-upload-limit",
      "requirement": "限制上传文件大小并处理超限错误",
      "granularity": "function",
      "scopes": [{ "repositoryId": "真实仓库编号", "analysisRevision": "已发布版本编号" }],
      "budget": { "maxTokens": 4000, "maxLatencyMs": 10000 }
    },
    "relevant": [{ "repositoryId": "真实仓库编号", "relativePath": "src/upload.ts", "relevance": 3 }],
    "requiredEvidence": [{ "repositoryId": "真实仓库编号", "relativePath": "src/upload.ts", "startLine": 10, "endLine": 30, "relevance": 3 }]
  }
]
```

```powershell
npm run evaluate:guochuang -- --tasks tasks.json --url http://127.0.0.1:4041 --output report.json --k 10
```

标注等级为 1、2、3，可用 `symbolKey` 标注精确符号。排名指标对应主要结果，源码覆盖对应交付证据；两者分别标注，不能把依赖源码的符号身份误作主要命中的身份。未给行范围的必要证据必须以非截断源码交付。重复命中不重复增加排名收益；重复源码指标按同版本、文件内容身份和行号计量，同一行的不同列范围可能计为重复。

本实现的“任务成功”定义为：至少一个主要结果命中标注，且全部必要证据已经交付。失败/超时记零分并保留实测耗时，参与总体分母；HTTP 错误不会被排除。延迟使用客户端墙钟时间，P95 使用最近秩方法。只有检索数据时不计算功能完备度，也不据此证明 90%/10 秒目标已经达到。可通过同一任务集分别运行不同后端配置进行对照；命令本身不修改生产检索算法。

## 功能测试

`npm test` 包含新增 `test:guochuang`。端到端用例采用真实源码索引、实际 HTTP 请求、实际评测 CLI 子进程、真实 Node 编译与行为断言，覆盖所选证据交接、错误身份拒绝、配置指纹、重复启动和重建客户端后的回滚；模型返回固定工具调用，用于检验协议及执行路径。

前端组件测试覆盖目标预览、证据编号交接、失败状态、差异审阅和回滚。三个已有真实 Git worktree/commit 用例在 Windows 上超过默认 5 秒，为这些用例单独设置 15 秒，未删除或放宽功能断言。

2026-09-09 合并最新界面前，完整 `npm test`：**662 项通过、1 项跳过**。同步 `2ee7278` 后，上游移除一个旧界面用例；本次复验扩展 135 项、端到端 2 项及 Git 波次 9 项均通过，最终测试集合为 661 个通过用例和 1 个跳过用例。跳过项是原有 `RUN_DOTNET_INTEGRATION=1` 控制的 .NET 集成用例。code-indexer、code-intelligence、adaptation-service 构建、扩展/Webview 类型检查、扩展打包及旧网页构建均通过；扩展打包仍有基线已有的 CJS `import.meta` 静态警告。

复现命令：

```powershell
npm ci --no-audit --no-fund
npm test
npm run build --workspace @forexplore/code-indexer
npm run build:code-intelligence
npm run build:adaptation
npm run typecheck --workspace forexplore-vscode
npm run build
npm run build:web
```

## 未由本次测试证明的范围

本次没有运行真实大仓容量实验、真实 SeekDB/远程模型质量评测或完整 SDK 构建。基线中记录的分片、跨宿主原子任务抢占、按变化类型复用模块产物、JNI 动态注册、完整 ArkUI/编译上下文语义，仍属于后续工程范围。新增 JNI 长名称解析是语法证据，不能替代编译器类型绑定。固定夹具通过不等于未知任务上的检索准确率或代码功能完备度达标。
