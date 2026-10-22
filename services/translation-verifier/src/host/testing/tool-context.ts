import { dirname } from "node:path";
import { resolveTestEnvironment } from "./test-environment.js";
import type {
  AgentTaskContext,
  ToolRuntimeContext,
} from "../tools/common.js";

/** Resolves the Host-owned test environment for one Agent task. */
export type ToolContextResolver = (
  taskContext: AgentTaskContext,
) => Promise<ToolRuntimeContext>;

/**
 * Default resolver shared by the LangChain Hosts and every production caller:
 * it discovers the dedicated test roots, the fixed runner command and any
 * ephemeral harness cleanup for the task's target project.
 */
export async function defaultToolContextResolver(
  taskContext: AgentTaskContext,
): Promise<ToolRuntimeContext> {
  const testEnvironment = await resolveTestEnvironment(taskContext);
  return {
    ...taskContext,
    sourceDirectory: directoryForFile(taskContext.sourcePath),
    targetDirectory: directoryForFile(taskContext.targetPath),
    testRoots: testEnvironment.testRoots,
    testRunner: testEnvironment.framework,
    targetTest: testEnvironment.targetTest,
    cleanup: testEnvironment.cleanup,
  };
}

function directoryForFile(path: string): string {
  const directory = dirname(path.replaceAll("\\", "/"));
  return directory === "" ? "." : directory;
}
