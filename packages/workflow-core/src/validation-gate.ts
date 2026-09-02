import {
  validationPolicySchemaVersion,
  type AdaptationResult,
  type ValidationPolicyCheck,
  type ValidationPolicySnapshot,
  type ValidationRecord,
} from '@forexplore/contracts';

export interface ValidationGateResult {
  allowed: boolean;
  blockers: ValidationRecord[];
}

export interface ValidationPolicyGateContext {
  /** Exact patch/source-bundle hash which every policy record must bind to. */
  subjectHash?: string;
}

export interface ValidationPolicyGateResult extends ValidationGateResult {
  evaluatedRecords: ValidationRecord[];
  missingCheckIds: string[];
}

function validationPolicyIsStructurallyValid(policy: ValidationPolicySnapshot): boolean {
  if (
    policy.schemaVersion !== validationPolicySchemaVersion ||
    !policy.id.trim() ||
    !policy.routeId.trim() ||
    !policy.routeVersion.trim()
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const check of policy.checks) {
    if (!check.id.trim() || !check.label.trim() || !check.verifierId.trim() || ids.has(check.id)) {
      return false;
    }
    if (check.verifierVersion !== undefined && !check.verifierVersion.trim()) return false;
    ids.add(check.id);
  }
  return true;
}

/**
 * A patch is eligible for human-confirmed write-back only when it carries
 * evidence and every required check is at least usable. This deliberately does
 * not turn a compiler pass into a business-correctness claim.
 *
 * @deprecated V1 compatibility gate; V2 routes must use
 * `evaluateValidationPolicyGate`.
 */
export function evaluateValidationGate(
  validation: ValidationRecord[],
): ValidationGateResult {
  if (validation.length === 0) {
    return {
      allowed: false,
      blockers: [
        {
          id: 'validation-evidence',
          label: '验证证据',
          status: 'unverified',
          required: true,
          summary: '适配结果未附带任何验证记录。',
          failureReason: 'missing-validation-records',
        },
      ],
    };
  }

  const blockers = validation.filter(
    (item) => item.required && (item.status === 'fail' || item.status === 'unverified'),
  );
  return { allowed: blockers.length === 0, blockers };
}

function missingPolicyRecord(
  policy: ValidationPolicySnapshot,
  check: ValidationPolicyCheck,
  failureReason: string,
  summary: string,
): ValidationRecord {
  return {
    id: `validation-policy:${policy.id}:${check.id}:${failureReason}`,
    label: check.label,
    status: 'unverified',
    required: check.required,
    policyCheckId: check.id,
    routeId: policy.routeId,
    routeVersion: policy.routeVersion,
    phase: check.phase,
    verifierId: check.verifierId,
    ...(check.verifierVersion === undefined ? {} : { verifierVersion: check.verifierVersion }),
    summary,
    failureReason,
  };
}

function recordMismatch(
  record: ValidationRecord,
  policy: ValidationPolicySnapshot,
  check: ValidationPolicyCheck,
  context: ValidationPolicyGateContext,
): string | undefined {
  if (record.routeId !== policy.routeId) return 'validation-route-mismatch';
  if (record.routeVersion !== policy.routeVersion) return 'validation-route-version-mismatch';
  if (record.phase !== check.phase) return 'validation-phase-mismatch';
  if (record.verifierId !== check.verifierId) return 'validation-verifier-mismatch';
  if (
    check.verifierVersion !== undefined &&
    record.verifierVersion !== check.verifierVersion
  ) {
    return 'validation-verifier-version-mismatch';
  }
  if (context.subjectHash !== undefined && record.subjectHash !== context.subjectHash) {
    return 'validation-subject-mismatch';
  }
  return undefined;
}

/**
 * Fail-closed route-policy gate. Required checks come only from the immutable
 * route policy. Missing, duplicated, or wrongly attributed evidence becomes an
 * explicit `unverified` blocker even if another record claims success.
 */
export function evaluateValidationPolicyGate(
  policy: ValidationPolicySnapshot,
  validation: readonly ValidationRecord[],
  context: ValidationPolicyGateContext = {},
): ValidationPolicyGateResult {
  if (!validationPolicyIsStructurallyValid(policy)) {
    const blocker: ValidationRecord = {
      id: 'validation-policy-invalid',
      label: '验证策略',
      status: 'unverified',
      required: true,
      summary: '迁移路线未提供可用的验证策略快照。',
      failureReason: 'invalid-validation-policy',
    };
    return {
      allowed: false,
      blockers: [blocker],
      evaluatedRecords: [...validation, blocker],
      missingCheckIds: [],
    };
  }

  const requiredChecks = policy.checks.filter((check) => check.required);
  if (requiredChecks.length === 0) {
    const blocker: ValidationRecord = {
      id: `validation-policy:${policy.id}:required-checks-missing`,
      label: '必需验证策略',
      status: 'unverified',
      required: true,
      routeId: policy.routeId,
      summary: '验证策略没有声明任何必需检查，禁止写回。',
      failureReason: 'validation-policy-has-no-required-checks',
    };
    return {
      allowed: false,
      blockers: [blocker],
      evaluatedRecords: [...validation, blocker],
      missingCheckIds: [],
    };
  }

  const recordsByCheck = new Map<string, ValidationRecord[]>();
  for (const record of validation) {
    const checkId = record.policyCheckId ?? record.id;
    const records = recordsByCheck.get(checkId) ?? [];
    records.push(record);
    recordsByCheck.set(checkId, records);
  }

  const synthesized: ValidationRecord[] = [];
  const evaluated: ValidationRecord[] = [];
  const missingCheckIds: string[] = [];
  for (const check of policy.checks) {
    const records = recordsByCheck.get(check.id) ?? [];
    if (records.length === 0) {
      if (check.required) {
        missingCheckIds.push(check.id);
        synthesized.push(missingPolicyRecord(
          policy,
          check,
          'required-validation-missing',
          `缺少路线要求的验证证据：${check.label}。`,
        ));
      }
      continue;
    }
    if (records.length > 1) {
      synthesized.push(missingPolicyRecord(
        policy,
        check,
        'duplicate-validation-records',
        `验证检查 ${check.id} 存在重复证据，无法确定权威结果。`,
      ));
      continue;
    }
    const record = records[0]!;
    const mismatch = recordMismatch(record, policy, check, context);
    if (mismatch !== undefined) {
      synthesized.push(missingPolicyRecord(
        policy,
        check,
        mismatch,
        `验证检查 ${check.id} 的路线、阶段、验证器或制品绑定不匹配。`,
      ));
      continue;
    }
    evaluated.push({ ...record, required: check.required });
  }

  const evaluatedRecords = [...evaluated, ...synthesized];
  const blockers = evaluatedRecords.filter(
    (record) => record.required && (record.status === 'fail' || record.status === 'unverified'),
  );
  return {
    allowed: blockers.length === 0,
    blockers,
    evaluatedRecords,
    missingCheckIds,
  };
}

/** @deprecated V1 compatibility helper; V2 routes must use `canApplyAdaptationForRoute`. */
export function canApplyAdaptation(result: AdaptationResult | null): boolean {
  return result !== null && result.files.length > 0 && evaluateValidationGate(result.validation).allowed;
}

export function canApplyAdaptationForRoute(
  result: Pick<AdaptationResult, 'files' | 'validation'> | null,
  policy: ValidationPolicySnapshot,
  context: ValidationPolicyGateContext = {},
): boolean {
  return result !== null &&
    result.files.length > 0 &&
    evaluateValidationPolicyGate(policy, result.validation, context).allowed;
}
