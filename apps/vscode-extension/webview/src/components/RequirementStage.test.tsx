import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MigrationTargetRef } from '@forexplore/contracts';
import { initialWorkflowStateV2 } from '../v2-workflow';
import { RequirementStage } from './RequirementStage';

const hash = 'a'.repeat(64);
const target = {
  schemaVersion: '2.0',
  workspaceId: 'workspace-1',
  targetWorkspaceSnapshotId: 'snapshot-1',
  targetWorkspaceSnapshotHash: hash,
  entity: {
    entityId: 'callable-1',
    name: 'pay',
    kind: 'callable',
    languageId: 'typescript',
    path: 'src/payment.ts',
    signature: 'pay(): Promise<void>',
    fileContentHash: hash,
    declarationIdentity: {
      providerId: 'test',
      providerVersion: '1',
      contentHash: hash,
    },
  },
  route: {
    runtimeCapabilitySnapshotId: 'runtime-1',
    runtimeCapabilitySnapshotHash: hash,
    routeId: 'route-1',
    routeVersion: '1',
    routeContentHash: hash,
    validationPolicyId: 'policy-1',
    validationPolicyHash: hash,
    sourceLanguageId: 'java',
    targetLanguageId: 'typescript',
    strategy: 'translate',
  },
  lineage: {},
  allowedTargetPaths: ['src/payment.ts'],
  contentHash: hash,
} as unknown as MigrationTargetRef;

describe('RequirementStage V2', () => {
  it('renders the reviewed target, route, requirement and repository boundary', () => {
    const state = {
      ...initialWorkflowStateV2,
      stage: 'requirement' as const,
      target,
      topK: 4,
      requirement: '保留现有接口',
    };
    const markup = renderToStaticMarkup(
      <RequirementStage
        state={state}
        target={target}
        dispatch={vi.fn()}
        repositoryStatuses={[]}
        onSearch={vi.fn()}
        onCheckRepositories={vi.fn()}
      />,
    );

    expect(markup).toContain('01 · 迁移目标');
    expect(markup).toContain('pay');
    expect(markup).toContain('java → typescript');
    expect(markup).toContain('保留现有接口');
    expect(markup).toContain('Top 4');
    expect(markup).toContain('检索相似实现');
  });
});
