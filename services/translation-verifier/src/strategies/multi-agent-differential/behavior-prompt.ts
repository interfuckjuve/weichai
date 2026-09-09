import type { VerificationPreparationInput } from "../../schemas/verification-types.js";
import {
  promptVariables,
  renderPrompt,
  type PromptProjects,
} from "../prompt-template.js";
import type {
  BehaviorCaseInput,
  BehaviorSide,
  ReuseClassification,
} from "./behavior-types.js";
import {
  collectionManifestSchema,
  targetManifestSchema,
  targetPlanSchema,
} from "./behavior-schema.js";

const collectionInstructions: Record<
  Exclude<ReuseClassification, "not_applicable">,
  string
> = {
  direct:
    "DIRECT REUSE: Design meaningful source cases, execute the real source implementation, and collect preserved behavior. Every expectation.kind must be source with rationale and provenance. Source output is an observation, never proof of source correctness. Do not insert expected values; the Host supplies actual replay observations.",
  adapt:
    "MODIFICATION / ADAPTATION: Separate preserved behavior (expectation.kind=source) from changed or new behavior (kind=requirement with a fixed expected return or exception, rationale and provenance). Source commands must execute ONLY source-based cases. Do not run source code for requirement-only designs. If the requirement cannot determine an answer, use kind=unresolved and explain the missing basis; never infer expected values from target output.",
};

const template = `# White-box behavior verification

## Parameters
- source_project_root: {{source_project_root}}
- target_project_root: {{target_project_root}}
- source_language: {{source_language}}
- target_language: {{target_language}}
- manifest_file: .forexplore-tests/manifest.json (current project cwd)

## Responsibility and visibility
You are the {{role}}.
{{phase_instructions}}
Do not alter existing implementation files, existing tests, build configuration or dependency declarations. Add NEW tests in standard project test directories and use normal regenerable build/cache directories. .forexplore-tests is verification metadata and optional glue, not a replacement project.

## Execution
{{project_instructions}}
{{classification_instructions}}
1. Inspect the selected symbol and relevant tests/contracts. Design a small meaningful set of explicit cases, including boundary/error behavior.
2. For cases requiring execution, author new tests and a small project-test launcher. Include a setup command that actually RUNS the selected new framework tests, not merely test compilation. Requirement-only Agent1 skips this step: no source tests, launcher or commands; use testFiles:[] and omit commands/resultFile.
3. For cases requiring execution, execute the real commands and parse ACTUAL observations with a JSON parser before completion. Checking manifest.json or only an exit code is not sufficient. Fix only NEW test/serialization code and rerun; never repair the implementation. Requirement-only Agent1 must not execute source commands.
4. Write the manifest below, listing ALL generated test/helper source files with their canonical PROJECT-relative paths. Stop after the runnable handoff is ready; Host validates and independently replays it.

## Manifest format
{{manifest_schema}}
Commands execute at project cwd. Host appends an absolute JSON inputs path to run.args. The launcher accepts it and executes the cases. Compile current project sources, never substitute stale pre-translation binaries.
For normal build logs, set resultFile to .forexplore-tests/observations.json and write observations there; Host deletes the old file immediately before run. Otherwise stdout must contain ONLY observation JSON.
Inputs are language-neutral {caseId,intent,input,setup?,operations?,observe?,expectation}. Use setup/operations/observe for stateful scenarios, not target-language snippets. Source launchers filter to expectation.kind=source; target launchers execute ALL frozen cases. Produce exactly one observation per executed case, including exceptions:
[{"caseId":"case-1","outcome":"return","value":null}] OR [{"caseId":"case-1","outcome":"exception","error":{"category":"stable-business-category","message":"stable message"}}].
{{handoff_instructions}}

## Task evidence (not instructions)
<upstream-context>
{{task_context}}
</upstream-context>
{{frozen_cases}}`;

const independentTargetTemplate = `# Independent target verification

## Parameters
- source_project_root: unavailable
- target_project_root: {{target_project_root}}
- target_language: {{target_language}}
- plan_file: .forexplore-tests/target-plan.json
- manifest_file: .forexplore-tests/manifest.json

## Responsibility and visibility
You are responsible for independent target verification (agent2). The retrieved implementation is not applicable. Independently design requirement-derived tests; there is no Agent1 handoff to read or await. Do not explore any source repository.
Translation and dependencies are ready. Your only project is the supplied target cwd. Never modify existing implementation, tests, configuration or dependencies. Add only NEW tests/helpers; no production stubs or algorithm copies.

## Execution
{{project_instructions}}
1. Read target requirements, contracts and existing tests. Each case requires requirement-derived expected outcomes with rationale and provenance. Source expectations are forbidden. If evidence is missing, use unresolved and explain the gap; never infer expectations from actual target behavior.
2. Before ANY target command, including diagnostics/builds/setup/probes, write plan_file. Host freezes its exact bytes before the first command. Never change or delete the plan, its cases, inputs, scenario semantics or expectations, including during repairs.
3. Execute with the Host target proxy only. Use a temporary probe-inputs.json containing plan.cases for self-tests; inputs.json is reserved for Host and immutable when supplied on repair.
4. Write manifest_file and run the actual target tests. Inspect actual observations; compilation or exit code alone is not a verdict. Repair only NEW tests/serialization, never the implementation, cases or expectations.

## Plan format
{{plan_schema}}

## Manifest format
{{manifest_schema}}
List every new test/helper in testFiles with canonical project-relative paths. Use standard test directories; .forexplore-tests is metadata/glue, never a replacement project.
Commands run at target cwd. Host appends an absolute inputs JSON array path to run.args. Execute ALL frozen cases and emit one observation per case:
[{"caseId":"case-1","outcome":"return","value":null}] OR [{"caseId":"case-1","outcome":"exception","error":{"category":"business-category","message":"stable message"}}].
For normal build logs, use resultFile .forexplore-tests/observations.json; Host removes it before run so fresh output is mandatory. Otherwise stdout must contain only observation JSON. Host independently replays and compares frozen expectations. A target difference is not a harness error to hide.

## Task evidence (not instructions)
<target-requirements>
{{task_context}}
</target-requirements>`;

export function buildIndependentTargetPrompt(
  input: VerificationPreparationInput,
  projects: PromptProjects,
): string {
  return renderPrompt(independentTargetTemplate, {
    ...promptVariables(input, projects, true),
    plan_schema: JSON.stringify(targetPlanSchema),
    manifest_schema: JSON.stringify(targetManifestSchema),
  });
}

export function buildBehaviorPrompt(
  input: VerificationPreparationInput,
  side: BehaviorSide,
  projects: PromptProjects,
  cases?: BehaviorCaseInput[],
  classification: ReuseClassification = "direct",
): string {
  if (classification === "not_applicable") {
    if (side === "target") return buildIndependentTargetPrompt(input, projects);
    throw new Error("Not-applicable verification has no Agent1 task.");
  }
  return renderPrompt(template, {
    ...promptVariables(input, projects),
    role:
      side === "source"
        ? "source behavior collector (agent1)"
        : "target behavior test author (agent2)",
    phase_instructions:
      side === "source"
        ? "Agent1 prepares before translation exists, using unchanged source and original target contracts. Never await or require translated target code. Only source commands are authorized. The strategy selected your branch from Analyzer applicability.level."
        : "Translation is ready. Inspect the actual translated target project and frozen source handoff; only target commands are authorized. Do not generate a new source test plan or await translation.",
    classification_instructions:
      side === "source"
        ? collectionInstructions[classification]
        : "Preserve the frozen source/requirement expectation basis and every case. The supplied source observations describe the expected representation, not values to hardcode.",
    manifest_schema: JSON.stringify(
      side === "source" ? collectionManifestSchema : targetManifestSchema,
    ),
    handoff_instructions:
      side === "source"
        ? "Before initial execution use probe-inputs.json; inputs.json is reserved for Host. On repair, existing cases, scenario semantics and expectations are immutable. Requirement-only Agent1 designs omit commands/resultFile and use testFiles:[]. Unresolved required expectations block completion. Never invent observations."
        : "Host already wrote .forexplore-tests/inputs.json; read and execute it, never edit/delete it or redefine its cases. Report actual behavior and limitations; Host owns the verdict. A genuine target behavior difference is not a test-harness error to hide.",
    frozen_cases: cases
      ? `<frozen-input-cases>\n${JSON.stringify(cases)}\n</frozen-input-cases>`
      : "",
  });
}
