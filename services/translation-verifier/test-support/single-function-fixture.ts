import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRuntimeContext } from "../src/host/tools/common.js";
import type { VerificationInput } from "../src/types.js";

export const TEST_PATH = "tests/agent/BehaviorTest.java";
export const TARGET_PATH = "src/Target.java";

export const RUNNER_SCRIPT = `const fs = require('node:fs');
const content = fs.existsSync(${JSON.stringify(TEST_PATH)})
  ? fs.readFileSync(${JSON.stringify(TEST_PATH)}, 'utf8') : '';
fs.rmSync('target', { recursive: true, force: true });
fs.mkdirSync('target/surefire-reports', { recursive: true });
fs.mkdirSync('target/site/jacoco', { recursive: true });
const surefire = 'target/surefire-reports/TEST-BehaviorTest.xml';
const jacoco = 'target/site/jacoco/jacoco.xml';
const coverage = '<report><package name=""><class name="Target" sourcefilename="Target.java"><method name="targetFn" desc="()I"><counter type="METHOD" missed="0" covered="1"/></method></class></package></report>';
if (content.includes('BROKEN')) {
  fs.writeFileSync(surefire, '<testsuite name="BehaviorTest" tests="1" failures="0" errors="1" skipped="0"><testcase classname="BehaviorTest" name="compile"><error message="cannot find symbol"/></testcase></testsuite>');
} else if (content.includes('FAILING')) {
  fs.writeFileSync(surefire, '<testsuite name="BehaviorTest" tests="1" failures="1" errors="0" skipped="0"><testcase classname="BehaviorTest" name="requirement"><failure message="expected rejection">trace</failure></testcase></testsuite>');
  fs.writeFileSync(jacoco, coverage);
  process.exitCode = 1;
} else {
  fs.writeFileSync(surefire, '<testsuite name="BehaviorTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="BehaviorTest" name="requirement"/></testsuite>');
  fs.writeFileSync(jacoco, coverage);
}
`;

export type SingleFunctionFixture = {
  root: string;
  input: VerificationInput;
  resolveToolContext: () => Promise<ToolRuntimeContext>;
  cleanupCalls: number;
};

export async function createSingleFunctionFixture(
  roots: string[],
  testContent?: string,
  runnerScript = RUNNER_SCRIPT,
): Promise<SingleFunctionFixture> {
  const root = await mkdtemp(join(tmpdir(), "verifier-langchain-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests/agent"), { recursive: true });
  await writeFile(join(root, "src/Source.java"), "class Source { int sourceFn() { return 1; } }");
  await writeFile(join(root, TARGET_PATH), "class Target { int targetFn() { return 1; } }");
  if (testContent !== undefined) await writeFile(join(root, TEST_PATH), testContent);
  await writeFile(join(root, "fake-runner.cjs"), runnerScript);
  const input: VerificationInput = {
    schemaVersion: "2.0",
    sourceLanguage: "Java",
    targetLanguage: "Java",
    sourceProjectPath: root,
    targetProjectPath: root,
    subject: {
      sourceFunction: { path: "src/Source.java", name: "sourceFn" },
      targetFunction: { path: TARGET_PATH, name: "targetFn" },
      requirement: "Preserve the targetFn behavior.",
    },
    analysisReport: {
      schemaVersion: "1.0",
      applicability: { level: "reference", confidence: 1, reasons: [] },
      behaviorMapping: [],
      contractMapping: [],
      dependencyPlan: [],
      implementationPlan: [],
      risks: [],
      assumptions: [],
      unresolved: [],
    },
    migrationPlan: {},
    translation: { round: 0, files: [] },
  };
  const fixture: SingleFunctionFixture = {
    root,
    input,
    cleanupCalls: 0,
    resolveToolContext: async () => ({
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: root,
      targetProjectPath: root,
      sourcePath: input.subject.sourceFunction.path,
      targetPath: input.subject.targetFunction.path,
      targetFunction: input.subject.targetFunction,
      sourceDirectory: "src",
      targetDirectory: "src",
      testRoots: ["tests/agent"],
      testRunner: "maven",
      targetTest: { executable: process.execPath, args: ["fake-runner.cjs"], timeoutMs: 10_000 },
      async cleanup() { fixture.cleanupCalls += 1; },
    }),
  };
  return fixture;
}
