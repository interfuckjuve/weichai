# guochuang.pdf 技术部分修订说明

基线：`chiparon/weichai` 的 `9-8-v` 分支，提交 `c3f09d3`，2026-09-08 22:35:58 +0800。原 PDF：用户提供的 36 页 `guochuang.pdf`。原工作区有未提交修改，因此在独立 worktree `D:/CodeProjects/Weichai-guochuang`、分支 `huawei` 内完成。

## 结构重整

| 新章 | 集中处理的内容 | 与原稿的关系 |
| --- | --- | --- |
| 四 面向大型工程理解的系统框架 | 系统边界、分层职责、两条业务链路、共同约束 | 合并原四的挑战与原五的总体方案，删除按技术逐项重复“问题—解决思路”的介绍 |
| 五 依赖约束的分层建模与增量索引 | 源码事实、受限解析、Agent 提案、层级状态、依赖与更新 | 集中原六的离线建模机制；操作细节移至七 |
| 六 任务驱动的级联检索与证据编译 | 范围校验、混合召回、有限扩展、上下文计量与补取 | 集中在线机制，避免原四、五、六、七反复解释检索与上下文 |
| 七 Agent 协同开发与工程实现 | 工作台、用户操作、HTTP/MCP、IDE、翻译执行与运行 | 用输入、操作、输出和状态说明产品，不再逐项复述算法 |
| 八 实验设计与阶段结果 | 最新实现状态、已有记录、证据口径、正式指标及实验计划 | 将原提纲补成正文，区分历史扁平基线、结构层级与最新 Agent 产物 |

## 技术论证与文风修订

参考用户提供的《面向 Agent 记忆的向量检索系统IO优化-项目文档(1).pdf》，借鉴其从访问行为或成本矛盾推导技术机制、再解释正确性条件与验证方法的论证方式。未移植该文档的实验数据、算法成果或结论。

本版补充流水线吞吐和内存分解、模块集合约束、任务身份与过期写入防护、增量失效闭包、排名融合、读取放大、覆盖收益及预算约束等 11 个公式，说明变量含义和适用边界。跨语言关系按构建上下文和证据端点解释，开发验证区分编译通过与行为保持。第八章集中列明基线已实现能力和待实现机制，避免各节反复插入状态声明打断技术论证。

## 实现与数字核对入口

| 正文内容 | 当前仓库依据 |
| --- | --- |
| Agent 默认要求、120 文件阈值、投影单独重试 | `services/code-intelligence-service/src/project-analysis.ts` |
| 层级划分、细化原因和模型来源 | `services/code-intelligence-service/src/module-modeling.ts`、`module-hierarchy.ts`、`module-hierarchy-planner.ts` |
| 模块协议 | `packages/contracts/src/project-analysis.ts`、`module-hierarchy.ts` |
| 可回收解析进程 | `services/code-indexer/src/structural-parse-pool.ts`、`structural-parse-worker.ts` |
| 版本与混合索引 | `services/code-intelligence-service/src/seekdb-index-store.ts`、`seekdb-projection.ts` |
| 粒度、固定范围、受限候选及依赖 | `services/code-intelligence-service/src/task-retrieval.ts` |
| 精确计量、范围去重、缺口 | `services/code-intelligence-service/src/context-compiler.ts` |
| 页面预算移除与请求边界 | `apps/vscode-extension/webview/src/components/TaskSearch.tsx`、`apps/vscode-extension/src/protocol/messages.ts` |
| HTTP 与 MCP | `services/code-intelligence-service/src/semantic-query-http-server.ts`、`services/semantic-index-mcp-server/src/semantic-index-mcp-server.ts` |
| 翻译执行和 compilation-only | `services/adaptation-service/src/workspace-translation-runtime.ts`、`packages/contracts/src/workspace-translation.ts` |
| 规模、模型与 UI 历史记录 | `docs/task-code-context-implementation.zh-CN.md` |
| 早期两文件翻译记录 | `docs/session-handoff-translation-2026-09-08.zh-CN.md` |

旧说明书关于“仅结构基线、模型仅可选”的实现描述已更新。保留真实 Agent 模块结果与待细化状态，注明一次模块检索 15.537 秒；没有将现有记录包装成三项命题指标已达标。正文引用的大仓和远程模型历史数字没有在本次任务中重跑。新增 huawei 代码的固定样例、实际命令及测试结果见 `docs/huawei-implementation.zh-CN.md`，第八章已区分新验证与历史记录。

## 交付与复现

- `docs/guochuang-technical-chapters.zh-CN.md`：技术五章的可编辑主稿。
- `docs/guochuang-technical-chapters.zh-CN.tex`：由主稿生成的 LaTeX 章节，可放入原工程并从第四章位置引用。
- `docs/recast-project-description.zh-CN.tex`：仓库已有说明书，第四至第八章改为引用新章节；第一章只做必要的现状一致性更新。它的其他章节原本就与用户 PDF 不同，不能拿它直接编译替代完整整合版。
- `output/pdf/guochuang-technical-revised.pdf`：技术部分独立阅读稿，页码从 13 开始，供替换原第四至第八章。
- `output/pdf/guochuang-integrated-revised.pdf`：保留原封面、第一至第三章、第九至第十章页面，替换技术部分，重建到节一级的目录、书签和连续正文页码。

原 PDF 非技术部分保留既有内容，包括原封面的重复字、团队图片占位文本和第十章提纲。它们不属于本次第四至第八章修订范围。原 PDF 的中文在 pypdf 直接提取时存在字体映射问题，因此保留页使用原页面对象，核对文字时使用 pdfplumber。

生成方式（依赖 `reportlab`、`pypdf`、`pdfplumber`、`matplotlib` 和中文字体）：

```powershell
python scripts/build-guochuang-pdf.py --original 'C:/Users/IcebearHound/Downloads/guochuang.pdf'
```

默认使用 `C:/Windows/Fonts` 的宋体与微软雅黑，可通过 `--font-dir` 指向包含相同字体文件的目录。构建清单保存在 `tmp/pdfs/build-manifest.json`。PDF 使用 ReportLab 排版并拼接原页面；LaTeX 源码供继续编辑，本机未安装 XeLaTeX，未声称通过 LaTeX 编译。
