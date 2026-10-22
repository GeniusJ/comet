import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCodexLogAnalysis } from '../../platform/process/codex-log-analysis.js';

let root: string;
let executable: { executable: string; args: string[] };
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-log-ai-test-'));
  const script = path.join(root, 'fake-codex.mjs');
  await fs.writeFile(
    script,
    `
    import fs from 'node:fs';
    if (process.argv.includes('list')) {
      console.log(JSON.stringify([{ name: 'fixture-mcp', enabled: true }]));
    } else {
      fs.writeFileSync(process.env.COMET_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        fs.writeFileSync(process.env.COMET_INPUT, input);
        const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
        emit({ type: 'item.completed', item: { type: 'error', message: 'non-fatal startup warning' } });
        if (process.env.COMET_CASE === 'wait') { setInterval(() => {}, 1000); return; }
        if (process.env.COMET_CASE === 'error') {
          console.error('secret-fixture-token'); emit({ type: 'turn.failed', error: { message: 'secret-fixture-token' } }); return;
        }
        if (process.env.COMET_CASE === 'tool') {
          emit({ type: 'item.started', item: { type: 'command_execution', command: 'echo secret' } }); return;
        }
        if (process.env.COMET_CASE === 'empty') { emit({ type: 'turn.completed' }); return; }
        if (process.env.COMET_CASE === 'large') {
          emit({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(70 * 1024) } }); return;
        }
        const payload = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'L1：数据库连接超时。' } }) + '\\n');
        for (let i = 0; i < payload.length; i += 2) process.stdout.write(payload.subarray(i, i + 2));
        emit({ type: 'turn.completed' });
      });
    }
  `,
  );
  executable = { executable: process.execPath, args: [script] };
  env = {
    ...process.env,
    HOME: root,
    CODEX_HOME: root,
    COMET_CASE: '',
    COMET_CAPTURE: path.join(root, 'capture.json'),
    COMET_INPUT: path.join(root, 'input.txt'),
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('Codex log analysis process', () => {
  it('sends logs only through stdin and disables tools in a disposable read-only directory', async () => {
    const onMessage = vi.fn();
    const prompt = '合成日志：ERROR connection timeout; $(echo untrusted)';
    await runCodexLogAnalysis(prompt, { command: executable, env, onMessage });
    expect(onMessage).toHaveBeenLastCalledWith('L1：数据库连接超时。');
    expect(await fs.readFile(env.COMET_INPUT!, 'utf8')).toBe(prompt);
    const capture = JSON.parse(await fs.readFile(env.COMET_CAPTURE!, 'utf8'));
    expect(capture.args).not.toContain(prompt);
    expect(capture.args).toEqual(
      expect.arrayContaining([
        'never',
        'read-only',
        '--ephemeral',
        'shell_tool',
        'unified_exec',
        'plugins',
        'hooks',
        'apps',
        'mcp_servers.fixture-mcp.enabled=false',
      ]),
    );
    expect(capture.cwd).not.toBe(process.cwd());
    await expect(fs.access(capture.cwd)).rejects.toThrow();
  });

  for (const kind of ['error', 'tool', 'empty', 'large']) {
    it(`fails closed for ${kind} output without exposing CLI diagnostics`, async () => {
      const onMessage = vi.fn();
      const run = runCodexLogAnalysis('synthetic', {
        command: executable,
        env: { ...env, COMET_CASE: kind },
        onMessage,
      });
      await expect(run).rejects.toThrow('Codex CLI 分析失败');
      expect(onMessage).not.toHaveBeenCalled();
    });
  }

  it('terminates a running CLI on cancellation and on timeout', async () => {
    const controller = new AbortController();
    const running = runCodexLogAnalysis('synthetic', {
      command: executable,
      env: { ...env, COMET_CASE: 'wait' },
      signal: controller.signal,
      onMessage: vi.fn(),
    });
    const cancelled = expect(running).rejects.toMatchObject({ status: 499 });
    await vi.waitFor(async () => {
      await fs.access(env.COMET_INPUT!);
    });
    controller.abort();
    await cancelled;
    await expect(
      runCodexLogAnalysis('synthetic', {
        command: executable,
        env: { ...env, COMET_CASE: 'wait' },
        timeoutMs: 100,
        onMessage: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 504 });
  });
});
