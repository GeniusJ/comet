import { runExternalCommandAsync } from './external-command.js';

export interface KubernetesTarget {
  context: string;
  namespace: string;
  deployment: string;
  container: string;
}

export class KubectlError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

async function kubectl(args: string[], signal?: AbortSignal): Promise<string> {
  try {
    return await runExternalCommandAsync('kubectl', args, {
      timeoutMs: 20_000,
      maxBufferBytes: 2 * 1024 * 1024,
      signal,
    });
  } catch {
    throw new KubectlError('kubectl 查询失败，请检查本机安装、kubeconfig、集群连接和访问权限。');
  }
}

export async function listKubernetesContexts(): Promise<string[]> {
  const output = await kubectl(['config', 'get-contexts', '-o', 'name']);
  return output
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
}

function targetArgs(target: KubernetesTarget): string[] {
  if (!target.context || /[\s\p{Cc}]/u.test(target.context) || target.context.length > 253)
    throw new KubectlError('请选择有效的集群上下文。', 400);
  for (const value of [
    target.namespace,
    target.deployment,
    ...(target.container ? [target.container] : []),
  ]) {
    if (value.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value))
      throw new KubectlError('命名空间、Deployment 或容器名称无效。', 400);
  }
  return [
    `--context=${target.context}`,
    `--namespace=${target.namespace}`,
    '--request-timeout=15s',
  ];
}

interface OwnerReference {
  kind?: string;
  uid?: string;
  controller?: boolean;
}
interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{ key: string; operator: string; values?: string[] }>;
}
interface KubernetesResource {
  metadata?: { name?: string; uid?: string; ownerReferences?: OwnerReference[] };
  spec?: {
    selector?: LabelSelector;
    replicas?: number;
    template?: { spec?: { containers?: Array<{ name: string; image?: string }> } };
    containers?: Array<{ name: string }>;
  };
  status?: {
    phase?: string;
    readyReplicas?: number;
    updatedReplicas?: number;
    containerStatuses?: Array<{ ready?: boolean; restartCount?: number }>;
  };
  items?: KubernetesResource[];
}

function parseObject(text: string): KubernetesResource {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new KubectlError('kubectl 返回了无法解析的资源信息。');
  }
}

function selectorText(selector: LabelSelector): string {
  const parts = Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`);
  for (const expression of selector.matchExpressions ?? []) {
    const { key, operator, values = [] } = expression;
    if (operator === 'In' || operator === 'NotIn')
      parts.push(`${key} ${operator === 'In' ? 'in' : 'notin'} (${values.join(',')})`);
    else if (operator === 'Exists') parts.push(key);
    else if (operator === 'DoesNotExist') parts.push(`!${key}`);
    else throw new KubectlError('Deployment 的 Pod 选择条件不受支持。');
  }
  if (!parts.length) throw new KubectlError('Deployment 缺少 Pod 选择条件，未查询其他工作负载。');
  return parts.join(',');
}

export async function inspectKubernetesDeployment(target: KubernetesTarget, signal?: AbortSignal) {
  const args = targetArgs(target);
  const deployment = parseObject(
    await kubectl([...args, 'get', 'deployment', target.deployment, '-o', 'json'], signal),
  );
  if (!deployment.metadata?.uid)
    throw new KubectlError('Deployment 资源缺少标识，未查询其他工作负载。');
  const pods = parseObject(
    await kubectl(
      [
        ...args,
        'get',
        'pods',
        `--selector=${selectorText(deployment.spec?.selector ?? {})}`,
        '-o',
        'json',
      ],
      signal,
    ),
  );
  // Only expose Pods owned by a ReplicaSet belonging to this Deployment.
  const replicaSets = parseObject(
    await kubectl(
      [
        ...args,
        'get',
        'replicasets',
        `--selector=${selectorText(deployment.spec?.selector ?? {})}`,
        '-o',
        'json',
      ],
      signal,
    ),
  );
  if (!Array.isArray(pods.items) || !Array.isArray(replicaSets.items))
    throw new KubectlError('kubectl 返回了无法解析的资源列表。');
  const owned = new Set(
    (replicaSets.items ?? [])
      .filter((item) =>
        item.metadata?.ownerReferences?.some(
          (owner) =>
            owner.kind === 'Deployment' &&
            Boolean(item.metadata?.uid) &&
            owner.uid === deployment.metadata?.uid &&
            owner.controller === true,
        ),
      )
      .map((item) => item.metadata?.uid),
  );
  return {
    context: target.context,
    namespace: target.namespace,
    deployment: target.deployment,
    desiredReplicas: deployment.spec?.replicas ?? 1,
    readyReplicas: deployment.status?.readyReplicas ?? 0,
    updatedReplicas: deployment.status?.updatedReplicas ?? 0,
    containers: (deployment.spec?.template?.spec?.containers ?? []).map((item) => ({
      name: String(item.name),
      image: String(item.image ?? ''),
    })),
    pods: (pods.items ?? [])
      .filter((item) =>
        item.metadata?.ownerReferences?.some(
          (owner) =>
            owner.kind === 'ReplicaSet' && owned.has(owner.uid) && owner.controller === true,
        ),
      )
      .map((item) => ({
        name: String(item.metadata?.name ?? ''),
        phase: String(item.status?.phase ?? 'Unknown'),
        containers: (item.spec?.containers ?? []).map((container) => String(container.name)),
        ready: (item.status?.containerStatuses ?? []).filter((container) => container.ready).length,
        restarts: (item.status?.containerStatuses ?? []).reduce(
          (total: number, container) => total + (container.restartCount ?? 0),
          0,
        ),
      })),
    checkedAt: new Date().toISOString(),
  };
}

export async function readKubernetesLogs(
  target: KubernetesTarget,
  options: { pod: unknown; container: unknown; previous?: unknown; tail?: unknown },
  signal?: AbortSignal,
) {
  const args = targetArgs(target);
  if (
    typeof options.pod !== 'string' ||
    typeof options.container !== 'string' ||
    (options.previous !== undefined && typeof options.previous !== 'boolean') ||
    (options.tail !== undefined && ![100, 200, 500].includes(options.tail as number))
  )
    throw new KubectlError('日志查询参数无效。', 400);
  const resource = await inspectKubernetesDeployment(target, signal);
  const pod = resource.pods.find((item: { name: string }) => item.name === options.pod);
  if (
    !pod ||
    !pod.containers.includes(options.container) ||
    (target.container && target.container !== options.container)
  )
    throw new KubectlError('请选择当前工程所属的 Pod 和容器。', 400);
  const logs = await kubectl(
    [
      ...args,
      'logs',
      pod.name,
      `--container=${options.container}`,
      `--tail=${options.tail ?? 200}`,
      '--limit-bytes=131072',
      '--timestamps=true',
      '--since=1h',
      ...(options.previous ? ['--previous=true'] : []),
    ],
    signal,
  );
  return { logs, pod: pod.name, container: options.container, checkedAt: new Date().toISOString() };
}
