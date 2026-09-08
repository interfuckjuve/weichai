import type {
  SideFile,
  SmokeMode,
  VerifierLanguage,
} from "./differential-test-types.js";
import type { VerificationInput } from "../../schemas/verification-types.js";
import { resolveVerificationPolicy } from "../../schemas/verification-assessment.js";

export interface SmokeTaskInput {
  requirement: string;
  analysisReport?: string;
  verificationPolicy?: VerificationInput["verificationPolicy"];
  source: {
    language: VerifierLanguage;
    root?: string;
    candidatePath?: string;
    files?: SideFile[];
  };
  target: {
    language: VerifierLanguage;
    className: string;
    method: string;
    isStatic: boolean;
    root?: string;
    file?: string;
  };
}

export function buildSmokeTaskPrompt(
  input: SmokeTaskInput,
  mode: SmokeMode = "verify-only",
): string {
  const policy = resolveVerificationPolicy(input);
  const differential = policy.mode === "differential";
  const sides = differential ? "BOTH source and target" : "target ONLY";
  return `You are a behavior verification agent. Verification mode: ${policy.mode} (Host-selected; never change it).

REQUIREMENT
${input.requirement}

HOST-CONFIRMED INDEPENDENT TEST BASIS
${policy.testBasis ?? "MISSING: do not invent a basis or claim successful verification."}

${
  differential
    ? `SOURCE SIDE (reference, READ-ONLY; not an absolute oracle)
- language: ${input.source.language}
- project root: ${input.source.root ?? "see EXECUTION CONTEXT"}
- candidate file: ${input.source.candidatePath ?? input.source.files?.[0]?.relativePath ?? "browse"}
${input.analysisReport ? `ANALYZER REPORT (context only)\n${input.analysisReport}` : ""}
`
    : "The reference is not accepted. Do not read, inspect, execute, or assess reference code. source must be null and sourceAssessment must be not_checked."
}
TARGET SIDE (translated artifact under test, READ-ONLY)
- language: ${input.target.language}
- class: ${input.target.className}
- method: ${input.target.method} (${input.target.isStatic ? "static" : "instance"})
- project root: ${input.target.root ?? "see EXECUTION CONTEXT"}
- file: ${input.target.file ?? "browse"}

WORKFLOW (${mode})
1. Read only the permitted project(s). Design normal, boundary, and error cases from the Host-confirmed basis.
2. Write runners for ${sides}; record complete files in runnerFiles, including driver entries.
3. Compile and run ${sides} only through the verifier-command proxy. Repair erroneous runners, never fabricate output. A dependency/build failure is not proof of a code bug.
4. Each run must print JSON: an array of CaseResult objects, or {"cases": [CaseResult, ...]}. Do not replace actual invocation with hard-coded observations.
5. Bind each case to real successful run commandIds and copy observed CaseResult values exactly from stdout.
6. Derive an expected CaseResult from the independent basis for each case. Copy the exact Host basis into requirement.basis. For explicitly permitted representation differences (such as language-specific exception names), record expectedBySide overrides and explain them in reasoning; never invent an exception to the requirement to fit observed code. Judge each permitted side independently against its expectation. Matching outputs alone prove neither side correct; both may have the same bug. A source bug must not be replicated in the target.
7. bug_found requires an executed observation contradicting requirement.expected; no_bug_observed requires an executed observation matching it. Use suspected_bug for unsupported suspicions and inconclusive when no conclusion is possible. sourceIssues are annotations, never confirmed findings.
8. ${mode === "verify-only" ? "Never modify the target implementation. rounds must be 0 and targetFiles empty. There are no target repair rounds." : "Diagnostic mode only: propose targetFiles repairs with at most 2 rounds; never use this mode for write-back decisions."}
9. Write report.json in the working directory and STOP. If unable to finish, still write the available observations and explain the missing evidence.

SANDBOX CONSTRAINTS
Project roots are READ-ONLY. Write only under the permitted dedicated runner directories and the agent working directory. Never edit, rename or delete protected code. Bash permits exactly the verifier-command form in EXECUTION CONTEXT, not direct toolchain or shell invocations.

REPORT CONTRACT
{
  "converged": boolean,
  "steps": nonnegative integer,
  "rounds": ${mode === "verify-only" ? "0" : "nonnegative integer"},
  "cases": [{
    "caseId": string, "intent": string,
    "source": ${differential ? "CaseResult" : "null"}, "target": CaseResult,
    "sourceAssessment": ${differential ? '"bug_found"|"no_bug_observed"|"suspected_bug"|"inconclusive"' : '"not_checked"'},
    "targetAssessment": "bug_found"|"no_bug_observed"|"suspected_bug"|"inconclusive",
    "requirement": {"basis": "exact Host-confirmed test basis", "expected": CaseResult, "expectedBySide"?: {${differential ? '"source"?: CaseResult, ' : ""}"target"?: CaseResult}},
    "commandIds": {${differential ? '"source": "source run commandId", ' : ""}"target": "target run commandId"},
    "mechanical": "pass"|"fail"|"divergent",
    "decision": "pass"|"translation-bug"|"accepted-diff"|"unclear",
    "reasoning": string
  }],
  "targetFiles": [],
  "runnerFiles": [{"side": ${differential ? '"source"|"target"' : '"target"'}, "language": "Java"|"C#"|"Python"|"TypeScript", "files": [{"path": "safe relative path", "content": string}]}],
  "sourceIssues": [],
  "executions": [{"side": ${differential ? '"source"|"target"' : '"target"'}, "phase": "compile"|"run", "commandId": string, "exitCode": nonnegative integer or null, "durationMs": nonnegative integer}],
  "summary": string
}
CaseResult is {"caseId": string, "outcome": "return", "returnValue": TypedValue} or {"caseId": string, "outcome": "exception", "exceptionType": string, "exceptionMessage"?: string}.
TypedValue uses type string, number, boolean, null, list, or map with a value of that type. All numeric language types use "number". Lists/maps recursively contain TypedValue.
Decision is deprecated compatibility: translation-bug only for target bug_found; unclear for inconclusive/suspected cases; pass or accepted-diff otherwise. Per-side assessments are authoritative, including source-only and both-side bugs.

EXECUTION EVIDENCE CONTRACT
Copy commandId/side/phase/exitCode/durationMs from commands.jsonl after each proxied command. Include successful compile AND run for every required side. Each case's commandIds must reference its actual run and match its stdout observation. Failed commands must not be claimed as successful evidence.

TASK TIMING MARKERS (optional, never evidence)
Emit standalone assistant lines [VERIFIER_STEP] {"name":"explore","event":"start"} and {"name":"explore","event":"end"} around actual work. Use lowercase names such as design-cases, write-runners, execute-tests, judge, finalize-report. Never invent tasks or timestamps.

TERMINATION
Once report.json is written, emit the finalize-report end marker and stop; do not perform further work.`;
}
