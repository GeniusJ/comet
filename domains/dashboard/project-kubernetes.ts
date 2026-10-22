import {
  inspectKubernetesDeployment,
  readKubernetesLogs,
} from '../../platform/process/kubernetes.js';
import { ManagedRepositoryError } from '../../platform/process/managed-repository.js';
import { queryDashboardKubeEase } from './project-kubeease.js';
import { collectDashboardRepositories } from './project-repositories.js';

export async function queryDashboardKubernetes(
  projectPath: string,
  input: unknown,
  signal?: AbortSignal,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ManagedRepositoryError('Kubernetes 查询无效。', 400);
  const request = input as Record<string, unknown>;
  if (
    ![
      'status',
      'logs',
      'ke-environments',
      'ke-status',
      'ke-logs',
      'ke-prepare',
      'ke-run',
      'ke-runtimes',
      'ke-runtime',
      'ke-pipeline-logs',
    ].includes(String(request.action))
  )
    throw new ManagedRepositoryError('Kubernetes 查询无效。', 400);
  const data = await collectDashboardRepositories(projectPath);
  const repository = data.repositories.find((entry) => entry.id === request.repositoryId);
  if (!repository) throw new ManagedRepositoryError('工程不存在。', 404);
  if (String(request.action).startsWith('ke-')) {
    if (!repository.ke_pipeline) throw new ManagedRepositoryError('请先配置 KubeEase 流水线。');
    return queryDashboardKubeEase(
      projectPath,
      repository.id,
      repository.ke_pipeline,
      request,
      signal,
    );
  }
  if (!repository.kubernetes)
    throw new ManagedRepositoryError('请先在仓库管理中配置 Kubernetes 运行环境。');
  return request.action === 'status'
    ? inspectKubernetesDeployment(repository.kubernetes, signal)
    : readKubernetesLogs(
        repository.kubernetes,
        request as { pod: unknown; container: unknown },
        signal,
      );
}
