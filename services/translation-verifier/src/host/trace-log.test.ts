import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJsonlAgentTraceLogger,
  emitAgentTrace,
  type AgentTraceEvent,
} from "./trace-log.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent trace logger", () => {
  it("writes detailed events, redacts configured secrets, and uses mode 600", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-trace-"));
    roots.push(root);
    const filePath = join(root, "trace.jsonl");
    const logger = createJsonlAgentTraceLogger(filePath, ["secret-key"]);
    const event: AgentTraceEvent = {
      at: "2026-01-01T00:00:00.000Z",
      runId: "run-1",
      event: "tool.completed",
      output: { content: "visible output", credential: "secret-key" },
    };

    emitAgentTrace(logger, event);

    const content = await readFile(filePath, "utf8");
    expect(content).toContain("visible output");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("secret-key");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
