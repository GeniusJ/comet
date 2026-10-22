import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Open a native folder dialog on the machine running the local server. */
export async function chooseLocalDirectory(platform = process.platform): Promise<string | null> {
  const commands: [string, string[]][] =
    platform === 'darwin'
      ? [['osascript', ['-e', 'POSIX path of (choose folder with prompt "选择 Comet 项目文件夹")']]]
      : platform === 'win32'
        ? [
            [
              'powershell.exe',
              [
                '-NoProfile',
                '-STA',
                '-Command',
                '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "Select Comet project folder"; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) }; $dialog.Dispose()',
              ],
            ],
          ]
        : platform === 'linux'
          ? [
              ['zenity', ['--file-selection', '--directory', '--title=选择 Comet 项目文件夹']],
              ['kdialog', ['--getexistingdirectory', '.', '--title', '选择 Comet 项目文件夹']],
            ]
          : [];

  for (const [command, args] of commands) {
    try {
      const { stdout } = await promisify(execFile)(command, args, {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 64 * 1024,
      });
      return stdout.replace(/[\r\n]+$/u, '') || null;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (platform === 'darwin' && failure.stderr?.includes('(-128)')) return null;
      if (platform === 'linux' && Number(failure.code) === 1) return null;
      if (failure.code === 'ENOENT') continue;
      throw new Error('无法打开系统文件夹选择器，请手动输入项目的绝对路径。', { cause: error });
    }
  }
  throw new Error('当前环境没有可用的文件夹选择器，请手动输入项目的绝对路径。');
}
