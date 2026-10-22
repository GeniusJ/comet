import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { listProjectRegistryEntries } from '../../platform/install/project-registry.js';
import { spawnCometCommand } from '../../platform/process/comet-command.js';
import { redactCommandOutput } from '../../platform/process/redact-command-output.js';
import {
  checkForUpdate,
  parseSemver,
  type VersionCheckResult,
} from '../../platform/version/version.js';

export class DashboardUpdateError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
  }
}
interface UpdateLogEntry {
  sequence: number;
  stream: 'stdout' | 'stderr';
  text: string;
}
interface UpdateJob {
  id: string;
  version: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  command: string;
  entries: UpdateLogEntry[];
  cursor: number;
  truncated: boolean;
}

export function createDashboardUpdateService(cwd: string) {
  let version: VersionCheckResult | null = null;
  let checkedAt = 0;
  let checking: Promise<VersionCheckResult> | null = null;
  let job: UpdateJob | null = null;
  const isRunning = () => job?.status === 'running';
  const check = async (refresh: boolean) => {
    if (!checking && (refresh || !version || Date.now() - checkedAt > 60 * 60_000)) {
      checking = checkForUpdate()
        .then((result) => {
          version = result;
          checkedAt = Date.now();
          return result;
        })
        .finally(() => {
          checking = null;
        });
    }
    return checking ? await checking : version!;
  };
  const projects = async () => {
    const entries = await listProjectRegistryEntries({ strict: true });
    const paths = entries.map((entry) => entry.path).sort();
    const revision = createHash('sha256')
      .update(
        JSON.stringify(entries.map((entry) => [entry.canonicalPath, entry.lastTargets]).sort()),
      )
      .digest('hex');
    return { paths, revision };
  };
  const readJob = (after = 0) =>
    job ? { ...job, entries: job.entries.filter((entry) => entry.sequence > after) } : null;
  return {
    async status(refresh = false) {
      const [result, indexed] = await Promise.all([check(refresh), projects()]);
      return {
        ...result,
        checkedAt: new Date(checkedAt).toISOString(),
        projects: indexed.paths,
        projectRevision: indexed.revision,
        job: readJob(),
      };
    },
    readJob,
    async start(input: unknown) {
      const body =
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      if (isRunning()) throw new DashboardUpdateError('已有更新正在执行');
      if (body.confirmed !== true || typeof body.version !== 'string' || !parseSemver(body.version))
        throw new DashboardUpdateError('请先确认更新版本与项目范围', 400);
      const [result, indexed] = await Promise.all([check(true), projects()]);
      if (!result.checked) throw new DashboardUpdateError('无法连接 npm，请稍后重新检查版本', 503);
      if (
        !result.hasUpdate ||
        result.latestVersion !== body.version ||
        indexed.revision !== body.projectRevision
      )
        throw new DashboardUpdateError('版本或项目索引已变化，请重新检查并确认更新');
      if (indexed.paths.length === 0)
        throw new DashboardUpdateError('项目索引为空，没有可更新的项目');
      // 网络检查期间再次确认，避免两个并发请求启动两轮更新。
      if (isRunning()) throw new DashboardUpdateError('已有更新正在执行');
      const args = ['update', '--all-projects', '--yes', '--target-version', body.version];
      const current: UpdateJob = {
        id: randomUUID(),
        version: body.version,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        command: `comet ${args.join(' ')}`,
        entries: [],
        cursor: 0,
        truncated: false,
      };
      job = current;
      let logBytes = 0;
      const append = (text: string, stream: UpdateLogEntry['stream']) => {
        if (!text) return;
        const redacted = redactCommandOutput(text);
        const safe = redacted.slice(-128 * 1024);
        if (safe.length !== redacted.length) current.truncated = true;
        current.entries.push({ sequence: ++current.cursor, text: safe, stream });
        logBytes += Buffer.byteLength(safe);
        while (
          current.entries.length > 1 &&
          (logBytes > 512 * 1024 || current.entries.length > 2000)
        ) {
          logBytes -= Buffer.byteLength(current.entries.shift()!.text);
          current.truncated = true;
        }
      };
      const finish = (code: number | null) => {
        current.exitCode = code;
        current.status = code === 0 ? 'completed' : 'failed';
        current.finishedAt = new Date().toISOString();
      };
      append(`$ ${current.command}\n`, 'stdout');
      try {
        const child = spawnCometCommand(args, cwd);
        const flushers: Array<() => void> = [];
        for (const stream of ['stdout', 'stderr'] as const) {
          const decoder = new StringDecoder('utf8');
          let pending = '';
          let discarding = false;
          child[stream].on('data', (chunk: Buffer) => {
            let text = decoder.write(chunk);
            if (discarding) {
              const end = text.search(/[\r\n]/u);
              if (end < 0) return;
              text = text.slice(end + 1);
              discarding = false;
            }
            pending += text;
            const end = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
            if (end >= 0) {
              append(pending.slice(0, end + 1), stream);
              pending = pending.slice(end + 1);
            }
            // 不把超长且未结束的原始行推送给浏览器，避免凭据被拆分泄露。
            if (pending.length > 64 * 1024) {
              pending = '';
              discarding = true;
              append('[Oversized log line omitted]\n', stream);
            }
          });
          flushers.push(() => {
            append(pending + decoder.end(), stream);
            pending = '';
          });
        }
        child.once('error', (error) => {
          append(`${error.message}\n`, 'stderr');
          finish(null);
        });
        child.once('close', (code) => {
          flushers.forEach((flush) => flush());
          finish(code);
        });
      } catch (error) {
        append(`${(error as Error).message}\n`, 'stderr');
        finish(null);
      }
      return readJob();
    },
  };
}
