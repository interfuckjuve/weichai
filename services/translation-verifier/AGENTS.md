# Translation Verifier Agent Instructions

This directory contains a new implementation of `translation-verifier`. Treat `services/translation-verifier-reference` as a read-only behavioral reference. Use it to understand expected outcomes and fixtures, but do not copy its directory structure or compatibility layers.

## Responsibilities

### `workflow`

`workflow` owns the overall verification flow:

- Define the end-to-end phases and their order.
- Validate the operation-level input before execution.
- Start and finish a verification run.
- Pass data between phases and assemble the final result.
- Decide what constitutes a completed or failed run at the application level.

`workflow` does not contain agent prompts, tool implementations, or agent-specific scheduling logic.

### `strategy`

`strategy` owns agent scheduling:

- Select the agents and tool capabilities needed for the strategy.
- Pass task context to the Host, including the languages and logical source/target function paths.
- Do not construct tool descriptions or bind project roots, test roots, runners, executables, or other filesystem/test permissions.
- Convert agent results into strategy-level results for `workflow`.

`strategy` does not implement an agent's role, tool access, workspace manipulation, or low-level execution behavior.

### `host`

`host` owns individual agent responsibilities and execution capabilities:

- Define the tool descriptions from Host-injected task context.
- Bind source and target project roots, test roots, runners, and test commands.
- Enforce workspace, command, file, and artifact boundaries.
- Execute the agent and return an observed result, failure, or artifact.

`host` does not choose the overall verification strategy, schedule unrelated agents, or own workflow phase transitions.

## Dependency Direction

Keep the dependency direction one-way:

```text
workflow -> strategy -> host
```

A lower layer must not import a higher layer. `host` must not import `workflow`; `strategy` must not import workflow orchestration. Shared types should stay small and should describe data, not control the flow.

## Implementation Rules

- Start with one concrete verification flow and the smallest public entry point that satisfies its tests.
- Add a new abstraction only when a current requirement cannot be implemented clearly without it.
- Keep orchestration in `workflow`, scheduling in `strategy`, and agent execution in `host`.
- Keep behavior tests focused on public outcomes. Keep unit tests close to the layer they verify.
- Use the reference module to recover behavior, not to preserve its APIs, file layout, or internal abstractions.
- Do not add compatibility wrappers for the reference module unless a current caller explicitly requires them and the requirement is tested.
- Do not introduce multiple strategies, durable workflow state, projections, receipts, or generic role graphs before a concrete use case requires them.

A change is complete only when the relevant behavior tests pass, the dependency direction remains `workflow -> strategy -> host`, and each changed responsibility has one clear owner.
