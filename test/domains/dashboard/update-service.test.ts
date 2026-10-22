import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { checkForUpdate } from '../../../platform/version/version.js';
import { listProjectRegistryEntries } from '../../../platform/install/project-registry.js';
import { spawnCometCommand } from '../../../platform/process/comet-command.js';
import { createDashboardUpdateService } from '../../../domains/dashboard/update-service.js';
import { startDashboardServer } from '../../../domains/dashboard/server.js';

vi.mock('../../../platform/version/version.js', async (original) => ({
  ...(await original<typeof import('../../../platform/version/version.js')>()),
  checkForUpdate: vi.fn(),
}));
vi.mock('../../../platform/install/project-registry.js', async (original) => ({
  ...(await original<typeof import('../../../platform/install/project-registry.js')>()),
  listProjectRegistryEntries: vi.fn(),
}));
vi.mock('../../../platform/process/comet-command.js', () => ({ spawnCometCommand: vi.fn() }));

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
const version = { currentVersion: '0.5.0', latestVersion: '0.5.1', hasUpdate: true, checked: true };
const entries = [
  {
    path: '/project-a',
    canonicalPath: '/project-a',
    lastTargets: [{ platform: 'claude', language: 'zh' }],
  },
];
describe('Dashboard update confirmation and logs', () => {
  beforeEach(() => {
    vi.mocked(checkForUpdate).mockResolvedValue(version);
    vi.mocked(listProjectRegistryEntries).mockResolvedValue(
      entries as Awaited<ReturnType<typeof listProjectRegistryEntries>>,
    );
    vi.mocked(spawnCometCommand).mockImplementation(
      () => child() as unknown as ReturnType<typeof spawnCometCommand>,
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  it('checks cached npm metadata and indexed scope without starting an update', async () => {
    const service = createDashboardUpdateService('/cwd');
    expect(await service.status()).toMatchObject({
      ...version,
      projects: ['/project-a'],
      job: null,
    });
    await service.status();
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(spawnCometCommand).not.toHaveBeenCalled();
  });
  it('rejects missing confirmation, npm failures, and drift in version or project scope', async () => {
    const service = createDashboardUpdateService('/cwd');
    const initial = await service.status();
    const body = { confirmed: true, version: '0.5.1', projectRevision: initial.projectRevision };
    await expect(service.start({ ...body, confirmed: false })).rejects.toThrow('确认');
    await expect(service.start({ ...body, version: '0.5.2' })).rejects.toThrow('已变化');
    vi.mocked(listProjectRegistryEntries).mockResolvedValueOnce([]);
    await expect(service.start(body)).rejects.toThrow('已变化');
    vi.mocked(checkForUpdate).mockResolvedValueOnce({ ...version, checked: false });
    await expect(service.start(body)).rejects.toThrow('无法连接 npm');
    expect(spawnCometCommand).not.toHaveBeenCalled();
  });
  it('starts one pinned all-projects CLI command and replays sanitized incremental output', async () => {
    vi.stubEnv('TEST_API_KEY', 'fixture-secret-token');
    const process = child();
    vi.mocked(spawnCometCommand).mockReturnValue(
      process as unknown as ReturnType<typeof spawnCometCommand>,
    );
    const service = createDashboardUpdateService('/cwd');
    const info = await service.status();
    const body = { confirmed: true, version: '0.5.1', projectRevision: info.projectRevision };
    const results = await Promise.allSettled([service.start(body), service.start(body)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(spawnCometCommand).toHaveBeenCalledExactlyOnceWith(
      ['update', '--all-projects', '--yes', '--target-version', '0.5.1'],
      '/cwd',
    );
    const cursor = service.readJob()!.cursor;
    process.stdout.write('npm install: fixture-secret-');
    expect(service.readJob(cursor)!.entries).toHaveLength(0);
    process.stdout.write('token\n');
    process.stderr.write('auth_token=example-value\n');
    const text = service
      .readJob(cursor)!
      .entries.map((entry) => entry.text)
      .join('');
    expect(text).not.toContain('fixture-secret-token');
    expect(text).not.toContain('example-value');
    expect(text).toContain('[redacted]');
    process.emit('close', 1);
    expect(service.readJob()).toMatchObject({ status: 'failed', exitCode: 1 });
    const retry = await service.start(body);
    expect(retry!.id).not.toBe(results.find((result) => result.status === 'fulfilled')!.value!.id);
    expect(retry!.status).toBe('running');
  });
  it('bounds log history, flushes trailing output, and marks completion only on exit zero', async () => {
    const process = child();
    vi.mocked(spawnCometCommand).mockReturnValue(
      process as unknown as ReturnType<typeof spawnCometCommand>,
    );
    const service = createDashboardUpdateService('/cwd');
    const info = await service.status();
    await service.start({
      confirmed: true,
      version: '0.5.1',
      projectRevision: info.projectRevision,
    });
    for (let i = 0; i < 20; i++) process.stdout.write('x'.repeat(40_000) + '\n');
    process.stderr.write('trailing warning');
    process.emit('close', 0);
    const job = service.readJob()!;
    expect(job).toMatchObject({ status: 'completed', exitCode: 0, truncated: true });
    expect(
      job.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0),
    ).toBeLessThanOrEqual(512 * 1024);
    expect(job.entries.at(-1)!.text).toBe('trailing warning');
  });
  it('accepts only a trusted confirmed JSON POST through the HTTP server', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-update-http-'));
    const handle = await startDashboardServer({ projectPath: root, webRoot: root, port: 0 });
    const request = (method: string, origin?: string, body?: unknown) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: handle.port,
            path: '/api/dashboard/update',
            method,
            headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => {
              text += chunk;
            });
            res.on('end', () =>
              resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }),
            );
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    try {
      const info = await request('GET');
      const body = {
        confirmed: true,
        version: '0.5.1',
        projectRevision: info.body.projectRevision,
      };
      expect((await request('POST', 'https://example.com', body)).status).toBe(403);
      expect((await request('POST', undefined, {})).status).toBe(400);
      expect(spawnCometCommand).not.toHaveBeenCalled();
      expect((await request('POST', undefined, body)).status).toBe(202);
      expect((await request('POST', undefined, body)).status).toBe(409);
    } finally {
      await handle.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
