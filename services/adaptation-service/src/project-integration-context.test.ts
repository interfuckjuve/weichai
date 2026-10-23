import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactIntegrationCoverage } from './project-integration-input';
import { collectProjectIntegrationEvidence, isNewProjectIntegrationSource, prepareProjectIntegrationContext } from './project-integration-context';

describe('project integration inputs', () => {
  it('permits new production sources while preserving the public configuration and evaluator boundary', () => {
    const sources = ['src/main/java/example/app/Entry.java', 'src/main/java/example/adapter/Store.java'];
    expect(isNewProjectIntegrationSource('src/main/java/example/integration/Repair.java', sources)).toBe(true);
    for (const path of ['pom.xml', 'evaluation/Hidden.java', 'src/test/java/Check.java', 'src/main/java/example/Repair.test.java', 'src/main/java/example/../../private.java', 'src/main/java/example/credentials.key']) {
      expect(isNewProjectIntegrationSource(path, sources)).toBe(false);
    }
  });
  it('exposes all current production and complete public requirements while excluding prior module records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recast-public-inputs-'));
    try {
      for (const file of ['src/Entry.java', 'src/adapter/Store.java', 'requirements/public.md', 'pom.xml', 'evaluation/hidden.md', 'tests/Hidden.java', '.env', '.forexplore/journal.json']) {
        await mkdir(join(root, file, '..'), { recursive: true });
        await writeFile(join(root, file), file.startsWith('requirements/') ? 'PUBLIC BEHAVIOR' : 'CODE OR PRIVATE');
      }
      const input = [{ moduleId: 'store', module: 'Store', status: 'completed', sourceFiles: ['src/adapter/Store.java'],
        plan: { markdown: 'OLD_MODULE_PLAN', summary: 'old summary', mappings: [], dependencies: [], steps: [] },
        translationVerification: { status: 'failure', issue: { kind: 'translation', description: 'OLD_VERIFICATION_FAILURE' }, functions: [] } }];
      const context = await prepareProjectIntegrationContext(root, input);
      expect(context.writeFiles).toEqual(['src/adapter/Store.java', 'src/Entry.java']);
      expect(context.readOnlyFiles).toEqual(['pom.xml', 'requirements/public.md']);
      expect(context.context).toEqual([]);
      expect(context.requirement).toContain('PUBLIC BEHAVIOR');
      expect(context.requirement).toContain('pom.xml');
      expect(context.requirement).not.toMatch(/OLD_MODULE_PLAN|OLD_VERIFICATION_FAILURE|CODE OR PRIVATE/);
      const directory = join(root, '.forexplore', 'integration-input-evidence');
      const archive = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'));
      expect(archive.modules[0].verification).toEqual(input[0].translationVerification);
      expect(archive.plans[0].plan).toEqual(input[0].plan);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('integration independent checks and Host audit', () => {
  it('retains bounded temporary checks and explicitly reports missing, truncated and linked evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recast-integration-evidence-'));
    try {
      expect((await collectProjectIntegrationEvidence(root)).omissions).toHaveLength(1);
      const scratch = join(root, '.agent-tmp', 'integration-checks');
      await mkdir(scratch, { recursive: true });
      await writeFile(join(scratch, 'coverage.md'), 'PUBLIC SOURCE -> EXPECTATION -> CASE');
      await writeFile(join(scratch, 'execution.log'), 'x'.repeat(70_000));
      const outside = join(root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'outside.txt'), 'MUST NOT FOLLOW');
      await symlink(outside, join(scratch, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const checkSource = 'assert(result === expected);\n'.repeat(2_500);
      await writeFile(join(scratch, 'Check.ts'), checkSource);
      await writeFile(join(scratch, 'binary.class'), 'ignore binary');
      const evidence = await collectProjectIntegrationEvidence(root);
      expect(evidence.files).toHaveLength(3);
      expect(evidence.files.find(file => file.path.endsWith('Check.ts'))).toMatchObject({ content: checkSource, truncated: false });
      expect(evidence.files.find(file => file.path.endsWith('coverage.md'))?.content).toContain('PUBLIC SOURCE');
      expect(evidence.files.find(file => file.path.endsWith('execution.log'))).toMatchObject({ truncated: true });
      expect(evidence.omissions).toContain('linked: symlink omitted');
      expect(JSON.stringify(evidence)).not.toContain('MUST NOT FOLLOW');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


it('keeps original current/earlier failure and correction records in Host audit only', async () => {
 const root = await mkdtemp(join(tmpdir(), 'recast-host-audit-'));
 try {
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/Entry.ts'), 'export const entry = 1;');
  const evidence = { runs: [{ id: 'original-run', revisionCount: 3, versions: [] }], failures: [{ id: 'failure-1', status: 'unresolved', message: 'ORIGINAL_EXPECTATION' }], revisions: [{ corrections: [{ status: 'unconfirmed' }] }] };
  const attempt = { status: 'failure', functions: [], testEvidence: evidence };
  const context = await prepareProjectIntegrationContext(root, [{ moduleId: 'entry', module: 'Entry', status: 'completed', sourceFiles: ['src/Entry.ts'], translationVerification: { status: 'success', functions: [], testEvidence: evidence }, translationVerificationAttempts: [attempt] }]);
  expect(context.context).toEqual([]); expect(context.requirement).not.toContain('ORIGINAL_EXPECTATION');
  const directory = join(root, '.forexplore', 'integration-input-evidence'); const files = await readdir(directory);
  const archive = JSON.parse(await readFile(join(directory, files[0]!), 'utf8'));
  expect(archive.modules[0].verification.testEvidence).toEqual(evidence); expect(archive.modules[0].attempts).toEqual([attempt]);
 } finally { await rm(root, { recursive: true, force: true }); }
});

it('large historical records do not inflate the independent Agent input', async () => {
 const root = await mkdtemp(join(tmpdir(), 'recast-large-audit-'));
 try {
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/Entry.ts'), 'export const entry = 1;');
  const evidence = { failures: Array.from({ length: 30 }, (_, index) => ({ id: `failure-${index}`, status: 'unresolved', message: 'large-historical-record'.repeat(5000) })) };
  const context = await prepareProjectIntegrationContext(root, [{ moduleId: 'entry', module: 'Entry', status: 'completed', sourceFiles: ['src/Entry.ts'], plan: { markdown: 'OLD_PLAN'.repeat(30000), summary: '', mappings: [], dependencies: [], steps: [] }, translationVerification: { status: 'failure', functions: [], testEvidence: evidence } }]);
  expect(context.context).toEqual([]); expect(context.requirement.length).toBeLessThan(64000); expect(context.requirement).not.toContain('large-historical-record');
  const directory = join(root, '.forexplore', 'integration-input-evidence'); const archive = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'));
  expect(archive.modules[0].verification.testEvidence).toEqual(evidence);
 } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps complete large public requirement documents visible when the inline spec uses their inventory', async () => {
 const root = await mkdtemp(join(tmpdir(), 'recast-large-public-requirement-'));
 try {
  await mkdir(join(root, 'src')); await mkdir(join(root, 'requirements'));
  await writeFile(join(root, 'src/Entry.ts'), 'export const entry = 1;');
  const text = 'PUBLIC_PASSAGE'.repeat(5000) + 'END_OF_PUBLIC_REQUIREMENT'; await writeFile(join(root, 'requirements/public.md'), text);
  const context = await prepareProjectIntegrationContext(root);
  expect(context.readOnlyFiles).toContain('requirements/public.md'); expect(context.requirement).toContain('Read every document'); expect(context.requirement.length).toBeLessThan(64000);
  expect(await readFile(join(root, 'requirements/public.md'), 'utf8')).toBe(text);
 } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps exception causes and expectation text when archiving only repetitive stack frames', () => {
  const original = { id: 'observed-failure', status: 'unresolved', message:
    'expected no effect, observed dispatch\njava.lang.IllegalStateException: commit failed\n\tat framework.Test.invoke(Test.java:1)\nCaused by: tenant mismatch\n\tat example.Route.resolve(Route.java:2)' };
  const projected = compactIntegrationCoverage(original) as any;
  expect(projected.message).toBe('expected no effect, observed dispatch\njava.lang.IllegalStateException: commit failed\nCaused by: tenant mismatch');
  expect(projected.status).toBe('unresolved');
  expect(projected.hostTrace).toMatchObject({ bytes: Buffer.byteLength(original.message), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
