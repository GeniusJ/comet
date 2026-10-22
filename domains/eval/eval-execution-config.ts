import { promises as fs } from 'node:fs';
import { parse } from 'yaml';
import type { ResolvedEvalContext } from './standalone-context.js';
import { loadInstalledCustomAgent } from './standalone-static-collect.js';

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const field = (value: Record<string, unknown> | undefined, ...names: string[]): unknown =>
  names.map((name) => value?.[name]).find((value) => value !== undefined);
export const EVAL_AGENT_ENVIRONMENT: Record<
  string,
  { models: string[]; urls: string[]; credentials: string[] }
> = {
  'claude-code': {
    models: ['BENCH_CC_MODEL', 'ANTHROPIC_MODEL', 'BENCH_MODEL'],
    urls: ['ANTHROPIC_BASE_URL', 'BENCH_BASE_URL'],
    credentials: ['BENCH_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  },
  codex: {
    models: ['BENCH_CODEX_MODEL', 'OPENAI_MODEL', 'CODEX_MODEL', 'BENCH_MODEL'],
    urls: ['OPENAI_BASE_URL', 'CODEX_BASE_URL', 'BENCH_BASE_URL'],
    credentials: ['BENCH_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  qoder: {
    models: ['QODER_MODEL', 'BENCH_MODEL'],
    urls: ['QODER_BASE_URL'],
    credentials: ['BENCH_API_KEY', 'QODER_PERSONAL_ACCESS_TOKEN'],
  },
  codebuddy: {
    models: ['CODEBUDDY_MODEL', 'BENCH_MODEL'],
    urls: ['CODEBUDDY_BASE_URL', 'BENCH_BASE_URL'],
    credentials: ['BENCH_API_KEY', 'CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'],
  },
};
export interface ResolvedEvalExecution {
  agent: string;
  model: string;
  baseUrl?: string;
  api: 'default' | 'custom';
  judge: { agent: string; model: string; baseUrl?: string; api: 'default' | 'custom' } | null;
}
export async function resolveEvalExecution(
  options: {
    agent?: string;
    model?: string;
    baseUrl?: string;
    judgeAgent?: string;
    judgeModel?: string;
    judgeBaseUrl?: string;
    judgeEnabled?: boolean;
  },
  context?: ResolvedEvalContext,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedEvalExecution> {
  const parsed = context?.manifestPath
    ? parse(await fs.readFile(context.manifestPath, 'utf8'))
    : context?.baseManifest;
  const manifest =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  const execution =
    manifest?.execution && typeof manifest.execution === 'object'
      ? (manifest.execution as Record<string, unknown>)
      : undefined;
  const agent =
    options.agent ??
    nonEmpty(field(execution, 'agent')) ??
    nonEmpty(environment.BENCH_EVAL_AGENT) ??
    'claude-code';
  const adapter = await loadInstalledCustomAgent(agent, environment);
  const fromEnvironment = (keys: string[]) =>
    keys.map((key) => nonEmpty(environment[key])).find(Boolean);
  const model =
    options.model ??
    nonEmpty(field(execution, 'model')) ??
    fromEnvironment(
      adapter?.modelEnv ? [adapter.modelEnv] : (EVAL_AGENT_ENVIRONMENT[agent]?.models ?? []),
    ) ??
    'default';
  const baseUrl =
    options.baseUrl ??
    nonEmpty(field(execution, 'baseUrl', 'base_url')) ??
    fromEnvironment(
      adapter?.baseUrlEnv ? [adapter.baseUrlEnv] : (EVAL_AGENT_ENVIRONMENT[agent]?.urls ?? []),
    );
  const judgeManifest =
    manifest?.judge && typeof manifest.judge === 'object'
      ? (manifest.judge as Record<string, unknown>)
      : undefined;
  const explicitlyDisabled =
    options.judgeEnabled === false ||
    (environment.COMET_EVAL_MANAGED === '1' && environment.COMET_EVAL_MANAGED_JUDGE === '0');
  const enabled =
    !explicitlyDisabled &&
    (Boolean(judgeManifest) ||
      Boolean(options.judgeAgent || options.judgeModel || options.judgeBaseUrl) ||
      ['1', 'true', 'yes', 'on'].includes((environment.BENCH_LLM_JUDGE ?? '').toLowerCase()));
  const judgeBaseUrl =
    options.judgeBaseUrl ??
    nonEmpty(field(judgeManifest, 'baseUrl', 'base_url')) ??
    nonEmpty(environment.BENCH_JUDGE_BASE_URL);
  const judge = enabled
    ? {
        agent:
          options.judgeAgent ??
          nonEmpty(field(judgeManifest, 'agent')) ??
          nonEmpty(environment.BENCH_JUDGE_AGENT) ??
          agent,
        model:
          options.judgeModel ??
          nonEmpty(field(judgeManifest, 'model')) ??
          nonEmpty(environment.BENCH_JUDGE_MODEL) ??
          'missing',
        ...(judgeBaseUrl ? { baseUrl: judgeBaseUrl } : {}),
        api: judgeBaseUrl ? ('custom' as const) : ('default' as const),
      }
    : null;
  return {
    agent,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    api: baseUrl ? 'custom' : 'default',
    judge,
  };
}
