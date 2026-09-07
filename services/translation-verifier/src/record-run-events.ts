import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { redactSecrets } from "./logger.js";
import { validateRunEventSchema } from "./verification-schemas.js";
import type RunSchema from "./schemas/verification-run.schema.json";
import type { VerificationRun, VerificationRunEvent, VerificationStage, VerificationStageId } from "./verification-types.js";

const require = createRequire(import.meta.url);
const schema: typeof RunSchema = require("./schemas/verification-run.schema.json");
const stageIds = schema.definitions.stageId.enum as VerificationStageId[];
const MAX_EVENTS = 10_000;
const MAX_DIAGNOSTICS = schema.properties.diagnostics.maxItems;
const IDENTIFIER_LIMIT = schema.definitions.identifier.maxLength;
const MESSAGE_LIMIT = schema.definitions.message.maxLength;
const context = new AsyncLocalStorage<RunRecorder>();

export interface RunRecorder {
  readonly runId: string;
  startStage(id: VerificationStageId): void;
  endStage(id: VerificationStageId, state: "completed" | "failed" | "cancelled", error?: unknown): void;
  skipStage(id: VerificationStageId, reason: string): void;
  observe(event: Omit<VerificationRunEvent, "runId" | "sequence" | "receivedAt">): void;
  anomaly(code: string, message: string): void;
  finish(): VerificationRun;
  snapshot(): VerificationRun;
  /** Detached, bounded normalized observations for diagnostic writers and legacy timing readers. */
  events(): VerificationRunEvent[];
}

export function withRunRecorder<T>(recorder: RunRecorder, work: () => Promise<T>): Promise<T> {
  return context.run(recorder, work);
}

export function currentRunRecorder(): RunRecorder | undefined {
  return context.getStore();
}

function safeText(value: string, limit: number): string {
  return redactSecrets(value.slice(0, limit)).slice(0, limit).trim() || "Unavailable";
}

function errorText(error: unknown): string {
  try {
    return safeText(error instanceof Error ? error.message : typeof error === "string" ? error : "Non-Error failure.", MESSAGE_LIMIT);
  } catch {
    return "Error details unavailable.";
  }
}

export function createRunRecorder(options: {
  runId: string;
  now?: () => string;
  monotonicNow?: () => number;
}): RunRecorder {
  if (!options.runId.trim() || options.runId.length > IDENTIFIER_LIMIT) {
    throw new TypeError("Run ID must be a nonempty identifier of at most 256 characters.");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const started = monotonicNow();
  const retained: VerificationRunEvent[] = [];
  const starts = new Map<VerificationStageId, number>();
  let finished = false;
  let truncated = false;
  const run: VerificationRun = {
    schemaVersion: "1.0",
    runId: options.runId,
    startedAt: now(),
    input: { availability: "unavailable", reason: "Input snapshot not recorded." },
    strategy: { selection: "default", applicability: "not-checked" },
    stages: stageIds.map((id) => ({ id, state: "not-started" })) as VerificationRun["stages"],
    agentTimeline: { availability: "unavailable", reason: "Agent observations not persisted.", source: "host-observed", completeness: "unavailable" },
    hostEvents: { availability: "unavailable", reason: "Host observations not persisted.", source: "host-observed", completeness: "unavailable" },
    report: { availability: "unavailable", reason: "Canonical report not recorded." },
    diagnostics: [],
  };

  function anomaly(code: string, message: string): void {
    if (finished) return;
    if (run.diagnostics.length >= MAX_DIAGNOSTICS) {
      run.diagnostics[MAX_DIAGNOSTICS - 1] = { code: "diagnostics-truncated", message: "Further diagnostics were omitted." };
      return;
    }
    run.diagnostics.push({ code: safeText(code, IDENTIFIER_LIMIT), message: safeText(message, MESSAGE_LIMIT) });
  }

  function stageFor(id: VerificationStageId, expected: VerificationStage["state"]): VerificationStage | undefined {
    const index = stageIds.indexOf(id);
    const stage = run.stages[index];
    if (!stage || stage.state !== expected || (expected === "not-started" && run.stages.slice(0, index).some((prior) => prior.state === "not-started" || prior.state === "running"))) {
      anomaly("stage-order", "Stage observation does not match the ordered lifecycle.");
      return undefined;
    }
    return stage;
  }

  return {
    runId: run.runId,
    startStage(id) {
      if (finished) return;
      const stage = stageFor(id, "not-started");
      if (!stage) return;
      starts.set(id, monotonicNow());
      stage.state = "running";
      stage.startedAt = now();
    },
    endStage(id, state, error) {
      if (finished) return;
      const stage = stageFor(id, "running");
      if (!stage) return;
      stage.state = state;
      stage.endedAt = now();
      stage.durationMs = Math.max(0, monotonicNow() - starts.get(id)!);
      starts.delete(id);
      if (error !== undefined) stage.error = errorText(error);
    },
    skipStage(id, reason) {
      if (finished) return;
      const stage = stageFor(id, "not-started");
      if (!stage) return;
      stage.state = "skipped";
      stage.reason = safeText(reason, MESSAGE_LIMIT);
    },
    observe(event) {
      if (finished || truncated) return;
      if (retained.length >= MAX_EVENTS) {
        truncated = true;
        run.agentTimeline.completeness = "truncated";
        run.hostEvents.completeness = "truncated";
        anomaly("events-truncated", "The 10,000 normalized event limit was reached; further observations were omitted.");
        return;
      }
      try {
        // Copy only schema metadata. Never retain raw tool payloads or caller-owned objects.
        const normalized: VerificationRunEvent = {
          kind: safeText(event.kind, IDENTIFIER_LIMIT),
          source: safeText(event.source, IDENTIFIER_LIMIT),
          runId: run.runId,
          sequence: retained.length,
          receivedAt: now(),
          offsetMs: event.offsetMs ?? Math.max(0, monotonicNow() - started),
        };
        for (const key of ["operationId", "parentOperationId", "name", "event", "commandId"] as const) {
          const value = event[key];
          if (value !== undefined) normalized[key] = safeText(value, IDENTIFIER_LIMIT);
        }
        if (event.durationMs !== undefined) normalized.durationMs = event.durationMs;
        if (event.exitCode !== undefined) normalized.exitCode = event.exitCode;
        if (event.timedOut !== undefined) normalized.timedOut = event.timedOut;
        if (!validateRunEventSchema(normalized)) {
          anomaly("invalid-event", "Observation did not match the normalized event schema.");
          return;
        }
        retained.push(normalized);
      } catch {
        anomaly("invalid-event", "Observation metadata could not be read.");
      }
    },
    anomaly,
    finish() {
      if (!finished) {
        for (const stage of run.stages) {
          if (stage.state !== "running") continue;
          stage.state = "failed";
          stage.reason = "Stage ended without a matching end observation.";
          anomaly("stage-missing-end", `Missing end observation for ${stage.id}.`);
        }
        starts.clear();
        run.endedAt = now();
        // Caller chooses the response-preparation boundary; the final record write is excluded.
        run.totalDurationMs = Math.max(0, monotonicNow() - started);
        finished = true;
      }
      return structuredClone(run);
    },
    snapshot: () => structuredClone(run),
    events: () => structuredClone(retained),
  };
}
