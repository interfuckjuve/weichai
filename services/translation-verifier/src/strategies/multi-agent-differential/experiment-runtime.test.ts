import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBehaviorRuntime } from "./claude-runtime.js";
import {
  BEHAVIOR_COMMAND_ENTRY,
  BEHAVIOR_CONTROL_ENV,
} from "./behavior-command.js";
import type {
  BehaviorCommandRecord,
  BehaviorExecutionScope,
} from "./behavior-types.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "behavior-experiment-")),
  );
  directories.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  for (const project of [source, target]) {
    mkdirSync(join(project, ".forexplore-tests"), { recursive: true });
    writeFileSync(join(project, "implementation.cjs"), "module.exports = 42;");
    writeFileSync(join(project, "obsolete.cjs"), "old");
  }
  const sandbox: BehaviorExecutionScope = {
    cwd: source,
    readRoots: [source, target],
    writeRoots: [source],
  };
  return { root, source, target, sandbox };
}

function fakeClaude(root: string, script: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.236'); process.exit(0); }
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
const control = JSON.parse(fs.readFileSync(process.env[${JSON.stringify(BEHAVIOR_CONTROL_ENV)}], 'utf8'));
const proxy = (argv) => {
  const result = spawnSync(${JSON.stringify(process.execPath)},
    ['--import', ${JSON.stringify(import.meta.resolve("tsx"))}, ${JSON.stringify(BEHAVIOR_COMMAND_ENTRY)}, ...argv],
    { env: process.env, encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
};
const command = (side, script) => proxy(['--project', side, '--', 'node', '-e', script]);
const emit = (data) => console.log(JSON.stringify({ type: 'assistant', data }));
${script}
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
}

const mutation = `
  const fs = require('node:fs');
  fs.writeFileSync('implementation.cjs', 'module.exports = 43;');
  fs.unlinkSync('obsolete.cjs');
  fs.writeFileSync('new-production.cjs', 'new');
  console.log('mutated');
`;

describe("Host-approved experiment project access", () => {
  it("keeps target originals protected while a source-only experiment proxy edits source and authors target tests", async () => {
    const f = fixture();
    const sourceFrozen = join(f.source, ".forexplore-tests", "input.json");
    const targetFrozen = join(f.target, ".forexplore-tests", "input.json");
    writeFileSync(sourceFrozen, "source frozen");
    writeFileSync(targetFrozen, "target frozen");
    fakeClaude(
      f.root,
      `
      const source = control.projects.source;
      const target = control.projects.target;
      fs.mkdirSync(target.scope.cwd + '/tests');
      fs.writeFileSync(target.scope.cwd + '/tests/generated.test.cjs', 'target test');
      fs.mkdirSync(source.scope.cwd + '/tests');
      fs.writeFileSync(source.scope.cwd + '/tests/generated.test.cjs', 'source test');
      const first = command('source', ${JSON.stringify(mutation)});
      const second = command('source', "console.log('again')");
      const unauthorized = command('target', "console.log('must not run')");
      const forged = proxy(['--project', 'source', '--project-access', 'experiment', '--', 'node', '-e', '']);
      emit({ settings, first, second, unauthorized, forged });
    `,
    );
    const result = await createBehaviorRuntime({
      apiKey: "local-only-credential",
    }).runAgent({
      side: "source",
      sandbox: {
        ...f.sandbox,
        projectAccess: "experiment",
        readOnlyFiles: [sourceFrozen],
      },
      additionalProjects: {
        target: {
          cwd: f.target,
          readRoots: [f.source, f.target],
          writeRoots: [f.target],
          readOnlyFiles: [targetFrozen],
        },
      },
      executionSides: ["source"],
      prompt: "local process fixture",
      deadlineAt: Date.now() + 20_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.first).toMatchObject({ exitCode: 0, stdout: "mutated\n" });
    expect(data.second).toMatchObject({ exitCode: 0, stdout: "again\n" });
    expect(data.unauthorized.exitCode).toBe(1);
    expect(data.forged.exitCode).toBe(1);
    expect(data.settings.sandbox).toEqual({ enabled: false });
    const deny = data.settings.permissions.deny as string[];
    for (const tool of ["Edit", "Write"]) {
      const rule = (path: string) => `${tool}(//${path.replace(/^\/+/, "")})`;
      expect(deny).not.toContain(rule(join(f.source, "implementation.cjs")));
      expect(deny).toContain(rule(join(f.target, "implementation.cjs")));
      expect(deny).toContain(rule(sourceFrozen));
      expect(deny).toContain(rule(targetFrozen));
    }
    expect(result.commandEvidence).toHaveLength(2);
    expect(result.commandEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          side: "source",
          baselineValid: true,
          completed: true,
          testFiles: {
            "tests/generated.test.cjs": "source test",
            ".forexplore-tests/input.json": "source frozen",
          },
        }),
      ]),
    );
    expect(
      readFileSync(join(f.target, "tests/generated.test.cjs"), "utf8"),
    ).toBe("target test");
    expect(readFileSync(join(f.target, "implementation.cjs"), "utf8")).toBe(
      "module.exports = 42;",
    );
  }, 25_000);

  it.each([
    ["target original", "target", "implementation.cjs", /baseline changed/],
    [
      "target frozen input",
      "target",
      ".forexplore-tests/input.json",
      /Frozen file integrity/,
    ],
    [
      "source frozen input",
      "source",
      ".forexplore-tests/input.json",
      /Frozen file integrity/,
    ],
  ] as const)(
    "rejects a source experiment command changing %s and records failed integrity",
    async (_label, side, path, error) => {
      const f = fixture();
      const sourceFrozen = join(f.source, ".forexplore-tests/input.json");
      const targetFrozen = join(f.target, ".forexplore-tests/input.json");
      writeFileSync(sourceFrozen, "source frozen");
      writeFileSync(targetFrozen, "target frozen");
      const script = `${mutation}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(side === "source" ? f.source : f.target, path))}, 'tampered');`;
      fakeClaude(f.root, `emit(command('source', ${JSON.stringify(script)}));`);
      let evidence: BehaviorCommandRecord[] = [];
      await expect(
        createBehaviorRuntime({ apiKey: "local-only-credential" }).runAgent({
          side: "source",
          sandbox: {
            ...f.sandbox,
            projectAccess: "experiment",
            readOnlyFiles: [sourceFrozen],
          },
          additionalProjects: {
            target: {
              cwd: f.target,
              readRoots: [f.source, f.target],
              writeRoots: [f.target],
              readOnlyFiles: [targetFrozen],
            },
          },
          executionSides: ["source"],
          prompt: "local process fixture",
          deadlineAt: Date.now() + 20_000,
          onEvidence: (records) => {
            evidence = records;
          },
        }),
      ).rejects.toThrow(error);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        side: "source",
        exitCode: 0,
        completed: true,
        baselineValid: false,
      });
    },
    25_000,
  );

  it.each([
    [
      "symlink",
      "fs.symlinkSync('implementation.cjs', 'linked.cjs')",
      /Unsupported project entry/,
    ],
    [
      "hardlink",
      "fs.linkSync('implementation.cjs', 'linked.cjs')",
      /Hard-linked project files/,
    ],
    [
      "replaced cwd",
      "const cwd = process.cwd(); fs.renameSync(cwd, cwd + '-old'); fs.symlinkSync(cwd + '-old', cwd)",
      /Project baseline root changed/,
    ],
  ] as const)(
    "still rejects experiment %s topology changes after a command",
    async (_label, change, error) => {
      const f = fixture();
      await expect(
        createBehaviorRuntime().runCommand({
          sandbox: { ...f.sandbox, projectAccess: "experiment" },
          command: {
            executable: "node",
            args: ["-e", `const fs = require('node:fs'); ${change}`],
          },
          deadlineAt: Date.now() + 10_000,
        }),
      ).rejects.toThrow(error);
    },
  );

  it("scans experiment topology before every command even with a retained Host baseline", async () => {
    const f = fixture();
    const runtime = createBehaviorRuntime();
    const task = {
      sandbox: { ...f.sandbox, projectAccess: "experiment" as const },
      command: { executable: "node", args: ["-e", "console.log('ok')"] },
      deadlineAt: Date.now() + 10_000,
    };
    await runtime.runCommand(task);
    symlinkSync("implementation.cjs", join(f.source, "linked.cjs"));
    await expect(runtime.runCommand(task)).rejects.toThrow(
      /Unsupported project entry/,
    );
  });

  it.each(["protected", "experiment ", null, true])(
    "rejects invalid Host project access %s",
    async (projectAccess) => {
      const f = fixture();
      await expect(
        createBehaviorRuntime().runCommand({
          sandbox: { ...f.sandbox, projectAccess } as BehaviorExecutionScope,
          command: { executable: "node", args: ["-e", ""] },
          deadlineAt: Date.now() + 10_000,
        }),
      ).rejects.toThrow(/Invalid Host project access/);
    },
  );

  it.each([false, true])(
    "permits original source edits, deletions and arbitrary additions only with experiment=%s",
    async (experiment) => {
      const f = fixture();
      const runtime = createBehaviorRuntime();
      const sandbox = {
        ...f.sandbox,
        ...(experiment ? { projectAccess: "experiment" as const } : {}),
      };
      const task = {
        sandbox,
        deadlineAt: Date.now() + 10_000,
        command: { executable: "node", args: ["-e", mutation] },
      };
      if (!experiment) {
        await expect(runtime.runCommand(task)).rejects.toThrow(
          /baseline changed/,
        );
        return;
      }
      expect((await runtime.runCommand(task)).stdout).toBe("mutated\n");
      expect(readFileSync(join(f.source, "implementation.cjs"), "utf8")).toBe(
        "module.exports = 43;",
      );
      expect(existsSync(join(f.source, "obsolete.cjs"))).toBe(false);
      expect(readFileSync(join(f.source, "new-production.cjs"), "utf8")).toBe(
        "new",
      );
      expect(
        (
          await runtime.runCommand({
            ...task,
            command: {
              executable: "node",
              args: ["-e", "console.log('again')"],
            },
          })
        ).stdout,
      ).toBe("again\n");
    },
  );
});
