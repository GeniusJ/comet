import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../../app/commands/doctor.js';
import { statusCommand } from '../../app/commands/status.js';
import { inspectCometProjectStatus } from '../../domains/comet-entry/project-status.js';
import { runClassicCli } from '../../domains/comet-classic/classic-cli.js';
import { prepareClassicLegacyProject } from '../helpers/classic-project.js';

async function snapshot(root: string) {
  const entries: Record<string, { mtime: number; content: string | null }> = {};
  async function visit(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file);
      entries[path.relative(root, file)] = {
        mtime: stat.mtimeMs,
        content: stat.isFile() ? (await fs.readFile(file)).toString('base64') : null,
      };
      if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
  return entries;
}

describe('project Doctor SDK read-only diagnostics', () => {
  it.each(['comet-state.yaml', '.comet.yaml'] as const)(
    'reads Classic state at %s in Doctor and status without moving it',
    async (stateFileName) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-doctor-state-name-'));
      const home = path.join(root, 'home');
      const exitCode = process.exitCode;
      await fs.mkdir(home);
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      try {
        execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
        await prepareClassicLegacyProject(root);
        const initialized = await runClassicCli(
          ['state', 'init', 'named-state', 'full', '--runtime', 'compat', '--isolation', 'current'],
          undefined,
          { projectRoot: root, invocationCwd: root },
        );
        expect(initialized.exitCode, initialized.stdout).toBe(0);
        const changeDir = path.join(root, 'openspec/changes/named-state');
        if (stateFileName === 'comet-state.yaml') {
          await fs.rename(path.join(changeDir, '.comet.yaml'), path.join(changeDir, stateFileName));
        }
        const before = await snapshot(root);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await doctorCommand(root, { json: true, scope: 'project', homeDir: home });
        const doctor = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
        log.mockClear();
        await statusCommand(root, { json: true });
        const status = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
        expect(doctor.results).toContainEqual({
          check: `${stateFileName}: named-state`,
          status: 'pass',
          message: expect.stringContaining('valid'),
        });
        expect(status.workflows.classic.changes).toContainEqual(
          expect.objectContaining({
            name: 'named-state',
            cometManaged: true,
            phase: 'open',
          }),
        );
        expect(await snapshot(root)).toEqual(before);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        process.exitCode = exitCode;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['file', 'dangling-symlink'] as const)(
    'reports conflicting SDK Classic states including a %s with zero writes',
    async (legacyKind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-doctor-state-conflict-'));
      const home = path.join(root, 'home');
      const exitCode = process.exitCode;
      await fs.mkdir(home);
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      try {
        execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
        await prepareClassicLegacyProject(root);
        const initialized = await runClassicCli(
          ['state', 'init', 'conflict', 'full', '--isolation', 'current', '--json'],
          undefined,
          { projectRoot: root, invocationCwd: root },
        );
        expect(initialized.exitCode, initialized.stdout).toBe(0);
        const legacyPath = path.join(root, 'openspec/changes/conflict/.comet.yaml');
        if (legacyKind === 'file') {
          await fs.writeFile(legacyPath, 'phase: verify\n');
        } else {
          try {
            await fs.symlink('missing-state.yaml', legacyPath, 'file');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
            throw error;
          }
        }
        const before = await snapshot(root);
        const writes = [
          vi.spyOn(fs, 'mkdir'),
          vi.spyOn(fs, 'writeFile'),
          vi.spyOn(fs, 'rename'),
          vi.spyOn(fs, 'unlink'),
        ];
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await doctorCommand(root, { json: true, scope: 'project', homeDir: home });
        const doctor = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
        log.mockClear();
        await statusCommand(root, { json: true });
        const status = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
        expect(doctor.results).toContainEqual({
          check: 'comet-state.yaml: conflict',
          status: 'fail',
          message: expect.stringMatching(/comet-state\.yaml.*\.comet\.yaml/u),
        });
        expect(status.workflows.classic.changes).toContainEqual(
          expect.objectContaining({
            name: 'conflict',
            cometManaged: true,
            error: expect.stringMatching(/comet-state\.yaml.*\.comet\.yaml/u),
          }),
        );
        for (const write of writes) expect(write).not.toHaveBeenCalled();
        expect(await snapshot(root)).toEqual(before);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        process.exitCode = exitCode;
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it('retains a missing non-selected Classic projection without creating transient locks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-doctor-sdk-readonly-'));
    const home = path.join(root, 'home');
    const exitCode = process.exitCode;
    await fs.mkdir(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
      await prepareClassicLegacyProject(root);
      const run = (args: string[]) =>
        runClassicCli(args, undefined, { projectRoot: root, invocationCwd: root });
      for (const name of ['broken', 'healthy']) {
        const initialized = await run([
          'state',
          'init',
          name,
          'full',
          '--isolation',
          'current',
          '--json',
        ]);
        expect(initialized.exitCode, initialized.stdout).toBe(0);
        expect((await run(['state', 'next', name, '--json'])).exitCode).toBe(0);
      }
      expect((await run(['state', 'select', 'healthy', '--json'])).exitCode).toBe(0);
      await fs.rm(path.join(root, 'openspec/changes/broken/comet-state.yaml'));
      const before = await snapshot(root);
      const writes = [
        vi.spyOn(fs, 'mkdir'),
        vi.spyOn(fs, 'writeFile'),
        vi.spyOn(fs, 'rename'),
        vi.spyOn(fs, 'unlink'),
      ];
      const status = await inspectCometProjectStatus(root);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await doctorCommand(root, { json: true, scope: 'project', homeDir: home });
      const doctor = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      log.mockRestore();
      expect(
        status.workflows.classic.changes.find((change) => change.name === 'broken')?.error,
      ).toBeTruthy();
      expect(
        status.workflows.classic.changes.find((change) => change.name === 'healthy')?.runtimeMode,
      ).toBe('sdk');
      expect(doctor.results).toContainEqual({
        check: 'comet-state.yaml: broken',
        status: 'fail',
        message: expect.stringContaining('requires recovery'),
      });
      expect(doctor.results).toContainEqual({
        check: 'comet-state.yaml: healthy',
        status: 'pass',
        message: expect.stringContaining('mode: sdk'),
      });
      expect(doctor.results).toContainEqual({
        check: 'current selection',
        status: 'pass',
        message: 'classic:healthy (open)',
      });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(await snapshot(root)).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      process.exitCode = exitCode;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
