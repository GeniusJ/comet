import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Switch } from 'antd';
import { DownOutlined, SearchOutlined, UpOutlined, RobotOutlined } from '@ant-design/icons';
import { LogAIAnalysis } from './log-ai-analysis.jsx';

export function KubernetesLogViewer({ text = '', label, analysis }) {
  const [wrap, setWrap] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [analysisKey, setAnalysisKey] = useState(null);
  const sourceKey = analysis
    ? JSON.stringify([analysis.endpoint, analysis.repositoryId, analysis.source, analysis.context])
    : null;
  const showAnalysis = sourceKey !== null && analysisKey === sourceKey;
  const currentMatch = useRef(null);
  const matches = useMemo(() => {
    if (!query) return [];
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return Array.from(text.matchAll(pattern), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
  }, [text, query]);
  const active = Math.min(selected, Math.max(0, matches.length - 1));
  useEffect(() => {
    currentMatch.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, text, query, wrap]);

  function move(direction) {
    if (matches.length) setSelected((active + direction + matches.length) % matches.length);
  }

  // Bound highlighted DOM nodes for repetitive logs while keeping every match navigable.
  const first = Math.max(0, active - 500);
  const highlighted = matches.slice(first, first + 1000);
  const content = [];
  let offset = 0;
  highlighted.forEach((match, index) => {
    content.push(text.slice(offset, match.start));
    const isCurrent = first + index === active;
    content.push(
      <mark
        key={match.start}
        ref={isCurrent ? currentMatch : null}
        aria-current={isCurrent ? 'true' : undefined}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    offset = match.end;
  });
  content.push(text.slice(offset));

  return (
    <div className="dashboard-log-viewer">
      <div className="dashboard-log-toolbar">
        <Input
          className="dashboard-log-search"
          aria-label={`${label}搜索`}
          placeholder="搜索日志（忽略大小写）"
          prefix={<SearchOutlined />}
          allowClear
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span role="status" aria-label="日志搜索结果" className="dashboard-log-search-count">
          {query ? `${matches.length ? active + 1 : 0} / ${matches.length} 处匹配` : ''}
        </span>
        <Button
          aria-label="上一个匹配"
          title="上一个匹配（Shift+Enter）"
          icon={<UpOutlined />}
          disabled={!matches.length}
          onClick={() => move(-1)}
        />
        <Button
          aria-label="下一个匹配"
          title="下一个匹配（Enter）"
          icon={<DownOutlined />}
          disabled={!matches.length}
          onClick={() => move(1)}
        />
        <label className="dashboard-log-wrap">
          自动换行 <Switch aria-label="自动换行" checked={wrap} onChange={setWrap} />
        </label>
        {analysis && (
          <Button
            icon={<RobotOutlined />}
            aria-label="AI 分析"
            disabled={!text}
            aria-pressed={showAnalysis}
            onClick={() => setAnalysisKey(showAnalysis ? null : sourceKey)}
          >
            AI 分析
          </Button>
        )}
      </div>
      <div className={`dashboard-log-content${showAnalysis ? ' has-analysis' : ''}`}>
        <pre className="dashboard-kubernetes-logs" data-wrap={wrap} aria-label={label}>
          {text ? content : '暂无日志'}
        </pre>
        {showAnalysis && (
          <LogAIAnalysis
            key={sourceKey}
            {...analysis}
            text={text}
            onClose={() => setAnalysisKey(null)}
          />
        )}
      </div>
    </div>
  );
}
