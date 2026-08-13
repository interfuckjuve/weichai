/**
 * CodeAdaptationPort 实现 — 核心编排
 *
 * 流程: LLM翻译 → 独立编译 → 自动修复(最多3轮) → 集成编译 → 生成结果
 * 支持 Java ↔ C# 双向翻译。
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AdaptationRequest,
  AdaptationResult,
  FilePatch,
  InterfaceMapping,
} from "@forexplore/contracts";
import type { CodeAdaptationPort } from "@forexplore/workflow-core";
import {
  translateJavaToCSharp,
  translateCSharpToJava,
  fixCompileErrors,
} from "./translator";
import {
  compileIntegrated,
  compileJavaIntegrated,
  compileJavaStandalone,
  compileStandalone,
  isCompilerUnavailable,
} from "./compiler";

const MAX_RETRIES = 3;

export interface AdaptationAdapterOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** C# skeleton 项目根目录（可选，有则启用集成编译） */
  skeletonProjectPath?: string;
  /** 目标项目根目录（可选，有则生成定点 context patch 而非全量替换） */
  projectRoot?: string;
}

export class AdaptationAdapter implements CodeAdaptationPort {
  #apiKey: string;
  #skeletonProjectPath?: string;
  #projectRoot?: string;

  constructor(options: AdaptationAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#skeletonProjectPath = options.skeletonProjectPath;
    this.#projectRoot = options.projectRoot;
  }

  async adapt(
    request: AdaptationRequest,
    signal?: AbortSignal,
  ): Promise<AdaptationResult> {
    assertSupportedTranslation(request);
    const matchType = inferMatchType(request);
    const direction = getDirection(request);
    const targetLang = request.target.language as "C#" | "Java";

    // ===== Step 1: LLM 翻译 =====
    let generatedCode = await translateCode(request, matchType, direction, this.#apiKey, signal);

    // ===== Step 2: 编译 + 自动修复 =====
    let standaloneResult = compileCode(generatedCode, request.target.name, direction);
    let integratedResult = compileCodeIntegrated(
      generatedCode,
      this.#skeletonProjectPath,
      request.target.path,
      direction,
    );
    let retries = 0;
    let repairResult = integratedResult ?? standaloneResult;

    while (
      !repairResult.success &&
      !isCompilerUnavailable(repairResult) &&
      retries < MAX_RETRIES
    ) {
      generatedCode = await fixCompileErrors(
        generatedCode,
        repairResult.errors,
        request.target.signature,
        request.requirement,
        this.#apiKey,
        targetLang,
        signal,
      );
      standaloneResult = compileCode(generatedCode, request.target.name, direction);
      integratedResult = compileCodeIntegrated(
        generatedCode,
        this.#skeletonProjectPath,
        request.target.path,
        direction,
      );
      repairResult = integratedResult ?? standaloneResult;
      retries++;
    }

    // ===== Step 3: 生成映射 =====
    const mappings = buildMappings(request.candidate.preview, generatedCode, direction);

    // ===== Step 4: 生成 FilePatch =====
    const originalContent = readOriginalIfAvailable(
      this.#projectRoot,
      this.#skeletonProjectPath,
      request.target.path,
    );
    const patch = buildFilePatch(
      request.target.path,
      generatedCode,
      originalContent,
      request.target.line,
    );

    return {
      strategy: request.strategy,
      targetLanguage: targetLang,
      generatedCode,
      interfaceMappings: mappings,
      validation: [
        {
          label: "独立编译",
          status: standaloneResult.success ? "pass" : "warn",
          detail: standaloneResult.success
            ? "编译通过"
            : standaloneResult.errors.slice(0, 3).join("; "),
        },
        {
          label: "集成编译",
          status: integratedResult?.success ? "pass" : "warn",
          detail: integratedResult
            ? integratedResult.success
              ? "编译通过"
              : integratedResult.errors.slice(0, 3).join("; ")
            : "未执行（需 skeleton 项目路径）",
        },
      ],
      files: [patch],
    };
  }
}

// ---- helpers ----

type TranslationDirection = "java-to-csharp" | "csharp-to-java";

function getDirection(request: AdaptationRequest): TranslationDirection {
  const src = request.candidate.language;
  const tgt = request.target.language;
  if (src === "Java" && tgt === "C#") return "java-to-csharp";
  if (src === "C#" && tgt === "Java") return "csharp-to-java";
  // assertSupportedTranslation 已经保证了方向合法，这里只是兜底
  throw new Error(`Unsupported direction: ${src} -> ${tgt}`);
}

async function translateCode(
  request: AdaptationRequest,
  matchType: "exact" | "partial" | "different",
  direction: TranslationDirection,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  if (direction === "java-to-csharp") {
    return translateJavaToCSharp(
      {
        javaSource: request.candidate.preview,
        csharpSignature: request.target.signature,
        requirement: request.requirement,
        matchType,
      },
      apiKey,
      signal,
    );
  }
  return translateCSharpToJava(
    {
      csharpSource: request.candidate.preview,
      javaSignature: request.target.signature,
      requirement: request.requirement,
      matchType,
    },
    apiKey,
    signal,
  );
}

function compileCode(
  generatedCode: string,
  name: string,
  direction: TranslationDirection,
) {
  return direction === "java-to-csharp"
    ? compileStandalone(generatedCode, name)
    : compileJavaStandalone(generatedCode, name);
}

function compileCodeIntegrated(
  generatedCode: string,
  skeletonProjectPath: string | undefined,
  targetPath: string,
  direction: TranslationDirection,
) {
  if (!skeletonProjectPath) return null;
  return direction === "java-to-csharp"
    ? compileIntegrated(generatedCode, skeletonProjectPath, targetPath)
    : compileJavaIntegrated(generatedCode, skeletonProjectPath, targetPath);
}

function assertSupportedTranslation(request: AdaptationRequest): void {
  if (request.strategy !== "translate") {
    throw new Error(
      `AdaptationAdapter only supports the "translate" strategy; received "${request.strategy}".`,
    );
  }
  const supportedPairs = [
    ["Java", "C#"],
    ["C#", "Java"],
  ] as const;
  const isSupported = supportedPairs.some(
    ([src, tgt]) =>
      request.candidate.language === src && request.target.language === tgt,
  );
  if (!isSupported) {
    throw new Error(
      `Unsupported adaptation language pair: ${request.candidate.language} -> ${request.target.language}. Supported: Java <-> C#.`,
    );
  }
}

function inferMatchType(request: AdaptationRequest): "exact" | "partial" | "different" {
  const notes = request.decisionNotes.toLowerCase();
  if (notes.includes("partial") || notes.includes("部分")) return "partial";
  if (notes.includes("different") || notes.includes("不同")) return "different";
  return "exact";
}

/** 从源码和目标代码中推断类型映射 */
function buildMappings(
  sourceCode: string,
  _targetCode: string,
  direction: TranslationDirection,
): InterfaceMapping[] {
  const rules: Array<[string, string, InterfaceMapping["action"]]> =
    direction === "java-to-csharp"
      ? [
          ["double", "decimal", "convert"],
          ["List<", "List<", "preserve"],
          ["boolean", "bool", "convert"],
          ["String", "string", "convert"],
          ["Map<", "Dictionary<", "convert"],
          ["public class", "public class", "preserve"],
        ]
      : [
          ["decimal", "double", "convert"],
          ["List<", "List<", "preserve"],
          ["bool", "boolean", "convert"],
          ["string", "String", "convert"],
          ["Dictionary<", "Map<", "convert"],
          ["public class", "public class", "preserve"],
        ];

  return rules
    .filter(([source]) => sourceCode.includes(source))
    .map(([source, target, action]) => ({
      source,
      target,
      action,
      note: typeMapNote(action, source, target),
    }));
}

function typeMapNote(
  action: InterfaceMapping["action"],
  source: string,
  target: string,
): string {
  switch (action) {
    case "convert":
      return `${source} -> ${target} 类型转换`;
    case "preserve":
      return `${source} 保持一致`;
    default:
      return `${source} -> ${target}`;
  }
}

function readOriginalIfAvailable(
  projectRoot: string | undefined,
  skeletonProjectPath: string | undefined,
  filePath: string,
): string | null {
  const root = projectRoot ?? skeletonProjectPath;
  if (!root) return null;
  const fullPath = join(root, filePath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : null;
}

function buildFilePatch(
  filePath: string,
  newCode: string,
  originalContent: string | null,
  targetLine?: number,
): FilePatch {
  const newLines = newCode.split("\n");

  // 无法做定点 patch 时回退到全量替换
  if (!originalContent || targetLine == null) {
    return {
      path: filePath,
      status: "modified",
      additions: newLines.length,
      deletions: 0,
      hunks: [
        {
          header: `@@ -0,0 +1,${newLines.length} @@`,
          lines: newLines.map((content) => ({
            type: "add" as const,
            content,
          })),
        },
      ],
    };
  }

  // 定点 patch：用括号匹配找到原方法体范围
  const originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  const startIdx = Math.max(0, targetLine - 1);

  // 找到方法体的闭合大括号
  const endIdx = findMethodEnd(originalLines, startIdx);
  const removedLines = originalLines.slice(startIdx, endIdx + 1);

  // 用原方法签名作为 context 行来定位
  const contextBefore = startIdx > 0 ? originalLines[startIdx - 1] : null;
  const contextAfter =
    endIdx < originalLines.length - 1 ? originalLines[endIdx + 1] : null;

  const hunkLines: FilePatch["hunks"][number]["lines"] = [];

  // 前置 context：方法体前一行（通常是类声明或空行）
  if (contextBefore) {
    hunkLines.push({ type: "context", content: contextBefore });
  }

  // 原方法所有行标记为 remove
  for (const line of removedLines) {
    hunkLines.push({ type: "remove", content: line });
  }

  // 新方法所有行标记为 add
  for (const line of newLines) {
    hunkLines.push({ type: "add", content: line });
  }

  // 后置 context：方法体后一行
  if (contextAfter) {
    hunkLines.push({ type: "context", content: contextAfter });
  }

  return {
    path: filePath,
    status: "modified",
    additions: newLines.length,
    deletions: removedLines.length,
    hunks: [{ header: `@@ -${startIdx + 1},${removedLines.length} +${startIdx + 1},${newLines.length} @@`, lines: hunkLines }],
  };
}

/** 从 startIdx 开始，用括号深度匹配找到方法/代码块的结束行（0-based 索引） */
function findMethodEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth === 0) {
      return i;
    }
  }
  // 未找到匹配括号时回退到文件末尾
  return lines.length - 1;
}

/** @internal 暴露给测试 */
export { buildFilePatch as _buildFilePatch };
