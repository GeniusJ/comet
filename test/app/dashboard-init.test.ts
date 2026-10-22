import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDashboardProject } from '../../app/commands/dashboard-init.js';
import * as external from '../../platform/process/external-command.js';

afterEach(() => vi.restoreAllMocks());
describe('Dashboard init CLI adapter', () => {
  const options = {
    platform: 'codex',
    workflow: 'native' as const,
    language: 'zh' as const,
    artifactRoot: 'docs',
    overwrite: false,
    codegraph: 'skip' as const,
  };
  it('runs the existing init command in an isolated process with project scope and JSON output', async () => {
    const result = { status: 'incomplete', failures: [{ component: 'Hook', reason: 'failed' }] };
    const run = vi
      .spyOn(external, 'runExternalCommandAsync')
      .mockResolvedValue(JSON.stringify(result));
    expect(await initializeDashboardProject('/tmp/project with spaces', options)).toEqual(result);
    const [command, args, processOptions] = run.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args[3]).toMatch(/\/app\/commands\/init\.js$/u);
    expect(args[4]).toBe('/tmp/project with spaces');
    expect(JSON.parse(args[5])).toEqual({ ...options, yes: true, json: true, scope: 'project' });
    expect(processOptions).toMatchObject({ cwd: '/tmp/project with spaces', timeoutMs: 600_000 });
  });
  it('does not report malformed CLI output as success', async () => {
    vi.spyOn(external, 'runExternalCommandAsync').mockResolvedValue('{}');
    await expect(initializeDashboardProject('/tmp/project', options)).rejects.toThrow('有效结果');
  });
});
