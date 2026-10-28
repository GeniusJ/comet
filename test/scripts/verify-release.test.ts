import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  releaseOptions,
  releaseSteps,
  verifyRelease,
} from '../../scripts/release/verify-release.mjs';

describe('release bad-case and Eval gate', () => {
  it('makes the candidate Eval receipt optional and parses it from flags or environment', () => {
    expect(releaseOptions([], {})).toEqual({
      regressionsOnly: false,
      artifactOnly: false,
      evalReport: undefined,
    });
    expect(releaseOptions([], { COMET_RELEASE_EVAL_REPORT: '  ' }).evalReport).toBeUndefined();
    expect(releaseOptions(['--eval-report', 'evidence/current.json'], {})).toEqual({
      regressionsOnly: false,
      artifactOnly: false,
      evalReport: 'evidence/current.json',
    });
    expect(releaseOptions([], { COMET_RELEASE_EVAL_REPORT: '/tmp/current.json' }).evalReport).toBe(
      '/tmp/current.json',
    );
  });

  it('keeps no-model checks explicit and rejects ambiguous or unknown flags', () => {
    expect(releaseOptions(['--regressions-only'], {}).regressionsOnly).toBe(true);
    expect(releaseOptions(['--artifact-only'], {}).artifactOnly).toBe(true);
    for (const args of [
      ['--skip-eval'],
      ['--eval-report'],
      ['--regressions-only', '--eval-report', 'x'],
      ['--artifact-only', '--eval-report', 'x'],
      ['--artifact-only', '--regressions-only'],
    ])
      expect(() => releaseOptions(args, {})).toThrow();
  });

  it('limits the artifact-only publish path to artifact self-checks and trusts merge-time CI for regressions', () => {
    const steps = releaseSteps(releaseOptions(['--artifact-only'], {}), '/repo');
    expect(steps.map((step) => step.args.join(' '))).toEqual([
      'build.js',
      'scripts/release/prepublish-check.js',
      'scripts/release/check-sdk-api.mjs',
    ]);
    expect(
      steps.some(
        (step) =>
          step.args.some((arg) => String(arg).includes('regressions') || arg.includes('vitest')) ||
          step.command === 'uv',
      ),
    ).toBe(false);
  });

  it('runs all bad-case gates before validating the current candidate receipt without spending model budget', () => {
    const steps = releaseSteps(
      releaseOptions(['--eval-report', 'proof with spaces.json'], {}),
      '/repo',
    );
    expect(steps[0].args).toEqual(['build.js']);
    expect(steps[1].args).toEqual(['scripts/release/prepublish-check.js']);
    expect(steps.map((step) => step.args.join(' '))).toEqual(
      expect.arrayContaining([
        'scripts/lint/core-regressions.mjs',
        'scripts/lint/workflow-regressions.mjs --require-acceptance',
        expect.stringContaining('local/tests/scaffold/test_regression_check.py'),
      ]),
    );
    expect(steps.at(-1)?.args.slice(-2)).toEqual([
      '--verify-receipt',
      path.resolve('/repo', 'proof with spaces.json'),
    ]);
    expect(
      steps
        .filter((step) => step.command === 'uv')
        .every(
          (step) => step.args.includes('--no-sync') && step.args.includes('--no-python-downloads'),
        ),
    ).toBe(true);
    expect(
      steps.some(
        (step) => step.args.includes('--suite') || step.args.includes('--initialize-baseline'),
      ),
    ).toBe(false);
  });

  it.each([
    { status: 1 },
    { status: null, signal: 'SIGTERM' },
    { status: null, error: new Error('missing tool') },
  ])('stops immediately on a failed or incomplete stage: %j', (failure) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const run = vi.fn().mockReturnValue(failure);
      expect(() => verifyRelease({ regressionsOnly: true }, run, '/repo')).toThrow('未通过');
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('publishes without a receipt by running all no-model checks only', () => {
    const options = releaseOptions([], {});
    expect(options.regressionsOnly).toBe(false);
    const steps = releaseSteps(options, '/repo');
    expect(steps.map((step) => step.args.join(' '))).toContain(
      'scripts/lint/workflow-regressions.mjs --require-acceptance',
    );
    expect(steps.some((step) => step.args.includes('--verify-receipt'))).toBe(false);
  });

  it('does not confuse deterministic checks with completion of additional acceptance', () => {
    expect(
      releaseSteps({ regressionsOnly: true }).some((step) =>
        step.args.includes('--require-acceptance'),
      ),
    ).toBe(false);
    for (const options of [
      { regressionsOnly: false },
      { regressionsOnly: false, evalReport: 'current.json' },
    ])
      expect(releaseSteps(options).some((step) => step.args.includes('--require-acceptance'))).toBe(
        true,
      );
  });

  it('labels the run result by whether a model Eval receipt was verified', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      verifyRelease(
        { regressionsOnly: false, artifactOnly: true },
        vi.fn().mockReturnValue({ status: 0 }),
        '/repo',
      );
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining('以合并 PR 时的 CI 回归为准'));
      verifyRelease({ regressionsOnly: true }, vi.fn().mockReturnValue({ status: 0 }), '/repo');
      expect(log).toHaveBeenLastCalledWith(
        expect.stringContaining('未运行 badcase 附加验收和完整模型 Eval'),
      );
      verifyRelease({ regressionsOnly: false }, vi.fn().mockReturnValue({ status: 0 }), '/repo');
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining('未提供完整 Eval 凭证'));
      verifyRelease(
        { regressionsOnly: false, evalReport: 'current.json' },
        vi.fn().mockReturnValue({ status: 0 }),
        '/repo',
      );
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining('完整 Eval 凭证均已核对通过'));
    } finally {
      log.mockRestore();
    }
  });

  it('keeps npm publication on artifact self-checks while release:verify and required CI keep the regression gate', async () => {
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
    expect(pkg.scripts.prepublishOnly).toBe(
      'node scripts/release/verify-release.mjs --artifact-only',
    );
    expect(pkg.scripts['release:verify']).toBe('node scripts/release/verify-release.mjs');
    const ci = await fs.readFile('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('      - core-regressions');
    expect(ci).toContain('run: pnpm test:core-regressions');
  });
});
