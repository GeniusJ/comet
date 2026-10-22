import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listEvalPresets,
  saveEvalPreset,
  deleteEvalPreset,
} from '../../../domains/eval/eval-run-presets.js';
let project: string;
beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-presets-'));
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(project, 'home'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(project, { recursive: true, force: true });
});
it('saves reusable settings without run bindings and checks stale changes', async () => {
  const preset = await saveEvalPreset(project, {
    name: '日常评估',
    config: {
      target: 'skill',
      agent: 'codex',
      model: 'model-a',
      previousExperimentId: 'old-run',
      retrySourceRunId: 'old-run',
    },
  });
  expect(preset.config).toMatchObject({ agent: 'codex', model: 'model-a' });
  expect(preset.config.previousExperimentId).toBeUndefined();
  expect(preset.config.retrySourceRunId).toBeUndefined();
  expect(await listEvalPresets(project)).toHaveLength(1);
  await expect(
    saveEvalPreset(project, {
      id: preset.id,
      name: '修改',
      config: preset.config,
      expectedUpdatedAt: 'stale',
    }),
  ).rejects.toThrow(/变化/);
  await deleteEvalPreset(project, preset.id, preset.updatedAt);
  expect(await listEvalPresets(project)).toEqual([]);
});
it('rejects credential fields and secret values before writing', async () => {
  vi.stubEnv('BENCH_API_KEY', 'sensitive-preset-test-credential');
  await expect(
    saveEvalPreset(project, { name: 'secret', config: { target: 'skill', apiKey: 'secret' } }),
  ).rejects.toThrow(/字段/);
  await expect(
    saveEvalPreset(project, {
      name: 'secret',
      config: { target: 'skill', model: 'sensitive-preset-test-credential' },
    }),
  ).rejects.toThrow(/敏感/);
  await expect(
    saveEvalPreset(project, {
      name: 'sensitive-preset-test-credential',
      config: { target: 'skill', model: 'fixture' },
    }),
  ).rejects.toThrow(/敏感/);
  await expect(fs.stat(path.join(project, '.comet/eval/presets.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('also rejects a credential declared by an installed custom adapter', async () => {
  vi.stubEnv('ROUTING_VALUE', 'custom-adapter-private-value');
  const root = path.join(project, 'home/.comet/eval/adapters/local-script');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'adapter.yaml'),
    'apiVersion: comet.eval.agent/v1alpha1\nkind: EvalAgentAdapter\nmetadata:\n  id: local-script\n  version: "1"\nruntime:\n  executable: python3\n  install:\n    kind: none\ncredentials: [ROUTING_VALUE]\ncapabilities:\n  singleTurn: true\n  resume: false\n  structuredEvents: false\n  telemetry: false\n  skillInvocationEvidence: false\n',
  );
  await expect(
    saveEvalPreset(project, {
      name: 'local',
      config: { target: 'skill', agent: 'local-script', model: 'custom-adapter-private-value' },
    }),
  ).rejects.toThrow(/敏感/);
});
