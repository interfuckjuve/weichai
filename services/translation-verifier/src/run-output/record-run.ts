import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { redactSecrets } from "./verification-logger.js";
import { validateRunEventSchema } from "../schemas/compile-schema-validators.js";
import type RunSchema from "../schemas/verification-run.schema.json";
import type {
  VerificationRun,
  VerificationRunEvent,
  VerificationStage,
} from "../schemas/verification-types.js";

const require = createRequire(import.meta.url);
const schema: typeof RunSchema = require("../schemas/verification-run.schema.json");
const MAX_STEPS = schema.properties.stages.maxItems;
const MAX_EVENTS = 10_000;
const MAX_DIAGNOSTICS = schema.properties.diagnostics.maxItems;
const IDENTIFIER_LIMIT = schema.definitions.identifier.maxLength;
const MESSAGE_LIMIT = schema.definitions.message.maxLength;
const context = new AsyncLocalStorage<RunRecorder>();
const stepContext = new AsyncLocalStorage<{
  recorder: RunRecorder;
  handle: StepHandle;
}>();

/** Identity is checked by the owning recorder, not by the caller-visible ID. */
export interface StepHandle {
  readonly id: string;
}
export interface StepOptions {
  scope: VerificationStage["scope"];
  parentId?: string;
}

export interface RunRecorder {
  readonly runId: string;
  startStep(name: string, options: StepOptions): StepHandle | undefined;
  endStep(
    handle: StepHandle | undefined,
    state: "completed" | "failed" | "cancelled",
    error?: unknown,
  ): void;
  skipStep(name: string, options: StepOptions, reason: string): void;
  measureStep<T>(
    name: string,
    options: StepOptions,
    work: () => T | Promise<T>,
  ): Promise<T>;
  observe(
    event: Omit<VerificationRunEvent, "runId" | "sequence" | "receivedAt">,
  ): void;
  anomaly(code: string, message: string): void;
  finish(): VerificationRun;
  snapshot(): VerificationRun;
  /** Detached, bounded normalized observations for diagnostic writers and legacy timing readers. */
  events(): VerificationRunEvent[];
}

export function withRunRecorder<T>(
  recorder: RunRecorder,
  work: () => Promise<T>,
): Promise<T> {
  return context.run(recorder, work);
}

export function withStepContext<T>(
  recorder: RunRecorder,
  handle: StepHandle | undefined,
  work: () => T,
): T {
  return handle ? stepContext.run({ recorder, handle }, work) : work();
}

export function currentRunRecorder(): RunRecorder | undefined {
  return context.getStore();
}

/** Optional instrumentation for standalone strategy callers; never dispatches work. */
export async function measureStep<T>(
  name: string,
  work: () => T | Promise<T>,
): Promise<T> {
  const recorder = currentRunRecorder();
  return recorder
    ? recorder.measureStep(name, { scope: "strategy" }, work)
    : work();
}

export function stepFailureState(error: unknown): "cancelled" | "failed" {
  try {
    return typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
      ? "cancelled"
      : "failed";
  } catch {
    return "failed";
  }
}

function safeText(value: string, limit: number): string {
  return (
    redactSecrets(value.slice(0, limit)).slice(0, limit).trim() || "Unavailable"
  );
}

function errorText(error: unknown): string {
  try {
    return safeText(
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Non-Error failure.",
      MESSAGE_LIMIT,
    );
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
    throw new TypeError(
      "Run ID must be a nonempty identifier of at most 256 characters.",
    );
  }
  const now = options.now ?? (() => new Date().toISOString());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const started = monotonicNow();
  const retained: VerificationRunEvent[] = [];
  const starts = new Map<
    StepHandle,
    { stage: VerificationStage; at: number }
  >();
  const stagesById = new Map<string, VerificationStage>();
  let stepsTruncated = false;
  let finished = false;
  let truncated = false;
  const run: VerificationRun = {
    schemaVersion: "1.0",
    runId: options.runId,
    startedAt: now(),
    input: {
      availability: "unavailable",
      reason: "Input snapshot not recorded.",
    },
    strategy: { selection: "default", applicability: "not-checked" },
    stages: [],
    agentTimeline: {
      availability: "unavailable",
      reason: "Agent observations not persisted.",
      source: "host-observed",
      completeness: "unavailable",
    },
    hostEvents: {
      availability: "unavailable",
      reason: "Host observations not persisted.",
      source: "host-observed",
      completeness: "unavailable",
    },
    report: {
      availability: "unavailable",
      reason: "Canonical report not recorded.",
    },
    diagnostics: [],
  };

  function anomaly(code: string, message: string): void {
    if (finished) return;
    if (run.diagnostics.length >= MAX_DIAGNOSTICS) {
      run.diagnostics[MAX_DIAGNOSTICS - 1] = {
        code: "diagnostics-truncated",
        message: "Further diagnostics were omitted.",
      };
      return;
    }
    run.diagnostics.push({
      code: safeText(code, IDENTIFIER_LIMIT),
      message: safeText(message, MESSAGE_LIMIT),
    });
  }

  function newStep(
    name: string,
    options: StepOptions,
    state: "running" | "skipped",
  ): VerificationStage | undefined {
    if (finished) return;
    if (run.stages.length >= MAX_STEPS) {
      if (!stepsTruncated)
        anomaly(
          "steps-truncated",
          `The ${MAX_STEPS} step limit was reached; further steps were omitted.`,
        );
      stepsTruncated = true;
      return;
    }
    try {
      const active = stepContext.getStore();
      const parentId =
        options.parentId ??
        (active?.recorder === recorder ? active.handle.id : undefined);
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > IDENTIFIER_LIMIT ||
        !["framework", "strategy"].includes(options.scope) ||
        (parentId !== undefined && !stagesById.has(parentId))
      ) {
        anomaly("invalid-step", "Step name, scope or parent was invalid.");
        return;
      }
      const stage: VerificationStage = {
        id: `step-${run.stages.length + 1}`,
        name: safeText(name, IDENTIFIER_LIMIT),
        scope: options.scope,
        state,
        ...(parentId === undefined ? {} : { parentId }),
      };
      run.stages.push(stage);
      stagesById.set(stage.id, stage);
      return stage;
    } catch {
      anomaly("invalid-step", "Step metadata could not be read.");
      return;
    }
  }

  const recorder: RunRecorder = {
    runId: run.runId,
    startStep(name, options) {
      const stage = newStep(name, options, "running");
      if (!stage) return;
      const handle = Object.freeze({ id: stage.id });
      starts.set(handle, { stage, at: monotonicNow() });
      stage.startedAt = now();
      return handle;
    },
    endStep(handle, state, error) {
      if (finished || handle === undefined) return;
      const entry = starts.get(handle);
      if (!entry || !["completed", "failed", "cancelled"].includes(state)) {
        anomaly(
          "step-lifecycle",
          "End observation did not match an active occurrence handle.",
        );
        return;
      }
      const { stage, at } = entry;
      stage.state = state;
      stage.endedAt = now();
      stage.durationMs = Math.max(0, monotonicNow() - at);
      starts.delete(handle);
      if (error !== undefined) stage.error = errorText(error);
    },
    skipStep(name, options, reason) {
      const stage = newStep(name, options, "skipped");
      if (stage) stage.reason = safeText(reason, MESSAGE_LIMIT);
    },
    async measureStep(name, options, work) {
      const handle = recorder.startStep(name, options);
      const runWork = async () => {
        try {
          const value = await work();
          recorder.endStep(handle, "completed");
          return value;
        } catch (error) {
          recorder.endStep(handle, stepFailureState(error), error);
          throw error;
        }
      };
      return withStepContext(recorder, handle, runWork);
    },
    observe(event) {
      if (finished || truncated) return;
      if (retained.length >= MAX_EVENTS) {
        truncated = true;
        run.agentTimeline.completeness = "truncated";
        run.hostEvents.completeness = "truncated";
        anomaly(
          "events-truncated",
          "The 10,000 normalized event limit was reached; further observations were omitted.",
        );
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
        };
        const offsetMs = event.offsetMs;
        if (offsetMs !== undefined) normalized.offsetMs = offsetMs;
        else if (normalized.source === "host-performance") {
          normalized.offsetMs = Math.max(0, monotonicNow() - started);
        }
        for (const key of [
          "operationId",
          "parentOperationId",
          "name",
          "event",
          "commandId",
        ] as const) {
          const value = event[key];
          if (value !== undefined)
            normalized[key] = safeText(value, IDENTIFIER_LIMIT);
        }
        if (event.durationMs !== undefined)
          normalized.durationMs = event.durationMs;
        if (event.exitCode !== undefined) normalized.exitCode = event.exitCode;
        if (event.timedOut !== undefined) normalized.timedOut = event.timedOut;
        if (!validateRunEventSchema(normalized)) {
          anomaly(
            "invalid-event",
            "Observation did not match the normalized event schema.",
          );
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
          anomaly(
            "stage-missing-end",
            `Missing end observation for ${stage.id}.`,
          );
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
  return recorder;
}
