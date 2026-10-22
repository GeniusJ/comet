import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tabs,
  Tooltip,
} from 'antd';
import {
  DisconnectOutlined,
  EditOutlined,
  PlusOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { DashboardModal } from './dashboard-modal.jsx';
import { RepositoryDeploymentFields } from './repository-deployment-fields.jsx';

const emptyRepository = { name: '', remote: '', branch: '', kind: 'backend', tags: [] };

export function RepositoryBindingDialog({
  projectId,
  repository,
  tagOptions,
  busy,
  onSave,
  onClose,
  deploymentOnly = false,
}) {
  const [form] = Form.useForm();
  const [error, setError] = useState(null);
  const kind = Form.useWatch('kind', form) ?? repository?.kind ?? 'backend';
  const name = Form.useWatch('name', form) ?? repository?.name ?? '';
  async function save(sync) {
    let fields;
    try {
      fields = await form.validateFields();
    } catch {
      return;
    }
    setError(null);
    try {
      const { kubernetesEnabled, pipelineEnabled, pipelineArguments, ...binding } = fields;
      await onSave(
        {
          ...binding,
          kubernetes: kubernetesEnabled ? fields.kubernetes : null,
          ke_pipeline: pipelineEnabled
            ? {
                ...fields.ke_pipeline,
                action: 'run',
                arguments: JSON.parse(pipelineArguments || '{}'),
              }
            : null,
        },
        sync,
      );
    } catch (failure) {
      setError(failure.message);
    }
  }
  return (
    <DashboardModal
      open
      title={repository ? '编辑仓库绑定' : '新增仓库绑定'}
      ariaLabel={repository ? '编辑仓库绑定' : '新增仓库绑定'}
      width={720}
      styles={{ body: { overflow: 'auto' } }}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <Space wrap>
          <Button autoInsertSpace={false} disabled={Boolean(busy)} onClick={onClose}>
            取消
          </Button>
          <Button disabled={Boolean(busy)} onClick={() => save(false)}>
            {deploymentOnly ? '保存配置' : '仅保存绑定'}
          </Button>
          {!deploymentOnly && (
            <Button
              type="primary"
              disabled={Boolean(busy)}
              loading={busy === 'saving'}
              onClick={() => save(true)}
            >
              保存并拉取
            </Button>
          )}
        </Space>
      }
    >
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          ...emptyRepository,
          ...repository,
          kubernetes: repository?.kubernetes ?? {
            context: '',
            namespace: 'default',
            deployment: repository?.name ?? '',
            container: '',
          },
          ke_pipeline: repository?.ke_pipeline ?? {
            base_url: 'http://pro.kubeease.cn',
            tenant: '',
            project: '',
            application: '',
            environment: '',
            pipeline: '',
          },
          kubernetesEnabled: Boolean(repository?.kubernetes),
          pipelineEnabled: Boolean(repository?.ke_pipeline),
          pipelineArguments: JSON.stringify(repository?.ke_pipeline?.arguments ?? {}, null, 2),
        }}
        clearOnDestroy
        disabled={Boolean(busy)}
      >
        <Tabs
          defaultActiveKey={deploymentOnly ? 'kubernetes' : 'repository'}
          items={[
            {
              key: 'repository',
              label: '仓库绑定',
              forceRender: true,
              children: (
                <>
                  {' '}
                  <Form.Item
                    name="remote"
                    label="Git 仓库地址"
                    rules={[{ required: true, message: '请输入 Git 仓库地址' }]}
                  >
                    <Input placeholder="https://github.com/team/repo.git 或 git@host:team/repo.git" />
                  </Form.Item>
                  <div className="dashboard-repository-form-grid">
                    <Form.Item
                      name="name"
                      label="工程名"
                      rules={[{ required: true, whitespace: true, message: '请输入工程名' }]}
                    >
                      <Input placeholder="例如 order-service" />
                    </Form.Item>
                    <Form.Item name="kind" label="工程类型">
                      <Select
                        options={[
                          { value: 'backend', label: '后端' },
                          { value: 'frontend', label: '前端' },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item name="branch" label="分支（选填）">
                      <Input placeholder="留空使用默认或当前分支" />
                    </Form.Item>
                  </div>
                  <Form.Item
                    name="tags"
                    label="标签"
                    extra="输入后按 Enter 添加，可选择已有标签；最多 20 个，每个不超过 40 字。"
                  >
                    <Select
                      mode="tags"
                      placement="topLeft"
                      options={tagOptions}
                      maxCount={20}
                      maxTagCount="responsive"
                      tokenSeparators={[',', '，']}
                      placeholder="例如：核心服务、票务"
                    />
                  </Form.Item>
                  <p className="dashboard-repository-location">
                    代码目录：engineering/{kind === 'backend' ? 'backed' : 'frontend'}/
                    {name || '<工程名>'}
                  </p>
                </>
              ),
            },
            {
              key: 'kubernetes',
              label: 'Kubernetes 发布',
              forceRender: true,
              children: (
                <RepositoryDeploymentFields
                  projectId={projectId}
                  form={form}
                  busy={Boolean(busy)}
                />
              ),
            },
          ]}
        />
      </Form>
    </DashboardModal>
  );
}

export function ProjectRepositoriesPage({ projectId, project }) {
  const { modal } = App.useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [editor, setEditor] = useState(null);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState(null);
  const [tagFilter, setTagFilter] = useState([]);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState(null);
  const [discovery, setDiscovery] = useState(null);
  const [selected, setSelected] = useState([]);
  const [reload, setReload] = useState(0);
  const endpoint = `/api/dashboard/projects/${encodeURIComponent(projectId)}/repositories`;

  useEffect(() => {
    const controller = new AbortController();
    setBusy('loading');
    setData(null);
    setDiscovery(null);
    setSelected([]);
    setNotice(null);
    setEditor(null);
    setError(null);
    fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '无法读取项目仓库。');
        if (controller.signal.aborted) return;
        setData(result);
        if (result.initialized === false) {
          const response = await fetch(`${endpoint}/discovery`, { signal: controller.signal });
          const local = await response.json();
          if (!response.ok) throw new Error(local.error || '无法扫描本地仓库。');
          if (!controller.signal.aborted) setDiscovery(local);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [endpoint, reload]);

  async function request(body) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '仓库维护失败。');
    setData(result);
    return result;
  }

  async function scan() {
    setBusy('scanning');
    setError(null);
    setSelected([]);
    try {
      const response = await fetch(`${endpoint}/discovery`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法扫描本地仓库。');
      setDiscovery(result);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  }

  async function initialize(paths) {
    setBusy('initializing');
    setError(null);
    setNotice(null);
    try {
      await request({ action: 'initialize', paths });
      setDiscovery(null);
      setSelected([]);
      setNotice(
        paths.length
          ? `已纳入 ${paths.length} 个本地仓库，未执行代码拉取。`
          : '初始化已完成，可随时扫描并添加本地仓库。',
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  }

  async function save(repository, sync) {
    setBusy('saving');
    setError(null);
    setNotice(null);
    let saved = false;
    try {
      const result = await request({
        action: editor.repository ? 'edit' : 'bind',
        id: editor.repository?.id,
        repository,
      });
      const entry = result.repositories.find(
        (item) => item.name === repository.name.trim() && item.kind === repository.kind,
      );
      saved = true;
      setEditor(null);
      if (sync) {
        setBusy(`sync:${entry.id}`);
        const updated = await request({ action: 'sync', id: entry.id });
        setNotice(
          `代码已${updated.result.action === 'cloned' ? '克隆' : '更新'}到 ${entry.relativePath}（${updated.result.branch} · ${updated.result.head}）。`,
        );
      } else setNotice('仓库绑定已保存。');
    } catch (failure) {
      if (!saved) throw failure;
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  }

  async function action(action, entry) {
    setBusy(`${action}:${entry.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await request({ action, id: entry.id });
      setNotice(
        action === 'unbind'
          ? '已解除绑定，本地代码保留。'
          : `代码已${result.result.action === 'cloned' ? '克隆' : '更新'}：${entry.relativePath}（${result.result.branch} · ${result.result.head}）。`,
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(null);
    }
  }

  const repositories = data?.repositories ?? [];
  const tagOptions = [...new Set(repositories.flatMap((entry) => entry.tags ?? []))]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, label: value }));
  const search = query.trim().toLocaleLowerCase();
  const filtered = repositories.filter(
    (entry) =>
      (!kindFilter || entry.kind === kindFilter) &&
      tagFilter.every((tag) => (entry.tags ?? []).includes(tag)) &&
      (!search ||
        [entry.name, entry.remote, entry.branch, entry.relativePath, ...(entry.tags ?? [])].some(
          (value) => value.toLocaleLowerCase().includes(search),
        )),
  );
  const hasFilters = Boolean(query || kindFilter || tagFilter.length);
  const columns = [
    {
      title: '工程',
      key: 'repository',
      width: 340,
      render: (_, entry) => (
        <div className="dashboard-repository-location">
          <strong>{entry.name}</strong>
          <div className="dashboard-repository-secondary">{entry.remote}</div>
          <div className="dashboard-repository-secondary">{entry.relativePath}</div>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 80,
      render: (kind) => <Tag>{kind === 'backend' ? '后端' : '前端'}</Tag>,
    },
    {
      title: '分支',
      dataIndex: 'branch',
      width: 120,
      render: (branch) => (
        <span className="dashboard-repository-location">{branch || '默认 / 当前分支'}</span>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 170,
      render: (tags = []) =>
        tags.length ? (
          <Space size={[0, 4]} wrap>
            {tags.map((tag) => (
              <Tag key={tag} color="blue" className="dashboard-repository-tag">
                {tag}
              </Tag>
            ))}
          </Space>
        ) : (
          <span className="dashboard-repository-secondary">未打标签</span>
        ),
    },
    {
      title: '上次拉取',
      dataIndex: 'lastSyncedAt',
      width: 165,
      render: (value) => (value ? new Date(value).toLocaleString() : '尚未拉取'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 112,
      render: (_, entry) => (
        <Space size={4}>
          <Tooltip title="拉取代码">
            <span>
              <Button
                type="link"
                size="small"
                icon={<SyncOutlined />}
                aria-label="拉取代码"
                disabled={Boolean(busy)}
                loading={busy === `sync:${entry.id}`}
                onClick={() => action('sync', entry)}
              />
            </span>
          </Tooltip>
          <Tooltip title="编辑绑定">
            <span>
              <Button
                type="link"
                size="small"
                icon={<EditOutlined />}
                aria-label="编辑绑定"
                disabled={Boolean(busy)}
                onClick={() => setEditor({ repository: entry })}
              />
            </span>
          </Tooltip>
          <Tooltip title="解除绑定">
            <span>
              <Button
                type="link"
                size="small"
                icon={<DisconnectOutlined />}
                aria-label="解除绑定"
                danger
                disabled={Boolean(busy)}
                onClick={() =>
                  modal.confirm({
                    title: '解除仓库绑定？',
                    content: '本地代码会保留，之后可重新绑定。',
                    okText: '解除绑定',
                    cancelText: '取消',
                    onOk: () => action('unbind', entry),
                  })
                }
              />
            </span>
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <section className="dashboard-repositories-page" aria-label="仓库管理">
      <div className="dashboard-repositories-heading">
        <h2>仓库管理</h2>
        <Space wrap>
          <Button disabled={Boolean(busy) || !data} loading={busy === 'scanning'} onClick={scan}>
            扫描本地仓库
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            aria-label="新增仓库"
            disabled={Boolean(busy) || !data}
            onClick={() => setEditor({ repository: null })}
          >
            新增仓库
          </Button>
        </Space>
      </div>
      <div className="dashboard-repositories-body">
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <div style={{ overflowWrap: 'anywhere' }}>
            <strong style={{ whiteSpace: 'nowrap' }}>当前工作目录：</strong>
            {data?.workspace ?? project?.path}
          </div>
          <Alert
            type="info"
            showIcon
            title="前后端工程分目录管理"
            description="后端：engineering/backed/<工程名>；前端：engineering/frontend/<工程名>。首次拉取克隆仓库，后续仅快进更新。使用本机已有的 Git 认证。"
          />
          {error && <Alert type="error" showIcon title={error} />}
          {notice && <Alert type="success" showIcon title={notice} />}
          {busy?.startsWith('sync:') && (
            <Alert type="info" showIcon title="正在拉取代码，请稍候…" />
          )}
          {!data && !busy && (
            <Button onClick={() => setReload((value) => value + 1)}>重新加载</Button>
          )}
          {busy === 'loading' && <Alert type="info" title="正在加载仓库并扫描本地工程…" />}
          {(discovery || data?.initialized === false) && (
            <Card
              size="small"
              title={data?.initialized === false ? '初始化本地仓库' : '发现本地仓库'}
            >
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                <p>
                  扫描当前工作目录 engineering/backed 和 engineering/frontend 下的 Git
                  仓库。勾选后仅保存绑定，保留本地文件和当前分支。
                </p>
                {(discovery?.candidates ?? []).map((candidate) => (
                  <div key={candidate.relativePath} style={{ overflowWrap: 'anywhere' }}>
                    <Checkbox
                      disabled={Boolean(busy) || Boolean(candidate.issue)}
                      checked={selected.includes(candidate.relativePath)}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, candidate.relativePath]
                            : previous.filter((item) => item !== candidate.relativePath),
                        )
                      }
                    >
                      {candidate.name}（{candidate.kind === 'backend' ? '后端' : '前端'}）
                    </Checkbox>
                    <div>{candidate.relativePath}</div>
                    {candidate.issue ? (
                      <Alert type="warning" showIcon title={candidate.issue} />
                    ) : (
                      <div>
                        {candidate.remote} · {candidate.branch}
                      </div>
                    )}
                  </div>
                ))}
                {discovery?.candidates?.length === 0 && (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="未发现可添加的本地 Git 仓库"
                  />
                )}
                <Space wrap>
                  <Button
                    type="primary"
                    disabled={Boolean(busy) || !selected.length}
                    loading={busy === 'initializing'}
                    onClick={() => initialize(selected)}
                  >
                    纳入所选仓库（{selected.length}）
                  </Button>
                  <Button disabled={Boolean(busy)} onClick={() => initialize([])}>
                    暂不添加
                  </Button>
                  <Button disabled={Boolean(busy)} onClick={scan}>
                    重新扫描
                  </Button>
                </Space>
              </Space>
            </Card>
          )}
          <div className="dashboard-repositories-list-heading">
            <strong>已绑定仓库（{repositories.length}）</strong>
            {hasFilters && (
              <span className="dashboard-repository-secondary">找到 {filtered.length} 个仓库</span>
            )}
          </div>
          <div className="dashboard-repositories-filters">
            <Input
              aria-label="查找仓库"
              prefix={<SearchOutlined />}
              placeholder="搜索工程名、地址、分支或标签"
              value={query}
              allowClear
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
            <Select
              aria-label="筛选工程类型"
              placeholder="全部类型"
              value={kindFilter}
              allowClear
              options={[
                { value: 'backend', label: '后端' },
                { value: 'frontend', label: '前端' },
              ]}
              onChange={(value) => {
                setKindFilter(value ?? null);
                setPage(1);
              }}
            />
            <Select
              aria-label="筛选标签"
              mode="multiple"
              placeholder="标签（同时匹配）"
              value={tagFilter}
              allowClear
              options={tagOptions}
              maxTagCount="responsive"
              onChange={(value) => {
                setTagFilter(value);
                setPage(1);
              }}
            />
            <Button
              disabled={!hasFilters}
              onClick={() => {
                setQuery('');
                setKindFilter(null);
                setTagFilter([]);
                setPage(1);
              }}
            >
              重置筛选
            </Button>
          </div>
          <Table
            className="dashboard-repositories-table"
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={filtered}
            onRow={(entry) => ({ 'aria-label': `仓库 ${entry.name}` })}
            loading={busy === 'loading'}
            scroll={{ x: 987 }}
            pagination={{
              current: Math.min(page, Math.max(1, Math.ceil(filtered.length / 10))),
              pageSize: 10,
              showSizeChanger: false,
              hideOnSinglePage: true,
              onChange: setPage,
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={repositories.length ? '没有符合条件的仓库' : '尚未绑定 Git 仓库'}
                />
              ),
            }}
          />
        </Space>
      </div>
      {editor && (
        <RepositoryBindingDialog
          projectId={projectId}
          key={editor.repository?.id ?? 'new'}
          repository={editor.repository}
          tagOptions={tagOptions}
          busy={busy}
          onSave={save}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
}
