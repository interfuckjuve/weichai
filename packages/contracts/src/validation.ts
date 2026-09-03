/**
 * A verification result produced independently of the implementation text.
 * `pass` and `warn` are display states; a required `fail` or `unverified`
 * check blocks a write-back by default.
 */
export type ValidationStatus = 'pass' | 'warn' | 'fail' | 'unverified';

export const validationPolicySchemaVersion = '1.0' as const;

/** Common policy axis; language-specific check details remain verifier-owned. */
export type ValidationPhase =
  | 'syntax'
  | 'compile'
  | 'static-analysis'
  | 'unit-test'
  | 'integration-test'
  | 'behavior'
  | 'architecture'
  | 'dependency'
  | 'security'
  | 'license'
  | 'format'
  | 'custom';

export interface ValidationPolicyCheck {
  /** Stable key which a ValidationRecord must cite through `policyCheckId`. */
  id: string;
  label: string;
  phase: ValidationPhase;
  required: boolean;
  /** Expected independent verifier identity, not an implementation model name. */
  verifierId: string;
  verifierVersion?: string;
  reason?: string;
}

/**
 * Immutable policy selected together with one migration route. The route owns
 * the required-check set; an implementation result cannot weaken it.
 */
export interface ValidationPolicySnapshot {
  schemaVersion: typeof validationPolicySchemaVersion;
  id: string;
  routeId: string;
  routeVersion: string;
  checks: ValidationPolicyCheck[];
  createdAt?: string;
  /** Optional until persisted; durable run manifests should always include it. */
  contentHash?: string;
}

export interface ValidationRecord {
  /** Stable identifier so a run manifest can refer to this check. */
  id: string;
  label: string;
  status: ValidationStatus;
  /** Whether this check must be usable before the patch can be applied. */
  required: boolean;
  /** Route-policy check satisfied by this record. Legacy records may omit it. */
  policyCheckId?: string;
  routeId?: string;
  routeVersion?: string;
  phase?: ValidationPhase;
  verifierId?: string;
  verifierVersion?: string;
  /** Hash of the patch, source bundle, or other exact subject which was checked. */
  subjectHash?: string;
  /** Command or verifier used to obtain this evidence, when applicable. */
  command?: string;
  /** Human-readable, bounded summary of the verifier output. */
  summary: string;
  /** Optional durable artifact containing full output. */
  artifactPath?: string;
  /** Explicit reason when a check failed or was not executed. */
  failureReason?: string;
}
