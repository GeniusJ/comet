import { execFileSync } from 'node:child_process';
import { ensureClassicRuntimeRun } from '../../../domains/comet-classic/classic-runtime-run.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runClassicCli } from '../../../domains/comet-classic/classic-cli.js';
import { withClassicCommandContext } from '../../../domains/comet-classic/classic-command-context.js';
import { readClassicState } from '../../../domains/comet-classic/classic-store.js';
import {
  readTrajectory,
  appendTrajectory,
} from '../../../domains/comet-classic/classic-run-store.js';
import { resolveClassicRunDirectory } from '../../../domains/comet-classic/classic-runtime-paths.js';
import { createClassicSdkStateStore } from '../../../domains/comet-classic/classic-sdk-state-store.js';
import {
  classicProjectTargetExists,
  readClassicProjectFile,
  writeClassicProjectText,
} from '../../../domains/comet-classic/classic-protected-path.js';
import {
  isWorkspaceRuntimeMigrationFence,
  resolveWorkspaceRuntimeRoot,
} from '../../../domains/workflow-contract/workspace-runtime.js';
import { prepareClassicLegacyProject } from '../../helpers/classic-project.js';

describe('Classic workspace-local runtime storage', () => {
  let directory: string;
  let root: string;
  let change: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-classic-home-'));
    vi.stubEnv('COMET_DATA_DIR', path.join(directory, 'user-data'));
    root = path.join(directory, 'project');
    await fs.mkdir(root);
    await prepareClassicLegacyProject(root);
    change = path.join(root, 'openspec', 'changes', 'demo');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function initialize(runtime: 'compat' | 'sdk') {
    const result = await withClassicCommandContext({ projectRoot: root, invocationCwd: root }, () =>
      runClassicCli(['state', 'init', 'demo', 'full', '--runtime', runtime, '--json']),
    );
    expect(result.exitCode, result.stderr).toBe(0);
  }

  it('blocks old compat writers immediately after initialization and permits current writes', async () => {
    await initialize('compat');
    const lock = path.join(change, '.comet-state.lock');
    const runtime = await resolveWorkspaceRuntimeRoot(root);
    expect(
      await isWorkspaceRuntimeMigrationFence(lock, path.join(runtime, 'classic-legacy-state.lock')),
    ).toBe(true);
    await expect(fs.open(lock, 'wx')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(fs.access(path.join(change, '.comet', 'run-state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const result = await withClassicCommandContext({ projectRoot: root, invocationCwd: root }, () =>
      runClassicCli(['state', 'set', 'demo', 'language', 'zh-CN', '--json']),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await fs.readFile(path.join(change, '.comet.yaml'), 'utf8')).toContain(
      'language: zh-CN',
    );
    expect(await fs.lstat(lock).then((stat) => stat.isDirectory())).toBe(true);
  });

  it('blocks old compat writers when adopting YAML with no legacy local records', async () => {
    await fs.mkdir(change, { recursive: true });
    await fs.writeFile(path.join(change, '.comet.yaml'), 'workflow: full\nphase: open\n');
    const local = await resolveClassicRunDirectory(change, root);
    await expect(fs.open(path.join(change, '.comet-state.lock'), 'wx')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await resolveClassicRunDirectory(change, root)).toBe(local);
    await expect(fs.access(path.join(local, '.comet-state.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps compat Run state, trajectory and Skill snapshots outside the project', async () => {
    await initialize('compat');
    await ensureClassicRuntimeRun(change);
    const projection = await readClassicState(change);
    expect(projection.run).not.toBeNull();
    const local = await resolveClassicRunDirectory(change, root);
    expect(local.startsWith(path.join(directory, 'user-data') + path.sep)).toBe(true);
    expect(await fs.readFile(path.join(local, '.comet', 'run-state.json'), 'utf8')).toContain(
      projection.run!.runId,
    );
    expect(await fs.readdir(path.join(local, '.comet', 'skill-snapshots'))).toContain(
      projection.run!.skillHash,
    );
    await expect(fs.access(path.join(change, '.comet', 'run-state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await appendTrajectory(change, projection.run!.trajectoryRef, {
      sequence: 100,
      timestamp: new Date().toISOString(),
      type: 'home-test',
      runId: projection.run!.runId,
      data: {},
    });
    expect((await readTrajectory(change, projection.run!.trajectoryRef)).at(-1)?.type).toBe(
      'home-test',
    );
    expect(await fs.readFile(path.join(change, '.comet.yaml'), 'utf8')).toContain('run_id:');
  });

  it('stores SDK Run and projection at the workspace root and retains portable YAML', async () => {
    await initialize('sdk');
    const run = await createClassicSdkStateStore(root).read('demo');
    expect(run?.runId).toBe('demo');
    const runtime = await resolveWorkspaceRuntimeRoot(root);
    expect(await fs.readdir(path.join(runtime, 'sdk-runs', 'classic'))).not.toHaveLength(0);
    expect(
      await fs.readFile(path.join(runtime, 'state-projections', 'classic', 'demo.json'), 'utf8'),
    ).toContain('demo');
    await expect(fs.access(path.join(root, '.comet', 'runtime', 'sdk-runs'))).rejects.toMatchObject(
      { code: expect.stringMatching(/ENOENT|ENOTDIR/) },
    );
    expect(await fs.readFile(path.join(change, 'comet-state.yaml'), 'utf8')).toContain(
      'run_checkpoint:',
    );
  });

  it('migrates legacy local logs while preserving handoff and resolves them after archive', async () => {
    await fs.mkdir(path.join(change, '.comet', 'checks'), { recursive: true });
    await fs.mkdir(path.join(change, '.comet', 'handoff'));
    await fs.writeFile(path.join(change, '.comet.yaml'), 'workflow: full\nphase: open\n');
    await fs.writeFile(path.join(change, '.comet', 'checks', 'old.log'), 'old execution evidence');
    await fs.writeFile(path.join(change, '.comet', 'handoff', 'context.json'), '{"portable":true}');
    const ref = 'openspec/changes/demo/.comet/checks/old.log';
    expect(await readClassicProjectFile(root, ref, { label: 'legacy check' })).toBe(
      'old execution evidence',
    );
    await writeClassicProjectText(root, ref, 'new execution evidence', { label: 'local check' });
    const local = await resolveClassicRunDirectory(change, root);
    expect(await fs.readFile(path.join(local, '.comet', 'checks', 'old.log'), 'utf8')).toBe(
      'new execution evidence',
    );
    expect(
      await fs.readFile(path.join(change, '.comet', 'handoff', 'context.json'), 'utf8'),
    ).toContain('portable');
    const archived = path.join(root, 'openspec', 'changes', 'archive', '2026-10-11-demo');
    await fs.mkdir(path.dirname(archived), { recursive: true });
    await fs.rename(change, archived);
    expect(await resolveClassicRunDirectory(archived, root)).toBe(local);
    expect(
      await readClassicProjectFile(root, path.join(archived, '.comet', 'checks', 'old.log'), {
        label: 'archived check',
      }),
    ).toBe('new execution evidence');
  });

  it('keeps the same instance after checkout recreation and separates reused names', async () => {
    await initialize('compat');
    await ensureClassicRuntimeRun(change);
    const first = await readClassicState(change);
    const original = await resolveClassicRunDirectory(change, root);
    const yaml = await fs.readFile(path.join(change, '.comet.yaml'));
    await fs.rm(change, { recursive: true });
    await fs.mkdir(change);
    await fs.writeFile(path.join(change, '.comet.yaml'), yaml);
    expect(await resolveClassicRunDirectory(change, root)).toBe(original);
    expect((await readClassicState(change)).run?.runId).toBe(first.run?.runId);
    const archived = path.join(root, 'openspec', 'changes', 'archive', '2026-10-11-demo');
    await fs.rename(change, archived);
    await initialize('compat');
    await ensureClassicRuntimeRun(change);
    expect(await resolveClassicRunDirectory(change, root)).not.toBe(original);
    expect((await readClassicState(change)).run?.runId).not.toBe(first.run?.runId);
    expect((await readClassicState(archived)).run?.runId).toBe(first.run?.runId);
  });

  it.each(['lock', 'transaction', 'execution'])(
    'preserves legacy YAML byte-for-byte when old %s blocks migration',
    async (kind) => {
      await fs.mkdir(change, { recursive: true });
      const source = '# legacy state\nworkflow: full\nphase: open\n';
      await fs.writeFile(path.join(change, '.comet.yaml'), source);
      if (kind === 'lock')
        await fs.writeFile(
          path.join(change, '.comet-state.lock'),
          JSON.stringify({ pid: process.pid }),
        );
      else if (kind === 'transaction')
        await fs.writeFile(
          path.join(change, '.comet-state-transaction.json'),
          JSON.stringify({
            schema: 'comet.classic.state-transaction.v1',
            beforeYaml: source,
            afterYaml: source + 'language: en\n',
            beforeRun: null,
            afterRun: null,
          }),
        );
      else {
        await fs.mkdir(path.join(change, '.comet'));
        await fs.writeFile(
          path.join(change, '.comet', 'trajectory.jsonl'),
          JSON.stringify({
            sequence: 1,
            timestamp: new Date().toISOString(),
            runId: 'legacy-run',
            type: 'command_check_started',
            data: { scope: 'build' },
          }) + '\n',
        );
      }
      await expect(resolveClassicRunDirectory(change, root)).rejects.toThrow();
      expect(await fs.readFile(path.join(change, '.comet.yaml'), 'utf8')).toBe(source);
    },
  );

  it('does not create a state file while probing a missing local record', async () => {
    for (const exists of [false, true]) {
      if (exists) await fs.mkdir(change, { recursive: true });
      expect(
        await classicProjectTargetExists(root, path.join(change, '.comet', 'checkpoint.json'), {
          label: 'Missing checkpoint',
          expected: 'file',
        }),
      ).toBe(false);
      for (const filename of ['comet-state.yaml', '.comet.yaml']) {
        await expect(fs.access(path.join(change, filename))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    }
  });

  it('rejects a second same-workspace projection with a copied instance UUID', async () => {
    await initialize('compat');
    await ensureClassicRuntimeRun(change);
    const original = await readClassicState(change);
    const copied = path.join(root, 'openspec', 'changes', 'copied');
    await fs.cp(change, copied, { recursive: true });
    await expect(readClassicState(copied)).rejects.toThrow(/Duplicate Classic change_id/);
    expect((await readClassicState(change)).run?.runId).toBe(original.run?.runId);
  });

  it('rejects an SDK store retained across git init and recovers into the new workspace identity', async () => {
    vi.stubEnv('GIT_CEILING_DIRECTORIES', directory);
    await initialize('sdk');
    const store = createClassicSdkStateStore(root);
    const original = await store.read('demo');
    const previousRoot = await resolveWorkspaceRuntimeRoot(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    expect(await resolveWorkspaceRuntimeRoot(root)).not.toBe(previousRoot);
    await expect(store.read('demo')).rejects.toThrow('workspace identity changed');
    await expect(
      store.compareAndSwap('demo', original!.revision, {
        ...original!,
        revision: original!.revision + 1,
      }),
    ).rejects.toThrow('workspace identity changed');
    const recovered = await createClassicSdkStateStore(root).read('demo');
    expect(recovered!.actions).toEqual(original!.actions);
    expect(recovered!.revision).toBe(original!.revision);
  });

  it('isolates equal change names across workspaces', async () => {
    await initialize('sdk');
    const other = path.join(directory, 'other-project');
    await fs.mkdir(other);
    await prepareClassicLegacyProject(other);
    expect(await createClassicSdkStateStore(other).read('demo')).toBeNull();
    expect(await resolveWorkspaceRuntimeRoot(other)).not.toBe(
      await resolveWorkspaceRuntimeRoot(root),
    );
  });
});
