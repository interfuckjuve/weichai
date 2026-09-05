import type { SemanticQueryPort } from "@forexplore/workflow-core";

export interface HttpSemanticQueryPortOptions {
  /** Host-owned SemanticQueryPort HTTP endpoint, without a trailing slash. */
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  /** Optional bearer credential issued by the local VS Code host. */
  bearerToken?: string;
}

interface ErrorPayload {
  error?: { message?: unknown };
}

/**
 * Transport-only adapter used by the standalone MCP executable. It owns no
 * grammar, LSP session, filesystem handle, registry, or SeekDB connection;
 * the host process remains the sole owner of the actual SemanticQueryPort.
 */
export class HttpSemanticQueryPort implements SemanticQueryPort {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #bearerToken?: string;

  constructor(options: HttpSemanticQueryPortOptions) {
    const endpoint = options.endpoint.trim();
    if (!/^https?:\/\//i.test(endpoint)) {
      throw new Error("SEMANTIC_QUERY_PORT_URL must be an http(s) URL.");
    }
    this.#endpoint = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#bearerToken = options.bearerToken?.trim() || undefined;
  }

  async listRepositories(...[request, signal]: Parameters<SemanticQueryPort["listRepositories"]>) {
    return this.#invoke("listRepositories", request, signal);
  }

  async getRepositoryOverview(...[request, signal]: Parameters<SemanticQueryPort["getRepositoryOverview"]>) {
    return this.#invoke("getRepositoryOverview", request, signal);
  }

  async listProjects(...[request, signal]: Parameters<SemanticQueryPort["listProjects"]>) {
    return this.#invoke("listProjects", request, signal);
  }

  async getFileStructure(...[request, signal]: Parameters<SemanticQueryPort["getFileStructure"]>) {
    return this.#invoke("getFileStructure", request, signal);
  }

  async searchSymbols(...[request, signal]: Parameters<SemanticQueryPort["searchSymbols"]>) {
    return this.#invoke("searchSymbols", request, signal);
  }

  async getSymbol(...[request, signal]: Parameters<SemanticQueryPort["getSymbol"]>) {
    return this.#invoke("getSymbol", request, signal);
  }

  async findDefinition(...[request, signal]: Parameters<SemanticQueryPort["findDefinition"]>) {
    return this.#invoke("findDefinition", request, signal);
  }

  async findReferences(...[request, signal]: Parameters<SemanticQueryPort["findReferences"]>) {
    return this.#invoke("findReferences", request, signal);
  }

  async getDependencies(...[request, signal]: Parameters<SemanticQueryPort["getDependencies"]>) {
    return this.#invoke("getDependencies", request, signal);
  }

  async getDiagnostics(...[request, signal]: Parameters<SemanticQueryPort["getDiagnostics"]>) {
    return this.#invoke("getDiagnostics", request, signal);
  }

  async readSourceExcerpt(...[request, signal]: Parameters<SemanticQueryPort["readSourceExcerpt"]>) {
    return this.#invoke("readSourceExcerpt", request, signal);
  }

  async #invoke<K extends keyof SemanticQueryPort>(
    operation: K,
    request: Parameters<SemanticQueryPort[K]>[0],
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<SemanticQueryPort[K]>>> {
    const response = await this.#fetch(new URL(`v1/semantic-query/${operation}`, this.#endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#bearerToken ? { authorization: `Bearer ${this.#bearerToken}` } : {}),
      },
      body: JSON.stringify(request ?? {}),
      signal,
    });
    if (!response.ok) {
      let detail: ErrorPayload | undefined;
      try {
        detail = await response.json() as ErrorPayload;
      } catch {
        // Remote errors are intentionally not reflected verbatim into MCP.
      }
      const message = typeof detail?.error?.message === "string"
        ? detail.error.message
        : `SemanticQueryPort HTTP request failed with status ${response.status}.`;
      throw new Error(message.slice(0, 512));
    }
    return await response.json() as Awaited<ReturnType<SemanticQueryPort[K]>>;
  }
}
