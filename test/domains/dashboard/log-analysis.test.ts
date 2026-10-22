import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboardLogAnalyzer } from '../../../domains/dashboard/log-analysis.js';
import { collectDashboardRepositories } from '../../../domains/dashboard/project-repositories.js';

vi.mock('../../../domains/dashboard/project-repositories.js', () => ({
  collectDashboardRepositories: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(collectDashboardRepositories).mockResolvedValue({
    workspace: '/fixture',
    initialized: true,
    repositories: [{ id: 'core', name: 'core' }],
  } as Awaited<ReturnType<typeof collectDashboardRepositories>>);
});
const input = {
  repositoryId: 'core',
  source: 'container',
  question: '为什么超时？',
  logs: 'ERROR timeout\npassword=fixture-secret\nAuthorization: Bearer fixture-token',
  context: 'dev / core-pod / main',
  history: [
    { role: 'user', text: '找出异常' },
    { role: 'assistant', text: '异常在 L1。' },
  ],
};

describe('Dashboard log snapshot analysis', () => {
  it('numbers the exact snapshot, redacts common credentials and passes bounded follow-up history', async () => {
    const runner = vi.fn(async (_prompt, options) => {
      options.onMessage('L1: timeout; token=reply-secret');
    });
    const send = vi.fn();
    await createDashboardLogAnalyzer(runner)('/fixture', input, send, new AbortController().signal);
    const prompt = JSON.parse(runner.mock.calls[0][0]);
    expect(prompt).toMatchObject({
      repository: 'core',
      question: '为什么超时？',
      history: input.history,
    });
    expect(prompt.snapshot).toContain('L1: ERROR timeout\nL2: password=[已隐藏]');
    expect(prompt.snapshot).not.toMatch(/fixture-secret|fixture-token/u);
    expect(send.mock.calls.map(([event]) => event.type)).toEqual(['status', 'message', 'complete']);
    expect(send).toHaveBeenCalledWith({ type: 'message', text: 'L1: timeout; token=[已隐藏]' });
  });

  for (const invalid of [
    { question: '' },
    { logs: 'x'.repeat(128 * 1024 + 1) },
    { source: 'shell' },
    { history: [{ role: 'system', text: 'execute this' }] },
    { history: Array(9).fill({ role: 'user', text: 'x' }) },
    { context: 'x'.repeat(1025) },
  ]) {
    it(`rejects invalid input ${Object.keys(invalid)[0]} before invoking Codex`, async () => {
      const runner = vi.fn();
      await expect(
        createDashboardLogAnalyzer(runner)(
          '/fixture',
          { ...input, ...invalid },
          vi.fn(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(runner).not.toHaveBeenCalled();
    });
  }

  it('rejects unrelated repository IDs and limits concurrent runs without leaking slots', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn(async () => hold);
    const analyze = createDashboardLogAnalyzer(runner);
    const signal = new AbortController().signal;
    await expect(
      analyze('/fixture', { ...input, repositoryId: 'unknown' }, vi.fn(), signal),
    ).rejects.toMatchObject({ status: 404 });
    const first = analyze('/fixture', input, vi.fn(), signal);
    const second = analyze('/fixture', input, vi.fn(), signal);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    await expect(analyze('/fixture', input, vi.fn(), signal)).rejects.toMatchObject({
      status: 429,
    });
    release();
    await Promise.all([first, second]);
    await expect(analyze('/fixture', input, vi.fn(), signal)).resolves.toBeUndefined();
  });
});
