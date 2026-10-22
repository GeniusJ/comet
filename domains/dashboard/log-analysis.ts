import {
  runCodexLogAnalysis,
  CodexLogAnalysisError,
} from '../../platform/process/codex-log-analysis.js';
import { collectDashboardRepositories } from './project-repositories.js';

export type DashboardLogAnalysisEvent =
  | { type: 'status'; message: string }
  | { type: 'message'; text: string }
  | { type: 'complete' }
  | { type: 'error'; message: string };
export type DashboardLogAnalysisRunner = typeof runCodexLogAnalysis;

function redact(text: string): string {
  return text
    .replace(/(\bauthorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\r\n]+/giu, '$1[已隐藏]')
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|token)\s*["']?\s*[:=]\s*["']?)[^"'&\s,;}]+/giu,
      '$1[已隐藏]',
    );
}

function boundedString(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit)
    throw new CodexLogAnalysisError(`${name}为空或超出长度限制。`, 400);
  return redact(value);
}

export function createDashboardLogAnalyzer(
  runner: DashboardLogAnalysisRunner = runCodexLogAnalysis,
) {
  let active = 0;
  return async (
    projectPath: string,
    input: unknown,
    send: (event: DashboardLogAnalysisEvent) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new CodexLogAnalysisError('日志分析请求无效。', 400);
    const value = input as Record<string, unknown>;
    const question = boundedString(value.question, '问题', 4096);
    const logs = boundedString(value.logs, '日志快照', 128 * 1024);
    if (value.source !== 'container' && value.source !== 'pipeline')
      throw new CodexLogAnalysisError('请选择容器日志或流水线日志。', 400);
    const context =
      value.context === undefined ? '' : boundedString(value.context, '日志来源', 1024);
    const history = value.history ?? [];
    if (
      !Array.isArray(history) ||
      history.length > 8 ||
      Buffer.byteLength(JSON.stringify(history)) > 64 * 1024
    )
      throw new CodexLogAnalysisError('对话过长，请开始新的分析。', 400);
    const conversation = history.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new CodexLogAnalysisError('对话记录无效。', 400);
      const item = entry as Record<string, unknown>;
      if (item.role !== 'user' && item.role !== 'assistant')
        throw new CodexLogAnalysisError('对话角色无效。', 400);
      return { role: item.role, text: boundedString(item.text, '对话内容', 32 * 1024) };
    });
    const data = await collectDashboardRepositories(projectPath);
    const repository = data.repositories.find((entry) => entry.id === value.repositoryId);
    if (!repository) throw new CodexLogAnalysisError('工程不存在。', 404);
    if (signal.aborted) throw new CodexLogAnalysisError('分析已停止。', 499);
    if (active >= 2) throw new CodexLogAnalysisError('已有两个分析正在运行，请稍后重试。', 429);
    const prompt = JSON.stringify({
      task: '根据日志快照和历史对话，回答当前问题；仅做日志分析。',
      repository: repository.name,
      source: value.source,
      context,
      snapshot: logs
        .split(/\r?\n/u)
        .map((line, index) => `L${index + 1}: ${line}`)
        .join('\n'),
      history: conversation,
      question,
    });
    active++;
    try {
      send({ type: 'status', message: '正在通过本机 Codex CLI 分析日志快照…' });
      await runner(prompt, {
        signal,
        onMessage: (text) => send({ type: 'message', text: redact(text) }),
      });
      if (!signal.aborted) send({ type: 'complete' });
    } finally {
      active--;
    }
  };
}
