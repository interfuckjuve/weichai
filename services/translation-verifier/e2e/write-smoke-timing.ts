import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VerificationRun, VerificationRunEvent } from "../src/schemas/verification-types.js";
import { redactSecrets } from "../src/run-output/verification-logger.js";

interface TimingIdentifiers { strategy: string; strategyVersion: string; model: string; mode: string; fixture: string }
interface AgentTask {
  operationId: string;
  name: string;
  source: "host-performance";
  kind: "agent-step-approximate";
  state: "complete" | "missing-start" | "missing-end";
  startOffsetMs?: number;
  endOffsetMs?: number;
  durationMs?: number;
}

const caveat = "Agent durations are approximate Host receipt intervals, not model clocks. Host spans and command timings can be inclusive or overlapping. Do not sum these intervals or infer command execution from Agent markers. A single run is not a performance or business-correctness proof.";
const label = (value: string) => redactSecrets(value.slice(0, 256)).replace(/[\r\n|`]/g, "_");

/** E2E helper only: no production run root, raw content, or verdict ownership. */
export function writeSmokeTiming(directory: string, identifiers: TimingIdentifiers, run: VerificationRun, events: VerificationRunEvent[], display = false): string | undefined {
  try {
    const tasks = new Map<string, AgentTask>();
    for (const event of events) {
      if (event.kind !== "agent-step-approximate" || !event.operationId || !event.name) continue;
      let task = tasks.get(event.operationId);
      if (!task) {
        task = { operationId: event.operationId, name: event.name, source: "host-performance", kind: "agent-step-approximate", state: "missing-start" };
        tasks.set(event.operationId, task);
      }
      if (event.event === "start") task.startOffsetMs = event.offsetMs;
      if (event.event === "end") task.endOffsetMs = event.offsetMs;
      if (task.startOffsetMs !== undefined && task.endOffsetMs !== undefined) {
        task.state = "complete";
        task.durationMs = Math.max(0, task.endOffsetMs - task.startOffsetMs);
      } else task.state = task.startOffsetMs === undefined ? "missing-start" : "missing-end";
    }
    const agentTasks = [...tasks.values()];
    const hostSpans = run.stages.map(({ id, name, scope, parentId, state, durationMs }) => ({ id, name, scope, parentId, state, durationMs, source: "host-performance" }));
    const commands = events.filter((event) => event.kind === "command" || event.kind === "command-timing")
      .map(({ kind, source, commandId, name, durationMs, exitCode, timedOut }) => ({ kind, source, commandId, name, durationMs, exitCode, timedOut }));
    const timing = {
      schemaVersion: "1.0", runId: run.runId,
      strategy: label(identifiers.strategy), strategyVersion: label(identifiers.strategyVersion),
      model: label(identifiers.model), mode: label(identifiers.mode), fixture: label(identifiers.fixture),
      totalDurationMs: run.totalDurationMs, totalSource: "host-performance",
      hostSpans, agentAvailability: agentTasks.length ? "available" : "unavailable", agentTasks, commands,
      diagnostics: run.diagnostics.map(({ code }) => code), caveat,
    };
    const duration = (value: number | undefined) => value === undefined ? "unavailable" : `${value.toFixed(1)} ms`;
    const markdown = [
      "# Smoke E2E Timing", "", `${timing.strategy}@${timing.strategyVersion}; model=${timing.model}; mode=${timing.mode}; fixture=${timing.fixture}`,
      "", `Total: ${duration(timing.totalDurationMs)} (host-performance).`, "", caveat,
      "", "## Host Spans", "", ...hostSpans.map((span) => `- ${label(span.name)} (${span.id}, ${span.state}): ${duration(span.durationMs)}`),
      "", "## Approximate Agent Tasks", "", ...(agentTasks.length ? agentTasks.map((task) => `- ${label(task.name)} (${task.operationId}, ${task.state}): ${duration(task.durationMs)}`) : ["Unavailable: no live task markers observed."]),
      "", "## Controlled Commands", "", ...(commands.length ? commands.map((command) => `- ${label(command.commandId ?? "unknown")}: ${label(command.name ?? "unknown")} = ${duration(command.durationMs)} (${command.source})`) : ["Unavailable: no command timing metadata retained."]),
      "", "## Observation Limits", "", ...(timing.diagnostics.length ? timing.diagnostics.map((code) => `- ${label(code)}`) : ["No observation omissions reported."]), "",
    ].join("\n");
    writeFileSync(join(directory, "timing.json"), JSON.stringify(timing, null, 2) + "\n", "utf8");
    writeFileSync(join(directory, "timing.md"), markdown, "utf8");
    if (display) {
      console.log(`Approximate Agent tasks: ${agentTasks.length ? agentTasks.map((task) => `${label(task.name)} (${task.state}): ${duration(task.durationMs)}`).join("; ") : "unavailable"}`);
    }
    return directory;
  } catch { return undefined; }
}
