import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type {
  AnalysisRequest,
  AnalysisReport,
  ModuleTarget,
  SearchCandidate,
} from "@forexplore/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyzerAgent,
  buildAnalyzerMessages,
  parseAnalysisReport,
  type AnalyzerMessage,
  type AnalyzerModelClient,
} from "./analyzer";
import { collectTargetContext } from "./context-collector";

interface AnalysisCase {
  id: string;
  requirement: string;
  candidatePreview: string;
  expectedApplicability: AnalysisReport["applicability"]["level"];
  expectedStatus: AnalysisReport["behaviorMapping"][number]["status"];
}

const cases = JSON.parse(
  readFileSync(fileURLToPath(new URL("../testdata/analysis-cases.json", import.meta.url)), "utf8"),
) as AnalysisCase[];

const projectRoot = fileURLToPath(
  new URL("../../../fixtures/target-system/forexplore-csharp-workspace", import.meta.url),
);

const target: ModuleTarget = {
  id: "get-quote-async-function",
  name: "GetQuoteAsync",
  kind: "function",
  path: "src/Application/QuoteOrchestrationService.cs",
  language: "C#",
  signature: "Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)",
  line: 24,
};

const targetContext = collectTargetContext({ projectRoot, target });

function candidate(preview: string): SearchCandidate {
  return {
    id: "fixture-candidate",
    title: "Quote route",
    repository: "fixture/java",
    license: "Apache-2.0",
    language: "Java",
    kind: "function",
    path: "src/QuoteRouter.java",
    signature: "public Quote route(QuoteRequest request)",
    summary: "Routes a quote request.",
    score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.7 },
    preview,
    dependencies: ["ProviderClient"],
    compatibility: [],
    risks: [],
  };
}

function request(testCase: AnalysisCase): AnalysisRequest {
  return {
    schemaVersion: "1.0",
    targetContext,
    candidate: candidate(testCase.candidatePreview),
    requirement: testCase.requirement,
    immutableConstraints: targetContext.constraints,
  };
}

function report(
  applicability: AnalysisReport["applicability"]["level"],
  status: AnalysisReport["behaviorMapping"][number]["status"],
): AnalysisReport {
  return {
    schemaVersion: "1.0",
    applicability: {
      level: applicability,
      confidence: 0.82,
      reasons: ["The candidate preview was compared with the target contract."],
    },
    behaviorMapping: [{
      requirement: "The requested behavior",
      status,
      candidateEvidence: ["candidate.preview"],
      targetAction: "Implement the behavior within the target method.",
    }],
    contractMapping: [{
      source: "Quote route",
      target: "GetQuoteAsync",
      action: "rename",
      note: "Keep the target method name and asynchronous contract.",
    }],
    dependencyPlan: [{
      sourceDependency: "ProviderClient",
      targetDependency: "IQuoteProvider",
      action: "adapt",
    }],
    implementationPlan: ["Preserve the target signature.", "Implement the required behavior using existing target dependencies."],
    risks: [],
    assumptions: [],
    unresolved: [],
  };
}

describe("AnalyzerAgent", () => {
  it.each(cases)("produces a validated report for $id", async (testCase) => {
    const expected = report(testCase.expectedApplicability, testCase.expectedStatus);
    const complete = vi.fn(async (_messages: readonly AnalyzerMessage[]) => JSON.stringify(expected));
    const client: AnalyzerModelClient = { complete };
    const agent = new AnalyzerAgent({ client });

    const actual = await agent.analyze(request(testCase));

    expect(actual).toEqual(expected);
    expect(complete).toHaveBeenCalledTimes(1);
    const messages = complete.mock.calls[0]?.[0] ?? [];
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[1]?.content).toContain("[TARGET MODULE CONTEXT]");
    expect(messages[1]?.content).toContain(JSON.stringify(testCase.candidatePreview));
  });

  it("accepts a JSON object returned inside a markdown fence", () => {
    const value = report("direct", "covered");
    expect(parseAnalysisReport(`Here is the report:\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``)).toEqual(value);
  });

  it("passes unknown contract actions through without a repair call", async () => {
    const advisory = report("adapt", "partial");
    advisory.contractMapping.push({
      source: "Audit record",
      target: "IAuditJournal",
      action: "compose-through-port",
      note: "Use the target journal dependency.",
    });
    const calls: Array<readonly AnalyzerMessage[]> = [];
    const complete: AnalyzerModelClient["complete"] = async (messages) => {
      calls.push(messages);
      return JSON.stringify(advisory);
    };
    const agent = new AnalyzerAgent({ client: { complete } });

    await expect(agent.analyze(request(cases[0]))).resolves.toEqual(advisory);
    expect(calls).toHaveLength(1);
  });

  it("accepts common contract action terminology", () => {
    for (const action of ["adapt", "map", "delegate", "wrap"] as const) {
      const value = report("adapt", "partial");
      value.contractMapping[0]!.action = action;
      expect(parseAnalysisReport(JSON.stringify(value)).contractMapping[0]?.action).toBe(action);
    }
  });

  it("accepts arbitrary Analyzer terminology without schema repairs", async () => {
    const advisory = report("adapt", "partial");
    advisory.applicability.level = "candidate-with-caveats";
    advisory.behaviorMapping[0]!.status = "mostly-covered";
    advisory.contractMapping[0]!.action = "compose-through-port";
    advisory.dependencyPlan[0]!.action = "provided-by-runtime";
    const complete = vi.fn(async () => JSON.stringify(advisory));
    const agent = new AnalyzerAgent({ client: { complete } });

    await expect(agent.analyze(request(cases[0]))).resolves.toEqual(advisory);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("preserves narrative output and fills omitted report sections", () => {
    expect(parseAnalysisReport("Candidate is usable with a compatibility wrapper.")).toMatchObject({
      schemaVersion: "1.0",
      assumptions: ["Candidate is usable with a compatibility wrapper."],
    });
    expect(parseAnalysisReport(JSON.stringify({ schemaVersion: "future" }))).toEqual({
      schemaVersion: "1.0",
      applicability: { level: "reference", confidence: 0, reasons: [] },
      behaviorMapping: [],
      contractMapping: [],
      dependencyPlan: [],
      implementationPlan: [],
      risks: [],
      assumptions: [],
      unresolved: [],
    });
  });

  it("requires a non-empty requirement before making a model call", async () => {
    const client = { complete: vi.fn(async () => "never") };
    const agent = new AnalyzerAgent({ client });

    await expect(
      agent.analyze({ ...request(cases[0]), requirement: "   " }),
    ).rejects.toThrow("requirement must not be empty");
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("propagates model client errors", async () => {
    const client = {
      complete: vi.fn(async () => {
        throw new Error("upstream timeout");
      }),
    };
    const agent = new AnalyzerAgent({ client });

    await expect(agent.analyze(request(cases[0]))).rejects.toThrow("upstream timeout");
  });
});

describe("buildAnalyzerMessages", () => {
  it("keeps target facts and user intent in separate prompt sections", () => {
    const messages = buildAnalyzerMessages(request(cases[0]));
    expect(messages[0]?.content).toContain("immutable");
    expect(messages[1]?.content).toContain("[USER REQUIREMENT]");
    expect(messages[1]?.content).toContain("[RETRIEVED CANDIDATE]");
  });
});
