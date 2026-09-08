# Real Repository Capacity Verification

The build and main-project context verification passed. This measures capacity with local 64-dimensional hash vectors; semantic quality is tested separately with the configured embedding model.

## Corpus and Coverage

- Real VS Code checkout: `/mnt/e/CS/devsys/vscode/src`.
- Git source revision: `c5f02db50896ef310d3c909628e651675644fcef`.
- Index revision: `vscode-scale@scale-1788853146362`.
- Dedicated database: `forexplore_task_scale_20260908`.
- 7,708 UTF-8 files; 97,285,176 bytes; 2,356,695 physical lines.
- Source role alone: 1,696,036 lines in 5,445 files. Tests: 649,069 lines. Existing generated source: 10,431 lines. Other/configuration: 1,159 lines.
- No files were copied or generated to inflate the corpus.
- 287,471 declarations; 117,420 syntactic import/export/project-reference edges.
- Parsing: 7,691 parsed, 10 partial, 7 unsupported; 12 visible diagnostics.
- 3 projects, 1,541 structural modules, 7,708 / 7,708 assigned files.
- Projection: 287,471 symbol documents, 300,121 complete-source fragments, 4,623 summary documents.

## Measured Resources and Time

| Measurement | Result |
| --- | ---: |
| Snapshot, isolated parsing and structural merge | 385.157 s |
| Structural persistence | 868.734 s |
| Base search projection | 784.169 s |
| Module modeling, publication and projection | 24.304 s |
| Node parent process maximum RSS | 1,488,539,648 bytes |
| Sampled maximum JS heap | 1,035,428,944 bytes |
| Maximum parser worker RSS | 134,520,832 bytes |
| Recycled parser workers | 121 |
| Retained full-source Map entries | 0 |

Workers process at most 64 files or 8 MiB of source per process with a 512 MiB JS heap. The measured run allowed 8 MiB per file; the reproducible script now uses the production 4 MiB limit. The largest actual file was 1,377,567 bytes, below both limits. Structural rows use batches of 2,000; source rows also have 64-row / 2 MiB limits. Projection batches use 2,000 documents / 4 MiB.

Build time includes database log throttling. The initial 8 GiB SeekDB redo quota reached about 90% usage and produced `ob clog disk hang`. Online changes to 12 GiB and then 24 GiB restored commit time from 4-16 seconds to 3-5 milliseconds. Docker settings confirmed the data disk is on `E:\CS\Docker\DockerDesktopWSL`, with about 121 GiB free before the final adjustment. No container restart or user data deletion occurred. One `ALTER SYSTEM MINOR FREEZE` succeeded, but the old base LSN did not advance; checkpoint reclamation was not proven fixed.

## Main-Project Context

The original script selected a four-file test project by array position. Those query results are retained as rejected evidence in `initialWrongScopeQuery`. The corrected verifier chooses the largest project, containing 7,702 files, and uses the unchanged requirement `CodeEditorWidget executeEdits editor text model`.

- Main-project hybrid symbol search: 669 ms, 10 hits.
- Authoritative symbol lookup and source slice: 53 ms.
- Complete Task retrieval: 4,955 ms, 10 results, 17 source evidence items, 4 files, 260 source lines.
- Independent tokenizer count: 7,813 / 8,000 tokens.
- Required implementation: `CodeEditorWidget.executeEdits`, `vs/editor/browser/widget/codeEditor/codeEditorWidget.ts`, range `1282:2-1314:3`, 1,093 characters, untruncated.
- Original disk-file SHA, exact range text, whole-method range and tokenizer assertions all passed.
- Whole-index/list-files/list-symbols/list-dependencies/list-documents APIs were replaced with throwing stubs during online queries; no full-index hydration occurred.

The same complex query originally took about 19-20 seconds. Equivalent project filtering via a full-text `JOIN files` selected a hash join and reduced each full-text channel from 8-10 seconds to approximately 1.2 seconds. Query text, project boundaries, candidate budgets and embeddings were preserved. ID-and-score candidate selection followed by bounded source hydration also limits data transfer, but was not the main speedup.

The returned packet is explicitly `partial`: dependency resolution and context budgets leave recorded gaps. The required method itself is complete. These measurements do not establish ten-million-line capacity, a complete semantic call graph, or million-line incremental rewrite performance. Structural metadata arrays still scale with repository size. Database/model memory is outside the reported Node process RSS.

## Reproduce

```bash
TASK_SCALE_DATABASE=forexplore_task_scale_unique_run \
  node --import tsx --max-old-space-size=2048 scripts/verify-task-indexing-scale.mts
```

The script refuses to overwrite an already published run. To repeat only the strong main-project query checks against this built snapshot:

```bash
TASK_SCALE_VERIFY_REVISION=scale-1788853146362 \
  node --import tsx --max-old-space-size=2048 scripts/verify-task-indexing-scale.mts
```

Detailed numeric evidence, rejected initial scope results, recovery events and the final strong assertions are in `task-indexing-scale-20260908.json`.
