import { runExternalCommandAsync } from '../../platform/process/external-command.js';
import type {
  DashboardProjectInitOptions,
  DashboardProjectInitResult,
} from '../../domains/dashboard/project-initialization.js';

/** Isolate CLI output and process state from concurrent Dashboard requests. */
export async function initializeDashboardProject(
  projectPath: string,
  options: DashboardProjectInitOptions,
): Promise<DashboardProjectInitResult> {
  const output = await runExternalCommandAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'const { initCommand } = await import(process.argv[1]); await initCommand(process.argv[2], JSON.parse(process.argv[3]));',
      new URL('./init.js', import.meta.url).href,
      projectPath,
      JSON.stringify({ ...options, yes: true, json: true, scope: 'project' }),
    ],
    { cwd: projectPath, timeoutMs: 600_000 },
  );
  const result = JSON.parse(output) as DashboardProjectInitResult;
  if (
    !result ||
    !['complete', 'incomplete'].includes(result.status) ||
    !Array.isArray(result.failures)
  )
    throw new Error('Comet 初始化未返回有效结果。');
  return result;
}
