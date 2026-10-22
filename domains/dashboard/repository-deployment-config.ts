import type { KubernetesTarget } from '../../platform/process/kubernetes.js';
import { ManagedRepositoryError } from '../../platform/process/managed-repository.js';

export interface KePipelineConfig {
  base_url: string;
  tenant: string;
  project: string;
  application: string;
  environment: string;
  pipeline: string;
  action: 'run';
  arguments: Record<string, unknown>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedRepositoryError(`${label}配置无效。`, 400);
  return value as Record<string, unknown>;
}

function text(input: Record<string, unknown>, key: string, required = true): string {
  const value = input[key] ?? '';
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    /[\p{Cc}]/u.test(value) ||
    (required && !value.trim())
  )
    throw new ManagedRepositoryError(`请填写有效的 ${key}。`, 400);
  return value.trim();
}

export function parseRepositoryKubernetes(value: unknown): KubernetesTarget | null {
  if (value === null || value === undefined) return null;
  const input = object(value, 'Kubernetes');
  const context = text(input, 'context');
  const namespace = text(input, 'namespace');
  const deployment = text(input, 'deployment');
  const container = text(input, 'container', false);
  if (
    /\s/u.test(context) ||
    [namespace, deployment, ...(container ? [container] : [])].some(
      (item) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(item),
    )
  )
    throw new ManagedRepositoryError('Kubernetes 上下文或资源名称无效。', 400);
  return { context, namespace, deployment, container };
}

export function parseKePipeline(value: unknown): KePipelineConfig | null {
  if (value === null || value === undefined) return null;
  const input = object(value, 'KubeEase 流水线');
  const base_url = text(input, 'base_url');
  try {
    const url = new URL(base_url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new ManagedRepositoryError('KubeEase 地址须为不含凭证的 HTTP(S) 地址。', 400);
  }
  const args = input.arguments === undefined ? {} : object(input.arguments, '流水线参数');
  if (JSON.stringify(args).length > 16_384)
    throw new ManagedRepositoryError('流水线参数不可超过 16 KiB。', 400);
  if (input.action !== undefined && input.action !== 'run')
    throw new ManagedRepositoryError('流水线 action 仅支持 run。', 400);
  return {
    base_url,
    tenant: text(input, 'tenant'),
    project: text(input, 'project'),
    application: text(input, 'application'),
    environment: text(input, 'environment', false),
    pipeline: text(input, 'pipeline'),
    action: 'run',
    arguments: args,
  };
}
