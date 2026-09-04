import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("adaptation service config", () => {
  it("loads local workflow defaults and keeps the API key server-side", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: "demo-key" });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8788);
    expect(config.corsOrigin).toBeUndefined();
    expect(config.apiKey).toBe("demo-key");
    expect(config.skeletonProjectPath).toMatch(/commons-fileupload-java-skeleton$/);
    expect(config.projectRoot).toBe(config.skeletonProjectPath);
  });

  it("reads explicit skeleton and backfill roots", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_SKELETON_PROJECT_PATH: "/tmp/skeleton",
      ADAPTATION_PROJECT_ROOT: "/tmp/project",
    });

    expect(config.skeletonProjectPath).toBe("/tmp/skeleton");
    expect(config.projectRoot).toBe("/tmp/project");
  });

  it("keeps the module planning snapshot store server-owned and configurable", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_PROJECT_ROOT: "/tmp/project",
      ADAPTATION_ANALYSIS_ROOT: "/tmp/workspace/.forexplore/analysis",
    });

    expect(config.analysisRoot).toBe("/tmp/workspace/.forexplore/analysis");
  });

  it("enables the revision-scoped semantic planner only with an explicit host query-port configuration", () => {
    expect(loadConfig({ DEEPSEEK_API_KEY: "sk-test" }).semanticQueryPort).toBeUndefined();
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_SEMANTIC_INDEX_ENABLED: "true",
      SEMANTIC_QUERY_PORT_URL: "http://semantic-host.local:8790/api",
      SEMANTIC_QUERY_PORT_TOKEN: " host-issued-token ",
    });

    expect(config.semanticQueryPort).toEqual({
      endpoint: "http://semantic-host.local:8790/api",
      bearerToken: "host-issued-token",
    });
  });

  it("requires a host HTTP endpoint instead of a local semantic storage configuration", () => {
    expect(() => loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_SEMANTIC_INDEX_ENABLED: "true",
    })).toThrow("SEMANTIC_QUERY_PORT_URL is required");

    expect(() => loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_SEMANTIC_INDEX_ENABLED: "true",
      SEMANTIC_QUERY_PORT_URL: "seekdb://localhost:2881",
    })).toThrow("SEMANTIC_QUERY_PORT_URL must be an http(s) URL.");
  });

  it("accepts the merged branch's skeleton variable as a compatibility alias", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_SKELETON_PATH: "/tmp/legacy-skeleton",
    });

    expect(config.skeletonProjectPath).toBe("/tmp/legacy-skeleton");
  });

  it("reads custom host, port, and CORS origin", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_HOST: "0.0.0.0",
      ADAPTATION_PORT: "9090",
      ADAPTATION_CORS_ORIGIN: "https://example.com",
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9090);
    expect(config.corsOrigin).toBe("https://example.com");
  });

  it("fails fast when the DeepSeek key is missing", () => {
    expect(() => loadConfig({})).toThrow("DEEPSEEK_API_KEY is required");
  });

  it("rejects invalid ports", () => {
    for (const port of ["0", "-1", "abc"]) {
      expect(() =>
        loadConfig({ DEEPSEEK_API_KEY: "sk-test", ADAPTATION_PORT: port }),
      ).toThrow("ADAPTATION_PORT must be a positive integer.");
    }
  });

});
