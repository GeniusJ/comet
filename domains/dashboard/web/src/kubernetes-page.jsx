import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import { CloudServerOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { DashboardModal } from './dashboard-modal.jsx';
import { KubernetesLogViewer } from './kubernetes-log-viewer.jsx';
import { KubeEaseRelease, KubeEasePipeline, keRequest } from './kubeease-pipeline.jsx';
import { RepositoryBindingDialog } from './project-repositories.jsx';

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Kubernetes 查询失败。');
  return data;
}

function KubernetesDetails({
  endpoint,
  repository,
  initialTab,
  initialRuntime,
  submitted,
  onClose,
}) {
  const [tab, setTab] = useState(initialTab);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState(null);
  const [logError, setLogError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [logBusy, setLogBusy] = useState(false);
  const [pod, setPod] = useState(null);
  const [container, setContainer] = useState(null);
  const [previous, setPrevious] = useState(false);
  const [tail, setTail] = useState(200);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [reload, setReload] = useState(0);
  const [logReload, setLogReload] = useState(0);
  const useKE = Boolean(repository.ke_pipeline);
  const [environment, setEnvironment] = useState(repository.ke_pipeline?.environment || null);
  const [environments, setEnvironments] = useState([]);
  const [environmentError, setEnvironmentError] = useState(null);
  const target = useKE
    ? {
        context: environment,
        namespace: `${repository.ke_pipeline.tenant}-${repository.ke_pipeline.project}`,
        deployment: repository.ke_pipeline.application,
      }
    : repository.kubernetes;
  useEffect(() => {
    if (!useKE || tab === 'pipeline') return undefined;
    const controller = new AbortController();
    setEnvironmentError(null);
    keRequest(endpoint, repository.id, 'ke-environments', {}, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setEnvironments(result.environments);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setEnvironmentError(e.message);
      });
    return () => controller.abort();
  }, [endpoint, repository.id, useKE, tab, reload]);
  const containers = status?.pods.find((item) => item.name === pod)?.containers ?? [];
  const validContainer =
    containers.includes(container) && (!target?.container || target.container === container);

  useEffect(() => {
    if (!target || tab === 'pipeline' || (useKE && !environment)) return undefined;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: useKE ? 'ke-status' : 'status',
        repositoryId: repository.id,
        environment,
      }),
      signal: controller.signal,
    })
      .then(readResponse)
      .then((result) => {
        if (controller.signal.aborted) return;
        setStatus(result);
        setPod((current) =>
          result.pods.some((item) => item.name === current)
            ? current
            : (result.pods[0]?.name ?? null),
        );
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(failure.message);
          setStatus(null);
          setPod(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [endpoint, repository.id, repository.kubernetes, useKE, environment, tab, reload]);

  useEffect(() => {
    const choices = status?.pods.find((item) => item.name === pod)?.containers ?? [];
    setContainer(
      (current) =>
        target?.container || (choices.includes(current) ? current : (choices[0] ?? null)),
    );
  }, [status, pod, repository.kubernetes, useKE]);

  useEffect(() => {
    setLogs(null);
    setLogError(null);
    setLogBusy(false);
    if (tab !== 'runtime' || !pod || !validContainer || busy) return undefined;
    let stopped = false;
    let timer;
    const controller = new AbortController();
    async function load() {
      setLogBusy(true);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: useKE ? 'ke-logs' : 'logs',
            environment,
            repositoryId: repository.id,
            pod,
            container,
            previous,
            tail,
          }),
          signal: controller.signal,
        });
        const result = await readResponse(response);
        if (!stopped) {
          setLogs(result);
          setLogError(null);
        }
      } catch (failure) {
        if (!stopped) setLogError(failure.message);
      } finally {
        if (!stopped) {
          setLogBusy(false);
          if (autoRefresh) timer = setTimeout(load, 5000);
        }
      }
    }
    load();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    endpoint,
    repository.id,
    tab,
    pod,
    container,
    previous,
    tail,
    validContainer,
    busy,
    autoRefresh,
    logReload,
    useKE,
    environment,
  ]);

  return (
    <DashboardModal
      open
      title={`Kubernetes · ${repository.name}`}
      ariaLabel={`Kubernetes ${repository.name}`}
      width={1000}
      styles={{ body: { overflow: 'auto' } }}
      onClose={onClose}
      footer={
        <Button autoInsertSpace={false} onClick={onClose}>
          关闭
        </Button>
      }
    >
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'runtime',
            label: '状态与容器日志',
            children: (
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                {!target ? (
                  <Alert
                    type="info"
                    title="请先在工程配置中填写集群上下文、命名空间和 Deployment。"
                  />
                ) : (
                  <>
                    <Space wrap>
                      {useKE && (
                        <Select
                          aria-label="KE 环境"
                          placeholder="选择 KE 环境"
                          value={environment}
                          options={environments.map((value) => ({ value, label: value }))}
                          onChange={(value) => {
                            setStatus(null);
                            setLogs(null);
                            setPod(null);
                            setEnvironment(value);
                          }}
                          style={{ minWidth: 180 }}
                        />
                      )}
                      {!useKE && <Tag>{target.context}</Tag>}
                      <Tag>{target.namespace}</Tag>
                      <span>{target.deployment}</span>
                      <Button
                        loading={busy}
                        icon={<ReloadOutlined />}
                        onClick={() => setReload((value) => value + 1)}
                      >
                        刷新状态
                      </Button>
                    </Space>
                    {environmentError && <Alert type="error" title={environmentError} />}
                    {useKE && !environment && (
                      <Alert type="info" title="请选择 KE 环境后查看容器状态与日志。" />
                    )}
                    {error && <Alert type="error" showIcon title={error} />}
                    {status && (
                      <>
                        <div>
                          就绪副本：{status.readyReplicas} / {status.desiredReplicas}；已更新：
                          {status.updatedReplicas}
                        </div>
                        <div className="dashboard-repository-location">
                          {status.containers
                            .map((item) => `${item.name}: ${item.image}`)
                            .join('；')}
                        </div>
                        {!status.pods.length ? (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="当前 Deployment 暂无所属 Pod"
                          />
                        ) : (
                          <>
                            <Space wrap>
                              <Select
                                aria-label="日志 Pod"
                                value={pod}
                                options={status.pods.map((item) => ({
                                  value: item.name,
                                  label: `${item.name} · ${item.phase} · 重启 ${item.restarts}`,
                                }))}
                                onChange={setPod}
                                style={{ minWidth: 220, maxWidth: '100%' }}
                              />
                              <Select
                                aria-label="日志容器"
                                value={container}
                                options={containers
                                  .filter((item) => !target.container || item === target.container)
                                  .map((value) => ({ value, label: value }))}
                                onChange={setContainer}
                                style={{ minWidth: 120 }}
                              />
                              <Select
                                aria-label="日志行数"
                                value={tail}
                                options={[100, 200, 500].map((value) => ({
                                  value,
                                  label: `最近 ${value} 行`,
                                }))}
                                onChange={setTail}
                              />
                              <span>
                                上次容器日志{' '}
                                <Switch
                                  aria-label="上次容器日志"
                                  checked={previous}
                                  onChange={setPrevious}
                                />
                              </span>
                              <span>
                                自动刷新{' '}
                                <Switch
                                  aria-label="自动刷新日志"
                                  checked={autoRefresh}
                                  onChange={setAutoRefresh}
                                />
                              </span>
                              <Button
                                disabled={!validContainer || busy}
                                loading={logBusy}
                                onClick={() => setLogReload((value) => value + 1)}
                              >
                                刷新日志
                              </Button>
                            </Space>
                            {!validContainer && (
                              <Alert
                                type="warning"
                                title="配置的容器不在所选 Pod 中，请检查配置或选择其他 Pod。"
                              />
                            )}
                            {logError && <Alert type="error" showIcon title={logError} />}
                            {logs && (
                              <>
                                <small>
                                  {useKE ? 'KE 日志快照' : '最近一小时'} · 最多 128 KiB ·{' '}
                                  {new Date(logs.checkedAt).toLocaleString()}
                                </small>
                                {logs.truncated && (
                                  <Alert type="warning" title="日志已截断，仅展示前 128 KiB。" />
                                )}
                                {logs.partial && (
                                  <small>当前为日志快照，可刷新获取后续日志。</small>
                                )}
                              </>
                            )}
                            <KubernetesLogViewer
                              key="container-log-viewer"
                              text={logs?.logs}
                              label="容器日志"
                              analysis={{
                                endpoint: endpoint.replace(/\/kubernetes$/u, '/log-analysis'),
                                repositoryId: repository.id,
                                source: 'container',
                                context: `${environment || target.context || ''} / ${pod || ''} / ${container || ''} / previous=${previous}`,
                              }}
                            />
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
              </Space>
            ),
          },
          {
            key: 'pipeline',
            label: '流水线日志',
            children: repository.ke_pipeline ? (
              <KubeEasePipeline
                endpoint={endpoint}
                repository={repository}
                initialRuntime={initialRuntime}
                submitted={submitted}
              />
            ) : (
              <Alert type="info" title="尚未配置 KubeEase 流水线" />
            ),
          },
        ]}
      />
    </DashboardModal>
  );
}

export function KubernetesPage({ projectId, project }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(null);
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState(null);
  const [details, setDetails] = useState(null);
  const [release, setRelease] = useState(null);
  const endpoint = `/api/dashboard/projects/${encodeURIComponent(projectId)}`;
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    fetch(`${endpoint}/repositories`, { signal: controller.signal })
      .then(readResponse)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [endpoint, reload]);
  async function save(repository) {
    setBusy(true);
    try {
      const response = await fetch(`${endpoint}/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit', id: editor.id, repository }),
      });
      setData(await readResponse(response));
      setEditor(null);
    } finally {
      setBusy(false);
    }
  }
  const repositories = data?.repositories ?? [];
  const search = query.trim().toLowerCase();
  const filtered = repositories.filter(
    (entry) =>
      (!filter ||
        (filter === 'configured'
          ? Boolean(entry.ke_pipeline || entry.kubernetes)
          : !entry.ke_pipeline && !entry.kubernetes)) &&
      (!search ||
        [
          entry.name,
          ...(entry.tags ?? []),
          entry.kubernetes?.namespace ?? '',
          entry.kubernetes?.context ?? '',
          entry.ke_pipeline?.pipeline ?? '',
        ].some((value) => value.toLowerCase().includes(search))),
  );
  return (
    <section className="dashboard-repositories-page" aria-label="Kubernetes">
      <div className="dashboard-repositories-heading">
        <h2>
          <CloudServerOutlined /> Kubernetes
        </h2>
        <Button
          loading={busy}
          icon={<ReloadOutlined />}
          onClick={() => setReload((value) => value + 1)}
        >
          刷新工程
        </Button>
      </div>
      <div className="dashboard-repositories-body">
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <div className="dashboard-repository-location">
            <strong>当前工作目录：</strong>
            {data?.workspace ?? project?.path}
          </div>
          <Alert
            type="info"
            showIcon
            title="工程来自当前工作目录的仓库绑定"
            description="在仓库管理中配置 KubeEase 流水线及应用。发布前可核对参数，运行记录与两类日志均可从工程查看。"
          />
          {error && <Alert type="error" showIcon title={error} />}
          <Space wrap style={{ width: '100%' }}>
            <Input
              aria-label="查找 Kubernetes 工程"
              prefix={<SearchOutlined />}
              placeholder="工程名、标签、集群、命名空间或流水线"
              value={query}
              allowClear
              onChange={(event) => setQuery(event.target.value)}
              style={{ width: 330, maxWidth: '100%' }}
            />
            <Select
              aria-label="筛选 Kubernetes 配置"
              allowClear
              placeholder="全部工程"
              value={filter}
              options={[
                { value: 'configured', label: '已配置' },
                { value: 'unconfigured', label: '未配置' },
              ]}
              onChange={setFilter}
              style={{ width: 140 }}
            />
            <span>
              {filtered.length} / {repositories.length} 个工程
            </span>
          </Space>
          <Table
            rowKey="id"
            size="small"
            dataSource={filtered}
            loading={busy}
            scroll={{ x: 1100 }}
            onRow={(entry) => ({ 'aria-label': `Kubernetes 工程 ${entry.name}` })}
            pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    repositories.length ? '没有符合条件的工程' : '请先在仓库管理中绑定工程'
                  }
                />
              ),
            }}
            columns={[
              {
                title: '工程',
                key: 'name',
                width: 200,
                render: (_, entry) => (
                  <>
                    <strong>{entry.name}</strong>
                    <div>
                      <Tag>{entry.kind === 'backend' ? '后端' : '前端'}</Tag>
                      {(entry.tags ?? []).map((tag) => (
                        <Tag key={tag} color="blue">
                          {tag}
                        </Tag>
                      ))}
                    </div>
                  </>
                ),
              },
              {
                title: 'KubeEase 流水线',
                key: 'pipeline',
                width: 230,
                render: (_, entry) =>
                  entry.ke_pipeline ? (
                    <div className="dashboard-repository-location">
                      <div>{entry.ke_pipeline.pipeline}</div>
                      <small>
                        {entry.ke_pipeline.tenant} / {entry.ke_pipeline.project} /{' '}
                        {entry.ke_pipeline.application}
                      </small>
                      <div>
                        <Tag color="blue">KubeEase</Tag>
                      </div>
                    </div>
                  ) : (
                    '未配置'
                  ),
              },
              {
                title: 'Kubernetes 运行环境',
                key: 'target',
                width: 250,
                render: (_, entry) =>
                  entry.ke_pipeline ? (
                    <div>
                      {entry.ke_pipeline.environment || '查看时选择 KE 环境'}
                      <div>{entry.ke_pipeline.application}</div>
                    </div>
                  ) : entry.kubernetes ? (
                    <div className="dashboard-repository-location">
                      <div>{entry.kubernetes.context}</div>
                      <div>
                        {entry.kubernetes.namespace} / {entry.kubernetes.deployment}
                      </div>
                    </div>
                  ) : (
                    '未配置'
                  ),
              },
              {
                title: '操作',
                key: 'actions',
                width: 420,
                render: (_, entry) => (
                  <Space size={4} wrap>
                    <Button
                      autoInsertSpace={false}
                      size="small"
                      disabled={busy}
                      onClick={() => setEditor(entry)}
                    >
                      配置
                    </Button>
                    <Tooltip
                      title={
                        entry.ke_pipeline ? '准备流水线参数并确认发布' : '请先配置 KubeEase 流水线'
                      }
                    >
                      <span>
                        <Button
                          autoInsertSpace={false}
                          size="small"
                          disabled={!entry.ke_pipeline || busy}
                          onClick={() => setRelease(entry)}
                        >
                          发布
                        </Button>
                      </span>
                    </Tooltip>
                    <Button
                      size="small"
                      disabled={!entry.kubernetes && !entry.ke_pipeline}
                      onClick={() => setDetails({ repository: entry, tab: 'runtime' })}
                    >
                      状态与容器日志
                    </Button>
                    <Button
                      size="small"
                      disabled={!entry.ke_pipeline}
                      onClick={() => setDetails({ repository: entry, tab: 'pipeline' })}
                    >
                      流水线日志
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Space>
      </div>
      {editor && (
        <RepositoryBindingDialog
          projectId={projectId}
          repository={editor}
          tagOptions={[...new Set(repositories.flatMap((entry) => entry.tags ?? []))].map(
            (value) => ({ value, label: value }),
          )}
          busy={busy}
          deploymentOnly
          onSave={save}
          onClose={() => setEditor(null)}
        />
      )}
      {release && (
        <KubeEaseRelease
          key={release.id}
          endpoint={`${endpoint}/kubernetes`}
          repository={release}
          onClose={() => setRelease(null)}
          onSubmitted={(result) => {
            setDetails({
              repository: release,
              tab: 'pipeline',
              runtime: result.runtime,
              submitted: true,
            });
            setRelease(null);
          }}
        />
      )}
      {details && (
        <KubernetesDetails
          key={details.repository.id}
          endpoint={`${endpoint}/kubernetes`}
          repository={details.repository}
          initialTab={details.tab}
          initialRuntime={details.runtime}
          submitted={details.submitted}
          onClose={() => setDetails(null)}
        />
      )}
    </section>
  );
}
