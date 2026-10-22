import { useState } from 'react';
import { Alert, Button, Form, Input, Tooltip } from 'antd';
import { FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { DashboardModal } from './dashboard-modal.jsx';

export function AddProjectButton({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const busy = adding || choosing;

  async function chooseDirectory() {
    setChoosing(true);
    setError(null);
    try {
      const response = await fetch('/api/dashboard/projects/choose-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法打开文件夹选择器，请手动输入路径。');
      if (result.path) setProjectPath(result.path);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setChoosing(false);
    }
  }

  async function addProject() {
    if (busy || !projectPath.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await onAdd(projectPath);
      setOpen(false);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <Tooltip title="添加项目">
        <Button
          type="text"
          icon={<PlusOutlined />}
          aria-label="添加项目"
          onClick={() => {
            setProjectPath('');
            setError(null);
            setOpen(true);
          }}
        />
      </Tooltip>
      <DashboardModal
        open={open}
        title="添加项目"
        ariaLabel="添加项目"
        description="输入项目的绝对路径，或选择本地文件夹。"
        width={560}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        footer={[
          <Button
            key="cancel"
            autoInsertSpace={false}
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            取消
          </Button>,
          <Button
            key="add"
            type="primary"
            loading={adding}
            disabled={choosing || !projectPath.trim()}
            onClick={addProject}
          >
            添加并切换
          </Button>,
        ]}
      >
        <Form layout="vertical" onFinish={addProject}>
          <Form.Item label="项目绝对路径" htmlFor="dashboard-project-path">
            <Input
              id="dashboard-project-path"
              aria-label="项目绝对路径"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              disabled={busy}
              placeholder="例如 /Users/me/projects/my-app"
            />
          </Form.Item>
          <Button
            icon={<FolderOpenOutlined />}
            loading={choosing}
            disabled={adding}
            onClick={chooseDirectory}
          >
            选择文件夹
          </Button>
          {error && <Alert style={{ marginTop: 16 }} type="error" title={error} showIcon />}
        </Form>
      </DashboardModal>
    </>
  );
}
