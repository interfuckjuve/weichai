import type { DependencyEdgeRecord, EvidenceLevel, EvidenceProvider, RepositoryRevisionScope, SourceRange } from './code-intelligence';

export type RetrievalGranularity = 'auto' | 'function' | 'class' | 'module' | 'subsystem';
export type ConcreteRetrievalGranularity = Exclude<RetrievalGranularity, 'auto'>;
export interface TaskRetrievalScope extends RepositoryRevisionScope { projectId?: string; role?: 'target' | 'reference' }
export interface TaskRetrievalRequest {
  requestId: string;
  requirement: string;
  granularity?: RetrievalGranularity;
  scopes: TaskRetrievalScope[];
  budget: { maxTokens: number; maxLatencyMs?: number; maxFiles?: number; maxSourceLines?: number };
  knownEvidence?: Array<{ evidenceId: string; contentHash: string }>;
}
export interface TaskRetrievalRouting {
  requestedGranularity: RetrievalGranularity;
  resolvedGranularities: ConcreteRetrievalGranularity[];
  source: 'user' | 'automatic';
  reason: string;
  confidence?: null;
}
export interface TaskRetrievalResult extends RepositoryRevisionScope {
  id: string;
  granularity: ConcreteRetrievalGranularity;
  name: string;
  projectId?: string;
  relativePath?: string;
  symbolKey?: string;
  moduleId?: string;
  score: number;
  reason: string;
}
export interface TaskContextEvidence extends RepositoryRevisionScope {
  evidenceId: string;
  role: 'implementation' | 'interface' | 'dependency' | 'configuration';
  name: string;
  relativePath: string;
  sourceRange: SourceRange;
  contentHash: string;
  fileHash: string;
  content: string;
  reason: string;
  provider: EvidenceProvider;
  evidenceLevel: EvidenceLevel;
  truncated: boolean;
  symbolKey?: string;
}
export interface TaskRetrievalGap { code: string; message: string; repositoryId?: string; relativePath?: string }
export interface TaskRetrievalSnapshot extends TaskRetrievalScope { repositoryName: string; analysisHash: string; sourceRevision?: string }
export interface ContextPacket {
  packetId: string;
  requestId: string;
  requirement: string;
  status: 'complete' | 'partial' | 'unavailable';
  snapshots: TaskRetrievalSnapshot[];
  routing: TaskRetrievalRouting;
  results: TaskRetrievalResult[];
  evidence: TaskContextEvidence[];
  relations: DependencyEdgeRecord[];
  gaps: TaskRetrievalGap[];
  markdown: string;
  usage: { tokenizer: 'cl100k_base'; tokens: number; maxTokens: number; characters: number; files: number; sourceLines: number; latencyMs: number };
}

/** Shared serialization for the service and user-selected evidence exports. */
export function formatContextMarkdown(packet: Pick<ContextPacket, 'requirement' | 'snapshots' | 'routing' | 'results' | 'evidence' | 'relations' | 'gaps'>): string {
  const sections = ['# Code Context', packet.requirement, '## Snapshots', ...packet.snapshots.map((snapshot) =>
    `- ${snapshot.repositoryName}: ${snapshot.repositoryId}@${snapshot.analysisRevision}${snapshot.projectId ? ` project=${snapshot.projectId}` : ''} analysis=${snapshot.analysisHash}`),
  `## Retrieval\n${packet.routing.requestedGranularity} -> ${packet.routing.resolvedGranularities.join(', ') || 'unavailable'} (${packet.routing.source})\n${packet.routing.reason}`];
  if (packet.results.length) sections.push('## Relevant Implementations', ...packet.results.map((result) =>
    `- ${result.name} [${result.granularity}] ${result.repositoryId}@${result.analysisRevision}${result.relativePath ? `:${result.relativePath}` : ''}\n  ${result.reason}`));
  if (packet.relations.length) sections.push('## Relations', ...packet.relations.map((edge) =>
    `- ${edge.repositoryId}@${edge.analysisRevision}: ${edge.sourceSymbolKey ?? edge.sourceRelativePath} --${edge.kind} (${edge.resolution}, ${edge.evidenceLevel})--> ${edge.targetSymbolKey ?? edge.targetRelativePath ?? edge.targetReference ?? 'unknown'}`));
  for (const item of packet.evidence) {
    // Source may itself contain Markdown fences; choose a strictly longer fence.
    const longest = Math.max(2, ...Array.from(item.content.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(longest + 1);
    sections.push(`## ${item.name} [${item.role}]\n${item.repositoryId}@${item.analysisRevision}:${item.relativePath}:${item.sourceRange.startLine}:${item.sourceRange.startColumn}-${item.sourceRange.endLine}:${item.sourceRange.endColumn}\nEvidence: ${item.evidenceId}; SHA256: ${item.contentHash}; ${item.evidenceLevel}${item.truncated ? '; truncated' : ''}\n${item.reason}\n\n${fence}\n${item.content}\n${fence}`);
  }
  if (packet.gaps.length) sections.push('## Gaps', ...packet.gaps.map((gap) => `- ${gap.code}: ${gap.message}`));
  return sections.join('\n\n');
}
