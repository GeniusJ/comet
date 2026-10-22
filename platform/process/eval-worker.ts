import { spawn } from 'node:child_process';
import { readProcessIdentity } from './process-identity.js';

/** Detached execution belongs to its persisted run, not the Dashboard HTTP lifetime. */
export async function launchEvalWorker(
  entry: string,
  project: string,
  runId: string,
): Promise<{ pid: number; identity?: string }> {
  const child = spawn(process.execPath, [entry, '--project', project, '--run', runId], {
    cwd: project,
    env: process.env,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid!;
  const identity = await readProcessIdentity(pid);
  child.unref();
  return { pid, ...(identity ? { identity } : {}) };
}
