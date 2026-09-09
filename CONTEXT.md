# ForeXplore

ForeXplore reuses evidence from historical enterprise implementations to build required behavior in a target system. These terms distinguish reuse decisions from evidence used to verify a migration.

## Language

**Reuse Classification**:
The Analyzer's task-scoped assessment that a retrieved implementation is directly reusable, requires adaptation, or is not applicable to the requested target behavior. It informs test design but does not establish that any generated expectation or implementation is correct.
_Avoid_: Test verdict, execution permission

**Single-Agent Baseline**:
A single test agent that autonomously carries out either differential verification or target-only verification in the actual project copies. It measures one agent's end-to-end verification effectiveness and does not require simulated Agent1-to-Agent2 handoffs or the multi-agent test-data protocol.
_Avoid_: Agent1 and Agent2 inside one session, legacy smoke implementation

**Reuse Applicability**:
The extent to which a retrieved implementation contributes usable behavior, structure, or engineering knowledge to the selected target requirement. Partial applicability does not imply that every source behavior should be preserved.
_Avoid_: Search accuracy, source correctness

**Reference Suitability**:
Whether a source behavior is suitable as a comparison reference for the selected target requirement. A mature, correctly implemented historical behavior can still be unsuitable for a different target requirement.
_Avoid_: Repository trust, execution permission, universal correctness

**Source Observation**:
A recorded outcome of actually executing the selected source implementation on a specified input. An inferred or desired outcome is not a source observation.
_Avoid_: Expected result without provenance

**Requirement-Derived Expectation**:
An expected target behavior derived from user requirements, target contracts, and relevant analysis or existing tests. Its derivation is distinct from observing either implementation, and may remain uncertain when the requirement is incomplete.
_Avoid_: Measured source output, target output used as its own answer

**Differential Verification**:
Verification that executes both implementations and compares corresponding behavior where the source is suitable as a reference. Agreement is evidence about the tested cases, not proof that the source satisfies every business requirement.
_Avoid_: Proof of business correctness

**Target-Only Verification**:
Verification that executes the target against requirement-derived expectations without using source execution as its behavioral reference. It does not imply that historical code or analysis has no reuse value.
_Avoid_: Translation from scratch, source correctness assessment

**Translation-Implementation Black-Box Verification**:
Verification whose initial target tests are designed without access to the generated implementation under test. Source implementations and existing target contracts may inform test design; later implementation-aware diagnosis is an explicit exception, so the entire workflow is not strictly black-box.
_Avoid_: No source-code access, target-only verification, strictly black-box workflow

**Verification Strategy**:
An arrangement of test design, execution, and assessment work for a migration task. A single-agent baseline and a split-agent strategy can pursue the same verification objective with different scheduling and information handoffs.
_Avoid_: A different product requirement for each agent count
