#!/usr/bin/env node
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createVerificationWorkspace } from "../src/verification-workspace.js";
import {
  runManagedProcess,
  sanitizedBuildEnvironment,
  type ManagedProcessResult,
} from "../src/process-tree.js";
import {
  fileUploadInput,
  repositoryRoot,
  variants,
} from "./fileupload-benchmark-fixture.js";

const output = resolve(
  process.argv[2] ??
    join(
      repositoryRoot,
      "services/translation-verifier/test-results",
      `fileupload-oracles-${Date.now()}`,
    ),
);
const oracleRoot = fileURLToPath(new URL("./oracles/", import.meta.url));
mkdirSync(output, { recursive: true });
const results = [];
for (const variant of variants) {
  const ws = createVerificationWorkspace(fileUploadInput(variant), {
    workspaceRoot: join(output, variant),
    artifactRoot: join(output, "artifacts"),
  });
  const logs: Array<
    ManagedProcessResult & { command: string; args: string[]; cwd: string }
  > = [];
  const command = async (executable: string, args: string[], cwd: string) => {
    const result = await runManagedProcess({
      command: executable,
      args,
      cwd,
      env: sanitizedBuildEnvironment(),
      deadlineAt: Date.now() + 120000,
    });
    logs.push({ command: executable, args, cwd, ...result });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error(
        `${executable} failed: ${result.stderr}\n${result.stdout}`,
      );
    return result.stdout;
  };
  try {
    const runner = join(ws.context.workspace.root, "target/.forexplore-tests");
    copyFileSync(
      join(oracleRoot, "FileUploadOracle.java.txt"),
      join(runner, "FileUploadOracle.java"),
    );
    await command(
      "mvn",
      ["-q", "-Dmaven.test.skip=true", "compile"],
      ws.context.workspace.targetRoot,
    );
    const classpath = [
      join(ws.context.workspace.targetRoot, "target/classes"),
      join(
        homedir(),
        ".m2/repository/commons-io/commons-io/2.11.0/commons-io-2.11.0.jar",
      ),
    ].join(delimiter);
    await command(
      "javac",
      ["-cp", classpath, "-d", runner, join(runner, "FileUploadOracle.java")],
      runner,
    );
    const java = await command(
      "java",
      ["-cp", [runner, classpath].join(delimiter), "FileUploadOracle"],
      runner,
    );
    const python = await command(
      "python3",
      [
        "-B",
        join(oracleRoot, "fileupload_oracle.py"),
        ws.context.workspace.sourceRoot,
      ],
      runner,
    );
    const parse = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string; passed: boolean });
    const source = parse(python);
    const target = parse(java);
    const expectedFailures =
      variant === "correct"
        ? []
        : variant === "count-plus-one"
          ? ["empty", "text", "binary", "large", "discard"]
          : ["text", "binary", "large"];
    const actualFailures = target
      .filter((item) => !item.passed)
      .map((item) => item.id);
    const passed =
      source.length === 5 &&
      source.every((item) => item.passed) &&
      target.length === 5 &&
      JSON.stringify(actualFailures) === JSON.stringify(expectedFailures);
    results.push({
      variant,
      source,
      target,
      expectedFailures,
      actualFailures,
      passed,
      logs,
    });
  } finally {
    writeFileSync(
      join(output, `${variant}-commands.json`),
      JSON.stringify(logs, null, 2) + "\n",
    );
    ws.cleanup();
  }
}
writeFileSync(
  join(output, "oracle-results.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      output,
      variants: results.map(({ variant, passed, actualFailures }) => ({
        variant,
        passed,
        actualFailures,
      })),
    },
    null,
    2,
  ),
);
process.exitCode = results.every((item) => item.passed) ? 0 : 1;
