# 现有工程真实验证结果

记录时间：2026-10-23。原始报告、模型 trace 和编译产物位于本机仓库外 runtime；本文不包含凭据或隐藏测试源码。操作说明见 [Windows 环境说明](WINDOWS-ENVIRONMENT.md)。

## 当前结论

完整环境已配置，六种测试/覆盖率 runner、基础服务、生产检索及扩展真实 Analyzer/Translator 路径已有执行证据。以下为本次交付采用的已通过模块覆盖率快照；后续章节保留各轮诊断和历史观察。

| 已通过模块范围 | 目标函数数 | 平均行覆盖率 | 最低行覆盖率 | 行覆盖100%的函数数 | 平均分支覆盖率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Java：common、error、observability、security、telemetry、audit、retry、messaging、routing、persistence | 320 | 99.78% | 64.29% | 316 | 97.35% |
| C# Pro：contracts、domain、policies | 115 | 99.38% | 73.68% | 111 | 91.55% |

统计来自 `full-java-20261023-v3` 与 `full-csharp-pro-20261023` 的 `full-project-report.json`，每模块取最后一个 verified 轮次的分组 Host observation，全部435个目标均 executed。平均值为逐函数百分比的算术平均，不按源码行数加权；无分支方法的分支覆盖为null，不计入分支平均值，Java/C#分别有124/49个函数参与分支统计。分组共享测试目录，不能相加各组测试数。

C# 最终统一 Host 观察为336/336测试通过、0skip、0executionErrors；全范围287个函数中包含尚未实现的骨架，因此逐函数行覆盖率平均为39.82%。该数字与上表已通过模块的统计口径不同。单独公开功能组复验为936/936测试通过，8个目标行覆盖均100%，7个有分支目标平均分支覆盖96.43%。原报告及各阶段状态保留。

七个参考仓库的 CPU 索引已全部完成。Camel为7203/7203文件、249907条搜索投影文档；前六参考建模完成，Camel建模记录为failed，原错误为“Agent 未能完成有效的功能模块分析，请检查模型服务后重试。”。

早期附件边界实验的真实 DeepSeek → Java 编译 → verifier 测试 → Maven/JaCoCo → Host 重验已跑通，三个目标方法均有逐函数覆盖；该轮独立隐藏验收未通过，其结果作为单独历史保留。

现有两目标、公开需求、隐藏测试和七参考均被直接复用，没有新增数据集或改写原目标骨架。

### 收尾问题诊断（08:34 UTC）

完整 C# Pro 的 contracts 组出现真实模型循环：27 次测试写入中 26 次完整内容相同，测试持续 10/10 通过且五个目标有覆盖，最终耗尽时间预算。独立网络探针的八轮请求保留全部历史与成对工具结果，八个 completion id 全部不同；该现场没有工具结果丢失或消息 ID 覆盖证据。完整运行已停在第三轮准备阶段，原 checkpoint 和失败 trace 保留。

另一个受控负例从已通过公开组的生产源码开始，只移除空订单 Lines 集合检查；独立 oracle 先通过基线，再拒绝该变异。真实 verifier 自行生成的 32 条测试中 31 通过、1 条有效失败，Evaluate 行/分支覆盖均100%、零 skip 和执行错误。模型正确识别缺陷，但五次最终报告都夹带说明文字，严格 JSON 解析拒绝，原实验最终仍为预算失败。

早期候选探针 `csharp-completion-policy-v2-20261023` 与 `controlled-order-completion-20261023` 曾返回通过，但进一步核对发现传输层把数组形式的 system content 拼接为字符串，意外丢失原系统指令。这两份结果保留为诊断历史，不能作为仅追加收尾指令的有效对照。

正式修改在 Host 中保留全部原指令后加入明确停止条件和纯 JSON 示例，38项回归及strict TypeScript通过。直接使用实际Host的正负复验均exit0：`csharp-host-completion-20261023`四轮完成，原测试文件不变，独立TRX为10/10、零skip/错误，五个目标行覆盖均100%；`controlled-order-host-20261023`正确返回translation失败，独立Host重跑19条、18通过/1有效失败、零skip/执行错误、Evaluate行/分支100%，生产源码hash保护通过。正例一次、负例两次格式反馈后才接受纯JSON；该改善不保证模型每次首轮都遵守输出格式。严格解析、覆盖率门槛、预算失败分类和独立Host重验保持不变，完整工程及冻结隐藏验收仍未完成。

### Java受控缺陷补充（08:57 UTC）

复用现有250文件骨架，仅复制已验证的 `TenantId` 实现，不复制任何公开或隐藏测试。明确补充实验验收要求：`sameAs` 对相同租户值为true，不同租户值和null为false。独立oracle先通过三个基线行为，再只移除值比较；变异编译成功但被oracle拒绝。真实 `deepseek-flash` 自行生成测试并正确返回translation失败，独立Host复验5条、3通过/2有效失败、0skip/0执行错误，`sameAs` 行/分支均100%。全部原生产/输入hash保持受控预期，模型未修复或改写变异源码。证据为 `experiments/controlled-java-tenant-20261023/controlled-fault-report.json`。这是隔离的能力探针，不是原冻结隐藏分数或新数据集。

### 完整工程的公开失败证据（09:28 UTC）

Java attachment 第1轮第3组已形成正式 `issue.kind=translation` 失败结论，Host 重验1222条、1216通过/6失败、0skip、0执行错误，8/8目标均执行。`intake` 行/分支79.69%/61.54%，`release` 为88.57%/81.25%。初始生成测试将多方法接口当成lambda的编译错误已由模型自行修正，最终失败来自断言。

公开需求明确要求文件名规范化、有效校验和重复命令单条审计，这些方面的失败有直接契约依据。另几项断言将 `accepted` 解释为扫描通过，或要求跨租户请求在隔离前完全无副作用；原需求对这些时机和返回值语义没有同等明确的规定，不能把六个失败一律算成六个已证实缺陷。全部测试、原结论与trace保留。该观察未使用冻结隐藏测试。

### 无效工具调用协议恢复

真实 Java 验证期间发现，模型返回畸形 JSON 工具参数后，LangChain保留原始tool_calls但未生成对应ToolMessage；下一次请求因此被服务端以HTTP400拒绝。Host现对包含无效参数的整批调用返回配对错误反馈，不执行批次中的写操作，随后沿用原有独立重验和反馈循环恢复。缺少唯一调用ID时明确拒绝，模型轮次及每轮调用数限制保留。

五项传输层回归覆盖无效批次、混合批次、每轮调用上限、缺少ID与连续无效批次；相关四文件43/43通过。另以故障注入触发畸形批次后调用真实服务，`protocol-live-20261023/protocol-report.json`为passed=true：两轮请求配对完整，独立dotnet10/10通过、0skip、0失败，生产源码及原测试hash不变。

## 真实复杂模块

材料为 `experiments/asset-upgrade-test-materials-20261014/java/target-project` 的完整 250 源文件骨架。实测只允许模型修改 `AttachmentIntakeHandler.java`，目标为 `intake`、`release` 和 `execute`；其余 concrete 模块仍为骨架，通过原有八个 typed ports 注入依赖。本轮不认证外部 provider 或完整工程。

参考为现有七仓中的五个生产源码片段，涉及 Commons FileUpload、Keycloak、Flowable 和 BullMQ。参考仅提供局部设计证据，目标的公开需求及 API 才是行为依据。报告保存需求、参考、响应、实现 hash，并核查其他原文件及 public API 未被改动。

模型为 `deepseek-flash`。新实验目录为 `$env:LOCALAPPDATA\translation-verifier-runtime\experiments\existing-java-public-contract`，`report.json` 中保留原始运行结果和证据路径。

| 项目 | 实测结果 |
| --- | --- |
| 骨架基线、翻译后 Maven package | 成功 |
| verifier 生成及最终重验 | 26 执行、26 通过、0 skip、0 executionErrors |
| verifier 函数组结果 | success，三个目标均 executed |
| 独立冻结隐藏测试 | 6 执行、3 通过、3 断言失败、0 executionErrors |
| 实验最终结果 | requirement-mismatch，passed=false，进程 exit 1 |

| 目标方法 | 行覆盖率 | 分支覆盖率 |
| --- | ---: | ---: |
| intake | 86.25% | 61.11% |
| release | 80.00% | 66.67% |
| execute | 100.00% | 100.00% |

覆盖率来自新鲜 JaCoCo/XML，保存在目标副本的 `.translation-verifier-tests/maven/target/site/jacoco/`，可查看 HTML 及 XML；Surefire 报告在同级 `target/surefire-reports/`。百分比没有最低通过阈值，不代表行为需求完整性。

### 隐藏验收差异

三个失败涉及 intake 扫描失败时的 accepted 返回值，以及重复 clean intake 是否已经发出一次事件。当前实现先隔离，在 release 中扫描并在 clean 后发布事件；生成测试也接受这一流程。公开附件需求要求 clean scan 之后才允许释放/审批，完整工程需求明确禁止在 intake 释放，但未明确 accepted 的语义或必须在 intake 同步扫描并发布审批事件。

因此这三个差异需要结合公开契约审查，不能自动解释成三个已证实漏检。它们仍足以证明本轮没有通过冻结验收，生成测试与实现共享同一解释可能产生盲点。没有向翻译或 verifier 模型提供隐藏测试、隐藏失败详情或针对隐藏答案的修复提示。

较早 `experiments/existing-java` 试跑保留原样：最后一轮 verifier 48/48，通过函数覆盖率，但隐藏仍3/6。该早期驱动额外加入了“intake 不发事件”的限制，属于实验需求污染；已从新运行移除，并使用新目录从纯骨架重跑，未回写旧结果。

## Windows 与全项目环境

已完成工具链、仓库依赖、独立推理 runtime 与六种测试 runner 的安装。全 workspace build 和扩展类型检查通过；Maven、Gradle、pytest、Jest、Vitest、dotnet 均经过真实目标执行、失败断言、未执行目标和 skip 验证；Go、Rust、GCC 编译 smoke 通过，C# 现有纯骨架外部副本 build 为 0 warning/0 error。

本轮修复 Windows batch wrapper/调用与进程树终止、Git 行尾基线、缺少文件 symlink 权限时的明确 skip，以及 LOCALAPPDATA 虚拟路径导致报告相对路径越界的问题。文件链接能力 skip 不代替 junction/硬链接安全回归。模型默认值只在 `-LiveModel` 进程中选择，避免持久环境污染普通测试。

最终驱动补充真正的 detached Git worktree、准备/写入中断恢复和旧实验历史保护，9 项行为回归通过。环境脚本将旧 DirectML 配置整体迁移到 CPU/q8，且拒绝 CPU 数据库与其他设备/精度混用；真实 PowerShell 迁移、独立配置保留和冲突拒绝回归 4/4 通过。

| 回归范围 | 结果 |
| --- | --- |
| verifier src、离线 Maven E2E、启动器初轮综合 | 196 pass、1 明确能力 skip |
| 启动器追加兼容回归 | 主目录 20/20，隔离目录 startup+rerank 23/23 |
| realpath 修复后的 pytest/Jest/Vitest | 3/3 |
| workflow / indexer / adaptation-http | 36 / 102 / 5 通过 |
| code-intelligence | 255 pass、2 skip |
| adaptation | 319 pass、3 skip；一条显式 20 秒两波 Git 用例超时，已确认 Windows 累计子进程耗时超出预算 |
| adaptation MCP / semantic MCP | 7 / 2 通过；另有真实 initialize/listTools 与仓库列表调用 |
| VS Code extension | 399/399 |
| 主目录最终同步回归 | 综合运行 216 pass、1 skip，唯一启动器环境隔离失败修复后该文件 20/20；合并结果 217 pass、1 skip |

主目录新驱动、环境回归及其依赖闭包的 strict TypeScript 检查通过；使用与仓库源码兼容的 Bundler resolution 和显式 Node 类型。交付文件与实施目录按规范化行尾核对一致，未将旧 multipart 原型作为交付材料。

SeekDB SQL、embedding/rerank 实际请求、适配服务和两个 MCP 均有真实调用证据。大仓持续投影发现 DirectML GPU `887A0005` 设备挂起，随后 embedding 返回无效向量/HTTP400，而 health 仍宣告 ready。正式 4021 已切为 CPU/q8；14 请求、152 文本的长输入及混批复验全部返回有效 384 维归一向量。新库为 `forexplore_asset_verifier_cpu_20261023`，全部向量重新计算，原数据库、日志和可校验的结构/建模成果保留。

剩余 adaptation 用例并非挂死：原 20 秒预算失败；仅在外部副本放宽预算后，34.808 秒通过全部断言。131 个顶层 Git 命令均退出 0，最慢 0.426 秒，总跨度 34.578 秒，说明 Windows 大量同步子进程累计超过硬预算。原测试及业务源码未修改，原套件仍记超时失败，副本通过不替代原套件验收。

## 索引、建模与检索质量

七参考已真实排队，顺序为 Commons FileUpload、APScheduler、BullMQ、nopCommerce、Keycloak、Flowable、Camel。原 DirectML 队列中前四参考完成源码索引，前三完成模块摘要；后三在 search-projection 失败，nopCommerce 摘要投影未完成。原队列已经结束，其日志和 `EXISTING-ASSETS-STATUS.md` 作为历史保留。

CPU 恢复队列已在后台持续推进。2026-10-23 04:48 UTC，两目标及 Commons FileUpload、APScheduler、BullMQ 的 CPU 索引完成；前三参考分别恢复 7/9/14 个模块、28/36/56 条摘要文档，`planCalls=0`，未重复调用 LLM。nopCommerce 正在重建向量，其余大仓顺序推进。最新进度、PID、日志及恢复方法见 runtime 的 `experiments/existing-assets/CPU-RECOVERY-STATUS.md`、`cpu-recovery-state.json`、`cpu-model-queue-state.json` 和真实 SQL 快照 `cpu-recovery-snapshot.json`。数据库完成状态以这些证据为准。

新库生产 SemanticQueryPort 已精确命中 `AbstractFileUpload.parseRequest` 两个重载，158ms，路径、kind 和 scope 断言通过。环境加载后的 `npm run services:up` 复用三个基础服务并退出 0；索引与模型队列使用隐藏独立进程，启动命令结束后仍继续推进。

08:56 UTC 补充真实C#检索：生产SemanticQueryPort命中 `Nop.Services.Orders.OrderProcessingService.PlaceOrderAsync`，返回现有 `src/Libraries/Nop.Services/Orders/OrderProcessingService.cs`；同一analysisRevision下摘要检索返回非空结果，含订单处理与交易模块，耗时9027ms。证据为runtime的 `experiments/existing-assets/cpu-nopcommerce-search-report.json`。该探针证明方法检索和摘要版本边界可用，不将摘要排序质量等同需求正确性。

发现 `SeekDbIndexStore` 的 `config.embedding` 分支在配置 hash 和持久 embedding cache key 中遗漏 variant，不能据旧 hash 证明 CPU/DML 精度差异。本轮使用独立 CPU 数据库、全部重算向量并明确记录 `cpu-q8`，没有复制旧向量或改写 hash；后续更换 variant 仍须隔离数据库。该业务源码问题未纳入 verifier 修改。

真实检索发现长指令 query 会让缓存过期模块排在重试模块之前，类级需求的跨仓相关性也不足；精确 `DiskFileItem.checkFileName` 查询可正确命中。这是已复现的业务质量限制，当前未修改检索业务逻辑。

## 完整双工程实测进展（2026-10-23）

完整驱动已覆盖 Java 250 文件/19 模块及 C# 27 文件/12 模块，复用现有材料，不再创建数据集。两者均已真实准备 detached worktree，C# 现有纯骨架、外部反射 API inspector 和 Host 测试环境均完成构建。C# 的 Program 装配作为明确新增实验需求进入模型输入和需求 hash，未把它冒充原四份业务契约。

双轴审查修复了默认接口遗漏、半回滚恢复、公开 verifier 失败不重翻译、共享测试目录使旧覆盖证据过期、最终 skip 放行、显式 record / C# 链式构造器遗漏、同文件跨类型属性污染及泛型重载/API 元数混淆。恢复与边界、Java/C# 目标清单及覆盖解析的定向回归 56/56 通过，strict TypeScript 通过；原 worktree 恢复 9 项回归通过。

完整 Java 首次真实验证揭示了服务本身的 JaCoCo 构造器解析缺陷：实际 24 条测试全通过、无执行错误，XML 中方法名为 `&lt;init&gt;`，Host 却按 `<init>` 原样比较，导致覆盖率 unavailable 并耗尽反馈预算。已仅在 JaCoCo 方法身份处规范化两个 JVM 特殊名称，保持 XML 实体展开关闭，并加入重载构造器回归。修复后直接通过真实 Host 重跑：46/46 测试、0 skip、0 executionErrors、8/8 目标有覆盖证据，两个显式 record 构造器均为行100%/分支100%。证据位于 runtime 的 `experiments/full-java-20261023-v3/constructor-revalidation.json`，修复前完整 checkpoint 另存保留。

当前完整 Java 与 C# 正在真实翻译/模块验证，分别保存于 runtime 的 `experiments/full-java-20261023-v3` 和 `experiments/full-csharp-20261023`。尚无完整工程通过结论，最终 Java35/C#24 隐藏验收须等全部模块结束后执行。早期 Java v2 因实验驱动将 record 合法重写的 final 修饰差异误判成 API 不兼容而停止，历史报告保留；v3 改为 JVM 方法身份比较后从原骨架重启。

13:53 本地服务复验：SeekDB healthy，embedding4021 CPU/q8 ready，rerank4022 ready，adaptation8788 status ok。两目标及 Commons FileUpload、APScheduler、BullMQ、nopCommerce 的 CPU 索引完成，四参考建模完成；Keycloak 已投影2101/3951文件，Flowable/Camel 继续顺序排队。队列存活和阶段进度不等同全部完成。

06:07 UTC 续跑核对：主目录精确同步后的四文件回归65/65及strict TypeScript通过。Java common前四个8目标组success；C# contracts的5目标组、domain前两个8目标组success，均零skip、零执行错误且有逐函数覆盖。C# domain第二组曾出现两个字典内容相同却按record引用相等比较的测试编写错误，verifier在同一会话中改为内容断言并由Host重跑139/139通过，未改生产实现。各组共享测试目录，测试数为各自观察快照，不能相加，也不能代替最终统一重验。

06:06 UTC 的真实SQL快照确认四参考处于ready并有模块摘要，Keycloak仍indexing，已有91008条搜索文档；两目标为ready。完整结果仍待后台队列和双工程全部阶段完成。

## 扩展真实后端能力验收

已区分规划 bootstrap 与目标工作区后端：8788 的 health 正常时，仍可关闭 module generation / workspace translation，不能单凭 health 宣称翻译能力可用。新增探针直接使用扩展实际 `BackendProcess` 和已构建 bundle，在独立动态端口启动目标后端，不重启8788或其他后台队列。

首轮 `experiments/backend-capabilities-20261023/backend-capabilities-report.json` 保留原样：真实 DeepSeek 工具调用成功，真实 Codex 修改原 C# 骨架的 TenantScope 四方法、编译通过，外部16项行为断言通过；该轮 acceptance 明确为 `compilation-only`。审查随后要求同时核验 capability、configuration 和 run 三处代理身份，防止继承 legacy 环境而误称 Codex 验收。

06:42 UTC 第二轮 `experiments/backend-behavior-20261023/backend-capabilities-report.json` 全部通过，进程退出0。后端动态端口54863，任务 `2a826ed4-b726-4f9c-a102-b748b623e71c`，模型 deepseek-flash；三处代理身份均为codex。真实任务经历 analyzing / translating / compiling / testing 后 completed，acceptance=`behavior-verified`。后端内部 dotnet 行为验收 exit0、16项断言通过、`filesUnchanged=true`，随后独立重跑也通过；原骨架中声明写入文件之外的文件 hash 保持不变。凭据仅经禁回显stdin进入进程，报告脱敏，无凭据文件。

探针实现的 strict TypeScript（ES2022 lib、Bundler resolution、Node types）及 scoped diff check 通过。默认 DOM lib 会触发扩展既有 local-fetch 类型冲突，本次未改动该无关源码。该有界探针证明真实生成、Codex翻译、编译和后端内部测试路径可用，完整逐函数覆盖率及双工程需求评估仍由各自完整驱动负责。

06:42 UTC CPU队列：Keycloak3951/3951文件、140180投影文档的索引已完成，建模正在逐项目推进；Flowable已进入投影，Camel继续排队。四个较小参考建模已完成。

06:49 UTC 更新：Keycloak建模队列已完成22个非空项目，planCalls=0，复用经校验的结构模型并完成CPU摘要投影；Flowable/Camel继续顺序处理。Java common/error和C# contracts/domain已验证，后续observability/policies仍在执行，不能据此宣称全部模块通过。

环境脚本另补 `-LiveModel` 同时选择聊天与Codex模型，防止实际扩展使用另一默认模型；显式配置保留，普通加载和持久环境不受该默认影响。真实PowerShell回归先复现Codex模型未设置的失败，修复后6/6通过，strict TypeScript通过。

07:07 UTC 增量发现：C# policies首个8函数组在真实测试中为86通过/1失败、0skip/0executionErrors，所有请求函数均有覆盖；模型反复写入和运行测试后耗尽20分钟Agent预算，driver保留`Agent run time budget exceeded.`及最后完整观察，继续后续组。失败断言为未配置扩展名限制时仍要求x.exe被拒绝；公开附件需求没有明确无条件禁用该扩展名，不能将它直接记为已证实生产缺陷，也不能算该组通过。完整trace保留，尚待后续公开反馈与最终统一复验。trace的写入参数有24000字符上限，不能仅依据截断前缀相同断言完整文件每次完全一致。

Java observability已验证；security首次翻译出现Set<?>到Set<String>的编译错误，第二轮利用公开编译反馈修复并已开始逐组通过。该错误属于生成源码，工具链正常运行且保留原轮次证据。主Windows扩展最新build:extension退出0，包含构造器解析修复；构建仍有既有CJS/import.meta警告。

07:16 UTC C#后续组已自主修正上述测试：未配置允许列表时不再强制拒绝x.exe，另保留`WithConfiguredAllowList`负例，验证配置限制后的拒绝及无状态行为；未修改生产代码。当前完整测试观察734/734、0skip/0executionErrors，第二个8目标组success。首组预算失败仍作为原始记录保留，整个policies模块仍须后续轮次/最终统一复验，不能把后续测试成功回写成首组当时已通过。

07:34 UTC 完整Codex两阶段探针通过：`experiments/backend-analyzer-20261023/backend-capabilities-report.json`，任务`490b9e49-46a4-432c-96fe-edc6540d14b2`，动态端口63628。生产CodeIntelligenceHost从Keycloak当前ready项目模型选择RealmAuth和AuthenticationManager两个现有文件，生成有manifest/hash的只读history view；真实Analyzer以read-only运行、exit0且计划accepted，Markdown计划9860字符；Translator以workspace-write运行、exit0，编译和内部16行为检查通过，acceptance=behavior-verified，独立16检查也exit0。原history view hash及原骨架保护文件保持不变，未发生direct fallback。环境脚本默认选用的deepseek-flash同时支持聊天工具调用与这条真实Codex链路。

C#policies第1轮第4/5组又分别达到上下文限制（1521508 / 1527065字符超过1500000），最终测试观察分别95/96和899/900，均0skip、0executionErrors，不能归为runner环境故障或需求已通过；第2/3组已success。原驱动继续第2轮公开反馈修复。Java前5模块common/error/observability/security/telemetry已verified，audit继续。

另起隔离公开功能组Pro复验，原Flash实验保持运行、历史不改。复制当前生产源码和公开生成测试到新detached worktree，逐文件校验hash，重新生成指向副本的测试project，未复制隐藏测试。证据目录`experiments/csharp-public-pro-replay-20261023`；这不是完整C#项目验收，也不是严格控制所有上下文差异的模型性能比较。服务商模型列表返回deepseek-flash、deepseek-v4-pro；库默认deepseek-v4-flash虽未列出，也已通过真实最小调用，未据列表缺少别名擅改默认值。

Flowable的2753文件CPU索引及3非空项目建模已完成；Camel7203文件正在CPU投影，七参考中前六已完成建模。仍以运行目录的JSON状态和SQL快照为准。

## 待完成验收

- 后台大仓 CPU 索引/摘要恢复的最终验收；当前服务与已完成仓已复验，不能把队列运行等同全部完成。
- adaptation 原套件的 20 秒 Git 测试仍未通过；超时原因已有证据，未扩大范围修改预算。
- 两套目标工程的全部模块翻译与独立验收。
- 公开附件契约与冻结隐藏断言差异的解释，以及更广泛模块的 verifier 判断能力评估。

原工作区的无关未提交文件保持原样。实验失败报告被完整保留，没有通过修改隐藏测试、降低行为断言或清理原始证据来制造通过。

### 08:06 UTC 增量结果与续跑

- 独立 Pro 公开功能组复验已结束，`experiments/csharp-public-pro-replay-20261023/public-replay-report.json` 为 `passed:true`：统一 Host 重验936/936、0skip、0executionErrors、无timeout，8/8目标有执行覆盖。8个目标行覆盖率均100%，有分支的方法除 `OrderValidationPolicy.IsValid` 为75%外均100%，构造器无分支为null。源码hash保护通过。它只证明该公开功能组通过，不是完整Pro工程或严格模型A/B比较。
- 探针预检在仓库缺失或存储读取异常时遗留runtime连接；两例先红复现，改为探针统一等待原runtime关闭，Host使用非关闭副本。回归2/2和strict TypeScript通过，Standards复核确认P2关闭。
- C#原Flash实验的policies第2轮首组仍因1,513,726字符超过1,500,000预算失败。trace显示一次测试反馈含936个case约186k字符，另有74次源码/测试读取约1.3m字符，其中后半段循环读取相同测试文件。两种原因分开记录，不将其归为runner错误或已证实需求失败。该组最后观察936/936、0skip、0executionErrors，预算失败原记录仍保留。
- 对测试工具反馈增加模型可见case上限16，失败和skip优先，单case诊断有界且标明省略数量。完整artifact/trace、汇总计数、逐函数覆盖和最终Host复验不变。新增1001条测试且尾部失败的两个public verifier回归先红复现40k上下文预算失败，修复后生命周期17/17和strict TypeScript通过。该修复不宣称消除模型重复读文件的问题。
- 原C# Flash进程已在policies第2轮停止，保留全部原目录及checkpoint，不改原失败判定。新的`experiments/full-csharp-pro-20261023`从原纯骨架重新开始完整12模块运行，使用真实`deepseek-v4-pro`及新反馈限制；它与已结束的单公开组复验目录相互独立。
- Java原完整实验继续，前5模块已verified，audit第2轮4组均有成功测试及覆盖观察，最终组结论以checkpoint为准。Camel投影已到1659/7203文件，前六参考建模完成；两工程最终冻结验收尚未全部运行，不能宣称完整工程通过。
