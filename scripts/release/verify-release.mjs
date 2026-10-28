#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function releaseOptions(args, env = process.env) {
  let regressionsOnly = false;
  let artifactOnly = false;
  let evalReport = env.COMET_RELEASE_EVAL_REPORT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--regressions-only') regressionsOnly = true;
    else if (argument === '--artifact-only') artifactOnly = true;
    else if (argument === '--eval-report' && args[index + 1] && !args[index + 1].startsWith('--'))
      evalReport = args[++index];
    else throw new Error(`不支持的发布检查参数：${argument}`);
  }
  const receipt = typeof evalReport === 'string' ? evalReport.trim() : '';
  if (artifactOnly && regressionsOnly) throw new Error('发布物自检不能同时声明回归检查。');
  if ((artifactOnly || regressionsOnly) && receipt)
    throw new Error('未运行回归的发布检查不能同时声明完整 Eval 放行凭证。');
  return { regressionsOnly, artifactOnly, evalReport: receipt || undefined };
}

export function releaseSteps(options, repositoryRoot = root) {
  const node = (label, args) => ({ label, command: process.execPath, args, cwd: repositoryRoot });
  const python = (label, args) => ({
    label,
    command: 'uv',
    args: ['run', '--locked', '--no-sync', '--no-python-downloads', 'python', ...args],
    cwd: path.join(repositoryRoot, 'eval'),
  });
  const artifactSteps = [
    node('构建当前候选', ['build.js']),
    node('扫描实际构建后的发布文件', ['scripts/release/prepublish-check.js']),
    node('SDK API 兼容检查', ['scripts/release/check-sdk-api.mjs']),
  ];
  if (options.artifactOnly) return artifactSteps;
  return [
    ...artifactSteps,
    node('发布元数据与检查入口回归', [
      'node_modules/vitest/vitest.mjs',
      'run',
      'test/repository/release-metadata.test.ts',
      'test/scripts/core-regressions.test.ts',
      'test/scripts/historical-regressions.test.ts',
      'test/scripts/badcase-registration.test.ts',
      'test/scripts/verify-release.test.ts',
      '--maxWorkers=2',
    ]),
    node('核心历史故障回归', ['scripts/lint/core-regressions.mjs']),
    python('Eval 判定器无模型反例回归', [
      '-m',
      'pytest',
      '-q',
      'local/tests/scaffold/test_regression_check.py',
    ]),
    ...(!options.regressionsOnly
      ? [
          node('核对 badcase 附加验收', [
            'scripts/lint/workflow-regressions.mjs',
            '--require-acceptance',
          ]),
          ...(options.evalReport
            ? [
                python('核对当前候选完整 Eval 凭证', [
                  'local/scripts/regression_check.py',
                  '--verify-receipt',
                  path.resolve(repositoryRoot, options.evalReport),
                ]),
              ]
            : []),
        ]
      : []),
  ];
}

export function verifyRelease(options, run = spawnSync, repositoryRoot = root) {
  for (const step of releaseSteps(options, repositoryRoot)) {
    console.log(`\n${step.label}`);
    const result = run(step.command, step.args, { cwd: step.cwd, stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0)
      throw new Error(
        `${step.label}未通过：${result.error?.message ?? result.signal ?? `退出码 ${result.status}`}。未完成的检查不能作为发布证据。`,
      );
  }
  console.log(
    options.artifactOnly
      ? '发布物自检通过；未运行回归、badcase 附加验收和完整模型 Eval，以合并 PR 时的 CI 回归为准。'
      : options.regressionsOnly
        ? '无模型发布回归通过；未运行 badcase 附加验收和完整模型 Eval。'
        : options.evalReport
          ? '当前候选的核心回归和完整 Eval 凭证均已核对通过。'
          : '核心回归与 badcase 附加验收通过；本次未提供完整 Eval 凭证，未核对真实模型 Eval。',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyRelease(releaseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
