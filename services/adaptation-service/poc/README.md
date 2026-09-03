# Adaptation Service — Historical POC Scripts

These scripts predate the Analyzer → AnalysisReport → Translator workflow.
They are not part of the service, MCP, or VS Code execution paths and must not
be used as a production translation entry point. The old bidirectional
one-shot TypeScript POC has been removed to prevent bypassing the Agent
handoff.

## Replacement

Use the formal HTTP V2 workflow only when its exact route and every required
stage are available and the trusted Host supplies authoritative artifacts.
`POST /v1/adapt` and the adaptation MCP workflow are deprecated legacy
compatibility paths, not replacements for V2. The retained legacy path creates
a fresh Analyzer session, persists only `AnalysisReport`, starts a separate
Translator session from that artifact, then validates and previews a protected
patch.
