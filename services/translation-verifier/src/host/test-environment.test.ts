import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestEnvironment } from "./test-environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "translation-verifier-environment-"));
  roots.push(root);
  return root;
}

describe("resolveTestEnvironment", () => {
  it("uses Maven test roots configured in pom.xml", async () => {
    const root = await project();
    await mkdir(join(root, "custom-tests/java"), { recursive: true });
    await mkdir(join(root, "custom-tests/resources"), { recursive: true });
    await writeFile(
      join(root, "pom.xml"),
      `<project><build><testSourceDirectory>custom-tests/java</testSourceDirectory><testResources><testResource><directory>custom-tests/resources</directory></testResource></testResources></build></project>`,
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).resolves.toEqual({
      framework: "maven",
      testRoots: ["custom-tests/java", "custom-tests/resources"],
      targetTest: { executable: "mvn", args: ["test"] },
    });
  });

  it("uses pytest testpaths from project configuration", async () => {
    const root = await project();
    await mkdir(join(root, "checks"), { recursive: true });
    await mkdir(join(root, "integration-tests"), { recursive: true });
    await writeFile(
      join(root, "pytest.ini"),
      "[pytest]\ntestpaths = checks integration-tests\n",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Python", targetProjectPath: root }),
    ).resolves.toMatchObject({
      framework: "pytest",
      testRoots: ["checks", "integration-tests"],
      targetTest: { args: ["-m", "pytest"] },
    });
  });

  it("uses the Vitest root from vitest.config.ts", async () => {
    const root = await project();
    await mkdir(join(root, "checks"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^4.0.0" }, scripts: { test: "vitest run" } }),
    );
    await writeFile(
      join(root, "vitest.config.ts"),
      "export default { test: { root: 'checks' } }\n",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "TypeScript", targetProjectPath: root }),
    ).resolves.toMatchObject({
      framework: "vitest",
      testRoots: ["checks"],
      targetTest: { args: ["test", "--"] },
    });
  });

  it("rejects a configured test root that does not exist", async () => {
    const root = await project();
    await writeFile(
      join(root, "pom.xml"),
      "<project><build><testSourceDirectory>missing-tests</testSourceDirectory></build></project>",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).rejects.toThrow("test root does not exist: missing-tests");
  });

  it("rejects ambiguous Java build frameworks", async () => {
    const root = await project();
    await writeFile(join(root, "pom.xml"), "<project />");
    await writeFile(join(root, "build.gradle"), "plugins {}\n");

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).rejects.toThrow("ambiguous Maven and Gradle configurations");
  });
});
