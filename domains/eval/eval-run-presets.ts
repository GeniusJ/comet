import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { withRecoverableFileLock } from '../../platform/fs/recoverable-file-lock.js';
import { normalizeEvalRunConfig } from './eval-run-preview.js';
import { loadUserEvalEnvironment } from './user-environment.js';
import { loadInstalledCustomAgent } from './standalone-static-collect.js';
import {
  EvalRunError,
  evalStoragePath,
  readEvalJson,
  writeEvalJson,
  redactEvalOutput,
} from './eval-run-store.js';
import type { EvalRunConfig } from './eval-run-types.js';
export interface EvalPreset {
  id: string;
  name: string;
  config: EvalRunConfig;
  updatedAt: string;
}
async function settings(project: string, input: unknown, name?: string): Promise<EvalRunConfig> {
  const config = normalizeEvalRunConfig(project, input);
  delete config.previousExperimentId;
  delete config.retrySourceRunId;
  const environment = { ...process.env };
  loadUserEvalEnvironment(environment, os.homedir(), { create: false });
  const adapters = await Promise.all(
    [...new Set([config.agent, config.judgeAgent].filter((agent): agent is string => !!agent))].map(
      (agent) =>
        loadInstalledCustomAgent(agent, environment, { includeCredentials: true }).catch(
          () => null,
        ),
    ),
  );
  environment.COMET_EVAL_CUSTOM_CREDENTIALS = [
    environment.COMET_EVAL_CUSTOM_CREDENTIALS,
    ...adapters.flatMap((adapter) => adapter?.credentials ?? []),
  ]
    .filter(Boolean)
    .join(',');
  const serialized = JSON.stringify({ config, name });
  if (redactEvalOutput(serialized, environment) !== serialized)
    throw new EvalRunError('常用配置包含敏感信息，不能保存');
  return config;
}
export async function listEvalPresets(project: string): Promise<EvalPreset[]> {
  const data = await readEvalJson(await evalStoragePath(project, 'presets.json'));
  if (!data) return [];
  if (
    data.schema !== 'comet.eval.presets.v1' ||
    !Array.isArray(data.items) ||
    data.items.length > 50
  )
    throw new EvalRunError('常用配置文件无效，请保留文件并检查格式', 409);
  return Promise.all(
    data.items.map(async (value) => {
      const item = value as EvalPreset;
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^preset-[\w-]{1,80}$/u.test(item.id) ||
        typeof item.name !== 'string' ||
        typeof item.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(item.updatedAt))
      )
        throw new EvalRunError('常用配置记录无效', 409);
      return {
        id: item.id,
        name: item.name,
        updatedAt: item.updatedAt,
        config: await settings(project, item.config, item.name),
      };
    }),
  );
}
export async function saveEvalPreset(
  project: string,
  input: { id?: unknown; name?: unknown; config?: unknown; expectedUpdatedAt?: unknown },
): Promise<EvalPreset> {
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.trim().length > 80 ||
    [...input.name].some((character) => character.codePointAt(0)! < 32)
  )
    throw new EvalRunError('配置名称须为 1–80 个字符');
  const config = await settings(project, input.config, input.name);
  const file = await evalStoragePath(project, 'presets.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let result: EvalPreset;
  await withRecoverableFileLock(`${file}.lock`, async () => {
    const items = await listEvalPresets(project);
    const old = input.id ? items.find((item) => item.id === input.id) : undefined;
    if (input.id && (!old || old.updatedAt !== input.expectedUpdatedAt))
      throw new EvalRunError('常用配置已变化，请刷新后重新保存', 409);
    if (items.some((item) => item.name === String(input.name).trim() && item.id !== old?.id))
      throw new EvalRunError('配置名称已存在，请选择原配置后确认更新', 409);
    if (!old && items.length >= 50)
      throw new EvalRunError('最多保存 50 个常用配置，请先删除不再使用的配置', 409);
    result = {
      id: old?.id ?? `preset-${randomUUID()}`,
      name: String(input.name).trim(),
      config,
      updatedAt: new Date(
        Math.max(Date.now(), old ? Date.parse(old.updatedAt) + 1 : 0),
      ).toISOString(),
    };
    await writeEvalJson(file, {
      schema: 'comet.eval.presets.v1',
      items: [...items.filter((item) => item.id !== result.id), result],
    });
  });
  return result!;
}
export async function deleteEvalPreset(
  project: string,
  id: string,
  expectedUpdatedAt: unknown,
): Promise<void> {
  const file = await evalStoragePath(project, 'presets.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withRecoverableFileLock(`${file}.lock`, async () => {
    const items = await listEvalPresets(project);
    const old = items.find((item) => item.id === id);
    if (!old || old.updatedAt !== expectedUpdatedAt)
      throw new EvalRunError('常用配置已变化，请刷新后重新删除', 409);
    await writeEvalJson(file, {
      schema: 'comet.eval.presets.v1',
      items: items.filter((item) => item.id !== id),
    });
  });
}
