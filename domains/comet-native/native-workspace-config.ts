import {
  resolveWorkspaceRuntimeRoot,
  resolveWorkspaceRuntimeRootSync,
} from '../workflow-contract/workspace-runtime.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { gitStatusPaths, runGitCommand } from '../../platform/process/git.js';
import { atomicWriteJson } from './native-atomic-file.js';

const CONFIG = '.comet/config.yaml';
const snapshotFile = (root: string) =>
  path.join(resolveWorkspaceRuntimeRootSync(root), 'native', 'workspace-config.json');
const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');

/** Only an unchanged, untracked configuration created by Runtime is exempt. */
export function managedConfigMatches(root: string): boolean {
  try {
    if (runGitCommand(root, ['ls-files', '--', CONFIG])) return false;
    const file = path.join(root, CONFIG);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const runtimeRoot = resolveWorkspaceRuntimeRootSync(root);
    const saved = snapshotFile(root);
    for (const directory of [runtimeRoot, path.dirname(saved)]) {
      const metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
    }
    const metadata = lstatSync(saved);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      realpathSync(saved) !== path.resolve(saved)
    )
      return false;
    const snapshot = JSON.parse(readFileSync(saved, 'utf8')) as { hash: string };
    return snapshot.hash === digest(readFileSync(file));
  } catch {
    return false;
  }
}

export async function recordNativeWorkspaceConfig(root: string): Promise<void> {
  const file = path.join(root, CONFIG);
  let content: Buffer;
  try {
    content = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const runtimeRoot = await resolveWorkspaceRuntimeRoot(root);
  const snapshot = snapshotFile(root);
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await atomicWriteJson(snapshot, { hash: digest(content) }, { containedRoot: runtimeRoot });
}

export function nativeWorkspaceIsClean(root: string, allowed: readonly string[] = []): boolean {
  return gitStatusPaths(root).every(
    (candidate) =>
      allowed.some((entry) => candidate === entry || candidate.startsWith(`${entry}/`)) ||
      (candidate === CONFIG && managedConfigMatches(root)),
  );
}

/** Remove only the exact Runtime-created copy before ordinary safe Git cleanup. */
export async function removeNativeWorkspaceConfig(root: string): Promise<void> {
  if (managedConfigMatches(root)) await fs.unlink(path.join(root, CONFIG));
}
