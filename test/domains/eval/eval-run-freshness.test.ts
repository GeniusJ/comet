import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashEvalSkill } from '../../../domains/eval/eval-run-preview.js';
import { inspectEvalContentFreshness } from '../../../domains/eval/eval-run-freshness.js';
let project: string;
beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-eval-freshness-'));
  await fs.mkdir(path.join(project, 'skill'));
  await fs.writeFile(path.join(project, 'skill/SKILL.md'), '# Original');
});
afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});
it('marks an old result after the evaluated Skill changes without modifying the result', async () => {
  const config = { target: path.join(project, 'skill'), targetType: 'skill' as const };
  const contentHash = await hashEvalSkill(config.target);
  expect((await inspectEvalContentFreshness(project, config, contentHash)).stale).toBe(false);
  await fs.writeFile(path.join(project, 'skill/SKILL.md'), '# Revised');
  expect((await inspectEvalContentFreshness(project, config, contentHash)).stale).toBe(true);
});
it('keeps missing targets distinct from a verified current result', async () => {
  const value = await inspectEvalContentFreshness(
    project,
    { target: path.join(project, 'missing'), targetType: 'skill' },
    'old-hash',
  );
  expect(value.stale).toBe(true);
});
