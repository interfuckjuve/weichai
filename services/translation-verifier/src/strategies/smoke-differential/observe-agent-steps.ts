import { StringDecoder } from "node:string_decoder";
import type { RunRecorder } from "../../run-output/record-run.js";

const MAX_STREAM_LINE = 1024 * 1024;
const MAX_TEXT_LINE = 4096;
const MAX_EVENTS = 10_000;
const MAX_MESSAGES = 1024;
const MAX_BLOCKS = 4096;

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;

/** Smoke-only protocol reader. Raw text is transient; only receipt-time metadata reaches the recorder. */
export function observeAgentSteps(recorder: RunRecorder) {
  const decoder = new StringDecoder("utf8");
  const messages = new Map<string, Set<number>>();
  const open = new Map<string, string[]>();
  let currentMessage: string | undefined;
  let currentBlock: number | undefined;
  let textLine = "";
  let streamLine = "";
  let textBytes = 0;
  let streamBytes = 0;
  let droppingText = false;
  let droppingStream = false;
  let fence: string | undefined;
  let events = 0;
  let occurrences = 0;
  let blocks = 0;
  let omitted = false;
  let disabled = false;
  let finished = false;
  let anonymousPartial = false;

  function omit() {
    if (!omitted) recorder.anomaly("agent-telemetry-omitted", "Malformed, oversized, ambiguous or excess Agent observations were omitted; timings are incomplete.");
    omitted = true;
  }

  function mark(line: string) {
    const trimmed = line.trim();
    const delimiter = /^(\`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && trimmed === delimiter) fence = undefined;
      return;
    }
    if (fence || !line.startsWith("[VERIFIER_STEP] ")) return;
    let value: JsonObject | undefined;
    try { value = object(JSON.parse(line.slice("[VERIFIER_STEP] ".length))); } catch { omit(); return; }
    if (!value || Object.keys(value).length !== 2 || typeof value.name !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(value.name) || !["start", "end"].includes(value.event as string)) {
      omit(); return;
    }
    if (events >= MAX_EVENTS) { omit(); return; }
    const name = value.name;
    const pending = open.get(name) ?? [];
    let operationId: string;
    if (value.event === "start") {
      operationId = `agent-task-${++occurrences}`;
      pending.push(operationId);
      open.set(name, pending);
    } else {
      operationId = pending.pop() ?? `agent-task-${++occurrences}`;
      if (!open.has(name)) recorder.anomaly("agent-step-missing-start", `No start marker for ${name}.`);
      if (!pending.length) open.delete(name);
    }
    recorder.observe({ kind: "agent-step-approximate", source: "host-performance", name, event: value.event as string, operationId });
    events++;
  }

  function text(value: string, end = false) {
    // Scan segments, never retain an overflowing line, including fenced/tool-like payloads.
    for (const segment of value.split(/(?<=\n)/)) {
      const newline = segment.endsWith("\n");
      textBytes += Buffer.byteLength(segment);
      if (!droppingText && textBytes > MAX_TEXT_LINE) {
        // Preserve an opening fence even when its info string exceeds the text-line budget.
        const delimiter = /^(\`{3,}|~{3,})/.exec((textLine || segment).trimStart())?.[1];
        if (!fence && delimiter) fence = delimiter;
        textLine = "";
        droppingText = true;
        omit();
      }
      if (!droppingText) textLine += segment;
      if (newline) {
        if (!droppingText) mark(textLine.replace(/\r?\n$/, ""));
        textLine = "";
        textBytes = 0;
        droppingText = false;
      }
    }
    if (end) {
      if (!droppingText && textLine) mark(textLine);
      textLine = "";
      textBytes = 0;
      droppingText = false;
      fence = undefined;
    }
  }

  function identity(id: unknown): Set<number> | undefined {
    if (typeof id !== "string" || !id || id.length > 256) return;
    let seen = messages.get(id);
    if (!seen) {
      if (messages.size >= MAX_MESSAGES) { disabled = true; omit(); return; }
      seen = new Set();
      messages.set(id, seen);
    }
    return seen;
  }

  function remember(seen: Set<number> | undefined, index: number): boolean {
    if (seen?.has(index)) return true;
    if (++blocks > MAX_BLOCKS) { disabled = true; omit(); return false; }
    seen?.add(index);
    return true;
  }

  function parse(line: string) {
    if (disabled || !line.trim()) return;
    let packet: JsonObject | undefined;
    try { packet = object(JSON.parse(line)); } catch { omit(); return; }
    if (!packet) return;
    if (packet.type === "assistant") {
      const message = object(packet.message);
      if (!message || !Array.isArray(message.content)) return;
      const seen = identity(message.id);
      if (disabled) return;
      if (anonymousPartial) { omit(); return; }
      for (const [index, raw] of message.content.entries()) {
        const block = object(raw);
        if (block?.type !== "text" || typeof block.text !== "string" || seen?.has(index)) continue;
        if (!remember(seen, index)) return;
        text(block.text, true);
      }
      return;
    }
    if (packet.type !== "stream_event") return;
    const event = object(packet.event);
    if (!event) return;
    if (event.type === "message_start") {
      text("", true);
      const id = object(event.message)?.id;
      currentMessage = identity(id) ? id as string : undefined;
      currentBlock = undefined;
    } else if (event.type === "content_block_start") {
      text("", true);
      const block = object(event.content_block);
      currentBlock = block?.type === "text" && Number.isSafeInteger(event.index) && (event.index as number) >= 0 ? event.index as number : undefined;
      if (currentBlock !== undefined && typeof block?.text === "string" && block.text) partial(block.text);
    } else if (event.type === "content_block_delta") {
      const delta = object(event.delta);
      if (currentBlock === event.index && delta?.type === "text_delta" && typeof delta.text === "string") partial(delta.text);
    } else if (event.type === "content_block_stop" || event.type === "message_stop") {
      text("", true);
      currentBlock = undefined;
      if (event.type === "message_stop") currentMessage = undefined;
    }
  }

  function partial(value: string) {
    if (disabled || currentBlock === undefined) return;
    if (!currentMessage) anonymousPartial = true;
    if (remember(currentMessage ? messages.get(currentMessage) : undefined, currentBlock)) text(value);
  }

  function consume(value: string) {
    for (const segment of value.split(/(?<=\n)/)) {
      const newline = segment.endsWith("\n");
      streamBytes += Buffer.byteLength(segment);
      if (!droppingStream && streamBytes > MAX_STREAM_LINE) {
        streamLine = "";
        droppingStream = true;
        omit();
      }
      if (!droppingStream) streamLine += segment;
      if (newline) {
        if (!droppingStream) parse(streamLine);
        streamLine = "";
        streamBytes = 0;
        droppingStream = false;
      }
    }
  }

  return {
    push(chunk: Buffer) {
      if (finished) return;
      for (let offset = 0; offset < chunk.length; offset += 64 * 1024) consume(decoder.write(chunk.subarray(offset, offset + 64 * 1024)));
    },
    finish() {
      if (finished) return;
      consume(decoder.end());
      if (!droppingStream && streamLine) parse(streamLine);
      text("", true);
      if (!events) recorder.anomaly("agent-telemetry-missing", "No live Agent task markers were observed; task timing is unavailable.");
      if (open.size) recorder.anomaly("agent-step-missing-end", "Some Agent tasks have no end marker; their durations remain unavailable.");
      finished = true;
      streamLine = "";
      messages.clear();
      open.clear();
    },
  };
}
