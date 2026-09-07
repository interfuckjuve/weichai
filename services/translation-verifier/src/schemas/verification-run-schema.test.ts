import { describe, expect, expectTypeOf, it } from "vitest";
import type { ValidateFunction } from "ajv";
import { validateRunSchema, validateRunEventSchema } from "./compile-schema-validators.js";
import { assertVerificationRun } from "./validate-verification-run.js";
import { type VerificationRun, type VerificationRunEvent, type VerificationStage, type VerificationStageId, type AgentTaskName } from "./verification-types.js";

const ids = ["custom-1", "custom-2", "custom-3"] as const satisfies readonly VerificationStageId[];
const timestamp = "2026-09-07T00:00:00.000Z";

function run(): VerificationRun {
  return {
    schemaVersion: "1.0",
    runId: "run-1",
    startedAt: timestamp,
    endedAt: timestamp,
    totalDurationMs: 0,
    input: { availability: "available", path: "input.json" },
    strategy: {
      requestedId: "fixture",
      selected: { id: "fixture", version: "1", displayName: "Fixture" },
      selection: "explicit",
      applicability: "supported",
    },
    stages: ids.map((id) => ({
      id,
      name: "repeat-custom",
      scope: "strategy",
      state: "completed",
      durationMs: 0,
    })) as VerificationRun["stages"],
    agentTimeline: {
      availability: "available",
      path: "test/agent-steps.jsonl",
      source: "agent-marker",
      completeness: "complete",
    },
    hostEvents: {
      availability: "available",
      path: "test/host-events.jsonl",
      source: "host",
      completeness: "complete",
    },
    report: { availability: "available", path: "report.json" },
    diagnostics: [],
  };
}

function event(operationId = "task-1"): VerificationRunEvent {
  const name: AgentTaskName = "verify";
  return {
    kind: "agent-task",
    source: "agent-marker",
    runId: "run-1",
    sequence: 0,
    receivedAt: timestamp,
    operationId,
    name,
    event: "start",
  };
}

describe("verification run schema", () => {
  it("accepts variable strategy steps and arbitrary Agent task names", () => {
    const value = run();
    value.stages = [{ id: "step-1", name: "custom-comparison", scope: "strategy", state: "completed", durationMs: 1 }];
    expect(validateRunSchema(value)).toBe(true);
    value.stages = [];
    expect(validateRunSchema(value)).toBe(true);
    expect(validateRunEventSchema({ ...event(), name: "custom-agent-task" })).toBe(true);
  });

  it("exports typed validators and accepts variable completed steps with zero measured duration", () => {
    const validator: ValidateFunction<VerificationRun> = validateRunSchema;
    expect(validator).toBe(validateRunSchema);
    expectTypeOf(validateRunEventSchema).toEqualTypeOf<
      ValidateFunction<VerificationRunEvent>
    >();
    expect(validateRunSchema(run())).toBe(true);
    expect(assertVerificationRun(run())).toEqual(run());
  });

  it("allows unmeasured stages and absent canonical results on early failure", () => {
    const value = run();
    value.input = { availability: "unavailable", reason: "Invalid input" };
    value.report = {
      availability: "unavailable",
      reason: "Input validation threw",
    };
    value.stages = ids.map((id, index): VerificationStage =>
      index === 0
        ? { id, name: "input", scope: "framework", state: "failed", error: "Invalid input" }
        : { id, name: "custom", scope: "strategy", state: "skipped", reason: "Input validation failed" },
    ) as VerificationRun["stages"];
    delete value.totalDurationMs;
    expect(validateRunSchema(value)).toBe(true);
    expect(value.stages[0]).not.toHaveProperty("durationMs");
    expect(value.report).not.toHaveProperty("path");
  });

  it.each([
    [
      "negative stage duration",
      (v: VerificationRun) => {
        v.stages[0].durationMs = -1;
      },
    ],
    [
      "negative total duration",
      (v: VerificationRun) => {
        v.totalDurationMs = -1;
      },
    ],
    [
      "invalid lifecycle state",
      (v: VerificationRun) => {
        v.stages[0].state = "pass" as never;
      },
    ],
    [
      "malformed occurrence ID",
      (v: VerificationRun) => {
        v.stages[0].id = "space in id";
      },
    ],
    [
      "missing step scope",
      (v: VerificationRun) => {
        delete (v.stages[0] as Partial<VerificationStage>).scope;
      },
    ],
    [
      "unbounded step list",
      (v: VerificationRun) => {
        v.stages = Array.from({ length: 1025 }, () => ({ ...v.stages[0] }));
      },
    ],
    [
      "raw step payload",
      (v: VerificationRun) => {
        Object.assign(v.stages[0], { raw: "private" });
      },
    ],
    [
      "missing absence reason",
      (v: VerificationRun) => {
        v.report = { availability: "unavailable" } as never;
      },
    ],
    [
      "path for absent file",
      (v: VerificationRun) => {
        v.report = {
          availability: "omitted",
          reason: "Budget",
          path: "report.json",
        } as never;
      },
    ],
    [
      "missing available path",
      (v: VerificationRun) => {
        v.input = { availability: "available" } as never;
      },
    ],
    [
      "arbitrary payload",
      (v: VerificationRun) => {
        Object.assign(v, { payload: { secret: true } });
      },
    ],
  ])("rejects %s without modifying the value", (_name, mutate) => {
    const value = run();
    mutate(value);
    const before = structuredClone(value);
    expect(validateRunSchema(value)).toBe(false);
    expect(value).toEqual(before);
  });

  it.each([
    "../escape.json",
    "/tmp/report.json",
    "a/../report.json",
    "C:\\report.json",
    "test\\report.json",
  ])("leaves unsafe relative path %s to Host semantic validation", (path) => {
    const value = run();
    value.report = { availability: "available", path };
    expect(validateRunSchema(value)).toBe(true);
    expect(() => assertVerificationRun(value)).toThrow(/safe.*relative/i);
  });

  it("validates stage and timeline references through the same Host boundary", () => {
    const value = run();
    value.stages[0].artifacts = [
      { availability: "available", path: "../stage.json" },
    ];
    expect(() => assertVerificationRun(value)).toThrow(/safe.*relative/i);
    delete value.stages[0].artifacts;
    value.hostEvents = {
      ...value.hostEvents,
      availability: "available",
      path: "../events.jsonl",
    };
    expect(() => assertVerificationRun(value)).toThrow(/safe.*relative/i);
  });

  it("reuses local public input and output schema definitions", () => {
    expect(validateRunSchema.schema).toHaveProperty(
      "definitions.inputSnapshot.$ref",
      "verification-input.schema.json",
    );
    expect(validateRunSchema.schema).toHaveProperty(
      "definitions.resultSnapshot.$ref",
      "verification-output.schema.json",
    );
  });
});

describe("verification run event schema", () => {
  it("allows repeated task names with separate occurrence IDs and missing duration", () => {
    const events = [event("task-1"), { ...event("task-2"), sequence: 1 }];
    expect(events.every((value) => validateRunEventSchema(value))).toBe(true);
    expect(events[0]).not.toHaveProperty("durationMs");
  });

  it("accepts Host-observed tool names without treating them as Agent tasks", () => {
    expect(
      validateRunEventSchema({
        ...event(),
        kind: "tool",
        source: "agent-stream",
        name: "Bash",
        event: "request",
      }),
    ).toBe(true);
  });

  it("accepts actual zero command duration and bounded command metadata", () => {
    expect(
      validateRunEventSchema({
        ...event(),
        kind: "command",
        source: "command-proxy",
        durationMs: 0,
        exitCode: 0,
        timedOut: false,
        commandId: "command-1",
        parentOperationId: "session-1",
        offsetMs: 0,
      }),
    ).toBe(true);
  });

  it.each([
    { durationMs: -1 },
    { offsetMs: -1 },
    { sequence: -1 },
    { sequence: 0.5 },
    { name: "x".repeat(257) },
    { name: " " },
    { payload: { raw: "secret" } },
    { timedOut: "false" },
    { source: "x".repeat(257) },
  ])("rejects invalid or unrestricted event fields %j", (overrides) => {
    const value = { ...event(), ...overrides };
    const before = structuredClone(value);
    expect(validateRunEventSchema(value)).toBe(false);
    expect(value).toEqual(before);
  });
});
