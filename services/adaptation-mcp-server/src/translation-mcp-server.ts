import {
  AdaptationAdapter,
  AnalyzerAgent,
  collectTargetContext,
  compileTargetIntegrated,
  compileTargetStandalone,
  ArchitectAgent,
  FileStaticAnalysisSnapshotStore,
  projectTargetContext,
  repairTranslation,
  TranslationVerifierAdapter,
  translateWithAnalysis,
  type AdaptationAnalyzer,
  type AdaptationVerifier,
  type AdaptationValidator,
  type StaticAnalysisSnapshotStore,
  type RepositoryArchitecturePort,
  type TranslatorModelOptions,
} from "@forexplore/adaptation-service";
import {
  moduleMigrationSchemaVersion,
  validateRerankContract,
  type ModuleTarget,
  type RepositoryArchitectureRequest,
} from "@forexplore/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

const MAX_CODE_CHARS = 160_000;
const MAX_REQUIREMENT_CHARS = 8_000;
const MAX_NOTES_CHARS = 8_000;

const languageSchema = z.enum([
  "TypeScript",
  "Python",
  "Java",
  "C#",
  "Rust",
  "Go",
]);

const targetSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(512),
  kind: z.enum(["class", "function"]),
  path: z.string().trim().min(1).max(4_096),
  language: languageSchema,
  signature: z.string().trim().min(1).max(16_000),
  documentation: z.string().max(32_000).optional(),
  line: z.number().int().positive().optional(),
  implementationStatus: z.enum(["implemented", "unimplemented"]).optional(),
});

const candidateSchema = z.object({
  id: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(1_024),
  repository: z.string().trim().min(1).max(4_096),
  license: z.string().trim().min(1).max(512),
  language: languageSchema,
  kind: z.enum(["class", "function"]),
  path: z.string().trim().min(1).max(4_096),
  signature: z.string().trim().min(1).max(16_000),
  summary: z.string().max(16_000),
  score: z.object({
    overall: z.number(),
    semantic: z.number(),
    symbol: z.number(),
    contract: z.number(),
    rerank: z.number().optional(),
  }),
  preview: z.string().min(1).max(MAX_CODE_CHARS),
  dependencies: z.array(z.string().max(1_024)).max(1_000),
  compatibility: z.array(z.string().max(4_096)).max(1_000),
  risks: z.array(z.string().max(4_096)).max(1_000),
  rerankReason: z.string().max(8_000).optional(),
});

const analysisReportSchema = z.object({
  schemaVersion: z.literal("1.0"),
  applicability: z.object({
    level: z.enum(["direct", "adapt", "reference", "reject"]),
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string().min(1).max(8_000)).min(1),
  }),
  behaviorMapping: z.array(z.object({
    requirement: z.string().min(1).max(8_000),
    status: z.enum(["covered", "partial", "missing", "conflict"]),
    candidateEvidence: z.array(z.string().max(8_000)),
    targetAction: z.string().min(1).max(8_000),
  })),
  contractMapping: z.array(z.object({
    source: z.string().min(1).max(8_000),
    target: z.string().min(1).max(8_000),
    action: z.enum(["preserve", "rename", "convert", "inject", "replace", "adapt", "map", "delegate", "wrap"]),
    note: z.string().min(1).max(8_000),
  })),
  dependencyPlan: z.array(z.object({
    sourceDependency: z.string().min(1).max(8_000),
    targetDependency: z.string().min(1).max(8_000).optional(),
    action: z.enum(["reuse-existing", "adapt", "inline", "unresolved"]),
  })),
  implementationPlan: z.array(z.string().min(1).max(8_000)).min(1),
  risks: z.array(z.string().max(8_000)),
  assumptions: z.array(z.string().max(8_000)),
  unresolved: z.array(z.string().max(8_000)),
});

const translationResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  generatedCode: z.string().min(1).max(MAX_CODE_CHARS),
  interfaceMappings: z.array(z.object({
    source: z.string().min(1).max(8_000),
    target: z.string().min(1).max(8_000),
    action: z.enum(["preserve", "rename", "convert", "inject", "replace", "adapt", "map", "delegate", "wrap"]),
    note: z.string().min(1).max(8_000),
  })).optional().default([]),
  completedSteps: z.array(z.string().min(1).max(8_000)),
  unresolved: z.array(z.string().max(8_000)),
});

const validationFeedbackSchema = z.object({
  status: z.enum(["pass", "fail"]),
  issues: z.array(z.object({
    category: z.enum(["syntax", "contract", "dependency", "behavior"]),
    file: z.string().max(4_096).optional(),
    line: z.number().int().positive().optional(),
    message: z.string().min(1).max(16_000),
    evidence: z.string().max(16_000).optional(),
  })).max(1_000),
});

const rerankResultSchema = z.object({
  id: z.string().trim().min(1).max(4_096),
  score: z.number().finite(),
  reason: z.string().max(8_000).optional(),
});

export interface AdaptationMcpServerOptions {
  apiKey: string;
  projectRoot: string;
  /** Server-owned analysis artifact directory for the read-only module planner. */
  analysisRoot?: string;
  /** Optional injected architecture port and snapshot store for tests/hosts. */
  architecturePort?: RepositoryArchitecturePort;
  staticAnalysisSnapshots?: StaticAnalysisSnapshotStore;
  skeletonProjectPath?: string;
  analyzer?: AdaptationAnalyzer;
  translatorRequest?: typeof globalThis.fetch;
  validator?: AdaptationValidator;
  verifier?: AdaptationVerifier;
}

/**
 * Creates a local MCP server for translation analysis and generation. File
 * write-back stays outside MCP so the VS Code host retains its approval gate.
 */
export function createAdaptationMcpServer(
  options: AdaptationMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: "forexplore-adaptation",
    version: "0.1.0",
  });
  const analyzer = options.analyzer ?? new AnalyzerAgent({ apiKey: options.apiKey });
  const translatorOptions: TranslatorModelOptions = options.translatorRequest
    ? { apiKey: options.apiKey, request: options.translatorRequest }
    : { apiKey: options.apiKey };
  const adapter = new AdaptationAdapter({
    apiKey: options.apiKey,
    projectRoot: options.projectRoot,
    skeletonProjectPath: options.skeletonProjectPath,
    analyzer,
    translatorRequest: options.translatorRequest,
    validator: options.validator,
    // Keep even direct programmatic MCP construction fail-closed.  Callers
    // that own a real isolated runner may inject its verifier explicitly.
    verifier: options.verifier ?? new TranslationVerifierAdapter({ apiKey: options.apiKey }),
  });

  // Module planning is read-only and is exposed only when the host has both
  // an architecture port and a server-owned immutable snapshot store. The
  // MCP client can therefore select a snapshot but cannot upload source,
  // paths, or a browser-created analysis graph.
  const architecturePort = options.architecturePort ?? (
    options.analysisRoot
      ? new ArchitectAgent({ apiKey: options.apiKey })
      : undefined
  );
  const staticAnalysisSnapshots = options.staticAnalysisSnapshots ?? (
    options.analysisRoot
      ? new FileStaticAnalysisSnapshotStore({ analysisRoot: options.analysisRoot })
      : undefined
  );

  const collect = (target: ModuleTarget, signal: AbortSignal) => collectTargetContext({
    projectRoot: options.projectRoot,
    target,
    signal,
  });

  server.registerTool("forexplore_collect_target_context", {
    title: "Collect Target Context",
    description: "Read a selected target module and its bounded local dependencies from the configured project.",
    inputSchema: { target: targetSchema },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ target }, extra) => runTool(() => collect(target, extra.signal)));

  server.registerTool("forexplore_analyze_translation", {
    title: "Analyze Translation Candidate",
    description: "Compare a retrieved candidate with the selected target contract and return AnalysisReport v1.",
    inputSchema: {
      target: targetSchema,
      candidate: candidateSchema,
      requirement: z.string().trim().min(1).max(MAX_REQUIREMENT_CHARS),
      decisionNotes: z.string().max(MAX_NOTES_CHARS).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ target, candidate, requirement, decisionNotes }, extra) => runTool(async () => {
    const targetContext = collect(target, extra.signal);
    return analyzer.analyze({
      schemaVersion: "1.0",
      targetContext,
      candidate,
      requirement,
      immutableConstraints: targetContext.constraints,
      decisionNotes,
    }, extra.signal);
  }));

  server.registerTool("forexplore_validate_rerank", {
    title: "Validate Rerank Contract",
    description: "Validate that a reranking result scores every supplied candidate ID exactly once, without unknown, missing, or duplicate IDs.",
    inputSchema: {
      candidateIds: z.array(z.string().trim().min(1).max(4_096)).min(1).max(250),
      results: z.array(rerankResultSchema).max(250),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ candidateIds, results }) => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify(validateRerankContract(candidateIds, results), null, 2),
    }],
  }));

  if (architecturePort && staticAnalysisSnapshots) {
    server.registerTool("forexplore_propose_module_plan", {
      title: "Propose Module Migration Plan",
      description: "Use a server-owned static-analysis snapshot to propose functional modules. The result is an untrusted read-only proposal; it does not schedule, approve, or write files.",
      inputSchema: z.object({
        snapshotId: z.string().trim().min(1).max(256),
        objective: z.string().trim().min(1).max(16_000),
        immutableConstraints: z.array(z.string().trim().min(1).max(2_000)).max(64).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ snapshotId, objective, immutableConstraints }, extra) => runTool(async () => {
      const analysis = await staticAnalysisSnapshots.getSnapshot(snapshotId, extra.signal);
      if (!analysis) {
        throw new Error("Static analysis snapshot was not found.");
      }
      if (analysis.snapshotId !== snapshotId) {
        throw new Error("Static analysis snapshot store returned a mismatched snapshot ID.");
      }
      const request: RepositoryArchitectureRequest = {
        schemaVersion: moduleMigrationSchemaVersion,
        analysis,
        objective,
        ...(immutableConstraints === undefined ? {} : { immutableConstraints }),
      };
      return architecturePort.proposeModulePlan(request, extra.signal);
    }));
  }

  server.registerTool("forexplore_generate_translation", {
    title: "Generate Translation",
    description: "Generate one target method or complete target class from source code and a validated AnalysisReport; it does not write files.",
    inputSchema: {
      target: targetSchema,
      candidateSource: z.string().min(1).max(MAX_CODE_CHARS),
      requirement: z.string().trim().min(1).max(MAX_REQUIREMENT_CHARS),
      analysisReport: analysisReportSchema,
    },
    annotations: { destructiveHint: false },
  }, async ({ target, candidateSource, requirement, analysisReport }, extra) => runTool(() =>
    translateWithAnalysis({
      candidateSource,
      targetContext: projectTargetContext(collect(target, extra.signal)),
      requirement,
      analysisReport,
    }, translatorOptions, extra.signal),
  ));

  server.registerTool("forexplore_repair_translation", {
    title: "Repair Translation",
    description: "Repair a generated target method or class from structured compiler or contract feedback; it does not write files.",
    inputSchema: {
      target: targetSchema,
      candidateSource: z.string().min(1).max(MAX_CODE_CHARS),
      requirement: z.string().trim().min(1).max(MAX_REQUIREMENT_CHARS),
      analysisReport: analysisReportSchema,
      previousResult: translationResultSchema,
      validationFeedback: validationFeedbackSchema,
    },
    annotations: { destructiveHint: false },
  }, async (
    { target, candidateSource, requirement, analysisReport, previousResult, validationFeedback },
    extra,
  ) => runTool(() => repairTranslation({
    candidateSource,
    targetContext: projectTargetContext(collect(target, extra.signal)),
    requirement,
    analysisReport,
    previousResult,
    validationFeedback,
  }, translatorOptions, extra.signal)));

  server.registerTool("forexplore_validate_translation", {
    title: "Validate Translation",
    description: "Compile generated code using the selected target language as a standalone method or inside a temporary copy of the configured project.",
    inputSchema: {
      target: targetSchema,
      generatedCode: z.string().min(1).max(MAX_CODE_CHARS),
      mode: z.enum(["standalone", "integrated"]),
      className: z.string().trim().min(1).max(512).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ generatedCode, mode, className, target }) => runTool(() => {
    if (mode === "standalone") {
      return compileTargetStandalone(
        target.language,
        generatedCode,
        className ?? "ForeXploreStandalone",
      );
    }
    if (!options.skeletonProjectPath) {
      throw new Error("Integrated validation requires ADAPTATION_SKELETON_PROJECT_PATH.");
    }
    return compileTargetIntegrated(
      target.language,
      generatedCode,
      options.skeletonProjectPath,
      target.path,
    );
  }));

  server.registerTool("forexplore_adapt_translation", {
    title: "Adapt Translation",
    description: "Run the guarded workflow: collect context, analyze, translate, compile, repair up to three times, and return a patch preview without writing files.",
    inputSchema: {
      target: targetSchema,
      candidate: candidateSchema,
      requirement: z.string().trim().min(1).max(MAX_REQUIREMENT_CHARS),
      decisionNotes: z.string().max(MAX_NOTES_CHARS).default(""),
    },
    annotations: { destructiveHint: false },
  }, async ({ target, candidate, requirement, decisionNotes }, extra) => runTool(() => adapter.adapt({
    target,
    candidate,
    requirement,
    strategy: "translate",
    decisionNotes,
  }, extra.signal)));

  return server;
}

async function runTool<T>(work: () => Promise<T> | T) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await work(), null, 2) }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      }],
      isError: true,
    };
  }
}

export type TranslationMcpTarget = z.infer<typeof targetSchema>;
export type TranslationMcpCandidate = z.infer<typeof candidateSchema>;
export type TranslationMcpAnalysisReport = z.infer<typeof analysisReportSchema>;
