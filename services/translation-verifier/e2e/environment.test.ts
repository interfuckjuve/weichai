import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../environment.ps1", import.meta.url));
const names = ["CODE_INTELLIGENCE_SEEKDB_DATABASE", "CODE_INTELLIGENCE_EMBEDDING_VARIANT", "FOREXPLORE_EMBEDDING_DEVICE", "FOREXPLORE_EMBEDDING_DTYPE", "DEEPSEEK_MODEL", "ADAPTATION_CODEX_MODEL"];
let runtime: string;

beforeEach(async () => {
  runtime = await mkdtemp(join(tmpdir(), "verifier-environment-"));
  for (const path of ["apache-maven-3.9.11/bin", "gradle-8.14.3/bin", "python/Scripts", "node/node_modules/.bin", "go/bin", "cargo/bin"]) {
    await mkdir(join(runtime, path), { recursive: true });
  }
});

afterEach(async () => { await rm(runtime, { recursive: true, force: true }); });

function load(values: string[], liveModel = false) {
  const env = { ...process.env };
  names.forEach((name, index) => { env[name] = values[index]; });
  const command = `$ErrorActionPreference = 'Stop'; . '${script.replaceAll("'", "''")}' -RuntimeRoot '${runtime.replaceAll("'", "''")}'${liveModel ? " -LiveModel" : ""}; @{ database=$env:CODE_INTELLIGENCE_SEEKDB_DATABASE; variant=$env:CODE_INTELLIGENCE_EMBEDDING_VARIANT; device=$env:FOREXPLORE_EMBEDDING_DEVICE; dtype=$env:FOREXPLORE_EMBEDDING_DTYPE${liveModel ? "; model=$env:DEEPSEEK_MODEL; codexModel=$env:ADAPTATION_CODEX_MODEL" : ""} } | ConvertTo-Json -Compress`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
}

describe.skipIf(process.platform !== "win32")("Windows runtime environment", () => {
  it("selects the tested live model for both chat and Codex", () => {
    expect(load([], true)).toMatchObject({ model: "deepseek-flash", codexModel: "deepseek-flash" });
  }, 30_000);

  it("preserves explicitly configured live models", () => {
    expect(load(["", "", "", "", "custom-chat", "custom-codex"], true)).toMatchObject({ model: "custom-chat", codexModel: "custom-codex" });
  }, 30_000);

  it.each(["dml", "directml"])("migrates the old %s configuration as a complete CPU configuration", device => {
    expect(load(["forexplore_asset_verifier_20261022", "dml-fp16", device, "fp16"])).toEqual({
      database: "forexplore_asset_verifier_cpu_20261023", variant: "cpu-q8", device: "cpu", dtype: "q8",
    });
  }, 30_000);

  it("preserves a separate custom configuration", () => {
    expect(load(["custom_database", "cuda-fp32", "cuda", "fp32"])).toEqual({
      database: "custom_database", variant: "cuda-fp32", device: "cuda", dtype: "fp32",
    });
  }, 30_000);

  it("rejects inference that conflicts with the CPU database identity", () => {
    expect(() => load(["forexplore_asset_verifier_cpu_20261023", "cpu-q8", "cuda", "fp32"])).toThrow("The CPU database and cpu-q8 variant require");
  }, 30_000);
});
