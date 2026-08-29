import type {
  ExecutionGroup,
  ExecutionWave,
  FunctionalModule,
  ModuleDependency,
  ModuleFileAssignment,
  ModuleMigrationPlan,
} from '@forexplore/contracts';

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

/** JSON with object keys sorted recursively. Arrays retain their semantic order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

const sha256RoundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rightRotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Encode text as UTF-8 without relying on `TextEncoder`, which keeps hashing
 * usable in both browser and Node-based execution hosts. Lone UTF-16
 * surrogates follow the standard UTF-8 replacement-character behavior.
 */
function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * A synchronous SHA-256 implementation for deterministic plan identities.
 * It intentionally has no Node `crypto` dependency because workflow-core is
 * also loaded by browser and VS Code extension hosts.
 */
export function sha256Hex(value: string): string {
  const source = utf8Bytes(value);
  const blockCount = Math.ceil((source.length + 9) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(source);
  padded[source.length] = 0x80;

  const bitLength = source.length * 8;
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  const end = padded.length;
  padded[end - 8] = (high >>> 24) & 0xff;
  padded[end - 7] = (high >>> 16) & 0xff;
  padded[end - 6] = (high >>> 8) & 0xff;
  padded[end - 5] = high & 0xff;
  padded[end - 4] = (low >>> 24) & 0xff;
  padded[end - 3] = (low >>> 16) & 0xff;
  padded[end - 2] = (low >>> 8) & 0xff;
  padded[end - 1] = low & 0xff;

  let a0 = 0x6a09e667;
  let b0 = 0xbb67ae85;
  let c0 = 0x3c6ef372;
  let d0 = 0xa54ff53a;
  let e0 = 0x510e527f;
  let f0 = 0x9b05688c;
  let g0 = 0x1f83d9ab;
  let h0 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byte = offset + index * 4;
      words[index] = (
        (padded[byte]! << 24) |
        (padded[byte + 1]! << 16) |
        (padded[byte + 2]! << 8) |
        padded[byte + 3]!
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rightRotate(previous15, 7) ^ rightRotate(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rightRotate(previous2, 17) ^ rightRotate(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    let e = e0;
    let f = f0;
    let g = g0;
    let h = h0;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + sha256RoundConstants[index]! + words[index]!) >>> 0;
      const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
    e0 = (e0 + e) >>> 0;
    f0 = (f0 + f) >>> 0;
    g0 = (g0 + g) >>> 0;
    h0 = (h0 + h) >>> 0;
  }

  return [a0, b0, c0, d0, e0, f0, g0, h0]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * A cryptographic digest over canonical JSON. Plan hashes bind human
 * approvals to an exact, collision-resistant plan representation.
 */
export function stableHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

function canonicalModule(module: FunctionalModule): Record<string, unknown> {
  return {
    id: module.id,
    name: module.name,
    kind: module.kind,
    description: module.description,
    sourceFiles: sortedUnique(module.sourceFiles),
    testFiles: sortedUnique(module.testFiles ?? []),
    generatedFiles: sortedUnique(module.generatedFiles ?? []),
    symbolIds: sortedUnique(module.symbolIds),
    dependsOn: sortedUnique(module.dependsOn),
    writeSet: sortedUnique(module.writeSet),
    resourceLocks: sortedUnique(module.resourceLocks),
    evidenceIds: sortedUnique(module.evidenceIds),
  };
}

function canonicalAssignment(assignment: ModuleFileAssignment): Record<string, unknown> {
  return {
    path: assignment.path,
    kind: assignment.kind,
    moduleId: assignment.moduleId,
    reason: assignment.reason,
  };
}

function canonicalDependency(dependency: ModuleDependency): Record<string, unknown> {
  return {
    moduleId: dependency.moduleId,
    dependsOnModuleId: dependency.dependsOnModuleId,
    source: dependency.source,
    evidenceEdgeIds: sortedUnique(dependency.evidenceEdgeIds),
  };
}

function canonicalGroup(group: ExecutionGroup): Record<string, unknown> {
  return {
    id: group.id,
    kind: group.kind,
    moduleIds: sortedUnique(group.moduleIds),
    dependsOnGroupIds: sortedUnique(group.dependsOnGroupIds),
    executionMode: group.executionMode,
    atomic: group.atomic,
    writeSet: sortedUnique(group.writeSet),
    resourceLocks: sortedUnique(group.resourceLocks),
    reasons: sortedUnique(group.reasons),
  };
}

function canonicalWave(wave: ExecutionWave): Record<string, unknown> {
  return {
    id: wave.id,
    order: wave.order,
    groupIds: sortedUnique(wave.groupIds),
    moduleIds: sortedUnique(wave.moduleIds),
    dependsOnWaveIds: sortedUnique(wave.dependsOnWaveIds),
    maxParallelism: wave.maxParallelism,
    requiresApproval: wave.requiresApproval,
    parallelismBlockedBy: sortedUnique(wave.parallelismBlockedBy),
  };
}

/**
 * Excludes lifecycle timestamps, decision records, and status transitions so
 * a human approval does not rewrite the hash it is intended to approve.
 */
export function modulePlanHashInput(
  plan: Pick<
    ModuleMigrationPlan,
    | 'schemaVersion'
    | 'snapshotId'
    | 'analysisHash'
    | 'objective'
    | 'modules'
    | 'fileAssignments'
    | 'dependencies'
    | 'executionGroups'
    | 'executionWaves'
  > & { risks?: readonly string[] },
): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    snapshotId: plan.snapshotId,
    analysisHash: plan.analysisHash,
    objective: plan.objective,
    modules: [...plan.modules]
      .sort(compareById)
      .map((module) => canonicalModule(module)),
    fileAssignments: [...plan.fileAssignments]
      .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind))
      .map((assignment) => canonicalAssignment(assignment)),
    dependencies: [...(plan.dependencies ?? [])]
      .sort(
        (left, right) =>
          left.moduleId.localeCompare(right.moduleId) ||
          left.dependsOnModuleId.localeCompare(right.dependsOnModuleId) ||
          left.source.localeCompare(right.source),
      )
      .map((dependency) => canonicalDependency(dependency)),
    executionGroups: [...(plan.executionGroups ?? [])]
      .sort(compareById)
      .map((group) => canonicalGroup(group)),
    executionWaves: [...(plan.executionWaves ?? [])]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((wave) => canonicalWave(wave)),
    risks: sortedUnique(plan.risks ?? []),
  };
}

export function calculateModuleMigrationPlanHash(
  plan: Pick<
    ModuleMigrationPlan,
    | 'schemaVersion'
    | 'snapshotId'
    | 'analysisHash'
    | 'objective'
    | 'modules'
    | 'fileAssignments'
    | 'dependencies'
    | 'executionGroups'
    | 'executionWaves'
  > & { risks?: readonly string[] },
): string {
  return stableHash(modulePlanHashInput(plan));
}
