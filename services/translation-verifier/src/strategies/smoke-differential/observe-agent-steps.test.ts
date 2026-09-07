import { describe, expect, it } from "vitest";
import { createRunRecorder } from "../../run-output/record-run.js";
import { observeAgentSteps } from "./observe-agent-steps.js";

const marker = (name = "explore", event = "start") => `[VERIFIER_STEP] ${JSON.stringify({ name, event })}\n`;
const snapshot = (id: string, text: string) => JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }] } }) + "\n";
const stream = (event: object) => JSON.stringify({ type: "stream_event", event }) + "\n";

function setup() {
  let clock = 100;
  const recorder = createRunRecorder({ runId: "observed", monotonicNow: () => clock });
  const observer = observeAgentSteps(recorder);
  return { recorder, observer, send: (text: string) => observer.push(Buffer.from(text)), tick: () => { clock += 5; } };
}

describe("strategy-private Agent task observations", () => {
  it("decodes split UTF-8 and partial lines, deduplicates snapshots by message/block, retains repeated occurrences", () => {
    const { recorder, observer, send, tick } = setup();
    send(stream({ type: "message_start", message: { id: "m1" } }));
    send(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    const text = stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "中文\n" + marker() } });
    for (const byte of Buffer.from(text)) observer.push(Buffer.from([byte]));
    tick();
    send(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: marker("explore", "end") } }));
    send(stream({ type: "content_block_stop", index: 0 }));
    send(stream({ type: "message_stop" }));
    send(snapshot("m1", "中文\n" + marker() + marker("explore", "end")));
    send(snapshot("m1", marker()));
    tick();
    send(snapshot("m2", marker() + marker("explore", "end")));
    observer.finish();
    const events = recorder.events();
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.offsetMs)).toEqual([0, 5, 10, 10]);
    expect(events.every((event) => event.source === "host-performance" && event.kind === "agent-step-approximate")).toBe(true);
    expect(events[0].operationId).toBe(events[1].operationId);
    expect(events[2].operationId).not.toBe(events[0].operationId);
  });

  it("deduplicates a single text record after thinking changed the original stream index", () => {
    const { recorder, observer, send, tick } = setup();
    send(stream({ type: "message_start", message: { id: "thinking-first" } }));
    send(stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
    send(stream({ type: "content_block_stop", index: 0 }));
    send(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    tick();
    send(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: marker("compare") } }));
    tick();
    send(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: marker("compare", "end") } }));
    send(stream({ type: "content_block_stop", index: 1 }));
    tick();
    send(snapshot("thinking-first", marker("compare") + marker("compare", "end")));
    send(snapshot("thinking-first", marker("compare") + marker("compare", "end")));
    observer.finish();
    expect(recorder.events().map((event) => event.offsetMs)).toEqual([5, 10]);
    expect(recorder.events().map((event) => event.operationId)).toEqual(["agent-task-1", "agent-task-1"]);
    expect(recorder.snapshot().diagnostics).toEqual([]);
  });

  it("preserves repeated streamed tasks across text blocks and messages while deduplicating single and cumulative records", () => {
    const { recorder, observer, send } = setup();
    const value = marker("compare") + marker("compare", "end");
    for (const id of ["first", "second"]) {
      send(stream({ type: "message_start", message: { id } }));
      for (const index of [1, 3]) {
        send(stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
        send(stream({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }));
        send(stream({ type: "content_block_stop", index }));
        send(snapshot(id, value));
      }
      send(JSON.stringify({ type: "assistant", message: { id, content: [
        { type: "thinking" }, { type: "text", text: value }, { type: "tool_use" }, { type: "text", text: value },
      ] } }) + "\n");
      send(snapshot(id, value));
    }
    observer.finish();
    expect(recorder.events()).toHaveLength(8);
    expect(new Set(recorder.events().map((event) => event.operationId)).size).toBe(4);
    expect(recorder.snapshot().diagnostics).toEqual([]);
  });

  it("omits unidentifiable changed records conservatively and preserves no-partial multi-block fallback", () => {
    const { recorder, observer, send } = setup();
    const value = marker() + marker("explore", "end");
    const packet = JSON.stringify({ type: "assistant", message: { id: "fallback", content: [{ type: "text", text: value }, { type: "text", text: value }] } }) + "\n";
    send(packet);
    send(packet);
    send(snapshot("fallback", marker("ambiguous")));
    send(stream({ type: "message_start", message: { id: "streamed" } }));
    send(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: value } }));
    send(stream({ type: "content_block_stop", index: 1 }));
    send(snapshot("streamed", marker("unknown-block")));
    observer.finish();
    expect(recorder.events()).toHaveLength(6);
    expect(recorder.events().every((event) => event.name === "explore")).toBe(true);
    expect(recorder.snapshot().diagnostics.map((entry) => entry.code)).toEqual(["agent-telemetry-omitted"]);
  });

  it("keeps text digest matching stable across split UTF-16 surrogates", () => {
    const { recorder, observer, send } = setup();
    const value = marker() + marker("explore", "end");
    send(stream({ type: "message_start", message: { id: "unicode" } }));
    send(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    send(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "\ud840" } }));
    send(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "\udc00\n" + value } }));
    send(stream({ type: "content_block_stop", index: 1 }));
    send(snapshot("unicode", "\ud840\udc00\n" + value));
    observer.finish();
    expect(recorder.events()).toHaveLength(2);
    expect(recorder.snapshot().diagnostics).toEqual([]);
  });

  it("omits snapshots without message identity and late partials after snapshot fallback", () => {
    const { recorder, observer, send } = setup();
    const value = marker() + marker("explore", "end");
    send(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: value }] } }) + "\n");
    send(snapshot("fallback", value));
    send(stream({ type: "message_start", message: { id: "fallback" } }));
    send(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: value } }));
    send(stream({ type: "content_block_stop", index: 1 }));
    observer.finish();
    expect(recorder.events()).toHaveLength(2);
    expect(recorder.snapshot().diagnostics.map((entry) => entry.code)).toEqual(["agent-telemetry-omitted"]);
  });

  it.each(["`", "``"])("ignores examples after split opening fence %s and oversized info, then reads real tasks", (prefix) => {
    const { recorder, observer, send } = setup();
    send(stream({ type: "message_start", message: { id: "split-fence" } }));
    send(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    send(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: prefix } }));
    send(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "`".repeat(3 - prefix.length) + "x".repeat(4096) + "\n" + marker("example") + marker("example", "end") + "```\n" + marker("real") + marker("real", "end") } }));
    send(stream({ type: "content_block_stop", index: 0 }));
    observer.finish();
    expect(recorder.events().map((event) => event.name)).toEqual(["real", "real"]);
    expect(recorder.snapshot().diagnostics.map((entry) => entry.code)).toEqual(["agent-telemetry-omitted"]);
  });

  it("ignores thinking, tool payloads, fenced snippets and inline examples", () => {
    const { recorder, observer, send } = setup();
    send(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: marker() }] } }) + "\n");
    send(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: marker() }, { type: "tool_use", input: { text: marker() } }, { type: "text", text: "```text\n" + marker() + "```\n~~~\n" + marker() + "~~~\nprefix " + marker() }] } }) + "\n");
    send(snapshot("m2", marker("finalize-report") + marker("finalize-report", "end")));
    observer.finish();
    expect(recorder.events().map((event) => event.name)).toEqual(["finalize-report", "finalize-report"]);
  });

  it("falls back to assistant snapshots when no partial text was observed, without deduplicating distinct messages", () => {
    const { recorder, observer, send } = setup();
    send(stream({ type: "message_start", message: { id: "m1" } }));
    send(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    send(stream({ type: "content_block_stop", index: 0 }));
    send(snapshot("m1", marker()));
    send(snapshot("m2", marker()));
    observer.finish();
    expect(recorder.events()).toHaveLength(2);
    expect(recorder.events()[0].operationId).not.toBe(recorder.events()[1].operationId);
  });

  it("suppresses ambiguous snapshots after anonymous partial text and oversized fenced examples", () => {
    const { recorder, observer, send } = setup();
    send(stream({ type: "message_start", message: {} }));
    send(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    send(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: marker() } }));
    send(stream({ type: "message_stop" }));
    send(snapshot("identified-later", marker()));
    observer.finish();
    expect(recorder.events()).toHaveLength(1);
    const fenced = setup();
    fenced.send(snapshot("fence", "```" + "x".repeat(4096) + "\n" + marker() + "```\n" + marker("judge")));
    fenced.observer.finish();
    expect(fenced.recorder.events().map((event) => event.name)).toEqual(["judge"]);
  });

  it("preserves missing ends, unmatched ends and missing telemetry without inventing durations", () => {
    const { recorder, observer, send } = setup();
    send(snapshot("m1", marker() + marker("judge", "end")));
    observer.finish();
    observer.finish();
    expect(recorder.events()).toHaveLength(2);
    expect(recorder.events().every((event) => event.durationMs === undefined)).toBe(true);
    expect(recorder.snapshot().diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["agent-step-missing-start", "agent-step-missing-end"]));
    const empty = setup();
    empty.observer.finish();
    expect(empty.recorder.snapshot().diagnostics[0].code).toBe("agent-telemetry-missing");
  });

  it("drains oversized stream/text lines and rejects malformed markers without retaining payloads", () => {
    const { recorder, observer, send } = setup();
    send("x".repeat(1024 * 1024 + 1) + "\n");
    send(snapshot("big", "x".repeat(4097) + marker() + marker("judge", "start")));
    send(snapshot("bad", '[VERIFIER_STEP] {"name":"explore","event":"start","timestamp":1}\n'));
    send("{broken\n");
    send(snapshot("ok", marker("judge", "end")));
    observer.finish();
    expect(recorder.events().map((event) => event.name)).toEqual(["judge", "judge"]);
    expect(recorder.snapshot().diagnostics.some((d) => d.code === "agent-telemetry-omitted")).toBe(true);
    expect(JSON.stringify(recorder.snapshot())).not.toContain("xxxxx");
  });

  it("caps streamed block digests without retaining raw text or accepting late tasks", () => {
    const { recorder, observer, send } = setup();
    send(stream({ type: "message_start", message: { id: "block-budget" } }));
    for (let index = 0; index < 4097; index++) {
      send(stream({ type: "content_block_start", index, content_block: { type: "text", text: "PRIVATE-TEXT\n" } }));
      send(stream({ type: "content_block_stop", index }));
    }
    send(snapshot("late", marker()));
    observer.finish();
    expect(recorder.events()).toEqual([]);
    expect(recorder.snapshot().diagnostics.some((entry) => entry.code === "agent-telemetry-omitted")).toBe(true);
    expect(JSON.stringify(recorder.snapshot())).not.toContain("PRIVATE-TEXT");
  });

  it("caps events and auxiliary identity state and continues draining", () => {
    const { recorder, observer, send } = setup();
    send(snapshot("many", (marker() + marker("explore", "end")).repeat(5001)));
    // One bounded stream line can contain enough small markers to reach the event cap.
    observer.finish();
    expect(recorder.events()).toHaveLength(10000);
    expect(recorder.snapshot().diagnostics.some((d) => d.code === "agent-telemetry-omitted")).toBe(true);
    const bounded = setup();
    for (let index = 0; index < 1100; index++) bounded.send(snapshot(`m${index}`, "no marker"));
    bounded.send(snapshot("late", marker()));
    bounded.observer.finish();
    expect(bounded.recorder.events()).toEqual([]);
    expect(bounded.recorder.snapshot().diagnostics.some((d) => d.code === "agent-telemetry-omitted")).toBe(true);
  });
});
