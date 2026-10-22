import { useState } from 'react';
import { Alert, AutoComplete, Button, Form, Input, Space, Switch } from 'antd';

export function RepositoryDeploymentFields({ projectId, form, busy }) {
  const enabled = Form.useWatch('kubernetesEnabled', form);
  const pipelineEnabled = Form.useWatch('pipelineEnabled', form);
  const [contexts, setContexts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  async function loadContexts() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dashboard/projects/${encodeURIComponent(projectId)}/kubernetes/contexts`,
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法读取本机集群上下文。');
      setContexts(result.contexts ?? []);
      if (!result.contexts?.length)
        setError('本机尚未配置集群上下文，请先配置 kubeconfig，或手动填写已有上下文名称。');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        title="每个工程独立配置发布流水线和运行环境"
        description="发布、应用状态及两类日志通过 KubeEase 获取；本地 Kubernetes 配置可作为独立查询方式。"
      />
      <Form.Item name="pipelineEnabled" label="配置 KubeEase 发布流水线" valuePropName="checked">
        <Switch />
      </Form.Item>
      {pipelineEnabled && (
        <>
          <Form.Item
            name={['ke_pipeline', 'base_url']}
            label="KubeEase 地址"
            rules={[{ required: true }]}
          >
            <Input placeholder="http://pro.kubeease.cn" />
          </Form.Item>
          <div className="dashboard-repository-form-grid">
            {[
              ['tenant', '租户', 'jstest'],
              ['project', 'KubeEase 项目', 'jstytest'],
              ['application', '应用', 'core'],
              ['environment', '环境（选填）', ''],
              ['pipeline', '流水线', 'coreceshiqianyi'],
            ].map(([key, label, placeholder]) => (
              <Form.Item
                key={key}
                name={['ke_pipeline', key]}
                label={label}
                rules={key === 'environment' ? [] : [{ required: true }]}
              >
                <Input placeholder={placeholder} />
              </Form.Item>
            ))}
          </div>
          <Form.Item
            name="pipelineArguments"
            label="流水线参数（JSON）"
            rules={[
              {
                validator: async (_, value) => {
                  try {
                    const parsed = JSON.parse(value || '{}');
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                      throw new Error();
                  } catch {
                    throw new Error('请输入 JSON 对象，例如 {}。');
                  }
                },
              },
            ]}
          >
            <Input.TextArea rows={3} spellCheck={false} />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="访问凭证由 Dashboard 服务端读取"
            description="发布时先准备并确认流水线参数；环境留空时，在查看容器日志时选择。"
          />
        </>
      )}
      <Form.Item name="kubernetesEnabled" label="配置 Kubernetes 运行环境" valuePropName="checked">
        <Switch />
      </Form.Item>
      {enabled && (
        <>
          {error && <Alert type="warning" showIcon title={error} />}
          <Space wrap>
            <Button loading={loading} disabled={busy} onClick={loadContexts}>
              读取本机集群上下文
            </Button>
            <span>仅使用已配置的 kubeconfig，不切换本机默认集群。</span>
          </Space>
          <Form.Item
            name={['kubernetes', 'context']}
            label="集群上下文"
            rules={[{ required: true }]}
          >
            <AutoComplete
              options={contexts.map((value) => ({ value }))}
              placeholder="选择或输入 kubeconfig 中的上下文"
              filterOption={(input, option) =>
                option.value.toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <div className="dashboard-repository-form-grid">
            <Form.Item
              name={['kubernetes', 'namespace']}
              label="命名空间"
              rules={[{ required: true }]}
            >
              <Input placeholder="例如 default" />
            </Form.Item>
            <Form.Item
              name={['kubernetes', 'deployment']}
              label="Deployment"
              rules={[{ required: true }]}
            >
              <Input placeholder="例如 core" />
            </Form.Item>
            <Form.Item name={['kubernetes', 'container']} label="容器（选填）">
              <Input placeholder="留空时可查询所属 Pod 的容器" />
            </Form.Item>
          </div>
        </>
      )}
    </Space>
  );
}
