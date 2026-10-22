import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JsonFileTextStore } from '../../platform/fs/plugin-store.js';
import {
  ManagedRepositoryError,
  inspectManagedRepository,
  syncManagedRepository,
  validateRepositoryRemote,
} from '../../platform/process/managed-repository.js';

import {
  parseRepositoryKubernetes,
  parseKePipeline,
  type KePipelineConfig,
} from './repository-deployment-config.js';
import type { KubernetesTarget } from '../../platform/process/kubernetes.js';

export interface DashboardRepository {
  id: string;
  name: string;
  kind: 'backend' | 'frontend';
  remote: string;
  branch: string;
  tags: string[];
  kubernetes: KubernetesTarget | null;
  ke_pipeline: KePipelineConfig | null;
  relativePath: string;
  lastSyncedAt: string | null;
}

export interface DashboardRepositoryDirectory {
  workspace: string;
  repositories: DashboardRepository[];
  initialized: boolean;
}

export interface DashboardRepositoryCandidate {
  name: string;
  kind: DashboardRepository['kind'];
  relativePath: string;
  remote: string;
  branch: string;
  issue?: string;
}

async function safePath(root: string, relative: string, createParents = false): Promise<string> {
  let current = await fs.realpath(root);
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
        throw new ManagedRepositoryError('项目路径经过链接或非文件夹，无法维护。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (createParents && index < parts.length - 1) {
        try {
          await fs.mkdir(current);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
        }
        const created = await fs.lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory())
          throw new ManagedRepositoryError('项目路径经过链接或非文件夹，无法维护。');
      }
    }
  }
  return current;
}

async function storeFor(projectPath: string): Promise<JsonFileTextStore> {
  return new JsonFileTextStore(
    await safePath(projectPath, '.comet/dashboard-repositories.json', true),
    { timeoutMs: 1000 },
  );
}

function binding(value: unknown, id: string, previous?: DashboardRepository): DashboardRepository {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedRepositoryError('仓库绑定内容无效。', 400);
  const input = value as Record<string, unknown>;
  const remote = validateRepositoryRemote(input.remote);
  const inferred =
    remote
      .split(/[/:]/u)
      .at(-1)
      ?.replace(/\.git$/iu, '') ?? '';
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : inferred;
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) ||
    name.endsWith('.') ||
    name.endsWith(' ')
  )
    throw new ManagedRepositoryError(
      '工程名须以文字或数字开头，仅使用文字、数字、空格、点、横线和下划线，末尾不可为空格或点。',
      400,
    );
  if (input.kind !== 'backend' && input.kind !== 'frontend')
    throw new ManagedRepositoryError('请选择前端或后端。', 400);
  const branch = input.branch === undefined ? '' : input.branch;
  if (
    typeof branch !== 'string' ||
    branch.startsWith('-') ||
    Array.from(branch).some(
      (character) =>
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127 ||
        '~^:?*[\\'.includes(character),
    ) ||
    branch === '@' ||
    (branch !== '' &&
      branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.endsWith('/') ||
    branch.endsWith('.')
  )
    throw new ManagedRepositoryError('分支名称无效。', 400);
  const rawTags = input.tags === undefined ? (previous?.tags ?? []) : input.tags;
  if (
    !Array.isArray(rawTags) ||
    rawTags.length > 20 ||
    rawTags.some(
      (tag) =>
        typeof tag !== 'string' || !tag.trim() || tag.trim().length > 40 || /[\p{Cc}]/u.test(tag),
    )
  )
    throw new ManagedRepositoryError('标签最多 20 个，每个须为 1–40 字且不含控制字符。', 400);
  const tags = [...new Set((rawTags as string[]).map((tag) => tag.trim()))];
  return {
    id,
    name,
    kind: input.kind,
    remote,
    branch,
    tags,
    kubernetes: parseRepositoryKubernetes(
      input.kubernetes === undefined ? previous?.kubernetes : input.kubernetes,
    ),
    ke_pipeline: parseKePipeline(
      input.ke_pipeline === undefined ? previous?.ke_pipeline : input.ke_pipeline,
    ),
    relativePath: `engineering/${input.kind === 'backend' ? 'backed' : 'frontend'}/${name}`,
    lastSyncedAt:
      previous &&
      previous.remote === remote &&
      previous.branch === branch &&
      previous.name === name &&
      previous.kind === input.kind
        ? previous.lastSyncedAt
        : null,
  };
}

async function read(
  store: JsonFileTextStore,
): Promise<{ repositories: DashboardRepository[]; initialized: boolean }> {
  const text = await store.read();
  if (text === null) return { repositories: [], initialized: false };
  try {
    const data = JSON.parse(text);
    if (data.schemaVersion !== 1 || !Array.isArray(data.repositories)) throw new Error();
    const entries = data.repositories.map((entry: DashboardRepository) => {
      if (
        typeof entry.id !== 'string' ||
        !/^[a-z0-9-]+$/u.test(entry.id) ||
        (entry.lastSyncedAt !== null && typeof entry.lastSyncedAt !== 'string')
      )
        throw new Error();
      const parsed = binding(entry, entry.id, entry);
      if (parsed.relativePath !== entry.relativePath) throw new Error();
      return parsed;
    });
    if (
      new Set(entries.map((entry: DashboardRepository) => entry.id)).size !== entries.length ||
      new Set(entries.map((entry: DashboardRepository) => entry.relativePath.toLowerCase()))
        .size !== entries.length
    )
      throw new Error();
    return { repositories: entries, initialized: true };
  } catch {
    throw new ManagedRepositoryError(
      '项目仓库配置无效，请检查 .comet/dashboard-repositories.json。',
    );
  }
}

export async function collectDashboardRepositories(
  projectPath: string,
): Promise<DashboardRepositoryDirectory> {
  const file = await safePath(projectPath, '.comet/dashboard-repositories.json');
  return {
    workspace: await fs.realpath(projectPath),
    ...(await read(new JsonFileTextStore(file))),
  };
}

async function discoverLocalRepositories(
  projectPath: string,
  entries: DashboardRepository[],
): Promise<DashboardRepositoryCandidate[]> {
  const bound = new Set(entries.map((entry) => entry.relativePath.toLowerCase()));
  const candidates: DashboardRepositoryCandidate[] = [];
  for (const kind of ['backend', 'frontend'] as const) {
    const relative = `engineering/${kind === 'backend' ? 'backed' : 'frontend'}`;
    const directory = await safePath(projectPath, relative);
    let children;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `${relative}/${child.name}`;
      if (!child.isDirectory() || child.isSymbolicLink() || bound.has(relativePath.toLowerCase()))
        continue;
      const metadata = await inspectManagedRepository(await safePath(projectPath, relativePath));
      if (!metadata) continue;
      let issue = metadata.issue;
      if (!issue) {
        try {
          const parsed = binding({ ...metadata, name: child.name, kind }, 'candidate');
          if (parsed.name !== child.name) throw new Error();
        } catch {
          issue = '本地目录名或分支不符合绑定规则，请在本地调整后重新扫描。';
        }
      }
      candidates.push({
        name: child.name,
        kind,
        relativePath,
        ...metadata,
        ...(issue ? { issue } : {}),
      });
    }
  }
  return candidates;
}

export async function discoverDashboardRepositories(projectPath: string): Promise<{
  workspace: string;
  candidates: DashboardRepositoryCandidate[];
}> {
  const data = await collectDashboardRepositories(projectPath);
  return {
    workspace: data.workspace,
    candidates: await discoverLocalRepositories(projectPath, data.repositories),
  };
}

export async function maintainDashboardRepository(
  projectPath: string,
  input: unknown,
): Promise<
  DashboardRepositoryDirectory & { result?: { action: string; branch: string; head: string } }
> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ManagedRepositoryError('仓库操作无效。', 400);
  const request = input as Record<string, unknown>;
  if (!['bind', 'edit', 'unbind', 'sync', 'initialize'].includes(String(request.action)))
    throw new ManagedRepositoryError('仓库操作无效。', 400);
  const store = await storeFor(projectPath);
  try {
    return await store.withLock(async () => {
      let { repositories: entries } = await read(store);
      const existing =
        request.action === 'bind' ? undefined : entries.find((entry) => entry.id === request.id);
      if (request.action !== 'bind' && request.action !== 'initialize' && !existing)
        throw new ManagedRepositoryError('仓库绑定不存在。', 404);
      let result;
      if (request.action === 'initialize') {
        if (
          !Array.isArray(request.paths) ||
          request.paths.length > 500 ||
          request.paths.some((item) => typeof item !== 'string')
        )
          throw new ManagedRepositoryError('请选择有效的本地仓库。', 400);
        const bound = new Set(entries.map((entry) => entry.relativePath.toLowerCase()));
        const paths = [...new Set(request.paths as string[])].filter(
          (item) => !bound.has(item.toLowerCase()),
        );
        const candidates = paths.length
          ? await discoverLocalRepositories(projectPath, entries)
          : [];
        const added = paths.map((relativePath) => {
          const candidate = candidates.find((item) => item.relativePath === relativePath);
          if (!candidate || candidate.issue)
            throw new ManagedRepositoryError('所选本地仓库已变化或无法绑定，请重新扫描。');
          return binding(candidate, randomUUID());
        });
        if (new Set(added.map((entry) => entry.relativePath.toLowerCase())).size !== added.length)
          throw new ManagedRepositoryError('所选工程目录重名，请调整后重新扫描。');
        entries = [...entries, ...added];
      } else if (request.action === 'bind' || request.action === 'edit') {
        const next = binding(request.repository, existing?.id ?? randomUUID(), existing);
        if (
          entries.some(
            (entry) =>
              entry.id !== next.id &&
              entry.relativePath.toLowerCase() === next.relativePath.toLowerCase(),
          )
        )
          throw new ManagedRepositoryError('该工程目录已有绑定，请使用不同的工程名。');
        if (existing && existing.relativePath !== next.relativePath) {
          try {
            await fs.lstat(await safePath(projectPath, existing.relativePath));
            throw new ManagedRepositoryError(
              '已有本地代码时不能修改工程名或类型；请解除绑定后重新绑定。',
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        entries = existing
          ? entries.map((entry) => (entry.id === next.id ? next : entry))
          : [...entries, next];
      } else if (request.action === 'unbind') {
        entries = entries.filter((entry) => entry.id !== existing!.id);
      } else {
        const directory = await safePath(projectPath, existing!.relativePath, true);
        result = await syncManagedRepository({
          workspace: await fs.realpath(projectPath),
          directory,
          remote: existing!.remote,
          branch: existing!.branch || undefined,
        });
        entries = entries.map((entry) =>
          entry.id === existing!.id ? { ...entry, lastSyncedAt: new Date().toISOString() } : entry,
        );
      }
      await store.write(
        JSON.stringify({ schemaVersion: 1, repositories: entries }, null, 2) + '\n',
      );
      return {
        workspace: await fs.realpath(projectPath),
        repositories: entries,
        initialized: true,
        ...(result ? { result } : {}),
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Timed out waiting for file lock:'))
      throw new ManagedRepositoryError('项目仓库正在维护，请稍后重试。');
    throw error;
  }
}
