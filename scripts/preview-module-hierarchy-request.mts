import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanRepositoryStructuralIndex } from '../services/code-indexer/src/repository-scan.js';
import { buildAdaptiveModuleProposal } from '../services/code-intelligence-service/src/module-hierarchy.js';
import { parseModuleHierarchyDecisionRequest } from '../services/code-intelligence-service/src/module-hierarchy-planner.js';
import type { ModuleHierarchyDecisionRequest } from '../packages/contracts/src/index.js';

// This script only writes a local preview from the checked-in demonstration fixture.
const root = path.resolve('fixtures/code-corpus/ledger-flow-ts');
const scanned = await scanRepositoryStructuralIndex({ repositoryRoot: root, repositoryId: 'ledger-flow-demo',
  analysisRevision: 'hierarchy-preview', retainSourceTexts: true });
const index = scanned.index;
const project = index.projects.find((item) => item.relativePath === '') ?? index.projects[0]!;
const requests: ModuleHierarchyDecisionRequest[] = [];
await buildAdaptiveModuleProposal(index, { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, projectId: project.projectId },
  'Describe coherent implementation responsibilities.', {
    maxModelCalls: 1,
    planner: { decide: async (request) => {
      const excerpts = index.files.filter((file) => file.role === 'source').slice(0, 2).map((file) => ({
        relativePath: file.relativePath, content: (scanned.sourceFiles.get(file.relativePath) ?? '').slice(0, 1_800), evidenceId: `file:${file.fileId}`,
      }));
      requests.push(parseModuleHierarchyDecisionRequest({ ...request, excerpts }));
      throw new Error('Local preview only: no model request is made.');
    } },
  });
assert.equal(requests.length, 1);
await mkdir('logs', { recursive: true });
await writeFile('logs/module-hierarchy-request-preview.json', `${JSON.stringify({ source: 'checked-in demo fixture', fixture: 'fixtures/code-corpus/ledger-flow-ts',
  externalRequests: 0, requestChars: JSON.stringify(requests[0]).length, request: requests[0] }, null, 2)}\n`);
console.log(JSON.stringify({ preview: 'logs/module-hierarchy-request-preview.json', externalRequests: 0,
  candidates: requests[0]!.candidates.length, excerpts: requests[0]!.excerpts.length, requestChars: JSON.stringify(requests[0]).length }));
