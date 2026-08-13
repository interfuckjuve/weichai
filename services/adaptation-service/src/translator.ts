/**
 * Java ↔ C# 双向翻译器
 * 调用 DeepSeek API（兼容 OpenAI 格式）进行 Java 和 C# 之间的方法翻译。
 */
import { adaptationModelConfig } from "./model-config";

export interface TranslateRequest {
  javaSource: string;
  csharpSignature: string;
  requirement: string;
  matchType: "exact" | "partial" | "different";
}

export interface CSharpToJavaRequest {
  csharpSource: string;
  javaSignature: string;
  requirement: string;
  matchType: "exact" | "partial" | "different";
}

const MATCH_NOTES: Record<string, string> = {
  exact: "功能完全对应，请保持逻辑1:1翻译。",
  partial: "功能部分重叠，只翻译与需求描述相关的部分，不需要的功能可以省略。",
  different: "功能差异较大，以需求描述为准，源码仅作参考。",
};

const JAVA_TO_CSHARP_RULES = [
  "1. Java double → C# decimal",
  "2. Java List<T> → C# List<T>",
  "3. Java Map<K,V> → C# Dictionary<K,V>",
  "4. Java boolean → C# bool",
  "5. Java String → C# string",
  "6. Java getter/setter → C# 属性 (get; set;)",
  "7. Java checked exception → C# 去掉 throws 声明, throw 直接保留",
  "8. IllegalArgumentException → ArgumentException",
  "9. IllegalStateException → InvalidOperationException",
  "10. NullPointerException → ArgumentNullException",
  "11. Java static method → C# 如果签名没有 static 关键字就改成实例方法",
  "12. Stream API → LINQ (Where / Select / ToDictionary / OrderByDescending / Take)",
  "13. String.format() → string.Format() 或 $\"\" 字符串插值",
  "14. Map.merge() → Dictionary.TryGetValue + 赋值",
].join("\n");

const CSHARP_TO_JAVA_RULES = [
  "1. C# decimal → Java double",
  "2. C# List<T> → Java List<T>",
  "3. C# Dictionary<K,V> → Java Map<K,V>",
  "4. C# bool → Java boolean",
  "5. C# string → Java String",
  "6. C# 属性 (get; set;) → Java getter/setter 方法",
  "7. C# 无 throws 声明 → Java 方法签名添加 throws 声明（如需要）",
  "8. ArgumentException → IllegalArgumentException",
  "9. InvalidOperationException → IllegalStateException",
  "10. ArgumentNullException → NullPointerException",
  "11. C# static method → Java 保留 static",
  "12. LINQ → Stream API (Where→filter, Select→map, ToDictionary→collect(Collectors.toMap), OrderByDescending→sorted(Comparator.reverseOrder()), Take→limit)",
  "13. string.Format() / $\"\" 字符串插值 → String.format()",
  "14. Dictionary.TryGetValue + 赋值 → Map.merge()",
].join("\n");

export async function translateJavaToCSharp(
  request: TranslateRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildJavaToCSharpPrompt(request);
  return callLLM(prompt, apiKey, signal);
}

export async function translateCSharpToJava(
  request: CSharpToJavaRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildCSharpToJavaPrompt(request);
  return callLLM(prompt, apiKey, signal);
}

export async function fixCompileErrors(
  badCode: string,
  errors: string[],
  signature: string,
  requirement: string,
  apiKey: string,
  targetLanguage: "C#" | "Java" = "C#",
  signal?: AbortSignal,
): Promise<string> {
  const langLabel = targetLanguage === "Java" ? "java" : "csharp";
  const prompt = `以下 ${targetLanguage} 代码编译失败，请修复所有编译错误后重新输出完整代码。

【编译错误】
${errors.map((e) => `- ${e}`).join("\n")}

【当前代码】
\`\`\`${langLabel}
${badCode}
\`\`\`

【目标签名要求】
${signature}

【功能需求】
${requirement}

要求: 只输出修复后的 ${targetLanguage} 方法代码(含签名), 不要 markdown 标记, 不要解释。`;

  return callLLM(prompt, apiKey, signal);
}

// ---- helpers ----

function buildJavaToCSharpPrompt(req: TranslateRequest): string {
  return `你是 Java→C# 代码翻译专家。请把以下 Java 方法翻译成 C#。

【匹配类型】${MATCH_NOTES[req.matchType] ?? ""}

【Java 源码】
\`\`\`java
${req.javaSource}
\`\`\`

【目标 C# 方法签名】
\`\`\`csharp
${req.csharpSignature}
\`\`\`

【需求描述】
${req.requirement}

【翻译规则】
${JAVA_TO_CSHARP_RULES}

15. 不要写 using 语句 (放到编译 wrapper 里统一处理)
16. 只输出方法代码（包含签名），不要 class 包裹，不要文件头，不要解释
17. 不要 markdown 代码块标记 (\`\`\`)`;
}

function buildCSharpToJavaPrompt(req: CSharpToJavaRequest): string {
  return `你是 C#→Java 代码翻译专家。请把以下 C# 方法翻译成 Java。

【匹配类型】${MATCH_NOTES[req.matchType] ?? ""}

【C# 源码】
\`\`\`csharp
${req.csharpSource}
\`\`\`

【目标 Java 方法签名】
\`\`\`java
${req.javaSignature}
\`\`\`

【需求描述】
${req.requirement}

【翻译规则】
${CSHARP_TO_JAVA_RULES}

15. 不要写 import 语句 (放到编译 wrapper 里统一处理)
16. 只输出方法代码（包含签名），不要 class 包裹，不要文件头，不要解释
17. 不要 markdown 代码块标记 (\`\`\`)`;
}

async function callLLM(
  prompt: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${adaptationModelConfig.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: adaptationModelConfig.model,
      messages: [{ role: "user", content: prompt }],
      thinking: { type: "disabled" },
      temperature: 0.1,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices[0]?.message.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("DeepSeek API returned an empty completion.");
  }
  return stripCodeFence(content.trim());
}

/** 剥掉 LLM 偶尔无视 prompt 仍输出的 markdown 代码块标记（```csharp / ```java / ```） */
function stripCodeFence(code: string): string {
  return code
    .replace(/^```(?:csharp|cs|java)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}
