import { beforeEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { spawnCometCommand } from '../../platform/process/comet-command.js';
import { spawnCommand } from '../../platform/process/spawn-command.js';
import { redactCommandOutput } from '../../platform/process/redact-command-output.js';

vi.mock('../../platform/process/spawn-command.js', () => ({ spawnCommand: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('uses the current package CLI and Node executable with a fixed argument array', () => {
  const args = ['update', '--all-projects', '--yes', '--target-version', '0.5.1'];
  spawnCometCommand(args, '/temporary-project');
  expect(spawnCommand).toHaveBeenCalledWith(
    process.execPath,
    [path.resolve('bin/comet.js'), ...args],
    expect.objectContaining({
      cwd: '/temporary-project',
      env: expect.objectContaining({ NO_COLOR: '1' }),
    }),
  );
});
it('removes terminal control sequences and masks tokens, credentials in URLs, and environment secrets', () => {
  const text =
    '\u001b[31mBearer fixture-token\u001b[0m\n_authToken=fixture-npm-secret https://user:fixture-password@example.com arbitrary fixture-private';
  const safe = redactCommandOutput(text, { CUSTOM_SECRET: 'fixture-private' });
  expect(safe).not.toMatch(/fixture-token|fixture-npm-secret|fixture-password|fixture-private/u);
  expect(safe).toContain('[redacted]');
  expect(safe).not.toContain('\u001b');
});
