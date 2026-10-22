import { createHash } from 'node:crypto';
import { promises as fs } from 'fs';
import path from 'path';

import {
  ProjectRegistryError,
  ProjectDirectoryReappearedError,
  readProjectRegistry,
  registerProjectDirectory,
  removeProjectInstallation,
  type ProjectRegistryEntry,
} from '../../platform/install/project-registry.js';
import { isProjectDirectoryMissing } from '../../platform/fs/file-system.js';
import { readWorkflowProjectConfig } from '../workflow-contract/project-config-reader.js';
import type { CometProjectWorkflow } from '../workflow-contract/types.js';

export type DashboardProjectAvailability = 'available' | 'missing' | 'unreadable';
export type DashboardProjectWorkflowSource = 'configured' | 'fallback';

export interface DashboardProjectEntry {
  id: string;
  name: string;
  path: string;
  lastSeenAt: string | null;
  availability: DashboardProjectAvailability;
  isCurrent: boolean;
  defaultWorkflow: CometProjectWorkflow;
  workflowSource: DashboardProjectWorkflowSource;
}

export interface DashboardProjectDirectory {
  currentProjectId: string;
  projects: DashboardProjectEntry[];
  warning?: string;
}

export interface DashboardProjectDirectoryOptions {
  homeDir?: string;
}

export class DashboardProjectDirectoryError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

function canonicalKey(projectPath: string): string {
  const normalized = path.resolve(projectPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function projectId(canonicalPath: string): string {
  // Dashboard routes address a working directory, not a repository shared by worktrees.
  return `dashboard-${createHash('sha256').update(canonicalPath).digest('hex')}`;
}

function projectName(projectPath: string): string {
  const parsed = path.parse(projectPath);
  return path.basename(projectPath) || parsed.root || projectPath;
}

async function availabilityOf(projectPath: string): Promise<DashboardProjectAvailability> {
  try {
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) return 'missing';
    await fs.access(projectPath);
    return 'available';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

function registryWarning(error: unknown): string | undefined {
  if (!(error instanceof ProjectRegistryError)) return undefined;
  return error.code === 'invalid-json'
    ? '项目索引无效，当前仅显示启动项目。'
    : '项目索引格式无效，当前仅显示启动项目。';
}

function sortEntries(left: DashboardProjectEntry, right: DashboardProjectEntry): number {
  if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
  const bySeen = (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? '');
  if (bySeen !== 0) return bySeen;
  return left.name.localeCompare(right.name);
}

async function projectWorkflow(
  projectPath: string,
  availability: DashboardProjectAvailability,
): Promise<Pick<DashboardProjectEntry, 'defaultWorkflow' | 'workflowSource'>> {
  if (availability !== 'available') {
    return { defaultWorkflow: 'classic', workflowSource: 'fallback' };
  }
  try {
    const config = await readWorkflowProjectConfig(projectPath);
    if (config?.default_workflow === 'native' || config?.default_workflow === 'classic') {
      return { defaultWorkflow: config.default_workflow, workflowSource: 'configured' };
    }
  } catch {
    // The project directory remains usable when an optional workflow hint cannot be read.
  }
  return { defaultWorkflow: 'classic', workflowSource: 'fallback' };
}

export async function collectDashboardProjectDirectory(
  currentProjectPath: string,
  options: DashboardProjectDirectoryOptions = {},
): Promise<DashboardProjectDirectory> {
  const currentPath = path.resolve(currentProjectPath);
  const currentKey = canonicalKey(await fs.realpath(currentPath).catch(() => currentPath));
  let registryProjects: ProjectRegistryEntry[] = [];
  let warning: string | undefined;

  try {
    registryProjects = (await readProjectRegistry({ homeDir: options.homeDir, strict: true }))
      .projects;
  } catch (error) {
    warning = registryWarning(error) ?? '无法读取项目索引，当前仅显示启动项目。';
  }

  const candidates = new Map<string, { path: string; lastSeenAt: string | null }>();
  candidates.set(currentKey, { path: currentPath, lastSeenAt: null });
  for (const entry of registryProjects) {
    const key = canonicalKey(entry.canonicalPath || entry.path);
    const existing = candidates.get(key);
    candidates.set(key, {
      path: key === currentKey ? currentPath : entry.path,
      lastSeenAt: existing?.lastSeenAt ?? entry.lastSeenAt,
    });
  }

  const projects = await Promise.all(
    [...candidates.entries()].map(async ([key, candidate]) => {
      const availability = await availabilityOf(candidate.path);
      const workflow = await projectWorkflow(candidate.path, availability);
      return {
        id: projectId(key),
        name: projectName(candidate.path),
        path: candidate.path,
        lastSeenAt: candidate.lastSeenAt,
        availability,
        isCurrent: key === currentKey,
        ...workflow,
      };
    }),
  );
  projects.sort(sortEntries);

  const current = projects.find((project) => project.isCurrent);
  if (!current) throw new Error('Dashboard project directory lost its current project');

  return {
    currentProjectId: current.id,
    projects,
    ...(warning ? { warning } : {}),
  };
}

export function findDashboardProject(
  directory: DashboardProjectDirectory,
  id: string,
): DashboardProjectEntry | undefined {
  return directory.projects.find((project) => project.id === id);
}

export async function forgetMissingDashboardProject(
  currentProjectPath: string,
  project: DashboardProjectEntry,
  options: DashboardProjectDirectoryOptions = {},
): Promise<DashboardProjectDirectory> {
  if (
    project.isCurrent ||
    project.availability !== 'missing' ||
    !(await isProjectDirectoryMissing(project.path))
  ) {
    throw new DashboardProjectDirectoryError(
      'Only missing projects other than the launch project can be removed from the index',
    );
  }
  const registry = await readProjectRegistry({ homeDir: options.homeDir, strict: true });
  const entry = registry.projects.find(
    (candidate) => projectId(canonicalKey(candidate.canonicalPath)) === project.id,
  );
  if (entry) {
    try {
      await removeProjectInstallation(project.path, {
        homeDir: options.homeDir,
        expectedCanonicalPath: entry.canonicalPath,
        missingOnly: true,
      });
    } catch (error) {
      if (!(error instanceof ProjectDirectoryReappearedError)) throw error;
      throw new DashboardProjectDirectoryError(error.message);
    }
  }
  return collectDashboardProjectDirectory(currentProjectPath, options);
}

export async function addDashboardProject(
  currentProjectPath: string,
  requestedPath: unknown,
  options: DashboardProjectDirectoryOptions = {},
): Promise<{ projectId: string; directory: DashboardProjectDirectory }> {
  if (
    typeof requestedPath !== 'string' ||
    !path.isAbsolute(requestedPath) ||
    requestedPath.includes('\0')
  ) {
    throw new DashboardProjectDirectoryError('请输入项目的绝对路径。', 400);
  }
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(requestedPath);
    if (!(await fs.stat(canonicalPath)).isDirectory()) throw new Error('Not a directory');
    await fs.readdir(canonicalPath);
  } catch {
    throw new DashboardProjectDirectoryError('项目路径不存在、不是文件夹或无法读取。', 400);
  }
  await registerProjectDirectory(canonicalPath, options);
  return {
    projectId: projectId(canonicalKey(canonicalPath)),
    directory: await collectDashboardProjectDirectory(currentProjectPath, options),
  };
}
