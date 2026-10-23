import { describe, expect, it, vi } from "vitest";
import { createCodeIntelligenceRuntime, type CodeIntelligenceRuntime } from "../../code-intelligence-service/src/index.js";
import { prepareHistoryView } from "./backend-capabilities.js";

vi.mock("../../code-intelligence-service/src/index.js", () => ({ createCodeIntelligenceRuntime: vi.fn() }));

describe("backend capability preflight", () => {
  it.each(["missing repository", "store failure"])("closes the runtime after %s before Host ownership", async failure => {
    const close = vi.fn().mockResolvedValue(undefined);
    const listRepositories = failure === "store failure" ? vi.fn().mockRejectedValue(new Error("Store unavailable")) : vi.fn().mockResolvedValue([]);
    vi.mocked(createCodeIntelligenceRuntime).mockResolvedValue({ store: { listRepositories }, close } as unknown as CodeIntelligenceRuntime);
    const previous = process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE;
    process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE = "capability_preflight_test";
    try {
      await expect(prepareHistoryView("unused-target")).rejects.toThrow(failure === "store failure" ? "Store unavailable" : "Keycloak CPU index must be ready");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE;
      else process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE = previous;
    }
  });
});
