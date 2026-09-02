import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type {
  AdaptationResult,
  ModuleTarget,
  SearchCandidate,
} from "@forexplore/contracts";
import { extractSymbols } from "@forexplore/code-indexer";
import { compilerInternals } from "../services/adaptation-service/src/compiler.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const skeletonRoot = join(repositoryRoot, "fixtures/target-system/commons-fileupload-java-skeleton");
const experimentRoot = "/tmp/forexplore-class-pipeline-skeleton";
const retrievalUrl = process.env.RETRIEVAL_URL?.trim() || "http://127.0.0.1:8787";
const adaptationUrl = process.env.ADAPTATION_URL?.trim() || "http://127.0.0.1:8792";

interface TargetWithSource {
  target: ModuleTarget;
  sourcePath: string;
}

interface PipelineRecord {
  path: string;
  name: string;
  candidate?: string;
  candidateLanguage?: string;
  retrievalStatus: "pass" | "fail";
  adaptationStatus: "pass" | "fail" | "skipped";
  isolatedCompile: "pass" | "fail" | "unverified" | "unknown";
  cumulativeCompile: "accepted" | "rejected" | "skipped";
  reason?: string;
}

interface TestTotals {
  executed: number;
  passed: number;
  failures: number;
  errors: number;
  skipped: number;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".java")) files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

function targetSignature(signature: string): string {
  return signature.replace(/\s*\{\s*$/, "").trim();
}

function discoverTargets(): TargetWithSource[] {
  const sourceRoot = join(skeletonRoot, "src/main/java");
  const targets: TargetWithSource[] = [];
  for (const sourcePath of sourceFiles(sourceRoot)) {
    const source = readFileSync(sourcePath, "utf8");
    const fileName = basename(sourcePath, ".java");
    for (const symbol of extractSymbols(source, "Java")) {
      if (symbol.kind !== "class" || symbol.name !== fileName) continue;
      const relativePath = relative(skeletonRoot, sourcePath).replaceAll("\\", "/");
      targets.push({
        sourcePath,
        target: {
          id: `skeleton:${relativePath}:${symbol.line}:${symbol.name}`,
          name: symbol.name,
          kind: "class",
          path: relativePath,
          language: "Java",
          signature: targetSignature(symbol.signature),
          documentation: symbol.summary || undefined,
          line: symbol.line,
          implementationStatus: "unimplemented",
        },
      });
    }
  }
  return targets.sort((left, right) => left.target.path.localeCompare(right.target.path));
}

async function postJson(url: string, body: unknown): Promise<{ status: number; value: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = { error: text };
  }
  return { status: response.status, value };
}

function compilerCommand(): string {
  return process.env.MAVEN_COMMAND?.trim() || "mvn";
}

function runMaven(projectRoot: string, goal: "compile" | "test"): { success: boolean; output: string } {
  try {
    const output = execFileSync(
      compilerCommand(),
      ["-q", goal === "compile" ? "-DskipTests" : "", goal].filter(Boolean),
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: goal === "compile" ? 120_000 : 180_000,
        maxBuffer: 20 * 1024 * 1024,
        stdio: "pipe",
      },
    );
    return { success: true, output };
  } catch (error: unknown) {
    const stdout = error && typeof error === "object" && "stdout" in error
      ? String(error.stdout ?? "")
      : "";
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr ?? "")
      : error instanceof Error ? error.message : String(error);
    return { success: false, output: `${stdout}\n${stderr}` };
  }
}

function parseTestTotals(projectRoot: string): TestTotals {
  const reportRoot = join(projectRoot, "target/surefire-reports");
  const totals: TestTotals = { executed: 0, passed: 0, failures: 0, errors: 0, skipped: 0 };
  if (!existsSync(reportRoot)) return totals;
  for (const name of readdirSync(reportRoot)) {
    if (!name.endsWith(".txt")) continue;
    const report = readFileSync(join(reportRoot, name), "utf8");
    const match = report.match(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/);
    if (!match) continue;
    const executed = Number(match[1]);
    const failures = Number(match[2]);
    const errors = Number(match[3]);
    const skipped = Number(match[4]);
    totals.executed += executed;
    totals.failures += failures;
    totals.errors += errors;
    totals.skipped += skipped;
    totals.passed += executed - failures - errors - skipped;
  }
  return totals;
}

function isolatedCompileStatus(result: AdaptationResult): PipelineRecord["isolatedCompile"] {
  const validation = result.validation.find((item) => item.id === "integrated-compile");
  return validation?.status === "pass"
    ? "pass"
    : validation?.status === "unverified"
      ? "unverified"
      : validation?.status === "fail"
        ? "fail"
        : "unknown";
}

async function main(): Promise<void> {
  const discoveredTargets = discoverTargets();
  const requestedLimit = Number.parseInt(process.env.TARGET_LIMIT ?? "", 10);
  const targets = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? discoveredTargets.slice(0, requestedLimit)
    : discoveredTargets;
  if (targets.length === 0) throw new Error("No Java class targets were discovered.");
  rmSync(experimentRoot, { recursive: true, force: true });
  cpSync(skeletonRoot, experimentRoot, { recursive: true });

  const records: PipelineRecord[] = [];
  let cumulativeAccepted = 0;
  for (const [index, item] of targets.entries()) {
    const target = item.target;
    const search = await postJson(`${retrievalUrl}/v1/search`, {
      target,
      requirement: target.documentation || `Translate the complete ${target.name} Java class while preserving its public contract.`,
      topK: 4,
      repositoryScopes: [],
    });
    const candidates = search.value?.candidates as SearchCandidate[] | undefined;
    const candidate = search.status === 200 ? candidates?.[0] : undefined;
    const record: PipelineRecord = {
      path: target.path,
      name: target.name,
      candidate: candidate?.title,
      candidateLanguage: candidate?.language,
      retrievalStatus: candidate ? "pass" : "fail",
      adaptationStatus: "skipped",
      isolatedCompile: "unknown",
      cumulativeCompile: "skipped",
      reason: candidate ? undefined : String(search.value?.error || "no class candidate returned"),
    };
    if (!candidate) {
      records.push(record);
      console.log(JSON.stringify({ index: index + 1, total: targets.length, ...record }));
      continue;
    }

    const adaptation = await postJson(`${adaptationUrl}/v1/adapt`, {
      target,
      candidate,
      requirement: target.documentation || `Translate the complete ${target.name} Java class while preserving its public contract.`,
      strategy: "translate",
      decisionNotes: "Cumulative class-level pipeline experiment. Never write back to the source skeleton.",
    });
    const result = adaptation.value as Partial<AdaptationResult> & { error?: string };
    record.adaptationStatus = adaptation.status === 200 ? "pass" : "fail";
    record.isolatedCompile = adaptation.status === 200 && Array.isArray(result.validation)
      ? isolatedCompileStatus(result as AdaptationResult)
      : "unknown";
    if (adaptation.status !== 200 || record.isolatedCompile !== "pass" || !result.generatedCode) {
      record.reason = result.error || `isolated compile status: ${record.isolatedCompile}`;
      records.push(record);
      console.log(JSON.stringify({ index: index + 1, total: targets.length, ...record }));
      continue;
    }

    const temporaryTarget = join(experimentRoot, target.path);
    const before = readFileSync(temporaryTarget, "utf8");
    try {
      const replaced = compilerInternals.replaceTargetClass(before, result.generatedCode);
      writeFileSync(temporaryTarget, replaced, "utf8");
    } catch (error: unknown) {
      record.reason = error instanceof Error ? error.message : String(error);
      record.cumulativeCompile = "rejected";
      records.push(record);
      console.log(JSON.stringify({ index: index + 1, total: targets.length, ...record }));
      continue;
    }

    const cumulative = runMaven(experimentRoot, "compile");
    if (cumulative.success) {
      record.cumulativeCompile = "accepted";
      cumulativeAccepted += 1;
    } else {
      writeFileSync(temporaryTarget, before, "utf8");
      record.cumulativeCompile = "rejected";
      record.reason = "cumulative project compilation failed; patch discarded";
    }
    records.push(record);
    console.log(JSON.stringify({
      index: index + 1,
      total: targets.length,
      accepted: cumulativeAccepted,
      ...record,
    }));
  }

  const tests = runMaven(experimentRoot, "test");
  const testTotals = parseTestTotals(experimentRoot);
  const summary = {
    setting: {
      targetCount: targets.length,
      candidateTopK: 4,
      candidateSelection: "reranked top-1",
      cumulativeCompileGate: true,
      backfill: "disabled; temporary copy only",
    },
    metrics: {
      cumulativeCompilePassedClasses: cumulativeAccepted,
      cumulativeCompilePassRate: Number((cumulativeAccepted / targets.length).toFixed(4)),
      projectTestsCommandSucceeded: tests.success,
      projectTests: testTotals,
      projectTestPassRate: testTotals.executed === 0
        ? null
        : Number((testTotals.passed / testTotals.executed).toFixed(4)),
    },
    records,
    experimentRoot,
  };
  writeFileSync("/tmp/forexplore-class-pipeline-results.json", JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ completed: true, ...summary.metrics }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
