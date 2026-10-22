import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';

/** 在独立目录探测文件链接权限；测试目标上的失败仍须正常抛出。 */
export async function requireFileSymlink(context: Pick<TestContext, 'skip'>): Promise<void> {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-file-symlink-probe-'));
  let unavailable = false;
  try {
    const target = path.join(probe, 'target');
    await fs.writeFile(target, 'file symlink capability');
    try {
      await fs.symlink(target, path.join(probe, 'link'), 'file');
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      unavailable = true;
    }
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
  if (unavailable) context.skip('当前 Windows 进程没有创建文件符号链接的权限');
}
