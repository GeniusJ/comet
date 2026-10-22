import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Space, Tag } from 'antd';
import { CloseOutlined, SendOutlined, StopOutlined } from '@ant-design/icons';

function requestHistory(turns) {
  const result = [];
  for (const turn of turns.slice(-8).reverse()) {
    const entry = { role: turn.role, text: turn.text.slice(0, 8000) };
    if (new TextEncoder().encode(JSON.stringify([entry, ...result])).length > 60 * 1024) break;
    result.unshift(entry);
  }
  return result;
}

export function LogAIAnalysis({ endpoint, repositoryId, source, context, text, onClose }) {
  const [snapshot, setSnapshot] = useState(() => ({ text, time: new Date().toLocaleTimeString() }));
  const [question, setQuestion] = useState('请总结异常，找出相关日志并分析可能原因。');
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const controllerRef = useRef(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  function stop() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setBusy(false);
    setStatus('分析已停止，可重试或继续提问。');
  }
  async function analyze() {
    if (controllerRef.current || !question.trim() || !snapshot.text) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const history = turns.filter((turn) => turn.text);
    const currentQuestion = question.trim();
    setTurns([
      ...history,
      { role: 'user', text: currentQuestion },
      { role: 'assistant', text: '' },
    ]);
    setQuestion('');
    setBusy(true);
    setError(null);
    setStatus('正在连接本机 Codex CLI…');
    const update = (line) => {
      if (!line.trim() || controller.signal.aborted) return false;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'status') setStatus(event.message);
      if (event.type === 'message')
        setTurns((previous) => [...previous.slice(0, -1), { role: 'assistant', text: event.text }]);
      if (event.type === 'complete') {
        setStatus('分析完成');
        return true;
      }
      return false;
    };
    let reader;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryId,
          source,
          context,
          logs: snapshot.text,
          question: currentQuestion,
          history: requestHistory(history),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || '无法启动日志分析。');
      }
      if (!response.body) throw new Error('浏览器不支持读取分析结果。');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let complete = false;
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) complete = update(line) || complete;
        if (done) break;
      }
      complete = update(pending) || complete;
      if (!complete && !controller.signal.aborted) throw new Error('分析连接中断，请重试。');
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.message);
        setStatus('分析未完成');
        setQuestion(currentQuestion);
      }
    } finally {
      await reader?.cancel().catch(() => {});
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <aside className="dashboard-log-ai" aria-label="AI 日志分析">
      <div className="dashboard-log-ai-heading">
        <strong>AI 日志分析</strong>
        <Tag>Codex CLI</Tag>
        <Button type="text" icon={<CloseOutlined />} aria-label="关闭 AI 分析" onClick={onClose} />
      </div>
      <small>
        分析快照 · {snapshot.time} · {snapshot.text.split('\n').length} 行
      </small>
      <small>提问时将此快照提交给本机 Codex CLI 配置的模型服务，仅进行日志分析。</small>
      {snapshot.text !== text && <Alert type="info" title="当前日志已更新，分析仍使用原快照。" />}
      <Button
        size="small"
        disabled={busy || !text}
        onClick={() => {
          setSnapshot({ text, time: new Date().toLocaleTimeString() });
          setTurns([]);
          setStatus('');
          setError(null);
        }}
      >
        使用最新日志并开始新对话
      </Button>
      <div className="dashboard-log-ai-conversation" aria-label="日志分析对话" aria-busy={busy}>
        {turns.map((turn, index) => (
          <div key={index} className={`dashboard-log-ai-turn is-${turn.role}`}>
            <strong>{turn.role === 'user' ? '问题' : '分析'}</strong>
            <div>{turn.text || (busy ? '正在分析…' : '未返回分析结果')}</div>
          </div>
        ))}
      </div>
      {error && <Alert type="error" title={error} />}
      <Input.TextArea
        aria-label="日志分析问题"
        placeholder="例如：找出数据库超时及相关上下文"
        value={question}
        maxLength={1000}
        autoSize={{ minRows: 2, maxRows: 5 }}
        disabled={busy}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.ctrlKey || event.metaKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            analyze();
          }
        }}
      />
      <Space wrap>
        <Button
          type="primary"
          icon={<SendOutlined />}
          disabled={busy || !question.trim() || !snapshot.text}
          onClick={analyze}
        >
          {turns.length ? '继续提问' : '开始分析'}
        </Button>
        {busy && (
          <Button icon={<StopOutlined />} onClick={stop}>
            停止分析
          </Button>
        )}
        <small role="status" aria-label="AI 分析状态">
          {status}
        </small>
      </Space>
    </aside>
  );
}
