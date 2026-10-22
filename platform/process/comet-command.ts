import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCommand } from './spawn-command.js';

export function spawnCometCommand(args: readonly string[], cwd: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = ['../../bin/comet.js', '../../../bin/comet.js']
    .map((relative) => path.resolve(here, relative))
    .find((candidate) => existsSync(candidate));
  if (!cli) throw new Error('无法找到当前 Comet 的 CLI 入口');
  return spawnCommand(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}
