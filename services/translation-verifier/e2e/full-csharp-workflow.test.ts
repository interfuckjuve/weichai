import { describe, expect, it } from "vitest";
import { csharpTargets, decodeCsharpFiles, planCsharpModules } from "./full-csharp-workflow.js";

const path = "src/AssetUpgradeGateway/Application/Example.cs";

describe("complete C# project boundaries", () => {
  it("refuses incomplete source manifests", () => {
    expect(() => planCsharpModules([path])).toThrow("all 27 files");
  });

  it("preserves declared namespaces and rejects escaped writes, placeholders and credentials", () => {
    const source = { path, content: "namespace Example.Application; public class Service {}" };
    expect(decodeCsharpFiles(JSON.stringify({ files: [source] }), [source], "credential")).toEqual([{ ...source, content: source.content + "\n" }]);
    for (const file of [
      { ...source, path: "AssetUpgradeGateway.csproj" },
      { ...source, content: source.content.replace("Example.Application", "Another") },
      { ...source, content: source.content + ' class Unfinished { void Run() { throw new global::System.NotImplementedException(); } }' },
      { ...source, content: source.content + ' class Secret { string Key = "credential"; }' },
    ]) expect(() => decodeCsharpFiles(JSON.stringify({ files: [file] }), [source], "credential")).toThrow();
  });

  it("uses exact declaring types, explicit constructors, generic methods and property bodies", () => {
    const content = [
      "namespace Example.Application;",
      "public class First<T> {",
      " public First() { }",
      " public async Task<U> ExecuteAsync<U>(U value) { await Task.Yield(); return value; }",
      " public int Count => 1;",
      " public string Label { get; set; }",
      "}",
      "public class Second {",
      " public (int Count, bool Ok) Find(string tenant) { return (1, true); }",
      "}",
    ].join("\n");
    const base = { parameters: "", constructor: false, property: false, abstractMethod: false, generic: false, identity: "unused" };
    const targets = csharpTargets({ members: [
      { ...base, owner: "Example.Application.First`1", name: "First", constructor: true, generic: true },
      { ...base, owner: "Example.Application.First`1", name: "ExecuteAsync", parameters: "U", generic: true },
      { ...base, owner: "Example.Application.First`1", name: "Count", property: true },
      { ...base, owner: "Example.Application.First`1", name: "Label", property: true },
      { ...base, owner: "Example.Application.First`1", name: "ToString" },
      { ...base, owner: "Example.Application.Second", name: "Find", parameters: "System.String" },
    ] }, [{ path, content }]);
    expect(targets.map(target => [target.name, target.signature])).toEqual([
      [".ctor", "Example.Application.First`1..ctor()"],
      ["ExecuteAsync", "Example.Application.First`1.ExecuteAsync(U)"],
      ["Count", "Example.Application.First`1.Count"],
      ["Find", "Example.Application.Second.Find(System.String)"],
    ]);
  });

  it("keeps abstract interface declarations and generated record members outside executable targets", () => {
    const base = { owner: "Example.Contract", parameters: "", constructor: false, property: false, abstractMethod: true, generic: false, identity: "unused" };
    expect(csharpTargets({ members: [{ ...base, name: "Execute" }, { ...base, name: "Contract", abstractMethod: false, constructor: true }] }, [
      { path, content: "namespace Example; public interface Contract { void Execute(); }" },
    ])).toEqual([]);
  });

  it("includes explicit chained constructors while excluding generated record constructors", () => {
    const content = [
      "namespace Example;",
      "public record EventEnvelope(string Id, string Payload, string Tenant) {",
      " public EventEnvelope(string id, string payload) : this(id, payload, \"default\")",
      " { if (id.Length == 0) throw new ArgumentException(); }",
      "}",
    ].join("\n");
    const base = { owner: "Example.EventEnvelope", name: "EventEnvelope", constructor: true, property: false, abstractMethod: false, generic: false, identity: "unused" };
    expect(csharpTargets({ members: [
      { ...base, parameters: "System.String,System.String,System.String" },
      { ...base, parameters: "System.String,System.String" },
    ] }, [{ path, content }])).toEqual([{ path, name: ".ctor", signature: "Example.EventEnvelope..ctor(System.String,System.String)" }]);
  });

  it("does not borrow an explicit property body from another declaring type", () => {
    const base = { parameters: "", constructor: false, property: true, abstractMethod: false, generic: false, identity: "unused", name: "Name" };
    const content = [
      "namespace Example;",
      "public record TraceSpan(string Name);",
      "public class MetricsHealthProbe {",
      " public string Name => \"metrics\";",
      "}",
      "public class CustomProperty {",
      " public string Name { get { return \"custom\"; } }",
      "}",
    ].join("\n");
    expect(csharpTargets({ members: [
      { ...base, owner: "Example.TraceSpan" },
      { ...base, owner: "Example.MetricsHealthProbe" },
      { ...base, owner: "Example.CustomProperty" },
    ] }, [{ path, content }]).map(target => target.signature)).toEqual(["Example.MetricsHealthProbe.Name", "Example.CustomProperty.Name"]);
  });

  it("keeps overloaded methods in generic declaring types as distinct targets", () => {
    const content = "namespace Example; public class Service<T> { public int Run(int value) { return value; } public int Run(string value) { return value.Length; } }";
    const base = { owner: "Example.Service`1", name: "Run", constructor: false, property: false, abstractMethod: false, generic: true, identity: "unused" };
    expect(csharpTargets({ members: [{ ...base, parameters: "System.Int32" }, { ...base, parameters: "System.String" }] }, [{ path, content }]).map(target => target.signature)).toEqual([
      "Example.Service`1.Run(System.Int32)", "Example.Service`1.Run(System.String)",
    ]);
  });
});
