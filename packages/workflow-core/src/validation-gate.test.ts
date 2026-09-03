import { describe, expect, it } from 'vitest';
import {
  validationPolicySchemaVersion,
  type AdaptationResult,
  type ValidationPolicySnapshot,
  type ValidationRecord,
} from '@forexplore/contracts';
import {
  canApplyAdaptation,
  canApplyAdaptationForRoute,
  evaluateValidationGate,
  evaluateValidationPolicyGate,
} from './validation-gate';

function record(
  status: ValidationRecord['status'],
  required = true,
): ValidationRecord {
  return {
    id: `check-${status}`,
    label: '编译验证',
    status,
    required,
    summary: status,
  };
}

function adaptation(validation: ValidationRecord[]): AdaptationResult {
  return {
    strategy: 'translate',
    targetLanguage: 'C#',
    generatedCode: 'public void Run() {}',
    interfaceMappings: [],
    validation,
    files: [
      {
        path: 'Service.cs',
        status: 'modified',
        expectedOriginalSha256: 'a'.repeat(64),
        additions: 1,
        deletions: 1,
        hunks: [
          {
            header: '@@ -1,1 +1,1 @@',
            lines: [
              { type: 'remove', content: 'old' },
              { type: 'add', content: 'new' },
            ],
          },
        ],
      },
    ],
  };
}

describe('evaluateValidationGate', () => {
  it('allows passed and warned required checks', () => {
    expect(evaluateValidationGate([record('pass'), record('warn')])).toEqual({
      allowed: true,
      blockers: [],
    });
  });

  it.each(['fail', 'unverified'] as const)('blocks required %s checks', (status) => {
    const result = evaluateValidationGate([record(status)]);
    expect(result.allowed).toBe(false);
    expect(result.blockers).toHaveLength(1);
  });

  it('does not allow an adaptation without evidence', () => {
    expect(canApplyAdaptation(adaptation([]))).toBe(false);
  });

  it('allows a reviewed patch only after required evidence passes', () => {
    expect(
      canApplyAdaptation(adaptation([record('pass'), record('unverified', false)])),
    ).toBe(true);
  });
});

const routePolicy: ValidationPolicySnapshot = {
  schemaVersion: validationPolicySchemaVersion,
  id: 'gleam-elixir-policy',
  routeId: 'gleam-to-elixir-translate',
  routeVersion: '1.0.0',
  checks: [
    {
      id: 'behavior-parity',
      label: 'Behavior parity',
      phase: 'behavior',
      required: true,
      verifierId: 'beam-verifier',
      verifierVersion: '1.2.0',
    },
    {
      id: 'format',
      label: 'Formatting',
      phase: 'format',
      required: false,
      verifierId: 'mix-format',
    },
  ],
};

function policyRecord(overrides: Partial<ValidationRecord> = {}): ValidationRecord {
  return {
    id: 'behavior-parity-record',
    policyCheckId: 'behavior-parity',
    routeId: routePolicy.routeId,
    routeVersion: routePolicy.routeVersion,
    label: 'Behavior parity',
    phase: 'behavior',
    verifierId: 'beam-verifier',
    verifierVersion: '1.2.0',
    subjectHash: 'f'.repeat(64),
    status: 'pass',
    required: false,
    summary: 'Independent behavior suite passed.',
    ...overrides,
  };
}

describe('evaluateValidationPolicyGate', () => {
  it('turns a missing required verifier into an explicit unverified blocker', () => {
    const result = evaluateValidationPolicyGate(routePolicy, []);
    expect(result.allowed).toBe(false);
    expect(result.missingCheckIds).toEqual(['behavior-parity']);
    expect(result.blockers[0]).toMatchObject({
      policyCheckId: 'behavior-parity',
      status: 'unverified',
      required: true,
      failureReason: 'required-validation-missing',
    });
  });

  it('does not accept a pass emitted by the wrong verifier', () => {
    const result = evaluateValidationPolicyGate(routePolicy, [
      policyRecord({ verifierId: 'implementation-agent' }),
    ], { subjectHash: 'f'.repeat(64) });
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]?.failureReason).toBe('validation-verifier-mismatch');
  });

  it('allows a non-Java/C# route only with policy-bound evidence', () => {
    const validation = [policyRecord()];
    const result = evaluateValidationPolicyGate(
      routePolicy,
      validation,
      { subjectHash: 'f'.repeat(64) },
    );
    expect(result.allowed).toBe(true);
    expect(result.evaluatedRecords[0]?.required).toBe(true);
    expect(canApplyAdaptationForRoute({
      files: adaptation(validation).files,
      validation,
    }, routePolicy, { subjectHash: 'f'.repeat(64) })).toBe(true);
  });

  it('fails closed when a policy declares no required verifier', () => {
    const result = evaluateValidationPolicyGate({
      ...routePolicy,
      checks: routePolicy.checks.map((check) => ({ ...check, required: false })),
    }, [policyRecord()]);
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]?.failureReason).toBe('validation-policy-has-no-required-checks');
  });
});
