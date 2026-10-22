import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Select, Space, Tag } from 'antd';
import { DashboardModal } from './dashboard-modal.jsx';
import { KubernetesLogViewer } from './kubernetes-log-viewer.jsx';

export async function keRequest(endpoint, repositoryId, action, data = {}, signal) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, repositoryId, action }),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'KubeEase 请求失败。');
  return result;
}

export function KubeEaseRelease({ endpoint, repository, onClose, onSubmitted }) {
  const [prepared, setPrepared] = useState(null);
  const [args, setArgs] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [consumed, setConsumed] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setPrepared(null);
    setError(null);
    setBusy(true);
    setConsumed(false);
    keRequest(endpoint, repository.id, 'ke-prepare', {}, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPrepared(result);
        setArgs(
          Object.fromEntries(
            result.parameters.map((p) => [
              p.name,
              typeof p.value === 'string' ? p.value : JSON.stringify(p.value),
            ]),
          ),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [endpoint, repository.id, reload]);
  async function release() {
    if (submitting.current || consumed || !prepared) return;
    submitting.current = true;
    setBusy(true);
    setConsumed(true);
    setError(null);
    try {
      const values = Object.fromEntries(
        prepared.parameters.map((p) => [
          p.name,
          typeof p.value === 'string' ? args[p.name] : JSON.parse(args[p.name]),
        ]),
      );
      const result = await keRequest(endpoint, repository.id, 'ke-run', {
        confirmation: prepared.confirmation,
        confirmed: true,
        arguments: values,
      });
      onSubmitted(result);
    } catch (e) {
      setError(e.message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <DashboardModal
      open
      title={`发布 · ${repository.name}`}
      width={760}
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      footer={
        <Space>
          <Button autoInsertSpace={false} disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="primary" loading={busy} disabled={!prepared || consumed} onClick={release}>
            确认发布
          </Button>
        </Space>
      }
    >
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          title={`确认运行流水线：${repository.ke_pipeline.pipeline}`}
          description="请核对发布分支与参数，确认后将触发一次真实发布。"
        />
        {error && <Alert type="error" showIcon title={error} />}
        {(error || consumed) && (
          <Button disabled={busy} onClick={() => setReload((v) => v + 1)}>
            重新准备参数
          </Button>
        )}
        {prepared?.parameters.map((p) => (
          <label key={p.name} style={{ display: 'block', width: '100%' }}>
            <span>
              {p.label} <small>({p.name})</small>
            </span>
            <Input.TextArea
              aria-label={`发布参数 ${p.name}`}
              autoSize={{ minRows: 1, maxRows: 5 }}
              value={args[p.name]}
              disabled={busy || consumed}
              onChange={(event) => setArgs((old) => ({ ...old, [p.name]: event.target.value }))}
            />
          </label>
        ))}
        {prepared && !prepared.parameters.length && <span>此流水线没有需要填写的参数。</span>}
      </Space>
    </DashboardModal>
  );
}

const phases = { 1: '运行中', 2: '成功', 3: '失败', 4: '暂停' };
export function KubeEasePipeline({ endpoint, repository, initialRuntime, submitted }) {
  const [records, setRecords] = useState([]);
  const [runtime, setRuntime] = useState(initialRuntime || null);
  const [detail, setDetail] = useState(null);
  const [pod, setPod] = useState(null);
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState(null);
  const [logError, setLogError] = useState(null);
  const [listError, setListError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [logReload, setLogReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setListError(null);
    keRequest(endpoint, repository.id, 'ke-runtimes', {}, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRecords(result.runtimes);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setListError(e.message);
      });
    return () => controller.abort();
  }, [endpoint, repository.id, reload]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    setPod(null);
    if (!runtime) return undefined;
    const controller = new AbortController();
    let timer;
    async function load() {
      setBusy(true);
      try {
        const result = await keRequest(
          endpoint,
          repository.id,
          'ke-runtime',
          { runtime },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setDetail(result);
        setError(null);
        setPod((current) =>
          result.stages.some((s) => s.podName === current)
            ? current
            : result.stages.find((s) => s.podName)?.podName || null,
        );
        if (result.phase === 1) timer = setTimeout(load, 5000);
      } catch (e) {
        if (!controller.signal.aborted) setError(e.message);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, repository.id, runtime, reload]);
  useEffect(() => {
    setLogs(null);
    setLogError(null);
    if (!runtime || !pod) return undefined;
    const controller = new AbortController();
    keRequest(endpoint, repository.id, 'ke-pipeline-logs', { runtime, pod }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setLogs(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLogError(e.message);
      });
    return () => controller.abort();
  }, [endpoint, repository.id, runtime, pod, reload, logReload]);
  const choices =
    records.some((r) => r.name === runtime) || !runtime ? records : [{ name: runtime }, ...records];
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <div className="dashboard-repository-location">
        {repository.ke_pipeline.base_url} · {repository.ke_pipeline.pipeline}
      </div>
      {submitted && (
        <Alert
          type={initialRuntime ? 'success' : 'warning'}
          showIcon
          title={
            initialRuntime
              ? `发布已提交：${initialRuntime}`
              : '发布已提交，但服务未返回运行标识，请从运行记录中核对；不要重复发布。'
          }
        />
      )}
      {listError && <Alert type="error" title={listError} />}
      {error && <Alert type="error" title={error} />}
      <Space wrap>
        <Select
          aria-label="流水线运行记录"
          placeholder="选择运行记录"
          value={runtime}
          style={{ width: 340, maxWidth: '100%' }}
          onChange={setRuntime}
          options={choices.map((r) => ({
            value: r.name,
            label: `${r.name} · ${phases[r.phase] || '待查询'}${r.createAt ? ` · ${r.createAt}` : ''}`,
          }))}
        />
        <Button loading={busy} onClick={() => setReload((v) => v + 1)}>
          刷新运行记录
        </Button>
      </Space>
      {!runtime && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择需要查看的运行记录" />
      )}
      {detail && (
        <>
          <Tag color={detail.phase === 3 ? 'error' : detail.phase === 2 ? 'success' : 'processing'}>
            {phases[detail.phase] || '未知状态'}
          </Tag>
          <Select
            aria-label="流水线节点"
            value={pod}
            placeholder="选择节点"
            style={{ width: '100%' }}
            onChange={setPod}
            options={detail.stages
              .filter((s) => s.podName)
              .map((s) => ({
                value: s.podName,
                label: `${s.displayName || s.podName} · ${phases[s.phase] || '待运行'}`,
              }))}
          />
          {detail.stages
            .filter((s) => s.message)
            .map((s, i) => (
              <Alert
                key={i}
                type={s.phase === 3 ? 'error' : 'info'}
                title={`${s.displayName}: ${s.message}`}
              />
            ))}
          <Button disabled={!pod} onClick={() => setLogReload((v) => v + 1)}>
            刷新节点日志
          </Button>
          {logError && <Alert type="error" title={logError} />}
          {logs?.truncated && <Alert type="warning" title="日志已截断，仅展示前 128 KiB。" />}
          <KubernetesLogViewer
            key="pipeline-log-viewer"
            text={logs?.logs}
            label="流水线节点日志"
            analysis={{
              endpoint: endpoint.replace(/\/kubernetes$/u, '/log-analysis'),
              repositoryId: repository.id,
              source: 'pipeline',
              context: `${runtime || ''} / ${pod || ''}`,
            }}
          />
        </>
      )}
    </Space>
  );
}
