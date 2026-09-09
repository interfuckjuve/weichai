# 计划书修订说明

代码基础：`chiparon/weichai` 的 `9-8-v`（`c3f09d3`）和本次获取的最新分支 `codex/guochuang-ui`（`a02e903`）。计划书功能在 `huawei` 分支实现，测试与配置见 `docs/huawei-implementation.zh-CN.md`。

## 本轮全文措辞修订

以用户提供的 `guochuang.pdf` 为正文来源，技术章节参考现有代码；写作方式参考《面向 Agent 记忆的向量检索系统IO优化-项目文档(1).pdf》。采用从具体问题解释处理方法、约束及验证方式的行文顺序，不引用参考文档的实验成果。

本轮通读第一至第十章已有文字，按语义重写模糊表达，不只做词语替换。例如：

| 原表达 | 修订方式 |
| --- | --- |
| 检索的交付单位是任务证据 | 直接说明返回相关源码、文件位置、版本、接口依赖及未解析信息 |
| 证据构建 | 根据语境写为查找源码、补充依赖或整理模型输入 |
| 证据编译、上下文编译 | 改为源码筛选与上下文整理，说明去重、片段选择及 token 计量步骤 |
| 任务级交付契约 | 说明 ContextPacket 是 HTTP、MCP 和 IDE 共用的返回数据结构 |
| 形成连续证据、开发闭环 | 说明具体执行哪些步骤、保存哪些记录、通过哪些测试 |
| 输入指纹、执行身份、检索投影 | 分别说明内容哈希、执行编号和生成的全文或向量索引 |

保留 AST、JNI、N-API、RRF、背压、增量失效等有明确技术含义的术语，并解释其处理对象或适用条件。保留 11 个公式、历史实验数字和已实现／待验证范围。读取放大率明确为源码读取字节数与返回字节数之比，不等同于数据库物理 I/O。

## 章节安排

- 第一至三章：项目、需求与竞品，删除重复宣传句，具体说明功能、限制和比较方法。
- 第四章：工程索引、任务查询及版本一致性。
- 第五章：多语言解析、资源控制、模块划分、跨语言依赖和增量更新。
- 第六章：不同粒度的代码查找、候选合并、依赖补充及上下文整理。
- 第七章：查询接口、多文件修改、行为测试和恢复。
- 第八章：已有数据、本次验证与后续实验。
- 第九章：教师与学生分工，保留原稿姓名、专业及资历信息，压缩套话。
- 第十章：原稿只有七个小节标题，继续保留提纲，没有补造项目成果或后续承诺。

封面重复的“面向面向”已校正。原团队表格没有实际照片，只有暴露的排版占位命令；修订版保留文字信息并去掉该无效照片列。全文重新排版，目录、书签及正文页码按实际页数生成。

## 可编辑来源与生成方式

- `docs/guochuang-front-chapters.zh-CN.md`：第一至三章。
- `docs/guochuang-technical-chapters.zh-CN.md`：第四至八章。
- `docs/guochuang-closing-chapters.zh-CN.md`：第九至十章。
- 三份同名 `.tex` 由构建脚本生成，编辑时以 Markdown 为准。
- `docs/recast-project-description.zh-CN.tex` 引用上述三个文件，全文内容与 PDF 使用相同主稿。

```powershell
python scripts/build-guochuang-pdf.py --original 'C:/Users/IcebearHound/Downloads/guochuang.pdf'
```

依赖 `reportlab`、`pypdf`、`matplotlib` 和中文字体。默认字体目录为 `C:/Windows/Fonts`，可用 `--font-dir` 修改。PDF 由 ReportLab 排版，TeX 为可编辑输出；本机没有 XeLaTeX，未进行 TeX 编译。

输出为 `output/pdf/guochuang-integrated-revised.pdf`（30 页）和 `output/pdf/guochuang-technical-revised.pdf`（16 页，正文页码 9—24）。构建清单位于 `tmp/pdfs/build-manifest.json`。核对范围包括 255 个段落及标题、141 个表格单元、11 个公式与 61 项目录目标；同时渲染页面检查排版。
