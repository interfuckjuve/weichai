import { describe, expect, it, vi } from "vitest";
import { HttpSemanticQueryPort } from "./http-semantic-query-port";

describe("HttpSemanticQueryPort", () => {
  it("forwards only read-only SemanticQueryPort requests to the host endpoint", async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      repository: { repositoryId: "history-quote" },
    }), { status: 200 }));
    const controller = new AbortController();
    const port = new HttpSemanticQueryPort({
      endpoint: "http://127.0.0.1:8790/host-api",
      bearerToken: "host-token",
      fetch: request as unknown as typeof globalThis.fetch,
    });

    await expect(port.getRepositoryOverview({
      repositoryId: "history-quote",
      analysisRevision: "revision-1",
    }, controller.signal)).resolves.toEqual({
      repository: { repositoryId: "history-quote" },
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "http://127.0.0.1:8790/host-api/v1/semantic-query/getRepositoryOverview",
      }),
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer host-token",
        },
        body: JSON.stringify({
          repositoryId: "history-quote",
          analysisRevision: "revision-1",
        }),
        signal: controller.signal,
      }),
    );
  });

  it("uses the host's bounded error message and rejects non-HTTP endpoints", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "host query denied" },
    }), { status: 403 }));
    const port = new HttpSemanticQueryPort({
      endpoint: "https://semantic.example.test",
      fetch: request as unknown as typeof globalThis.fetch,
    });

    await expect(port.listRepositories()).rejects.toThrow("host query denied");
    expect(() => new HttpSemanticQueryPort({ endpoint: "seekdb://localhost:2881" }))
      .toThrow("SEMANTIC_QUERY_PORT_URL must be an http(s) URL.");
  });
});
