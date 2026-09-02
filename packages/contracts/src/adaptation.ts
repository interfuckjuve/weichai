import type { FilePatch } from './backfill';
import type { Language, ModuleTarget } from './module';
import type { SearchCandidate } from './retrieval';
import type { ValidationRecord } from './validation';

export type AdaptationStrategy = 'translate' | 'bridge' | 'wrap' | 'reuse';

/** @deprecated V1 compatibility only. Production execution uses AdaptationRequestV2. */
export interface AdaptationRequest {
  target: ModuleTarget;
  candidate: SearchCandidate;
  requirement: string;
  strategy: AdaptationStrategy;
  decisionNotes: string;
}

export interface InterfaceMapping {
  source: string;
  target: string;
  action: ContractAction;
  note: string;
}

/** @deprecated V1 compatibility only. Production execution uses AdaptationResultV2. */
export interface AdaptationResult {
  strategy: AdaptationStrategy;
  targetLanguage: Language;
  generatedCode: string;
  interfaceMappings: InterfaceMapping[];
  /** Behavior-level repair instructions produced by post-compile verification. */
  modificationPlan?: string[];
  validation: ValidationRecord[];
  files: FilePatch[];
}

/** Stable schema version shared by Analyzer and Translator. */
export const analysisSchemaVersion = '1.0' as const;

export type ApplicabilityLevel = 'direct' | 'adapt' | 'reference' | 'reject';
export type BehaviorStatus = 'covered' | 'partial' | 'missing' | 'conflict';
/**
 * How a candidate contract element is represented by the target contract.
 * The last four actions cover common model terminology for an intentional
 * compatibility layer rather than silently coercing one action into another.
 */
export type ContractAction =
  | 'preserve'
  | 'rename'
  | 'convert'
  | 'inject'
  | 'replace'
  | 'adapt'
  | 'map'
  | 'delegate'
  | 'wrap';
export type DependencyAction = 'reuse-existing' | 'adapt' | 'inline' | 'unresolved';

export interface TargetDependencyContext {
  name: string;
  kind: 'field' | 'constructor' | 'signature' | 'invocation' | 'type';
  declaration: string;
  path?: string;
  memberSignatures?: string[];
}

export interface RelatedTypeContext {
  name: string;
  kind: 'class' | 'record' | 'interface' | 'struct' | 'enum' | 'unknown';
  path: string;
  declaration: string;
  source: string;
}

export interface CallerContext {
  path: string;
  line: number;
  excerpt: string;
}

/**
 * Facts collected from the target workspace. This intentionally contains no
 * model judgement; it is the target-side input to Analyzer.
 */
export interface TargetModuleContext {
  schemaVersion: typeof analysisSchemaVersion;
  target: ModuleTarget;
  source: {
    namespace?: string;
    usings: string[];
    method: string;
    containingType: string;
    fields: string[];
    constructor?: string;
    relatedMembers: string[];
  };
  dependencies: TargetDependencyContext[];
  relatedTypes: RelatedTypeContext[];
  callers: CallerContext[];
  constraints: string[];
  collection: {
    projectRoot: string;
    targetFile: string;
    maxChars: number;
    actualChars: number;
    truncated: boolean;
    truncatedSections: string[];
  };
}

export interface AnalysisRequest {
  schemaVersion: typeof analysisSchemaVersion;
  targetContext: TargetModuleContext;
  candidate: SearchCandidate;
  requirement: string;
  immutableConstraints?: string[];
  decisionNotes?: string;
}

export interface AnalysisReport {
  schemaVersion: typeof analysisSchemaVersion;
  applicability: {
    level: ApplicabilityLevel;
    confidence: number;
    reasons: string[];
  };
  behaviorMapping: Array<{
    requirement: string;
    status: BehaviorStatus;
    candidateEvidence: string[];
    targetAction: string;
  }>;
  contractMapping: Array<{
    source: string;
    target: string;
    action: ContractAction;
    note: string;
  }>;
  dependencyPlan: Array<{
    sourceDependency: string;
    targetDependency?: string;
    action: DependencyAction;
  }>;
  implementationPlan: string[];
  risks: string[];
  assumptions: string[];
  /**
   * Open questions for human review. These do not block translation by
   * themselves; hard dependency blockers belong in dependencyPlan with the
   * `unresolved` action.
   */
  unresolved: string[];
}
