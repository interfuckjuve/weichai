import { appendFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  createRunRecorder,
  stepFailureState,
} from "../src/run-output/record-run.js";
import { redactSecrets } from "../src/run-output/verification-logger.js";
import {
  protectedSecrets,
  redact,
} from "../src/strategies/multi-agent-differential/behavior-command.js";
import { isProjectTestPath } from "../src/strategies/multi-agent-differential/behavior-workspace.js";
import type {
  BehaviorAgentTask,
  BehaviorCommand,
  BehaviorCommandRecord,
  BehaviorRuntime,
} from "../src/strategies/multi-agent-differential/behavior-types.js";

const MAX_EVENTS = 10_000;
const MAX_ITEMS = 1_000;
const MAX_SESSIONS = 32;
const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 256 * 1024;
const caveat =
  "Host spans, sessions, replay and command intervals are inclusive and may overlap. Do not sum them. Tool intervals are approximate Host receipt wall intervals, not model thought time. Missing markers are unknown, not zero. Per-session tool union merges overlapping complete intervals only; residual is session wall time minus that union, is unclassified, and includes missing tools, model, transport and scheduling. Categories are tool-name/path heuristics, not semantic or completeness claims. Command durations come from runtime evidence, not tool intervals; command phases absent from that evidence remain unknown. Preparation records may precede observer creation and are not added to its total. Observation I/O adds Host overhead. A single run is not a performance or business-correctness proof.";

interface ToolInterval {
  sessionId: string;
  toolUseId: string;
  tool: string;
  category: string;
  source: "host-performance";
  kind: "tool-wall-approximate";
  state: "complete" | "missing-start" | "missing-end" | "out-of-order";
  startOffsetMs?: number;
  endOffsetMs?: number;
  durationMs?: number;
}
interface Session {
  id: string;
  side: string;
  role: string;
  state: string;
  startOffsetMs: number;
  endOffsetMs?: number;
  durationMs?: number;
  streamPath: string;
  streamBytes: number;
  streamCompleteness: "partial" | "truncated" | "unavailable";
  toolCoverage: "partial" | "unavailable";
  toolObservedUnionDurationMs?: number;
  unclassifiedDurationMs?: number;
}
interface CommandTiming {
  commandId: string;
  sessionId?: string;
  side: string;
  phase: "setup" | "unknown";
  command: string;
  category: string;
  source: string;
  completed: boolean;
  durationMs?: number;
  exitCode: number | null;
  timedOut: boolean;
}
function commandCategory(command: BehaviorCommand): string {
  const name = basename(command.executable);
  const args = command.args;
  if (
    (/^(mvnw?|gradlew?)$/.test(name) &&
      args.some((arg) =>
        ["test", "verify", "check", "build", "package", "install"].includes(
          arg,
        ),
      )) ||
    (["dotnet", "go", "cargo"].includes(name) && args.includes("test"))
  )
    return "compile-test";
  if (
    ["pytest", "vitest", "jest"].includes(name) ||
    (["python", "python3"].includes(name) &&
      args[0] === "-m" &&
      ["pytest", "unittest"].includes(args[1] ?? ""))
  )
    return "test";
  if (
    ["javac", "tsc", "rustc"].includes(name) ||
    (["mvn", "mvnw", "gradle", "gradlew", "dotnet", "go", "cargo"].includes(
      name,
    ) &&
      args.some((arg) => ["compile", "build", "classes"].includes(arg)))
  )
    return "compile";
  if (
    (["npm", "pnpm"].includes(name) &&
      args.some((arg) => ["ci", "install"].includes(arg))) ||
    (name === "dotnet" && args[0] === "restore")
  )
    return "setup";
  return "unknown";
}

/** E2E-only passive observations; never dispatches or changes verification work. */
export function createE2EObserver(options: {
  root: string;
  strategy: string;
  model: string;
  task: string;
  variant: string;
  secrets?: string[];
}) {
  const started = performance.now();
  const recorder = createRunRecorder({ runId: randomUUID() });
  const secrets = [
    ...new Set([...protectedSecrets(), ...(options.secrets ?? [])]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const secretForms = [
    ...new Set(
      secrets.flatMap((secret) => [
        secret,
        JSON.stringify(secret).slice(1, -1),
      ]),
    ),
  ];
  const clean = (text: string, limit = 1024) =>
    redactSecrets(redact(text, secrets).slice(0, limit)).slice(0, limit);
  const label = (text: string) => clean(text, 256);
  const paths = {
    timingPath: join(options.root, "timing.json"),
    eventsPath: join(options.root, "events.jsonl"),
  };
  const diagnostics = new Set<string>();
  const sessions: Session[] = [];
  const tools = new Map<string, ToolInterval>();
  const commands = new Map<string, CommandTiming>();
  const sides = new Map<string, string>();
  let eventCount = 0;
  let replayCount = 0;
  let preparationCount = 0;
  let finished = false;
  const offset = () => Math.max(0, performance.now() - started);
  function diagnostic(code: string) {
    if (diagnostics.size < 100) diagnostics.add(code);
  }
  function bestEffort(code: string, work: () => void) {
    try {
      work();
    } catch {
      diagnostic(code);
    }
  }
  function event(
    kind: string,
    fields: Record<string, unknown>,
    receivedOffset = offset(),
  ) {
    if (finished) return;
    if (eventCount >= MAX_EVENTS - 1) {
      diagnostic("events-truncated");
      if (eventCount >= MAX_EVENTS) return;
      kind = "diagnostic";
      fields = { code: "events-truncated", limit: MAX_EVENTS };
    }
    const line =
      JSON.stringify({
        ...fields,
        kind,
        source: "host-performance",
        sequence: eventCount++,
        offsetMs: receivedOffset,
      }) + "\n";
    bestEffort("events-write-failed", () =>
      appendFileSync(paths.eventsPath, line, { mode: 0o600 }),
    );
  }
  function retainCommand(key: string, command: CommandTiming) {
    const previous = commands.get(key);
    if (previous?.completed && !command.completed) return;
    if (previous && JSON.stringify(previous) === JSON.stringify(command))
      return;
    if (!previous && commands.size >= MAX_ITEMS) {
      diagnostic("commands-truncated");
      return;
    }
    commands.set(key, command);
    event("command-timing", { ...command, evidenceSource: command.source });
  }
  function evidence(records: BehaviorCommandRecord[], session: Session) {
    for (const record of records) {
      if (!record.commandId || record.commandId.length > 256) {
        diagnostic("invalid-command-id");
        continue;
      }
      const completed = record.completed !== false;
      retainCommand(`evidence:${record.commandId}`, {
        commandId: label(record.commandId),
        sessionId: session.id,
        side: label(record.side ?? session.side),
        phase: "unknown",
        command: label(
          `${record.command.executable} ${record.command.args.join(" ")}`,
        ),
        category: commandCategory(record.command),
        source: "command-evidence",
        completed,
        ...(completed &&
        Number.isFinite(record.durationMs) &&
        record.durationMs >= 0
          ? { durationMs: record.durationMs }
          : {}),
        exitCode: record.exitCode,
        timedOut: record.timedOut,
      });
    }
  }
  function toolCategory(
    name: string,
    input: unknown,
    task: BehaviorAgentTask,
  ): string {
    if (["Read", "Glob", "Grep"].includes(name)) return "exploration";
    if (!["Write", "Edit"].includes(name)) return "other";
    const path =
      input && typeof input === "object" && "file_path" in input
        ? input.file_path
        : undefined;
    if (typeof path !== "string") return "other-write";
    const absolute = resolve(task.sandbox.cwd, path);
    const scopes = [
      task.sandbox,
      ...Object.values(task.additionalProjects ?? {}),
    ];
    const scope = scopes.find((candidate) => {
      const local = relative(candidate.cwd, absolute);
      return (
        local !== ".." && !local.startsWith("../") && !local.startsWith("/")
      );
    });
    if (!scope) return "other-write";
    const local = relative(scope.cwd, absolute);
    if (isProjectTestPath(local)) return "test-authoring";
    return scope.projectAccess === "experiment"
      ? "source-experiment"
      : "other-write";
  }
  function startSession(task: BehaviorAgentTask) {
    if (finished || sessions.length >= MAX_SESSIONS) {
      diagnostic("sessions-truncated");
      return;
    }
    const id = `session-${sessions.length + 1}`;
    const session: Session = {
      id,
      side: label(task.side),
      role: label(task.sessionRole ?? task.side),
      state: "running",
      startOffsetMs: offset(),
      streamPath: `${id}.stream.log`,
      streamBytes: 0,
      streamCompleteness: "partial",
      toolCoverage: "unavailable",
    };
    sessions.push(session);
    sides.set(task.sandbox.cwd, task.side);
    for (const [side, scope] of Object.entries(task.additionalProjects ?? {}))
      sides.set(scope.cwd, side);
    try {
      writeFileSync(join(options.root, session.streamPath), "", {
        mode: 0o600,
      });
    } catch {
      session.streamCompleteness = "unavailable";
      diagnostic("stream-write-failed");
    }
    event("session", { sessionId: id, side: session.side, event: "start" });
    let observed = "";
    let pending = "";
    let logPending = "";
    let pendingReceipt = session.startOffsetMs;
    let stopped = false;
    function saveLog(final: boolean) {
      let cut = final ? logPending.length : logPending.lastIndexOf("\n") + 1;
      // Hold a credential crossing the append boundary, including escaped JSON credentials.
      for (const secret of secretForms) {
        const start = logPending.lastIndexOf(secret, cut - 1);
        if (start >= 0 && start < cut && start + secret.length > cut)
          cut = start;
        if (!logPending.endsWith(secret)) {
          for (
            let length = Math.min(secret.length - 1, logPending.length);
            length > 0;
            length--
          ) {
            if (logPending.endsWith(secret.slice(0, length))) {
              cut = Math.min(cut, logPending.length - length);
              break;
            }
          }
        }
      }
      const omitted = final && cut < logPending.length;
      if (omitted) diagnostic("stream-secret-tail-omitted");
      if (!cut && !omitted) return;
      // Stream payloads can be megabytes; use the runtime's literal credential redactor.
      const payload = Buffer.from(redact(logPending.slice(0, cut), secrets));
      logPending = final ? "" : logPending.slice(cut);
      const remaining = MAX_STREAM_BYTES - session.streamBytes;
      if (payload.length > remaining) {
        session.streamCompleteness = "truncated";
        diagnostic("stream-truncated");
      }
      const bounded = payload.subarray(0, remaining);
      if (bounded.length) {
        try {
          appendFileSync(join(options.root, session.streamPath), bounded, {
            mode: 0o600,
          });
          session.streamBytes += bounded.length;
        } catch {
          session.streamCompleteness = "unavailable";
          diagnostic("stream-write-failed");
        }
      }
    }
    function parseLine(
      text: string,
      receivedOffset: number,
      terminator = "\n",
    ) {
      if (!text.trim()) return;
      if (text.length > MAX_LINE_CHARS) {
        diagnostic("stream-line-truncated");
        diagnostic("stream-payload-omitted");
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        diagnostic("stream-json-invalid");
        diagnostic("stream-payload-omitted");
        return;
      }
      // Sanitize only the observer's parsed copy, never callbacks or arbitrary tool payloads.
      if (
        parsed?.type === "assistant" &&
        Array.isArray(parsed.message?.content)
      ) {
        const content: unknown[] = parsed.message.content;
        const visible = content.filter(
          (item) =>
            !item ||
            typeof item !== "object" ||
            !("type" in item) ||
            (item.type !== "thinking" && item.type !== "redacted_thinking"),
        );
        if (visible.length !== content.length) {
          parsed.message.content = visible;
          diagnostic("stream-reasoning-omitted");
        }
      }
      logPending += JSON.stringify(parsed) + terminator;
      if (
        !parsed ||
        !["assistant", "user"].includes(parsed.type) ||
        !Array.isArray(parsed.message?.content)
      )
        return;
      const content: unknown[] = parsed.message.content;
      if (content.length > MAX_ITEMS) diagnostic("tool-content-truncated");
      for (const item of content.slice(0, MAX_ITEMS)) {
        if (!item || typeof item !== "object" || !("type" in item)) continue;
        const use = item.type === "tool_use";
        const result = item.type === "tool_result";
        const toolId =
          use && "id" in item
            ? item.id
            : result && "tool_use_id" in item
              ? item.tool_use_id
              : undefined;
        if (typeof toolId !== "string" || !toolId || toolId.length > 256)
          continue;
        const key = `${id}:${toolId}`;
        let tool = tools.get(key);
        if (!tool) {
          if (tools.size >= MAX_ITEMS) {
            diagnostic("tools-truncated");
            continue;
          }
          tool = {
            sessionId: id,
            toolUseId: label(toolId),
            tool: "unknown",
            category: "unknown",
            source: "host-performance",
            kind: "tool-wall-approximate",
            state: "missing-start",
          };
          tools.set(key, tool);
        }
        if (use && tool.startOffsetMs === undefined) {
          tool.startOffsetMs = receivedOffset;
          const name =
            "name" in item && typeof item.name === "string"
              ? item.name
              : "unknown";
          tool.tool = label(name);
          tool.category = toolCategory(
            name,
            "input" in item ? item.input : undefined,
            task,
          );
          event(
            "tool-wall-approximate",
            {
              sessionId: id,
              toolUseId: tool.toolUseId,
              tool: tool.tool,
              category: tool.category,
              event: "start",
            },
            receivedOffset,
          );
        } else if (result && tool.endOffsetMs === undefined) {
          tool.endOffsetMs = receivedOffset;
          event(
            "tool-wall-approximate",
            { sessionId: id, toolUseId: tool.toolUseId, event: "end" },
            receivedOffset,
          );
        }
        if (
          tool.startOffsetMs !== undefined &&
          tool.endOffsetMs !== undefined
        ) {
          tool.state =
            tool.endOffsetMs >= tool.startOffsetMs
              ? "complete"
              : "out-of-order";
          if (tool.state === "complete")
            tool.durationMs = tool.endOffsetMs - tool.startOffsetMs;
        } else
          tool.state =
            tool.startOffsetMs === undefined ? "missing-start" : "missing-end";
        session.toolCoverage = "partial";
      }
    }
    return {
      session,
      consume(text: string) {
        if (stopped || !text) return;
        const receivedOffset = offset();
        const bounded = text.slice(0, MAX_STREAM_BYTES);
        if (!bounded.startsWith(observed)) {
          diagnostic("stream-not-cumulative");
          return;
        }
        if (text.length > MAX_STREAM_BYTES) {
          session.streamCompleteness = "truncated";
          diagnostic("stream-truncated");
        }
        const delta = bounded.slice(observed.length);
        observed = bounded;
        pending += delta;
        if (delta) pendingReceipt = receivedOffset;
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          parseLine(pending.slice(0, end), receivedOffset);
          pending = pending.slice(end + 1);
        }
        saveLog(false);
      },
      end(state: string) {
        stopped = true;
        if (pending) parseLine(pending, pendingReceipt, "");
        saveLog(true);
        session.state = state;
        session.endOffsetMs = offset();
        session.durationMs = session.endOffsetMs - session.startOffsetMs;
        const intervals = [...tools.values()]
          .filter((tool) => tool.sessionId === id && tool.state === "complete")
          .sort((a, b) => a.startOffsetMs! - b.startOffsetMs!);
        if (intervals.length) {
          let union = 0;
          let previousEnd = session.startOffsetMs;
          for (const tool of intervals) {
            union += Math.max(
              0,
              tool.endOffsetMs! - Math.max(previousEnd, tool.startOffsetMs!),
            );
            previousEnd = Math.max(previousEnd, tool.endOffsetMs!);
          }
          session.toolObservedUnionDurationMs = union;
          session.unclassifiedDurationMs = Math.max(
            0,
            session.durationMs - union,
          );
        }
        event("session", {
          sessionId: id,
          event: "end",
          state,
          durationMs: session.durationMs,
        });
      },
    };
  }
  bestEffort("events-write-failed", () =>
    writeFileSync(paths.eventsPath, "", { mode: 0o600 }),
  );

  const observer = {
    async measureStep<T>(name: string, work: () => Promise<T>): Promise<T> {
      const safeName = label(name);
      event("stage", { name: safeName, event: "start" });
      try {
        return await recorder.measureStep(
          safeName,
          { scope: "framework" },
          work,
        );
      } finally {
        event("stage", { name: safeName, event: "end" });
      }
    },
    wrapRuntime(runtime: BehaviorRuntime): BehaviorRuntime {
      return {
        async runAgent(task) {
          let observation: ReturnType<typeof startSession>;
          bestEffort("session-observation-failed", () => {
            observation = startSession(task);
          });
          let state = "completed";
          try {
            const result = await observer.measureStep("agent-session", () =>
              runtime.runAgent({
                ...task,
                onOutput(text) {
                  bestEffort("stream-observation-failed", () =>
                    observation?.consume(text),
                  );
                  task.onOutput?.(text);
                },
                onEvidence(records, plan) {
                  bestEffort("command-observation-failed", () => {
                    if (observation) evidence(records, observation.session);
                  });
                  task.onEvidence?.(records, plan);
                },
              }),
            );
            bestEffort("session-result-observation-failed", () => {
              observation?.consume(result.stdout);
              if (observation && result.commandEvidence)
                evidence(result.commandEvidence, observation.session);
            });
            return result;
          } catch (error) {
            state = stepFailureState(error);
            throw error;
          } finally {
            bestEffort("session-finalization-failed", () =>
              observation?.end(state),
            );
          }
        },
        async runCommand(task) {
          const id = `replay-${++replayCount}`;
          const result = await observer.measureStep("host-replay", () =>
            runtime.runCommand(task),
          );
          bestEffort("replay-observation-failed", () =>
            retainCommand(id, {
              commandId: id,
              side: label(sides.get(task.sandbox.cwd) ?? "unknown"),
              phase: "unknown",
              command: label(
                `${task.command.executable} ${task.command.args.join(" ")}`,
              ),
              category: commandCategory(task.command),
              source: "runtime-command-result",
              completed: true,
              ...(Number.isFinite(result.durationMs) && result.durationMs >= 0
                ? { durationMs: result.durationMs }
                : {}),
              exitCode: result.exitCode,
              timedOut: result.timedOut,
            }),
          );
          return result;
        },
      };
    },
    recordPreparation(
      records: Array<{
        side: string;
        command: string;
        durationMs: number;
        exitCode: number | null;
        timedOut: boolean;
      }>,
    ): void {
      bestEffort("preparation-observation-failed", () => {
        for (const record of records) {
          const id = `preparation-${++preparationCount}`;
          retainCommand(id, {
            commandId: id,
            side: label(record.side),
            phase: "setup",
            command: label(record.command),
            category: "setup",
            source: "preparation-record",
            completed: true,
            ...(Number.isFinite(record.durationMs) && record.durationMs >= 0
              ? { durationMs: record.durationMs }
              : {}),
            exitCode: record.exitCode,
            timedOut: record.timedOut,
          });
        }
      });
    },
    skip(name: string, reason: string): void {
      recorder.skipStep(label(name), { scope: "framework" }, label(reason));
      event("stage", {
        name: label(name),
        event: "skipped",
        reason: label(reason),
      });
    },
    async finish(): Promise<{ timingPath: string; eventsPath: string }> {
      if (finished) return paths;
      const run = recorder.finish();
      const hostSpans = run.stages.map((span) => ({
        ...span,
        ...(span.error ? { error: clean(span.error) } : {}),
        source: "host-performance",
      }));
      const timing = {
        schemaVersion: "1.0",
        runId: run.runId,
        strategy: label(options.strategy),
        model: label(options.model),
        task: label(options.task),
        variant: label(options.variant),
        totalDurationMs: run.totalDurationMs,
        totalSource: "host-performance",
        hostSpans,
        sessions,
        agentAvailability: tools.size ? "available" : "unavailable",
        agentTasks: [...tools.values()],
        commands: [...commands.values()],
        limits: {
          events: MAX_EVENTS,
          tools: MAX_ITEMS,
          commands: MAX_ITEMS,
          sessions: MAX_SESSIONS,
          streamBytesPerSession: MAX_STREAM_BYTES,
          parsedLineChars: MAX_LINE_CHARS,
        },
        diagnostics: [
          ...diagnostics,
          ...run.diagnostics.map(({ code }) => code),
        ],
        caveat,
      };
      const text = (value: string) => label(value).replace(/[\r\n|`]/g, "_");
      const duration = (value?: number) =>
        value === undefined ? "unknown" : `${value.toFixed(1)} ms`;
      const markdown = [
        "# E2E Timing",
        "",
        `${text(timing.strategy)}; model=${text(timing.model)}; task=${text(timing.task)}; variant=${text(timing.variant)}`,
        "",
        `Total: ${duration(timing.totalDurationMs)} (host-performance).`,
        "",
        caveat,
        "",
        "## Host Spans",
        "",
        ...hostSpans.map(
          (span) =>
            `- ${text(span.name)} (${span.id}, ${span.state}): ${duration(span.durationMs)}${span.reason ? `; ${text(span.reason)}` : ""}`,
        ),
        "",
        "## Sessions",
        "",
        ...sessions.map(
          (session) =>
            `- ${session.id} (${session.side}, ${session.state}): ${duration(session.durationMs)}; complete-tool union=${duration(session.toolObservedUnionDurationMs)}; unclassified=${duration(session.unclassifiedDurationMs)}; log=${session.streamPath} (${session.streamCompleteness})`,
        ),
        "",
        "## Approximate Tool Intervals",
        "",
        ...(tools.size
          ? [...tools.values()].map(
              (tool) =>
                `- ${tool.sessionId}/${text(tool.toolUseId)} ${text(tool.tool)} (${tool.category}, ${tool.state}): ${duration(tool.durationMs)}`,
            )
          : ["Unknown: no native tool markers observed."]),
        "",
        "## Controlled Commands",
        "",
        ...timing.commands.map(
          (command) =>
            `- ${text(command.commandId)} ${text(command.command)} (${command.side}, ${command.phase}, ${command.category}): ${duration(command.durationMs)} (${command.source})`,
        ),
        "",
        "## Observation Limits",
        "",
        `At most ${MAX_EVENTS} events, ${MAX_ITEMS} tools/commands, ${MAX_SESSIONS} sessions, ${MAX_STREAM_BYTES} stream bytes/session; ${MAX_LINE_CHARS} characters/parsed line. Streams omit assistant reasoning blocks and invalid or oversized JSON lines; they are not complete model transcripts.`,
        ...timing.diagnostics.map((code) => `- ${code}`),
        "",
      ].join("\n");
      bestEffort("timing-markdown-write-failed", () =>
        writeFileSync(join(options.root, "timing.md"), markdown, {
          mode: 0o600,
        }),
      );
      timing.diagnostics = [
        ...diagnostics,
        ...run.diagnostics.map(({ code }) => code),
      ];
      bestEffort("timing-json-write-failed", () =>
        writeFileSync(
          paths.timingPath,
          JSON.stringify(timing, null, 2) + "\n",
          { mode: 0o600 },
        ),
      );
      if (diagnostics.has("timing-json-write-failed"))
        event("diagnostic", { code: "timing-json-write-failed" });
      finished = true;
      return paths;
    },
  };
  return observer;
}
