import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input, Select, Space, Spin, Switch, Tabs, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

async function request(projectId, suffix, body) {
  const response = await fetch(
    `/api/dashboard/projects/${encodeURIComponent(projectId)}/${suffix}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败（${response.status}）`);
  return result;
}

export function ProjectSettingsPage({ projectId, project, ConfigEditor, onChanged }) {
  const [form] = Form.useForm();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const workflow = Form.useWatch('workflow', form) ?? 'native';
  const codegraph = Form.useWatch('codegraph', form) ?? 'skip';

  useEffect(() => {
    mounted.current = true;
    setError(null);
    let timer;
    const load = async (initial = false) => {
      try {
        const next = await request(projectId, 'initialization');
        if (!mounted.current) return;
        setData(next);
        if (initial && next.config) {
          form.setFieldsValue({
            workflow: next.config.workflows.length === 2 ? 'both' : next.config.defaultWorkflow,
            language: next.config.native.language === 'zh-CN' ? 'zh' : 'en',
            artifactRoot: next.config.native.artifactRoot,
          });
        }
        if (next.busy) timer = setTimeout(() => void load(), 2000);
      } catch (failure) {
        if (mounted.current) setError(failure.message);
      }
    };
    void load(true);
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [projectId, form, retry]);

  async function initialize(options) {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const nextResult = await request(projectId, 'initialization', options);
      if (!mounted.current) return;
      setResult(nextResult);
      const next = await request(projectId, 'initialization');
      if (!mounted.current) return;
      setData(next);
      await onChanged(next.config);
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      if (mounted.current) setRunning(false);
    }
  }

  async function save(config) {
    const next = await request(projectId, 'config', {
      expectedRevision: data.config.revision,
      config,
    });
    if (!mounted.current) return;
    setData((current) => ({ ...current, config: next }));
    await onChanged(next);
  }

  const busy = running || data?.busy;
  return (
    <section className="dashboard-repositories-page" aria-label="项目配置">
      <div className="dashboard-repositories-heading">
        <div>
          <h2>项目配置</h2>
          <p style={{ overflowWrap: 'anywhere', marginBottom: 0 }}>
            {project?.name} · {project?.path}
          </p>
        </div>
        <Tag color={data?.config ? 'success' : 'default'}>
          {data?.config ? '已有 Comet 配置' : '尚无有效 Comet 配置'}
        </Tag>
      </div>
      <div className="dashboard-repositories-body">
        {error && <Alert type="error" showIcon title={error} />}
        {!data ? (
          error ? (
            <Button onClick={() => setRetry((value) => value + 1)}>重新加载</Button>
          ) : (
            <Spin aria-label="加载项目配置" />
          )
        ) : (
          <Tabs
            items={[
              {
                key: 'initialization',
                label: 'Comet 初始化',
                children: (
                  <Card size="small" title="初始化当前项目">
                    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
                      <Alert
                        type="info"
                        showIcon
                        title="在上方工作目录执行 comet init"
                        description="安装所选平台的 Comet Skills、规则及支持的 Hook，并创建工作流目录与 .comet/config.yaml。仅初始化当前项目，已有文件默认保留。"
                      />
                      {data.configError && (
                        <Alert type="warning" showIcon title={data.configError} />
                      )}
                      {!data.available && (
                        <Alert
                          type="warning"
                          title="当前服务未启用初始化，请使用 comet dashboard 启动。"
                        />
                      )}
                      {data.busy && (
                        <Alert
                          type="info"
                          showIcon
                          title={
                            data.running
                              ? '当前项目正在初始化…'
                              : '其他项目正在初始化，请稍后重试。'
                          }
                        />
                      )}
                      <Form
                        form={form}
                        layout="vertical"
                        disabled={busy || !data.available}
                        initialValues={{
                          platform: 'codex',
                          workflow: 'native',
                          language: 'zh',
                          artifactRoot: 'docs',
                          overwrite: false,
                          codegraph: 'skip',
                        }}
                        onFinish={initialize}
                      >
                        <div className="dashboard-project-init-fields">
                          <Form.Item
                            name="platform"
                            label="Agent 平台"
                            rules={[{ required: true }]}
                          >
                            <Select
                              showSearch
                              optionFilterProp="label"
                              options={data.platforms.map(({ id, name }) => ({
                                value: id,
                                label: name,
                              }))}
                            />
                          </Form.Item>
                          <Form.Item name="workflow" label="工作流" rules={[{ required: true }]}>
                            <Select
                              options={[
                                { value: 'native', label: 'Native' },
                                { value: 'classic', label: 'Classic' },
                                { value: 'both', label: 'Native + Classic（默认 Native）' },
                              ]}
                            />
                          </Form.Item>
                          <Form.Item name="language" label="语言">
                            <Select
                              options={[
                                { value: 'zh', label: '中文' },
                                { value: 'en', label: 'English' },
                              ]}
                            />
                          </Form.Item>
                          <Form.Item
                            name="artifactRoot"
                            label="Native 文档根目录"
                            extra="相对于当前工作目录，例如 docs。Classic 沿用 CLI 的目录规则。"
                            rules={[{ required: true, whitespace: true }]}
                          >
                            <Input />
                          </Form.Item>
                          <Form.Item name="codegraph" label="CodeGraph 项目索引">
                            <Select
                              options={[
                                { value: 'skip', label: '跳过' },
                                { value: 'init', label: '初始化索引' },
                              ]}
                            />
                          </Form.Item>
                          <Form.Item
                            name="overwrite"
                            label="覆盖已有的 Comet 托管文件"
                            valuePropName="checked"
                            extra="默认关闭；开启后与 comet init --overwrite 一致。用户自建文件不属于覆盖范围。"
                          >
                            <Switch />
                          </Form.Item>
                        </div>
                        {(workflow !== 'native' || codegraph === 'init') && (
                          <Alert
                            style={{ marginBottom: 16 }}
                            type="warning"
                            showIcon
                            title="依赖与索引安装"
                            description="Classic 可能安装 OpenSpec / Superpowers 依赖；CodeGraph 初始化可能下载工具并扫描项目。执行行为与 CLI 相同。"
                          />
                        )}
                        <Button
                          type="primary"
                          htmlType="submit"
                          aria-label={data.config ? '重新初始化 Comet' : '初始化 Comet'}
                          icon={<ReloadOutlined />}
                          loading={running}
                        >
                          {data.config ? '重新初始化 Comet' : '初始化 Comet'}
                        </Button>
                      </Form>
                      {result && (
                        <Alert
                          showIcon
                          type={result.status === 'complete' ? 'success' : 'warning'}
                          title={
                            result.status === 'complete' ? 'Comet 初始化完成' : 'Comet 初始化未完成'
                          }
                          description={
                            result.status === 'incomplete'
                              ? result.failures
                                  .map((failure) => `${failure.component}：${failure.reason}`)
                                  .join('\n') || '请检查执行结果后重试。'
                              : '可切换到“Comet 配置”继续调整项目设置。'
                          }
                        />
                      )}
                      {result && (
                        <details>
                          <summary>执行结果</summary>
                          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            {JSON.stringify(result, null, 2)}
                          </pre>
                        </details>
                      )}
                    </Space>
                  </Card>
                ),
              },
              {
                key: 'config',
                label: 'Comet 配置',
                disabled: !data.config || busy,
                children: data.config ? <ConfigEditor data={data.config} onSave={save} /> : null,
              },
            ]}
          />
        )}
      </div>
    </section>
  );
}
