import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExternalCommandAsync } from './external-command.js';
import { nonInteractiveGitEnvironment } from './git-environment.js';

export class ManagedRepositoryError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export function validateRepositoryRemote(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new ManagedRepositoryError('请输入有效的 Git 仓库地址。', 400);
  }
  if (path.isAbsolute(value) && !value.startsWith('//') && !value.startsWith('\\\\')) return value;
  if (/\s/u.test(value)) throw new ManagedRepositoryError('请输入有效的 Git 仓库地址。', 400);
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/u.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      ['https:', 'http:', 'ssh:'].includes(url.protocol) &&
      url.hostname &&
      !url.password &&
      (url.protocol === 'ssh:' || !url.username) &&
      !url.search &&
      !url.hash
    )
      return value;
  } catch {
    /* Report the supported remote formats below. */
  }
  throw new ManagedRepositoryError(
    '仓库地址仅支持 HTTPS、SSH 或本地绝对路径；请使用本机 Git 认证。',
    400,
  );
}

/** Read local metadata only; no fetch, hooks, credentials or working-tree changes. */
export async function inspectManagedRepository(
  directory: string,
): Promise<{ remote: string; branch: string; issue?: string } | null> {
  try {
    const metadata = await fs.lstat(path.join(directory, '.git'));
    if (metadata.isSymbolicLink())
      return { remote: '', branch: '', issue: 'Git 元数据是链接，请在本地检查后重新扫描。' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const read = async (args: string[]) =>
    (
      await runExternalCommandAsync('git', ['--no-optional-locks', ...args], {
        cwd: directory,
        env: nonInteractiveGitEnvironment({ authentication: false }),
        timeoutMs: 5000,
      })
    ).trim();
  try {
    const root = await read(['rev-parse', '--show-toplevel']);
    if ((await fs.realpath(root)) !== (await fs.realpath(directory))) return null;
    let remote: string;
    try {
      remote = validateRepositoryRemote(
        await read(['config', '--local', '--get', 'remote.origin.url']),
      );
    } catch {
      return {
        remote: '',
        branch: '',
        issue: 'origin 缺失或地址不受支持，请在本地配置安全的仓库地址后重新扫描。',
      };
    }
    try {
      return { remote, branch: await read(['symbolic-ref', '--quiet', '--short', 'HEAD']) };
    } catch {
      return { remote, branch: '', issue: '仓库未处于本地分支，请先切换分支后重新扫描。' };
    }
  } catch {
    return { remote: '', branch: '', issue: '无法读取 Git 仓库，请在本地检查后重新扫描。' };
  }
}

async function git(cwd: string, args: string[], hooksPath: string): Promise<string> {
  try {
    return (
      await runExternalCommandAsync(
        'git',
        [
          '-c',
          `core.hooksPath=${hooksPath}`,
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'protocol.http.allow=always',
          '-c',
          'protocol.ssh.allow=always',
          '-c',
          'protocol.file.allow=always',
          ...args,
        ],
        { cwd, env: nonInteractiveGitEnvironment({ authentication: true }), timeoutMs: 180_000 },
      )
    ).trim();
  } catch {
    throw new ManagedRepositoryError(
      'Git 操作失败，请检查仓库、分支、网络及本机 Git 认证；本地文件已保留。',
      502,
    );
  }
}

export async function syncManagedRepository(options: {
  workspace: string;
  directory: string;
  remote: string;
  branch?: string;
}): Promise<{ action: 'cloned' | 'updated'; branch: string; head: string }> {
  const remote = validateRepositoryRemote(options.remote);
  const hooksPath = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-disabled-hooks-'));
  try {
    const run = (cwd: string, args: string[]) => git(cwd, args, hooksPath);
    if (options.branch)
      await run(options.workspace, ['check-ref-format', '--branch', options.branch]);
    let exists = false;
    try {
      await fs.lstat(options.directory);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let action: 'cloned' | 'updated';
    if (!exists) {
      await run(options.workspace, [
        'clone',
        '--no-recurse-submodules',
        ...(options.branch ? ['--branch', options.branch] : []),
        '--',
        remote,
        options.directory,
      ]);
      action = 'cloned';
    } else {
      const stat = await fs.lstat(options.directory);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new ManagedRepositoryError('目标路径不是普通文件夹。');
      const root = await run(options.directory, ['rev-parse', '--show-toplevel']);
      if ((await fs.realpath(root)) !== (await fs.realpath(options.directory)))
        throw new ManagedRepositoryError('目标目录已有其他文件，不能覆盖。');
      if ((await run(options.directory, ['config', '--get', 'remote.origin.url'])) !== remote)
        throw new ManagedRepositoryError('目标目录的 origin 与绑定仓库不一致，未执行拉取。');
      if (await run(options.directory, ['status', '--porcelain=v1', '--untracked-files=all']))
        throw new ManagedRepositoryError('工作区有未提交文件，请先提交或自行处理后再拉取。');
      const branch = await run(options.directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (options.branch && branch !== options.branch)
        throw new ManagedRepositoryError(
          `当前分支与绑定分支 ${options.branch} 不一致，请先在本地切换。`,
        );
      await run(options.directory, ['fetch', '--no-recurse-submodules', '--', 'origin', branch]);
      await run(options.directory, ['merge', '--ff-only', 'FETCH_HEAD']);
      action = 'updated';
    }
    return {
      action,
      branch: await run(options.directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      head: await run(options.directory, ['rev-parse', '--short', 'HEAD']),
    };
  } finally {
    await fs.rm(hooksPath, { recursive: true, force: true });
  }
}
