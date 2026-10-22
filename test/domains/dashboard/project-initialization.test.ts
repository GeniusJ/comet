import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboardProjectInitializer } from '../../../domains/dashboard/project-initialization.js';

const options = {
  platform: 'codex',
  workflow: 'native',
  language: 'zh',
  artifactRoot: 'docs',
  overwrite: false,
  codegraph: 'skip',
};

describe('Dashboard project initialization', () => {
  let project: string;
  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-init-'));
  });
  afterEach(async () => fs.rm(project, { recursive: true, force: true }));

  it('reports a missing config without writing project files', async () => {
    const initializer = createDashboardProjectInitializer();
    expect(await initializer.collect(project)).toMatchObject({
      available: false,
      config: null,
      configError: null,
      busy: false,
    });
    expect(await fs.readdir(project)).toEqual([]);
    await expect(initializer.run(project, options)).rejects.toMatchObject({ statusCode: 503 });
  });

  it.each([
    { platform: '../../elsewhere' },
    { workflow: 'other' },
    { language: 'sh' },
    { artifactRoot: '../outside' },
    { artifactRoot: ' ../outside ' },
    { artifactRoot: '/outside' },
    { artifactRoot: 'C:\\outside' },
    { artifactRoot: 'docs/../../outside' },
    { artifactRoot: '' },
    { artifactRoot: 'docs\nother' },
    { scope: 'global' },
    { path: '/another-project' },
    { overwrite: 'true' },
    { codegraph: 'shell' },
  ])('rejects unsafe or unsupported input %j before invoking CLI', async (invalid) => {
    const runner = vi.fn();
    const initializer = createDashboardProjectInitializer(runner);
    await expect(initializer.run(project, { ...options, ...invalid })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('serializes initialization and releases the slot after an error', async () => {
    let reject!: (error: Error) => void;
    const runner = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, failure) => {
            reject = failure;
          }),
      )
      .mockResolvedValue({
        status: 'incomplete',
        failures: [{ component: 'Hook', reason: 'unavailable' }],
      });
    const initializer = createDashboardProjectInitializer(runner);
    const pending = initializer.run(project, options);
    expect(await initializer.collect(project)).toMatchObject({ running: true, busy: true });
    await expect(initializer.run(project, options)).rejects.toMatchObject({ statusCode: 409 });
    reject(new Error('failed'));
    await expect(pending).rejects.toThrow('failed');
    expect(await initializer.run(project, options)).toMatchObject({ status: 'incomplete' });
    expect(await initializer.collect(project)).toMatchObject({ running: false, busy: false });
    expect(runner).toHaveBeenLastCalledWith(project, options);
  });
});
