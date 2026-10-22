import { readCheckIndex } from '../../../domains/comet-classic/classic-check-index.js';
import { requireFileSymlink } from '../../helpers/file-symlink.js';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument, stringify } from 'yaml';
import {
  readClassicState,
  writeClassicState,
  withClassicStateLock,
} from '../../../domains/comet-classic/classic-store.js';
import {
  resolveClassicRunDirectory,
  resolveClassicRunDirectoryForRead,
  resolveClassicLocalTarget,
} from '../../../domains/comet-classic/classic-runtime-paths.js';
import { resolveWorkspaceRuntimeRootSync } from '../../../domains/workflow-contract/workspace-runtime.js';
import * as workspaceRuntime from '../../../domains/workflow-contract/workspace-runtime.js';
import { writeRunState } from '../../../domains/engine/state.js';
import type { RunState } from '../../../domains/engine/types.js';
import { inspectClassicHookGuard } from '../../../domains/comet-classic/classic-hook-guard.js';
import { readChangeRuntimeOwner } from '../../../domains/workflow-contract/change-runtime-owner.js';
import { prepareClassicLegacyProject } from '../../helpers/classic-project.js';
import {
  readClassicProjectFile,
  classicProjectTargetExists,
  writeClassicProjectText,
} from '../../../domains/comet-classic/classic-protected-path.js';

const run: RunState = {
  runId: 'legacy-run',
  skill: 'comet:classic',
  skillVersion: '1',
  skillHash: 'a'.repeat(64),
  orchestration: 'deterministic',
  currentStep: 'work',
  iteration: 1,
  pending: null,
  pendingRef: '.comet/pending-action.json',
  trajectoryRef: '.comet/trajectory.jsonl',
  contextRef: '.comet/context.md',
  artifactsRef: '.comet/artifacts.json',
  checkpointRef: '.comet/checkpoint.json',
  status: 'waiting',
  retries: {},
};
const source =
  '# Retain formatting and comments.\nworkflow: full\nphase: design\ndesign_doc: null\nplan: null\nbuild_mode: null\nisolation: null\nverify_mode: null\nverified_at: null\nverify_result: pending\narchived: false\n';
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const ref = prefix + entry.name;
      if (entry.isDirectory()) {
        result[ref + '/'] = '';
        await walk(path.join(directory, entry.name), ref + '/');
      } else result[ref] = (await fs.readFile(path.join(directory, entry.name))).toString('base64');
    }
  }
  await walk(root);
  return result;
}

describe('Classic read-only state and Archive identity', () => {
  let directory: string;
  let root: string;
  let change: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'classic-readonly-'));
    vi.stubEnv('COMET_DATA_DIR', path.join(directory, 'user-data'));
    root = path.join(directory, 'project');
    await fs.mkdir(root);
    await prepareClassicLegacyProject(root);
    change = path.join(root, 'openspec', 'changes', 'demo');
    await fs.mkdir(change);
    await fs.writeFile(path.join(change, '.comet.yaml'), source);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('reads legacy local records without assigning identity or creating home', async () => {
    const file = path.join(change, '.comet', 'coordination.json');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '{"legacy":true}');
    const before = await tree(directory);
    expect(await readClassicProjectFile(root, file, { label: 'local read' })).toBe(
      '{"legacy":true}',
    );
    expect(await classicProjectTargetExists(root, file, { label: 'local read' })).toBe(true);
    expect(await tree(directory)).toEqual(before);
  });

  it('reads missing home records without recreating them or changing their portable identity', async () => {
    const file = path.join(change, '.comet', 'coordination.json');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '{"legacy":true}');
    await writeClassicProjectText(root, file, '{"local":true}', { label: 'local setup' });
    await fs.rm(resolveWorkspaceRuntimeRootSync(root), { recursive: true });
    const before = await tree(directory);
    expect(await classicProjectTargetExists(root, file, { label: 'local read' })).toBe(false);
    await expect(readClassicProjectFile(root, file, { label: 'local read' })).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(await readCheckIndex(change, '.comet/trajectory.jsonl')).toEqual({
      maximumSequence: 0,
      events: [],
    });
    expect(await tree(directory)).toEqual(before);
  });

  it('rejects different check files split across two real migration directories', async () => {
    const local = await resolveClassicRunDirectory(change, root);
    const legacy = path.join(change, '.comet', 'checks');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'old.log'), 'old evidence');
    await fs.mkdir(path.join(local, '.comet', 'checks'), { recursive: true });
    await fs.writeFile(path.join(local, '.comet', 'checks', 'new.log'), 'new evidence');
    const before = await tree(directory);
    for (const file of ['old.log', 'new.log'])
      await expect(
        readClassicProjectFile(root, path.join(legacy, file), { label: 'split checks' }),
      ).rejects.toThrow(/Conflicting/u);
    expect(await tree(directory)).toEqual(before);
  });

  it('does not read the original home target from a copied foreign fence', async () => {
    const file = path.join(change, '.comet', 'coordination.json');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '{"legacy":true}');
    const local = await resolveClassicRunDirectory(change, root);
    const originalTarget = path.join(local, '.comet', 'coordination.json');
    const copied = path.join(directory, 'copied-project');
    await fs.cp(root, copied, { recursive: true });
    const before = await tree(directory);
    const reads = vi.spyOn(fs, 'open');
    expect(
      await classicProjectTargetExists(copied, path.join(copied, path.relative(root, file)), {
        label: 'copied local read',
      }),
    ).toBe(false);
    expect(reads.mock.calls.filter(([target]) => String(target) === originalTarget)).toHaveLength(
      0,
    );
    expect(await tree(directory)).toEqual(before);
  });

  it('rejects two real local sources and altered same-workspace fence destinations', async () => {
    const file = path.join(change, '.comet', 'coordination.json');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '{"legacy":true}');
    await resolveClassicRunDirectory(change, root);
    const marker = path.join(file, '.comet-runtime-migration.json');
    const fence = JSON.parse(await fs.readFile(marker, 'utf8'));
    await fs.writeFile(marker, JSON.stringify({ ...fence, target: `${fence.target}-wrong` }));
    const before = await tree(directory);
    await expect(readClassicProjectFile(root, file, { label: 'local read' })).rejects.toThrow(
      /其他路径/u,
    );
    expect(await tree(directory)).toEqual(before);
    await fs.rm(file, { recursive: true });
    await fs.writeFile(file, '{"legacy":true}');
    await expect(readClassicProjectFile(root, file, { label: 'local read' })).rejects.toThrow(
      /Conflicting/u,
    );
  });

  it('rejects a symbolic link at an absolute home read target', async (context) => {
    await requireFileSymlink(context);
    const runtime = await workspaceRuntime.resolveWorkspaceRuntimeRoot(root);
    const outside = path.join(directory, 'outside.json');
    await fs.writeFile(outside, 'untouched');
    const target = path.join(runtime, 'record.json');
    await fs.symlink(outside, target);
    await expect(readClassicProjectFile(root, target, { label: 'local read' })).rejects.toThrow(
      /symbolic link|junction/u,
    );
    expect(await fs.readFile(outside, 'utf8')).toBe('untouched');
  });

  it('resolves legacy logical targets against the asynchronously validated workspace root', async () => {
    const previous = resolveWorkspaceRuntimeRootSync(root);
    const current = `${previous}-recreated`;
    vi.spyOn(workspaceRuntime, 'resolveWorkspaceRuntimeRoot').mockResolvedValueOnce(current);
    expect(
      await resolveClassicLocalTarget(root, path.join(root, '.comet', 'runtime', 'record.json')),
    ).toEqual({ root: current, target: path.join(current, 'record.json') });
  });

  it('rejects absolute home targets when the workspace identity changes during resolution', async () => {
    const previous = resolveWorkspaceRuntimeRootSync(root);
    vi.spyOn(workspaceRuntime, 'resolveWorkspaceRuntimeRoot').mockResolvedValueOnce(
      `${previous}-recreated`,
    );
    await expect(
      resolveClassicLocalTarget(root, path.join(previous, 'record.json')),
    ).rejects.toThrow('workspace changed');
  });

  it.each(['plain', 'legacy-commands'])(
    'reads %s YAML without assigning identities, creating fences or touching home',
    async (kind) => {
      if (kind === 'legacy-commands')
        await fs.appendFile(
          path.join(change, '.comet.yaml'),
          'build_command: node old-build.js\nverify_command: node old-verify.js\n',
        );
      const before = await tree(directory);
      expect(await readClassicState(change, { migrate: false })).toMatchObject({
        classic: { phase: 'design' },
        run: null,
        unknownKeys: [],
      });
      expect(await resolveClassicRunDirectoryForRead(change, root)).toBe(change);
      expect(await tree(directory)).toEqual(before);
    },
  );

  it.each(['plain', 'legacy-commands', 'legacy-owner'])(
    'keeps the actual Guard entry read-only for %s state',
    async (kind) => {
      if (kind === 'legacy-commands')
        await fs.appendFile(
          path.join(change, '.comet.yaml'),
          'build_command: node old.js\nverify_command: node old-test.js\n',
        );
      if (kind === 'legacy-owner') {
        const file = path.join(root, '.comet', 'runtime', 'change-owners', 'classic', 'demo.json');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
          file,
          JSON.stringify({
            schema: 'comet.change-owner.v1',
            workflow: 'classic',
            change: 'demo',
            format: 'compat',
          }),
        );
      }
      const before = await tree(directory);
      expect(
        await inspectClassicHookGuard(root, 'demo', { intent: 'write', targets: ['src/app.ts'] }),
      ).toMatchObject({ allowed: false, phase: 'design' });
      expect(await tree(directory)).toEqual(before);
    },
  );

  it('returns missing state without creating a ghost identity or Runtime directory', async () => {
    await fs.unlink(path.join(change, '.comet.yaml'));
    const before = await tree(directory);
    expect(await resolveClassicRunDirectoryForRead(change, root)).toBeNull();
    expect(await readClassicState(change, { migrate: false })).toEqual({
      classic: null,
      run: null,
      unknownKeys: [],
    });
    expect(await tree(directory)).toEqual(before);
  });

  it('rejects conflicting current and legacy owners without choosing or migrating either authority', async () => {
    const relative = path.join('change-owners', 'classic', 'demo.json');
    const current = path.join(resolveWorkspaceRuntimeRootSync(root), relative);
    const legacy = path.join(root, '.comet', 'runtime', relative);
    await fs.mkdir(path.dirname(current), { recursive: true });
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    const owner = {
      schema: 'comet.change-owner.v1',
      workflow: 'classic',
      change: 'demo',
      format: 'compat',
    };
    await fs.writeFile(current, JSON.stringify(owner));
    await fs.writeFile(
      legacy,
      JSON.stringify({ ...owner, format: 'sdk', application: 'classic-full', runId: 'demo' }),
    );
    const before = await tree(directory);
    await expect(
      readChangeRuntimeOwner(root, 'classic', 'demo', { readOnly: true }),
    ).rejects.toThrow(/Conflicting/u);
    expect(await tree(directory)).toEqual(before);
  });

  it('does not follow a copied foreign workspace fence when reading ownership', async () => {
    await fs.writeFile(
      path.join(root, '.comet', 'runtime'),
      JSON.stringify({
        schema: 'comet.workspace-runtime-migration.v1',
        workspaceId: 'f'.repeat(64),
        source: path.join(root, '.comet', 'runtime'),
        target: path.join(directory, 'foreign-home'),
        kind: 'directory',
      }),
    );
    const before = await tree(directory);
    expect(await readChangeRuntimeOwner(root, 'classic', 'demo', { readOnly: true })).toBeNull();
    expect(await tree(directory)).toEqual(before);
  });

  it('reads legacy local Run files in place without migrating them', async () => {
    await fs.appendFile(path.join(change, '.comet.yaml'), `run_id: ${run.runId}\n`);
    await writeRunState(change, run);
    const before = await tree(directory);
    expect((await readClassicState(change, { migrate: false })).run).toEqual(run);
    expect(await tree(directory)).toEqual(before);
  });

  it('projects embedded legacy Run state without extracting or rewriting it', async () => {
    await fs.appendFile(
      path.join(change, '.comet.yaml'),
      stringify({
        run_id: run.runId,
        skill: run.skill,
        skill_version: run.skillVersion,
        skill_hash: run.skillHash,
        orchestration: run.orchestration,
        current_step: run.currentStep,
        iteration: run.iteration,
        pending: run.pending,
        pending_ref: run.pendingRef,
        trajectory_ref: run.trajectoryRef,
        context_ref: run.contextRef,
        artifacts_ref: run.artifactsRef,
        checkpoint_ref: run.checkpointRef,
        run_status: run.status,
        run_retries: run.retries,
      }),
    );
    const before = await tree(directory);
    expect((await readClassicState(change, { migrate: false })).run).toEqual(run);
    expect(await tree(directory)).toEqual(before);
  });

  it('reads an already bound home Run and accepts its legacy writer fence without mutations', async () => {
    await fs.appendFile(path.join(change, '.comet.yaml'), `run_id: ${run.runId}\n`);
    await writeRunState(change, run);
    const local = await resolveClassicRunDirectory(change, root);
    const before = await tree(directory);
    expect(await resolveClassicRunDirectoryForRead(change, root)).toBe(local);
    expect((await readClassicState(change, { migrate: false })).run).toEqual(run);
    expect(await tree(directory)).toEqual(before);
  });

  it('locates a run_id-derived home Run without adding the missing change_id to old YAML', async () => {
    await fs.appendFile(path.join(change, '.comet.yaml'), `run_id: ${run.runId}\n`);
    const digest = createHash('sha256').update(`classic-run:${run.runId}`).digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    const local = path.join(resolveWorkspaceRuntimeRootSync(root), 'classic-changes', id);
    await fs.mkdir(local, { recursive: true });
    await writeRunState(local, run);
    const before = await tree(directory);
    expect(await resolveClassicRunDirectoryForRead(change, root)).toBe(local);
    expect((await readClassicState(change, { migrate: false })).run).toEqual(run);
    expect(await tree(directory)).toEqual(before);
  });

  it('rejects duplicate copied identities without rewriting either change or its binding', async () => {
    await resolveClassicRunDirectory(change, root);
    const copied = path.join(root, 'openspec', 'changes', 'copied');
    await fs.mkdir(copied);
    await fs.copyFile(path.join(change, '.comet.yaml'), path.join(copied, '.comet.yaml'));
    const before = await tree(directory);
    await expect(readClassicState(copied, { migrate: false })).rejects.toThrow(
      /Duplicate Classic change_id/u,
    );
    expect(await tree(directory)).toEqual(before);
  });

  it('blocks the actual Guard instead of falling back to a copied build-state identity', async () => {
    await fs.writeFile(
      path.join(change, '.comet.yaml'),
      source.replace('phase: design', 'phase: build'),
    );
    await resolveClassicRunDirectory(change, root);
    const copied = path.join(root, 'openspec', 'changes', 'copied');
    await fs.mkdir(copied);
    await fs.copyFile(path.join(change, '.comet.yaml'), path.join(copied, '.comet.yaml'));
    const before = await tree(directory);
    expect(
      await inspectClassicHookGuard(root, 'copied', { intent: 'write', targets: ['src/app.ts'] }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Duplicate Classic change_id'),
    });
    expect(await tree(directory)).toEqual(before);
  });

  it('does not recover or rewrite an outstanding home state transaction while reading', async () => {
    const local = await resolveClassicRunDirectory(change, root);
    await fs.writeFile(path.join(local, '.comet-state-transaction.json'), '{}');
    const before = await tree(directory);
    await expect(readClassicState(change, { migrate: false })).rejects.toThrow(/being updated/u);
    expect(await tree(directory)).toEqual(before);
  });

  it('reads without mutation while its own active state lock is held', async () => {
    await withClassicStateLock(change, async () => {
      const before = await tree(directory);
      expect((await readClassicState(change, { migrate: false })).classic?.phase).toBe('design');
      expect(await tree(directory)).toEqual(before);
    });
  });

  it('continues to reject another writer even in an expired state-lock async context', async () => {
    const local = await resolveClassicRunDirectory(change, root);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reading!: Promise<unknown>;
    await withClassicStateLock(change, async () => {
      reading = (async () => {
        await gate;
        return readClassicState(change, { migrate: false });
      })();
    });
    await fs.writeFile(path.join(local, '.comet-state.lock'), JSON.stringify({ pid: process.pid }));
    const before = await tree(directory);
    resume();
    await expect(reading).rejects.toThrow(/being updated/u);
    expect(await tree(directory)).toEqual(before);
  });

  it('rejects a replaced lock file even while the original lock callback is still active', async () => {
    const local = await resolveClassicRunDirectory(change, root);
    await withClassicStateLock(change, async () => {
      const replacement = path.join(local, 'replacement.lock');
      const lock = path.join(local, '.comet-state.lock');
      // 连内容也相同的替换文件仍不是本次持有的锁实例。
      await fs.copyFile(lock, replacement);
      await fs.rename(replacement, lock);
      const before = await tree(directory);
      await expect(readClassicState(change, { migrate: false })).rejects.toThrow(/lock changed/u);
      expect(await tree(directory)).toEqual(before);
    });
  });

  it('keeps a sealed legacy Archive unchanged during read-only inspection', async () => {
    const archived = path.join(root, 'openspec', 'changes', 'archive', '2026-01-01-demo');
    await fs.rename(change, archived);
    const yaml = source
      .replace('phase: design', 'phase: archive')
      .replace('archived: false', 'archived: true')
      .replace('verify_result: pending', 'verify_result: pass');
    await fs.writeFile(path.join(archived, '.comet.yaml'), yaml);
    const before = await tree(directory);
    expect((await readClassicState(archived, { migrate: false })).classic?.archived).toBe(true);
    expect(await tree(directory)).toEqual(before);
  });

  it('persists the selected Archive identity with its first Run write and continues in that same directory', async () => {
    const archived = path.join(root, 'openspec', 'changes', 'archive', '2026-01-01-demo');
    await fs.rename(change, archived);
    const yaml = source
      .replace('phase: design', 'phase: archive')
      .replace('archived: false', 'archived: true')
      .replace('verify_result: pending', 'verify_result: pass');
    await fs.writeFile(path.join(archived, '.comet.yaml'), yaml);
    const local = await resolveClassicRunDirectory(archived, root);
    expect(await fs.readFile(path.join(archived, '.comet.yaml'), 'utf8')).toBe(yaml);
    const initial = await readClassicState(archived, { migrate: false });
    await writeClassicState(archived, { ...initial, run });
    const written = parseDocument(await fs.readFile(path.join(archived, '.comet.yaml'), 'utf8'));
    expect(written.get('change_id')).toBe(path.basename(local));
    expect(await resolveClassicRunDirectory(archived, root)).toBe(local);
    const current = await readClassicState(archived, { migrate: false });
    expect(current.run).toEqual(run);
    await writeClassicState(archived, { ...current, run: { ...run, iteration: 2 } });
    expect(await resolveClassicRunDirectory(archived, root)).toBe(local);
    expect((await readClassicState(archived, { migrate: false })).run?.iteration).toBe(2);
  });
});
