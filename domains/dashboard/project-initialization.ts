import { PLATFORMS } from '../../platform/install/platforms.js';
import { normalizeWorkflowArtifactRoot } from '../workflow-contract/project-config.js';
import {
  collectDashboardProjectConfigSettings,
  DashboardProjectConfigError,
} from './project-config-settings.js';

export interface DashboardProjectInitOptions {
  platform: string;
  workflow: 'native' | 'classic' | 'both';
  language: 'zh' | 'en';
  artifactRoot: string;
  overwrite: boolean;
  codegraph: 'init' | 'skip';
}

export interface DashboardProjectInitResult {
  status: 'complete' | 'incomplete';
  failures: Array<{ component: string; reason: string }>;
  [key: string]: unknown;
}

export type DashboardProjectInitRunner = (
  projectPath: string,
  options: DashboardProjectInitOptions,
) => Promise<DashboardProjectInitResult>;

function parseOptions(value: unknown): DashboardProjectInitOptions {
  const fail = (): never => {
    throw new DashboardProjectConfigError('初始化参数无效，请检查平台、工作流和目录。', 400);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  const allowed = ['platform', 'workflow', 'language', 'artifactRoot', 'overwrite', 'codegraph'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return fail();
  if (!PLATFORMS.some((platform) => platform.id === input.platform)) return fail();
  if (!['native', 'classic', 'both'].includes(input.workflow as string)) return fail();
  if (!['zh', 'en'].includes(input.language as string)) return fail();
  if (typeof input.overwrite !== 'boolean') return fail();
  if (!['init', 'skip'].includes(input.codegraph as string)) return fail();
  if (
    typeof input.artifactRoot !== 'string' ||
    !input.artifactRoot.trim() ||
    input.artifactRoot.length > 200 ||
    /[\p{Cc}]/u.test(input.artifactRoot)
  )
    return fail();
  try {
    return {
      ...input,
      artifactRoot: normalizeWorkflowArtifactRoot(input.artifactRoot),
    } as unknown as DashboardProjectInitOptions;
  } catch {
    return fail();
  }
}

/** Each server serializes initialization; the caller supplies a registered project path. */
export function createDashboardProjectInitializer(runner?: DashboardProjectInitRunner) {
  let runningProject: string | null = null;
  return {
    async collect(projectPath: string) {
      let config = null;
      let configError: string | null = null;
      try {
        config = await collectDashboardProjectConfigSettings(projectPath);
      } catch (error) {
        if (!(error instanceof DashboardProjectConfigError)) throw error;
        if (error.statusCode !== 404) configError = error.message;
      }
      return {
        available: Boolean(runner),
        running: runningProject === projectPath,
        busy: runningProject !== null,
        config,
        configError,
        platforms: PLATFORMS.map(({ id, name }) => ({ id, name })),
      };
    },
    async run(projectPath: string, value: unknown) {
      const options = parseOptions(value);
      if (!runner) throw new DashboardProjectConfigError('当前服务未启用 Comet 初始化。', 503);
      if (runningProject !== null)
        throw new DashboardProjectConfigError('已有项目正在初始化，请稍后重试。', 409);
      runningProject = projectPath;
      try {
        return await runner(projectPath, options);
      } finally {
        runningProject = null;
      }
    },
  };
}
