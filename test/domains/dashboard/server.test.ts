import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import http from 'http';
import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import * as kubernetes from '../../../platform/process/kubernetes.js';
import { maintainDashboardRepository } from '../../../domains/dashboard/project-repositories.js';
import { startDashboardServer } from '../../../domains/dashboard/server.js';
import { resolveDashboardStaticPath } from '../../../domains/dashboard/server.js';
import { upsertProjectInstallation } from '../../../platform/install/project-registry.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/comet-native/native-config.js';
import { nativeProjectPaths } from '../../../domains/comet-native/native-paths.js';
import {
  createNativeChange,
  nativeChangeDir,
} from '../../../domains/comet-native/native-change.js';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// vitest's bundled fetch (undici) refuses to bind a 127.0.0.1 outbound on
// some macOS configs (EADDRNOTAVAIL with Local 0.0.0.0). The native http
// client picks the right local address, so the server tests use it directly.
function request(
  port: number,
  urlPath: string,
  options: http.RequestOptions = {},
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', ...options },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('startDashboardServer', () => {
  let projectDir: string;
  let webDir: string;
  let handles: Array<{ close: () => Promise<void> }> = [];

  beforeEach(async () => {
    projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'comet-srv-proj-')));
    webDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'comet-srv-web-')));
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(webDir, 'home'));
    await fs.writeFile(
      path.join(webDir, 'index.html'),
      '<!doctype html><title>Dashboard</title><p>hi</p>',
    );
    await fs.writeFile(path.join(webDir, 'app.js'), 'console.log(1);');
  });

  afterEach(async () => {
    await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
    handles = [];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(webDir, { recursive: true, force: true });
  });

  it('streams AI analysis only for registered projects and bound repositories with bounded snapshots', async () => {
    const analyzeLogs = vi.fn(async (_prompt, options) => {
      options.onMessage('L1: 合成异常');
    });
    const server = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
      analyzeLogs,
    });
    handles.push(server);
    const directory = JSON.parse((await request(server.port, '/api/dashboard/projects')).body);
    const bound = await maintainDashboardRepository(projectDir, {
      action: 'bind',
      repository: {
        remote: 'https://example.invalid/core.git',
        name: 'core',
        kind: 'backend',
      },
    });
    const endpoint = `/api/dashboard/projects/${directory.currentProjectId}/log-analysis`;
    const body = {
      repositoryId: bound.repositories[0].id,
      question: '为什么失败？',
      logs: 'ERROR fixture',
      source: 'container',
    };
    const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
    expect((await request(server.port, endpoint)).status).toBe(405);
    expect((await request(server.port, endpoint, { method: 'POST' }, body)).status).toBe(415);
    expect(
      (
        await request(
          server.port,
          endpoint,
          { ...post, headers: { ...post.headers, origin: 'https://external.invalid' } },
          body,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(server.port, '/api/dashboard/projects/unknown/log-analysis', post, body))
        .status,
    ).toBe(404);
    expect(
      (await request(server.port, endpoint, post, { ...body, repositoryId: 'unknown' })).status,
    ).toBe(404);
    expect(
      (await request(server.port, endpoint, post, { ...body, logs: 'x'.repeat(128 * 1024 + 1) }))
        .status,
    ).toBe(400);
    expect(analyzeLogs).not.toHaveBeenCalled();
    const response = await request(server.port, endpoint, post, {
      ...body,
      logs: '"'.repeat(128 * 1024),
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(
      response.body
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).type),
    ).toEqual(['status', 'message', 'complete']);
    expect(JSON.parse(analyzeLogs.mock.calls[0][0]).snapshot).toBe(`L1: ${'"'.repeat(128 * 1024)}`);
    expect(
      (await request(server.port, endpoint, post, { ...body, extra: 'x'.repeat(1024 * 1024) }))
        .status,
    ).toBe(413);
  });

  it('cancels CLI analysis when its browser connection closes and conceals unexpected errors', async () => {
    const cancelled = vi.fn();
    let waiting = true;
    const analyzeLogs = vi.fn(async (_prompt, options) => {
      if (!waiting) throw new Error('private-fixture-secret');
      await new Promise<void>((resolve) =>
        options.signal.addEventListener(
          'abort',
          () => {
            cancelled();
            resolve();
          },
          { once: true },
        ),
      );
    });
    const server = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
      analyzeLogs,
    });
    handles.push(server);
    const directory = JSON.parse((await request(server.port, '/api/dashboard/projects')).body);
    const bound = await maintainDashboardRepository(projectDir, {
      action: 'bind',
      repository: {
        remote: 'https://example.invalid/core.git',
        name: 'core',
        kind: 'backend',
      },
    });
    const endpoint = `/api/dashboard/projects/${directory.currentProjectId}/log-analysis`;
    const body = {
      repositoryId: bound.repositories[0].id,
      question: '分析',
      logs: 'ERROR fixture',
      source: 'pipeline',
    };
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: endpoint,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.once('data', () => {
            res.destroy();
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    waiting = false;
    const result = await request(
      server.port,
      endpoint,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      body,
    );
    const events = result.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(result.body).not.toContain('private-fixture-secret');
  });

  it('initializes only the registered selected project through the bounded JSON endpoint', async () => {
    const initializeProject = vi.fn().mockResolvedValue({ status: 'complete', failures: [] });
    const server = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
      initializeProject,
    });
    handles.push(server);
    const directory = JSON.parse((await request(server.port, '/api/dashboard/projects')).body);
    const endpoint = `/api/dashboard/projects/${directory.currentProjectId}/initialization`;
    expect(JSON.parse((await request(server.port, endpoint)).body)).toMatchObject({
      available: true,
      config: null,
    });
    const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const options = {
      platform: 'codex',
      workflow: 'native',
      language: 'zh',
      artifactRoot: 'docs',
      overwrite: false,
      codegraph: 'skip',
    };
    expect((await request(server.port, endpoint, { method: 'POST' }, options)).status).toBe(415);
    expect(
      (
        await request(
          server.port,
          endpoint,
          { ...post, headers: { ...post.headers, origin: 'https://external.invalid' } },
          options,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(server.port, '/api/dashboard/projects/unknown/initialization', post, options))
        .status,
    ).toBe(404);
    expect(
      (await request(server.port, endpoint, post, { ...options, path: '/elsewhere' })).status,
    ).toBe(400);
    expect(initializeProject).not.toHaveBeenCalled();
    const response = await request(server.port, endpoint, post, options);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: 'complete' });
    expect(initializeProject).toHaveBeenCalledExactlyOnceWith(projectDir, options);
  });

  it('queries only saved Kubernetes targets with project isolation and normal API protections', async () => {
    const status = vi.spyOn(kubernetes, 'inspectKubernetesDeployment').mockResolvedValue({
      context: 'saved',
      namespace: 'test',
      deployment: 'core',
      desiredReplicas: 1,
      readyReplicas: 1,
      updatedReplicas: 1,
      containers: [],
      pods: [],
      checkedAt: 'now',
    });
    const logs = vi.spyOn(kubernetes, 'readKubernetesLogs').mockResolvedValue({
      logs: 'test output',
      pod: 'core-abc',
      container: 'core',
      checkedAt: 'now',
    });
    const contexts = vi.spyOn(kubernetes, 'listKubernetesContexts').mockResolvedValue(['saved']);
    const server = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
    });
    handles.push(server);
    const directory = JSON.parse((await request(server.port, '/api/dashboard/projects')).body);
    const endpoint = `/api/dashboard/projects/${directory.currentProjectId}/kubernetes`;
    const headers = { 'content-type': 'application/json' };
    const post = (body: unknown, url = endpoint) =>
      request(server.port, url, { method: 'POST', headers }, body);
    const bound = await maintainDashboardRepository(projectDir, {
      action: 'bind',
      repository: { remote: 'https://example.invalid/core.git', name: 'core', kind: 'backend' },
    });
    const repositoryId = bound.repositories[0].id;
    expect((await request(server.port, endpoint)).status).toBe(405);
    expect((await request(server.port, endpoint, { method: 'HEAD' })).status).toBe(405);
    expect((await post({ action: 'run', repositoryId })).status).toBe(400);
    expect((await post({ action: 'status', repositoryId: 'missing' })).status).toBe(404);
    expect((await post({ action: 'status', repositoryId })).status).toBe(409);
    expect(status).not.toHaveBeenCalled();
    const target = { context: 'saved', namespace: 'test', deployment: 'core', container: '' };
    await maintainDashboardRepository(projectDir, {
      action: 'edit',
      id: repositoryId,
      repository: { ...bound.repositories[0], kubernetes: target },
    });
    expect(
      (await request(server.port, endpoint, { method: 'POST' }, { action: 'status', repositoryId }))
        .status,
    ).toBe(415);
    for (const unsafeHeaders of [
      { ...headers, origin: 'https://external.invalid' },
      { ...headers, host: 'external.invalid' },
    ])
      expect(
        (
          await request(
            server.port,
            endpoint,
            { method: 'POST', headers: unsafeHeaders },
            { action: 'status', repositoryId },
          )
        ).status,
      ).toBe(403);
    expect(
      (await post({ action: 'status', repositoryId, context: 'other', namespace: 'other' })).status,
    ).toBe(200);
    expect(status).toHaveBeenCalledWith(target, expect.any(AbortSignal));
    expect(
      JSON.parse(
        (await post({ action: 'logs', repositoryId, pod: 'core-abc', container: 'core' })).body,
      ),
    ).toMatchObject({ logs: 'test output' });
    expect(logs).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ pod: 'core-abc' }),
      expect.any(AbortSignal),
    );
    expect(JSON.parse((await request(server.port, `${endpoint}/contexts`)).body)).toEqual({
      contexts: ['saved'],
    });
    expect((await post({}, `${endpoint}/contexts`)).status).toBe(405);
    expect(contexts).toHaveBeenCalledTimes(1);
    const other = path.join(webDir, 'other-project');
    await fs.mkdir(other);
    const added = JSON.parse(
      (
        await request(
          server.port,
          '/api/dashboard/projects',
          { method: 'POST', headers },
          { path: other },
        )
      ).body,
    );
    expect(
      (
        await post(
          { action: 'status', repositoryId },
          `/api/dashboard/projects/${added.projectId}/kubernetes`,
        )
      ).status,
    ).toBe(404);
    status.mockRejectedValueOnce(new kubernetes.KubectlError('kubectl unavailable'));
    expect((await post({ action: 'status', repositoryId })).status).toBe(502);
    expect((await post({}, `${endpoint}/publish`)).status).toBe(405);
  });

  it('adds readable paths without installing files, deduplicates aliases and preserves installation metadata', async () => {
    const target = path.join(webDir, '中文 project');
    const alias = path.join(webDir, 'alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const handle = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
    });
    handles.push(handle);
    const add = (projectPath: unknown) =>
      request(
        handle.port,
        '/api/dashboard/projects',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        { path: projectPath },
      );
    const added = await add(target);
    expect(added.status).toBe(200);
    const result = JSON.parse(added.body);
    expect(result.directory.projects).toHaveLength(2);
    expect(
      result.directory.projects.find((entry: { id: string }) => entry.id === result.projectId).path,
    ).toBe(await fs.realpath(target));
    expect(await fs.readdir(target)).toEqual([]);
    expect(JSON.parse((await add(alias)).body).directory.projects).toHaveLength(2);
    const installed = await upsertProjectInstallation(
      await fs.realpath(target),
      [{ platform: 'codex', language: 'zh' }],
      'update',
    );
    await add(target);
    const { readProjectRegistry } = await import('../../../platform/install/project-registry.js');
    expect(
      (await readProjectRegistry()).projects.find(
        (entry) => entry.canonicalPath === installed.canonicalPath,
      ),
    ).toEqual(installed);
    for (const invalid of [
      'relative',
      '',
      path.join(webDir, 'missing'),
      path.join(webDir, 'index.html'),
      null,
    ]) {
      expect((await add(invalid)).status).toBe(400);
    }
    expect(
      (await request(handle.port, '/api/dashboard/projects', { method: 'POST' }, { path: target }))
        .status,
    ).toBe(415);
    expect(
      (
        await request(
          handle.port,
          '/api/dashboard/projects',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://example.com' },
          },
          { path: target },
        )
      ).status,
    ).toBe(403);
    const reopened = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
    });
    handles.push(reopened);
    expect(
      JSON.parse((await request(reopened.port, '/api/dashboard/projects')).body).projects,
    ).toHaveLength(2);
    expect(
      (await request(reopened.port, `/api/dashboard/projects/${result.projectId}/overview`)).status,
    ).toBe(200);
  });

  it('maintains project repository bindings through trusted JSON requests and clones into the workspace', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(webDir, 'empty-gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    const remote = path.join(webDir, 'repository');
    await fs.mkdir(remote);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', remote, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
        { stdio: 'pipe' },
      );
    git('init', '-b', 'main');
    await fs.writeFile(path.join(remote, 'README.md'), 'remote code');
    git('add', '.');
    git('commit', '-m', 'fixture');
    const server = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
    });
    handles.push(server);
    const directory = JSON.parse((await request(server.port, '/api/dashboard/projects')).body);
    const endpoint = `/api/dashboard/projects/${directory.currentProjectId}/repositories`;
    expect(JSON.parse((await request(server.port, endpoint)).body)).toMatchObject({
      repositories: [],
      initialized: false,
    });
    const body = {
      action: 'bind',
      repository: {
        remote,
        name: 'web-app',
        kind: 'frontend',
        branch: 'main',
        tags: ['用户端', '票务'],
      },
    };
    expect((await request(server.port, endpoint, { method: 'POST' }, body)).status).toBe(415);
    expect(
      (
        await request(
          server.port,
          endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://example.com' },
          },
          body,
        )
      ).status,
    ).toBe(403);
    const post = (value: unknown) =>
      request(
        server.port,
        endpoint,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        value,
      );
    expect((await post({ action: 'invalid' })).status).toBe(400);
    const bound = await post(body);
    expect(bound.status).toBe(200);
    const id = JSON.parse(bound.body).repositories[0].id;
    expect(JSON.parse((await request(server.port, endpoint)).body).repositories[0].tags).toEqual([
      '用户端',
      '票务',
    ]);
    expect((await post(body)).status).toBe(409);
    expect((await post({ action: 'sync', id: 'unknown' })).status).toBe(404);
    const synced = await post({ action: 'sync', id });
    expect(synced.status).toBe(200);
    expect(JSON.parse(synced.body).result.action).toBe('cloned');
    const file = path.join(projectDir, 'engineering/frontend/web-app/README.md');
    expect(await fs.readFile(file, 'utf8')).toBe('remote code');
    expect((await post({ action: 'unbind', id })).status).toBe(200);
    expect(await fs.readFile(file, 'utf8')).toBe('remote code');
    expect(JSON.parse((await request(server.port, endpoint)).body).repositories).toEqual([]);
    const discovery = JSON.parse((await request(server.port, `${endpoint}/discovery`)).body);
    expect(discovery.candidates).toMatchObject([
      { name: 'web-app', kind: 'frontend', branch: 'main' },
    ]);
    expect(
      (
        await request(
          server.port,
          `${endpoint}/discovery`,
          { method: 'POST', headers: { 'content-type': 'application/json' } },
          {},
        )
      ).status,
    ).toBe(405);
    const imported = await post({ action: 'initialize', paths: ['engineering/frontend/web-app'] });
    expect(imported.status).toBe(200);
    expect(JSON.parse(imported.body)).toMatchObject({
      initialized: true,
      repositories: [{ name: 'web-app', lastSyncedAt: null }],
    });
    expect(
      JSON.parse((await request(server.port, `${endpoint}/discovery`)).body).candidates,
    ).toEqual([]);
  });

  it('opens the directory picker only through trusted JSON POST and does not register a selection', async () => {
    const chooseDirectory = vi
      .fn()
      .mockResolvedValueOnce(projectDir)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('没有桌面，请手动输入'));
    const handle = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
      chooseDirectory,
    });
    handles.push(handle);
    const endpoint = '/api/dashboard/projects/choose-directory';
    expect((await request(handle.port, endpoint)).status).toBe(405);
    expect(
      (
        await request(
          handle.port,
          endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://example.com' },
          },
          {},
        )
      ).status,
    ).toBe(403);
    const choose = () =>
      request(
        handle.port,
        endpoint,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        {},
      );
    expect(JSON.parse((await choose()).body)).toEqual({ path: projectDir });
    expect(JSON.parse((await choose()).body)).toEqual({ path: null });
    const failed = await choose();
    expect(failed.status).toBe(503);
    expect(JSON.parse(failed.body).error).toContain('手动输入');
    expect(
      JSON.parse((await request(handle.port, '/api/dashboard/projects')).body).projects,
    ).toHaveLength(1);
  });

  it('removes a missing project only through a trusted JSON POST without deleting files', async () => {
    const missing = path.join(webDir, 'missing-project');
    await upsertProjectInstallation(missing, [], 'init');
    await upsertProjectInstallation(projectDir, [], 'init');
    const handle = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
    });
    handles.push(handle);
    const directory = JSON.parse((await request(handle.port, '/api/dashboard/projects')).body);
    const entry = directory.projects.find((project: { path: string }) => project.path === missing);
    const endpoint = `/api/dashboard/projects/${entry.id}/forget`;
    expect((await request(handle.port, endpoint)).status).toBe(405);
    expect(
      (
        await request(handle.port, endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://example.com',
          },
        })
      ).status,
    ).toBe(403);
    expect((await request(handle.port, endpoint, { method: 'POST' })).status).toBe(415);
    expect(
      (
        await request(handle.port, `/api/dashboard/projects/${directory.currentProjectId}/forget`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(409);
    // Recreated projects must be rechecked at mutation time.
    await fs.mkdir(missing);
    await fs.writeFile(path.join(missing, 'keep.txt'), 'keep');
    expect(
      (
        await request(handle.port, endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
        })
      ).status,
    ).toBe(409);
    expect(await fs.readFile(path.join(missing, 'keep.txt'), 'utf8')).toBe('keep');
    await fs.rm(missing, { recursive: true });
    const removed = await request(handle.port, endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    });
    expect(removed.status).toBe(200);
    expect(JSON.parse(removed.body).projects).toHaveLength(1);
    expect(
      (
        await request(handle.port, endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
        })
      ).status,
    ).toBe(404);
  });

  it('preserves the launch identity after a symlink target is deleted', async () => {
    const alias = path.join(webDir, 'launch-alias');
    await fs.symlink(projectDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await upsertProjectInstallation(alias, [], 'init');
    const handle = await startDashboardServer({ projectPath: alias, webRoot: webDir, port: 0 });
    handles.push(handle);
    const before = JSON.parse((await request(handle.port, '/api/dashboard/projects')).body);
    await fs.rm(projectDir, { recursive: true });
    const after = JSON.parse((await request(handle.port, '/api/dashboard/projects')).body);
    expect(after.currentProjectId).toBe(before.currentProjectId);
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0].isCurrent).toBe(true);
    expect(
      (
        await request(handle.port, `/api/dashboard/projects/${before.currentProjectId}/forget`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(409);
  });

  it.each([false, true])(
    'keeps reads and writes bound to the launch target when an alias is retargeted (registered=%s)',
    async (registered) => {
      const alias = path.join(webDir, 'unregistered-launch-alias');
      const replacement = path.join(webDir, 'replacement-project');
      await fs.mkdir(replacement);
      await writeProjectConfig(projectDir, defaultProjectConfig('docs'));
      await writeProjectConfig(replacement, defaultProjectConfig('docs'));
      const replacementConfigPath = path.join(replacement, '.comet', 'config.yaml');
      const replacementConfig = await fs.readFile(replacementConfigPath, 'utf8');
      await fs.symlink(projectDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
      if (registered) await upsertProjectInstallation(alias, [], 'init');
      const handle = await startDashboardServer({ projectPath: alias, webRoot: webDir, port: 0 });
      handles.push(handle);
      const before = JSON.parse((await request(handle.port, '/api/dashboard/projects')).body);
      const endpoint = `/api/dashboard/projects/${before.currentProjectId}/config`;
      const loadedResponse = await request(handle.port, endpoint);
      expect(loadedResponse.status).toBe(200);
      const loaded = JSON.parse(loadedResponse.body);
      await fs.unlink(alias);
      await fs.symlink(replacement, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const overview = JSON.parse(
        (await request(handle.port, `/api/dashboard/projects/${before.currentProjectId}/overview`))
          .body,
      );
      expect(overview.project.path).toBe(projectDir);
      const updated = await request(
        handle.port,
        endpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        {
          expectedRevision: loaded.revision,
          config: {
            defaultWorkflow: loaded.defaultWorkflow,
            workflows: loaded.workflows,
            ambientResume: false,
            hookAllowPaths: loaded.hookAllowPaths,
            native: loaded.native,
            classic: loaded.classic,
          },
        },
      );
      expect(updated.status).toBe(200);
      expect(JSON.parse(updated.body).ambientResume).toBe(false);
      expect(await fs.readFile(replacementConfigPath, 'utf8')).toBe(replacementConfig);
    },
  );

  it('routes same-remote worktrees to their own overview and current change details', async () => {
    const linked = path.join(webDir, 'linked');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', projectDir, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    git('remote', 'add', 'origin', 'https://example.com/team/shared.git');
    git('worktree', 'add', '-b', 'linked', linked);
    await upsertProjectInstallation(linked, [], 'init', { homeDir: os.homedir() });
    for (const [root, branch] of [
      [projectDir, 'main'],
      [linked, 'linked'],
    ]) {
      const changeDir = path.join(root, 'openspec', 'changes', 'same-name');
      await fs.mkdir(changeDir, { recursive: true });
      await fs.writeFile(
        path.join(changeDir, '.comet.yaml'),
        `phase: build\nbound_branch: ${branch}\n`,
      );
      await fs.writeFile(path.join(changeDir, 'proposal.md'), `# ${branch} proposal\n`);
      await fs.writeFile(path.join(changeDir, 'tasks.md'), `- [ ] ${branch} task\n`);
    }
    const handle = await startDashboardServer({
      projectPath: projectDir,
      webRoot: webDir,
      port: 0,
    });
    handles.push(handle);
    const directory = JSON.parse((await request(handle.port, '/api/dashboard/projects')).body) as {
      projects: Array<{ id: string; path: string }>;
    };
    expect(new Set(directory.projects.map(({ id }) => id)).size).toBe(2);
    for (const entry of directory.projects) {
      const branch = entry.path === projectDir ? 'main' : 'linked';
      const base = `/api/dashboard/projects/${entry.id}`;
      const overview = await request(handle.port, `${base}/overview`);
      expect(overview.status).toBe(200);
      expect(JSON.parse(overview.body)).toMatchObject({
        project: { path: entry.path },
        git: { branch },
      });
      const page = await request(handle.port, `${base}/changes?status=active`);
      expect(page.status).toBe(200);
      const current = JSON.parse(page.body).items.find(
        (item: { workspace: { current: boolean } }) => item.workspace.current,
      );
      expect(current).toBeDefined();
      const detail = await request(
        handle.port,
        `${base}/change?changeLocator=${encodeURIComponent(current.locator)}`,
      );
      expect(detail.status).toBe(200);
      expect(JSON.parse(detail.body)).toMatchObject({
        path: path.join(entry.path, 'openspec', 'changes', 'same-name'),
        artifactPreviews: expect.arrayContaining([
          expect.objectContaining({ key: 'proposal', content: `# ${branch} proposal\n` }),
        ]),
      });
    }
  });

  it('serves /api/dashboard with a valid snapshot payload', async () => {
    const handle = await startDashboardServer({
      projectPath: projectDir,
      port: 0,
      webRoot: webDir,
    });
    handles.push(handle);

    const res = await request(handle.port, '/api/dashboard');
    expect(res.status).toBe(200);
    const snap = JSON.parse(res.body) as Record<string, unknown>;

    expect(snap).toMatchObject({
      project: expect.objectContaining({ path: projectDir }),
      summary: expect.objectContaining({
        activeChanges: 0,
        archivedChanges: 0,
      }),
      changes: { active: [], archived: [] },
    });
  });

  it('lists the current project and only resolves snapshot requests by registered project id', async () => {
    const handle = await startDashboardServer({
      projectPath: projectDir,
      port: 0,
      webRoot: webDir,
    });
    handles.push(handle);

    const directoryResponse = await request(handle.port, '/api/dashboard/projects');
    expect(directoryResponse.status).toBe(200);
    const directory = JSON.parse(directoryResponse.body) as {
      currentProjectId: string;
      projects: Array<{ id: string; path: string }>;
    };
    expect(directory.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: projectDir })]),
    );

    const snapshotResponse = await request(
      handle.port,
      `/api/dashboard/projects/${directory.currentProjectId}`,
    );
    expect(snapshotResponse.status).toBe(200);
    expect(JSON.parse(snapshotResponse.body)).toMatchObject({
      project: expect.objectContaining({ path: projectDir }),
    });

    const unknownResponse = await request(handle.port, '/api/dashboard/projects/not-a-project-id');
    expect(unknownResponse.status).toBe(404);
    expect(JSON.parse(unknownResponse.body)).toEqual({ error: 'Unknown dashboard project id' });
  });

  it('serves paginated change rows and loads a selected change detail on demand', async () => {
    const changesRoot = path.join(projectDir, 'openspec', 'changes');
    await fs.mkdir(changesRoot, { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      const changeDir = path.join(changesRoot, `server-${index}`);
      await fs.mkdir(changeDir, { recursive: true });
      await fs.writeFile(path.join(changeDir, '.comet.yaml'), 'phase: build\n');
      await fs.writeFile(path.join(changeDir, 'tasks.md'), '- [ ] pending\n');
      await fs.writeFile(path.join(changeDir, 'proposal.md'), '# Proposal\n');
    }

    const handle = await startDashboardServer({
      projectPath: projectDir,
      port: 0,
      webRoot: webDir,
    });
    handles.push(handle);

    const directoryResponse = await request(handle.port, '/api/dashboard/projects');
    const directory = JSON.parse(directoryResponse.body) as { currentProjectId: string };
    const base = `/api/dashboard/projects/${directory.currentProjectId}`;

    const overviewResponse = await request(handle.port, `${base}/overview`);
    expect(overviewResponse.status).toBe(200);
    expect(JSON.parse(overviewResponse.body)).toMatchObject({
      summary: { activeChanges: 6 },
    });
    expect(JSON.parse(overviewResponse.body)).not.toHaveProperty('changes');

    const pageResponse = await request(handle.port, `${base}/changes?status=active&limit=5`);
    expect(pageResponse.status).toBe(200);
    const page = JSON.parse(pageResponse.body) as {
      items: Array<{ id: string; locator: string; status: string }>;
      total: number;
      nextCursor: string | null;
    };
    expect(page.total).toBe(6);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toEqual(expect.any(String));

    const detailResponse = await request(
      handle.port,
      `${base}/change?changeLocator=${encodeURIComponent(page.items[0].locator)}`,
    );
    expect(detailResponse.status).toBe(200);
    expect(JSON.parse(detailResponse.body)).toMatchObject({
      id: page.items[0].id,
      locator: page.items[0].locator,
      artifacts: expect.any(Object),
      artifactPreviews: expect.any(Array),
    });
  });

  it('serves Native changes from a paginated endpoint instead of embedding them in overview', async () => {
    await writeProjectConfig(projectDir, defaultProjectConfig('docs'));
    const paths = await nativeProjectPaths(projectDir, 'docs');
    for (let index = 0; index < 6; index += 1) {
      const state = await createNativeChange({
        paths,
        name: `native-server-${index}`,
        language: 'en',
      });
      await fs.writeFile(path.join(nativeChangeDir(paths, state.name), 'brief.md'), '# Outcome\n');
    }

    const handle = await startDashboardServer({
      projectPath: projectDir,
      port: 0,
      webRoot: webDir,
    });
    handles.push(handle);

    const directoryResponse = await request(handle.port, '/api/dashboard/projects');
    const directory = JSON.parse(directoryResponse.body) as { currentProjectId: string };
    const base = `/api/dashboard/projects/${directory.currentProjectId}`;

    const overviewResponse = await request(handle.port, `${base}/overview`);
    expect(overviewResponse.status).toBe(200);
    expect(JSON.parse(overviewResponse.body)).toMatchObject({
      native: {
        totalChangeCount: 6,
        activeChangeCount: 6,
        changes: [],
      },
    });

    const firstResponse = await request(
      handle.port,
      `${base}/native-changes?status=active&limit=5`,
    );
    expect(firstResponse.status).toBe(200);
    const first = JSON.parse(firstResponse.body) as {
      items: Array<{ name: string; status: string; locator: string }>;
      total: number;
      nextCursor: string | null;
    };
    expect(first.total).toBe(6);
    expect(first.items).toHaveLength(5);
    expect(first.items.every((item) => item.status === 'active')).toBe(true);
    expect(first.items[0]).not.toHaveProperty('artifacts');
    expect(first.nextCursor).toEqual(expect.any(String));

    const detailResponse = await request(
      handle.port,
      `${base}/native-change?status=active&changeLocator=${encodeURIComponent(first.items[0].locator)}`,
    );
    expect(detailResponse.status).toBe(200);
    expect(JSON.parse(detailResponse.body)).toMatchObject({
      name: first.items[0].name,
      locator: first.items[0].locator,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ key: 'comet-state.yaml' }),
        expect.objectContaining({ key: 'brief' }),
      ]),
    });

    const secondResponse = await request(
      handle.port,
      `${base}/native-changes?status=active&limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(secondResponse.status).toBe(200);
    expect(JSON.parse(secondResponse.body)).toMatchObject({
      total: 6,
      items: expect.arrayContaining([expect.objectContaining({ name: 'native-server-5' })]),
      nextCursor: null,
    });
  });

  it('rejects a Native page limit above the Classic Dashboard maximum', async () => {
    await writeProjectConfig(projectDir, defaultProjectConfig('docs'));

    const handle = await startDashboardServer({
      projectPath: projectDir,
      port: 0,
      webRoot: webDir,
    });
    handles.push(handle);

    const directoryResponse = await request(handle.port, '/api/dashboard/projects');
    const directory = JSON.parse(directoryResponse.body) as { currentProjectId: string };
    const response = await request(
      handle.port,
      `/api/dashboard/projects/${directory.currentProjectId}/native-changes?status=active&limit=51`,
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toContain('between 1 and 50');
  });

  it('serves the static index for the root path', async () => {
    const handle = await startDashboardServer({
      projectPath: projectDir,
      port: 0,
      webRoot: webDir,
    });
    handles.push(handle);

    const res = await request(handle.port, '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Dashboard');
  });

  it('serves static assets next to index.html', async () => {
    const handle = await startDashboardServer({
      projectPath: projectDir,
      port: 0,
      webRoot: webDir,
    });
    handles.push(handle);

    const res = await request(handle.port, '/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.body).toContain('console.log');
  });

  it('rejects static paths that escape its web root', () => {
    expect(resolveDashboardStaticPath(webDir, '/../etc/passwd')).toBeNull();
  });

  it('rejects encoded path traversal attempts', async () => {
    const handle = await startDashboardServer({
      projectPath: projectDir,
      port: 0,
      webRoot: webDir,
    });
    handles.push(handle);

    const response = await request(handle.port, '/%2e%2e/etc/passwd');
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: 'Not found' });
  });

  it('falls back to the next available port when the requested one is taken', async () => {
    const blocker = await new Promise<net.Server>((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
    const blockedPort = (blocker.address() as net.AddressInfo).port;

    try {
      const handle = await startDashboardServer({
        projectPath: projectDir,
        port: blockedPort,
        webRoot: webDir,
      });
      handles.push(handle);
      expect(handle.port).toBeGreaterThan(blockedPort);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
