# Translation Verifier 接入说明

本文面向模块翻译流程的上游维护者，说明如何接入现有的 translation-verifier。

## 接入边界

Verifier 负责测试 Agent、受限测试工具和 Host 观察结果。上游翻译流程负责识别模块、生成 source/target 函数映射、维护历史代码副本，并调用 Verifier。

Verifier 不负责重新推断模块映射，也不负责把一个源函数猜测绑定到另一个目标函数。

## 两个入口

函数级验证入口：`services/translation-verifier/src/verify.ts`，调用 `createVerifier(host)`，策略名为 `single-agent`。

模块级（函数组）验证入口：`services/translation-verifier/src/function-group-verify.ts`，调用 `createFunctionGroupVerifier(host)`，策略名为 `single-agent-function-group`。

模块级输入的核心结构是：

```ts
{
  schemaVersion: "3.1",
  sourceLanguage: "C#",
  targetLanguage: "Java",
  sourceProjectPath: "/path/to/source-project",
  targetProjectPath: "/path/to/target-project",
  requirement: "Preserve the module behavior.",
  functions: [{
    source: { path: "src/OrderService.cs", name: "calculatePrice" },
    target: { path: "src/OrderService.java", name: "calculatePrice" },
  }],
  unmatchedFunctions: [
    { path: "src/OrderService.java", name: "calculateDiscount" },
  ],
}
```

`functions` 只放已确认的 source/target 映射。`unmatchedFunctions` 记录没有可靠历史参考函数的目标函数，不能被伪装成已验证函数。

函数级输入继续使用 `VerificationInput` 的单个 `subject`：

```ts
subject: {
  sourceFunction: { path, name, signature? },
  targetFunction: { path, name, signature? },
  requirement,
}
```

## 历史副本生命周期

历史模块副本是 source 侧项目。上游应当：

1. 创建历史模块视图或副本；
2. 启动翻译 Agent；
3. 翻译完成后保留该副本；
4. 将历史视图的 `source` 子目录路径传给 Verifier 的 `sourceProjectPath`（即 `historyView.root/source`，不是外层 view 根目录）；
5. Verifier 完成后再清理副本。

不要在翻译 Agent 结束时立即删除副本，也不要再复制一层临时目录。Verifier 只读取上游提供的 `source` 子目录；历史视图根目录应保留到 Verifier 完成后再清理。

`targetProjectPath` 是当前目标工作区。测试 Agent 在授权测试根目录写入测试，Host 选择测试命令和覆盖率收集方式。

## Windows 适配边界

Verifier 可以处理必要的 Windows 差异：路径分隔符、`.cmd`/`.bat` 启动器、`dotnet`/`npm`/Maven/Gradle wrapper 的 Windows 可执行文件名，以及临时目录和子进程工作目录。适配应位于 Host、测试环境解析和测试执行层，不改变函数映射语义。

## 上游需要做的修改

1. 为模块构造可信的函数映射列表；
2. 将没有参考函数的目标函数填入 `unmatchedFunctions`；
3. 保留 source 侧历史模块副本直到 Verifier 完成；
4. 调用 `createFunctionGroupVerifier`；
5. 将返回结果写入模块报告。

不需要传递完整的 `translationRun`、plan、compilations 或 changes。翻译证据属于翻译流程，函数组测试入口只依赖项目路径、需求和映射。

## Host 结果和终止规则

测试 Agent 不能伪造执行结果或覆盖率。`run_function_group_tests` 只接收测试文件路径，Host 根据目标项目测试框架选择命令并读取覆盖率报告。

每个映射函数的结果包括：

```ts
{
  source,
  target,
  status: "passed" | "unverified",
  executed,
  lineCoverage,
  branchCoverage,
  reason,
}
```

函数组 Host 结果的 `reason` 包括 `verified`、`not-executed`、`coverage-unavailable`、`test-failed`、`test-environment-failure`、`mapping-invalid`、`agent-timeout` 和 `model-failure`。当前这些原因由函数组测试运行结果提供；函数级入口仍使用原有结果结构。

测试 Agent 以普通最终消息返回 JSON 结论（`no-bug`、`bug-found` 或 `uncertain`），不再调用终态工具。Host 在每次自然结束后重新运行完整专用测试目录并逐个复核请求函数：`no-bug` 要求完整套件通过且全部目标有执行证据；`bug-found` 要求存在有效失败断言且被点名目标有执行证据，其余目标保留为 `unverified`；`uncertain` 要求套件通过、全部目标已执行且存在明确需求歧义。不能把未执行、覆盖率不可用或测试失败的函数自行改报为成功。

## 修改约束

接入时尽量只修改上游 Verifier 调用、source 副本生命周期和必要的 Windows 兼容代码。不要引入无关的检索、计划轮询、数据库身份、候选排序或额外防御逻辑；只有发现明确 bug 时才扩大范围，并说明原因。
