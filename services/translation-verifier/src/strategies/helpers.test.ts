import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceRoot,
  packageRoot,
  VERIFIER_COMMAND_ENTRY,
} from "./helpers.js";

describe("smoke helper paths", () => {
  it("resolves package, workspace and verifier-command paths", () => {
    expect(packageRoot.endsWith("services/translation-verifier")).toBe(true);
    expect(defaultWorkspaceRoot()).toBe(resolve(packageRoot, "test-results"));
    expect(VERIFIER_COMMAND_ENTRY).toBe(join(packageRoot, "src", "verifier-command.ts"));
  });
});
