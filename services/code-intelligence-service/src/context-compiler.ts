import { createHash, randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { formatContextMarkdown, type ContextPacket, type TaskContextEvidence, type TaskRetrievalRequest } from '@forexplore/contracts';

const tokenizer = getEncoding('cl100k_base');
export function contextTokenCount(text: string): number { return tokenizer.encode(text, [], []).length; }

type ContextInput = Omit<ContextPacket, 'packetId' | 'requestId' | 'requirement' | 'markdown' | 'usage'>;
function evidenceKey(item: TaskContextEvidence): string { return `${item.repositoryId}\0${item.analysisRevision}\0${item.relativePath}\0${item.fileHash}\0${JSON.stringify(item.sourceRange)}\0${item.contentHash}`; }
function lineCount(item: TaskContextEvidence): number { return item.content.split('\n').length; }
function contained(inner: TaskContextEvidence, outer: TaskContextEvidence): boolean {
  const a = inner.sourceRange; const b = outer.sourceRange;
  return inner.repositoryId === outer.repositoryId && inner.analysisRevision === outer.analysisRevision && inner.relativePath === outer.relativePath && inner.fileHash === outer.fileHash &&
    (a.startLine > b.startLine || a.startLine === b.startLine && a.startColumn >= b.startColumn) &&
    (a.endLine < b.endLine || a.endLine === b.endLine && a.endColumn <= b.endColumn);
}

/** Budget the exact exported representation, including evidence metadata and gaps. */
export function compileTaskContext(request: TaskRetrievalRequest, input: ContextInput, latencyMs: number): ContextPacket {
  const maxFiles = request.budget.maxFiles ?? 20;
  const maxLines = request.budget.maxSourceLines ?? 1200;
  const known = new Map(request.knownEvidence?.map((item) => [item.evidenceId, item.contentHash]));
  const candidates = input.evidence.filter((item, index, all) => !all.slice(0, index).some((previous) => evidenceKey(previous) === evidenceKey(item)));
  const knownRanges = candidates.filter((item) => known.get(item.evidenceId) === item.contentHash);
  const packet: ContextPacket = { ...input, requestId: request.requestId, packetId: `context-${randomUUID()}`, requirement: request.requirement,
    evidence: [], results: [...input.results], relations: [...input.relations], gaps: [...input.gaps], markdown: '', usage: { tokenizer: 'cl100k_base', tokens: 0, maxTokens: request.budget.maxTokens, characters: 0, files: 0, sourceLines: 0, latencyMs } };
  let omitted = 0;
  const omittedGap = { code: 'CONTEXT_BUDGET_EXCEEDED', message: 'Additional source evidence was omitted to respect the context budget. Narrow the task or increase the budget.' };
  // Reserve the omission notice before adding source, so reporting truncation cannot exceed the limit.
  const render = (evidence: TaskContextEvidence[]) => formatContextMarkdown({ ...packet, evidence, gaps: [...packet.gaps, omittedGap] });
  const metadataLimit = candidates.length && request.budget.maxTokens >= 1000 ? Math.floor(request.budget.maxTokens * 0.55) : request.budget.maxTokens;
  let metadataOmitted = false;
  const markMetadataOmitted = () => {
    if (!metadataOmitted) packet.gaps.push({ code: 'CONTEXT_METADATA_TRUNCATED', message: 'Some result or relation metadata was omitted to preserve the source evidence budget.' });
    metadataOmitted = true;
  };
  while (contextTokenCount(render([])) > metadataLimit && packet.relations.length) { packet.relations.pop(); markMetadataOmitted(); }
  while (contextTokenCount(render([])) > request.budget.maxTokens && packet.results.length) { packet.results.pop(); markMetadataOmitted(); }
  if (contextTokenCount(render([])) > request.budget.maxTokens) throw new Error('The token budget is too small for the task and snapshot metadata.');
  const terms = taskTerms(request.requirement);
  const coverage = (item: TaskContextEvidence): Map<string, number> => {
    const text = `${item.name} ${item.content}`.normalize('NFKC').toLowerCase();
    const features = new Map<string, number>([[`role:${item.role}`, item.role === 'implementation' ? 2 : 1]]);
    for (const term of terms) if (text.includes(term)) features.set(`term:${term}`, 2);
    for (const result of input.results) if (result.repositoryId === item.repositoryId && result.analysisRevision === item.analysisRevision &&
      (result.symbolKey ? result.symbolKey === item.symbolKey : result.relativePath === item.relativePath)) features.set(`result:${result.id}`, 3);
    return features;
  };
  const features = new Map(candidates.map(item => [item, coverage(item)]));
  const covered = new Set<string>(knownRanges.flatMap(item => [...features.get(item)!.keys()]));
  // Estimate incremental encoding cost only for ranking; every accepted trial is
  // measured using the complete final representation below.
  const baseTokens = contextTokenCount(render([]));
  const cost = new Map(candidates.map(item => [item, Math.max(1, contextTokenCount(render([item])) - baseTokens)]));
  const pending = candidates.filter(item => !knownRanges.some(previous => contained(item, previous)));
  while (pending.length) {
    const gain = (item: TaskContextEvidence) => {
      let value = 0.1;
      for (const [feature, weight] of features.get(item)!) if (!covered.has(feature)) value += weight;
      // Same-version overlapping excerpts contribute less new source evidence.
      const overlap = packet.evidence.filter(previous => previous.repositoryId === item.repositoryId &&
        previous.analysisRevision === item.analysisRevision && previous.relativePath === item.relativePath && previous.fileHash === item.fileHash)
        .reduce((sum, previous) => sum + Math.max(0, Math.min(previous.sourceRange.endLine, item.sourceRange.endLine) - Math.max(previous.sourceRange.startLine, item.sourceRange.startLine)), 0);
      return value / (1 + overlap / Math.max(1, lineCount(item)));
    };
    // Secure a main implementation before choosing supporting evidence by gain/cost.
    const primary = !packet.evidence.length ? pending.find(item => item.role === 'implementation') : undefined;
    pending.sort((a, b) => gain(b) / cost.get(b)! - gain(a) / cost.get(a)! || a.evidenceId.localeCompare(b.evidenceId));
    const item = primary ?? pending[0]!;
    pending.splice(pending.indexOf(item), 1);
    if (packet.evidence.some(selected => contained(item, selected))) continue;
    const trial = [...packet.evidence.filter(selected => !contained(selected, item)), item];
    const files = new Set(trial.map(entry => `${entry.repositoryId}\0${entry.analysisRevision}\0${entry.relativePath}`));
    if (files.size > maxFiles || trial.reduce((sum, entry) => sum + lineCount(entry), 0) > maxLines || contextTokenCount(render(trial)) > request.budget.maxTokens) {
      omitted += 1;
      continue;
    }
    packet.evidence = trial;
    for (const feature of features.get(item)!.keys()) covered.add(feature);
  }
  if (omitted) packet.gaps.push(omittedGap);
  if (packet.gaps.length && packet.status === 'complete') packet.status = 'partial';
  packet.markdown = formatContextMarkdown(packet);
  packet.usage = { ...packet.usage, tokens: contextTokenCount(packet.markdown), characters: packet.markdown.length,
    files: new Set(packet.evidence.map((item) => `${item.repositoryId}\0${item.analysisRevision}\0${item.relativePath}`)).size,
    sourceLines: packet.evidence.reduce((sum, item) => sum + lineCount(item), 0) };
  return packet;
}

export function sourceContentHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/** Bounded lexical requirements; these are evidence hints, not inferred truth. */
function taskTerms(requirement: string): string[] {
  const words = requirement.replace(/([a-z])([A-Z])/g, '$1 $2').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words.flatMap(word => /[\p{Script=Han}]/u.test(word)
    ? Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2))
    : word.length > 2 ? [word] : []))].slice(0, 64);
}
