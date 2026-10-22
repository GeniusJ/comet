import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';

export class KubeEaseError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export async function createKubeEaseClient(
  workspace: string,
  baseUrl: string,
  signal?: AbortSignal,
) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
    throw new KubeEaseError('KubeEase 地址无效。', 400);
  const key = baseUrl.replace(/\/$/u, '');
  const override = process.env.COMET_KE_HOSTS_FILE;
  const files = override
    ? [override]
    : [
        path.join(os.homedir(), '.config/comet/kubeease-hosts.json'),
        ...['.agents', '.cursor'].flatMap((root) =>
          ['ke-app', 'ke-app-pipeline', 'ke-app-status'].map((skill) =>
            path.join(workspace, root, 'skills', skill, '.hosts.json'),
          ),
        ),
      ];
  let token = '';
  let user = '';
  for (const file of files) {
    try {
      if ((await fs.stat(file)).size > 1024 * 1024) throw new Error();
      const config = JSON.parse(await fs.readFile(file, 'utf8'));
      const entry = config.hosts?.[key] ?? config.hosts?.[`${key}/`];
      if (typeof entry?.leoUserToken === 'string' && entry.leoUserToken.trim()) {
        token = entry.leoUserToken.trim();
        user = typeof entry.leoUser === 'string' ? entry.leoUser : '';
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new KubeEaseError('无法读取 KubeEase 本地凭证文件，请检查格式和访问权限。', 409);
    }
  }
  if (!token) throw new KubeEaseError('此 KubeEase 地址尚未配置本地访问凭证。', 409);
  const redact = (value: string) => value.split(token).join('[已隐藏令牌]');
  const redactLogs = (value: string) =>
    redact(value)
      .replace(
        /([?&](?:access[_-]?token|token|api[_-]?key|password|secret|signature)=)[^&\s"'<>\\]*/giu,
        '$1[已隐藏]',
      )
      .replace(/(\bauthorization\s*[:=]\s*(?:bearer\s+)?)[^\s"'<>]+/giu, '$1[已隐藏]');

  async function request(endpoint: string, body?: unknown): Promise<unknown> {
    const combined = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    try {
      const response = await fetch(`${key}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'leo-user-token': token,
          ...(user ? { 'leo-user': user } : {}),
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new KubeEaseError(
          response.status === 401 || response.status === 403
            ? 'KubeEase 凭证失效或无权访问此资源。'
            : 'KubeEase 服务请求失败。',
        );
      }
      const reader = response.body?.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.length;
            if (bytes > 2 * 1024 * 1024) {
              await reader.cancel();
              throw new KubeEaseError('KubeEase 返回内容超过 2 MiB，请缩小查询范围。');
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const result = JSON.parse(redact(Buffer.concat(chunks).toString('utf8')));
      if (result.rtnCode !== '000000')
        throw new KubeEaseError('KubeEase 操作失败，请检查配置和权限。');
      return result.rtnData;
    } catch (error) {
      if (error instanceof KubeEaseError) throw error;
      throw new KubeEaseError(
        combined.aborted
          ? 'KubeEase 请求已取消或超时。'
          : 'KubeEase 连接或响应无效，请检查服务地址和连接。',
      );
    }
  }
  if (!user) {
    const info = (await request('/user-center/v4/auth/userinfo')) as Record<string, unknown>;
    if (!info?.userId || !info?.userName)
      throw new KubeEaseError('KubeEase 未返回有效的用户信息。');
    user = JSON.stringify({ userId: info.userId, userName: info.userName });
  }

  async function logs(payload: Record<string, unknown>) {
    const wsBase = new URL(key);
    wsBase.protocol = wsBase.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase.pathname = `${wsBase.pathname.replace(/\/$/u, '')}/amp/v4/ws/pods/log/${randomInt(100, 1000)}/${randomBytes(4).toString('hex')}/websocket`;
    wsBase.searchParams.set('token', token);
    return new Promise<{ logs: string; truncated: boolean; checkedAt: string; partial: boolean }>(
      (resolve, reject) => {
        const ws = new WebSocket(wsBase);
        let output = '';
        let bytes = 0;
        let done = false;
        let opened = false;
        let idle: ReturnType<typeof setTimeout>;
        const duration = setTimeout(
          () =>
            finish(opened ? undefined : new KubeEaseError('KubeEase 日志连接超时。'), false, true),
          30_000,
        );
        function finish(error?: KubeEaseError, truncated = false, partial = false) {
          if (done) return;
          done = true;
          clearTimeout(idle);
          clearTimeout(duration);
          signal?.removeEventListener('abort', cancel);
          ws.close();
          if (error) reject(error);
          else
            resolve({
              logs: redactLogs(output),
              truncated,
              partial,
              checkedAt: new Date().toISOString(),
            });
        }
        function cancel() {
          finish(new KubeEaseError('日志查询已取消。', 499));
        }
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        function append(value: unknown) {
          const text = String(value ?? '')
            .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu'), '')
            .replace(/\r/gu, '');
          const buffer = Buffer.from(text);
          const remaining = 128 * 1024 - bytes;
          output += buffer.subarray(0, remaining).toString('utf8');
          bytes += buffer.length;
          if (bytes >= 128 * 1024) finish(undefined, true, true);
        }
        ws.addEventListener('message', (event) => {
          if (done) return;
          const frame = String(event.data);
          if (frame === 'o') {
            if (!opened) {
              opened = true;
              ws.send(JSON.stringify([JSON.stringify(payload)]));
              idle = setTimeout(() => finish(undefined, false, true), 5000);
            }
            return;
          }
          if (frame === 'h') return;
          if (frame.startsWith('c')) {
            finish();
            return;
          }
          try {
            if (!frame.startsWith('a')) throw new Error();
            const messages = JSON.parse(frame.slice(1));
            if (!Array.isArray(messages)) throw new Error();
            for (const message of messages) {
              let item = message;
              if (typeof item === 'string') {
                try {
                  item = JSON.parse(item);
                } catch {
                  /* Plain text log. */
                }
              }
              if (item && typeof item === 'object') append(item.Data ?? item.data ?? '');
              else append(item);
            }
            clearTimeout(idle);
            if (!done) idle = setTimeout(() => finish(undefined, false, true), 5000);
          } catch {
            finish(new KubeEaseError('KubeEase 日志协议响应无效。'));
          }
        });
        ws.addEventListener('error', () =>
          finish(new KubeEaseError('KubeEase 日志连接失败，请检查凭证和环境。')),
        );
        ws.addEventListener('close', (event) =>
          finish(
            !opened || ![1000, 1005].includes(event.code)
              ? new KubeEaseError('KubeEase 日志连接异常中断。')
              : undefined,
          ),
        );
      },
    );
  }
  return { request, logs, redactLogs };
}
