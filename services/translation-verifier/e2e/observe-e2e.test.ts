import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import type {
  BehaviorAgentTask,
  BehaviorCommandRecord,
  BehaviorRuntime,
} from "../src/strategies/multi-agent-differential/behavior-types.js";
import { createE2EObserver } from "./observe-e2e.js";

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tv-observe-e2e-"));
  directories.push(root);
  return {
    root,
    strategy: "white-box",
    model: "fake",
    task: "upload",
    variant: "correct",
  };
}
afterEach(() => {
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("retains monotonic nested stage timings and skipped reasons after the original failure", async () => {
  const options = fixture();
  const observer = createE2EObserver(options);
  const failure = new Error("original failure");
  const value = {};
  expect(await observer.measureStep("prepare", async () => value)).toBe(value);
  await expect(
    observer.measureStep("verify", async () => {
      await observer.measureStep("inner", async () => {
        await delay(5);
      });
      throw failure;
    }),
  ).rejects.toBe(failure);
  observer.skip("replay", "No executable manifest");
  const paths = await observer.finish();
  const timing = JSON.parse(readFileSync(paths.timingPath, "utf8"));
  expect(timing).toMatchObject({
    schemaVersion: "1.0",
    strategy: "white-box",
    model: "fake",
    task: "upload",
    variant: "correct",
    totalSource: "host-performance",
  });
  expect(timing.totalDurationMs).toBeGreaterThan(0);
  expect(timing.hostSpans).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "prepare", state: "completed" }),
      expect.objectContaining({ name: "verify", state: "failed" }),
      expect.objectContaining({
        name: "inner",
        parentId: expect.any(String),
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        name: "replay",
        state: "skipped",
        reason: "No executable manifest",
      }),
    ]),
  );
  expect(readFileSync(join(options.root, "timing.md"), "utf8")).toContain(
    "overlap",
  );
  expect(readFileSync(paths.eventsPath, "utf8")).toContain("stage");
  expect(await observer.finish()).toEqual(paths);
});

const processResult = {
  exitCode: 0,
  timedOut: false,
  durationMs: 37,
  stdout: "",
  stderr: "",
};
function agentTask(root: string): BehaviorAgentTask {
  return {
    side: "source",
    sandbox: {
      cwd: root,
      readRoots: [root],
      writeRoots: [root],
      projectAccess: "experiment",
    },
    prompt: "private prompt",
    deadlineAt: Date.now() + 10000,
  };
}
const line = (type: string, content: unknown[]) =>
  JSON.stringify({ type, message: { content } }) + "\n";

it("forwards runtime inputs, cumulative callbacks and result identities while retaining incremental redacted tool observations", async () => {
  const options = fixture();
  const secret = "actual-credential-12345";
  const observer = createE2EObserver({ ...options, secrets: [secret] });
  const outputs: string[] = [];
  const task = agentTask(options.root);
  let callbackEvidence: BehaviorCommandRecord[] | undefined;
  let callbackPlan: string | undefined;
  task.onOutput = (output) => {
    outputs.push(output);
  };
  task.onEvidence = (records, plan) => {
    callbackEvidence = records;
    callbackPlan = plan;
  };
  const evidence: BehaviorCommandRecord[] = [
    {
      ...processResult,
      commandId: "controlled-1",
      completed: true,
      side: "source",
      command: { executable: "mvn", args: ["test", `-Dsecret=${secret}`] },
      cwd: options.root,
      baselineValid: true,
      credentialHit: false,
    },
  ];
  const first = line("assistant", [
    {
      type: "tool_use",
      id: "read-1",
      name: "Read",
      input: { file_path: "src/Private.java", content: secret },
    },
    {
      type: "tool_use",
      id: "write-1",
      name: "Write",
      input: {
        file_path: "src/test/java/ExampleTest.java",
        content: "PRIVATE_TEST_SOURCE",
      },
    },
  ]);
  const second =
    first +
    line("user", [
      { type: "tool_result", tool_use_id: "read-1", content: secret },
    ]);
  const final =
    second +
    line("user", [
      { type: "tool_result", tool_use_id: "write-1", content: "done" },
    ]);
  const result = { ...processResult, stdout: final, commandEvidence: evidence };
  const commandTask = {
    command: { executable: "mvn", args: ["test"] },
    sandbox: task.sandbox,
    deadlineAt: task.deadlineAt,
  };
  const commandResult = { ...processResult, durationMs: 23 };
  const runtime: BehaviorRuntime = {
    async runAgent(received) {
      expect(this).toBe(runtime);
      expect(received).toMatchObject({
        ...task,
        onOutput: expect.any(Function),
        onEvidence: expect.any(Function),
      });
      expect(received.sandbox).toBe(task.sandbox);
      received.onOutput?.(first);
      expect(
        readFileSync(join(options.root, "session-1.stream.log"), "utf8"),
      ).toContain("[REDACTED]");
      await delay(5);
      received.onOutput?.(second);
      received.onOutput?.(second);
      received.onEvidence?.(evidence, "exact plan");
      return result;
    },
    async runCommand(received) {
      expect(this).toBe(runtime);
      expect(received).toBe(commandTask);
      await delay(5);
      return commandResult;
    },
  };
  const wrapped = observer.wrapRuntime(runtime);
  expect(await wrapped.runAgent(task)).toBe(result);
  expect(await wrapped.runCommand(commandTask)).toBe(commandResult);
  expect(outputs).toEqual([first, second, second]);
  expect(callbackEvidence).toBe(evidence);
  expect(callbackPlan).toBe("exact plan");
  const { timingPath, eventsPath } = await observer.finish();
  const timing = JSON.parse(readFileSync(timingPath, "utf8"));
  expect(timing.sessions).toHaveLength(1);
  expect(timing.sessions[0]).toMatchObject({
    state: "completed",
    toolCoverage: "partial",
    unclassifiedDurationMs: expect.any(Number),
  });
  expect(timing.agentTasks).toHaveLength(2);
  expect(timing.agentTasks[0].startOffsetMs).toBe(
    timing.agentTasks[1].startOffsetMs,
  );
  expect(timing.sessions[0].toolObservedUnionDurationMs).toBeLessThanOrEqual(
    timing.sessions[0].durationMs,
  );
  expect(timing.agentTasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        toolUseId: "read-1",
        category: "exploration",
        state: "complete",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        toolUseId: "write-1",
        category: "test-authoring",
        state: "complete",
      }),
    ]),
  );
  expect(timing.commands).toHaveLength(2);
  expect(timing.commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        commandId: "controlled-1",
        durationMs: 37,
        category: "compile-test",
        source: "command-evidence",
      }),
      expect.objectContaining({
        durationMs: 23,
        category: "compile-test",
        source: "runtime-command-result",
      }),
    ]),
  );
  expect(timing.hostSpans).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "host-replay",
        durationMs: expect.any(Number),
      }),
    ]),
  );
  const events = readFileSync(eventsPath, "utf8");
  expect(
    events
      .split("\n")
      .filter((entry) => entry.includes('"commandId":"controlled-1"')),
  ).toHaveLength(1);
  for (const text of [
    readFileSync(timingPath, "utf8"),
    events,
    readFileSync(join(options.root, "session-1.stream.log"), "utf8"),
  ])
    expect(text).not.toContain(secret);
  expect(events).not.toContain("PRIVATE_TEST_SOURCE");
  expect(events).not.toContain("file_path");
  expect(
    readFileSync(join(options.root, "session-1.stream.log"), "utf8"),
  ).toContain('"tool_use_id":"write-1"');
});

it("omits assistant reasoning blocks and signatures only from observer logs, preserving callbacks and tool receipts", async () => {
  const options = fixture();
  const secret = 'private-credential-with-quote-"-and-newline-\n-end';
  const observer = createE2EObserver({ ...options, secrets: [secret] });
  const visible = [
    { type: "text", text: "The word thinking is ordinary text." },
    {
      type: "tool_use",
      id: "mixed",
      name: "Read",
      input: {
        type: "thinking",
        content: "ordinary tool input",
        credential: secret,
      },
    },
  ];
  const first = line("assistant", [
    {
      type: "thinking",
      thinking: "PRIVATE_REASONING",
      signature: "PRIVATE_SIGNATURE",
    },
    visible[0],
    {
      type: "redacted_thinking",
      data: "PRIVATE_REDACTED_REASONING",
      signature: "PRIVATE_REDACTED_SIGNATURE",
    },
    visible[1],
  ]);
  const toolResult = {
    type: "tool_result",
    tool_use_id: "mixed",
    content: [
      {
        type: "thinking",
        thinking: "ordinary tool result",
        signature: "ordinary result signature",
      },
      { type: "redacted_thinking", data: "ordinary result data" },
    ],
  };
  const final = first + line("user", [toolResult]);
  const split = first.indexOf("PRIVATE_REASONING") + 8;
  const outputs: string[] = [];
  const task = agentTask(options.root);
  task.onOutput = (output) => {
    outputs.push(output);
  };
  const result = { ...processResult, stdout: final };
  const runtime: BehaviorRuntime = {
    async runAgent(received) {
      received.onOutput?.(first.slice(0, split));
      expect(
        readFileSync(join(options.root, "session-1.stream.log"), "utf8"),
      ).toBe("");
      received.onOutput?.(first);
      const log = readFileSync(
        join(options.root, "session-1.stream.log"),
        "utf8",
      );
      expect(log).not.toContain("PRIVATE_");
      expect(log).not.toContain("private-credential");
      expect(JSON.parse(log).message.content).toEqual([
        visible[0],
        {
          ...visible[1],
          input: { ...visible[1]!.input, credential: "[REDACTED]" },
        },
      ]);
      await delay(5);
      received.onOutput?.(final);
      return result;
    },
    async runCommand() {
      return processResult;
    },
  };
  expect(await observer.wrapRuntime(runtime).runAgent(task)).toBe(result);
  expect(outputs).toEqual([first.slice(0, split), first, final]);
  expect(result.stdout).toBe(final);
  const paths = await observer.finish();
  const timing = JSON.parse(readFileSync(paths.timingPath, "utf8"));
  expect(timing.diagnostics).toContain("stream-reasoning-omitted");
  expect(timing.agentTasks).toEqual([
    expect.objectContaining({
      toolUseId: "mixed",
      state: "complete",
      durationMs: expect.any(Number),
    }),
  ]);
  expect(timing.agentTasks[0].durationMs).toBeGreaterThan(0);
  const saved = readFileSync(
    join(options.root, "session-1.stream.log"),
    "utf8",
  );
  expect(JSON.parse(saved.trim().split("\n")[1]!).message.content).toEqual([
    toolResult,
  ]);
  for (const text of [
    saved,
    readFileSync(paths.timingPath, "utf8"),
    readFileSync(paths.eventsPath, "utf8"),
  ]) {
    expect(text).not.toContain("PRIVATE_");
    expect(text).not.toContain("private-credential");
  }
});

it("does not retain reasoning hidden in duplicate JSON keys", async () => {
  const options = fixture();
  const observer = createE2EObserver(options);
  const output =
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"SHADOWED_PRIVATE_REASONING","signature":"SHADOWED_SIGNATURE"}],"content":[{"type":"text","text":"visible output"}]}}\n';
  const result = { ...processResult, stdout: output };
  const callbacks: string[] = [];
  const task = agentTask(options.root);
  task.onOutput = (text) => {
    callbacks.push(text);
  };
  const runtime: BehaviorRuntime = {
    async runAgent(received) {
      received.onOutput?.(output);
      return result;
    },
    async runCommand() {
      return processResult;
    },
  };
  expect(await observer.wrapRuntime(runtime).runAgent(task)).toBe(result);
  expect(callbacks).toEqual([output]);
  await observer.finish();
  const saved = readFileSync(
    join(options.root, "session-1.stream.log"),
    "utf8",
  );
  expect(saved).not.toContain("SHADOWED_");
  expect(JSON.parse(saved).message.content).toEqual([
    { type: "text", text: "visible output" },
  ]);
});

it("keeps failed-session partial logs and unknown unpaired intervals without inventing command durations", async () => {
  const options = fixture();
  const observer = createE2EObserver(options);
  const failure = new Error("original runtime failure");
  const output =
    line("assistant", [
      {
        type: "tool_use",
        id: "unfinished",
        name: "Edit",
        input: {
          file_path: "src/Experiment.java",
          new_string: "PRIVATE_SOURCE",
        },
      },
    ]) +
    line("user", [
      { type: "tool_result", tool_use_id: "orphan", content: "private result" },
    ]);
  const runtime: BehaviorRuntime = {
    async runAgent(task) {
      task.onOutput?.(output);
      task.onEvidence?.([
        {
          ...processResult,
          commandId: "unfinished-command",
          durationMs: 0,
          completed: false,
          command: { executable: "mvn", args: ["test"] },
          cwd: options.root,
          baselineValid: true,
          credentialHit: false,
        },
      ]);
      throw failure;
    },
    async runCommand() {
      throw failure;
    },
  };
  const wrapped = observer.wrapRuntime(runtime);
  await expect(wrapped.runAgent(agentTask(options.root))).rejects.toBe(failure);
  await expect(
    wrapped.runCommand({
      command: { executable: "mvn", args: ["test"] },
      sandbox: agentTask(options.root).sandbox,
      deadlineAt: Date.now() + 1000,
    }),
  ).rejects.toBe(failure);
  const paths = await observer.finish();
  const timing = JSON.parse(readFileSync(paths.timingPath, "utf8"));
  expect(timing.sessions[0]).toMatchObject({
    state: "failed",
    durationMs: expect.any(Number),
  });
  expect(timing.sessions[0].unclassifiedDurationMs).toBeUndefined();
  expect(timing.agentTasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        toolUseId: "unfinished",
        state: "missing-end",
        category: "source-experiment",
      }),
      expect.objectContaining({
        toolUseId: "orphan",
        state: "missing-start",
        category: "unknown",
      }),
    ]),
  );
  expect(
    timing.agentTasks.every(
      (tool: { durationMs?: number }) => tool.durationMs === undefined,
    ),
  ).toBe(true);
  expect(timing.commands[0]).toMatchObject({
    commandId: "unfinished-command",
    completed: false,
  });
  expect(timing.commands[0].durationMs).toBeUndefined();
  expect(timing.hostSpans).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "host-replay", state: "failed" }),
    ]),
  );
  expect(
    readFileSync(join(options.root, "session-1.stream.log"), "utf8"),
  ).toContain("unfinished");
  expect(readFileSync(paths.timingPath, "utf8")).not.toContain(
    "PRIVATE_SOURCE",
  );
});

it("does not replace caller callback failures with observation failures", async () => {
  const options = fixture();
  const observer = createE2EObserver(options);
  mkdirSync(join(options.root, "session-1.stream.log"));
  const failure = new Error("caller callback failed");
  const task = agentTask(options.root);
  task.onOutput = () => {
    throw failure;
  };
  const runtime: BehaviorRuntime = {
    async runAgent(received) {
      received.onOutput?.(line("assistant", [{ type: "text", text: "hello" }]));
      return processResult;
    },
    async runCommand() {
      return processResult;
    },
  };
  await expect(observer.wrapRuntime(runtime).runAgent(task)).rejects.toBe(
    failure,
  );
  const timing = JSON.parse(
    readFileSync((await observer.finish()).timingPath, "utf8"),
  );
  expect(timing.sessions[0]).toMatchObject({
    state: "failed",
    streamCompleteness: "unavailable",
    toolCoverage: "unavailable",
  });
  expect(timing.sessions[0].unclassifiedDurationMs).toBeUndefined();
  expect(timing.diagnostics).toContain("stream-write-failed");
});

it("reports setup records and opaque commands without inventing compile versus test splits", async () => {
  const options = fixture();
  const observer = createE2EObserver(options);
  observer.recordPreparation([
    {
      side: "source",
      command: "python -m pip install -r requirements.txt",
      durationMs: 101,
      exitCode: 0,
      timedOut: false,
    },
  ]);
  const runtime: BehaviorRuntime = {
    async runAgent() {
      return processResult;
    },
    async runCommand() {
      return processResult;
    },
  };
  const wrapped = observer.wrapRuntime(runtime);
  for (const command of [
    { executable: "npm", args: ["test"] },
    { executable: "dotnet", args: ["test"] },
  ]) {
    await wrapped.runCommand({
      command,
      sandbox: agentTask(options.root).sandbox,
      deadlineAt: Date.now() + 1000,
    });
  }
  await wrapped.runAgent(agentTask(options.root));
  const timing = JSON.parse(
    readFileSync((await observer.finish()).timingPath, "utf8"),
  );
  expect(timing.commands).toHaveLength(3);
  expect(timing.commands[0]).toMatchObject({
    phase: "setup",
    durationMs: 101,
    source: "preparation-record",
  });
  expect(timing.commands[1]).toMatchObject({
    phase: "unknown",
    category: "unknown",
    durationMs: 37,
  });
  expect(timing.commands[2]).toMatchObject({
    phase: "unknown",
    category: "compile-test",
    durationMs: 37,
  });
  expect(timing.agentAvailability).toBe("unavailable");
  expect(timing.sessions[0].toolObservedUnionDurationMs).toBeUndefined();
});

it("upgrades unfinished evidence once and consumes a final stdout tail without a newline", async () => {
  const options = fixture();
  const observer = createE2EObserver(options);
  const initial: BehaviorCommandRecord = {
    ...processResult,
    commandId: "one-command",
    completed: false,
    durationMs: 0,
    command: { executable: "mvn", args: ["test"] },
    cwd: options.root,
    baselineValid: true,
    credentialHit: false,
  };
  const complete = { ...initial, completed: true, durationMs: 41 };
  const first = line("assistant", [
    {
      type: "tool_use",
      id: "tail",
      name: "Grep",
      input: { pattern: "private" },
    },
  ]);
  const final =
    first +
    line("user", [
      { type: "tool_result", tool_use_id: "tail", content: "done" },
    ]).trimEnd();
  const runtime: BehaviorRuntime = {
    async runAgent(task) {
      task.onOutput?.(first);
      task.onEvidence?.([initial]);
      task.onEvidence?.([complete]);
      return { ...processResult, stdout: final, commandEvidence: [complete] };
    },
    async runCommand() {
      return processResult;
    },
  };
  await observer.wrapRuntime(runtime).runAgent(agentTask(options.root));
  const paths = await observer.finish();
  const timing = JSON.parse(readFileSync(paths.timingPath, "utf8"));
  expect(timing.commands).toEqual([
    expect.objectContaining({
      commandId: "one-command",
      completed: true,
      durationMs: 41,
    }),
  ]);
  expect(timing.agentTasks[0]).toMatchObject({
    state: "complete",
    category: "exploration",
    durationMs: expect.any(Number),
  });
  const events = readFileSync(paths.eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((entry) => JSON.parse(entry));
  expect(
    events.filter(
      (entry) => entry.commandId === "one-command" && entry.completed,
    ),
  ).toHaveLength(1);
  expect(readFileSync(join(options.root, "session-1.stream.log"), "utf8")).toBe(
    final,
  );
});

it("keeps the runtime usable when final timing persistence fails", async () => {
  const options = fixture();
  const observer = createE2EObserver(options);
  mkdirSync(join(options.root, "timing.json"));
  const value = {};
  expect(await observer.measureStep("verification", async () => value)).toBe(
    value,
  );
  const paths = await observer.finish();
  expect(readFileSync(paths.eventsPath, "utf8")).toContain(
    "timing-json-write-failed",
  );
  expect(readFileSync(join(options.root, "timing.md"), "utf8")).toContain(
    "verification",
  );
  expect(await observer.finish()).toEqual(paths);
});

it("caps retained commands and sessions without preventing additional runtime work", async () => {
  const options = fixture();
  const observer = createE2EObserver(options);
  observer.recordPreparation(
    Array.from({ length: 1002 }, () => ({
      side: "source",
      command: "prepare",
      durationMs: 2,
      exitCode: 0,
      timedOut: false,
    })),
  );
  let calls = 0;
  const runtime: BehaviorRuntime = {
    async runAgent() {
      calls++;
      return processResult;
    },
    async runCommand() {
      return processResult;
    },
  };
  const wrapped = observer.wrapRuntime(runtime);
  for (let index = 0; index < 34; index++)
    expect(await wrapped.runAgent(agentTask(options.root))).toBe(processResult);
  const timing = JSON.parse(
    readFileSync((await observer.finish()).timingPath, "utf8"),
  );
  expect(calls).toBe(34);
  expect(timing.commands).toHaveLength(1000);
  expect(timing.sessions).toHaveLength(32);
  expect(timing.diagnostics).toEqual(
    expect.arrayContaining(["commands-truncated", "sessions-truncated"]),
  );
});

it.each([
  [
    "malformed",
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"PRIVATE_MALFORMED_REASONING"}]}} trailing\n',
    "stream-json-invalid",
  ],
  [
    "unfinished",
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"PRIVATE_UNFINISHED_REASONING',
    "stream-json-invalid",
  ],
  [
    "oversized",
    line("assistant", [
      {
        type: "thinking",
        thinking: "PRIVATE_OVERSIZED_REASONING" + "x".repeat(256 * 1024),
      },
    ]),
    "stream-line-truncated",
  ],
])(
  "omits %s JSON payloads instead of persisting unfiltered reasoning",
  async (_name, payload, reason) => {
    const options = fixture();
    const observer = createE2EObserver(options);
    const visible = line("assistant", [
      { type: "text", text: "visible output" },
    ]);
    const output = visible + payload;
    const result = { ...processResult, stdout: output };
    const callbacks: string[] = [];
    const task = agentTask(options.root);
    task.onOutput = (text) => {
      callbacks.push(text);
    };
    const runtime: BehaviorRuntime = {
      async runAgent(received) {
        received.onOutput?.(output);
        return result;
      },
      async runCommand() {
        return processResult;
      },
    };
    expect(await observer.wrapRuntime(runtime).runAgent(task)).toBe(result);
    expect(callbacks).toEqual([output]);
    const paths = await observer.finish();
    expect(
      readFileSync(join(options.root, "session-1.stream.log"), "utf8"),
    ).toBe(visible);
    const timing = JSON.parse(readFileSync(paths.timingPath, "utf8"));
    expect(timing.diagnostics).toEqual(
      expect.arrayContaining([reason, "stream-payload-omitted"]),
    );
    expect(timing.sessions[0].streamBytes).toBe(Buffer.byteLength(visible));
  },
);

it("omits a credential prefix cut by the stream budget", async () => {
  const options = fixture();
  const secret = "private-long-credential-value";
  const observer = createE2EObserver({ ...options, secrets: [secret] });
  const prefix =
    '{"type":"assistant","message":{"content":[{"type":"text","text":"';
  const output =
    prefix + "x".repeat(1024 * 1024 - prefix.length - 12) + secret + '"}]}}\n';
  const runtime: BehaviorRuntime = {
    async runAgent(task) {
      task.onOutput?.(output);
      return { ...processResult, stdout: output };
    },
    async runCommand() {
      return processResult;
    },
  };
  await observer.wrapRuntime(runtime).runAgent(agentTask(options.root));
  const timing = JSON.parse(
    readFileSync((await observer.finish()).timingPath, "utf8"),
  );
  expect(timing.diagnostics).toContain("stream-truncated");
  const log = readFileSync(join(options.root, "session-1.stream.log"), "utf8");
  expect(log.includes(secret.slice(0, 12))).toBe(false);
  expect(log).toBe("");
  expect(timing.diagnostics).toEqual(
    expect.arrayContaining(["stream-line-truncated", "stream-payload-omitted"]),
  );
});

it("bounds streams, tools and events with explicit diagnostics while forwarding cumulative output untouched", async () => {
  const options = fixture();
  const secret = 'sensitive-token-with-quote-"-and-newline-\n-end';
  const observer = createE2EObserver({ ...options, secrets: [secret] });
  const first = line("assistant", [
    {
      type: "tool_use",
      id: "first",
      name: "Write",
      input: { file_path: ".forexplore-tests/test.py", content: secret },
    },
  ]);
  const markers = Array.from({ length: 1002 }, (_, index) =>
    line("assistant", [
      { type: "tool_use", id: `tool-${index}`, name: "Read", input: {} },
    ]),
  ).join("");
  const huge =
    first +
    markers +
    line("assistant", [
      { type: "text", text: "x".repeat(2 * 1024 * 1024) + secret },
    ]);
  const outputs: string[] = [];
  const task = agentTask(options.root);
  task.onOutput = (text) => {
    outputs.push(text);
  };
  const runtime: BehaviorRuntime = {
    async runAgent(received) {
      const split = first.indexOf("sensitive") + 10;
      received.onOutput?.(first.slice(0, split));
      received.onOutput?.(first);
      received.onOutput?.(huge);
      return { ...processResult, stdout: huge };
    },
    async runCommand() {
      return processResult;
    },
  };
  await observer.wrapRuntime(runtime).runAgent(task);
  for (let index = 0; index < 10010; index++)
    observer.skip(`omitted-${index}`, "Not executed");
  const paths = await observer.finish();
  const timing = JSON.parse(readFileSync(paths.timingPath, "utf8"));
  expect(outputs[2]).toBe(huge);
  expect(timing.agentTasks.length).toBeLessThanOrEqual(1000);
  expect(timing.diagnostics).toEqual(
    expect.arrayContaining([
      "events-truncated",
      "tools-truncated",
      "stream-truncated",
    ]),
  );
  expect(timing.sessions[0].streamCompleteness).toBe("truncated");
  expect(
    statSync(join(options.root, "session-1.stream.log")).size,
  ).toBeLessThanOrEqual(1024 * 1024);
  const events = readFileSync(paths.eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((entry) => JSON.parse(entry));
  expect(events).toHaveLength(10000);
  expect(events.at(-1)).toMatchObject({
    kind: "diagnostic",
    code: "events-truncated",
  });
  const log = readFileSync(join(options.root, "session-1.stream.log"), "utf8");
  expect(log).toContain("[REDACTED]");
  expect(log).not.toContain("sensitive-token");
  expect(log.trim().split("\n")).toHaveLength(1003);
  expect(timing.diagnostics).toEqual(
    expect.arrayContaining(["stream-line-truncated", "stream-payload-omitted"]),
  );
});
