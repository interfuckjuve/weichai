# Repository Structure

## Dependency direction

```text
web
    |            |                 |                 |
    v            v                 v                 v
workflow-core <- mock-adapters  workspace-adapters  seekdb-adapter
    |            |                 |                 |
    +------------+--------v--------+--------v--------+
                         contracts

seekdb-adapter -> retrieval-service -> SeekDB
```

`contracts` is the stable shared boundary. `workflow-core` controls when an
operation happens but does not decide how retrieval, adaptation, or backfill is
implemented. Adapters implement those ports. The web app renders state and
forwards user decisions.

## Composition root

`apps/vscode-extension` is the primary runtime composition root. It owns the
editor target, trusted write-back, and calls to the local services.
`web/src/main.tsx` is a standalone prototype composition root. It selects
the concrete workflow adapters and loads the module tree through
`ModuleSymbolPort`, then injects both into `App`. Feature components depend only
on contracts and workflow-core, so replacing the fixture workspace provider or
mock workflow adapters does not require changes to the workflow UI. When
`VITE_RETRIEVAL_API_URL` is configured, only `CodeSearchPort` is replaced by
the SeekDB HTTP adapter.

## Ownership boundaries

| Path | Responsibility |
| --- | --- |
| `apps/vscode-extension` | Primary VS Code extension application and trusted write-back host |
| `web` | Standalone React workflow prototype |
| `packages/contracts` | Cross-module request and result types |
| `packages/workflow-core` | Workflow state, transitions, and ports |
| `packages/workspace-adapters` | Workspace discovery and module-symbol implementations |
| `packages/mock-adapters` | Explicitly non-production demonstrations |
| `packages/seekdb-adapter` | HTTP implementation of `CodeSearchPort` |
| `services/code-indexer` | Repository and symbol indexing |
| `services/retrieval-service` | SeekDB storage, candidate retrieval, and ranking |
| `services/adaptation-service` | Translation, mapping, patching, validation |
| `fixtures` | Target workspaces and cross-language code corpus fixtures |

Package public APIs are exported from each package's `src/index.ts`. Consumers
should not import private files through relative paths across package
boundaries.
