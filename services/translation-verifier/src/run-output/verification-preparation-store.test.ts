import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberPreparation, assertRememberedPreparation } from "./verification-preparation-store.js";
import { createVerificationArtifactStore } from "./verification-artifact-store.js";
import type { VerificationPreparation, VerificationStrategyContext } from "../schemas/verification-types.js";

const writes = vi.hoisted(() => ({ failReceipt: false }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (writes.failReceipt && typeof args[0] === "number") throw new Error("simulated receipt write failure");
    return actual.writeFileSync(...args);
  } };
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("retries the same preparation after a failed receipt write without trusting partial receipts", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "preparation-store-"))); roots.push(root);
  const artifactRoot = join(root, "durable");
  const preparation: VerificationPreparation = { schemaVersion: "1.0", strategyId: "fixture", strategyVersion: "1.0.0", inputHash: "a".repeat(64), contentHash: "b".repeat(64), payload: {} };
  const stage = (name: string) => {
    const strategyRoot = join(root, name); fs.mkdirSync(strategyRoot);
    const store = createVerificationArtifactStore({ artifactRoot, agentRoot: strategyRoot, durablePrefix: name });
    const context: VerificationStrategyContext = { workspace: { root, sourceRoot: root, targetRoot: root, strategyRoot, evidenceRoot: strategyRoot }, deadlineAt: Date.now() + 1000, writeArtifact: store.writeArtifact };
    return { context, store };
  };
  writes.failReceipt = true;
  const first = stage("first");
  await expect(rememberPreparation(artifactRoot, preparation, first.context)).rejects.toThrow(/receipt write failure/);
  first.store.cleanup({ discardArtifacts: true });
  expect(fs.readdirSync(join(artifactRoot, "trusted-preparations"))).toEqual([]);
  writes.failReceipt = false;
  const second = stage("second");
  await rememberPreparation(artifactRoot, preparation, second.context);
  expect(() => assertRememberedPreparation(artifactRoot, preparation)).not.toThrow();
  expect(() => assertRememberedPreparation(artifactRoot, { ...preparation, payload: { changed: true } })).toThrow(/unchanged preparation/);
});
