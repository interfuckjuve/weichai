# Translation Verifier Agent API and Tool-Calling Loop Research

Date: 2026-09-25

## Question

How do established Agent runtimes separate provider authentication from Agent execution, and how are system prompts, task input, tool declarations, model output, reasoning/thinking, and tool results assembled and replayed across turns? How do they advance, terminate, bound, and recover a tool-calling loop? What should `translation-verifier` preserve when it adds a real model adapter?

This note is research only. It does not change `services/translation-verifier` business code.

## Executive Findings

1. API keys belong at the provider/client boundary, not in Agent input, system prompts, strategy code, or tool implementations. OpenAI Agents JS accepts an explicit key or client in `OpenAIProvider`, while its default key lookup falls back to `OPENAI_API_KEY`; the provider constructs or lazily obtains the SDK client. Pi follows the same boundary with `ModelRuntime`, stored credentials, environment variables, and a runtime API-key override. [OpenAI provider](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-openai/src/openaiProvider.ts#L19-L38), [OpenAI client resolution](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-openai/src/openaiProvider.ts#L81-L107), [OpenAI default key](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-openai/src/defaults.ts#L43-L55), [Pi model/auth docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#authenticate).
2. A tool-calling run is a state machine around one provider request: send the current transcript and tool definitions, accept an assistant response, execute the returned tool calls, append correlated tool results, and request the next turn. OpenAI Agents JS documents this explicitly; Pi describes the same sequence; the current verifier Host already implements the provider-neutral form. [OpenAI Runner loop](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L690-L703), [Pi loop](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md#agent-loop), [verifier runtime](../services/translation-verifier/src/host/runtime.ts#L123-L181).
3. Turn limits and HTTP retries are different budgets. OpenAI Agents JS checks `maxTurns` in the Runner and separately has opt-in model request retry policy whose default `maxRetries` is `0`; Pi exposes separate agent-level and provider-level retry settings; smolagents retries rate-limit failures inside its API model layer while `max_steps` bounds Agent progress. The verifier should keep its existing no-automatic-retry policy and test the two failure classes independently. [OpenAI turn check](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/runner/turnPreparation.ts#L149-L165), [OpenAI request retry](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/runner/modelRetry.ts#L1153-L1288), [Pi retry settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#network-and-retries), [smolagents step loop](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/agents.py#L540-L637).
4. The runtime, rather than the model, must own terminal semantics. OpenAI Agents JS supports configurable behavior for missing tools and model-visible tool errors; Claude Agent SDK exposes a strict tool allowlist and structured terminal reasons; the verifier Host additionally requires `finish` or `report_uncertain` to be the only terminal call and validates the result against Host-observed test state. [OpenAI missing-tool policy](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L401-L415), [Claude tool allowlist](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L1450-L1454), [verifier terminal enforcement](../services/translation-verifier/src/host/runtime.ts#L147-L153), [verifier finish validation](../services/translation-verifier/src/host/tools/finish.ts#L151-L177).
5. The real adapter should implement exactly one provider-neutral completion operation. It should resolve the key at request time, serialize `AgentMessage` and `AgentToolDefinition` into the selected provider protocol, parse the provider response into `AgentCompletion`, and fail closed for HTTP errors, invalid JSON, empty completions, malformed calls, and invalid call arguments. The Host loop should remain responsible for transcript progression, tool execution, budgets, and terminal results. This matches the existing `AgentModelClient` contract and the adaptation service's established DeepSeek/OpenAI-compatible/Anthropic adapter. [verifier model port](../services/translation-verifier/src/host/model.ts#L1-L45), [existing credential scope](../services/adaptation-service/src/model-credential.ts#L6-L15), [existing provider request boundary](../services/adaptation-service/src/deepseek-client.ts#L59-L105).
6. Context assembly is a projection problem, not just string concatenation. The verifier currently stores a local message transcript and resends it in full; OpenAI Agents JS stores typed output items and can send either the full local projection or only the unacknowledged delta; Pi replays system-message state before provider conversion; smolagents rebuilds provider messages from memory steps; Claude Code owns the provider transcript inside a CLI process and exposes stream/session records. Reasoning is therefore runtime-specific: it may be a replayable item, a signed or encrypted continuation payload, a visible thinking block, or absent from the verifier port. [verifier loop](../services/translation-verifier/src/host/runtime.ts#L123-L181), [OpenAI input projection](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/runner/items.ts#L630-L699), [Pi transcript replay](/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js#L1-L103).

## Source Snapshots

The comparison used primary source code, first-party examples, and first-party documentation at these snapshots:

| Project | Snapshot | Evidence |
| --- | --- | --- |
| OpenAI Agents JS | package version `0.18.0`; commit `00eef0cb84cc47814a48a132f3887fd9cc440006` | `packages/agents-core/src/run.ts`, `runner/turnPreparation.ts`, `runner/modelRetry.ts`, `packages/agents-openai/src/openaiProvider.ts`, `defaults.ts` |
| Claude Agent SDK TypeScript | tag `v0.3.282`; commit `9e477a178c370991ed87ca65b4c8631d390aea35`; published package `@anthropic-ai/claude-agent-sdk@0.3.282` | official README, session-store examples, official CHANGELOG, and published package type declarations; the Git checkout does not include the published SDK implementation source |
| Hugging Face smolagents | development version `1.27.0.dev0`; commit `227ef5e49ddd82339295939072f0223249aa8d38` | `src/smolagents/agents.py`, `models.py`, `utils.py`, README |
| Pi coding agent | installed packages `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`, version `0.87.1` | installed `docs/`, SDK examples, `dist/core/agent-session.js`, `dist/core/model-runtime.d.ts`, and `pi-ai/dist/types.d.ts` / transcript/provider converters |
| Existing workspace model client | current workspace | `services/adaptation-service/src/deepseek-client.ts`, `model-config.ts`, `model-credential.ts` |

## Comparison

| Runtime | Credential injection | Loop advancement | Normal termination | Bound/error behavior | Retry behavior |
| --- | --- | --- | --- | --- | --- |
| OpenAI Agents JS | `OpenAIProvider({ apiKey, baseURL, openAIClient })`; default key can come from `OPENAI_API_KEY` | Runner invokes model, processes final output/handoff/tool calls, executes tools, and loops | Typed final output, handoff progression, or an explicit run result | `maxTurns` raises `MaxTurnsExceeded`; missing tools can raise or return a model-visible error; tool errors can be formatted | Model retry is separate and opt-in through model settings; default `maxRetries` is `0` |
| Claude Agent SDK | SDK process uses Anthropic authentication; official examples require `ANTHROPIC_API_KEY` | `query()` returns an async message stream; the SDK process owns tool execution and session continuation | `result` messages expose success/error and, in current releases, `terminal_reason` | `maxTurns`, permissions, tool allowlists, and structured error result subtypes are host-visible | Official changelog documents transient `api_retry` events and bounded retry behavior, but the loop is behind the SDK subprocess |
| smolagents | Model objects receive `api_key`/`api_base`; examples commonly read keys from `os.environ` | `MultiStepAgent._run_stream()` repeats planning/action steps and records observations | Model-marked final answer or a max-step fallback answer | `max_steps` bounds the loop; generation errors propagate, other Agent errors are recorded and the loop continues | `ApiModel` defaults to three attempts for rate-limit errors only |
| Pi | `ModelRuntime` resolves stored credentials, environment variables, model config, or a runtime API-key override | Provider stream yields assistant text/tool calls; session records messages, executes tools, then calls `agent.continue()` | No pending tool results or queued work, or explicit abort | Session exposes stream/idle/retry state and preserves session entries | Separate agent-level retry and provider-level retry; context overflow uses compaction rather than ordinary retry |
| Current verifier | `AgentModelClient` receives no credential and only exposes `complete()` | Host owns the loop and re-feeds `tool` messages | Host terminal tool (`finish` or `report_uncertain`) returns a result | Host validates response shape, tool IDs, context/response sizes, duration, turns, and tool-call budgets | Intentionally no automatic model/tool/test retry |

## Context Assembly and Replay

The same abstract sequence appears in each runtime, but the persisted and provider-visible units differ:

```text
initial configuration
  -> system instructions + available tool declarations
  -> user/task input
  -> provider response
       -> assistant text
       -> reasoning/thinking, when the provider exposes it
       -> tool calls, each with a correlation ID
  -> host or SDK executes tools
  -> correlated tool results
  -> next request assembled from the chosen transcript projection
```

The important distinction is between four representations:

| Representation | Meaning |
| --- | --- |
| Runtime configuration | System prompt, tool definitions, model settings, permissions, and provider credentials. It is not necessarily stored as an ordinary user/assistant message. |
| Local transcript or memory | The records retained by the Agent runtime for replay, inspection, persistence, or resumption. |
| Provider request | The protocol-specific projection sent on one request. It may combine system instructions and tools into separate top-level fields, or render them as messages. |
| Provider response | The assistant output items and metadata returned by that request. A response may contain text, reasoning, tool calls, or a terminal answer. |

A tool result is not a new user task. It is a response correlated to a previous tool call. A continuation prompt, by contrast, is a new user-role message in the current verifier and exists only because the Host refuses to treat a no-tool assistant response as verification completion.

### Current verifier: full local transcript

The current Host builds the first request as:

```text
D  = [Host-bound tool definitions: name, dynamic description, input schema]
M0 = [ S(systemPrompt), U(userPrompt) ]
request 1 = complete(M0, D)
```

The strategy owns the role instructions and task evidence. It puts the source/target function labels, languages, requirement, analysis report, migration plan, and translation round into `userPrompt`; it does not put absolute roots or executable configuration there. The Host binds tools first, then derives `D` from those bound tools. [strategy task construction](../services/translation-verifier/src/strategies/single-agent/strategy.ts#L19-L84), [Host binding](../services/translation-verifier/src/host/runtime.ts#L45-L82).

For a non-terminal tool turn, the sequence is:

```text
M0 = [ S, U ]
A1 = assistant(content, toolCalls=[{ id, name, arguments }])
T1 = tool(toolCallId=id, content=serialized result)
M1 = [ S, U, A1, T1 ]
request 2 = complete(M1, D)
```

The Host appends the complete assistant response before executing calls. It parses the provider-neutral JSON argument string again, executes calls in order, and appends one `tool` message per successful or failed execution. A tool exception is therefore model-visible as a correlated tool result containing an error object. Unknown tools, invalid JSON arguments, parser failures, and tool execution failures all enter this same tool-result path after the completion itself has passed shape validation. [runtime append and execution](../services/translation-verifier/src/host/runtime.ts#L123-L179), [completion validation](../services/translation-verifier/src/host/runtime.ts#L192-L230).

If the model returns text without a tool call, the Host does not accept it as the verification result:

```text
Mn = [ ..., A(no tool calls) ]
Mn+1 = [ ..., A(no tool calls), U(continuePrompt) ]
request n+1 = complete(Mn+1, D)
```

`continuePrompt` is a synthetic user-role message. It is not a replacement for the original task and it does not reset the transcript. If the model calls `finish` or `report_uncertain`, the call must be the sole call in that turn. On successful terminal execution, the Host returns immediately and does not append a terminal tool result or make another model request. If terminal execution fails, the error is appended as a tool result and the model may continue. [terminal policy](../services/translation-verifier/src/host/runtime.ts#L148-L177), [terminal tool contract](../services/translation-verifier/src/host/tools/finish.ts#L151-L177).

The current verifier has no `reasoning` field in either `AgentMessage` or `AgentCompletion`. The only assistant fields are a string `content` and provider-neutral `toolCalls`; the only tool-result fields are a string content and a call ID. Consequently:

- The Host cannot inspect or replay provider-private reasoning.
- The Host cannot preserve a provider reasoning signature, encrypted thinking payload, or reasoning item ID.
- An adapter that receives reasoning must deliberately omit it or flatten it into `content`; it must not claim that the omitted reasoning is part of the next request.
- Adding reasoning later requires an explicit type and replay policy, including whether it is visible text, provider-only metadata, or an opaque continuation token.

The configured context budget currently checks `JSON.stringify(messages)`, so it covers the local message transcript but not the separately passed tool definitions. Response budget checks the serialized completion. This distinction matters when dynamic descriptions or schemas become large. [message port](../services/translation-verifier/src/host/model.ts#L1-L45), [context and response checks](../services/translation-verifier/src/host/runtime.ts#L134-L140) [../services/translation-verifier/src/host/runtime.ts#L192-L230).

### OpenAI Agents JS: typed items and optional server-side delta

OpenAI Agents JS separates the request envelope into `systemInstructions`, `input`, `tools`, model settings, and optional `conversationId` or `previousResponseId`. A string input is normalized to a user message; typed input can contain user and assistant messages, function calls, function-call results, reasoning items, and compaction items. [ModelRequest](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/model.ts#L545-L608), [protocol item types](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/types/protocol.ts#L365-L397) [https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/types/protocol.ts#L520-L660) [https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/types/protocol.ts#L810-L920].

For a local run, `prepareModelInputItems()` combines the caller's original input with generated output items, removes orphaned tool calls, and trims history at the latest compaction item. `getTurnInput()` uses the same projection for the current turn. The generated sequence can therefore look like:

```text
caller input
  -> assistant message / reasoning item / function_call
  -> function_call_result
  -> next assistant message or final output
```

The Runner then constructs a `ModelRequest` from the prepared instructions, input, and serialized tools. [input preparation](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/runner/items.ts#L630-L699), [request construction](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L1947-L1962).

A function call result preserves the original `callId`; provider converters render it as a tool message or function-call-output item. The Chat Completions converter explicitly flushes the assistant message, then emits `role: "tool"` with the matching `tool_call_id`. It also maps a reasoning item to the following assistant message's provider-specific reasoning field when the provider supports it. [Chat Completions history conversion](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-openai/src/openaiChatCompletionsConverter.ts#L300-L380) [https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-openai/src/openaiChatCompletionsConverter.ts#L505-L620).

Reasoning is not one universal text field. The core protocol stores a typed reasoning item with user-facing content, optional raw reasoning, and provider data. Model settings can choose reasoning context behavior (`auto`, `current_turn`, or `all_turns`), while `reasoningItemIdPolicy` controls whether a replayed reasoning item keeps its ID. These controls change what is sent on later requests; they do not turn private reasoning into ordinary user text. [reasoning item](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/types/protocol.ts#L810-L838), [reasoning settings](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/model.ts#L20-L55), [reasoning ID policy](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/runner/items.ts#L250-L330).

With `conversationId` or `previousResponseId`, `ServerConversationTracker` records which original and generated items the server has acknowledged. The next request includes initial items until acknowledged, then only generated items not already echoed by the server, plus any required supplemental items. This is a delta projection over the same logical transcript, not a different Agent conversation. [server conversation tracker](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/runner/conversation.ts#L370-L560).

### Claude Agent SDK: CLI-owned Anthropic transcript

The Claude Agent SDK is structurally different: `query()` starts or connects to a Claude Code process, and the SDK sends user input over the process transport. The published SDK types expose `Options.systemPrompt`, `Options.tools`, `Options.maxTurns`, `Options.resume`, and `Options.sessionStore`; the CLI, rather than the SDK caller, owns the detailed construction of the Anthropic request. The public Git checkout at tag `v0.3.282` does not include the CLI or SDK subprocess implementation, so the exact internal ordering of system prompt sections and API request fields cannot be proven from that checkout alone. [Options types in the published package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282), [SDK README](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/README.md#L1-L13).

The public boundary is nevertheless precise:

- `systemPrompt` is an option. It can be a custom string/array or a Claude Code preset with an append; `snapshot` controls whether the rendered prompt is recorded and reused on later requests and resume.
- `tools` is an option that restricts built-in tool names or disables them with an empty array. Permission callbacks such as `canUseTool` gate execution after a model tool call is selected.
- A submitted prompt is an `SDKUserMessage` whose `message` is an Anthropic `MessageParam`. The SDK also emits user messages for tool results; their content may contain `tool_result` blocks.
- An `SDKAssistantMessage.message` is shaped like an Anthropic `BetaMessage`. Its content blocks can contain text, `thinking`, and `tool_use`; streamed delivery may emit multiple assistant wrapper messages for one API response, sharing the message ID while delivering completed blocks.
- A `result` message is the turn boundary. It carries the final result, turn count, usage, and, in current releases, a structured `terminal_reason`; it is not itself an assistant message to replay as model input.

[system prompt and tool options](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282), [assistant message type](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282), [user/tool-result message type](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282), [result boundary and terminal reason](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282).

The public turn sequence is therefore best represented as:

```text
query(prompt, options)
  -> CLI builds system prompt and available tool set
  -> user MessageParam enters the session
  -> assistant BetaMessage content blocks stream
       [thinking] [text] [tool_use ...]
  -> CLI executes tools and emits user MessageParam tool_result blocks
  -> next assistant turn uses the CLI-owned session transcript
  -> result message closes the turn
```

Parallel tool calls remain correlated by their `tool_use` IDs. The changelog explicitly records fixes for preserving all parallel tool results in `getSessionMessages()`, so a consumer must not assume one tool result per assistant message or collapse parallel results into one uncorrelated string. [parallel result preservation](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L1038-L1045).

`sessionStore.append()` receives JSON-safe transcript entries after the local subprocess write. `sessionStore.load()` returns the full transcript for resume; the SDK materializes it to a temporary JSONL file and lets the subprocess use its existing resume path. This means the session store is a durable transcript mirror, not a second prompt builder. [published SessionStore contract](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282), [official session-store example](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/examples/session-stores/postgres/demo.ts#L22-L47).

For queued or side-question input, the public types distinguish message admission from assistant-turn triggering: `SDKUserMessage.shouldQuery = false` appends a user message without starting a turn, and queued messages can be folded into a later turn. Current type declarations also expose `priority` and progress events for client-originated `side_question` control requests. The exact side-question prompt projection is CLI-internal; the safe conclusion is that it is an additional session input/turn with its own correlation and retry/result events, not an alteration of the main verifier transcript. [SDK user message fields](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282), [side-question progress contract](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.282), [queued-message changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L895-L905).

### smolagents: memory-step reconstruction

smolagents persists an `AgentMemory` made of a system prompt and typed steps. A `TaskStep` contributes a user message. An `ActionStep` records the exact model input, model output, tool calls, observations, errors, and final action output. Its message projection emits the assistant output, a tool-call record, optional observation images, and a tool-response observation or error. `write_memory_to_messages()` starts with the system prompt and concatenates every step in order before each model call. [memory step types](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/memory.py#L20-L197), [memory reconstruction](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/agents.py#L750-L770).

A tool-calling action records model input before generation, records the returned `ChatMessage`, parses or normalizes tool calls, executes all returned calls, and stores observations on the same `ActionStep`. Multiple calls can execute in parallel, but observations are put back into memory in sorted call-ID order. The next step reconstructs the full message list from those memory fields. [tool-calling step](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/agents.py#L1277-L1345), [parallel tool result recording](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/agents.py#L1360-L1435).

smolagents' provider message model has explicit `system`, `user`, `assistant`, `tool-call`, and `tool-response` roles, but the memory projection is intentionally framework-shaped. It also does not define a separate provider-neutral `thinking` memory item: planning is represented as assistant text followed by a user instruction, while provider-specific reasoning can remain only in the raw `ChatMessage` returned by a model adapter. The model adapter can normalize these roles for the target API, so the persisted ActionStep and the wire-level messages are not necessarily byte-identical. A generation error is raised; other Agent errors are recorded as an observation-like error and the loop continues. [ChatMessage types](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/models.py#L70-L170), [error handling](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/agents.py#L584-L603).

### Pi: system-state replay plus typed content blocks

Pi's installed `pi-ai` package makes the context boundary explicit. `Context` accepts `systemPrompt`, `messages`, and `tools`; `normalizeContext()` creates a leading system message containing the prompt and tools. `SystemMessage` records later prompt sections and tool additions/removals, so replaying system messages reconstructs the current system prompt and tool set. Providers that do not support mid-conversation system messages receive a collapsed leading system message instead. [local `Context` and `TranscriptContext` types](/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts#L425-L453), [local transcript replay](/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js#L1-L103), [local system rendering](/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/text.js#L1-L31).

Pi's typed transcript stores assistant content as an ordered list of text, thinking, and tool-call blocks. A tool result stores the matching `toolCallId`, tool name, content, details, and `isError`. Thinking may include a `thinkingSignature`, including an opaque redacted payload that must be replayed for provider continuity. Thus Pi can preserve reasoning-related provider metadata without treating it as ordinary user-visible text. [local message types](/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts#L247-L387).

At request time, Pi resolves the transcript, obtains current tool declarations, and converts the typed history into the provider format. The OpenAI-compatible adapter can render thinking and tool-call blocks, parse streamed tool-call JSON, and emit a finalized assistant message only after those blocks are complete. This is a richer replay model than the verifier's current string-only assistant message. [local OpenAI-compatible stream implementation](/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js#L140-L240), [Pi agent-loop documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md#agent-loop).

## Verifier Turn Trace

For the current `single-agent` strategy, the complete logical trace is:

```text
Host resolves taskContext and binds tools
  |-- D: list/read/write/test/finish/report tool declarations
  |-- S: role instructions and terminal policy
  `-- U: source/target labels, requirement, supporting reports, translation round

Turn 1: complete([S, U], D)
  -> A1: assistant text and/or toolCalls
  -> if ordinary calls:
       execute each call
       append T1...Tn with matching toolCallId
       Turn 2: complete([S, U, A1, T1...Tn], D)
  -> if no calls:
       append U(continuePrompt)
       Turn 2: complete([S, U, A1, U(continuePrompt)], D)
  -> if sole terminal call:
       Host validates observed test state and returns terminal result

Every later ordinary turn repeats the same full-message projection.
The model never receives the Host's absolute roots, executable, or API key.
```

The strategy's `systemPrompt` is the stable role/policy layer. Its `userPrompt` is the task/evidence layer. Tool descriptions are neither layer: they are request-level declarations generated after Host binding. Model output becomes an assistant transcript item; tool execution becomes a correlated tool transcript item; a continuation is an explicit synthetic user item. This separation should be preserved when the real provider adapter is added. [strategy prompt layers](../services/translation-verifier/src/strategies/single-agent/strategy.ts#L51-L73), [request loop](../services/translation-verifier/src/host/runtime.ts#L123-L181).

The current port intentionally has no separate transcript event for streamed deltas, reasoning, usage, response ID, stop reason, or provider-native content blocks. The adapter should normalize those details at the boundary and retain only what the Host contract needs. If future verifier requirements include reasoning continuity, server-side conversation IDs, prompt caching, or provider-native compaction, the port must be extended first; those behaviors cannot be safely reconstructed from the current `content` and `toolCalls` fields.


## OpenAI Agents JS

### Authentication and provider boundary

`OpenAIProviderOptions` includes `apiKey`, `baseURL`, organization/project settings, or a preconfigured `openAIClient`. The provider rejects incompatible combinations such as both `apiKey` and `openAIClient`, and lazily creates an OpenAI client when first needed. Provider-specific options take precedence over the SDK-wide default client. [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-openai/src/openaiProvider.ts#L19-L38) [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-openai/src/openaiProvider.ts#L81-L107).

The default key getter returns an explicitly configured default key or loads `OPENAI_API_KEY`. This is a provider concern, not an Agent prompt concern. [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-openai/src/defaults.ts#L39-L55).

The core Runner also accepts a `modelProvider`, keeping model lookup and provider selection outside the Agent's task input. [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L315-L326) [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L641-L665).

### Loop and termination

The Runner's public contract states the loop precisely:

1. Invoke the Agent with input.
2. Stop when the Agent produces final output.
3. Start another loop with a new Agent after a handoff.
4. Otherwise execute tool calls and run the loop again.

Exceeding `maxTurns` raises a dedicated exception. [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L690-L703).

The implementation constructs a model request from instructions, input, serialized tools, and conversation state, calls the model, processes the response, executes tools, resolves the next step, and repeats unless the next step is final output, handoff, interruption, or another run-again step. [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L1946-L1969) [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a132f3887fd9cc440006/packages/agents-core/src/run.ts#L2075-L2168) [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L2170-L2205).

### Tool errors and retries

The Runner has explicit policy for a missing function tool: `raise_error` preserves a model-behavior failure, while `return_error_to_model` creates a model-visible tool error and allows recovery. A `toolErrorFormatter` can customize the message returned to the model. [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/run.ts#L401-L415) [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a132f3887fd9cc440006/packages/agents-core/src/run.ts#L433-L443).

Model request retry is a separate layer. `getResponseWithRetry()` reads `maxRetries`, retry policy, and backoff from model settings; when `maxRetries` is omitted it uses `0`. Aborts and unsafe streamed replay veto retries, and a failed attempt is surfaced when policy declines retry. [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/runner/modelRetry.ts#L909-L1003) [Source](https://github.com/openai/openai-agents-js/blob/00eef0cb84cc47814a48a132f3887fd9cc440006/packages/agents-core/src/runner/modelRetry.ts#L1153-L1288).

The relevant design lesson is to make retry policy explicit. A model request retry must not silently consume or bypass the Agent's turn budget, and retrying a request that may have been accepted requires replay-safety handling.

## Claude Agent SDK

### Published API shape

The official SDK README describes the package as a programmatic interface to Claude Code capabilities, including codebase understanding, file edits, command execution, and complex workflows. [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/README.md#L1-L13).

The official session-store examples use `query({ prompt, options })` as an async iterable. Callers consume messages with `for await`, inspect `system/init` for a session ID, and inspect `result` messages for the final result. The same example passes `maxTurns: 1` and resumes later with the returned session ID. [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/examples/session-stores/postgres/demo.ts#L22-L47).

The live demo explicitly requires `ANTHROPIC_API_KEY`, which confirms that authentication is an execution-environment concern rather than a query prompt field. [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/examples/session-stores/postgres/demo.ts#L1-L13).

### Permissions and termination signals

The official changelog documents an exact built-in tool allowlist through the `tools` option, including `tools: []` to disable built-in tools. It also documents current `result` fields such as `terminal_reason`, with values including `completed`, `aborted_tools`, `max_turns`, and `blocking_limit`; error result subtypes include `error_during_execution`, `error_max_turns`, and `error_max_budget_usd`. [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L978-L997) [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L1450-L1454).

The SDK also documents structured permission callbacks and explicit denial behavior in its changelog. In particular, a headless `query()` without `canUseTool` emits permission-denied events for auto-denied tool calls, and invalid `canUseTool` responses are rejected rather than silently treated as permission. [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L362-L363) [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L455-L456).

### Retry boundary

The changelog distinguishes transient API retry events from query termination. It records `api_retry` messages with attempt count, maximum retries, delay, and error status, and separately records `terminal_reason` and structured error results when the query ends. [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L978-L997) [Source](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9e477a178c370991ed87ca65b4c8631d390aea35/CHANGELOG.md#L1054-L1057).

The published checkout does not expose the SDK's internal subprocess loop, so this report does not infer details beyond the public stream, options, examples, and changelog. For the verifier, the useful contract is the separation of provider recovery, permission decisions, and final structured result messages.

## smolagents

### Model/client boundary

The official README constructs model objects with explicit `api_key` and `api_base` values, commonly sourcing the key from an environment variable. `OpenAIModel` stores those values in the model object and forwards them to the OpenAI-compatible request. [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/README.md#L106-L130) [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/models.py#L1646-L1689).

`ApiModel` also accepts a preconfigured client. That makes the model object the natural location for credentials, endpoint configuration, client construction, and transport retry policy. [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/models.py#L1138-L1187).

### Step loop and errors

`MultiStepAgent.run()` chooses a caller-provided `max_steps` or the Agent default, then either consumes `_run_stream()` internally or returns the stream to the caller. `_run_stream()` repeats action steps while the Agent has not produced a final answer and the step number is within the limit. At the limit it calls a max-step handler and emits a final answer step. [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/agents.py#L436-L538) [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/agents.py#L540-L637).

Generation errors are treated as implementation/model-generation failures and re-raised. Other `AgentError` failures are recorded on the action step and the loop continues, allowing the model to observe the failed step and try again. [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/agents.py#L594-L603).

### Retry behavior

`ApiModel` defaults to `retry=True`, constructs a retry controller with `RETRY_MAX_ATTEMPTS = 3`, and uses a rate-limit predicate. The predicate matches HTTP 429 and common rate-limit messages. The model's synchronous and streaming generation paths invoke the retry controller around the provider request. [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/models.py#L38-L41) [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/models.py#L1153-L1183) [Source](https://github.com/huggingface/smolagents/blob/227ef5e49ddd82339295939072f0223249aa8d38/src/smolagents/models.py#L1194-L1202).

The verifier should not copy this default because the current project decision is no automatic retry. It is still useful evidence that provider retry belongs in the model adapter and must have a count and predicate independent of the Agent turn budget.

## Pi Coding Agent

### Authentication and client injection

Pi documents a credential precedence order: runtime `--api-key`, stored `auth.json`, `apiKey` in `models.json`, then provider environment variables or ambient cloud credentials. It also supports custom auth and model paths through `ModelRuntime.create()` and a runtime API-key override through `setRuntimeApiKey(providerId, apiKey)`. [Source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#authenticate) [Source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts#L7-L34).

The installed runtime declaration exposes `getAuth`, `setRuntimeApiKey`, `stream`, `complete`, and `streamSimple` on `ModelRuntime`; the API key is therefore held in runtime/provider state and is not part of the Agent message type. Local evidence: `/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.d.ts:20-26,66-90`.

### Loop and session state

Pi's first-party documentation states that a submitted message is combined with the system prompt, active branch, tools, and model settings; the provider streams an assistant response; Pi records it, executes each tool call, records results, and starts another turn when tool results or queued messages require it. [Source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md#agent-loop).

The installed `AgentSession` implementation calls `agent.prompt(messages)`, then repeatedly calls `agent.continue()` while post-run handling or queued work requires another turn. It records finalized assistant and tool-result messages on `message_end`, making persisted transcript state distinct from the provider call itself. Local evidence: `/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:582-625,1078-1104`.

### Retry and overflow behavior

Pi's settings separate agent-level retry from provider-level retry. The documented defaults are enabled agent retry with `maxRetries: 3`, `baseDelayMs: 2000`, and a provider retry budget of `0`; the documentation recommends keeping provider retries at `0` unless they are explicitly required. [Source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#network-and-retries).

The installed session implementation retries only retryable assistant errors such as overload, rate limit, or server errors; context overflow is explicitly handled by compaction rather than ordinary retry. It increments a bounded retry counter, waits with exponential backoff, supports abort, and emits retry lifecycle events. Local evidence: `/Users/zen/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2627-2718`.

This is a useful operational model for the verifier even though the verifier intentionally chooses stricter no-retry semantics: classify retryable provider failures, bound them, make the retry observable, and never let a hidden retry change the meaning of the Agent's turn budget.

## Existing Workspace Design

### Current provider-neutral port

The verifier's `AgentModelClient` accepts only messages, tool definitions, and an optional `AbortSignal`, and returns `AgentCompletion`. Its comment explicitly assigns API keys, provider selection, request serialization, and response parsing to the caller that supplies the port. [Source](../services/translation-verifier/src/host/model.ts#L24-L45).

This is the right ownership boundary. The adapter can depend on provider SDKs or the existing HTTP client; strategy and tools should remain unaware of credentials and wire formats.

### Current Host loop

The Host creates the initial system/user transcript, sends the provider-neutral definitions, validates the completion, appends the assistant tool calls, executes each call, appends correlated tool results, and continues. A no-tool response receives a continuation prompt rather than being treated as a successful verification. A terminal tool must be the only call in its turn. [Source](../services/translation-verifier/src/host/runtime.ts#L123-L181).

The Host validates response object shape, response size, tool-call shape, and duplicate call IDs before execution. It parses tool arguments again through the Host-bound tool parser and converts tool exceptions into model-visible tool results. [Source](../services/translation-verifier/src/host/runtime.ts#L192-L240).

The run budget separately limits duration, turns, total tool calls, per-turn tool calls, context size, and response size. `maxTurns` is checked before each model request. [Source](../services/translation-verifier/src/host/agent.ts#L21-L37) [Source](../services/translation-verifier/src/host/agent.ts#L51-L109).

### Existing adaptation-service provider boundary

The adaptation service already has the shape required for a verifier adapter:

- `DeepSeekClientOptions` accepts a `ModelApiKey`, optional model config, an injectable request function, and request settings. [Source](../services/adaptation-service/src/deepseek-client.ts#L10-L16)
- `resolveModelApiKey()` resolves an `AsyncLocalStorage` request credential before an allowed fallback and rejects missing keys. [Source](../services/adaptation-service/src/model-credential.ts#L6-L15)
- `deepSeek-client.ts` selects the provider and endpoint, sends either OpenAI-compatible tool calls or Anthropic tool blocks, and returns a normalized completion. [Source](../services/adaptation-service/src/deepseek-client.ts#L59-L105)
- It rejects non-OK responses, invalid JSON, max-token truncation, invalid tool calls, and empty completions. [Source](../services/adaptation-service/src/deepseek-client.ts#L96-L105) [Source](../services/adaptation-service/src/deepseek-client.ts#L130-L147) [Source](../services/adaptation-service/src/deepseek-client.ts#L179-L216)
- The HTTP server scopes a request credential around the request handler instead of putting it in the workflow input. [Source](../services/adaptation-service/src/http-server.ts#L565-L571)

The existing default model configuration is `DEEPSEEK_API_BASE` with an HTTPS/HTTP validation step and `DEEPSEEK_MODEL`, defaulting to the current DeepSeek values. [Source](../services/adaptation-service/src/model-config.ts#L6-L19).

## Recommended Verifier Adapter Contract

The following is the smallest contract consistent with the evidence and current project constraints. This is a design recommendation, not an implementation in this report.

```ts
type TranslationVerifierModelOptions = {
  provider: "deepseek" | "openai" | "anthropic";
  apiKey: string | (() => string);
  apiBase?: string;
  model?: string;
  request?: typeof globalThis.fetch;
};

function createTranslationVerifierModelClient(
  options: TranslationVerifierModelOptions,
): AgentModelClient;
```

The concrete names may differ, but the ownership should remain:

- The caller or Host factory supplies provider configuration and a key resolver.
- The adapter resolves the key immediately before the request and never includes it in `AgentMessage`, `AgentTask`, tool descriptions, or error text.
- The adapter performs one request and one response parse. It does not execute tools and does not decide whether verification is complete.
- The adapter maps OpenAI-compatible and Anthropic wire formats into `AgentMessage`/`AgentCompletion`, preserving tool-call IDs and serialized JSON arguments.
- The Host remains the only component that executes tools, checks permissions, counts turns, observes tests, and accepts terminal results.
- A missing key is a configuration/authentication error; an HTTP error is a provider request error; invalid JSON or malformed tool calls are provider protocol errors; an invalid tool argument or failed tool execution is a model-visible tool result; exhausted Host budget is a run-limit error.
- No automatic retry is added initially. If retry is added later, it must be an explicit adapter option with a separate request-attempt budget and tests proving it does not silently increase `maxTurns`.

## Required Tests for the Real Adapter

1. With no key, the adapter rejects before issuing a request and the error does not contain a secret.
2. With a configured key, the request contains the expected endpoint, authorization header, provider-specific tool schema, and no path/cwd/API-key data in the prompt beyond the intended task context.
3. A non-OK response fails once, preserves the status classification, and does not retry.
4. Invalid JSON, an empty provider completion, a missing tool-call ID/name, and non-string tool arguments all fail closed.
5. A valid assistant tool call is normalized with its original ID and JSON argument text.
6. A tool result is sent back with the matching tool-call ID for both OpenAI-compatible and Anthropic wire formats.
7. A terminal call is accepted only through the Host loop and only when it is the sole call in that turn.
8. A model response with no tool calls follows the Host continuation policy and cannot silently produce a verification result.
9. The Host stops at `maxTurns` and does not make an additional model request.
10. A provider request failure, tool execution failure, and Host budget exhaustion remain distinguishable to the caller.
11. The deterministic fixture E2E remains network-free; a separate opt-in live-provider E2E is gated by an explicitly configured environment variable and is never part of the default test command.

## Decision

Proceed with a Host-owned provider adapter that reuses the existing adaptation-service credential and DeepSeek/OpenAI-compatible configuration conventions. Keep `AgentModelClient` provider-neutral, keep the existing Host loop authoritative, keep credentials outside task context, and preserve the current no-retry decision until a separately specified retry policy and test matrix exist.
