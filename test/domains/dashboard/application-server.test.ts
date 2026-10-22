import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboardServer } from '../../../domains/dashboard/server.js';
import {
  applicationObservationFixture,
  creatorObservationFixture,
} from '../../helpers/dashboard-application-fixture.js';

describe('Comet Any read-only HTTP endpoints', () => {
  let root: string,
    project: string,
    server: Awaited<ReturnType<typeof startDashboardServer>> | null;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-any-http-'));
    project = path.join(root, 'project');
    await fs.mkdir(project);
    vi.stubEnv('COMET_DATA_DIR', path.join(root, 'data'));
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    server = null;
  });
  afterEach(async () => {
    await server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (url: string, method = 'GET', headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server!.port, path: url, method, headers },
        (res) => {
          let content = '';
          res.on('data', (chunk) => {
            content += chunk;
          });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(content || 'null') });
            } catch {
              resolve({ status: res.statusCode!, body: content });
            }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  it('serves scoped pages, detail, history and bound artifacts without advancing a run', async () => {
    const fixture = await applicationObservationFixture(project, { parallel: true, child: true });
    await creatorObservationFixture(project);
    server = await startDashboardServer({ projectPath: project, port: 0, webRoot: project });
    const directory = await request('/api/dashboard/projects');
    const base = `/api/dashboard/projects/${directory.body.currentProjectId}`;
    const page = await request(`${base}/application-runs`);
    expect(page.status).toBe(200);
    expect(page.body.items.some((r: any) => r.kind === 'creator')).toBe(true);
    const item = page.body.items.find((r: any) => r.runId === 'run-one');
    const query = `locator=${encodeURIComponent(item.locator)}`;
    const detail = await request(`${base}/application-run?${query}`);
    expect(detail.body.currentIds).toHaveLength(4);
    expect(
      (await request(`${base}/application-run-records?${query}&limit=1`)).body.nextCursor,
    ).toBeTruthy();
    expect(
      (
        await request(
          `${base}/application-run-artifact?${query}&artifactId=${detail.body.artifacts[0].id}`,
        )
      ).body.exists,
    ).toBe(true);
    expect(
      (await request(`${base}/application-runs`, 'POST', { 'content-type': 'application/json' }))
        .status,
    ).toBe(405);
    expect(
      (await request(`${base}/application-runs`, 'GET', { origin: 'https://example.com' })).status,
    ).toBe(403);
    expect(
      (await request('/api/dashboard/projects/not-this-project/application-runs')).status,
    ).toBe(404);
    expect((await fixture.outer.read('run-one'))?.run).toEqual(fixture.run);
  });
});
