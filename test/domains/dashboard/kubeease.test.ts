import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboardServer } from '../../../domains/dashboard/server.js';
import { maintainDashboardRepository } from '../../../domains/dashboard/project-repositories.js';
import { createKubeEaseClient } from '../../../platform/http/kubeease.js';

function frame(text: string) {
  const body = Buffer.from(text);
  const header =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([header, body]);
}

describe('Dashboard KE integration with an isolated HTTP/WebSocket service', () => {
  let root: string;
  let base: string;
  let endpoint: string;
  let repositoryId: string;
  let ke: http.Server;
  let dashboard: Awaited<ReturnType<typeof startDashboardServer>>;
  let requests: { url: string; body: Record<string, unknown>; token?: string; user?: string }[];
  let messages: Record<string, unknown>[];
  let fail = false;
  let noRuntime = false;
  let cachedUser = false;
  const token = 'fixture-only-token';
  const pipeline = '/pipeline/v1/group/tenant-project/pipelines/release';
  const app = '/amp/v4/namespace/tenant-project/env/dev/applications/core/appstatus/view';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-ke-'));
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('COMET_KE_HOSTS_FILE', path.join(root, 'credentials.json'));
    requests = [];
    messages = [];
    fail = false;
    noRuntime = false;
    cachedUser = false;
    ke = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      requests.push({
        url: req.url!,
        body: raw ? JSON.parse(raw) : {},
        token: req.headers['leo-user-token'] as string,
        user: req.headers['leo-user'] as string,
      });
      res.setHeader('Content-Type', 'application/json');
      if (fail) {
        res.statusCode = 403;
        res.end(token);
        return;
      }
      const url = req.url!;
      let data: unknown;
      if (url === '/user-center/v4/auth/userinfo') data = { userId: 'u', userName: 'fixture' };
      else if (url.includes('/projects/list'))
        data = {
          data: [
            {
              projectName: 'other',
              projectClusterList: [{ envName: 'wrong', proxyStatus: 'CONNECTED' }],
            },
            {
              projectName: 'project',
              projectClusterList: [
                { envName: 'dev', proxyStatus: 'CONNECTED' },
                { envName: 'offline', proxyStatus: 'DISCONNECTED' },
              ],
            },
          ],
        };
      else if (url.startsWith(app))
        data = {
          workloads: [
            {
              name: 'core',
              replicas: 2,
              readyReplicas: 1,
              unstructured: {
                status: { updatedReplicas: 2 },
                spec: { template: { spec: { containers: [{ name: 'main', image: 'core:1' }] } } },
              },
              pods: [
                {
                  name: 'core-pod',
                  status: 'Running',
                  unstructured: {
                    spec: { containers: [{ name: 'main' }, { name: 'sidecar' }] },
                    status: { containerStatuses: [{ restartCount: 2 }] },
                  },
                },
                {
                  metadata: { name: 'native-pod' },
                  spec: { containers: [{ name: 'main' }] },
                  status: { phase: 'Running' },
                },
              ],
            },
          ],
        };
      else if (url === `${pipeline}/view`)
        data = {
          argumentHistory: [
            {
              global_args: {
                branch: 'previous',
                url: 'https://example.invalid/core.git',
                review: 'secret-review',
                'ke-nick-name': 'someone',
              },
            },
          ],
          data: { meta_data: { global: [{ name: 'branch', desc: '发布分支', value: 'main' }] } },
        };
      else if (url === `${pipeline}/runtimes/create`) data = noRuntime ? {} : { name: 'run-exact' };
      else if (url.includes('/runtimes/list'))
        data = {
          data: [
            { data: { name: 'run-newest' }, phase: 1 },
            { name: 'run-exact', phase: 3 },
          ],
        };
      else if (url.includes('/logs/view'))
        data = {
          data: `build failed ${token} https://example.invalid/log?access_token=fixture-robot&x=1`,
        };
      else if (url.includes('/runtimes/') && url.includes('/view'))
        data = {
          currentPhase: 3,
          stages: [{ displayName: '构建', phase: 3, message: 'exit code 1', podName: 'build-pod' }],
        };
      else {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.end(JSON.stringify({ rtnCode: '000000', rtnData: data }));
    });
    ke.on('upgrade', (req, socket) => {
      const accept = createHash('sha1')
        .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(frame('o'));
      let data = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (data.length < 6 || (data[0] & 15) !== 1) return;
        let size = data[1] & 127;
        let offset = 2;
        if (size === 126) {
          if (data.length < 8) return;
          size = data.readUInt16BE(2);
          offset = 4;
        }
        if (data.length < offset + 4 + size) return;
        const mask = data.subarray(offset, offset + 4);
        const body = Buffer.from(data.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        const message = JSON.parse(JSON.parse(body.toString())[0]);
        messages.push(message);
        socket.write(frame('h'));
        const text =
          message.tailLines === 500
            ? 'x'.repeat(140 * 1024)
            : `\u001b[31mcontainer ${message.previous ? 'previous' : 'current'} ${token}\n`;
        // Send several bounded frames to exercise output truncation.
        for (let i = 0; i < text.length; i += 16_000)
          socket.write(
            frame('a' + JSON.stringify([JSON.stringify({ Data: text.slice(i, i + 16_000) })])),
          );
        socket.end(Buffer.from([0x88, 2, 3, 232]));
        data = Buffer.alloc(0);
      });
    });
    await new Promise<void>((resolve) => ke.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(ke.address() as AddressInfo).port}`;
    await credentials();
    const workspace = path.join(root, 'workspace');
    const web = path.join(root, 'web');
    await fs.mkdir(workspace);
    await fs.mkdir(web);
    await fs.writeFile(path.join(web, 'index.html'), '<title>fixture</title>');
    const bound = await maintainDashboardRepository(workspace, {
      action: 'bind',
      repository: {
        remote: 'https://example.invalid/core.git',
        name: 'core',
        kind: 'backend',
        ke_pipeline: {
          base_url: base,
          tenant: 'tenant',
          project: 'project',
          application: 'core',
          environment: '',
          pipeline: 'release',
          action: 'run',
          arguments: { branch: 'online_test' },
        },
      },
    });
    repositoryId = bound.repositories[0].id;
    dashboard = await startDashboardServer({ projectPath: workspace, webRoot: web, port: 0 });
    const directory = await (
      await fetch(`http://127.0.0.1:${dashboard.port}/api/dashboard/projects`)
    ).json();
    endpoint = `http://127.0.0.1:${dashboard.port}/api/dashboard/projects/${directory.currentProjectId}/kubernetes`;
  });
  async function credentials() {
    await fs.writeFile(
      path.join(root, 'credentials.json'),
      JSON.stringify({
        hosts: {
          [base]: {
            leoUserToken: token,
            ...(cachedUser ? { leoUser: '{"userId":"u","userName":"fixture"}' } : {}),
          },
        },
      }),
    );
  }
  async function post(action: string, data: Record<string, unknown> = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryId, action, ...data }),
    });
    return { status: response.status, data: await response.json() };
  }
  afterEach(async () => {
    await dashboard?.close();
    ke?.closeAllConnections();
    await new Promise<void>((resolve) => ke?.close(() => resolve()));
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('prepares editable parameters and sends one confirmed run with exact runtime association', async () => {
    const prepared = await post('ke-prepare');
    expect(prepared.status).toBe(200);
    expect(prepared.data.parameters).toEqual([
      { name: 'branch', label: '发布分支', value: 'online_test' },
      { name: 'url', label: 'url', value: 'https://example.invalid/core.git' },
    ]);
    expect(requests.some((r) => r.url.endsWith('/create'))).toBe(false);
    const args = { branch: 'release', url: 'https://example.invalid/core.git' };
    expect(
      (await post('ke-run', { confirmation: prepared.data.confirmation, arguments: args })).status,
    ).toBe(409);
    expect(
      (
        await post('ke-run', {
          confirmation: prepared.data.confirmation,
          confirmed: true,
          arguments: { ...args, review: 'bypass' },
        })
      ).status,
    ).toBe(400);
    const input = { confirmation: prepared.data.confirmation, confirmed: true, arguments: args };
    const [first, second] = await Promise.all([post('ke-run', input), post('ke-run', input)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first, second].find((r) => r.status === 200)?.data.runtime).toBe('run-exact');
    const creates = requests.filter((r) => r.url.endsWith('/create'));
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toMatchObject({
      deadline: 86400,
      globalArguments: { ...args, review: '', 'ke-nick-name': '' },
    });
    expect(creates[0].user).toBe('{"userId":"u","userName":"fixture"}');
    const records = await post('ke-runtimes');
    expect(records.data.runtimes[0].name).toBe('run-newest');
    const detail = await post('ke-runtime', { runtime: 'run-exact' });
    expect(detail.data.phase).toBe(3);
    const logs = await post('ke-pipeline-logs', { runtime: 'run-exact', pod: 'build-pod' });
    expect(logs.data.logs).toContain('build failed');
    expect(logs.data.logs).not.toContain(token);
    expect(logs.data.logs).not.toContain('fixture-robot');
    expect(requests.at(-1)?.url).toContain('/run-exact/logs/view');
    expect(
      (await post('ke-pipeline-logs', { runtime: 'run-exact', pod: 'unrelated' })).status,
    ).toBe(400);
  });

  it('returns explicit uncertainty when create has no runtime id and rejects stale workspace confirmations', async () => {
    const prepared = await post('ke-prepare');
    expect(
      (
        await post('ke-run', {
          confirmation: prepared.data.confirmation,
          confirmed: true,
          arguments: { branch: 'test', url: 'url' },
          repositoryId: 'other',
        })
      ).status,
    ).toBe(404);
    noRuntime = true;
    const result = await post('ke-run', {
      confirmation: prepared.data.confirmation,
      confirmed: true,
      arguments: { branch: 'test', url: 'url' },
    });
    expect(result.data).toMatchObject({ submitted: true, runtime: null });
    expect(requests.some((r) => r.url.includes('/runtimes/list'))).toBe(false);
  });

  it('selects connected environments, normalizes pods and retrieves previous logs over real WebSocket frames', async () => {
    expect((await post('ke-environments')).data).toEqual({ environments: ['dev'] });
    expect((await post('ke-status')).status).toBe(400);
    expect((await post('ke-status', { environment: 'offline' })).status).toBe(409);
    const status = await post('ke-status', {
      environment: 'dev',
      namespace: 'ignored',
      application: 'ignored',
    });
    expect(status.data).toMatchObject({
      namespace: 'tenant-project',
      desiredReplicas: 2,
      readyReplicas: 1,
      updatedReplicas: 2,
    });
    expect(status.data.pods).toEqual([
      { name: 'core-pod', phase: 'Running', restarts: 2, containers: ['main', 'sidecar'] },
      { name: 'native-pod', phase: 'Running', restarts: 0, containers: ['main'] },
    ]);
    expect(
      (await post('ke-logs', { environment: 'dev', pod: 'other', container: 'main' })).status,
    ).toBe(400);
    expect(
      (await post('ke-logs', { environment: 'dev', pod: 'core-pod', container: 'absent' })).status,
    ).toBe(400);
    expect(
      (
        await post('ke-logs', {
          environment: 'dev',
          pod: 'core-pod',
          container: 'main',
          tail: 2000,
        })
      ).status,
    ).toBe(400);
    expect(messages).toHaveLength(0);
    const logs = await post('ke-logs', {
      environment: 'dev',
      pod: 'core-pod',
      container: 'sidecar',
      previous: true,
      tail: 100,
    });
    expect(logs.status).toBe(200);
    expect(logs.data.logs).toContain('container previous');
    expect(logs.data.logs).not.toContain(token);
    expect(logs.data.logs).not.toContain('\u001b');
    expect(messages[0]).toMatchObject({
      cluster: 'dev',
      tenantName: 'tenant',
      projectName: 'project',
      podName: 'core-pod',
      containerName: 'sidecar',
      previous: true,
      tailLines: 100,
    });
    const large = await post('ke-logs', {
      environment: 'dev',
      pod: 'core-pod',
      container: 'main',
      tail: 500,
    });
    expect(large.data.truncated).toBe(true);
    expect(Buffer.byteLength(large.data.logs)).toBeLessThanOrEqual(128 * 1024);
  });

  it('expires confirmations and invalidates them after binding configuration changes', async () => {
    const prepared = await post('ke-prepare');
    const input = {
      confirmation: prepared.data.confirmation,
      confirmed: true,
      arguments: { branch: 'release', url: 'url' },
    };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    try {
      expect((await post('ke-run', input)).status).toBe(409);
    } finally {
      clock.mockRestore();
    }
    const next = await post('ke-prepare');
    const file = path.join(root, 'workspace/.comet/dashboard-repositories.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.repositories[0].ke_pipeline.pipeline = 'changed';
    await fs.writeFile(file, JSON.stringify(saved));
    expect((await post('ke-run', { ...input, confirmation: next.data.confirmation })).status).toBe(
      409,
    );
    expect(requests.some((r) => r.url.endsWith('/create'))).toBe(false);
  });

  it('uses host-specific credentials, sanitizes service failures and rejects missing credentials', async () => {
    fail = true;
    const rejected = await post('ke-runtimes');
    expect(rejected.status).toBe(502);
    expect(JSON.stringify(rejected.data)).not.toContain(token);
    fail = false;
    await fs.writeFile(
      path.join(root, 'credentials.json'),
      JSON.stringify({ hosts: { 'https://wrong.invalid': { leoUserToken: token } } }),
    );
    expect((await post('ke-prepare')).status).toBe(409);
    cachedUser = true;
    await credentials();
    requests = [];
    expect((await post('ke-runtimes')).status).toBe(200);
    expect(requests.some((r) => r.url.includes('/userinfo'))).toBe(false);
    const controller = new AbortController();
    controller.abort();
    const client = await createKubeEaseClient(root, base, controller.signal);
    await expect(client.logs({})).rejects.toThrow('取消');
  });
});
