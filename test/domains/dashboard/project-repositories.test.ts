import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  collectDashboardRepositories,
  discoverDashboardRepositories,
  maintainDashboardRepository,
} from '../../../domains/dashboard/project-repositories.js';
import { validateRepositoryRemote } from '../../../platform/process/managed-repository.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

describe('Dashboard repository maintenance', () => {
  let root: string;
  let workspace: string;
  let remote: string;
  const bind = (remote: string, kind = 'backend', name = 'service', branch = 'main') => ({
    action: 'bind',
    repository: { remote, kind, name, branch },
  });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'comet-repositories-')));
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'empty-gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    workspace = path.join(root, 'workspace');
    remote = path.join(root, 'remote');
    await fs.mkdir(workspace);
    await fs.mkdir(remote);
    git(remote, 'init', '-b', 'main');
    await fs.writeFile(path.join(remote, 'README.md'), 'first');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'initial');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('discovers immediate local Git roots by kind and imports only the selected repositories without fetching', async () => {
    git(workspace, 'init', '-b', 'main');
    const backend = path.join(workspace, 'engineering/backed/订单 service');
    const frontend = path.join(workspace, 'engineering/frontend/web');
    await fs.mkdir(path.dirname(backend), { recursive: true });
    await fs.mkdir(path.dirname(frontend), { recursive: true });
    git(workspace, 'clone', remote, backend);
    git(workspace, 'clone', remote, frontend);
    await fs.mkdir(path.join(workspace, 'engineering/backed/plain/nested'), { recursive: true });
    git(workspace, 'clone', remote, path.join(workspace, 'engineering/backed/plain/nested/repo'));
    await fs.symlink(
      frontend,
      path.join(workspace, 'engineering/frontend/linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // Offline origins and dirty working trees must remain discoverable without a fetch.
    git(backend, 'remote', 'set-url', 'origin', 'https://offline.invalid/service.git');
    await fs.writeFile(path.join(backend, 'local.txt'), 'keep');
    const head = git(backend, 'rev-parse', 'HEAD');
    const status = git(backend, 'status', '--porcelain');
    expect((await collectDashboardRepositories(workspace)).initialized).toBe(false);
    const local = await discoverDashboardRepositories(workspace);
    expect(local.candidates.map(({ name, kind, branch }) => ({ name, kind, branch }))).toEqual([
      { name: '订单 service', kind: 'backend', branch: 'main' },
      { name: 'web', kind: 'frontend', branch: 'main' },
    ]);
    await expect(fs.stat(path.join(workspace, '.comet'))).rejects.toMatchObject({ code: 'ENOENT' });
    const paths = [local.candidates[0].relativePath];
    const result = await maintainDashboardRepository(workspace, { action: 'initialize', paths });
    expect(result.initialized).toBe(true);
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({
      name: '订单 service',
      remote: 'https://offline.invalid/service.git',
      lastSyncedAt: null,
    });
    expect(git(backend, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(backend, 'status', '--porcelain')).toBe(status);
    await expect(fs.stat(path.join(backend, '.git/FETCH_HEAD'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await discoverDashboardRepositories(workspace)).candidates.map((entry) => entry.name),
    ).toEqual(['web']);
    const repeated = await maintainDashboardRepository(workspace, { action: 'initialize', paths });
    expect(repeated.repositories).toEqual(result.repositories);
    expect((await collectDashboardRepositories(workspace)).initialized).toBe(true);
  });

  it('reports unusable local repositories without leaking credentials and rejects stale or forged selections atomically', async () => {
    const base = path.join(workspace, 'engineering/backed');
    await fs.mkdir(base, { recursive: true });
    for (const name of ['valid', 'no-origin', 'secret', 'detached']) {
      git(workspace, 'clone', remote, path.join(base, name));
    }
    git(path.join(base, 'no-origin'), 'remote', 'remove', 'origin');
    git(
      path.join(base, 'secret'),
      'remote',
      'set-url',
      'origin',
      'https://user:private-token@example.com/repo',
    );
    git(path.join(base, 'detached'), 'checkout', '--detach');
    const local = await discoverDashboardRepositories(workspace);
    expect(local.candidates).toHaveLength(4);
    expect(local.candidates.filter((entry) => entry.issue)).toHaveLength(3);
    expect(JSON.stringify(local)).not.toContain('private-token');
    for (const paths of [
      ['engineering/backed/valid', 'engineering/backed/no-origin'],
      ['../../remote'],
      ['engineering/backed/secret'],
    ]) {
      await expect(
        maintainDashboardRepository(workspace, { action: 'initialize', paths }),
      ).rejects.toThrow('重新扫描');
      expect((await collectDashboardRepositories(workspace)).repositories).toEqual([]);
    }
    await fs.rm(path.join(base, 'valid/.git'), { recursive: true, force: true });
    await expect(
      maintainDashboardRepository(workspace, {
        action: 'initialize',
        paths: ['engineering/backed/valid'],
      }),
    ).rejects.toThrow('重新扫描');
  });

  it('remembers an empty initialization per workspace and rejects linked discovery roots', async () => {
    expect((await discoverDashboardRepositories(workspace)).candidates).toEqual([]);
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    await maintainDashboardRepository(workspace, { action: 'initialize', paths: [] });
    expect((await collectDashboardRepositories(workspace)).initialized).toBe(true);
    expect((await collectDashboardRepositories(other)).initialized).toBe(false);
    await fs.symlink(
      remote,
      path.join(workspace, 'engineering'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(discoverDashboardRepositories(workspace)).rejects.toThrow('链接');
  });

  it('binds multiple frontend/backend repositories, persists edits and unbinds without removing code', async () => {
    expect(await collectDashboardRepositories(workspace)).toEqual({
      workspace,
      repositories: [],
      initialized: false,
    });
    expect(await fs.readdir(workspace)).toEqual([]);
    const first = await maintainDashboardRepository(workspace, bind(remote));
    const id = first.repositories[0].id;
    expect(first.repositories[0].relativePath).toBe('engineering/backed/service');
    await maintainDashboardRepository(workspace, bind(remote, 'frontend', 'web'));
    await maintainDashboardRepository(workspace, {
      action: 'edit',
      id,
      repository: { remote, kind: 'backend', name: 'api', branch: 'main' },
    });
    expect(
      (await collectDashboardRepositories(workspace)).repositories.map(
        (entry) => entry.relativePath,
      ),
    ).toEqual(['engineering/backed/api', 'engineering/frontend/web']);
    await maintainDashboardRepository(workspace, { action: 'sync', id });
    const code = path.join(workspace, 'engineering/backed/api/README.md');
    expect(await fs.readFile(code, 'utf8')).toBe('first');
    await expect(
      maintainDashboardRepository(workspace, {
        action: 'edit',
        id,
        repository: { remote, kind: 'frontend', name: 'api', branch: 'main' },
      }),
    ).rejects.toThrow('已有本地代码');
    await maintainDashboardRepository(workspace, { action: 'unbind', id });
    expect((await collectDashboardRepositories(workspace)).repositories).toHaveLength(1);
    expect(await fs.readFile(code, 'utf8')).toBe('first');
  });

  it('persists normalized tags, supports removing them and preserves sync metadata when editing labels', async () => {
    const result = await maintainDashboardRepository(workspace, {
      ...bind(remote),
      repository: { ...bind(remote).repository, tags: [' 核心服务 ', '票务', '核心服务'] },
    });
    const entry = result.repositories[0];
    expect(entry.tags).toEqual(['核心服务', '票务']);
    await maintainDashboardRepository(workspace, { action: 'sync', id: entry.id });
    const synced = (await collectDashboardRepositories(workspace)).repositories[0];
    const edit = (tags?: unknown) =>
      maintainDashboardRepository(workspace, {
        action: 'edit',
        id: entry.id,
        repository: { ...bind(remote).repository, ...(tags === undefined ? {} : { tags }) },
      });
    expect((await edit(['支付', '核心服务'])).repositories[0]).toMatchObject({
      tags: ['支付', '核心服务'],
      lastSyncedAt: synced.lastSyncedAt,
    });
    expect((await edit()).repositories[0].tags).toEqual(['支付', '核心服务']);
    for (const tags of [
      null,
      'tag',
      [''],
      ['  '],
      ['bad\nlabel'],
      [123],
      ['x'.repeat(41)],
      Array.from({ length: 21 }, (_, index) => `tag-${index}`),
    ]) {
      await expect(edit(tags)).rejects.toThrow('标签');
      expect((await collectDashboardRepositories(workspace)).repositories[0].tags).toEqual([
        '支付',
        '核心服务',
      ]);
    }
    await edit([]);
    expect((await collectDashboardRepositories(workspace)).repositories[0].tags).toEqual([]);
  });

  it('reads legacy bindings with empty tags without rewriting the configuration', async () => {
    const result = await maintainDashboardRepository(workspace, bind(remote));
    const legacy = result.repositories.map(({ tags: _tags, ...entry }) => entry);
    const file = path.join(workspace, '.comet/dashboard-repositories.json');
    const text = JSON.stringify({ schemaVersion: 1, repositories: legacy });
    await fs.writeFile(file, text);
    expect((await collectDashboardRepositories(workspace)).repositories[0].tags).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe(text);
  });

  it('persists per-repository pipeline and runtime settings across sync and ordinary edits', async () => {
    const ke_pipeline = {
      base_url: 'http://pro.kubeease.cn',
      tenant: 'jstest',
      project: 'jstytest',
      application: 'core',
      environment: '',
      pipeline: 'coreceshiqianyi',
      action: 'run',
      arguments: { release: 'test', flags: [1, true] },
    };
    const kubernetes = { context: 'test', namespace: 'default', deployment: 'core', container: '' };
    const bound = await maintainDashboardRepository(workspace, {
      ...bind(remote),
      repository: { ...bind(remote).repository, ke_pipeline, kubernetes },
    });
    const id = bound.repositories[0].id;
    await maintainDashboardRepository(workspace, { action: 'sync', id });
    const synced = (await collectDashboardRepositories(workspace)).repositories[0];
    const edited = await maintainDashboardRepository(workspace, {
      action: 'edit',
      id,
      repository: { ...bind(remote).repository, tags: ['core'] },
    });
    expect(edited.repositories[0]).toMatchObject({
      ke_pipeline,
      kubernetes,
      lastSyncedAt: synced.lastSyncedAt,
    });
    const cleared = await maintainDashboardRepository(workspace, {
      action: 'edit',
      id,
      repository: { ...bind(remote).repository, ke_pipeline: null, kubernetes: null },
    });
    expect(cleared.repositories[0]).toMatchObject({ ke_pipeline: null, kubernetes: null });
    const file = path.join(workspace, '.comet/dashboard-repositories.json');
    const legacy = cleared.repositories.map(
      ({ kubernetes: _k, ke_pipeline: _p, ...entry }) => entry,
    );
    const raw = JSON.stringify({ schemaVersion: 1, repositories: legacy });
    await fs.writeFile(file, raw);
    expect((await collectDashboardRepositories(workspace)).repositories[0]).toMatchObject({
      ke_pipeline: null,
      kubernetes: null,
    });
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    for (const patch of [
      { ke_pipeline: { ...ke_pipeline, base_url: 'https://user:secret@host' } },
      { ke_pipeline: { ...ke_pipeline, base_url: 'file:///tmp/pipeline' } },
      { ke_pipeline: { ...ke_pipeline, action: 'delete' } },
      { ke_pipeline: { ...ke_pipeline, arguments: [] } },
      { ke_pipeline: { ...ke_pipeline, arguments: { value: 'x'.repeat(17000) } } },
      { kubernetes: { ...kubernetes, deployment: '../other' } },
      { kubernetes: { ...kubernetes, context: 'bad\ncontext' } },
    ]) {
      await expect(
        maintainDashboardRepository(workspace, {
          action: 'edit',
          id,
          repository: { ...bind(remote).repository, ...patch },
        }),
      ).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(raw);
    }
  });

  it('clones and fast-forwards a real repository but preserves dirty, divergent and mismatched workspaces', async () => {
    const entry = (await maintainDashboardRepository(workspace, bind(remote))).repositories[0];
    const sync = () => maintainDashboardRepository(workspace, { action: 'sync', id: entry.id });
    expect((await sync()).result?.action).toBe('cloned');
    const target = path.join(workspace, entry.relativePath);
    await fs.writeFile(path.join(remote, 'README.md'), 'second');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'second');
    expect((await sync()).result?.action).toBe('updated');
    expect(await fs.readFile(path.join(target, 'README.md'), 'utf8')).toBe('second');
    expect(
      (await collectDashboardRepositories(workspace)).repositories[0].lastSyncedAt,
    ).toBeTruthy();
    await fs.writeFile(path.join(target, 'local.txt'), 'keep');
    await expect(sync()).rejects.toThrow('未提交');
    git(target, 'add', '.');
    git(target, 'commit', '-m', 'local');
    await fs.writeFile(path.join(remote, 'remote.txt'), 'upstream');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'third');
    const oldHead = git(target, 'rev-parse', 'HEAD');
    await expect(sync()).rejects.toThrow('Git 操作失败');
    expect(git(target, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(await fs.readFile(path.join(target, 'local.txt'), 'utf8')).toBe('keep');
    git(target, 'remote', 'set-url', 'origin', path.join(root, 'wrong'));
    await expect(sync()).rejects.toThrow('origin');
  });

  it('rejects traversal, duplicate paths, linked directories, occupied folders and corrupt state', async () => {
    for (const name of ['../escape', 'CON', 'bad/name', '.git', 'bad.'])
      await expect(
        maintainDashboardRepository(workspace, bind(remote, 'backend', name)),
      ).rejects.toThrow();
    const entry = (await maintainDashboardRepository(workspace, bind(remote))).repositories[0];
    await expect(maintainDashboardRepository(workspace, bind(remote))).rejects.toThrow('已有绑定');
    await fs.mkdir(path.join(workspace, 'engineering/backed/service'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'engineering/backed/service/keep.txt'), 'keep');
    await expect(
      maintainDashboardRepository(workspace, { action: 'sync', id: entry.id }),
    ).rejects.toThrow();
    expect(
      await fs.readFile(path.join(workspace, 'engineering/backed/service/keep.txt'), 'utf8'),
    ).toBe('keep');
    await fs.rename(path.join(workspace, 'engineering'), path.join(root, 'outside'));
    await fs.symlink(
      path.join(root, 'outside'),
      path.join(workspace, 'engineering'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      maintainDashboardRepository(workspace, { action: 'sync', id: entry.id }),
    ).rejects.toThrow('链接');
    await fs.writeFile(path.join(workspace, '.comet/dashboard-repositories.json'), '{broken');
    await expect(collectDashboardRepositories(workspace)).rejects.toThrow('配置无效');
    await expect(maintainDashboardRepository(workspace, bind(remote))).rejects.toThrow('配置无效');
    expect(
      await fs.readFile(path.join(workspace, '.comet/dashboard-repositories.json'), 'utf8'),
    ).toBe('{broken');
  });

  it('isolates projects, ignores an id on new bindings and clones the default or a named branch', async () => {
    const other = path.join(root, 'other-project');
    await fs.mkdir(other);
    const first = (await maintainDashboardRepository(workspace, bind(remote))).repositories[0];
    const second = await maintainDashboardRepository(workspace, {
      ...bind(remote, 'frontend', 'web', ''),
      id: first.id,
    });
    expect(second.repositories).toHaveLength(2);
    const web = second.repositories.find((entry) => entry.name === 'web')!;
    expect(web.id).not.toBe(first.id);
    expect(
      (await maintainDashboardRepository(workspace, { action: 'sync', id: web.id })).result?.branch,
    ).toBe('main');
    git(remote, 'checkout', '-b', 'develop');
    await fs.writeFile(path.join(remote, 'feature.txt'), 'feature');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'feature');
    const feature = (
      await maintainDashboardRepository(other, bind(remote, 'backend', 'feature', 'develop'))
    ).repositories[0];
    expect(
      (await maintainDashboardRepository(other, { action: 'sync', id: feature.id })).result?.branch,
    ).toBe('develop');
    expect(await fs.readFile(path.join(other, feature.relativePath, 'feature.txt'), 'utf8')).toBe(
      'feature',
    );
    await expect(
      maintainDashboardRepository(workspace, { action: 'sync', id: feature.id }),
    ).rejects.toThrow('不存在');
    expect((await collectDashboardRepositories(workspace)).repositories).toHaveLength(2);
    for (const branch of ['-bad', 'a//b', 'a.lock', '.hidden', 'a/..b', '@', 'a\n']) {
      await expect(
        maintainDashboardRepository(other, bind(remote, 'backend', 'invalid', branch)),
      ).rejects.toThrow('分支');
    }
  });

  it('uses configured URL rewrites while disabling repository hooks on clone and update', async () => {
    const alias = 'https://example.invalid/repository.git';
    git(root, 'config', '--global', `url.${remote}.insteadOf`, alias);
    const template = path.join(root, 'template');
    await fs.mkdir(path.join(template, 'hooks'), { recursive: true });
    const marker = path.join(root, 'hook-executed');
    for (const hook of ['post-checkout', 'post-merge']) {
      await fs.writeFile(
        path.join(template, 'hooks', hook),
        `#!/bin/sh\nprintf touched > '${marker}'\n`,
        { mode: 0o755 },
      );
    }
    git(root, 'config', '--global', 'init.templateDir', template);
    const entry = (await maintainDashboardRepository(workspace, bind(alias))).repositories[0];
    const sync = () => maintainDashboardRepository(workspace, { action: 'sync', id: entry.id });
    expect((await sync()).result?.action).toBe('cloned');
    await fs.writeFile(path.join(remote, 'README.md'), 'updated');
    git(remote, 'add', '.');
    git(remote, 'commit', '-m', 'update');
    expect((await sync()).result?.action).toBe('updated');
    expect(await fs.readFile(path.join(workspace, entry.relativePath, 'README.md'), 'utf8')).toBe(
      'updated',
    );
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects linked project metadata without writing outside the workspace', async () => {
    const outside = path.join(root, 'metadata');
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(workspace, '.comet'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(maintainDashboardRepository(workspace, bind(remote))).rejects.toThrow('链接');
    await expect(collectDashboardRepositories(workspace)).rejects.toThrow('链接');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('serializes concurrent bindings and validates remotes without accepting command protocols or credentials', async () => {
    await Promise.all(
      ['first', 'second'].map((name) =>
        maintainDashboardRepository(workspace, bind(remote, 'backend', name)),
      ),
    );
    expect((await collectDashboardRepositories(workspace)).repositories).toHaveLength(2);
    for (const value of [
      'ext::sh -c whoami',
      '--upload-pack=evil',
      'https://user:token@example.com/repo.git',
      'file:///tmp/repo',
      'https://example.com/r.git?token=abc',
    ])
      expect(() => validateRepositoryRemote(value)).toThrow();
    for (const value of [
      'git@example.com:team/repo.git',
      'ssh://git@example.com/team/repo.git',
      'https://example.com/team/repo.git',
    ])
      expect(validateRepositoryRemote(value)).toBe(value);
  });
});
