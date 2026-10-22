import { promises as fs } from 'fs';
import path from 'path';
import { normalizeCometHookTargets } from '../../platform/process/hook-adapter.js';

export interface ScopedCometHookTargets {
  projectTargets: string[];
  externalTargets: string[];
}

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function physicalPathForPossiblyMissingTarget(target: string): Promise<string | null> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const missingSegments: string[] = [];
  let cursor = resolved;

  while (cursor && cursor !== root) {
    try {
      const physicalBase = await fs.realpath(cursor);
      return path.join(physicalBase, ...missingSegments.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      missingSegments.push(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }

  try {
    const physicalRoot = await fs.realpath(root);
    return path.join(physicalRoot, ...missingSegments.reverse());
  } catch {
    return null;
  }
}

/** Runtime 禁写兼容项目相对路径和宿主 cwd 相对路径，不改变普通 phase guard 的归属。 */
export function cometHookRuntimeTargetCandidates(
  projectRoot: string,
  target: string,
  cwd?: string,
): string[] {
  const candidates = [path.resolve(projectRoot, target)];
  if (!path.isAbsolute(target) && cwd && path.isAbsolute(cwd)) {
    candidates.push(path.resolve(cwd, target));
  }
  return [...new Set(candidates)];
}

/** 受管存储即使在项目外也不能写入；同时识别链接别名和尚未创建的目标。 */
export async function isCometHookTargetWithin(root: string, target: string): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (isWithin(resolvedRoot, resolvedTarget)) return true;
  const [physicalRoot, physicalTarget] = await Promise.all([
    physicalPathForPossiblyMissingTarget(resolvedRoot),
    physicalPathForPossiblyMissingTarget(resolvedTarget),
  ]);
  return physicalRoot !== null && physicalTarget !== null && isWithin(physicalRoot, physicalTarget);
}

export async function scopeCometHookTargets(
  projectRoot: string,
  targets: readonly string[],
): Promise<ScopedCometHookTargets> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const physicalProjectRoot = await fs.realpath(resolvedProjectRoot);
  const projectTargets: string[] = [];
  const externalTargets: string[] = [];

  for (const target of normalizeCometHookTargets(targets)) {
    const resolvedTarget = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(resolvedProjectRoot, target);
    const physicalTarget = await physicalPathForPossiblyMissingTarget(resolvedTarget);
    const inside = physicalTarget
      ? isWithin(physicalProjectRoot, physicalTarget)
      : isWithin(resolvedProjectRoot, resolvedTarget);
    (inside ? projectTargets : externalTargets).push(target);
  }

  return { projectTargets, externalTargets };
}
