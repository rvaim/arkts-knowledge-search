import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { KnowledgeError } from './errors.js';

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandOutput>;

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export const runCommand: CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandOutput> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    };

    const collect = (
      target: Buffer[],
      chunk: Buffer,
      processToStop: ChildProcess
    ): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        processToStop.kill();
        finishReject(
          new KnowledgeError(
            'COMMAND_OUTPUT_TOO_LARGE',
            `命令输出超过 ${maxOutputBytes} 字节限制。`
          )
        );
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk, child));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, child));
    child.on('error', (error: NodeJS.ErrnoException) => {
      const code =
        error.code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : 'COMMAND_START_FAILED';
      finishReject(
        new KnowledgeError(code, `无法启动命令 ${command}。`, error)
      );
    });
    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      const result: CommandOutput = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? 1,
      };
      resolve(result);
    });

    timer = setTimeout(() => {
      child.kill();
      finishReject(
        new KnowledgeError(
          'COMMAND_TIMEOUT',
          `命令执行超过 ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} 毫秒。`
        )
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });

// Keep the URL out of command text: cmd.exe treats query separators as commands.
const WINDOWS_BROWSER_SCRIPT = `try {
  Start-Process -FilePath $env:ARKTS_KNOWLEDGE_LOGIN_URL -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine('Unable to open the default browser.')
  exit 1
}`;

interface BrowserOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}

export async function runInteractiveLogin(
  loginUrl: string,
  options: BrowserOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const preferredBrowser = env.ARKTS_KNOWLEDGE_BROWSER?.trim();
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'powershell.exe'
        : 'xdg-open';
  const args =
    platform === 'win32'
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(WINDOWS_BROWSER_SCRIPT, 'utf16le').toString('base64'),
        ]
      : platform === 'darwin' && preferredBrowser
        ? ['-a', preferredBrowser, loginUrl]
      : [loginUrl];

  const result = await (options.runner ?? runCommand)(command, args, {
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    ...(platform === 'win32'
      ? { env: { ...env, ARKTS_KNOWLEDGE_LOGIN_URL: loginUrl } }
      : {}),
  });
  if (result.exitCode !== 0) {
    throw new KnowledgeError(
      'BROWSER_OPEN_FAILED',
      `无法自动打开浏览器：${result.stderr.trim() || result.stdout.trim()}`
    );
  }
}
