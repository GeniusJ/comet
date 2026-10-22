import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExternalCommandAsync } from '../../platform/process/external-command.js';
import {
  inspectKubernetesDeployment,
  listKubernetesContexts,
  readKubernetesLogs,
} from '../../platform/process/kubernetes.js';

vi.mock('../../platform/process/external-command.js', () => ({
  runExternalCommandAsync: vi.fn(),
}));
const run = vi.mocked(runExternalCommandAsync);
const target = { context: 'test-cluster', namespace: 'test', deployment: 'core', container: '' };
const owner = (kind: string, uid: string) => ({ kind, uid, controller: true });
const pod = (name: string, uid: string) => ({
  metadata: { name, ownerReferences: [owner('ReplicaSet', uid)] },
  spec: { containers: [{ name: 'core' }, { name: 'sidecar' }] },
  status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2 }] },
});

beforeEach(() => {
  run.mockReset();
  run.mockImplementation(async (_command, args) => {
    if (args.includes('get-contexts')) return 'test-cluster\nother-cluster\n';
    if (args.includes('deployment'))
      return JSON.stringify({
        metadata: { uid: 'deployment-1' },
        spec: {
          replicas: 2,
          selector: {
            matchLabels: { app: 'core' },
            matchExpressions: [{ key: 'tier', operator: 'In', values: ['api', 'worker'] }],
          },
          template: { spec: { containers: [{ name: 'core', image: 'core:v1' }] } },
        },
        status: { readyReplicas: 1, updatedReplicas: 2 },
      });
    if (args.includes('replicasets'))
      return JSON.stringify({
        items: [
          { metadata: { uid: 'rs-1', ownerReferences: [owner('Deployment', 'deployment-1')] } },
          { metadata: { uid: 'rs-other', ownerReferences: [owner('Deployment', 'other')] } },
        ],
      });
    if (args.includes('pods'))
      return JSON.stringify({ items: [pod('core-abc', 'rs-1'), pod('other-pod', 'rs-other')] });
    if (args.includes('logs')) return '2026-10-21T00:00:00Z application started\n';
    throw new Error('Unexpected command');
  });
});

describe('read-only kubectl queries', () => {
  it('lists local context names and restricts status to controller-owned Pods', async () => {
    expect(await listKubernetesContexts()).toEqual(['test-cluster', 'other-cluster']);
    const signal = new AbortController().signal;
    const result = await inspectKubernetesDeployment(target, signal);
    expect(result).toMatchObject({ desiredReplicas: 2, readyReplicas: 1, updatedReplicas: 2 });
    expect(result.pods).toEqual([
      {
        name: 'core-abc',
        phase: 'Running',
        containers: ['core', 'sidecar'],
        ready: 1,
        restarts: 2,
      },
    ]);
    for (const [command, args, options] of run.mock.calls.slice(1)) {
      expect(command).toBe('kubectl');
      expect(args).toEqual(
        expect.arrayContaining([
          '--context=test-cluster',
          '--namespace=test',
          '--request-timeout=15s',
        ]),
      );
      expect(options).toMatchObject({ signal, timeoutMs: 20_000, maxBufferBytes: 2_097_152 });
      expect(args).not.toContain('use-context');
    }
    expect(run.mock.calls.find(([, args]) => args.includes('pods'))?.[1]).toContain(
      '--selector=app=core,tier in (api,worker)',
    );
  });

  it('bounds logs and supports previous containers without allowing unrelated resources', async () => {
    expect(
      await readKubernetesLogs(target, {
        pod: 'core-abc',
        container: 'core',
        previous: true,
        tail: 500,
      }),
    ).toMatchObject({ logs: expect.stringContaining('application started') });
    expect(run.mock.lastCall?.[1]).toEqual(
      expect.arrayContaining([
        'logs',
        'core-abc',
        '--container=core',
        '--tail=500',
        '--previous=true',
        '--limit-bytes=131072',
        '--since=1h',
        '--timestamps=true',
      ]),
    );
    for (const options of [
      { pod: 'other-pod', container: 'core' },
      { pod: 'core-abc', container: '--help' },
      { pod: 'core-abc', container: 'core', tail: 100000 },
      { pod: 'core-abc', container: 'core', previous: 'true' },
    ]) {
      run.mockClear();
      await expect(readKubernetesLogs(target, options)).rejects.toMatchObject({ status: 400 });
      expect(run.mock.calls.some(([, args]) => args.includes('logs'))).toBe(false);
    }
    await expect(
      readKubernetesLogs(
        { ...target, container: 'core' },
        { pod: 'core-abc', container: 'sidecar' },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects invalid targets before starting kubectl and hides command errors', async () => {
    await expect(
      inspectKubernetesDeployment({ ...target, namespace: '--all-namespaces' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(run).not.toHaveBeenCalled();
    run.mockRejectedValue(new Error('secret kubeconfig credential'));
    await expect(listKubernetesContexts()).rejects.toThrow('kubectl 查询失败');
    await expect(listKubernetesContexts()).rejects.not.toThrow('secret');
  });

  it('stops on malformed resource data or an empty selector rather than querying all workloads', async () => {
    for (const response of ['not json', '[]', '{"metadata":{"uid":"x"},"spec":{}}']) {
      run.mockClear();
      run.mockResolvedValue(response);
      await expect(inspectKubernetesDeployment(target)).rejects.toMatchObject({ status: 502 });
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});
