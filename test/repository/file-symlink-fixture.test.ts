import { promises as fs } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { requireFileSymlink } from '../helpers/file-symlink.js';

afterEach(() => vi.restoreAllMocks());

it('propagates unexpected probe errors instead of skipping security assertions', async () => {
  const error = Object.assign(new Error('unexpected link failure'), { code: 'ENOENT' });
  vi.spyOn(fs, 'symlink').mockRejectedValue(error);
  const skip = vi.fn((): never => {
    throw new Error('unexpected skip');
  });
  await expect(requireFileSymlink({ skip })).rejects.toBe(error);
  expect(skip).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32').each(['EPERM', 'EACCES'])(
  'reports unavailable Windows file symlink permission for %s',
  async (code) => {
    vi.spyOn(fs, 'symlink').mockRejectedValue(Object.assign(new Error('permission'), { code }));
    const skipped = new Error('capability unavailable');
    const skip = vi.fn(() => {
      throw skipped;
    });
    await expect(requireFileSymlink({ skip })).rejects.toBe(skipped);
    expect(skip).toHaveBeenCalledWith('当前 Windows 进程没有创建文件符号链接的权限');
  },
);
