import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

async function picker(platform: NodeJS.Platform) {
  const { chooseLocalDirectory } = await import('../../platform/process/directory-picker.js');
  return chooseLocalDirectory(platform);
}

function result(stdout = '', error: Error | null = null) {
  Object.assign(execFile, {
    [promisify.custom]: vi.fn().mockImplementation(async () => {
      if (error) throw error;
      return { stdout, stderr: '' };
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('local directory picker', () => {
  it('returns a Unicode path selected on macOS', async () => {
    result('/Users/test/中文 project/\n');
    expect(await picker('darwin')).toBe('/Users/test/中文 project/');
  });

  it('treats macOS user cancellation as an empty selection', async () => {
    result(
      '',
      Object.assign(new Error('User canceled (-128)'), {
        stderr: 'execution error: User canceled. (-128)',
      }),
    );
    expect(await picker('darwin')).toBeNull();
  });

  it('treats Windows cancellation as an empty selection', async () => {
    result('\r\n');
    expect(await picker('win32')).toBeNull();
  });

  it('explains that manual entry is still available when no desktop picker can run', async () => {
    result('', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    await expect(picker('linux')).rejects.toThrow(/手动输入/);
  });
});
