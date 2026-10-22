import { createHash, randomUUID } from 'node:crypto';
import { createKubeEaseClient, KubeEaseError } from '../../platform/http/kubeease.js';
import type { KePipelineConfig } from './repository-deployment-config.js';

type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const array = (value: unknown): Data[] => (Array.isArray(value) ? value.map(object) : []);
function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 253 || /[\p{Cc}]/u.test(value))
    throw new KubeEaseError(`请选择有效的${label}。`, 400);
  return value;
}
const segment = (value: string) => encodeURIComponent(value);
const internalDefaults: Record<string, string> = {
  'hide-value_wf-mutation-nacos-id': '{}',
  'hide-value_wf-mutation-task': '{}',
  'ke-nick-name': '',
  review: '',
  'wf-front-url': '',
  'wf-mutation-database-id': '',
  'wf-mutation-nacos-id': '',
  'wf-zendao-release-id': '',
};
const confirmations = new Map<string, { expires: number; fingerprint: string; arguments: Data }>();

export async function queryDashboardKubeEase(
  workspace: string,
  repositoryId: string,
  config: KePipelineConfig,
  input: Data,
  signal?: AbortSignal,
) {
  const client = await createKubeEaseClient(workspace, config.base_url, signal);
  const group = `${config.tenant}-${config.project}`;
  const pipeline = `/pipeline/v1/group/${segment(group)}/pipelines/${segment(config.pipeline)}`;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([workspace, repositoryId, config]))
    .digest('hex');
  const checkedAt = () => new Date().toISOString();
  const runtimePath = () => `${pipeline}/runtimes/${segment(name(input.runtime, '运行记录'))}`;
  async function environments() {
    const result = object(
      await client.request(
        `/user-center/v4/tenants/${segment(config.tenant)}/projects/list?statistics=false&searchValue=${segment(config.project)}`,
      ),
    );
    const project = array(result.data).find((entry) => entry.projectName === config.project);
    if (!project) throw new KubeEaseError('KE 空间不存在或无权访问。', 409);
    return array(project.projectClusterList)
      .filter((entry) => entry.proxyStatus === 'CONNECTED' && typeof entry.envName === 'string')
      .map((entry) => entry.envName as string);
  }
  async function status() {
    const env = name(input.environment || config.environment, 'KE 环境');
    if (!(await environments()).includes(env)) throw new KubeEaseError('所选 KE 环境不可用。', 409);
    const result = object(
      await client.request(
        `/amp/v4/namespace/${segment(group)}/env/${segment(env)}/applications/${segment(config.application)}/appstatus/view?canary=false`,
      ),
    );
    const workloads = array(result.workloads);
    const pods = workloads
      .flatMap((workload) =>
        array(workload.pods).map((pod) => {
          const raw = object(pod.unstructured ?? pod);
          const statuses = array(object(raw.status).containerStatuses);
          return {
            name: String(pod.name ?? object(raw.metadata).name ?? ''),
            phase:
              typeof pod.status === 'string' ? pod.status : String(object(raw.status).phase ?? ''),
            containers: array(object(raw.spec).containers).map((container) =>
              String(container.name),
            ),
            restarts: statuses.reduce((sum, item) => sum + (Number(item.restartCount) || 0), 0),
          };
        }),
      )
      .filter((pod) => pod.name);
    return {
      environment: env,
      context: env,
      namespace: group,
      deployment: config.application,
      desiredReplicas: workloads.reduce((sum, w) => sum + (Number(w.replicas) || 0), 0),
      readyReplicas: workloads.reduce((sum, w) => sum + (Number(w.readyReplicas) || 0), 0),
      updatedReplicas: workloads.reduce(
        (sum, w) =>
          sum +
          (Number(w.updatedReplicas ?? object(object(w.unstructured).status).updatedReplicas) || 0),
        0,
      ),
      containers: workloads.flatMap((w) =>
        array(object(object(object(object(w.unstructured).spec).template).spec).containers).map(
          (c) => ({
            name: String(c.name),
            image: String(c.image ?? ''),
          }),
        ),
      ),
      pods,
      checkedAt: checkedAt(),
    };
  }
  switch (input.action) {
    case 'ke-environments':
      return { environments: await environments() };
    case 'ke-status':
      return status();
    case 'ke-logs': {
      const current = await status();
      const pod = current.pods.find((p) => p.name === name(input.pod, 'Pod'));
      const container = name(input.container, '容器');
      if (!pod || !pod.containers.includes(container))
        throw new KubeEaseError('Pod 或容器不属于此工程的 KE 应用。', 400);
      const tail = input.tail ?? 200;
      if (
        typeof tail !== 'number' ||
        !Number.isInteger(tail) ||
        tail < 1 ||
        tail > 1000 ||
        (input.previous !== undefined && typeof input.previous !== 'boolean')
      )
        throw new KubeEaseError('日志参数无效。', 400);
      return client.logs({
        tenantName: config.tenant,
        projectName: config.project,
        cluster: current.environment,
        podName: pod.name,
        containerName: container,
        tailLines: tail,
        previous: input.previous === true,
        timestamps: true,
        sinceTime: '',
        allContainers: false,
      });
    }
    case 'ke-prepare': {
      const detail = object(await client.request(`${pipeline}/view`));
      const definitions = array(object(object(detail.data).meta_data).global);
      const history = array(detail.argumentHistory);
      const defaults = history.length
        ? object(history[0].global_args)
        : Object.fromEntries(definitions.map((arg) => [String(arg.name), arg.value ?? '']));
      const args = Object.fromEntries(
        Object.entries({ ...defaults, ...config.arguments }).filter(
          ([key]) => !Object.hasOwn(internalDefaults, key),
        ),
      );
      const parameters = Object.entries(args).map(([key, value]) => ({
        name: key,
        label: definitions.find((arg) => arg.name === key)?.desc || key,
        value,
      }));
      for (const [id, confirmation] of confirmations)
        if (confirmation.expires <= Date.now()) confirmations.delete(id);
      if (confirmations.size >= 200) throw new KubeEaseError('待确认发布过多，请稍后重试。', 429);
      const confirmation = randomUUID();
      confirmations.set(confirmation, {
        expires: Date.now() + 10 * 60_000,
        fingerprint,
        arguments: args,
      });
      return { confirmation, parameters, pipeline: config.pipeline, checkedAt: checkedAt() };
    }
    case 'ke-run': {
      const confirmation = confirmations.get(name(input.confirmation, '发布确认'));
      if (
        !confirmation ||
        confirmation.expires <= Date.now() ||
        confirmation.fingerprint !== fingerprint ||
        input.confirmed !== true
      )
        throw new KubeEaseError('发布确认已失效，请重新准备参数。', 409);
      const args = object(input.arguments);
      if (
        Object.keys(args).length !== Object.keys(confirmation.arguments).length ||
        Object.keys(args).some((key) => !Object.hasOwn(confirmation.arguments, key)) ||
        JSON.stringify(args).length > 16_384
      )
        throw new KubeEaseError('发布参数无效，请重新准备参数。', 400);
      confirmations.delete(name(input.confirmation, '发布确认'));
      let result: Data;
      try {
        result = object(
          await client.request(`${pipeline}/runtimes/create`, {
            deadline: 86400,
            globalArguments: { ...args, ...internalDefaults },
            review: '',
          }),
        );
      } catch {
        throw new KubeEaseError('发布请求未能确认成功，请先刷新运行记录核对结果，避免重复发布。');
      }
      const runtime = result.name ?? result.runtimeName ?? object(result.data).name;
      return {
        submitted: true,
        runtime: typeof runtime === 'string' && runtime ? runtime : null,
        checkedAt: checkedAt(),
      };
    }
    case 'ke-runtimes': {
      const result = object(
        await client.request(
          `${pipeline}/runtimes/list?sortBy=-createTimestamp&page=1&pageSize=30`,
        ),
      );
      return {
        runtimes: array(result.data)
          .map((r) => ({
            name: String(r.name ?? object(r.data).name ?? ''),
            phase: r.phase,
            createAt: r.createAt,
            creator: typeof r.creator === 'string' ? r.creator : '',
          }))
          .filter((r) => r.name),
        checkedAt: checkedAt(),
      };
    }
    case 'ke-runtime':
    case 'ke-pipeline-logs': {
      const runtime = object(await client.request(`${runtimePath()}/view?a=1`));
      const stages = array(runtime.stages).map((s) => ({
        phase: s.phase,
        message: String(s.message ?? ''),
        podName: String(s.podName ?? ''),
        displayName: String(s.displayName ?? s.name ?? ''),
      }));
      if (input.action === 'ke-runtime')
        return {
          runtime: input.runtime,
          phase: runtime.currentPhase,
          stages,
          checkedAt: checkedAt(),
        };
      const pod = name(input.pod, '流水线节点');
      if (!stages.some((stage) => stage.podName === pod))
        throw new KubeEaseError('节点不属于所选运行记录。', 400);
      const response = await client.request(
        `${runtimePath()}/logs/view?podName=${segment(pod)}&containerName=main`,
      );
      const text = typeof response === 'string' ? response : object(response).data;
      if (typeof text !== 'string') throw new KubeEaseError('KubeEase 返回的节点日志格式无效。');
      const buffer = Buffer.from(client.redactLogs(text));
      return {
        logs: buffer.subarray(0, 128 * 1024).toString('utf8'),
        truncated: buffer.length > 128 * 1024,
        checkedAt: checkedAt(),
      };
    }
    default:
      throw new KubeEaseError('KE 操作无效。', 400);
  }
}
